// Per-project generation defaults, with an app-level fallback.
//
// Two problems this solves. Model choice was hardcoded at every call site, so
// "use Klein for images on this project" meant editing code. And `style` was a
// single token ("anime") pasted into prompts, which is not enough to keep a
// project from drifting between cartoon, 3D and live-action — the style guide
// is the longer text that actually holds a look together.
//
// Resolution is project → app default → built-in, so a new project inherits
// what you normally work in and can still override it. Stored on
// projects.settings (jsonb) and localStorage; nothing here is a secret.
import { supabase } from "./supabase";
import {
  normalizeChain, normalizePostOptions,
  type GradeMethod, type H3FaceCanvas, type PostChain, type RefineSigmas,
  type RefineSize, type UpscaleModelId,
} from "./postChain";
import { normalizeOutput, RENDER_OUTPUT_DEFAULT, type RenderOutput } from "./renderOutput";
import { invalidateTables } from "../hooks/useLiveQuery";

const LS_KEY = "qamba.defaults";

/** One entry in a model's LoRA stack. `key` indexes the model's
 *  capabilities.styleLoras; the worker maps it to a filename through
 *  model_map's style_loras, so no .safetensors name ever reaches the browser. */
export interface LoraPick { key: string; strength: number }

export interface GenDefaults {
  /** model_catalog id, e.g. "krea2-local" */
  image_model?: string;
  /** Render quality for the hosted image rows that expose one (OpenAI's).
   *  Panels default to low: measured on one panel prompt across all three
   *  tiers, the SHOT is right at every tier and only background detail scales,
   *  at 6x the price from low to high. Stored per project because it belongs
   *  with the model it qualifies — a tier means nothing on its own. */
  image_quality?: "low" | "medium" | "high";
  /** model_catalog id, e.g. "h3-local" */
  video_model?: string;
  /** model_catalog id of a `kind: "audio"` row, e.g. "minimax-music3-local".
   *  No LoRA companion: neither music model has adapters ComfyUI can load. */
  music_model?: string;
  /** free text prepended to every generation prompt for this project */
  style_guide?: string;
  /** default aspect for the generate dock ("16:9" | "9:16" | "1:1" | "4:3") */
  aspect?: string;
  /** Stack, in application order. Supersedes the single image_lora below,
   *  which is still read so projects saved before this keep their choice. */
  image_loras?: LoraPick[];
  /** @deprecated single-LoRA form — migrated into image_loras on read */
  image_lora?: string | null;
  image_lora_strength?: number;
  /** Video concept-LoRA stack, same key convention as image_loras. Separate
   *  because it is a different model's adapters entirely: `validLoras` prunes
   *  any pick the selected model does not declare, so one shared field would
   *  silently empty itself every time you switched between an image and a
   *  video model. Rides `params.loras` onto every block of an episode. */
  video_loras?: LoraPick[];
  /** Default finishing passes for the final render. Every clip whose own
   *  `clips.post` is null follows this one; a clip that overrides it stores its
   *  own chain. Applied by tl_render, never at the moment a toggle flips. */
  post?: PostChain;
  /** The grade reference for the `color_match` post pass — an assets.id whose
   *  colour every clip with the pass on is matched to.
   *
   *  On the PROJECT rather than the clip because the whole point of the pass is
   *  that every shot in a cut agrees; a per-clip reference would let two clips
   *  match two different looks, which is the opposite of a grade.
   *
   *  Its absence is not benign: `color_match` RAISES without one rather than
   *  passing the clip through ungraded, so a project with the pass on and this
   *  unset has a render that cannot succeed. The picker is shown next to the
   *  switch that needs it, in both surfaces that edit the project's chain. */
  post_ref_asset_id?: string | null;

  /** What Color Match matches TO. "source" (the default) matches each clip
   *  back to a frame of its OWN take, so the pass restores the grade the
   *  timeline showed after the generative passes move it; "asset" matches
   *  every clip to the one still above — kept for deliberately unifying a
   *  cut's grade, and no longer the default because it was measured
   *  flattening a whole film onto one frame's histogram. */
  post_ref_mode?: "source" | "asset";
  /** How hard the grade is applied, 0..1. Read by the worker since the pass
   *  shipped and written by nothing until 2026-09-05 — see PostRefPicker. */
  post_ref_strength?: number;

  /** HOW the two generative passes are tuned — the refine's size, schedule and
   *  guidance, and which SeedVR2 checkpoint the restore loads. Flat keys
   *  beside `post_ref_*` because that is how the worker reads them
   *  (`handlers/render._post_opts`), and on the PROJECT for the same reason
   *  the grade reference is: a cut whose shots were refined at different
   *  strengths does not agree with itself.
   *
   *  Every default is exactly what renders did before these existed, so an
   *  untouched project is byte-for-byte unchanged — and each one is in the
   *  clip cache key ONLY when it differs from that default, so adding them
   *  invalidated nothing. See postChain.ts for the vocabulary. */
  post_refine_size?: RefineSize;
  post_refine_sigmas?: RefineSigmas;
  post_refine_cfg?: number;
  post_upscale_model?: UpscaleModelId;
  /** Which colour transfer the grade runs — see GRADE_METHODS. Here for the
   *  same reason the two below are: this is the type every save is checked
   *  against, and a key it does not declare is a typo nothing would catch. */
  post_grade_method?: GradeMethod;
  /** The H3 face pass's two knobs. Declared here as well as in `PostOptions`
   *  because this is the type every save is checked against — they were
   *  missing, and `save(patch)` only compiled because a variable of another
   *  type carries no excess-property check, so nothing would have caught a
   *  typo in either key. */
  post_h3face_canvas?: H3FaceCanvas;
  post_h3face_denoise?: number;

  /** How the final render is ENCODED — container, codec, quality, audio.
   *  Per project rather than per render because a studio delivers in one
   *  format for months at a time; the render settings modal edits this and
   *  the render reads it back, so what you chose last time is what you get.
   *  See renderOutput.ts (and its worker twin) for the table. */
  render_output?: RenderOutput;
}

export interface ProjectSettings extends GenDefaults {
  director_backend?: string;
}

export interface StylePreset {
  id: string;
  label: string;
  image: string;
  guide: string;
}

/** Starting points, not a closed list — every one is editable free text. */
export const STYLE_PRESETS: StylePreset[] = [
  { id: "anime", label: "Anime (2D)", image: "/presets/anime.png",
    guide: "2D-animated anime. Cel shading with hard shadow terminators, clean "
         + "line art, expressive but anatomically consistent faces. Backgrounds "
         + "painted in the Shinkai register: dense detail, volumetric light, "
         + "saturated skies. No 3D shading, no photographic skin texture." },
  { id: "3d", label: "3D animation", image: "/presets/3d.png",
    guide: "Stylised 3D animation, feature-film grade. Subsurface-scattered "
         + "skin, soft area lighting, shallow depth of field, physically based "
         + "materials. Slightly exaggerated proportions. Not photoreal, not "
         + "cel-shaded — rendered geometry throughout." },
  { id: "live", label: "Live action", image: "/presets/live.png",
    guide: "Live-action cinematic photography. Real skin texture with pores and "
         + "subsurface detail, natural motion blur, anamorphic lens character, "
         + "practical lighting with motivated sources. Shot on large-format "
         + "digital. No illustration or rendering cues of any kind." },
  { id: "watercolor", label: "Watercolour", image: "/presets/watercolor.png",
    guide: "Watercolour animation. Visible paper tooth, pigment blooming into "
         + "wet edges, colours that bleed rather than mask. Loose ink linework "
         + "that does not always close. Deliberately imperfect registration." },
  { id: "retro", label: "Retro film", image: "/presets/retro.png",
    guide: "Vintage film stock. 35mm grain, halation on highlights, slightly "
         + "faded blacks, period-correct lenses with visible falloff and a "
         + "narrow contrast range. Colour science of the era, not modern." },
  { id: "cinematic35", label: "Cinematic 35mm", image: "/presets/cinematic35.png",
    guide: "Cinematic 35mm film look. Shallow depth of field with creamy bokeh, "
         + "fine halation around brights, subtle gate weave and organic grain. "
         + "Motivated practical lighting, natural skin tones with controlled "
         + "contrast, a restrained palette graded for the projector, not the "
         + "phone." },
];

export function appDefaults(): GenDefaults {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as GenDefaults;
  } catch {
    return {};
  }
}

export function setAppDefaults(next: GenDefaults): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...appDefaults(), ...next }));
  } catch { /* storage disabled */ }
}

/** Read the LoRA stack from either shape, newest wins. */
function readLoras(s: GenDefaults | null | undefined): LoraPick[] | null {
  if (!s) return null;
  if (Array.isArray(s.image_loras)) {
    return s.image_loras
      .filter((l) => l && typeof l.key === "string" && l.key)
      .map((l) => ({ key: l.key, strength: Number(l.strength ?? 1) || 1 }));
  }
  if (s.image_lora) return [{ key: s.image_lora, strength: s.image_lora_strength ?? 1 }];
  return null;
}

/** What a generation should actually use, project first. */
export function resolveDefaults(settings: ProjectSettings | null | undefined): Required<GenDefaults> {
  const app = appDefaults();
  const loras = readLoras(settings) ?? readLoras(app) ?? [];
  const vloras = (settings?.video_loras ?? app.video_loras ?? [])
    .filter((l) => l && typeof l.key === "string" && l.key)
    .map((l) => ({ key: l.key, strength: Number(l.strength ?? 1) || 1 }));
  return {
    image_model: settings?.image_model || app.image_model || "krea2-local",
    image_quality: settings?.image_quality || app.image_quality || "low",
    // Turbo is the fallback, not a preference: a saved project/app setting
    // still wins. See WizardModal for the measurement behind the choice.
    video_model: settings?.video_model || app.video_model || "h3-turbo-local",
    // Music 3 rather than the faster ACE-Step turbo: it is the one that sings a
    // written lyric, which is what "generate a track for this scene" usually
    // means here. Swap per project when you want ACE's tag control or its 3x
    // turnaround.
    music_model: settings?.music_model || app.music_model || "minimax-music3-local",
    style_guide: settings?.style_guide !== undefined ? (settings.style_guide || "") : (app.style_guide || ""),
    aspect: settings?.aspect || app.aspect || "16:9",
    image_loras: loras,
    video_loras: vloras,
    // No app-level fallback on purpose: a finishing chain is a look decision
    // for one cut, and inheriting "everything gets grain" into a fresh project
    // would spend GPU time nobody asked for on its first render.
    post: normalizeChain(settings?.post) ?? {},
    // Normalized on READ as well as on write: the stored object predates any
    // format we might add or remove later, and an unknown codec reaching
    // ffmpeg fails the render on its last step. No app-level fallback — the
    // built-in default (H.264/CRF 18) is what every render produced before
    // this setting existed, so an untouched project is bit-for-bit unchanged.
    render_output: normalizeOutput(settings?.render_output ?? RENDER_OUTPUT_DEFAULT),
    // No app-level fallback, for the reason `post` has none: a grade reference
    // is one cut's look, and inheriting another project's would silently match
    // a new film to an old one's colour.
    post_ref_asset_id: settings?.post_ref_asset_id ?? null,
    post_ref_mode: (settings?.post_ref_mode === "asset" ? "asset" : "source") as "source" | "asset",
    // Clamped the way the worker clamps it, so the control and the render
    // cannot disagree about a value somebody typed into the row by hand.
    post_ref_strength: Math.max(0, Math.min(1, Number(settings?.post_ref_strength ?? 1) || 0)),
    // Normalized on read for `render_output`'s reason: the stored value
    // predates any rung we might add or drop, and a preset the worker cannot
    // resolve would silently fall back to a different schedule there while
    // this panel went on naming the old one.
    ...normalizePostOptions(settings),
    // Legacy mirrors, kept so call sites that only ever wanted one still read
    // something sensible — the first of the stack.
    image_lora: loras[0]?.key ?? null,
    image_lora_strength: loras[0]?.strength ?? 1,
  };
}

/** Saves are SERIALIZED per project. The body is a SELECT-then-UPDATE over the
 *  whole `settings` jsonb, so two quick saves racing (the post-ref picker fires
 *  `onMode` then `onChange` as independent calls) let the second read miss the
 *  first write and overwrite it — the control then visibly snapped back. A
 *  promise chain makes the second save read the first one's result. */
const settingsQueue = new Map<string, Promise<unknown>>();

export async function saveProjectSettings(
  projectId: string, patch: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  const prev = settingsQueue.get(projectId) ?? Promise.resolve();
  const run = prev.then(
    () => saveProjectSettingsNow(projectId, patch),
    () => saveProjectSettingsNow(projectId, patch)
  );
  settingsQueue.set(projectId, run);
  run.finally(() => {
    if (settingsQueue.get(projectId) === run) settingsQueue.delete(projectId);
  }).catch(() => {});
  return run;
}

/** A SAVE THAT DID NOT SAVE MUST THROW, because every caller of this treats a
 *  resolved promise as proof and shows the user something that says so.
 *
 *  Two silent failures were possible here and both end the same way: the
 *  panel keeps an OPTIMISTIC value on screen until the server agrees with it
 *  (ContextPanel's overlay stands deliberately, so a refetch that predates the
 *  write cannot snap a control back) — so a write that never lands leaves the
 *  sidebar showing a chain the database does not have, indefinitely, while
 *  every other surface reads the row and shows the old one. That is exactly
 *  what "the render modal doesn't show what I set in the sidebar" looks like
 *  from the outside, and nothing anywhere says the save failed.
 *
 *  1. THE READ'S ERROR WAS DISCARDED (`const { data } = ...`). This is a
 *     read-modify-write over the whole `settings` jsonb, so a failed read did
 *     not merely lose context — it made `next` the patch ALONE and wrote that
 *     over every other setting the project had. Same shape CLAUDE.md already
 *     records for a bad column name in a `select`: the client hands a failure
 *     back as data-less success, so it degrades a feature instead of breaking
 *     it.
 *  2. THE UPDATE WAS NOT VERIFIED. PostgREST answers an UPDATE that matched no
 *     rows with 204 and no error — an RLS-filtered row and a wrong id are both
 *     indistinguishable from success — so `.select("id")` and a count is the
 *     only way to know a row was written. */
async function saveProjectSettingsNow(
  projectId: string, patch: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  const { data, error: readErr } = await supabase.from("projects")
    .select("settings,style,aspect").eq("id", projectId).single();
  if (readErr) throw readErr;
  const next = { ...((data?.settings ?? {}) as ProjectSettings), ...patch };
  const updateObj: Record<string, unknown> = { settings: next };

  if (patch.style_guide !== undefined) {
    const matched = STYLE_PRESETS.find((p) => p.guide.trim() === patch.style_guide?.trim());
    if (matched) {
      updateObj.style = matched.label;
    } else if (patch.style_guide === "") {
      updateObj.style = null;
    }
  }
  if (patch.aspect) {
    updateObj.aspect = patch.aspect;
  }

  const { data: wrote, error } = await supabase.from("projects")
    .update(updateObj).eq("id", projectId).select("id");
  if (error) throw error;
  if (!wrote?.length) {
    throw new Error("the project row did not accept the change — sign in again, "
                  + "or ask the owner for edit access");
  }

  invalidateTables(["projects"]);
  return next;
}

/** A catalog id is not a model_map key, and the browser has to guess.
 *
 *  ONE table, in `director/model_keys.js`, because there were two and they
 *  drifted: `h3-pdd-local` was added here and to `gen_model_catalog.py` when
 *  the PDD row shipped and to NEITHER of the other copies, so the hosted
 *  director and the worker's twin both derived `h3-pdd` — not a model_map key
 *  — and any "re-render b6 on PDD" died with `model 'h3-pdd' not available`.
 *  Re-exported rather than re-declared so the dozen call sites that import
 *  `modelKeyOf` from here are unchanged; `model_keys.test.mjs` pins the two
 *  remaining hand-kept copies (the worker's and the sync script's) against it.
 *
 *  Returning undefined DROPS the key rather than failing: the pod falls back
 *  to its own default and the render happens. That is the right trade there
 *  only because the alternative is a dead job — everywhere else in this
 *  codebase a silently substituted model is the bug, so the surfaces that can
 *  say which plane a pick runs on should keep saying it. */
export { catalogIdOf, modelKeyOf } from "../../director/model_keys.js";

/** What "use the project style guide" will actually prepend, and where it came
 *  from — one resolution instead of the `style_guide || project.style` chain
 *  that was repeated at five call sites.
 *
 *  `source` matters to the UI. `guide` is the real thing: prose long enough to
 *  hold a look together. `legacy` is v1's one-word `projects.style` column
 *  ("anime"), which is what most projects still have, and pasting it in front
 *  of a prompt is barely a style instruction at all — it just silently prefixes
 *  a word. A control that says "style guide" while injecting that is lying
 *  about what it does, so callers get the text and its provenance and can say
 *  which one is in play.
 */
export function styleTextFor(
  settings: ProjectSettings | null | undefined,
  projectStyle?: string | null,
): { text: string; source: "guide" | "legacy" | "none" } {
  if (settings?.style_guide && settings.style_guide.trim()) {
    return { text: settings.style_guide.trim(), source: "guide" };
  }
  const legacy = (projectStyle ?? "").trim();
  if (legacy) {
    const preset = STYLE_PRESETS.find(
      (p) => p.id.toLowerCase() === legacy.toLowerCase() || p.label.toLowerCase() === legacy.toLowerCase()
    );
    if (preset) {
      return { text: preset.guide, source: "guide" };
    }
    return { text: legacy, source: "legacy" };
  }
  const fallback = resolveDefaults(settings).style_guide?.trim();
  if (fallback) return { text: fallback, source: "guide" };
  return { text: "", source: "none" };
}

/** Style guide + subject, in the order a prompt wants them. Keeps every call
 *  site from re-inventing how the two are joined. */
export function withStyle(styleGuide: string | undefined, ...parts: (string | undefined)[]): string {
  // Trim trailing sentence punctuation before joining: a style guide written
  // as prose already ends in a full stop, and "No 3D.. character sheet" reads
  // like a typo to a human and like noise to a model.
  return [styleGuide, ...parts]
    .map((p) => (p ?? "").trim().replace(/[.,;\s]+$/, ""))
    .filter(Boolean)
    .join(". ");
}

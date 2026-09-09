// The two intents behind "this panel is wrong", and every decision that
// differs between them.
//
// A panel is a picture the SHOT renders from — it stages as a `scene_ref`
// whose framing is copied, and a clip opens almost exactly on it (measured:
// 0.994/0.894/0.272/0.988/0.994 luma correlation at 0.1s) — so a wrong panel
// is a wrong shot, and fixing one has to be direct. There are two ways to fix
// it and they are not the same act:
//
//   REDRAW — a new roll of the same picture. The prompt is yours to edit, the
//     seed rerolls, and what comes back is a different attempt at the shot.
//   EDIT   — the panel itself becomes the first reference and the sampler is
//     seeded from it (`mode: "edit"` — `handle_image_gen` sets
//     `editing = has_refs and mode == "edit"` and passes `ref_names[0]` as
//     `source_image` at `denoise`), so everything you don't name is held. The
//     seed holds too, for the same reason.
//
// This is the image twin of `retake.ts` and deliberately NOT the same module.
// The video side's Edit rides `video_edit`/`<Video 1>` and its Regenerate
// rewrites the block's BEATS through `revise_block`; neither is right here. A
// beat is what the video block compiles from as well, so a note that rewrote
// it to fix a PANEL would silently change the shot — the panel path composes
// from `payload.prompt` alone and always has (`prompt_spec` is withheld on
// purpose, or `handle_image_gen` recomposes from the spec and discards
// whatever was typed).
//
// Split out of the modal for the reason retake.ts is: the component reaches
// supabase, so none of this could be tested — and every decision here fails
// SILENTLY when it is wrong.
//   * An edit queued against a model with no `edit` mode composes a brand-new
//     frame from an empty latent and hands back a different picture that
//     merely resembles the panel.
//   * A source that is not `ref_asset_ids[0]` edits a DIFFERENT picture: the
//     worker reworks `ref_names[0]`, whatever happens to be there.
//   * A redraw carrying no seed renders at seed 0 — which is what the panel
//     already rendered at (`int(payload.get("seed") or 0)`), so an unchanged
//     prompt returns the identical file and the button reads as broken.
//   * On the H3 image rows an edit is `len(ref_names) == 1`; adding one
//     reference silently turns it back into a compose.
//
// Nothing here imports anything that touches the network.
import { rollSeed } from "./retake.ts";

export { rollSeed };

export type PanelMode = "redraw" | "edit";

/** Roll once and replace the panel, or roll several and choose.
 *
 *  `panel` writes the single `beats.meta.panel_asset_id` slot; `panel_alt`
 *  appends to `beats.meta.panel_alts`. N jobs aimed at the single slot would
 *  overwrite each other and leave whichever landed last — a race, not a
 *  choice (see `queueBeatPanelAlternates`, which learned this first). */
export type PanelTarget = "panel" | "panel_alt";

/** The slice of `model_catalog` this decision reads. A structural type rather
 *  than `ModelCatalogRow` so the tests can state a model in four keys. */
export interface PanelModel {
  id: string;
  display_name?: string | null;
  family?: string | null;
  modes?: string[] | null;
  capabilities?: Record<string, unknown> | null;
}

/** How many pictures this model takes at once.
 *
 *  Same reading as GenComposer's `refCap`, including its last clause: a model
 *  that declares only `edit` still has one slot, because the picture being
 *  edited IS a reference. Reading `multiRef` alone reported 0 there and the
 *  grid then refused to hold the source. */
export function refCapacity(m: PanelModel | null | undefined): number {
  const c = (m?.capabilities ?? {}) as { refs?: number; multiRef?: number; edit?: unknown };
  return Number(c.multiRef ?? c.refs ?? 0) || (c.edit ? 1 : 0);
}

const modesOf = (m: PanelModel | null | undefined): string[] => m?.modes ?? [];

/** Why Edit can't run here, or "" when it can. Phrased for the tab's `title`,
 *  since that is what someone reads when the button is grey.
 *
 *  Two checks, and both are load-bearing. `modes` is what the WORKER will
 *  branch on: `editing` is gated on `mode == "edit"` reaching a family that
 *  implements it, and a model without it renders the r2i compose path — a
 *  different picture, arriving with nothing to say it was substituted, which
 *  is the silent downgrade this codebase keeps naming. `refCapacity` is the
 *  BUDGET: the source rides in as a reference, so a model with no reference
 *  slot has nowhere to put the thing being edited. */
export function editBlocker(o: {
  hasSource: boolean;
  model: PanelModel | null;
  modelName: string;
}): string {
  if (!o.hasSource) {
    return "Nothing drawn yet — the panel has to exist before you can edit it.";
  }
  if (!modesOf(o.model).includes("edit")) {
    return `${o.modelName} composes a new frame from its references and can't rework one`
      + ` — pick a model that edits (Qwen-Image-Edit, MiniMax H3 · image), or redraw.`;
  }
  if (refCapacity(o.model) < 1) {
    return `${o.modelName} takes no reference images, and an edit rides in as one.`;
  }
  return "";
}

/** Opening intent, and it is REDRAW even when the panel is editable.
 *
 *  Deliberately the opposite of the video side, where a block with a take
 *  opens on Edit. This modal is entered from "this panel is wrong" — the
 *  button that opens it says Redraw, the prompt is already loaded and
 *  editable, and Edit is the narrower act ("everything I don't name is held").
 *  Opening on Edit would quietly change what the existing button does. */
export const defaultPanelMode = (): PanelMode => "redraw";

/** What an edit will actually do on THIS family, when that differs from what
 *  the tab promises. "" when there is nothing to say.
 *
 *  The H3 rows are the case: `edit_one = editing and len(ref_names) == 1`, so
 *  a single added reference drops the render back onto the ref2va compose
 *  path. It still renders, it just isn't an edit any more — and the only trace
 *  is a line in the pod's journal. */
export function editRefWarning(model: PanelModel | null, addedRefs: number): string {
  if (!addedRefs) return "";
  if ((model?.family ?? "") === "minimax-h3") {
    return `H3 edits one picture only — with ${addedRefs} more reference`
      + `${addedRefs === 1 ? "" : "s"} staged it composes a new frame from the set instead`
      + ` of reworking this one. Remove them, or use Redraw.`;
  }
  return "";
}

export interface PanelCopy {
  tab: string;
  tabSub: string;
  title: string;
  /** what the big text box is, which is NOT the same field in both modes */
  fieldLabel: string;
  fieldHint: string;
  placeholder: string;
  refsLabel: string;
  refsHint: string;
  chips: string[];
  primary: (rolls: number) => string;
}

export const COPY: Record<PanelMode, PanelCopy> = {
  redraw: {
    tab: "Redraw",
    tabSub: "new roll · same references",
    title: "Redraw panel",
    // The PROMPT, not a brief: this path sends what is typed straight to the
    // model. The video side hid its prompt because a compiler owns it; here
    // withholding `prompt_spec` is what makes the edit take effect at all.
    fieldLabel: "Prompt",
    fieldHint:
      "[FRAMING] decides how much of the frame the subject fills; "
      + "[LOCKED CHARACTER] is what holds identity against the references.",
    placeholder: "The prompt this panel renders from.",
    refsLabel: "References",
    refsHint: "identity and design are taken from these; their framing is not",
    chips: ["extreme wide shot", "low angle", "over-the-shoulder",
            "no lettering, no split screen"],
    primary: (n) => (n > 1 ? `Redraw · ${n} rolls` : "Redraw panel"),
  },
  edit: {
    tab: "Edit this panel",
    tabSub: "hold the picture · change one thing",
    title: "Edit panel",
    fieldLabel: "What should this edit change",
    fieldHint:
      "Everything you don't name is held from the panel — its framing, its cast, "
      + "its light. Name one change.",
    placeholder:
      "Name the one thing that changes. “Open the shutter behind her so the "
      + "street reads through it.”",
    refsLabel: "References for the edit",
    refsHint: "only what the edit BRINGS IN — the panel already carries the rest",
    chips: ["change the light", "remove the crowd", "open her eyes",
            "make it night", "fix the hands"],
    primary: (n) => (n > 1 ? `Edit · ${n} rolls` : "Edit panel"),
  },
};

export type SeedMode = "roll" | "hold";

/** Redraw rolls, edit holds — unless there is nothing to hold.
 *
 *  A redraw that reuses the seed returns the same picture — literally the same
 *  file when the prompt is untouched, since the panel rendered at this seed
 *  already. An edit holds, because the promise is that only the named thing
 *  moves. Either is overridable; the DEFAULT is what follows the intent.
 *
 *  `hasHeld` is the third case and it is the honest one: a picture that
 *  recorded no seed (uploaded, or rendered before the field existed) has no
 *  roll to resume, so an edit there rolls a fresh one. Defaulting to "hold"
 *  regardless put `seed —` on the control and then quietly rolled anyway,
 *  which is a control describing something other than what happens. */
export const defaultSeedMode = (m: PanelMode, hasHeld = true): SeedMode =>
  (m === "edit" && hasHeld ? "hold" : "roll");

/** The seed a HOLD means: the one this panel was rendered at.
 *
 *  `handle_image_gen` records it on the asset (`meta.seed`), so an edit can
 *  genuinely resume the same roll. Absent — an older asset, or one uploaded
 *  rather than rendered — there is nothing to hold and the honest answer is to
 *  roll, not to invent a number and call it the panel's. */
export function heldSeed(meta: Record<string, unknown> | null | undefined): number | null {
  const s = meta?.seed;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

/** Seeds for one round of N rolls.
 *
 *  Distinct, or the round is N copies of one picture — the failure
 *  `queueBeatPanelAlternates` documents, arriving here by the same route. */
export const altSeeds = (base: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => base + i);

/** Where a round of rolls starts.
 *
 *  A ROLL is random, deliberately — not `seedBase(beat)`, which is what the
 *  scene editor's alternates use. That one advances only with the count of
 *  alternates already on the beat, and a single roll targets `panel` rather
 *  than `panel_alts`: so pressing Redraw twice with an unchanged prompt would
 *  derive the same seed twice and hand back the identical picture, which is
 *  the exact bug the seed exists to fix, one layer further in.
 *
 *  A HOLD takes the panel's own, and falls back to a roll when it recorded
 *  none — there is no roll to resume, and a made-up number is not the
 *  panel's. A typed seed outranks both: it is the one case where somebody is
 *  asking for a specific picture. */
export function seedForRound(o: {
  seedMode: SeedMode;
  typed: number | null;
  held: number | null;
  rnd?: () => number;
}): number {
  if (o.typed != null) return o.typed;
  if (o.seedMode === "hold" && o.held != null) return o.held;
  return rollSeed(o.rnd);
}

/** Where a round lands. One roll replaces the panel; several are offers. */
export const targetFor = (rolls: number): PanelTarget => (rolls > 1 ? "panel_alt" : "panel");

/** Why the queue button is refusing, or "" when it will queue. */
export function queueBlocker(o: {
  mode: PanelMode;
  text: string;
  editWhy: string;
}): string {
  if (o.mode === "edit") {
    if (o.editWhy) return o.editWhy;
    if (!o.text.trim()) {
      return "Say what the edit changes — an edit with no instruction re-renders the panel as it is.";
    }
    return "";
  }
  if (!o.text.trim()) return "The prompt is empty.";
  return "";
}

export interface SummaryInput {
  mode: PanelMode;
  refCount: number;
  rolls: number;
  seedMode: SeedMode;
  seed: number | null;
  width: number;
  height: number;
  denoise?: number;
}

/** The footer's mono strip.
 *  Redraw: `3 refs · 5 rolls · new seed · 1280×704`
 *  Edit:   `panel + 1 ref · seed 8412 held · changes 55% · 1280×704` */
export function footerSummary(o: SummaryInput): string {
  const parts: string[] = [];
  parts.push(o.mode === "edit"
    ? `panel${o.refCount ? ` + ${o.refCount} ref${o.refCount === 1 ? "" : "s"}` : ""}`
    : `${o.refCount} ref${o.refCount === 1 ? "" : "s"}`);
  if (o.rolls > 1) parts.push(`${o.rolls} rolls`);
  parts.push(o.seedMode === "roll" ? "new seed"
    : o.seed != null ? `seed ${o.seed} held` : "seed held");
  if (o.mode === "edit" && o.denoise != null) {
    parts.push(`changes ${Math.round(o.denoise * 100)}%`);
  }
  parts.push(`${o.width}×${o.height}`);
  return parts.join(" · ");
}

/** Extends the index-signature type so a payload can be handed straight to
 *  `enqueueJob`'s `Record<string, unknown>` without a cast that would also
 *  swallow a genuine mistake. */
export interface PanelJobPayload extends Record<string, unknown> {
  quality?: string;
  prompt: string;
  ref_asset_ids: string[];
  width: number;
  height: number;
  seed: number;
  auto_accept: true;
  user_edit: true;
  target: { beat_id: string; as: PanelTarget };
  label: string;
}

export interface PanelJobInput {
  /** hosted render quality, when the picked model takes one */
  quality?: string | null;
  mode: PanelMode;
  /** the panel being redrawn or edited */
  sourceAssetId: string;
  beatId: string;
  /** what the box says: the prompt on a redraw, the instruction on an edit */
  text: string;
  /** the reference set — on an edit these are ADDITIONS, the source is added
   *  by this function and must not be listed again */
  refAssetIds: string[];
  seed: number;
  width: number;
  height: number;
  rolls: number;
  /** model_map key. Local rows only: a key the worker cannot resolve fails the
   *  render, same rule as the wizard's `*-local` gate. */
  modelKey?: string | null;
  denoise?: number;
  label: string;
}

/** One job per roll. Everything a round shares is decided once, here, because
 *  the two things that differ per roll (the seed, and nothing else) are the
 *  whole reason a round is not one job repeated.
 *
 *  Three rules this encodes, each of them a silent failure otherwise:
 *
 *  * **`prompt_spec` is never sent.** `handle_image_gen` recomposes the prompt
 *    from the spec whenever one is present, which discards what was typed.
 *  * **The source leads `ref_asset_ids` on an edit.** The worker reworks
 *    `ref_names[0]`; anything else there is the picture that gets edited.
 *  * **A seed is always written.** `payload.seed or 0` is the default, and 0
 *    is the seed the panel already rendered at.
 *
 *  References travel as `ref_asset_ids`, never `anchors`: anchors are the
 *  late-bound form (entry + role, resolved at run time) and there is nothing
 *  late about a redraw you are watching. */
export function panelJobs(o: PanelJobInput): PanelJobPayload[] {
  const rolls = Math.max(1, Math.trunc(o.rolls));
  const as = targetFor(rolls);
  const editing = o.mode === "edit";
  const refs = editing
    ? [o.sourceAssetId, ...o.refAssetIds.filter((id) => id !== o.sourceAssetId)]
    : o.refAssetIds;
  return altSeeds(o.seed, rolls).map((seed, i) => ({
    prompt: o.text.trim(),
    ...(editing ? { mode: "edit" as const } : {}),
    ...(editing && o.denoise != null ? { denoise: o.denoise } : {}),
    ref_asset_ids: refs,
    ...(o.modelKey ? { model_key: o.modelKey } : {}),
    // Only where the model exposes one — the worker defaults panels to low
    // anyway, so a key the render ignores would be the silent no-op this
    // codebase keeps naming.
    ...(o.quality ? { quality: o.quality } : {}),
    width: o.width,
    height: o.height,
    seed,
    auto_accept: true as const,
    user_edit: true as const,
    target: { beat_id: o.beatId, as },
    label: rolls > 1 ? `${o.label} · ${editing ? "edit" : "redraw"} ${i + 1}/${rolls}`
      : `${o.label} · ${editing ? "edit" : "redraw"}`,
  }));
}

/** What the user is told after queueing. Says where the pictures LAND, which
 *  is the one thing the two targets differ on and the one thing nothing else
 *  on screen explains. */
export function queuedNote(rolls: number, mode: PanelMode): string {
  const verb = mode === "edit" ? "Editing" : "Redrawing";
  return rolls > 1
    ? `${verb} × ${rolls} — they land side by side under the panel to choose from.`
    : `${verb} — it replaces this shot's panel when it lands, and the picture it`
      + ` replaces stays in the rolls below.`;
}

/** Promoting an alternate writes the AUTO slot, so on a beat carrying a user's
 *  own designated still it changes what RENDERS without changing what the
 *  strip shows. Say so rather than looking broken (the rule `panelChoiceMeta`
 *  states and leaves to its caller). */
export function promotedNote(hasUserStill: boolean): string {
  return hasUserStill
    ? "Promoted — but this beat has a still you designated, which still outranks it"
      + " everywhere. The render uses the panel; the strip keeps showing your still."
    : "Promoted — this is the shot's panel now.";
}

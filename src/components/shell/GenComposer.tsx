// The library's generate dock — free-form generation, straight into the library.
//
// Everything else that spends GPU time here is attached to something — a bible
// entry, a scene still, a storyboard block. There was no way to just make a
// picture or a shot, which is the first thing you want when you are working
// out what a project should look like. This is that: a prompt, a model, the
// input type that model actually supports, references, and a queue button.
//
// It is shaped like a chat composer and pinned to the bottom of the library
// for a reason. The old form was a collapsed card above the grid: you opened
// it, filled a 268px settings column, queued, and it stayed open covering the
// results you had just asked for. Generation here is a conversation with the
// library — prompt, look at what landed, adjust, prompt again — so the prompt
// box never leaves, the settings compress into one row of pills you only open
// when you want to change something, and the results scroll underneath.
//
// It writes an ordinary jobs row like everything else (invariant #1); nothing
// here talks to the pod.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AtSign, Ban, Check, ChevronDown, ClipboardPaste, Cloud, Dice5, Globe,
  Image as ImageIcon, Laptop, Layers, Loader2, Music, Palette, Maximize2, Mic2,
  Play, Plus, Ratio, Sparkles, SlidersHorizontal, Timer, Undo2, Upload, Video, Wand2,
  Workflow, X,
} from "lucide-react";
import Dropdown from "../ui/Dropdown";
import AssetPickerModal from "../modals/AssetPickerModal";
import {
  defaultNegative, LoraStack, styleLoras, takesNegative, takesRefine, validLoras,
} from "../ui/ImageModelPicker";
import { loadWorkflows } from "../../lib/db/customWorkflows";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { invalidateTables, useLiveQuery } from "../../hooks/useLiveQuery";
import { useJobCancel } from "../../hooks/useJobCancel";
import { supabase } from "../../lib/supabase";
import { assetUrl, loadAssets, loadAssetsByIds, registerAsset } from "../../lib/db/assets";
import { probedUploadMeta } from "../../lib/mediaProbe";
import { loadBible, loadBibleAssets } from "../../lib/db/director";
import { enqueueJob, loadJobsByIds, type JobProgress } from "../../lib/db/jobs";
import { jobLabel } from "../../lib/jobMeta";
import { loadCatalog } from "../../lib/catalog";
import { uploadMedia } from "../../lib/upload";
import { clipboardMediaFiles, pasteChord, readClipboardMedia } from "../../lib/clipboardMedia";
import {
  backendLabel, describeDirectorError, enhanceAlignment,
  enhanceGuide, enhancePrompt,
} from "../../lib/director";
import {
  modelKeyOf, resolveDefaults, saveProjectSettings, STYLE_PRESETS, styleTextFor, withStyle,
  type LoraPick, type ProjectSettings,
} from "../../lib/projectSettings";
import { estimateSeconds, fmtEta, loadTimings } from "../../lib/eta";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import { useByok, useByokRows } from "../../hooks/useByok";
import { isDesktop } from "../../lib/desktop";
import { isByokRow } from "../../lib/byokCatalog";
import { TIER_META, tierOf, qualityTiers,
         type ModelTier, type Quality } from "../../lib/localModels";
import TieredModelMenu, { TierIcon } from "../ui/TieredModelMenu";
import { pad17, msToFramesCeil, framesToMs, FPS, MAX_FRAMES, MIN_FRAMES } from "../../lib/h3timing";
import { ASPECTS, fitSize, megapixels, resOptions } from "../../lib/resolution";
import { isStill } from "../../lib/assetKind";
import type { Asset, Job, ModelCatalogRow } from "../../lib/db/types";

interface HoverPreview { id: string; rect: DOMRect; asset: Asset; label: string }

const isVideoAsset = (a: Asset | null | undefined): boolean => {
  if (!a) return false;
  if (a.kind === "audio") return false;
  if (a.kind === "video" || a.kind === "render") return true;
  if (a.content_type?.startsWith("video/")) return true;
  if (/\.(mp4|webm|mov|mkv|m4v)$/i.test(a.b2_key ?? "")) return true;
  return !isStill(a);
};


/** The three things this dock makes. `music` is the UI's word; the catalog
 *  column and the asset row both say `audio`, so the two are mapped rather
 *  than renamed — `assets.kind` has no music value and inventing one would
 *  make every existing audio surface (timeline lanes, the picker, ingest)
 *  blind to a generated track. */
type GenKind = "image" | "video" | "music";
const CATALOG_KIND: Record<GenKind, string> = { image: "image", video: "video", music: "audio" };
/** The kinds whose handler actually branches on `payload.workflow_id` —
 *  handle_clip_gen and handle_image_gen. `music_gen` is excluded because
 *  nothing reads the field there, and an offered pick the render ignores is
 *  the silent no-op the negative-prompt and LoRA gating already guard against. */
const WF_KINDS: GenKind[] = ["video", "image"];

/** What each mode needs from you, in the order the form asks for it. */
const MODES: Record<string, { label: string; short: string; needs: string; kind: GenKind }> = {
  t2i: { label: "text → image", short: "from text", needs: "", kind: "image" },
  // r2i composes a SET of references into a new frame (Krea2EditRebalance,
  // Flux 2 ReferenceLatent); edit reworks one supplied image (Flux.1 Kontext).
  // Both carry references, which is why the multi-ref path had no name of its
  // own before and hid under "image edit".
  r2i: { label: "references → image", short: "from refs", needs: "refs", kind: "image" },
  edit: { label: "image edit", short: "edit", needs: "refs", kind: "image" },
  t2v: { label: "text → video", short: "from text", needs: "", kind: "video" },
  i2v: { label: "image → video", short: "from image", needs: "start", kind: "video" },
  flf: { label: "first → last", short: "first→last", needs: "start+end", kind: "video" },
  r2v: { label: "references → video", short: "from refs", needs: "refs", kind: "video" },
  v2v: { label: "video → video", short: "from video", needs: "source", kind: "video" },
  t2m: { label: "text → music", short: "from text", needs: "", kind: "music" },
};

const DURATIONS = [4, 5, 6, 8, 10, 12, 15];
/** Song lengths, in seconds. Both models plan structure against the length
 *  they are given, so these are musical durations (a hook, a radio edit, a
 *  full track) rather than a linear ladder. */
const SONG_SECONDS = [15, 30, 60, 90, 120, 180, 240];
/** ACE-Step's `keyscale` enum, in the order the node declares it. */
const KEY_SCALES = ["major", "minor"].flatMap((m) =>
  ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"]
    .map((r) => `${r} ${m}`));

/** A stored prompt already has the project style baked into its front (`go`
 *  writes `withStyle(...)` into the payload). Reusing it verbatim with the
 *  style toggle still on would prepend the guide a second time, so split it
 *  back off and let the toggle mean what it says. */
function splitStyle(prompt: string, style: string): { text: string; hadStyle: boolean } {
  const head = style.trim().replace(/[.,;\s]+$/, "");
  if (!head || !prompt.startsWith(head)) return { text: prompt, hadStyle: false };
  const rest = prompt.slice(head.length).replace(/^[.,;\s]+/, "");
  return rest ? { text: rest, hadStyle: true } : { text: prompt, hadStyle: false };
}

/** How many references this model can actually USE.
 *
 *  A model that declares no reference count but does declare `edit` takes
 *  exactly one — Flux.1's Kontext is a single-image instruction edit. It read
 *  as 0 here, which the callers treated as "no ceiling" and offered nine slots
 *  for a graph that consumes the first and ignores the rest. */
const refCap = (m: ModelCatalogRow | null) => {
  const c = (m?.capabilities ?? {}) as { multiRef?: number; refs?: number; edit?: unknown };
  return Number(c.multiRef ?? c.refs ?? 0) || (c.edit ? 1 : 0);
};

/**
 * Where a model runs, as one glyph.
 *
 * The same mark leads the group header and sits in the closed control, so the
 * pill can answer "am I about to spend GPU money" without being opened. Colour
 * carries it as much as the shape: green for free-and-local, the UI accent for
 * the studio's own box, amber for anything metered.
 */

/** One toolbar control: icon, value, chevron. The dock's only button shape. */
function Ctl({
  icon, value, on, mono, title, width = 240, align = "left", children,
}: {
  icon: React.ReactNode;
  value: string;
  on?: boolean;
  mono?: boolean;
  title?: string;
  width?: number;
  align?: "left" | "right";
  children: (close: () => void) => React.ReactNode;
}) {
  return (
    <Dropdown width={width} align={align}
      trigger={({ toggle }) => (
        <button className={"gd-ctl" + (on ? " on" : "") + (mono ? " mono" : "")}
                title={title} onClick={toggle}>
          {icon}
          <span className="v">{value}</span>
          <ChevronDown size={11} />
        </button>
      )}>
      {children}
    </Dropdown>
  );
}

/** Prompt box geometry. `PEEK` is what a collapsed box keeps on screen — two
 *  lines, so a long prompt still reads as a prompt rather than as an empty
 *  composer, and a SHORT one is already under it and therefore never moves. */
const TA_MIN = 48, TA_MAX = 300, TA_PEEK = 66;

export default function GenComposer({ projectId, collapsed = false, onExpand }: {
  projectId: string | null;
  /** The list behind the dock is being scrolled, so give it the room back.
   *  Owned by the view that holds both, since it is the one that knows the
   *  list scrolled — the dock only knows how to get out of the way. */
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const ws = useWorkspaceStore();
  const preset = ws.genPreset;
  const [kind, setKind] = useState<GenKind>("image");
  const [prompt, setPrompt] = useState("");
  /** Sung words. Separate state from `prompt` because they are separate inputs
   *  on both encoders — the caption describes the record, the lyrics are what
   *  the voice performs, and merging them gives you a song about its own
   *  production notes. */
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [songSec, setSongSec] = useState(60);
  /** ACE-Step's typed musical metadata. Real encoder inputs, not prose. */
  const [bpm, setBpm] = useState(120);
  const [keyScale, setKeyScale] = useState("C major");
  const [timeSig, setTimeSig] = useState("4");
  const [modelId, setModelId] = useState<string | null>(null);
  /** An imported ComfyUI graph to render with instead of the model's own
   *  template. Null is "model default", which is every existing caller. */
  const [customWfId, setCustomWfId] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [aspectId, setAspectId] = useState("16:9");
  const [resId, setResId] = useState<string | null>(null);
  const [seed, setSeed] = useState<number | null>(null);
  const [durSec, setDurSec] = useState(5);
  /** Sampler steps, LOCAL renders only. Null = whatever the recipe declares. */
  const [steps, setSteps] = useState<number | null>(null);
  const [loras, setLoras] = useState<LoraPick[]>([]);
  /** what to steer AWAY from — only reaches the payload on models that sample
   *  a negative branch (see `takesNegative`); empty means the model's own
   *  default from model_map. */
  const [negative, setNegative] = useState("");
  /** Second, higher-resolution sampler pass (`takesRefine`). Off by default:
   *  it is extra GPU time on every render, and the quality case for it is
   *  measured per shot rather than assumed. */
  const [refine, setRefine] = useState(false);
  const [refs, setRefs] = useState<Asset[]>([]);
  const [startAsset, setStartAsset] = useState<Asset | null>(null);
  const [endAsset, setEndAsset] = useState<Asset | null>(null);
  const [useStyle, setUseStyle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  /** what the prompt was before the last rewrite, so one click undoes it */
  const [preEnhance, setPreEnhance] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [warn, setWarn] = useState(true);
  /** ids of generations queued FROM THIS DOCK, newest first — what the live
   *  strip below the composer reports on. The queue popover already lists the
   *  whole studio's work; what pressing Generate lacked was any word about the
   *  one job you just pressed it for. */
  const [sent, setSent] = useState<string[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const [pastingMedia, setPastingMedia] = useState(false);
  const chord = useMemo(pasteChord, []);
  const [eta, setEta] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** in-progress edit of the project's style guide (null = not editing) */
  const [styleDraft, setStyleDraft] = useState<string | null>(null);
  const [savingStyle, setSavingStyle] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** does the prompt need more room than a collapsed box gives it? */
  const [tall, setTall] = useState(false);
  /** refs queued from the side panel while the dock was unmounted */
  const pendingShelf = useRef<string[] | null>(null);

  const [hover, setHover] = useState<HoverPreview | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openHover = (h: Omit<HoverPreview, "rect">, el: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const rect = el.getBoundingClientRect();
    hoverTimer.current = setTimeout(() => setHover({ ...h, rect }), 120);
  };
  const closeHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(null), 140);
  };
  const holdHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  };

  const { data, reload: reloadData } = useLiveQuery(
    async () => {
      const [catalog, library, { data: project }, bible] = await Promise.all([
        loadCatalog(),
        loadAssets({ limit: 60 }),
        projectId
          ? supabase.from("projects").select("settings,style").eq("id", projectId).maybeSingle()
          : Promise.resolve({ data: null }),
        // Independent of the rest of the round — it was a sequential hop.
        projectId ? loadBible(projectId, { committedOnly: true }) : Promise.resolve([]),
      ]);
      const links = bible.length ? await loadBibleAssets(bible.map((e) => e.id)) : [];
      const ids = [...new Set(links.map((l) => l.asset_id))];
      const { data: bibleAssets } = ids.length
        ? await supabase.from("assets").select("*").in("id", ids) : { data: [] };
      return {
        catalog, library, bible, links,
        bibleAssets: (bibleAssets ?? []) as Asset[],
        settings: ((project as { settings?: ProjectSettings } | null)?.settings ?? {}) as ProjectSettings,
        projectStyle: (project as { style?: string } | null)?.style ?? null,
      };
    },
    // `projects` too: the style guide read here lives on that row, so saving
    // one has to refresh this query or the toolbar keeps showing the old value.
    ["assets", "bible_assets", "projects"], [projectId]
  );

  // Runnable models first, whatever `sort` says. Two disabled hosted rows
  // sat above a local checkpoint on sort alone, which pushed a 13GB model
  // that is actually on this machine below the fold of the menu — models you
  // cannot pick should never outrank models you can.
  //
  // The desktop engine's models are CONCATENATED here rather than merged into
  // `model_catalog`: they are not the studio's models, they are whatever this
  // machine finished downloading, and they change without a database write.
  const engine = useLocalEngine();
  // The hosted rows the user's OWN keys turn on. Concatenated for the same
  // reason the engine's are, and with the same shape: what is available is not
  // a database fact but a property of this machine — there, what finished
  // downloading; here, which keys are in the keychain. `useByokRows` answers
  // [] in the browser and on a machine with no keys, so this needs no build
  // check of its own.
  //
  // They REPLACE the catalog's own copy of the same row rather than sitting
  // beside it: `byokRows` re-enables the row it was given, so keeping both
  // would put "GPT Image 2" in the menu twice — once runnable, once greyed.
  const byokRows = useByokRows(data?.catalog);
  const { config: byokCfg } = useByok();
  const models = useMemo(
    () => [...(data?.catalog ?? []).filter((m) => !byokRows.some((b) => b.id === m.id)),
           ...byokRows, ...engine.rows]
      // `kind` alone stopped being enough once SFX rows landed: they are
      // `audio` too (the column's check constraint allows no third value), and
      // a Stable Audio row in the MUSIC picker would offer a 6-second sound
      // effect where a song was asked for, and a TTS row would offer a voice.
      // The mode is the discriminator, named POSITIVELY — "not t2sfx" would
      // have swallowed the speech rows the moment they landed. Same rule
      // `catalog.musicModels` / `sfxModels` / `ttsModels` follow.
      .filter((m) => m.kind === CATALOG_KIND[kind]
        && (kind !== "music" || m.modes?.includes("t2m") || !m.modes?.length))
      .slice()
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.sort - b.sort),
    [data, engine.rows, byokRows, kind]);
  const model = models.find((m) => m.id === modelId) ?? null;
  const tier = model ? tierOf(model) : null;
  /**
   * A LOCAL PROJECT CANNOT SEND WORK TO THE POD, said before the click.
   *
   * `enqueueJob` refuses it too (that guard covers the wizard, the director
   * and the storyboard as well), but a Generate button that fails on press is
   * the control this file already argues against: the reason belongs where the
   * choice is made. A project on this machine keeps its jobs in its own file,
   * and the pod polls Supabase.
   */
  /** Runnable because the user has a key for it. Not a tier: it IS the hosted
   *  tier, plus a credential — `TIER_META` still describes it correctly. */
  const byok = !!model && isByokRow(model);
  const local = tier === "local";
  /** The user's own definition of this row, when it is one of theirs. Only a
   *  custom fal endpoint has one; a catalog row is resolved by id at run time
   *  because the catalog is shared and cannot go stale under the job. */
  const byokModel = useMemo(
    () => byokCfg.custom.find((c) => c.id === model?.id) ?? null,
    [byokCfg, model?.id]);
  const recipeSteps = Number(model?.capabilities?.steps ?? 20);
  // The input types on offer are the model's, filtered to the ones this form
  // knows how to gather inputs for.
  const modes = (model?.modes ?? []).filter((m) => MODES[m]);
  const needs = mode ? MODES[mode]?.needs ?? "" : "";
  const cap = refCap(model);
  // An edit renders at the source image's size — Krea 2 encodes it into the
  // starting latent, Kontext scales to its own grid. The size pills still work,
  // they just don't apply here, and a control that shows a number the output
  // won't have is worse than one that says where the number came from.
  const srcAsset = mode === "edit" ? refs[0] ?? null : null;
  const srcSize = srcAsset?.width && srcAsset?.height
    ? `${srcAsset.width}×${srcAsset.height}` : null;
  const available = styleLoras(model);
  const negOk = takesNegative(model);
  const refineOk = takesRefine(model);
  // Default low: measured, the shot is right at every tier and only background
  // detail scales, at 6x the price from low to high.
  const [quality, setQuality] = useState<Quality>("low");
  /** Render quality — only the hosted rows that actually take one. Same rule
   *  as the negative prompt: gated on the MODEL, because the state survives a
   *  model switch and a payload key the render ignores is a silent no-op. */
  const qTiers = qualityTiers(model);
  const negDefault = defaultNegative(model);
  const isMusic = kind === "music";
  const caps = (model?.capabilities ?? {}) as Record<string, unknown>;
  /** ACE-Step exposes BPM / key / time signature as typed encoder inputs;
   *  Music 3 has no such fields and wants them written into the caption. */
  const musicalMeta = isMusic && caps.musicalMeta === true;
  const songCap = Math.max(15, model?.max_seconds ?? 300);
  const songLen = Math.min(songCap, songSec);
  // What the style toggle will actually prepend, and whether it is a real
  // style guide or just v1's one-word `projects.style`. The control has to be
  // able to say which — see the button below.
  const styleText = styleTextFor(data?.settings, data?.projectStyle);

  /** Write the style guide onto the project. Saving also clears the legacy
   *  one-word `style` so the two can never disagree about what is applied. */
  const saveStyle = async (text: string) => {
    if (!projectId) { setNote("Open a project to set its style guide."); setWarn(true); return; }
    setSavingStyle(true);
    try {
      await saveProjectSettings(projectId, { style_guide: text });
      await supabase.from("projects").update({ style: null }).eq("id", projectId);
      setStyleDraft(null);
      setUseStyle(!!text);
      reloadData();
      setNote(text ? "Style guide saved for this project." : "Style guide cleared.");
      setWarn(false);
    } catch (e) {
      setNote(`Could not save the style guide: ${String((e as Error).message).slice(0, 90)}`);
      setWarn(true);
    } finally { setSavingStyle(false); }
  };

  // Defaults SEED the controls, once per kind; they don't keep re-asserting
  // themselves. This ran on every `data` identity change, and `data` reloads
  // from realtime whenever an asset lands — so picking a non-default model and
  // then generating anything at all yanked the model back to the project
  // default underneath you, and a reused recipe lasted until the next tick.
  const seeded = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!data || seeded.current[kind]) return;
    seeded.current[kind] = true;
    const eff = resolveDefaults(data.settings);
    setModelId(kind === "image" ? eff.image_model
      : kind === "video" ? eff.video_model : eff.music_model);
    setAspectId(ASPECTS.some((a) => a.id === eff.aspect) ? eff.aspect : "16:9");
    setLoras(kind === "image" ? eff.image_loras : []);
  }, [data, kind]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Imported graphs, live — one appears in the picker the moment it is
  // imported, without a reload.
  const { data: workflows } = useLiveQuery(
    () => loadWorkflows(projectId ?? null), ["custom_workflows"], [projectId]);
  const customWf = (workflows ?? []).find((w) => w.id === customWfId) ?? null;
  // Offered on BOTH planes: `resolve_custom.py` runs an imported graph on the
  // pod and `localRender.graphForJob` runs the same stored `{api_graph, slots}`
  // on the machine's own ComfyUI. It was gated to the pod while the local
  // runner still resolved every graph from `localGraphs.ts` by model_id — a
  // picker whose value the render silently dropped.
  const wfPickable = WF_KINDS.includes(kind);
  // Switching to images (or losing the row) must not leave a stale id in the
  // payload — same reasoning as `validLoras` pruning a pick the new model does
  // not declare.
  useEffect(() => {
    if (customWfId && (!wfPickable || !customWf)) setCustomWfId(null);
  }, [wfPickable, customWfId, customWf]);

  /** Refs queued from the Cast & references side panel (see `shelfRef` in the
   *  workspace store): attach them once the catalog/library are loaded.
   *  One-shot, like genPreset — cleared on consume, and any work-in-progress
   *  in the dock is never overwritten by a queued face. */
  const applyShelf = async (ids: string[]) => {
    try {
      const rows = await loadAssetsByIds(ids);
      let attached = 0;
      for (const id of ids) {
        const a = rows.get(id);
        if (!a) continue;
        if (needs === "start" && !startAsset) { setStartAsset(a); attached++; continue; }
        if (needs === "start+end" && !startAsset) { setStartAsset(a); attached++; continue; }
        if (needs === "start+end" && !endAsset) { setEndAsset(a); attached++; continue; }
        if (refs.some((r) => r.id === a.id)) continue;
        if (cap && refs.length + attached >= cap) continue;
        setRefs((r) => [...r, a]); attached++;
      }
      const skipped = ids.length - attached;
      say(skipped
        ? `${attached} of ${ids.length} queued reference${ids.length === 1 ? "" : "s"} attached — the rest were already there, missing, or past ${model?.display_name ?? "the model"}'s ${cap || 9}-ref ceiling.`
        : `${attached} reference${attached === 1 ? "" : "s"} from the refs panel attached.`, skipped > 0);
    } catch (e) {
      say(`Refs panel: ${String((e as Error).message).slice(0, 90)}`);
    }
  };
  useEffect(() => {
    const ids = ws.refShelf;
    if (!ids.length) return;
    if (!data) {
      // catalog not loaded yet — hold the ids so they aren't lost, re-run on `data`.
      pendingShelf.current = ids;
      ws.clearShelf();
      return;
    }
    ws.clearShelf();
    void applyShelf(ids);
  }, [ws.refShelf, data]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pendingShelf.current) return;
    const ids = pendingShelf.current;
    pendingShelf.current = null;
    void applyShelf(ids);
  }, [data]);   // eslint-disable-line react-hooks/exhaustive-deps

  // "Reuse" on a library card: the whole recipe behind a generated asset,
  // loaded back into these controls so the next one is a variation rather than
  // a re-type. Applied once and consumed — see `reuseGeneration` in the store.
  useEffect(() => {
    const p = preset;
    if (!p || !data) return;
    ws.clearGenPreset();
    // The catalog id first, then the model_map key the payload carried (older
    // jobs and worker-side picks only have that one).
    const fromCatalog = data.catalog.filter((c) => c.kind === p.kind);
    const m = fromCatalog.find((c) => c.id === p.modelId)
      ?? (p.modelKey ? fromCatalog.find((c) => modelKeyOf(c.id) === p.modelKey) : undefined)
      ?? null;
    // Whatever the recipe sets is not the defaults' business any more.
    seeded.current[p.kind] = true;
    setKind(p.kind);
    if (m) setModelId(m.id);
    const avail = ((m ?? model)?.modes ?? []).filter((x) => MODES[x]);
    const want = p.kind === "video"
      ? [p.mode, p.start ? "i2v" : null, p.refs.length ? "r2v" : null, "t2v"]
      : [p.refs.length ? "r2i" : null, p.refs.length ? "edit" : null, "t2i"];
    const picked = (want.filter(Boolean) as string[]).find((x) => avail.includes(x))
      ?? avail[0] ?? null;
    setMode(picked);

    const split = splitStyle(p.prompt, styleText.text);
    setPrompt(split.text);
    setUseStyle(split.hadStyle);
    // A job that took the model's default carries no `negative`, so clearing
    // is right: the box says "default" again and that is what it rendered on.
    setNegative(takesNegative(m ?? model) ? p.negative ?? "" : "");
    setPreEnhance(null);
    setSeed(p.seed);
    // Back to the frame count, not the millisecond. A stored duration is
    // `framesToMs` of a padded count and carries its rounding, so feeding it
    // back through `msToFramesCeil` tips one frame over and pad17 answers with
    // a whole 17-frame block more (5.17s in, 5.88s out). Rounding to the
    // nearest frame reconstructs exactly what was rendered.
    if (p.kind === "video" && p.durationMs)
      setDurSec(pad17(Math.round((p.durationMs * FPS) / 1000)) / FPS);
    // A LoRA the target model doesn't declare is dropped here for the same
    // reason the worker drops it: the adapter isn't installed for this model.
    const stack = validLoras(m, p.loras);
    setLoras(stack);
    const fit = p.width && p.height ? fitSize(m, p.width, p.height) : null;
    if (fit) { setAspectId(fit.aspectId); setResId(fit.resId); }
    const cap2 = refCap(m) || 9;
    setRefs(p.refs.slice(0, cap2));
    setStartAsset(p.start);
    setEndAsset(p.end);

    // Say what did NOT come across. A recipe that quietly drops the model it
    // was rendered with, or two of its three references, is a recipe for a
    // different picture — and the whole point of reuse is that it isn't one.
    const lost: string[] = [];
    if (!m) lost.push(`${p.modelId ?? p.modelKey ?? "its model"} isn't in the catalog — using ${model?.display_name ?? "the current model"}`);
    if (p.lostRefs) lost.push(`${p.lostRefs} reference${p.lostRefs === 1 ? " has" : "s have"} been deleted`);
    if (p.refs.length > cap2) lost.push(`kept ${cap2} of ${p.refs.length} references`);
    if (fit && p.width && p.height && (fit.w !== p.width || fit.h !== p.height))
      lost.push(`${p.width}×${p.height} isn't on this model's ladder — nearest is ${fit.w}×${fit.h}`);
    const dropped = p.loras.filter((l) => !stack.some((s) => s.key === l.key));
    if (dropped.length)
      lost.push(`${m?.display_name ?? "this model"} doesn't have ${dropped.map((l) => l.key).join(", ")}`);
    const kept = [
      `seed ${p.seed ?? "random"}`,
      Math.min(p.refs.length, cap2) ? `${Math.min(p.refs.length, cap2)} ref${p.refs.length === 1 ? "" : "s"}` : null,
      stack.length ? stack.map((l) => l.key).join(" + ") : null,
    ].filter(Boolean).join(" · ");
    say(lost.length
      ? `Reused ${p.label} (${kept}) — ${lost.join("; ")}.`
      : `Reused ${p.label} — ${kept}. Change anything and generate.`, lost.length > 0);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [preset, data]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!model) return;
    const avail = (model.modes ?? []).filter((m) => MODES[m]);
    if (!avail.length) { setMode(null); return; }
    if (!mode || !avail.includes(mode)) setMode(avail[0]);
    // Drop LoRAs the new model doesn't have. `validLoras` already runs at
    // submit so nothing invalid could ship — but the toolbar went on naming
    // the old model's LoRAs, i.e. claiming a style this generation will not
    // get. Pruned here rather than inside LoraStack because that only exists
    // while its menu is open, and the model is usually changed with it shut.
    setLoras((cur) => {
      const kept = validLoras(model, cur);
      return kept.length === cur.length ? cur : kept;
    });
    // Same reasoning as the LoRA prune: 4 steps is right for SDXL Turbo and
    // ruins Wan, and the pill survives a model switch while its meaning does
    // not. Back to the new model's own recipe.
    setSteps(null);
  }, [model?.id]);    // eslint-disable-line react-hooks/exhaustive-deps

  // The prompt box grows with what you write, the way a chat composer does,
  // and stops at a height that still leaves the library visible behind it.
  // Collapsed it keeps `TA_PEEK` — and clamping to the NATURAL height rather
  // than to a constant is what makes the flag invisible on a short prompt:
  // there is nothing to give back, so nothing moves.
  // BEFORE paint, because the fold changes the class (which draws the fade)
  // during render and the height here: run after paint and there is a frame
  // in which a full-height box wears the folded edge, and another, on the way
  // back, in which a 66px box has lost it and not yet grown.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    const natural = Math.min(TA_MAX, Math.max(TA_MIN, el.scrollHeight));
    el.style.height = `${collapsed ? Math.min(natural, TA_PEEK) : natural}px`;
    // A focused box scrolls itself to the caret, so collapsing one mid-write
    // would peek at the LAST line — which reads as the prompt having been
    // truncated rather than folded.
    if (collapsed) el.scrollTop = 0;
    // Only a prompt that OUTGROWS the peek gets the folded treatment — a
    // faded, clipped edge over a two-line prompt would be claiming there is
    // more to read when there is not.
    setTall(natural > TA_PEEK);
  }, [prompt, kind, collapsed]);

  const aspect = ASPECTS.find((a) => a.id === aspectId) ?? ASPECTS[0];
  const resList = useMemo(() => resOptions(model, aspectId), [model, aspectId]);
  // The ladder changes with the model, so a pinned id can stop existing —
  // fall back to the default rather than rendering an empty pill.
  const size = resList.find((s) => s.id === resId)
    ?? resList.find((s) => s.id === "1024" || s.id === "720p")
    ?? resList[0];
  // A size can cap the pass (H3's 1080p tops out at 81 frames); the ceiling is
  // the model's, not ours, so it wins over the duration slider.
  const frameCap = Math.min(MAX_FRAMES, size?.maxFrames ?? MAX_FRAMES);
  // The frame grid is the MODEL's, not H3's. `pad17` and FPS=24 are invariant
  // #5, and they are right for every row in `model_catalog` — but a local Wan
  // is 4n+1 at 16 or 24fps, and quoting a duration off the wrong grid means
  // the dock says 5.0s while the file comes back 4.5s long. Every catalog row
  // already declares `frame_base` / `frame_rem` / `fps`; nothing read them.
  const grid = {
    base: model?.frame_base ?? 17, rem: model?.frame_rem ?? 5, fps: model?.fps ?? FPS,
  };
  const onGrid = (n: number) =>
    Math.max(grid.base + grid.rem, Math.round((n - grid.rem) / grid.base) * grid.base + grid.rem);
  const frames = model && model.frame_base && model.frame_base !== 17
    ? Math.min(frameCap, onGrid(Math.round(durSec * grid.fps)))
    : pad17(Math.max(MIN_FRAMES, Math.min(frameCap, msToFramesCeil(durSec * 1000))));
  const realMs = model && model.frame_base && model.frame_base !== 17
    ? Math.round((frames / grid.fps) * 1000)
    : framesToMs(frames);

  useEffect(() => {
    if (kind !== "video" || !model || model.provider !== "local") { setEta(null); return; }
    loadTimings().then((ts) => {
      const s = estimateSeconds(ts, {
        modelId: model.id, width: size.w, height: size.h, frames, steps: 20,
      });
      setEta(s ? fmtEta(s) : null);
    }).catch(() => setEta(null));
  }, [kind, model?.id, size.w, size.h, frames]);  // eslint-disable-line react-hooks/exhaustive-deps

  // A vendor API, whoever pays for it. `byok` is what says whose key.
  const hosted = tier === "byok" || (tier === "cloud" && model?.provider !== "local");
  // NO COST ESTIMATE. It was a guess at a dollar figure derived by parsing
  // the ETA string — and the ETA is the part that answers the question anyone
  // actually has at this button ("how long?"), so that is what stayed.
  // `cost_usd` is still booked per job for the admin ledger; it is simply not
  // something the app prices back at the user before every render.

  const say = (msg: string, bad = true) => { setNote(msg); setWarn(bad); };

  // Which stored guide a rewrite would follow. Selected by the model's catalog
  // FAMILY, so every MiniMax H3 row — local, hosted API, fal — gets the H3
  // guide, and `exact:false` means we'd be applying general craft instead of a
  // guide this model actually ships.
  const guide = useMemo(
    () => enhanceGuide({ family: model?.family, kind, mode }),
    [model?.family, kind, mode]);
  // Same routing rule as the director dock — the picker's own choice, and the
  // local backend is queued by the browser rather than run through an adapter
  // (it spends no provider money).
  const llmBackend = data?.settings.director_backend || "auto";

  /** One-click rewrite of the prompt against the selected model's guide. */
  const enhance = async () => {
    const text = prompt.trim();
    if (!text || enhancing) return;
    setEnhancing(true);
    setNote(null);
    const eff = resolveDefaults(data?.settings);
    const body = {
      prompt: text, kind,
      family: model?.family ?? null, mode,
      mode_label: mode ? MODES[mode].label : null,
      model_label: model?.display_name ?? null,
      // Never on music: `go()` does not prepend the style guide there either
      // (a look guide inside a genre brief is noise), and telling the rewriter
      // to "stay inside" a look the render will never see makes the caption
      // worse for nothing.
      style: useStyle && !isMusic ? (styleText.text || null) : null,
      refs: isMusic ? 0 : refs.length, has_start: !isMusic && !!startAsset,
      // H3's keyframe modes open on a fixed instruction line carrying the real
      // render duration to two decimals. That is arithmetic, not writing, so
      // it is computed here and handed over verbatim.
      duration_ms: kind === "video" ? realMs : undefined,
      alignment: kind === "video" ? enhanceAlignment(mode, realMs) : undefined,
      project_id: projectId, backend: llmBackend,
    };
    try {
      // No key prompt: the rewrite runs on this machine, and a machine that
      // cannot answer says so in the message the outer catch reports. There is
      // nothing a text box here could supply.
      const res = await enhancePrompt(body);
      setPreEnhance(text);
      setPrompt(res.prompt);
      const how = res.guide.exact
        ? `Rewritten with the ${res.guide.label} prompt guide`
        : `${model?.display_name ?? "This model"} has no stored guide — rewritten with general ${kind} craft`;
      // A rewrite that arrived on the second choice is still a rewrite, but the
      // failure is not swallowed: say who fell over and who picked it up.
      const hops = res.fell_back ?? [];
      if (hops.length) {
        say(`${backendLabel(hops[0].from)} ${hops[0].reason} — ${backendLabel(res.backend)} wrote this instead. ${how}.`);
        return;
      }
      say(`${how}.`, false);
    } catch (e) {
      say(`Could not enhance: ${describeDirectorError(String((e as Error).message || e))}`);
    } finally {
      setEnhancing(false);
    }
  };

  const onUpload = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || f.type.startsWith("audio/"));
    if (!list.length) return;
    for (const file of list) {
      setUploading(0);
      try {
        const k = file.type.startsWith("video") ? "video" : file.type.startsWith("audio") ? "audio" : "image";
        const key = `library/${Date.now()}_${file.name.replace(/[^\w.-]+/g, "_")}`;
        await uploadMedia(file, key, (p: number) => setUploading(p));
        const asset = await registerAsset({
          b2_key: key, kind: k as Asset["kind"],
          project_id: projectId, content_type: file.type, bytes: file.size,
          origin: "uploaded", tags: ["library"], meta: { original_name: file.name },
          ...(await probedUploadMeta(file)),   // don't wait on the pod for a length
        });
        await enqueueJob({ kind: "asset_ingest", lane: "cpu", priority: 60, payload: { asset_id: asset.id } });
        attach(asset);
        reloadData();
        invalidateTables(["assets"]);
      } catch (e) {
        say(`Upload failed: ${String((e as Error).message).slice(0, 100)}`);
      } finally { setUploading(null); if (fileRef.current) fileRef.current.value = ""; }
    }
  };

  /** Where a picked or pasted image goes depends on what the mode is waiting for. */
  const attach = (a: Asset) => {
    if (needs === "start" || (needs === "start+end" && !startAsset)) { setStartAsset(a); return; }
    if (needs === "start+end" && !endAsset) { setEndAsset(a); return; }
    // Auto-switch mode when attaching a reference or frame from a text-only mode
    if (kind === "video" && mode === "t2v" && modes.includes("i2v")) {
      setStartAsset(a);
      setMode("i2v");
      return;
    }
    if (kind === "image" && mode === "t2i" && modes.includes("r2i")) {
      setMode("r2i");
    } else if (kind === "image" && mode === "t2i" && modes.includes("edit")) {
      setMode("edit");
    }
    if (refs.some((r) => r.id === a.id)) return;
    if (cap && refs.length >= cap) {
      say(`${model?.display_name} takes ${cap} reference${cap === 1 ? "" : "s"}.`); return;
    }
    setRefs((r) => [...r, a]);
  };

  const pasteFromClipboard = async () => {
    setPastingMedia(true);
    try {
      const files = await readClipboardMedia();
      if (!files.length) {
        say("Nothing to paste — the clipboard holds no image, video or audio.");
        return;
      }
      await onUpload(files);
      say(`Pasted ${files.length} file${files.length === 1 ? "" : "s"} — uploaded to library and attached.`, false);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setPastingMedia(false);
    }
  };

  /** Drag a card out of the grid and onto the dock to use it as a reference. */
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) { void onUpload(e.dataTransfer.files); return; }
    const raw = e.dataTransfer.getData("application/x-qamba-asset");
    if (!raw) return;
    // The grid hands over a bare id; other surfaces hand over {id}.
    let id = raw;
    try { id = (JSON.parse(raw) as { id: string }).id ?? raw; } catch { /* bare id */ }
    const known = [...(data?.library ?? []), ...(data?.bibleAssets ?? [])].find((a) => a.id === id);
    if (known) { attach(known); return; }
    const { data: row } = await supabase.from("assets").select("*").eq("id", id).maybeSingle();
    if (row) attach(row as Asset);
  };

  /** `@` drops a bible name into the prompt at the caret. */
  const mention = (name: string) => {
    const el = taRef.current;
    const at = el?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, at).replace(/\s+$/, "");
    const after = prompt.slice(at);
    const next = `${before}${before ? " " : ""}${name}${after.startsWith(" ") ? "" : " "}${after}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = before.length + (before ? 1 : 0) + name.length + 1;
      el?.setSelectionRange(caret, caret);
    });
  };

  /* ── what this dock has in flight ───────────────────────────────────────
     Polled as well as subscribed while anything is live, for the same reason
     the library grid is: this is the "your render is happening" readout, and
     it must not depend on the socket having survived. Idle costs nothing. */
  const { cancel, cancelling } = useJobCancel();
  const { data: sentJobs } = useLiveQuery(
    () => loadJobsByIds(sent), ["jobs"], [sent.join(",")], 300, sent.length ? 2500 : 0);
  /** in `sent` order (newest first), and only the rows that came back */
  const inFlight = useMemo(() => {
    const by = new Map((sentJobs ?? []).map((j) => [j.id, j]));
    return sent.map((id) => by.get(id)).filter(Boolean) as JobProgress[];
  }, [sent, sentJobs]);
  // A finished generation says so and then gets out of the way — its real card
  // is in the grid above by then. A failed or canceled one STAYS until it is
  // dismissed: a row that vanishes on its own is indistinguishable from the
  // render that never started, which is the whole complaint this strip answers.
  // Keyed on the settled ids rather than on `sentJobs`, whose identity changes
  // on every poll — restarting a 6s timer every 2.5s means it never fires.
  const settledKey = (sentJobs ?? [])
    .filter((j) => j.status === "done").map((j) => j.id).sort().join(",");
  useEffect(() => {
    if (!settledKey) return;
    const gone = new Set(settledKey.split(","));
    const t = setTimeout(() => setSent((s) => s.filter((id) => !gone.has(id))), 6000);
    return () => clearTimeout(t);
  }, [settledKey]);

  const missing = (): string => {
    if (!prompt.trim()) return isMusic
      ? "Describe the track first — genre, tempo, instruments, mood."
      : "Write a prompt first.";
    if (!model) return "Pick a model.";
    if (!mode) return `${model.display_name} lists no input type this form can drive.`;
    // Music takes no references or frames, so the shelf checks below never
    // apply — and `hosted` is meaningless for it too (every music row is local).
    if (isMusic) return "";
    if (needs === "start" && !startAsset) return `${mode} opens on an image — pick a start frame.`;
    if (needs === "start+end" && (!startAsset || !endAsset))
      return "First-last needs both a start and an end frame.";
    if (needs === "refs" && !refs.length) return `${mode} works from references — add at least one.`;
    // Two different "not now"s, and conflating them is what makes a downloaded
    // model look broken: the engine can be installed and simply not started.
    if (local && !engine.running) {
      // A LINKED ComfyUI is theirs to start — offering our Start button for a
      // process we do not own is the EngineProc rule read backwards.
      return engine.status?.models_linked
        ? "Your ComfyUI isn't listening on :8188 — start it, then try again."
        : "Your local engine isn't running — start it from the engine window.";
    }
    // A hosted row is runnable when YOUR key makes it so. Without one there
    // is nothing on this machine that could call it, so the refusal stays —
    // and it names the fix.
    if (hosted && !byok) {
      return isDesktop()
        ? `${model.display_name} runs on ${model.provider}'s API — add your ${model.provider} key `
          + `in the local engine window, under API keys.`
        : `${model.display_name} runs on ${model.provider}'s API, and a key for it lives in the `
          + `desktop app's keychain. Open this project there, or pick a local model.`;
    }
    // The key is on THIS machine, so the render is driven from here.
    if (byok && !isDesktop()) return `${model.display_name} needs the desktop app — your key lives there.`;
    return "";
  };

  const go = async () => {
    const why = missing();
    if (why) { say(why); return; }
    setBusy(true); setNote(null);
    try {
      const eff = resolveDefaults(data?.settings);
      // The project style guide is about how the picture LOOKS — cel shading,
      // lens character, film stock. Prepending it to a music caption is not a
      // style instruction, it is noise inside the one field the planner reads
      // to choose a genre, so music never takes it whatever the toggle says.
      const text = useStyle && !isMusic
        ? withStyle(styleText.text || undefined, prompt.trim())
        : prompt.trim();
      const s = seed ?? Math.floor(Math.random() * 1e9);
      // Video stacks adapters now too — H3 declares its concept LoRAs in
      // model_map's style_loras, exactly like the image models do, so this is
      // no longer an image-only control.
      const stack = validLoras(model, loras);
      // What every queue surface will call this row (jobLabel), and what the
      // strip below the composer shows: the prompt you typed, not the styled
      // one that goes to the pod, and not the bare kind — a queue row that says
      // only "clip_gen" is the regression the label convention exists to stop.
      const label = `${model!.display_name} · ${prompt.trim().replace(/\s+/g, " ").slice(0, 48)}`;
      let job: Job;
      if (byok) {
        // ON THE LOCAL LANE, because the KEY is local — not because the GPU
        // is. `lane: "local"` is the queue only this machine claims, so the
        // pod never sees a job it has no credential for. `byok_gen` is its own
        // kind because `localWorker` has to branch on it: there is no ComfyUI
        // in this path, so no graph, no `comfy_prompt_id` and nothing to
        // reattach to.
        job = await enqueueJob({
          kind: "byok_gen", lane: "local", priority: 10,
          project_id: projectId ?? undefined, model_id: model!.id,
          payload: {
            prompt: text, mode, label,
            width: size.w, height: size.h, seed: s,
            // A user-added fal endpoint lives in this machine's localStorage,
            // and the worker may run this job for a project the user is not
            // looking at — so the definition TRAVELS with the job rather than
            // being looked up when it runs, by which time the list could have
            // changed underneath it.
            ...(byokModel ? { byok_model: byokModel } : {}),
            ...(kind === "video" ? { seconds: Math.round(realMs / 1000) } : {}),
            ...(qTiers.length ? { quality } : {}),
            ...(negOk && negative.trim() ? { negative: negative.trim() } : {}),
            // THE OPENING FRAME IS ITS OWN FIELD, as it is on the other two
            // planes. This branch used to flatten it into `ref_asset_ids` —
            // which was harmless while every fal body wrote each url into
            // three plausible fields at once, and is not now that a video
            // model's body is built from its endpoint's own dialect: a start
            // frame in the reference list lands in `image_urls`, which the
            // image-to-video endpoint does not declare, so fal drops it and
            // the extend opens on nothing. `endAsset` rides along for the
            // models whose i2v endpoint takes a closing frame (Seedance 2.5
            // does; H3 on fal does not).
            ...(startAsset ? { start_asset_id: startAsset.id } : {}),
            ...(endAsset ? { end_asset_id: endAsset.id } : {}),
            ...(refs.length ? { ref_asset_ids: refs.map((r) => r.id) } : {}),
            project_id: projectId,
          },
        });
      } else if (local) {
        // ONE row shape for both media, because the local runner branches on
        // the recipe rather than on the job kind — and `lane: "local"` is what
        // keeps the pod's claim query from ever seeing it. No `model_key`:
        // that is a `model_map` key on a box this render never touches.
        job = await enqueueJob({
          // The KIND still travels even though the local runner branches on
          // the recipe: it is what every queue surface, the library's
          // placeholder card and `jobLabel` read, so a song queued as
          // `clip_gen` would render correctly and be described as a video
          // everywhere it appeared.
          kind: kind === "image" ? "image_gen"
            : kind === "music" ? "music_gen" : "clip_gen",
          lane: "local", priority: 10,
          project_id: projectId ?? undefined, model_id: model!.id,
          payload: {
            prompt: text, mode, label,
            width: size.w, height: size.h, seed: s,
            ...(kind === "video" ? { duration_ms: realMs } : {}),
            // A song's length is its own control, and the words are not the
            // prompt: the caption describes the track, `lyrics` is what gets
            // sung. An empty `lyrics` is an ABSENCE rather than an
            // instruction, which is why "instrumental" has to be said in the
            // caption — the same rule the pod's handler follows.
            ...(kind === "music" ? {
              duration_ms: Math.round(songLen * 1000),
              instrumental,
              ...(instrumental ? {} : { lyrics: lyrics.trim() }),
            } : {}),
            // The local runner reads this exactly as the pod's handlers do —
            // `localRender.graphForJob` applies the tagged slots instead of
            // building a catalogue recipe.
            ...(customWfId ? { workflow_id: customWfId } : {}),
            ...(steps != null ? { steps } : {}),
            ...(stack.length ? { loras: stack } : {}),
            ...(negOk && negative.trim() ? { negative: negative.trim() } : {}),
            ...(startAsset ? { start_asset_id: startAsset.id } : {}),
            // References travel on the local plane too now. Without this the
            // only local family that can compose from pictures would render a
            // text-to-image and hand back something that merely resembled the
            // request — which is the inference `mode` exists to prevent.
            ...(refs.length ? { ref_asset_ids: refs.map((r) => r.id) } : {}),
            project_id: projectId,
          },
        });
      } else if (kind === "image") {
        job = await enqueueJob({
          kind: "image_gen", lane: "gpu", priority: 10,
          project_id: projectId ?? undefined, model_id: model!.id,
          payload: {
            // The mode travels for images too. Without it the worker can only
            // see "this job has references", which reads as r2i — so "image
            // edit" composed a brand-new frame from an empty latent and handed
            // back a different picture that merely resembled the source.
            prompt: text, mode, model_key: modelKeyOf(model!.id), label,
            width: size.w, height: size.h, seed: s,
            ...(customWfId ? { workflow_id: customWfId } : {}),
            ...(stack.length ? { loras: stack } : {}),
            // Gated on the model, not just on the text: the field is hidden
            // when the model can't sample a negative branch, but the state
            // survives a model switch, and a payload key the render provably
            // ignores is the silent no-op this codebase keeps getting bitten
            // by. Empty means "use model_map's own default", which is a
            // different thing from an empty negative — so don't send "".
            ...(negOk && negative.trim() ? { negative: negative.trim() } : {}),
            ...(qTiers.length ? { quality } : {}),
            ref_asset_ids: refs.map((r) => r.id),
            // no target: it lands in the library, unattached
          },
        });
      } else if (kind === "music") {
        job = await enqueueJob({
          kind: "music_gen", lane: "gpu", priority: 10,
          project_id: projectId ?? undefined, model_id: model!.id,
          payload: {
            prompt: text, model_key: modelKeyOf(model!.id), label,
            // Milliseconds on the wire (invariant #3); the worker converts to
            // the seconds the ComfyUI nodes take.
            duration_ms: Math.round(songLen * 1000), seed: s,
            project_id: projectId,
            instrumental,
            ...(instrumental ? {} : { lyrics: lyrics.trim() }),
            // Only where the model actually has these inputs — sending BPM to
            // Music 3 would be a payload key nothing reads.
            ...(musicalMeta
              ? { bpm, key_scale: keyScale, time_signature: timeSig }
              : {}),
          },
        });
      } else {
        job = await enqueueJob({
          kind: "clip_gen", lane: "gpu", priority: 10,
          project_id: projectId ?? undefined, model_id: model!.id,
          payload: {
            prompt: text, mode, model_key: modelKeyOf(model!.id), label,
            width: size.w, height: size.h, seed: s,
            duration_ms: realMs, project_id: projectId,
            ...(customWfId ? { workflow_id: customWfId } : {}),
            ...(stack.length ? { loras: stack } : {}),
            // Gated on the MODEL, not just on the switch: the toggle is hidden
            // where the model declares no recipe, but the state survives a
            // model switch and `resolve()` RAISES on a model that cannot
            // refine — so sending it anyway would fail the job rather than
            // quietly ignore it.
            ...(refineOk && refine ? { refine: true } : {}),
            ref_asset_ids: refs.map((r) => r.id),
            ...(startAsset ? { start_asset_id: startAsset.id } : {}),
            ...(endAsset ? { end_asset_id: endAsset.id } : {}),
          },
        });
      }
      // Three rows: the strip grows the dock, and the dock takes its height off
      // the grid above it. Past that the queue popover is the backlog surface.
      setSent((s) => [job.id, ...s.filter((id) => id !== job.id)].slice(0, 3));
      // The row exists — say so on this tick rather than waiting for the socket
      // to echo it back, so the placeholder card in the grid above appears
      // while the click still feels connected to it.
      invalidateTables(["jobs"]);
      say(local
        ? `Rendering on this machine${engine.device ? ` · ${engine.device}` : ""} — progress below. `
          + "Your prompt stays for a re-run."
        : "Queued — rendering below. Your prompt stays for a re-run.",
        false);
      // The PROMPT stays: the recipe is the expensive part and the second take
      // is usually the first one with one word changed. The seed does not — a
      // pinned seed re-run at the same settings renders the identical picture,
      // so keeping it would make the obvious "press Generate again" a silent
      // duplicate. Pick one again from the seed control to hold it.
      setSeed(null);
    } catch (e) {
      say(`Could not queue: ${String((e as Error).message).slice(0, 120)}`);
    } finally { setBusy(false); }
  };

  const Thumb = ({ a, drop, label, lead }: {
    a: Asset; drop: () => void; label: string; lead?: boolean;
  }) => {
    const isVid = isVideoAsset(a);
    return (
      <div
        className={"gd-thumb" + (lead ? " lead" : "") + (isVid ? " is-video" : "")}
        title={label}
        onPointerEnter={(e) => {
          if (isVid) openHover({ id: a.id, asset: a, label: label ? label.toUpperCase() : "REF" }, e.currentTarget);
        }}
        onPointerLeave={() => {
          if (isVid) closeHover();
        }}
      >
        {isVid ? (
          <>
            <video
              src={assetUrl(a) ?? undefined}
              muted
              preload="metadata"
              playsInline
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.duration) v.currentTime = v.duration * 0.35;
              }}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            <div className="gd-thumb-play">
              <span className="gd-play-icon">
                <Play size={10} fill="currentColor" style={{ marginLeft: 1 }} />
              </span>
            </div>
          </>
        ) : (
          <img src={assetUrl(a) ?? undefined} alt="" loading="lazy" />
        )}
        <span className="tag">{label}</span>
        <button
          className="x"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            if (isVid) closeHover();
            drop();
          }}
        >
          <X size={10} />
        </button>
      </div>
    );
  };

  const shelf = !!(startAsset || endAsset || refs.length) || needs !== "";
  const attached = (startAsset ? 1 : 0) + (endAsset ? 1 : 0) + refs.length;
  const modeLabel = mode ? MODES[mode].short : "—";

  return (
    <div className="ws-gendock">
     <div className="gd-row">
      {/* what you are making — the rail reads top-to-bottom like the reference */}
      <div className="gd-kind ns-l1">
        {(["image", "video", "music"] as const).map((k) => (
          <button key={k} className={kind === k ? "on" : ""}
                  title={`Generate ${k === "image" ? "an image" : k === "video" ? "a clip" : "a track"}`}
                  onClick={() => { setKind(k); setNote(null); }}>
            {k === "image" ? <ImageIcon size={16} /> : k === "video" ? <Video size={16} /> : <Music size={16} />}
            <span>{k}</span>
          </button>
        ))}
      </div>

      <div className="gd-mid">
        <div className={"gd-slab ns-l2" + (dragOver ? " over" : "")}
             onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
             onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
             onDrop={(e) => void onDrop(e)}>

          {/* references / frames the chosen mode is waiting for */}
          {shelf && !isMusic && (
            <div className="gd-shelf ns-scroll">
              {startAsset && <Thumb a={startAsset} lead label="start" drop={() => setStartAsset(null)} />}
              {endAsset && <Thumb a={endAsset} label="end" drop={() => setEndAsset(null)} />}
              {refs.map((r) => (
                <Thumb key={r.id} a={r} label="ref"
                       drop={() => setRefs((x) => x.filter((y) => y.id !== r.id))} />
              ))}
              {needs !== "" && (
                <>
                  <button className="gd-add" title="Browse the bible and library"
                          onClick={() => setPicking(true)}>
                    <Plus size={14} /><span>add</span>
                  </button>
                  <button className="gd-add" title="Upload an image"
                          onClick={() => fileRef.current?.click()}>
                    {uploading != null
                      ? <span className="mono">{Math.round(uploading * 100)}%</span>
                      : <><Upload size={13} /><span>upload</span></>}
                  </button>
                  <button className="gd-add" title={`Paste image from clipboard (${chord})`}
                          disabled={pastingMedia}
                          onClick={() => void pasteFromClipboard()}>
                    {pastingMedia
                      ? <Loader2 size={13} className="ns-spin" />
                      : <ClipboardPaste size={13} />}
                    <span>paste</span>
                  </button>
                </>
              )}
              <span className="gd-shelfnote mono">
                {needs === "start" ? "the segment opens on this frame"
                  : needs === "start+end" ? "opening and closing frames"
                  : needs === "refs" ? `${refs.length}/${cap || 9} references`
                  : `drop library cards or paste with ${chord}`}
              </span>
            </div>
          )}

          <textarea ref={taRef}
                    className={"gd-text ns-scroll" + (collapsed && tall ? " folded" : "")}
                    rows={1} value={prompt}
                    placeholder={kind === "image"
                      ? `Describe the image — subject, framing, light, materials. (paste image with ${chord} for ref)`
                      : kind === "video"
                        ? `Describe the shot — action, camera move, light. (paste media with ${chord} for ref)`
                        : caps.promptStyle === "tags"
                          ? "Tags — genre, instruments, mood, production. Comma separated: dream pop, reverbed guitar, brushed drums, wistful, analog tape."
                          : "Describe the record — genre and tempo, then the voice, then the arrangement. Lyrics go in their own field."}
                    onChange={(e) => { setPrompt(e.target.value); if (note) setNote(null); onExpand?.(); }}
                    onFocus={() => onExpand?.()}
                    /* `focus` alone is not enough: collapsing does not blur, so
                       clicking a box that is ALREADY focused — the obvious way
                       to ask for it back — would fire nothing. */
                    onPointerDown={() => onExpand?.()}
                    onPaste={(e) => {
                      const files = clipboardMediaFiles(e.clipboardData);
                      if (!files.length) return;
                      e.preventDefault();
                      void onUpload(files);
                      say(`Pasted ${files.length} file${files.length === 1 ? "" : "s"} — uploaded to library and added as reference.`, false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        void go();
                      } else if (e.key?.toLowerCase() === "v" && e.ctrlKey && !e.metaKey && !e.altKey) {
                        // `typeof … === "function"`, not a truthiness check:
                        // lib.dom types `Clipboard.read` as always present, so
                        // TS rejects the latter as a condition that cannot be
                        // false (TS2774) — while at runtime the whole
                        // `clipboard` object is absent outside a secure
                        // context. Same feature-detect, and it compiles.
                        if (typeof navigator !== "undefined"
                            && typeof navigator.clipboard?.read === "function") {
                          void readClipboardMedia().then((files) => {
                            if (files.length) {
                              e.preventDefault();
                              void onUpload(files);
                              say(`Pasted ${files.length} file${files.length === 1 ? "" : "s"} — uploaded to library and added as reference.`, false);
                            }
                          }).catch(() => {});
                        }
                      }
                    }} />

          <div className="gd-bar">
            {!isMusic && (
              <>
                <button className="gd-round" title={`Add a reference image (or paste with ${chord})`}
                        onClick={() => setPicking(true)}><Plus size={15} /></button>
                <button className="gd-round" title={`Paste image from clipboard as reference (${chord})`}
                        disabled={pastingMedia}
                        onClick={() => void pasteFromClipboard()}>
                  {pastingMedia ? <Loader2 size={14} className="ns-spin" /> : <ClipboardPaste size={14} />}
                </button>
              </>
            )}

            <Dropdown width={250}
              trigger={({ toggle }) => (
                <button className="gd-round" title="Mention someone from the bible" onClick={toggle}>
                  <AtSign size={14} />
                </button>
              )}>
              {(close) => (
                <>
                  <div className="ws-menu-label">from the bible</div>
                  {(data?.bible ?? []).slice(0, 24).map((e) => (
                    <button key={e.id} className="ws-menu-row"
                            onClick={() => { close(); mention(e.name); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5 }}>{e.name}</span>
                        <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678" }}>
                          {e.kind}
                        </span>
                      </span>
                    </button>
                  ))}
                  {!(data?.bible ?? []).length && (
                    <div className="ws-menu-empty">No bible entries yet.</div>
                  )}
                </>
              )}
            </Dropdown>

            {/* one-click rewrite against the model's stored prompt guide */}
            <button className="gd-round wand" disabled={!prompt.trim() || enhancing}
                    onClick={() => void enhance()}
                    title={guide.exact
                      ? `Rewrite this prompt with the ${guide.label} prompt guide`
                      : `${model?.display_name ?? "This model"} has no stored prompt guide — `
                        + `rewrites with general ${kind} craft`}>
              {enhancing ? <Loader2 size={14} className="ns-spin" /> : <Wand2 size={14} />}
            </button>
            {preEnhance != null && prompt !== preEnhance && !enhancing && (
              <button className="gd-round" title="Put the prompt back the way it was"
                      onClick={() => { setPrompt(preEnhance); setPreEnhance(null); setNote(null); }}>
                <Undo2 size={14} />
              </button>
            )}

            <span className="gd-sep" />

            {/* model — grouped by WHERE IT RUNS, which is the first thing you
                need to know about a model and the one thing the flat list
                could not say. The trigger carries the tier chip too: with the
                menu shut, "Wan 2.2 · Q6_K" and a pod model look identical. */}
            <Ctl icon={<TierIcon tier={tier} />} width={330}
                 value={model?.display_name ?? "Pick a model"}
                 title={model ? `${model.display_name} — runs on ${TIER_META[tier!].where}` : "Model"}>
              {(close) => (
                <>
                  <TieredModelMenu models={models} value={modelId} close={close}
                                   onPick={setModelId} quality={quality}
                                   onQuality={setQuality}
                                   /* A DESKTOP row's own caveat, where a
                                      caveat can be read. `capabilities.note`
                                      was written by the catalog sync and
                                      rendered by nothing, so Krea 2's "this
                                      does text-to-image only, references need
                                      a node the local installer does not add"
                                      would have been writing nobody reads —
                                      the bug `bibleSheet` already names once.
                                      Scoped to local rows because the cloud
                                      notes run to a paragraph and widening
                                      this list is a different decision. */
                                   noteFor={(m) => (tierOf(m) === "local"
                                     ? (m.capabilities?.note as string | undefined)
                                     // A hosted row is otherwise
                                     // indistinguishable from one the studio
                                     // pays for, and the difference is whose
                                     // card it bills. Said on the ROW rather
                                     // than only on the tier header, because
                                     // the header is shared with hosted rows
                                     // that have no key.
                                     : isByokRow(m) ? "your key"
                                     : null)} />
                  {/* Downloaded and undriveable is a THIRD state, and silence
                      about it reads as a failed download. */}
                  {engine.blocked.map((b) => (
                    <div key={b.name} className="ws-menu-empty" style={{ fontSize: 10.5 }}>
                      {b.name} is on disk but {b.why}.
                    </div>
                  ))}
                  {engine.desktop && !engine.rows.length && (
                    <div className="ws-menu-empty" style={{ fontSize: 10.5 }}>
                      {engine.status?.installed || engine.status?.models_linked
                        ? "No local models yet — download one in the engine window."
                        : "No local engine installed yet."}
                    </div>
                  )}
                </>
              )}
            </Ctl>

            {/* An imported graph REPLACES the model, it does not modify it: a
                custom workflow names its own checkpoint, so leaving the model
                picker meaningful beside it would imply a substitution that
                never happens. Images and video both: handle_clip_gen and
                handle_image_gen each branch on payload.workflow_id, and
                resolve_custom is kind-agnostic (its output list takes an image
                saver as readily as a video one). The other kinds are excluded
                because no handler reads the field there — a picker whose value
                the render provably ignores is the silent no-op this file's
                negative-prompt and LoRA gating already exist to prevent. */}
            {wfPickable && (workflows ?? []).length > 0 && (
              <Ctl icon={<Workflow size={12} />} width={320}
                   value={customWf ? customWf.name : "Model default"} title="Workflow">
                {(close) => (
                  <>
                    <div className="ws-menu-label">render with</div>
                    <button className={"ws-menu-row" + (!customWfId ? " on" : "")}
                            onClick={() => { close(); setCustomWfId(null); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5 }}>Model default</span>
                        <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678" }}>
                          the bundled template for this model
                        </span>
                      </span>
                      {!customWfId && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                    </button>
                    <div className="ws-menu-sep" />
                    {(workflows ?? []).map((w) => {
                      // A graph with no prompt slot would render its author's
                      // prompt whatever you typed — the worker refuses it, so
                      // the picker refuses it first.
                      const ok = !!w.slots?.prompt;
                      return (
                        <button key={w.id} className={"ws-menu-row" + (w.id === customWfId ? " on" : "")}
                                disabled={!ok} style={!ok ? { opacity: 0.45 } : undefined}
                                onClick={() => { if (ok) { close(); setCustomWfId(w.id); } }}>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 12.5 }}>{w.name}</span>
                            <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678" }}>
                              {ok
                                ? `${w.status} · ${Object.keys(w.api_graph ?? {}).length} nodes`
                                : "no prompt slot tagged — tag one on its card first"}
                            </span>
                          </span>
                          {w.id === customWfId && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                        </button>
                      );
                    })}
                  </>
                )}
              </Ctl>
            )}

            {/* input type, straight off the model */}
            <Ctl icon={<Layers size={12} />} width={280} value={modeLabel} title="Input type">
              {(close) => (
                <>
                  <div className="ws-menu-label">input type</div>
                  {modes.map((m) => (
                    <button key={m} className={"ws-menu-row" + (mode === m ? " on" : "")}
                            onClick={() => { close(); setMode(m); setNote(null); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5 }}>{MODES[m].label}</span>
                        <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678" }}>
                          {m}{MODES[m].needs ? ` · needs ${MODES[m].needs}` : " · prompt only"}
                        </span>
                      </span>
                      {mode === m && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                    </button>
                  ))}
                  {!modes.length && <div className="ws-menu-empty">This model lists no input type.</div>}
                </>
              )}
            </Ctl>

            {/* aspect — a track has no frame */}
            {!isMusic && (
            <Ctl icon={<Ratio size={12} />} width={220} mono value={aspect.label} title="Aspect ratio">
              {(close) => (
                <>
                  <div className="ws-menu-label">aspect</div>
                  {ASPECTS.map((a) => {
                    const d = resOptions(model, a.id).find((s) => s.id === size?.id)
                      ?? resOptions(model, a.id)[0];
                    return (
                      <button key={a.id} className={"ws-menu-row" + (aspectId === a.id ? " on" : "")}
                              onClick={() => { close(); setAspectId(a.id); }}>
                        <span style={{ flex: 1 }}>{a.label}</span>
                        <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                          {d ? `${d.w}×${d.h}` : ""}
                        </span>
                        {aspectId === a.id && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                      </button>
                    );
                  })}
                </>
              )}
            </Ctl>
            )}

            {/* resolution — the model's own sizes when it declares any */}
            {!isMusic && (
            <Ctl icon={<Maximize2 size={12} />} width={250} mono
                 value={srcSize ?? (size ? `${size.w}×${size.h}` : "—")}
                 title={srcSize
                   ? "An edit renders at the source image's size"
                   : model?.sizes?.length
                     ? `Output size — ${model.display_name} declares these`
                     : "Output size — snapped to the model's dimension step"}>
              {(close) => (
                <>
                  <div className="ws-menu-label">
                    {srcSize
                      ? "resolution · follows the source"
                      : `resolution${model?.sizes?.length ? ` · ${model.display_name}` : ""}`}
                  </div>
                  {resList.map((s) => (
                    <button key={s.id} className={"ws-menu-row" + (size?.id === s.id ? " on" : "")}
                            onClick={() => { close(); setResId(s.id); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5 }}>{s.label}</span>
                        <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678" }}>
                          {megapixels(s)} MP
                          {s.maxFrames ? ` · max ${s.maxFrames}f` : ""}
                        </span>
                      </span>
                      {size?.id === s.id && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                    </button>
                  ))}
                </>
              )}
            </Ctl>
            )}

            {/* song length. Separate control from the clip slider above: the
                units are minutes rather than frames, there is no 17n+5 grid to
                land on, and the ceiling is the model's own `max_seconds`. */}
            {isMusic && (
              <Ctl icon={<Timer size={12} />} width={280} mono
                   value={songLen >= 60
                     ? `${Math.floor(songLen / 60)}:${String(songLen % 60).padStart(2, "0")}`
                     : `${songLen}s`}
                   title="Track length">
                {() => (
                  <>
                    <div className="ws-menu-label">length</div>
                    <div className="gd-pop">
                      <div className="gd-chips">
                        {SONG_SECONDS.filter((d) => d <= songCap).map((d) => (
                          <button key={d} className={"gd-chip" + (songLen === d ? " on" : "")}
                                  onClick={() => setSongSec(d)}>
                            {d >= 60 ? `${d / 60}m` : `${d}s`}
                          </button>
                        ))}
                      </div>
                      <input type="range" min={15} max={songCap} step={5} value={songLen}
                             onChange={(e) => setSongSec(+e.target.value)} style={{ width: "100%" }} />
                      <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                        {songLen}s · ceiling {Math.round(songCap / 60)}m on {model?.display_name ?? "this model"}
                      </span>
                      {/* Music 3's own planner decides where the song ends. The
                          number above is a maximum, and saying so here is the
                          difference between "it ignored me" and "it finished". */}
                      {caps.promptStyle === "caption" && (
                        <span className="mono" style={{ fontSize: 10.5, color: "#5e6678", lineHeight: 1.5 }}>
                          A ceiling, not a target — the model writes an ending and
                          often stops early.
                        </span>
                      )}
                    </div>
                  </>
                )}
              </Ctl>
            )}

            {/* lyrics + instrumental */}
            {isMusic && (
              <Ctl icon={<Mic2 size={12} />} width={340}
                   on={instrumental || !!lyrics.trim()}
                   value={instrumental ? "instrumental"
                     : lyrics.trim() ? `${lyrics.trim().split(/\s+/).length} words` : "no lyrics"}
                   title="Lyrics — what the voice sings">
                {() => (
                  <>
                    <div className="ws-menu-label">lyrics</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 9px 8px",
                                    fontSize: 12.5, color: "#c8cfdb", cursor: "pointer" }}>
                      <input type="checkbox" checked={instrumental}
                             onChange={(e) => setInstrumental(e.target.checked)} />
                      Instrumental — no vocals
                    </label>
                    {!instrumental && (
                      <div className="gd-pop">
                        <textarea className="ws-input ns-scroll" rows={7} value={lyrics}
                                  placeholder={"[Verse]\nwrite the words here\n\n[Chorus]\n…"}
                                  onChange={(e) => setLyrics(e.target.value)}
                                  style={{ fontSize: 12, lineHeight: 1.55 }} />
                        <div className="ws-menu-empty" style={{ fontSize: 10.5, lineHeight: 1.55,
                                                                textAlign: "left", padding: "2px 0 0" }}>
                          Section tags — [Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge]
                          [Instrumental] [Outro] — are how both models are told where
                          the song changes. Leave this empty and the track comes back
                          instrumental.
                        </div>
                      </div>
                    )}
                  </>
                )}
              </Ctl>
            )}

            {/* ACE-Step's typed musical inputs. Not shown for Music 3, which
                has no such fields — a BPM control there would be a number the
                render provably ignores. */}
            {musicalMeta && (
              <Ctl icon={<SlidersHorizontal size={12} />} width={300} mono
                   value={`${bpm} · ${keyScale}`} title="Tempo, key and time signature">
                {() => (
                  <>
                    <div className="ws-menu-label">musical key</div>
                    <div className="gd-pop">
                      <label className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                        tempo · {bpm} BPM
                      </label>
                      <input type="range" min={40} max={200} step={1} value={bpm}
                             onChange={(e) => setBpm(+e.target.value)} style={{ width: "100%" }} />
                      <div className="gd-chips">
                        {["2", "3", "4", "6"].map((t) => (
                          <button key={t} className={"gd-chip" + (timeSig === t ? " on" : "")}
                                  onClick={() => setTimeSig(t)}>{t}/4</button>
                        ))}
                      </div>
                      <select className="ws-input mono" value={keyScale}
                              onChange={(e) => setKeyScale(e.target.value)}
                              style={{ height: 32, fontSize: 12 }}>
                        {KEY_SCALES.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      <span className="mono" style={{ fontSize: 10.5, color: "#5e6678", lineHeight: 1.5 }}>
                        Guidance, not a guarantee — the model may land near these
                        rather than on them.
                      </span>
                    </div>
                  </>
                )}
              </Ctl>
            )}

            {/* length */}
            {kind === "video" && (
              <Ctl icon={<Timer size={12} />} width={260} mono
                   value={`${(realMs / 1000).toFixed(1)}s`} title="Clip length">
                {() => (
                  <>
                    <div className="ws-menu-label">length · rendered at {grid.fps}fps</div>
                    <div className="gd-pop">
                      <div className="gd-chips">
                        {DURATIONS.map((d) => (
                          <button key={d} className={"gd-chip" + (Math.abs(durSec - d) < 0.01 ? " on" : "")}
                                  onClick={() => setDurSec(d)}>{d}s</button>
                        ))}
                      </div>
                      <input type="range" min={4} max={15} step={0.5} value={durSec}
                             onChange={(e) => setDurSec(+e.target.value)} style={{ width: "100%" }} />
                      <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                        {frames} frames · {(realMs / 1000).toFixed(2)}s exact
                        {eta ? ` · ~${eta} in the cloud` : ""}
                      </span>
                      {local && (
                        // The slider tops out at 15s and no local recipe is
                        // measured past a few seconds; on a laptop the honest
                        // warning is about MINUTES, not about a frame cap.
                        <span className="mono" style={{ fontSize: 10.5, color: "#8a93a6" }}>
                          Every second is real sampling on your own GPU — start short.
                        </span>
                      )}
                      {/* the slider goes to 15s; the size may not */}
                      {frameCap < MAX_FRAMES && msToFramesCeil(durSec * 1000) > frameCap && (
                        <span className="mono" style={{ fontSize: 10.5, color: "#e8c268" }}>
                          {size.label} caps this pass at {frameCap} frames
                          ({(framesToMs(frameCap) / 1000).toFixed(1)}s).
                        </span>
                      )}
                    </div>
                  </>
                )}
              </Ctl>
            )}

            {/* Steps — LOCAL only, and only because the local runner actually
                reads `payload.steps`. The pod does too, but its recipes are
                tuned per model_map entry and the composer has never offered a
                way to break one; on your own machine step count is the whole
                speed/quality dial and the difference between 40 seconds and
                ten minutes. Blank means the recipe's own value. */}
            {local && (
              <Ctl icon={<Layers size={12} />} width={250} mono on={steps != null}
                   value={steps != null ? `${steps} steps` : `${recipeSteps} steps`}
                   title="Sampler steps on this machine">
                {() => (
                  <>
                    <div className="ws-menu-label">steps</div>
                    <div className="gd-pop">
                      <div className="gd-chips">
                        {[4, 6, 10, 15, 20, 30].map((n) => (
                          <button key={n} className={"gd-chip" + (steps === n ? " on" : "")}
                                  onClick={() => setSteps(n)}>{n}</button>
                        ))}
                        <button className={"gd-chip" + (steps == null ? " on" : "")}
                                onClick={() => setSteps(null)}>recipe</button>
                      </div>
                      <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                        {model?.display_name} is written for {recipeSteps}. Fewer is
                        faster and softer; a distillation you pick sets its own.
                      </span>
                    </div>
                  </>
                )}
              </Ctl>
            )}

            {/* style LoRAs — images and video alike */}
            {available.length > 0 && (
              <Ctl icon={<Palette size={12} />} width={300} on={loras.length > 0}
                   value={loras.length ? loras.map((l) => l.key).join(", ") : "no lora"}
                   title="Style LoRAs this model has installed">
                {() => (
                  <>
                    <div className="ws-menu-label">style loras</div>
                    <div className="gd-pop">
                      <LoraStack model={model} value={loras} onChange={setLoras} compact />
                    </div>
                  </>
                )}
              </Ctl>
            )}

            {/* Refinement pass. Gated the same way the negative prompt is:
                shown only where the model declares a recipe, because
                `resolve()` raises rather than quietly rendering one pass.
                Deliberately NOT its own model row — refinement composes with
                checkpoint, style and turbo alike, so twinning each of the six
                H3 entries would be twelve near-identical picks. */}
            {refineOk && !local && (
              <Ctl icon={<Sparkles size={12} />} width={320} on={refine}
                   value={refine ? "2-pass" : "1-pass"}
                   title="Refinement — a second, higher-resolution pass">
                {() => (
                  <>
                    <div className="ws-menu-label">refinement</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8,
                                    padding: "4px 9px 8px", fontSize: 12.5,
                                    color: "#c8cfdb", cursor: "pointer" }}>
                      <input type="checkbox" checked={refine}
                             onChange={(e) => setRefine(e.target.checked)} />
                      Add a second pass
                    </label>
                    <div className="ws-menu-empty" style={{ fontSize: 10.5, lineHeight: 1.55,
                                                            textAlign: "left", padding: "2px 9px 8px" }}>
                      Renders as usual, then upscales the result 1.25x and
                      samples it again for 4 steps at low denoise — detail
                      without re-deciding the shot. The soundtrack is carried
                      across untouched, so only the picture changes. Costs the
                      extra pass in GPU time.
                    </div>
                  </>
                )}
              </Ctl>
            )}

            {/* Negative prompt — only on models that actually sample one.
                Anima is the one local family that is not distilled, so it is
                the one where this changes the picture; everything else runs
                cfg 1.0 against a ConditioningZeroOut (or, for H3, has no
                negative branch at all) and would get a control that does
                nothing. See `takesNegative`. */}
            {negOk && (
              <Ctl icon={<Ban size={12} />} width={320} on={!!negative.trim()}
                   value={negative.trim()
                     ? (negative.trim().length > 22
                         ? `${negative.trim().slice(0, 20).trimEnd()}…` : negative.trim())
                     : "default"}
                   title="Negative prompt — what to steer away from">
                {() => (
                  <>
                    <div className="ws-menu-label">negative prompt</div>
                    <div className="gd-pop">
                      <textarea className="ws-input ns-scroll" rows={3}
                                value={negative}
                                placeholder={negDefault || "What to keep out of the frame."}
                                onChange={(e) => setNegative(e.target.value)}
                                style={{ fontSize: 12, lineHeight: 1.5 }} />
                      {/* An empty box is NOT "no negative prompt" — the worker
                          falls back to model_map's own string. Saying which
                          one is the whole point of showing it here. */}
                      <div className="ws-menu-empty" style={{ fontSize: 10.5, lineHeight: 1.5,
                                                              textAlign: "left", padding: "2px 0 0" }}>
                        {negative.trim()
                          ? "Replaces this model's default for this generation."
                          : negDefault
                            ? `Empty — ${model?.display_name ?? "the model"} applies its own default above.`
                            : `Empty — ${model?.display_name ?? "the model"} applies its own default.`}
                      </div>
                      {!!negative.trim() && (
                        <button className="ws-microbtn" style={{ marginTop: 6 }}
                                onClick={() => setNegative("")}>
                          back to the model default
                        </button>
                      )}
                    </div>
                  </>
                )}
              </Ctl>
            )}

            {/* seed */}
            <Ctl icon={<Dice5 size={12} />} width={250} mono on={seed != null}
                 value={seed != null ? String(seed) : "random"}
                 title="Pin a seed so the same prompt re-rolls identically">
              {() => (
                <>
                  <div className="ws-menu-label">seed</div>
                  <div className="gd-pop">
                    <input className="ws-input mono" placeholder="random"
                           value={seed ?? ""} inputMode="numeric"
                           onChange={(e) => {
                             const v = e.target.value.replace(/[^\d]/g, "");
                             setSeed(v ? Math.min(2 ** 31 - 1, +v) : null);
                           }}
                           style={{ height: 32, fontSize: 12 }} />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="ws-microbtn accent"
                              onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
                        <Dice5 size={11} /> roll one
                      </button>
                      <button className="ws-microbtn" style={{ flex: 1 }} onClick={() => setSeed(null)}>
                        back to random
                      </button>
                    </div>
                  </div>
                </>
              )}
            </Ctl>

            {/* Project style: what it will put in front of the prompt, and
                the means to change it. This was a bare on/off pill labelled
                "style guide", which is how a one-word `projects.style` of
                "anime" ended up silently prefixing every prompt — the toggle
                named a feature, not its content, and offered no way to set the
                guide it claimed to be applying.

                Hidden on music, because `go()` does not apply it there — a
                pill that stays on screen offering to "apply it to this
                generation" while the generation provably ignores it is the
                same control-that-lies problem in a new place. */}
            {!isMusic && (
            <Ctl icon={<Sparkles size={12} />} width={330} align="right"
                 on={useStyle && !!styleText.text}
                 title="Project style guide — prepended to every prompt"
                 value={!styleText.text ? "no style"
                   : styleText.text.length > 20
                     ? `${styleText.text.slice(0, 18).trimEnd()}…` : styleText.text}>
              {() => (
                <>
                  <div className="ws-menu-label">
                    Style guide
                    {styleText.source === "legacy" && " · legacy field"}
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 9px 8px",
                                  fontSize: 12.5, color: "#c8cfdb", cursor: "pointer" }}>
                    <input type="checkbox" checked={useStyle && !!styleText.text}
                           disabled={!styleText.text}
                           onChange={(e) => setUseStyle(e.target.checked)} />
                    Apply it to this generation
                  </label>
                  {styleText.source === "legacy" && (
                    <div className="ws-menu-empty" style={{ fontSize: 10.5, lineHeight: 1.55,
                                                            color: "#c9b48b", textAlign: "left" }}>
                      "{styleText.text}" is this project's one-word style field, not a style
                      guide. One word barely steers a model — pick a preset or write your own
                      below and it becomes the project's guide.
                    </div>
                  )}
                  <div className="ws-menu-sep" />
                  <div className="ws-menu-label">Presets</div>
                  {STYLE_PRESETS.map((p) => (
                    <button key={p.id} className={"ws-menu-row" + (styleText.text === p.guide ? " on" : "")}
                            title={p.guide}
                            onClick={() => void saveStyle(p.guide)}>
                      <img src={p.image} alt={p.label} style={{ width: 32, height: 24, borderRadius: 5, objectFit: "cover", flexShrink: 0, marginRight: 8 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5, fontWeight: 500 }}>{p.label}</span>
                      </span>
                      {styleText.text === p.guide && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                    </button>
                  ))}
                  <div className="ws-menu-sep" />
                  <div className="ws-menu-label">Or write one</div>
                  <div style={{ padding: "0 9px 9px" }}>
                    <textarea className="ws-input ns-scroll" rows={4}
                              value={styleDraft ?? styleText.text}
                              placeholder="Prose the whole project should look like — medium, lighting, lens, materials, what to avoid."
                              onChange={(e) => setStyleDraft(e.target.value)}
                              style={{ fontSize: 12, lineHeight: 1.5 }} />
                    <div style={{ display: "flex", gap: 7, marginTop: 7 }}>
                      <button className="ws-primary" style={{ height: 28, flex: 1, justifyContent: "center" }}
                              disabled={styleDraft == null || styleDraft === styleText.text || savingStyle}
                              onClick={() => void saveStyle((styleDraft ?? "").trim())}>
                        {savingStyle ? <Loader2 size={12} className="ns-spin" /> : "Save to project"}
                      </button>
                      {styleText.text && (
                        <button className="ws-ghost" style={{ height: 28 }}
                                title="Clear the project's style guide entirely"
                                onClick={() => void saveStyle("")}>
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </Ctl>
            )}

            <button className="gd-go" disabled={busy} onClick={() => void go()}>
              {busy ? <Loader2 size={14} className="ns-spin" /> : <Sparkles size={14} />}
              Generate
            </button>
          </div>
        </div>
      </div>
     </div>

      {/* What you just asked for, while it happens. Separate from the hint line
          below on purpose: that one is cleared by the next keystroke, and the
          prompt now survives the click, so the first thing you do after
          pressing Generate is usually to edit it. */}
      {!!inFlight.length && (
        <div className="gd-live">
          {inFlight.map((j) => {
            const done = j.status === "done";
            const bad = j.status === "error" || j.status === "canceled";
            const stopping = cancelling(j);
            const pct = Math.round((j.progress ?? 0) * 100);
            return (
              <div key={j.id} className={"gd-liverow" + (done ? " ok" : "") + (bad ? " bad" : "")}>
                {done ? <Check size={12} />
                  : bad ? <Ban size={12} />
                  : <Loader2 size={12} className="ns-spin" />}
                <span className="t" title={jobLabel(j)}>{jobLabel(j)}</span>
                <span className="s mono">
                  {done ? "done — it's in the library"
                    : j.status === "canceled" ? "canceled"
                    : j.status === "error" ? (j.error_msg ?? "failed").slice(0, 70)
                    : stopping ? "cancelling…"
                    : j.status === "queued" ? "queued for the studio cloud"
                    : j.progress ? `rendering ${pct}%` : (j.progress_note || "rendering")}
                </span>
                {j.status === "running" && j.progress != null && !stopping && (
                  <span className="gd-livebar"><i style={{ width: `${pct}%` }} /></span>
                )}
                <button className="x" disabled={stopping}
                        title={done || bad
                          ? "Dismiss"
                          : "Cancel — the worker stops at its next checkpoint"}
                        onClick={() => {
                          if (done || bad) setSent((s) => s.filter((id) => id !== j.id));
                          else cancel(j.id);
                        }}>
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className={"gd-hint" + (note && warn ? " warn" : "") + (note && !warn ? " ok" : "")}>
        {note ?? (kind === "video"
          ? `${size.w}×${size.h} · ${frames}f @24fps${eta ? ` · ~${eta}` : ""}`
            + `${attached ? ` · ${attached} image${attached === 1 ? "" : "s"}` : ""} · ⌘↵ to queue`
          : `${size.w}×${size.h}${attached ? ` · ${attached} reference${attached === 1 ? "" : "s"}` : ""}`
            + " · ⌘↵ to queue")}
      </div>

      <input ref={fileRef} type="file" hidden multiple accept="image/*,video/*,audio/*"
             onChange={(e) => void onUpload(e.target.files)} />

      {hover && createPortal(
        (() => {
          const W = 300;
          const left = Math.max(8, Math.min(window.innerWidth - W - 8,
            hover.rect.left + hover.rect.width / 2 - W / 2));
          const above = hover.rect.top > 250;
          return (
            <div className="ws-hover ns-l2 ns-pop"
                 onPointerEnter={holdHover} onPointerLeave={closeHover}
                 style={{
                   position: "fixed", zIndex: 1200, left, width: W,
                   ...(above ? { bottom: window.innerHeight - hover.rect.top + 10 }
                             : { top: hover.rect.bottom + 10 }),
                 }}>
              <div style={{ position: "relative", aspectRatio: "16/9", background: "#000", borderRadius: "12px", overflow: "hidden" }}
                   onPointerMove={(e) => {
                     const v = e.currentTarget.querySelector("video");
                     const bar = e.currentTarget.querySelector<HTMLElement>("[data-bar]");
                     if (!v?.duration) return;
                     const r = e.currentTarget.getBoundingClientRect();
                     const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
                     v.currentTime = f * v.duration;
                     if (bar) bar.style.width = `${f * 100}%`;
                   }}>
                <video src={assetUrl(hover.asset) ?? undefined} muted preload="metadata" playsInline
                       onLoadedMetadata={(e) => {
                         const v = e.currentTarget;
                         if (v.duration) v.currentTime = v.duration * 0.35;
                       }}
                       style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: "rgba(255,255,255,.16)" }}>
                  <span data-bar style={{ display: "block", height: "100%", width: "35%", background: "#eaeef6" }} />
                </div>
                <span className="mono" style={{ position: "absolute", left: 9, top: 9, padding: "4px 8px", borderRadius: 10,
                                                background: "rgba(7,9,14,.72)", backdropFilter: "blur(12px)",
                                                fontSize: 10.5, fontWeight: 600, color: "#eaeef6" }}>
                  {hover.label} · scrub to preview
                </span>
              </div>
            </div>
          );
        })(),
        document.body
      )}

      {picking && (
        <AssetPickerModal
          projectId={projectId}
          title={needs === "start" ? "Opening frame"
            : needs === "start+end" ? (!startAsset ? "Opening frame" : "Closing frame")
            : "Add references"}
          context={needs === "refs"
            ? `${refs.length}/${cap || 9} used · ${model?.display_name ?? "model"}`
            : `one image · ${model?.display_name ?? "model"}`}
          multi={needs === "refs"}
          capacity={needs === "refs" ? Math.max(0, (cap || 9) - refs.length) : 1}
          used={needs === "refs" ? new Set(refs.map((r) => r.id)) : undefined}
          onClose={() => setPicking(false)}
          onPick={(picks) => picks.forEach((p) => attach(p.asset))}
        />
      )}
    </div>
  );
}

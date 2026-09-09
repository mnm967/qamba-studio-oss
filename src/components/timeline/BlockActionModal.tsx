import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  X, Sparkles, Loader2, ArrowRight, FolderOpen, ChevronDown, Wand2, Undo2,
} from "lucide-react";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { aimVideoAt, extractAndSaveClipFrame } from "../../lib/frameExtractor";
import { isStill } from "../../lib/assetKind";
import { clipSourceMs, formatTc, frameMs } from "../../lib/clipFrames";
import { describePlan, rasterPlan } from "../../lib/clipRaster";
import { layerStyle, sourceBox, type Box } from "../../lib/clipCrop";
import { asArray } from "../../lib/jsonb";
import { frameGrid, framesToMs, gridSteps, msToFrames, snapFrames } from "../../lib/videoGrid";
// H3's trained-range floor, the same constant the worker carries — pinned
// against `worker/h3_timing.py` by `h3timing.test.ts`.
import { MIN_FRAMES } from "../../lib/h3timing";
import { loadCatalog } from "../../lib/catalog";
import { tierOf, type ModelTier } from "../../lib/localModels";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import { useByok, useByokRows } from "../../hooks/useByok";
import {
  backendLabel, describeDirectorError, enhanceAlignment, enhanceGuide, enhancePrompt,
} from "../../lib/director";
import {
  modelKeyOf, resolveDefaults, styleTextFor, type ProjectSettings,
} from "../../lib/projectSettings";
import { renderDims } from "../../lib/resolution";
import Dropdown from "../ui/Dropdown";
import TieredModelMenu, { rowBlocked } from "../ui/TieredModelMenu";
import { LoraStack, styleLoras, validLoras } from "../ui/ImageModelPicker";
import type { LoraPick } from "../../lib/projectSettings";
import type { ModelCatalogRow } from "../../lib/db/types";
import { enqueueJob } from "../../lib/db/jobs";
import { nearestLaneBlockId } from "../../lib/blockFromClip";
import {
  baseModeFor, jobModeFor, refCapOf, refsBlocker, submitBlocker,
} from "../../lib/addBlockRefs";
import { mediaUrl, supabase } from "../../lib/supabase";
import type { Asset, Clip } from "../../lib/db/types";
import AssetPickerModal from "../modals/AssetPickerModal";
import { Z_MODAL } from "../modals/ModalShell";
import RefTiles from "../ui/RefTiles";

export type BlockModalMode = "add_after" | "extend" | "chain";

/**
 * The render mode each action needs, and therefore which models can serve it.
 *
 * A chain is FIRST-AND-LAST-FRAME: it is handed both anchors and has to arrive
 * at the second one. An extend opens on a frame and goes wherever the prompt
 * takes it. A model that does not declare the mode fails server-side with
 * `mode '<X>' not available for <model>` — LTX 2.5, for one, has no `flf` at
 * all — so a picker that offered it would be offering a job that dies on the
 * pod minutes later.
 */
export const MODE_FOR: Record<BlockModalMode, string> = {
  chain: baseModeFor("chain"),
  extend: baseModeFor("extend"),
  add_after: baseModeFor("add_after"),
};

interface BlockActionModalProps {
  mode: BlockModalMode;
  clip: Clip;
  nextClip?: Clip | null;
  onClose: () => void;
}

/**
 * The source instant an anchor was taken from, and the window it came out of.
 *
 * Here because "did it use my trim?" was otherwise unanswerable from the
 * picture: two frames a second apart in a fight look equally plausible, so a
 * trim that never reached the extract and one that did are the same screen.
 * The window is the CLIP's, in source time, so a head trim shows as a non-zero
 * left edge and a tail trim as an early right one — which separates "the
 * extract ignored the trim" from "the clip never got trimmed" without a
 * database.
 */
function FrameStamp({ clip, asset, position }: {
  clip: Clip; asset: Asset | undefined; position: "first" | "last";
}) {
  if (isStill(asset)) return <em className="bam-stamp">whole still · no timecode</em>;
  const at = clipSourceMs(clip, position, asset);
  const from = Math.max(0, clip.in_ms ?? 0);
  const to = from + Math.max(0, clip.duration_ms ?? 0);
  // The clip's ops are applied to the extract now, so say when they were — a
  // mirrored anchor that matches the timeline looks identical to one that does
  // not until you know which you are looking at.
  const ops = describePlan(rasterPlan(clip, asset));
  return (
    <em className="bam-stamp" title="Source timecode of this frame, the clip's trimmed window, and the ops applied to it">
      {formatTc(at)} <span>of {formatTc(from)}–{formatTc(to)}</span>
      {/* Its own line: the timecode pair already fills a 320px tile, so the
          ops ran off the end of the card rather than wrapping. */}
      {ops && <b>{ops}</b>}
    </em>
  );
}

/**
 * The frame itself — read straight off the source, not extracted.
 *
 * Nothing is uploaded to show you a picture. This used to run the full extract
 * on MOUNT: two seeks, two canvas encodes, two B2 uploads and two `assets`
 * rows every time the modal opened, kept whether you pressed Create Block or
 * Cancel — and twice over, because the effect's deps include the store's
 * `assets` map, whose identity changes on every reconcile. The live data has
 * the duplicates in it, seconds apart.
 *
 * So the preview is a paused `<video>` parked on the instant, and the extract
 * happens once, on submit, when the frame is actually going to anchor a
 * render. It shares `aimVideoAt` with the extract, which is the point: if the
 * seek is wrong the picture on screen is wrong in the same way, rather than
 * the preview being right and the anchor silently not.
 */
/** The box the picture actually occupies, MEASURED rather than assumed.
 *
 *  `layerStyle` states its crop window as a `clip-path` in px against the box
 *  the element fills, so this cannot be a constant. It was `{320, 100}` while
 *  `.bam-frame-item img/video` pinned every preview to a fixed 100px — and it
 *  stopped being that the moment those pictures started SIZING THEMSELVES
 *  (`max-width: 100%; max-height: <cap>`), which is the whole point of that
 *  rule: the box is now the render's own shape capped by the column, a
 *  different rectangle per asset and a different one again in each of this
 *  modal's two layouts (the 140px `.bam-frame-item` pair and the 260px
 *  `.bam-frame-thumb`). A stale box does not fail — it puts a CROPPED clip's
 *  window in the wrong place and still shows a picture, which is the failure
 *  this file keeps naming.
 *
 *  `offsetWidth`/`offsetHeight`, never `getBoundingClientRect()`: the element
 *  carries `layerStyle`'s own `transform`, which the rect INCLUDES and the
 *  offsets do not — so measuring the rect would feed the scale straight back
 *  into the box it was computed from. Neither `transform` nor `clip-path`
 *  affects layout, so the measurement is stable and settles in one pass.
 *
 *  A zero box is "not measured yet", and `layerStyle` skips the crop for that
 *  frame rather than dividing by it. */
function useLayoutBox(el: HTMLElement | null): Box {
  const [box, setBox] = useState<Box>({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) { setBox({ w: 0, h: 0 }); return; }
    const measure = () => setBox((p) => {
      const w = el.offsetWidth, h = el.offsetHeight;
      return p.w === w && p.h === h ? p : { w, h };
    });
    measure();
    // The media's INTRINSIC size is what decides this box, and neither element
    // reports one until it loads — so the eager measurement above is of a
    // placeholder and the real one arrives with the metadata.
    el.addEventListener("loadedmetadata", measure);
    el.addEventListener("load", measure);
    // A ResizeObserver callback is delivered in the rendering steps, so a
    // document that is not painting never gets one; it is the follow-up here,
    // never the only measurement.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("loadedmetadata", measure);
      el.removeEventListener("load", measure);
      ro?.disconnect();
    };
  }, [el]);
  return box;
}

function SourceFrame({ clip, asset, atMs, alt }: {
  clip: Clip; asset: Asset | undefined; atMs: number; alt: string;
}) {
  // The node in STATE, not a ref: the box below is measured off it, and a ref
  // gives the effect nothing to re-run on when the element is swapped.
  const [media, setMedia] = useState<HTMLVideoElement | HTMLImageElement | null>(null);
  const still = isStill(asset);
  const url = asset ? mediaUrl(asset.b2_key) : null;
  const box = useLayoutBox(media);
  // THE CLIP'S OWN LOOK, the same way the stage gets it. The preview is a raw
  // media element, so without this it shows the untransformed source while the
  // timeline plays a flipped or cropped one — and the ANCHOR does carry the
  // ops (clipRaster), so the picture on screen would disagree with the render
  // it is previewing. `layerStyle` is PreviewPlayer's own, so the modal and
  // the stage cannot drift.
  const style = layerStyle(clip.ops, sourceBox(asset), box);

  useEffect(() => {
    if (!media || still || media.tagName !== "VIDEO") return;
    // Playback only — no canvas, so no crossOrigin and no proxy needed here.
    void aimVideoAt(media as HTMLVideoElement, atMs / 1000, { endGuardSec: frameMs(asset) / 2000 })
      .catch(() => { /* a frame we cannot reach shows the poster; the stamp still says where we aimed */ });
  }, [media, atMs, url, still, asset]);

  if (!url) return <span className="bam-frame-none">no media on this clip</span>;
  if (still) return <img ref={setMedia} src={url} alt={alt} style={style} />;
  return <video ref={setMedia} src={url} preload="auto" muted playsInline
                aria-label={alt} style={style} />;
}

export default function BlockActionModal({ mode, clip, nextClip, onClose }: BlockActionModalProps) {
  const store = useTimelineStore();
  const { assets } = store;

  const [prompt, setPrompt] = useState("");
  const engine = useLocalEngine();
  // The whole catalog, so `useByokRows` can re-enable the rows this machine
  // holds a key for and offer the ones it does not. Loaded into state rather
  // than awaited inside the effect below, because the hook has to see it.
  const [catalog, setCatalog] = useState<ModelCatalogRow[] | null>(null);
  const byokRows = useByokRows(catalog);
  const { config: byokCfg } = useByok();
  /** Carry the predecessor's MOTION across the join, not just its last frame.
   *  On by default, and offered as a switch because it is the one knob worth
   *  an A/B — see the payload below for what it costs. */
  const [carryMotion, setCarryMotion] = useState(true);
  const [enhancing, setEnhancing] = useState(false);
  /** What the box held before the rewrite, so one click puts it back. The
   *  rewrite REPLACES what you typed, so it has to be undoable — the library
   *  composer's own rule. */
  const [preEnhance, setPreEnhance] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [loras, setLoras] = useState<LoraPick[]>([]);
  /** Where the starting stack came from, so an adapter nobody picked in this
   *  modal is never silently applied. */
  const [loraFrom, setLoraFrom] = useState<string | null>(null);
  const [models, setModels] = useState<ModelCatalogRow[] | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  /** The project's own default, kept even when it cannot serve this mode —
   *  "your default can't do this, so here's what I picked" is a better answer
   *  than silently selecting something else. */
  const [projectModelId, setProjectModelId] = useState<string | null>(null);
  /** Length in FRAMES, not seconds: every legal length is a point on the
   *  model's own grid, so the slider steps along it and cannot land between
   *  two of them. Null until a model is known — its grid decides the range. */
  const [frames, setFrames] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** What the submit is doing right now — the extract is the slow half and it
   *  no longer happens before you ask for it, so the button has to say so. */
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the picker is being opened FOR. It used to be a boolean, which is
   *  all one purpose needs; references are a second. */
  const [picker, setPicker] = useState<null | "take" | "refs">(null);
  /** The reference set for a NEW block. Ordered — the payload is a flat list
   *  and the prompt refers to them as `Picture 1..N` in exactly this order —
   *  and held as whole assets so the tiles can be drawn without a second read. */
  const [refs, setRefs] = useState<Asset[]>([]);

  const curAsset = assets.get(clip.asset_id);
  const nextAsset = nextClip ? assets.get(nextClip.asset_id) : undefined;

  /** A block still waiting on its render is a PLACEHOLDER STILL on the lane —
   *  every generate action here parks one — and a still has one frame, so
   *  "the end of the shot" is not something it can give you. Warn rather than
   *  refuse: a still someone placed deliberately is a legitimate anchor, and
   *  refusing would block it. What must not happen is presenting a placeholder
   *  as a shot's final frame with nothing on screen to say otherwise. */
  const placeholders = [
    mode !== "add_after" && isStill(curAsset) ? (clip.label ?? "This block") : null,
    mode === "chain" && nextClip && isStill(nextAsset) ? (nextClip.label ?? "The next block") : null,
  ].filter(Boolean) as string[];

  // The two anchors of the BRIDGE, in source time. Named for the bridge and
  // not for the blocks: a chain generates a clip that opens where block A
  // stops and lands where block B starts, so A's END frame is the `start` one
  // — which is what made the panel's own "Frame A · End" read like a mislabel.
  // An extend uses the first alone, where the two readings coincide.
  const model = models?.find((m) => m.id === modelId) ?? null;
  const tier: ModelTier | null = model ? tierOf(model) : null;
  /**
   * Where the job runs, decided ONCE. `lane: "local"` is what keeps the pod's
   * claim query from ever seeing a desktop render, and `model_key` is a
   * `model_map` key on a box that render never touches — sending one would
   * name a checkpoint the local runner does not resolve. Same split the
   * library composer makes.
   */
  /**
   * THREE PLANES, not two, since hosted rows became pickable here.
   *
   *   local  this machine's ComfyUI       lane "local", kind "clip_gen"
   *   byok   a provider on the user's key lane "local", kind "byok_gen"
   *   cloud  the studio's pod             lane "gpu",   kind "clip_gen"
   *   cloud  a hosted API on the studio's lane "api",   kind "api_generate"
   *
   * `model_key` is a `model_map` key and belongs to the POD alone — the local
   * runner resolves an `engineCatalog` recipe and a hosted provider resolves
   * nothing, so sending one there names a checkpoint that will never be
   * loaded. `make_block` is the pod's too (`_publish_clip_block`), which is
   * why the other three land as a clip and can be promoted afterwards.
   */
  const hosted = tier === "cloud" && !!model && model.provider !== "local";
  const plane = tier === "local"
    ? { lane: "local" as const, kind: "clip_gen" as const, model_key: undefined }
    : tier === "byok"
    ? { lane: "local" as const, kind: "byok_gen" as const, model_key: undefined }
    : hosted
    ? { lane: "api" as const, kind: "api_generate" as const, model_key: undefined }
    : { lane: "gpu" as const, kind: "clip_gen" as const,
        model_key: modelKeyOf(modelId ?? undefined) };
  /**
   * A user-added fal endpoint TRAVELS WITH THE JOB. It lives in this machine's
   * localStorage and the runner may claim it for a project the user is not
   * looking at, so looking it up at run time would be reading a list that
   * could have changed since the click — GenComposer's own reasoning, and the
   * same field (`byok_model`) `rowForJob` reads.
   */
  const byokModel = byokCfg.custom.find((c) => c.id === modelId) ?? null;
  /** Why this model cannot be run, if it cannot. `TieredModelMenu` will not
   *  let one be picked, but the selection survives a model switch and a
   *  config change, so the submit asks again. */
  const blocked = model ? rowBlocked(model) : null;
  /** A desktop model whose engine is not listening cannot start. */
  const engineDown = tier === "local" && !engine.ready;
  /**
   * MAKE THE RENDER A BLOCK, so it enters the takes system: the worker
   * publishes it as a `generation_blocks` row with this render as its first
   * take (`_publish_clip_block`), and the strip, assembly and retakes all
   * apply to it untouched. Cloud only — the desktop runner attaches the clip
   * and stops, so on the local plane the render lands exactly as it always
   * did (a clip with its ClipRenders strip, promotable later via "Save as new
   * block").
   *
   * `after_block_id` places it in the storyboard: the extended clip's own
   * block when it has one, else the nearest lane neighbour. `chain_from` is
   * only the SOURCE block — it records where the anchor frame came from, and
   * a lane neighbour is not that.
   */
  const makeBlock = (): Record<string, unknown> => plane.lane !== "gpu" ? {} : {
    make_block: {
      after_block_id: clip.block_id ?? nearestLaneBlockId(store.clips, clip),
      chain_from_block_id: clip.block_id ?? null,
    },
  };
  /**
   * WHAT THE JOB ASKS FOR, which is not what the PICKER filtered on.
   *
   * A reference turns a new block from t2v into r2v — `handle_clip_gen` wires
   * `ref_images` under that mode and nowhere else — while the model list stays
   * filtered on the action's floor, so attaching one cannot silently re-pick
   * the model. See addBlockRefs.ts for why the two are different questions.
   */
  const jobMode = jobModeFor(mode, refs.length);
  const refsWhy = refsBlocker(mode, model);
  const refCap = refCapOf(model);
  const grid = frameGrid(model);
  /**
   * WHAT SIZE THIS RENDERS AT — carried, never left to `handle_clip_gen`.
   *
   * These three payloads named no width or height, so the handler used its own
   * `1280x720` literal — 720 is illegal at `dim_step` 32, and 720/32 = 22.5 is
   * exactly where JS rounds up (736) and Python rounds to even (704). A chain
   * therefore rendered 1280x704 between blocks the resolution picker had
   * snapped to 1280x736, and the 16px went in as black bars on every frame:
   * letterboxed in the preview, and baked into the flatten by `render.py`'s
   * `_fit`. The clip being continued is the size that means anything here.
   */
  const dims = renderDims(model, curAsset, nextAsset, store.timeline);
  const dimsPayload = dims ? { width: dims.w, height: dims.h } : {};
  // The starting length is the one this modal has always used, put on the
  // chosen model's grid rather than sent as-is.
  const wantMs = mode === "chain" ? 2000 : 4000;
  const frameCount = frames ?? msToFrames(grid, wantMs);
  const durMs = framesToMs(grid, frameCount);
  /**
   * Whether this length is below what H3 was trained on — NOT below what the
   * grid allows. `grid.minFrames` says which counts are legal (17n+5, from 5
   * up); this says which of them the model has seen. Two gates, and each is
   * load-bearing:
   *
   *  - the FAMILY, because 90 frames at 24fps is H3's number and every other
   *    row here has its own range;
   *  - the PLANE, because the note claims the render comes back at exactly
   *    this length and that is only true where the studio decides the frame
   *    count. `clip_gen` is that (the pod's `handle_clip_gen` since its floor
   *    was removed, and `localRender`, which never had one). A hosted or BYOK
   *    H3 goes to MiniMax's own API, which takes 4-15 WHOLE seconds and rounds
   *    a short request up at its end — so the note would be exactly backwards
   *    there, and promising a length the provider will not honour is the thing
   *    this whole change is undoing.
   */
  const belowSpec = model?.family === "minimax-h3"
    && plane.kind === "clip_gen" && frameCount < MIN_FRAMES;

  // Which models can serve this action, and which one the project would use.
  useEffect(() => {
    let off = false;
    (async () => {
      const pid = curAsset?.project_id ?? null;
      const [rows, proj] = await Promise.all([
        // The WHOLE catalog, not `videoModels()`. That helper filters
        // `m.enabled`, and every hosted row ships disabled — `enabled` records
        // whether the STUDIO has a key, not whether the adapter works — so
        // filtering here would drop exactly the rows a user with their own key
        // can run, and drop them before `byokRows` could turn them back on.
        // Nothing is hidden; `TieredModelMenu` says why a row cannot be picked
        // and, where the fix is the user's own, makes it a button.
        loadCatalog(),
        pid ? supabase.from("projects").select("settings").eq("id", pid).maybeSingle()
            : Promise.resolve({ data: null }),
      ]);
      if (off) return;
      setCatalog(rows);
      // The pod's rows, this machine's, and — since `_apply_target` learned
      // `clip_id` — the hosted ones too.
      //
      // HOSTED USED TO BE EXCLUDED HERE, and the reason was real rather than
      // cautious: those rows run as `api_generate`, whose target handling knew
      // only `bible_entry_id`, so a hosted extend registered its render in the
      // library and left the placeholder still on the lane — the exact failure
      // `_attach_to_clip` exists to prevent, arriving on a different job kind.
      // Both halves are wired now (providers/__init__.py), so the filter is
      // back to the one thing it should ever have been: can this model do this
      // mode.
      //
      // `modes` is what decides. A model that does not declare `flf` cannot
      // end on a given frame, and offering it for a chain would produce a
      // bridge that never arrives at block B with nothing to say why —
      // Seedance and Wan 3.0 declare it, Gemini Omni Flash deliberately does
      // not.
      const need = MODE_FOR[mode];
      // A BYOK row REPLACES its catalog twin rather than sitting beside it —
      // `byokRows` returns the same row with `enabled` forced on, so keeping
      // both would list one model twice with only one of them pickable.
      const usable = [
        ...rows.filter((m) => !byokRows.some((b) => b.id === m.id)),
        ...byokRows, ...engine.rows,
      ].filter((m) => m.kind === "video" && (m.modes ?? []).includes(need));
      const want = resolveDefaults(
        ((proj as { data?: { settings?: ProjectSettings } | null }).data?.settings) ?? null
      ).video_model;
      const st = ((proj as { data?: { settings?: ProjectSettings } | null }).data?.settings) ?? null;
      setSettings(st);
      // WHERE THE STARTING STACK COMES FROM, in preference order.
      //
      // The BLOCK being extended wins over the project default, for the reason
      // `_block_loras` gives about episodes: a concept LoRA appearing in shot 4
      // and not shot 3 is the same continuity break as switching checkpoints —
      // and an extension is, by construction, more of shot 3. The project
      // default is the fallback for a clip that has no block (imported media,
      // or one of these generated clips).
      let picked = resolveDefaults(st).video_loras ?? [];
      let from = picked.length ? "your project default" : null;
      if (clip.block_id) {
        const { data: blk } = await supabase.from("generation_blocks")
          .select("params").eq("id", clip.block_id).maybeSingle();
        const params = (blk as { params?: { loras?: LoraPick[]; fight?: boolean } } | null)?.params;
        const own = params?.loras;
        if (Array.isArray(own) && own.length) {
          picked = own;
          from = `${clip.label ?? "this block"}`;
        }
        // THE COMBAT ADAPTER IS NOT IN THE STORED STACK. `_block_loras`
        // appends it at RENDER time to any block stamped `params.fight`, so
        // reading `params.loras` finds a fight block's stack without it — and
        // an extension of a fight rendered without the adapter the fight was
        // rendered with is exactly the break this seeding exists to avoid.
        // Seeded, not forced: it lands in the picker where it can be removed.
        if (params?.fight && !picked.some((l) => l.key === "combat")) {
          picked = [...picked, { key: "combat", strength: 1 }];
          from = from ? `${from} (+ combat, a fight block)` : "this fight block";
        }
      }
      if (off) return;
      setLoras(picked);
      setLoraFrom(from);
      setModels(usable);
      setProjectModelId(want ?? null);
      // Default to something that can actually be pressed. With hosted rows in
      // the list, `usable[0]` is routinely one whose only outcome is a refusal
      // — the picker would open on a model nobody can run and the button would
      // report an error the user did not cause.
      const pickable = usable.filter((m) => !rowBlocked(m));
      setModelId(pickable.some((m) => m.id === want) ? want
                 : (pickable[0]?.id ?? usable[0]?.id ?? null));
    })().catch((err) => {
      if (!off) { console.error("Could not load video models", err); setModels([]); }
    });
    return () => { off = true; };
  }, [mode, curAsset?.project_id, engine.rows, byokRows]);

  // A model switch re-snaps the length onto the NEW grid rather than keeping a
  // frame count that is legal on the old one — 22f is H3, and on LTX's 8n+1
  // it is nothing at all.
  useEffect(() => {
    setFrames((f) => (f == null ? null : msToFrames(frameGrid(model), framesToMs(grid, f))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const fromAtMs = clipSourceMs(clip, "last", curAsset);
  const toAtMs = nextClip ? clipSourceMs(nextClip, "first", nextAsset) : 0;

  /**
   * Rewrite the prompt against the SELECTED MODEL's guide.
   *
   * This path is invariant #6's one documented exception — `handle_clip_gen`
   * sends `payload.prompt` to ComfyUI verbatim — so here the prompt IS the
   * format, and "Smooth video extension continuing from the previous frame"
   * is a prompt H3 was never trained to read. The library composer has had
   * this button since the guides shipped; this modal never got it.
   *
   * Explicit and undoable on purpose. A silent rewrite of what someone typed
   * is a different product, so the text lands in the box for review and
   * `preEnhance` puts it back. A backend hop is REPORTED, never swallowed.
   */
  const guide = enhanceGuide({ family: model?.family, kind: "video", mode: jobMode });
  const enhance = async () => {
    const text = prompt.trim();
    if (!text || enhancing) return;
    setEnhancing(true);
    setNote(null);
    try {
      const res = await enhancePrompt({
        prompt: text, kind: "video",
        family: model?.family ?? null, mode: jobMode,
        model_label: model?.display_name ?? null,
        style: styleTextFor(settings, null).text || null,
        // The real count, so the rewrite is told the pictures exist and may
        // refer to them as `Picture 1..N` — sending 0 with a reference set
        // staged is a prompt that never mentions what it was handed.
        refs: refs.length, has_start: jobMode === "i2v" || jobMode === "flf",
        duration_ms: durMs,
        // Arithmetic, not writing: H3's keyframe modes open on an instruction
        // line carrying the real render duration. Computed here, sent verbatim.
        alignment: enhanceAlignment(jobMode, durMs),
        project_id: curAsset?.project_id ?? null,
        backend: settings?.director_backend || "auto",
      });
      setPreEnhance(text);
      setPrompt(res.prompt);
      const how = res.guide.exact
        ? `Rewritten with the ${res.guide.label} prompt guide`
        : `${model?.display_name ?? "This model"} has no stored guide — rewritten with general video craft`;
      const hops = res.fell_back ?? [];
      setNote(hops.length
        ? `${backendLabel(hops[0].from)} ${hops[0].reason} — ${backendLabel(res.backend)} wrote this instead. ${how}.`
        : `${how}.`);
    } catch (err) {
      setNote(`Could not enhance: ${describeDirectorError(String((err as Error).message || err))}`);
    } finally {
      setEnhancing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!modelId) { setError("No model can do this — see the model row above"); return; }
    if (blocked) { setError(`${model?.display_name ?? "That model"} — ${blocked.why}`); return; }
    if (engineDown) { setError("Your local engine isn't running — start it, or pick a cloud model"); return; }
    // Asked again here because a selection outlives what made it legal: attach
    // references, switch to a text-only model, and the payload would ask it
    // for a reference render that dies on the pod minutes later.
    const refsBad = submitBlocker(mode, model, refs.length);
    if (refsBad) { setError(refsBad); return; }

    setSubmitting(true);
    setError(null);

    try {
      const projectId = curAsset?.project_id ?? store.timeline?.episode_id ?? null;

      if (mode === "add_after") {
        const atMs = clip.t_start_ms + clip.duration_ms;
        const label = prompt.trim() ? prompt.trim().slice(0, 24) : "New Block";

        // Create new placeholder asset or use start frame / cur asset
        const placeholderKey = `placeholder/${Date.now()}.jpg`;
        const placed = await store.insertAsset(
          curAsset ?? {
            id: "",
            project_id: projectId,
            kind: "video",
            b2_key: placeholderKey,
            content_type: null,
            bytes: null,
            width: 1280,
            height: 720,
            duration_ms: durMs,
            fps: 24,
            origin: "derived",
            source_job_id: null,
            meta: {},
            tags: [],
            created_at: new Date().toISOString(),
          },
          clip.track_id,
          atMs,
          { label, durationMs: durMs }
        );

        if (prompt.trim()) {
          await enqueueJob({
            kind: plane.kind,
            lane: plane.lane,
            priority: 10,
            project_id: projectId ?? undefined,
            model_id: modelId ?? undefined,
            payload: {
              // The queue's own label. Every enqueuer sends one (`jobLabel`
              // renders it); this modal never did, so an extend and a chain
              // both showed as a bare "clip_gen" among an episode's renders.
              // The MODEL and the action, since the prompt is often the
              // compiled envelope and its first 40 characters are the
              // alignment line — identical on every chain.
              // Said rather than inferred. A hosted adapter picks its
              // ENDPOINT off the mode (Seedance's t2v and i2v are different
              // urls), and inferring "no start frame, so text-to-video" is
              // right here and would be wrong the first time this path stages
              // a reference — which is now, so it is computed rather than
              // written: `r2v` the moment anything is attached.
              mode: jobMode,
              ...(refs.length ? { ref_asset_ids: refs.map((r) => r.id) } : {}),
              label: `${model?.display_name ?? "video"} · new block`,
              // Pruned again at submit: the picker's own guard cannot run while its
              // menu is shut, so a key the chosen model does not declare would
              // otherwise reach the payload and be dropped by the worker with only a
              // log line to show for it.
              ...(validLoras(model, loras).length ? { loras: validLoras(model, loras) } : {}),
              prompt: prompt.trim(),
              ...(plane.model_key ? { model_key: plane.model_key } : {}),
            ...(byokModel ? { byok_model: byokModel } : {}),
              ...(byokModel ? { byok_model: byokModel } : {}),
              ...dimsPayload,
              duration_ms: durMs,
              // no track_id/at_ms — handle_clip_gen ignores them, and the
              // placeholder clip is already on the lane. `target` is how the
              // render finds it: see the extend branch below.
              target: { clip_id: placed.id },
            },
          });
        }
      } else if (mode === "extend") {
        setPhase("Extracting the last frame…");
        const fromFrame = await extractAndSaveClipFrame(clip, curAsset, "last");
        setPhase("Queueing…");

        const atMs = clip.t_start_ms + clip.duration_ms;
        const label = prompt.trim() ? `Ext: ${prompt.trim().slice(0, 20)}` : "Extended Block";

        // Insert new clip asset on timeline
        const placed = await store.insertAsset(fromFrame, clip.track_id, atMs, {
          label,
          durationMs: durMs,
        });

        // Enqueue I2V generation job continuing from the block's last frame
        await enqueueJob({
          kind: plane.kind,
          lane: plane.lane,
          priority: 10,
          project_id: projectId ?? undefined,
          // The storyboard fallback for make_block when the anchor block is
          // gone by claim time — the worker appends to this episode's newest
          // board rather than dropping the block on the floor.
          episode_id: store.timeline?.episode_id ?? undefined,
          model_id: modelId ?? undefined,
          payload: {
            mode: "i2v",
            ...makeBlock(),
            label: `${model?.display_name ?? "video"} · extend ${clip.label ?? "clip"}`,
            // Pruned again at submit: the picker's own guard cannot run while its
            // menu is shut, so a key the chosen model does not declare would
            // otherwise reach the payload and be dropped by the worker with only a
            // log line to show for it.
            ...(validLoras(model, loras).length ? { loras: validLoras(model, loras) } : {}),
            ...(plane.model_key ? { model_key: plane.model_key } : {}),
            ...(byokModel ? { byok_model: byokModel } : {}),
            ...dimsPayload,
            prompt: prompt.trim() || "Smooth video extension continuing from the previous frame",
            // `start_asset_id`, not `start_frame_asset_id` — that is the key
            // handle_clip_gen reads, and the longer spelling meant the handler
            // saw no opening frame and refused every extend with "i2v opens on
            // a supplied frame — pick a start image".
            start_asset_id: fromFrame.id,
            // MOTION CONTEXT. `start_asset_id` is a still, so on its own it
            // tells H3 where to open and nothing about how the shot was
            // MOVING — which is what made an extension re-perform the action
            // it was supposed to continue. The worker pins the tail of this
            // clip's own media and cuts the pinned window back off, so the
            // delivered length is unchanged. It costs one extra grid step of
            // sampling (~0.9s of frames) and applies on H3 + i2v only; the
            // handler falls back to the frame alone for anything else.
            ...(carryMotion && curAsset ? {
              context_asset_id: curAsset.id,
              // WHERE THE PREDECESSOR'S CONTENT ENDS, in source time. Its file
              // runs past the trim, and motion read from frames the viewer
              // never saw is the trim bug one layer along.
              context_end_ms: Math.round(fromAtMs + frameMs(curAsset)),
              // THE CLIP'S OWN LOOK. The worker re-renders these few seconds
              // through the same ffmpeg chain the timeline uses before handing
              // them to the motion-context node, so a flipped or cropped
              // predecessor pins the motion the viewer saw rather than the raw
              // media's. Sent rather than looked up: the clip's ops are a
              // browser row, and the worker only knows the ASSET.
              ...(asArray(clip.ops).length ? { context_ops: clip.ops } : {}),
            } : { motion_ctx: false }),
            duration_ms: durMs,
            // track_id/at_ms are deliberately NOT sent: handle_clip_gen ignores
            // them, and the clip is already placed on the lane above.
            //
            // `target.clip_id` is what makes the extension ARRIVE. The clip
            // above points at the extracted last frame — a still, so the
            // preview can only ever show a held picture — and until the
            // handler learned this key nothing repointed it: the render landed
            // in the library and the lane kept the placeholder for good. Same
            // late-bound shape image_gen uses for a bible sheet: the job
            // cannot know the asset id it is about to make, so it names the
            // row the result belongs on.
            target: { clip_id: placed.id },
          },
        });
      } else if (mode === "chain") {
        if (!nextClip) throw new Error("There is no next block to chain to");
        setPhase("Extracting both frames…");
        // In parallel: two independent seeks on two different files.
        const [fromFrame, toFrame] = await Promise.all([
          extractAndSaveClipFrame(clip, curAsset, "last"),
          extractAndSaveClipFrame(nextClip, nextAsset, "first"),
        ]);
        setPhase("Queueing…");

        const atMs = clip.t_start_ms + clip.duration_ms;
        const label = prompt.trim() ? `Chain: ${prompt.trim().slice(0, 20)}` : "Chain Transition";

        // NO ROOM IS MADE HERE ANY MORE. This used to shift every clip at or
        // after `atMs` right by `durMs` before inserting — not because the lane
        // needed the space (`insertAsset` packs it either way) but to break the
        // tie that `insertAsset` used to resolve the wrong way, which is why a
        // chain landed correctly while an extend of the same block did not.
        // The tie is fixed at the source now (laneInsert.ts), so this is a lane
        // full of redundant writes — and they sat OUTSIDE the insert's own undo
        // group (`{ undoable: false }`, before `txAsync` snapshots), so undoing
        // a chain left the lane shifted with a gap where the bridge had been.
        const placed = await store.insertAsset(fromFrame, clip.track_id, atMs, {
          label,
          durationMs: durMs,
        });

        // Enqueue FLF (First-Last Frame) AI video transition job. The anchors
        // are the BRIDGE's own first and last frames, which is why block A's
        // END frame is the `start` one.
        await enqueueJob({
          kind: plane.kind,
          lane: plane.lane,
          priority: 10,
          project_id: projectId ?? undefined,
          episode_id: store.timeline?.episode_id ?? undefined,
          model_id: modelId ?? undefined,
          payload: {
            mode: "flf",
            ...makeBlock(),
            label: `${model?.display_name ?? "video"} · chain ${clip.label ?? "clip"} → ${nextClip?.label ?? "next"}`,
            // Pruned again at submit: the picker's own guard cannot run while its
            // menu is shut, so a key the chosen model does not declare would
            // otherwise reach the payload and be dropped by the worker with only a
            // log line to show for it.
            ...(validLoras(model, loras).length ? { loras: validLoras(model, loras) } : {}),
            ...(plane.model_key ? { model_key: plane.model_key } : {}),
            ...(byokModel ? { byok_model: byokModel } : {}),
            ...dimsPayload,
            prompt: prompt.trim() || "Seamless motion transition connecting frame A to frame B",
            // Same rename as the extend path above — the handler reads
            // start_asset_id / end_asset_id.
            start_asset_id: fromFrame.id,
            end_asset_id: toFrame.id,
            duration_ms: durMs,
            // track_id/at_ms dropped: handle_clip_gen ignores them and the
            // transition clip is already inserted above. `target` is how the
            // bridge lands on it — see the extend branch above.
            target: { clip_id: placed.id },
          },
        });
      }

      onClose();
    } catch (err) {
      console.error("Error creating block action:", err);
      setError(err instanceof Error ? err.message : "Failed to create block action");
    } finally {
      setSubmitting(false);
      setPhase(null);
    }
  };

  const handlePickFromLibrary = async (pickedAsset: Asset, pickedLabel: string) => {
    const atMs = clip.t_start_ms + clip.duration_ms;
    const durMs = pickedAsset.duration_ms ?? framesToMs(grid, frameCount);

    await store.insertAsset(pickedAsset, clip.track_id, atMs, {
      label: pickedLabel || pickedAsset.b2_key.split("/").pop() || "Library Block",
      durationMs: durMs,
    });

    setPicker(null);
    onClose();
  };

  const modalTitle =
    mode === "add_after"
      ? "Add Block After"
      : mode === "extend"
      ? "Extend Block with Motion"
      : "Chain Blocks with AI Transition";

  return createPortal(
    <>
      {/* Declared rather than inherited: this modal opens the reference and
          library pickers, so which layer it sits on is a fact about it. */}
      <div className="ws-scrim" style={{ zIndex: Z_MODAL }} onClick={onClose}>
        <form onSubmit={handleSubmit} className="ws-modal block-action-modal" onClick={(e) => e.stopPropagation()}>
          <div className="ws-modal-head">
            <div className="ws-modal-ico">
              <Sparkles size={16} />
            </div>
            <div style={{ flex: 1 }}>
              <div className="ws-modal-t">{modalTitle}</div>
              <div className="ws-modal-c">{clip.label ?? "Block"} · {(clip.duration_ms / 1000).toFixed(1)}s</div>
            </div>
            <button type="button" className="ws-ghost" style={{ width: 34, height: 34, padding: 0, justifyContent: "center" }} onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <div className="ws-modal-body ns-scroll" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {error && (
                <div style={{
                  padding: "10px 14px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  background: "rgba(255, 80, 80, 0.12)", border: "1px solid rgba(255, 80, 80, 0.3)", color: "#ff6b6b",
                }}>{error}</div>
              )}

              {placeholders.length > 0 && (
                <div className="bam-warn">
                  {placeholders.length > 1
                    ? `${placeholders.join(" and ")} are stills, not shots, so the frames below are those whole pictures rather than moments in them.`
                    : `${placeholders[0]} is a still, not a shot, so the frame below is that whole picture rather than a moment in it.`}
                  {" "}If a render is still in flight, wait for it to land on the lane and reopen this.
                </div>
              )}

              {/* Image Previews */}
              {mode === "extend" && (
                <div className="bam-frame-box">
                  <div className="bam-frame-label">Last Frame of Current Block</div>
                  <div className="bam-frame-thumb">
                    <SourceFrame clip={clip} asset={curAsset} atMs={fromAtMs}
                                 alt={`Last frame of ${clip.label ?? "the current block"}`} />
                  </div>
                  <FrameStamp clip={clip} asset={curAsset} position="last" />
                </div>
              )}

              {mode === "chain" && (
                <div className="bam-frame-box">
                  <div className="bam-frame-label">Transition Context</div>
                  <div className="bam-dual-frames">
                    <div className="bam-frame-item">
                      <span>Frame A · End</span>
                      <SourceFrame clip={clip} asset={curAsset} atMs={fromAtMs}
                                   alt={`Last frame of ${clip.label ?? "block A"}`} />
                      <FrameStamp clip={clip} asset={curAsset} position="last" />
                    </div>
                    <ArrowRight size={18} style={{ color: "#5e6678", flexShrink: 0 }} />
                    <div className="bam-frame-item">
                      <span>Frame B · Start</span>
                      {nextClip && (
                        <SourceFrame clip={nextClip!} asset={nextAsset} atMs={toAtMs}
                                     alt={`First frame of ${nextClip.label ?? "block B"}`} />
                      )}
                      {nextClip && <FrameStamp clip={nextClip} asset={nextAsset} position="first" />}
                    </div>
                  </div>
                </div>
              )}

              {/* Prompt */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="bam-promptbar">
                  <label className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5e6678" }}>
                    Prompt
                  </label>
                  <span style={{ flex: 1 }} />
                  {preEnhance != null && (
                    <button type="button" className="bam-mini"
                            title="Put back what you typed"
                            onClick={() => { setPrompt(preEnhance); setPreEnhance(null); setNote(null); }}>
                      <Undo2 size={12} /> undo
                    </button>
                  )}
                  <button type="button" className="bam-mini on"
                          disabled={!prompt.trim() || enhancing}
                          title={guide.exact
                            ? `Rewrite this against the ${guide.label} prompt guide — this path sends the prompt to the model verbatim, so its shape is the format.`
                            : `${model?.display_name ?? "This model"} has no stored guide; general video craft is applied instead.`}
                          onClick={() => void enhance()}>
                    {enhancing ? <Loader2 size={12} className="spin" /> : <Wand2 size={12} />}
                    {enhancing ? "rewriting…" : "enhance"}
                  </button>
                </div>
                <textarea
                  className="ws-input"
                  rows={3}
                  placeholder={
                    mode === "add_after"
                      ? "Describe the visual action or scene for the new block…"
                      : mode === "extend"
                      ? "Describe how the action continues from the last frame…"
                      : "Describe the transition motion connecting Frame A to Frame B…"
                  }
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  autoFocus
                />
                {note && <span className="bam-note">{note}</span>}
                {mode !== "add_after" && (
                  <span className="bam-note">
                    Left blank, the render gets a generic continuation line.
                    {guide.format === "h3"
                      ? " On H3 the studio also closes the music channel, so the model does not invent a score or a voice-over."
                      : ""}
                  </span>
                )}
              </div>

              {/* REFERENCES — a new block only. An extend and a chain carry
                  their anchor FRAMES instead, and on the pod path those modes
                  have no reference input at all (addBlockRefs.ts says why),
                  so offering the control there would be offering a job that
                  stages the pictures and drops them. */}
              {mode === "add_after" && (
                <div className="bam-render">
                  <div className="bam-row bam-loras">
                    <label className="bam-lbl">References</label>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <RefTiles
                        refs={refs} cap={refCap} blocked={refsWhy}
                        onAdd={() => setPicker("refs")}
                        onRemove={(a) => setRefs((c) => c.filter((x) => x.id !== a.id))} />
                      <span className="bam-note">
                        {refsWhy
                          ? refsWhy
                          : refs.length
                          ? `${refs.length}/${refCap} · renders as r2v, and the prompt can name them Picture 1${refs.length > 1 ? `–${refs.length}` : ""}.`
                          : `${model?.display_name ?? "This model"} holds up to ${refCap} — faces, the location, a storyboard panel. Without any, the block renders from the text alone.`}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Model + length. One card, because the length's RANGE is the
                  model's: switching the picker moves the slider's ends. */}
              <div className="bam-render">
                <div className="bam-row">
                  <label className="bam-lbl">Video model</label>
                  {models == null ? (
                    <span className="bam-note"><Loader2 size={12} className="spin" /> loading…</span>
                  ) : models.length === 0 ? (
                    <span className="bam-note warn">
                      No model declares {MODE_FOR[mode]} — nothing here can render this.
                    </span>
                  ) : (
                    <Dropdown width={300}
                      trigger={({ toggle }) => (
                        <button type="button" className="bam-sel" onClick={toggle}>
                          <span>{model?.display_name ?? "Pick a model"}</span>
                          <ChevronDown size={13} style={{ flex: "none" }} />
                        </button>
                      )}>
                      {(close) => (
                        <>
                          {/* THE SHARED MENU, not a fourth copy of it.
                              This was a hand-rolled two-tier list — it knew
                              `cloud` and `local` and nothing else, so it could
                              not render a BYOK row at all, said nothing about
                              why a row was unpickable, and offered no way to
                              fix one. That is the same drift `BackendMenu`
                              was extracted to end: three copies is how the
                              wizard's picker never grew tiers. `noteFor` is
                              how this surface keeps the one thing that IS its
                              own — the model's grid and ceiling. */}
                          <TieredModelMenu
                            models={models} value={modelId}
                            onPick={setModelId} close={close}
                            noteFor={(m) => [
                              m.id === projectModelId ? "project default" : null,
                              tierOf(m) === "local" && !engine.ready ? "engine not running" : null,
                              // Only a DECLARED grid is quoted — see FrameGrid.exact.
                              // A hosted row declares none (its API takes
                              // seconds), so it says the fps and the ceiling
                              // and lets the provider round.
                              frameGrid(m).exact
                                ? `${m.frame_base}n+${m.frame_rem} @ ${m.fps ?? 24}fps`
                                : `${m.fps ?? 24}fps`,
                              `up to ${(framesToMs(frameGrid(m), frameGrid(m).maxFrames) / 1000).toFixed(1)}s`,
                            ].filter(Boolean).join(" · ")}
                          />
                        </>
                      )}
                    </Dropdown>
                  )}
                </div>

                {/* The project default is kept and NAMED when it cannot serve
                    this action — silently selecting something else is how you
                    end up wondering why a chain looks nothing like the rest of
                    the episode. */}
                {mode === "extend" && (
                  <label className="bam-row bam-check" title={
                    carryMotion
                      ? "The tail of this block is pinned as motion context, so the extension continues the movement instead of re-deciding it from a still."
                      : "The extension opens on the last frame and works out the motion for itself."}>
                    <input type="checkbox" checked={carryMotion}
                           onChange={(e) => setCarryMotion(e.target.checked)} />
                    <span>Continue the motion, not just the frame</span>
                    {carryMotion && tier === "cloud" && model
                      && !model.id.startsWith("h3") && (
                      <em className="bam-note warn" style={{ marginLeft: "auto" }}>
                        H3 only — {model.display_name} extends from the frame
                      </em>
                    )}
                  </label>
                )}

                {engineDown && (
                  <span className="bam-note warn">
                    {model?.display_name} runs on this machine and your local engine isn't
                    listening — start it from Setup, or pick a cloud model.
                  </span>
                )}

                {models && models.length > 0 && projectModelId && projectModelId !== modelId
                  && !models.some((m) => m.id === projectModelId) && (
                  <span className="bam-note warn">
                    This project's default model can't do {MODE_FOR[mode]}, so {model?.display_name} is selected.
                  </span>
                )}

                <div className="bam-row">
                  <label className="bam-lbl">Length</label>
                  <input
                    type="range"
                    className="bam-range"
                    min={grid.minFrames}
                    max={grid.maxFrames}
                    // One grid step per notch, so every position the slider can
                    // reach is a count the model will actually render. A free
                    // 0.5s slider snaps invisibly and quotes a length the file
                    // does not come back at.
                    step={grid.base}
                    value={frameCount}
                    disabled={!model}
                    onChange={(e) => setFrames(snapFrames(grid, +e.target.value, "round"))}
                  />
                  <span className="bam-dur mono">{(durMs / 1000).toFixed(2)}s</span>
                </div>
                {/* H3 renders exactly this length now — `handle_clip_gen` used
                    to clamp anything under 90f up to 3.75s and deliver THAT,
                    silently, while this control quoted the request back to two
                    decimals. The clamp is gone; what survives it is the reason
                    it existed, which is a quality judgement rather than a limit
                    the model enforces, so it is said instead of applied. */}
                {belowSpec && (
                  <span className="bam-note warn">
                    Under H3's documented 4–15s range. It renders exactly this
                    long — out of the model's trained distribution, so expect it
                    to look rougher than a full-length shot.
                  </span>
                )}
                {/* Adapters. Renders NOTHING when the model declares none, so
                    a row with no LoRAs shows no dead control. `LoraStack` is
                    the composer's own — it prunes picks the newly chosen model
                    does not declare, caps at the model's `maxLoras`, and marks
                    a `partial` adapter amber. */}
                {model && styleLoras(model).length > 0 && (
                  <div className="bam-row bam-loras">
                    <label className="bam-lbl">Adapters</label>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <LoraStack model={model} value={loras} onChange={setLoras} compact />
                      {loraFrom && loras.length > 0 && (
                        <span className="bam-note">
                          carried from {loraFrom} — an adapter this shot does not
                          share with the one before it is a visible break
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {model && (
                  <span className="bam-note">
                    {frameCount} frames at {grid.fps}fps · up to{" "}
                    {(framesToMs(grid, grid.maxFrames) / 1000).toFixed(1)}s on {model.display_name}
                    {grid.exact
                      ? ` · ${grid.base}n+${grid.rem}, so ${gridSteps(grid)} lengths are legal`
                      : " · this row declares no frame grid, so the length is rounded to the nearest it can render"}
                  </span>
                )}
              </div>
            </div>

            <div className="ws-modal-foot">
              <span className="sum" />
              <button type="button" className="ws-ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              {mode === "add_after" && (
                <button
                  type="button"
                  className="ws-ghost"
                  onClick={() => setPicker("take")}
                  disabled={submitting}
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                >
                  <FolderOpen size={14} /> From Library
                </button>
              )}
              <button
                type="submit"
                className="ws-primary"
                disabled={submitting}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="spin" /> {phase ?? "Generating…"}
                  </>
                ) : (
                  <>
                    <Sparkles size={14} /> Create Block
                  </>
                )}
              </button>
            </div>
        </form>
      </div>

      {picker && (
        <AssetPickerModal
          projectId={assets.get(clip.asset_id)?.project_id ?? store.timeline?.episode_id ?? null}
          title={picker === "refs"
            ? "Add a reference for the new block"
            : "Choose take for new block from library"}
          kindFilter={picker === "refs" ? "image" : "all"}
          defaultRole={picker === "refs" ? "look" : "take"}
          multi={picker === "refs"}
          used={picker === "refs" ? new Set(refs.map((r) => r.id)) : undefined}
          capacity={picker === "refs" ? refCap - refs.length : 1}
          onPick={(picks) => {
            if (picker === "refs") {
              // Trimmed again here: the picker's own capacity is a ceiling on
              // ONE visit, and the set survives a model switch to a smaller one.
              setRefs((cur) => [...cur, ...picks.map((p) => p.asset)
                .filter((a) => !cur.some((c) => c.id === a.id))].slice(0, refCap));
              setPicker(null);
              return;
            }
            if (picks[0]) void handlePickFromLibrary(picks[0].asset, picks[0].label);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>,
    document.body
  );
}


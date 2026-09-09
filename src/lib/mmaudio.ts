// The MMAudio decisions BOTH surfaces have to make, and the payload they both
// send. Twinned with `worker/mmaudio_spec.py` and pinned against it by
// `mmaudio.test.ts`, the way `mix.ts`/`mix.py` and `previewStrip.ts`/`strip.py`
// are.
//
// Two failures this file exists to prevent, and neither shows up as an error:
//
//  * THE MODAL QUOTES A LENGTH THE RENDER DOES NOT DELIVER. Kijai's node
//    truncates the requested duration to `frames / 25` whenever the staged
//    batch is short, so a soundtrack that stops before the picture is the
//    natural result of a UI that promises the clip's own length without
//    knowing the rule. The worker stages at 25fps precisely so that cannot
//    happen; this side says the same number so the two agree out loud.
//  * THE TWO SURFACES DRIFT. A "Change audio" popup on the timeline and a
//    Video → Audio tab in the studio rail are the same render with different
//    destinations — written twice, they end up sending different defaults and
//    the same clip sounds different depending on which screen you asked from.
import type { ModelCatalogRow } from "./db/types";

/** The node's own floor — below about a second there is not enough of a latent
 *  sequence for the flow matcher to say anything. */
export const MIN_SECONDS = 1.0;
/** v2 large was trained on 8-second videos, and the vendor's own Space says
 *  so on the page: "Using much longer or shorter videos will degrade
 *  performance. Around 5s~12s should be fine." A QUALITY band, not a limit —
 *  so it is reported as a note and never enforced as a clamp. */
export const TRAINED_SECONDS = 8.0;
export const BAND_LOW = 5.0;
export const BAND_HIGH = 12.0;
/** Synchformer's rate, and the rate the worker stages a batch at. */
export const SYNC_FPS = 25;
/** The CLIP semantic tower's rate. Only used to say how much of the shot it
 *  sees — see `clipCoverage`. */
export const CLIP_FPS = 8;

/** The vendor's own standard negative for a clean effects bed. Offered as the
 *  starting value rather than forced: "music, speech" is right for foley and
 *  wrong the moment somebody wants a radio playing in the room. */
export const DEFAULT_NEGATIVE = "music, speech, voices";

export const DEFAULT_MODEL_ID = "mmaudio-large-44k-v2-local";

const caps = (m?: ModelCatalogRow | null) =>
  ((m?.capabilities ?? {}) as Record<string, unknown>);
const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Payload milliseconds (invariant #3) -> the seconds the node wants. */
export function clampSeconds(ms: number, maxSeconds?: number | null): number {
  const cap = maxSeconds && maxSeconds > 0 ? maxSeconds : 30;
  return Math.max(MIN_SECONDS, Math.min(cap, (ms || 0) / 1000));
}

/** How many frames the staged batch must carry for `seconds` to survive.
 *  The node truncates to `total_frames / 25` when the batch is short. */
export function framesNeeded(seconds: number, fps = SYNC_FPS): number {
  return Math.max(1, Math.round(seconds * fps));
}

/** The FRACTION of the shot the CLIP semantic tower sees, 0..1.
 *
 *  The port slices one image batch twice — `[:8*duration]` for CLIP and
 *  `[:25*duration]` for Synchformer — so at the 25fps the length contract
 *  requires, CLIP reads the first 8/25 of the frames. Surfaced rather than
 *  hidden: it is why the text prompt matters more here than on a model that
 *  watched the whole clip, and why a sound whose source only appears late is
 *  worth naming in words. */
export function clipCoverage(fps = SYNC_FPS, clipFps = CLIP_FPS): number {
  if (fps <= 0 || clipFps <= 0) return 1;
  return Math.min(1, clipFps / fps);
}

/** A sentence about a length outside the trained band, or null. */
export function durationNote(
  seconds: number, trained = TRAINED_SECONDS,
  low = BAND_LOW, high = BAND_HIGH,
): string | null {
  if (seconds < low) {
    return `${seconds.toFixed(1)}s is under the ${low.toFixed(0)}s this model `
      + `reads best. It was trained on ${trained.toFixed(0)}-second videos, so `
      + `a very short clip tends to come back thin — render the sound long and `
      + `trim it, or describe it more concretely.`;
  }
  if (seconds > high) {
    return `${seconds.toFixed(1)}s is over the ${high.toFixed(0)}s this model `
      + `reads best. It was trained on ${trained.toFixed(0)}-second videos; `
      + `past about ${high.toFixed(0)}s sync drifts and the sound wanders. `
      + `Score the shot in pieces if it matters.`;
  }
  return null;
}

/** The recipe a row declares, with this file's defaults where it is silent. */
export interface V2aDefaults {
  steps: number;
  cfg: number;
  maxSeconds: number;
  trainedSeconds: number;
  syncFps: number;
  /** Whether a negative prompt can contribute at all. At cfg <= 1 the uncond
   *  branch is never evaluated, so a field there is a control that provably
   *  cannot change the render — the rule the SFX and image rows follow. */
  takesNegative: boolean;
}

export function v2aDefaults(model?: ModelCatalogRow | null): V2aDefaults {
  const c = caps(model);
  const cfg = num(c.cfg, 4.5);
  return {
    steps: num(c.steps, 25),
    cfg,
    maxSeconds: num(model?.max_seconds, 30),
    trainedSeconds: num(c.trainedSeconds, TRAINED_SECONDS),
    syncFps: num(c.syncFps, SYNC_FPS),
    takesNegative: c.negativePrompt !== false && cfg > 1,
  };
}

export interface V2aRequest {
  sourceAssetId: string;
  model?: ModelCatalogRow | null;
  /** The model_map key, i.e. `modelKeyOf(model.id)`.
   *
   *  Passed IN rather than derived here, and the reason is import-shaped
   *  rather than stylistic: `modelKeyOf` lives in `projectSettings`, which
   *  imports `./supabase` at module scope — so importing it would make this
   *  file unreachable from `node --test` and every rule below untested. Same
   *  split as `panelSpec.ts` (pure, tested) against `panels.ts` (reaches the
   *  database). `mmaudio.test.ts` pins the id -> key translation against
   *  `projectSettings.ts`'s own source instead.
   *
   *  Optional because `modelKeyOf` is: it returns undefined for a DESKTOP row
   *  (`local:` ids name a checkpoint model_map has never heard of), and its
   *  documented contract is to DROP the key rather than send one the pod
   *  cannot resolve. Nothing local renders MMAudio today, so this is that
   *  contract honoured rather than a case anyone reaches.
   */
  modelKey?: string;
  prompt: string;
  negative?: string;
  durationMs: number;
  steps?: number;
  cfg?: number;
  /** -1 (or undefined) rolls. A v2a render is not deterministic across seeds,
   *  so a fresh roll is what "try again" means — the same reason the panel
   *  redraw had to start writing one. */
  seed?: number;
  maskAwayClip?: boolean;
  projectId?: string | null;
  /** Set to publish the result as a new TAKE of this block instead of as a
   *  library asset. */
  blockId?: string | null;
  /** Provenance only — which take's video was scored. */
  takeId?: string | null;
  /** "replace" makes the new take active. Defaults to replace on the block
   *  path: the user asked for the shot to sound different, so the different
   *  one should play, and history keeps the old takes either way. */
  activate?: "replace" | "review";
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

/** The `v2a_gen` payload. ONE builder so the studio tab and the timeline popup
 *  cannot disagree about what they send. */
export function v2aPayload(req: V2aRequest): Record<string, unknown> {
  const d = v2aDefaults(req.model);
  const seconds = clampSeconds(req.durationMs, d.maxSeconds);
  const negative = d.takesNegative ? (req.negative ?? "").trim() : "";
  const p: Record<string, unknown> = {
    source_asset_id: req.sourceAssetId,
    prompt: (req.prompt ?? "").trim(),
    duration_ms: Math.round(seconds * 1000),
    steps: Math.max(1, Math.round(req.steps ?? d.steps)),
    cfg: req.cfg ?? d.cfg,
    seed: req.seed === undefined || req.seed < 0 ? randomSeed() : req.seed,
  };
  // Omitted rather than sent empty: the worker falls back to the entry's own
  // value for a key it does not receive, and `""` would mean "no negative"
  // where the row declares one. Same rule GenComposer follows.
  if (req.modelKey) p.model_key = req.modelKey;
  if (negative) p.negative = negative;
  if (req.maskAwayClip) p.mask_away_clip = true;
  if (req.projectId) p.project_id = req.projectId;
  if (req.blockId) {
    p.block_id = req.blockId;
    p.activate = req.activate ?? "replace";
    if (req.takeId) p.take_id = req.takeId;
  }
  return p;
}

/** A one-line label for the queue row, so a `v2a_gen` in the popover says what
 *  it is rather than only its kind. */
export function v2aLabel(req: { blockLabel?: string | null; prompt: string }): string {
  const head = req.blockLabel ? `${req.blockLabel} audio` : "Video → audio";
  const tail = (req.prompt || "").trim().replace(/\s+/g, " ").slice(0, 60);
  return tail ? `${head} · ${tail}` : head;
}

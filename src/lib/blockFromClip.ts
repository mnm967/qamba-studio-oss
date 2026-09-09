// "SAVE AS NEW BLOCK" — what the timeline sends, and when it refuses to.
//
// The pure half of the action behind the block context menu's Save as new
// block. Split out for the reason `clipAttach.ts` and `blockSync.ts` are: the
// enqueue reaches Supabase and the render reaches the pod, and the part that
// decides WHICH FRAMES the new block contains is the part that fails
// silently. A window computed one frame wide of the trim still cuts, still
// registers, still lands on the lane — it is simply not the shot the user was
// looking at when they pressed the button.
//
// What the feature is: a block clip on the lane points at a `generation_blocks`
// row and at that block's active take, which is the WHOLE render. Trim it and
// the lane shows a window of that take while the block still describes all of
// it — so the trim lives in the cut and nowhere else. `assemble_cut`
// concatenates take assets whole, a new take repoints the media under the
// clip, and a re-plan rewrites the block. Save as new block ends that: the
// window is cut to its own asset, that asset becomes a NEW block's active
// take, and the clip repoints at the new block. The trim is the block now.
import { asArray } from "./jsonb.ts";
import { isStill } from "./assetKind.ts";
import type { Asset, Clip } from "./db/types";

/** Below this a block is not a shot. It is also the floor `blockSync` clamps
 *  to, for the same reason: a zero-length row is unselectable, so there would
 *  be no way to undo it by hand. */
export const MIN_BLOCK_MS = 200;

export interface SourceWindow {
  /** Source-media ms the new block's take starts at. */
  in_ms: number;
  /** Source-media ms it ends at — the CUT, i.e. the first instant the clip is
   *  no longer on screen, which is what ffmpeg's `-to` wants. */
  out_ms: number;
  duration_ms: number;
}

/**
 * The window of the source media this clip is showing.
 *
 * `out_ms` is deliberately NOT read off the clip, for the reason
 * `clipSourceMs` states at length: it agrees with `in_ms + duration_ms` after
 * every trim gesture and DISAGREES after `_attach_to_clip`, which writes the
 * whole render's length into `out_ms` while only ever shrinking
 * `duration_ms`. There the played window is the shorter one and `out_ms`
 * names frames nobody sees. The played window is the honest answer, and it is
 * the one the user is looking at.
 *
 * `rate` is not applied because a clip carrying ops never gets this far
 * (`blockFromClipBlocker` refuses it) — stated here so that a future op that
 * IS allowed cannot quietly inherit a 1:1 mapping that no longer holds.
 */
export function sourceWindow(
  clip: Pick<Clip, "in_ms" | "duration_ms">,
  asset?: Pick<Asset, "duration_ms"> | null,
): SourceWindow {
  const inMs = Math.max(0, Math.round(clip.in_ms ?? 0));
  let outMs = inMs + Math.max(0, Math.round(clip.duration_ms ?? 0));
  // Clamp to the media, but only when something has measured it. An uploaded
  // take registers before `asset_ingest` probes it, and clamping against a
  // length nobody knows would cut the block to the floor for no reason.
  const media = asset?.duration_ms;
  if (typeof media === "number" && Number.isFinite(media) && media > 0) {
    outMs = Math.min(outMs, Math.round(media));
  }
  return { in_ms: inMs, out_ms: outMs, duration_ms: Math.max(0, outMs - inMs) };
}

/** Human names for the ops, so a refusal can say which one is in the way. */
const OP_NAMES: Record<string, string> = {
  speed: "speed", reverse: "reverse", crop: "crop", transform: "transform",
  flip: "flip", freeze: "freeze",
};

/**
 * Why this clip cannot become a block, or null when it can.
 *
 * Returned as a SENTENCE rather than a boolean because every caller shows it:
 * the menu item is disabled with this as its tooltip and the action reports it
 * if the state changed underneath. A disabled control with no reason is the
 * thing this codebase keeps replacing.
 */
export function blockFromClipBlocker(
  clip: Pick<Clip, "block_id" | "in_ms" | "duration_ms" | "ops" | "asset_id">,
  asset?: Asset | null,
): string | null {
  // A BLOCKLESS clip is allowed: the worker PROMOTES it into the storyboard
  // (beside the nearest lane block, or appended to the newest board), which
  // is what puts a landed extend/chain — or imported media — into the takes
  // system. The refusals below still apply to it.
  // A block clip whose media is a STILL is a placeholder whose render has not
  // landed yet — the timeline's own generate actions park an extracted frame
  // on the lane while the GPU works. Cutting a window out of a JPEG produces a
  // block whose take is one frame. `isStill` rather than a kind test of its
  // own, so this agrees with what the PLAYER thinks it is holding.
  if (asset && isStill(asset)) {
    return "This clip is still showing a placeholder frame — wait for its render to land.";
  }
  // OPS ARE REFUSED RATHER THAN IGNORED. A block's take IS the block's
  // content: `assemble_cut` concatenates take assets whole, so a take that
  // ignores the crop, the speed or the reverse you applied is a block that
  // plays differently from the lane it was made from, with nothing saying so.
  // Baking them is `clip_render`'s job and a different feature.
  const ops = asArray<{ op?: string }>(clip.ops)
    .map((o) => OP_NAMES[String(o?.op ?? "")] ?? null)
    .filter(Boolean) as string[];
  if (ops.length) {
    const list = [...new Set(ops)].join(", ");
    return `This clip carries timeline effects (${list}). A block's take is the block's `
      + "content, so it cannot be cut from media those effects have not been applied to — "
      + "remove them, or flatten the clip first.";
  }
  const win = sourceWindow(clip, asset);
  if (win.duration_ms < MIN_BLOCK_MS) {
    return `This clip is only ${win.duration_ms}ms long — too short to be a block.`;
  }
  return null;
}

export interface BlockFromClipRequest {
  clip_id: string;
  /** null promotes a BLOCKLESS clip — the worker derives the storyboard from
   *  `after_block_id`, or appends to the episode's newest board. */
  block_id: string | null;
  /** Placement for a promotion: the nearest lane block, chosen by the caller
   *  looking at the lane. Ignored when `block_id` is set. */
  after_block_id?: string | null;
  asset_id: string;
  in_ms: number;
  out_ms: number;
  label: string;
  /** Put the new block at the END of the storyboard instead of straight after
   *  its anchor. Placement only — a source block still lends its beats,
   *  scenes and params.
   *
   *  Offered because neither answer is free. Inserting keeps story order and
   *  renumbers every following block, which is what makes a save LOOK like it
   *  duplicated a shot: a clip's label is a stored snapshot of `idx`, so all
   *  of them go stale at once. Appending renumbers nobody and costs story
   *  order — `assemble_cut` orders by idx, so the shot renders at the end of
   *  the episode until it is moved. */
  append?: boolean;
}

/**
 * The payload for a `block_from_clip` job.
 *
 * The WINDOW travels explicitly rather than being re-read from the clip on the
 * pod, and that is the decision worth keeping. The user pressed the button
 * looking at a particular trim; between the enqueue and the claim they may
 * drag the handles again, and a worker that re-derived the window would
 * silently save a different shot than the one that was asked for.
 */
export function blockFromClipPayload(
  clip: Pick<Clip, "id" | "block_id" | "asset_id" | "in_ms" | "duration_ms" | "ops" | "label">,
  asset?: Asset | null,
  opts: { afterBlockId?: string | null; append?: boolean } = {},
): BlockFromClipRequest {
  const blocked = blockFromClipBlocker(clip, asset);
  if (blocked) throw new Error(blocked);
  const win = sourceWindow(clip, asset);
  return {
    clip_id: clip.id,
    block_id: clip.block_id ?? null,
    ...(clip.block_id ? {} : { after_block_id: opts.afterBlockId ?? null }),
    asset_id: clip.asset_id,
    in_ms: win.in_ms,
    out_ms: win.out_ms,
    label: `${clip.label ?? "block"} → new block`,
    // Sent only when asked for, so a worker that predates it behaves exactly
    // as it always did rather than reading a key it does not know.
    ...(opts.append ? { append: true } : {}),
  };
}

/**
 * The lane block a BLOCKLESS clip sits beside — where a promotion or a
 * generate-time block lands in the storyboard.
 *
 * Nearest PRECEDING clip that carries a block (any lane: a detached audio
 * half shares its picture's block, so it answers the same), else the nearest
 * following one. Chosen in the browser rather than derived on the pod because
 * the store already holds the lane the user is looking at — and, like the
 * window, it is a fact about the moment the button was pressed.
 */
export function nearestLaneBlockId(
  clips: readonly Pick<Clip, "id" | "block_id" | "t_start_ms">[],
  clip: Pick<Clip, "id" | "t_start_ms">,
): string | null {
  const withBlock = clips
    .filter((c) => c.id !== clip.id && c.block_id)
    .sort((a, b) => a.t_start_ms - b.t_start_ms);
  if (!withBlock.length) return null;
  const before = [...withBlock].reverse().find((c) => c.t_start_ms <= clip.t_start_ms);
  return (before ?? withBlock[0]).block_id as string;
}

/**
 * The re-runnable recipe a CLIP-BORN block carries (`params.clip_gen`,
 * written by the worker's `_publish_clip_block`). Its presence is what routes
 * a retake away from the beats path: such a block has no beats to compile, so
 * `master_pass` replays this instead — and the retake UI edits THIS prompt,
 * never a brief.
 */
export interface ClipGenRecipe {
  prompt: string;
  mode?: string;
  model_key?: string;
  duration_ms?: number;
  seed?: number;
  loras?: unknown[];
  [k: string]: unknown;
}

export function clipGenRecipe(params: unknown): ClipGenRecipe | null {
  const r = (params as { clip_gen?: unknown } | null | undefined)?.clip_gen;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const prompt = (r as { prompt?: unknown }).prompt;
  return typeof prompt === "string" && prompt.trim() ? (r as ClipGenRecipe) : null;
}

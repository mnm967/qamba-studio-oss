// DRAWING A CLIP'S FRAME WITH ITS OPS APPLIED — the geometry the frame
// extractor needs, in PIXELS rather than CSS.
//
// `clipCrop.ts` answers the same question for the preview, where the answer is
// a `transform` and a `clip-path` on an element that fills the stage. A canvas
// has no element to style: it needs a source rectangle, a destination size and
// a mirror, so this is that shape. It reuses clipCrop's `cropOf`/`clampCrop`
// deliberately — the ffmpeg-exact crop clamp must not exist twice.
//
// Why it matters at all: `extractAndSaveClipFrame` drew the raw video into a
// canvas, so a clip with `flip h` on it — which is a thing the Transform panel
// puts there in one click — extracted an UNMIRRORED frame. That frame is not
// only the modal's thumbnail: it is `start_asset_id`, the picture the
// generated extend or chain OPENS ON. So the bridge opened on a mirror image
// of the shot preceding it, i.e. a hard flip at the cut, and the thumbnail
// agreed with the render rather than with the timeline, which is the one place
// you would look to catch it.
import { clampCrop, cropOf, sourceBox, type Box, type Rect } from "./clipCrop.ts";
import { asArray } from "./jsonb.ts";
import type { Asset, Clip, ClipOp } from "./db/types";

export interface RasterPlan {
  /** The rectangle to take OUT of the source media. */
  src: Rect;
  /** The size to draw it AT. Differs from `src` only under a scale. */
  out: Box;
  flipH: boolean;
  flipV: boolean;
  /** Degrees clockwise, applied about the centre. */
  rotate: number;
  /** Whether a crop op narrowed the source rect. Tracked rather than derived:
   *  a crop that happens to cover the whole frame is still a crop, and the
   *  scale factor makes `src` vs `out` say nothing about it. */
  cropped: boolean;
  /** Whether anything at all has to be done — a fast path for the common
   *  clip, which carries no visual ops and can be drawn straight. */
  plain: boolean;
}

/** Mirror parity per axis. Two `flip h` ops are the identity, and the crop
 *  window has to agree with that or it lands on the wrong half of the
 *  picture — the same rule `clipCrop.mirrors` states for the preview. */
function mirrorParity(ops: ClipOp[]) {
  let x = 0, y = 0;
  for (const o of ops) {
    if (o.op !== "flip") continue;
    if ((o as { dir?: string }).dir === "v") y++; else x++;
  }
  return { flipH: x % 2 === 1, flipV: y % 2 === 1 };
}

/**
 * How to draw one frame of `clip` from `asset` with its ops applied.
 *
 * Covers the three ops that change the PICTURE. `speed` and `reverse` change
 * WHICH frame and are already handled by `clipSourceMs`; `freeze` is timing
 * only.
 *
 * TWO DELIBERATE DEPARTURES from `build_clip_filter`:
 *
 *  * `_fit` is NOT applied. The renderer normalises every clip to the
 *    timeline's frame with `scale=…:force_original_aspect_ratio=decrease` plus
 *    a `pad`, which letterboxes. An extracted frame is a GENERATION ANCHOR,
 *    handed to a model that stages and sizes it itself — baking black bars
 *    into it would put them in the rendered video.
 *  * A `transform`'s ROTATE is applied about the centre and the result is kept
 *    whole. ffmpeg expands the canvas (`ow=rotw`, `oh=roth`) and then crops
 *    back to the TIMELINE's frame around `tx`/`ty`, which needs a render size
 *    this function is not given and which the preview does not do either. Said
 *    here rather than approximated silently: a rotated clip's anchor matches
 *    the stage, not the delivered pixel grid.
 */
export function rasterPlan(clip: Pick<Clip, "ops">, asset?: Asset | null): RasterPlan {
  const ops = asArray<ClipOp>(clip.ops);
  const box = sourceBox(asset ?? undefined);
  const { flipH, flipV } = mirrorParity(ops);

  const raw = cropOf(ops);
  const rect = raw && box.w > 0 && box.h > 0 ? clampCrop(raw, box) : null;
  const src: Rect = rect ?? { x: 0, y: 0, w: box.w, h: box.h };

  let scale = 1, rotate = 0;
  for (const o of ops) {
    if (o.op !== "transform") continue;
    const t = o as { scale?: number; rotate?: number };
    if (typeof t.scale === "number" && Number.isFinite(t.scale) && t.scale > 0) scale *= t.scale;
    if (typeof t.rotate === "number" && Number.isFinite(t.rotate)) rotate += t.rotate;
  }
  rotate = ((rotate % 360) + 360) % 360;

  const out: Box = {
    w: Math.max(1, Math.round(src.w * scale)),
    h: Math.max(1, Math.round(src.h * scale)),
  };
  const plain = !flipH && !flipV && rotate === 0 && scale === 1 && !rect;
  return { src, out, flipH, flipV, rotate, cropped: !!rect, plain };
}

/** A one-line record of what was applied, for the asset's own meta. An anchor
 *  that looks wrong is otherwise indistinguishable from a bad extract. */
export function describePlan(p: RasterPlan): string | null {
  if (p.plain) return null;
  const parts: string[] = [];
  if (p.flipH) parts.push("flip h");
  if (p.flipV) parts.push("flip v");
  if (p.rotate) parts.push(`rotate ${p.rotate}°`);
  if (p.out.w !== p.src.w) parts.push(`scale ${(p.out.w / p.src.w).toFixed(2)}x`);
  if (p.cropped) parts.push(`crop ${p.src.w}x${p.src.h}+${p.src.x}+${p.src.y}`);
  return parts.join(" · ") || null;
}

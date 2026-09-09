// THE CROP OP, PREVIEWED AS THE RENDER WILL DELIVER IT.
//
// Crop was the one picture op with no feedback loop. `PreviewPlayer`'s
// `opsTransform` showed flip and transform and left crop to the worker — its
// own comment said so ("crop, reverse, freeze are render-only"; reverse has
// since been given a preview of its own, see scrubTo) — so pressing
// a preset wrote a real op, hashed it into the clip cache, marked the timeline
// stale, and changed NOTHING on the stage except a mono readout line. From the
// outside that is a dead button: the only way to find out whether the crop had
// landed was to flatten the timeline minutes later on a $3.36/hr box.
//
// So this is the `src/lib/mix.ts` situation one op over — two engines have to
// agree about one geometry, and the engine that cannot be checked by looking
// is the render. The arithmetic here is pinned against the worker's own chain
// (`worker/handlers/render.py`, `build_clip_filter` + `_fit`):
//
//     crop=w:h:x:y ,
//     scale=W:H:force_original_aspect_ratio=decrease ,
//     pad=W:H:(ow-iw)/2:(oh-ih)/2
//
// Read that in order and the delivered frame is: the window, scaled to FIT the
// timeline's own frame, centred, with black filling the rest. A 1:1 crop on a
// 16:9 timeline is a PILLARBOXED SQUARE in the file — not a zoom that fills
// the frame — and the preview now says so instead of showing a full-width
// picture the render will not produce.
import { asArray } from "./jsonb.ts";
import type { Clip, ClipOp } from "./db/types";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Box { w: number; h: number }

/** Source dimensions assumed for an asset row that records none.
 *
 *  Shared with the picker (InspectorRail's CROP_PRESETS) deliberately rather
 *  than repeated: the STORED rect is computed against these numbers, so a
 *  preview assuming anything else would draw a window the render does not
 *  cut — and the two would drift apart the day one of them was tuned. */
export const FALLBACK_SRC: Box = { w: 1280, h: 720 };

type CropOp = Extract<ClipOp, { op: "crop" }>;
type FlipOp = Extract<ClipOp, { op: "flip" }>;

/** The media a clip plays, as the crop arithmetic needs it. */
export function sourceBox(a: { width?: number | null; height?: number | null } | undefined): Box {
  const w = a?.width ?? 0, h = a?.height ?? 0;
  return w > 0 && h > 0 ? { w, h } : FALLBACK_SRC;
}

/** The crop op a clip carries, if any. */
export function cropOf(ops: Clip["ops"]): Rect | null {
  const op = asArray<ClipOp>(ops).find((o): o is CropOp => o?.op === "crop");
  if (!op) return null;
  const r = { x: Number(op.x), y: Number(op.y), w: Number(op.w), h: Number(op.h) };
  return Object.values(r).every(Number.isFinite) ? r : null;
}

/** The window ffmpeg will ACTUALLY cut.
 *
 *  `vf_crop` refuses a region bigger than its input — it errors
 *  ("Invalid too big or non positive size") rather than clamping the size —
 *  and clamps only the offset. A clip repointed at a smaller take is exactly
 *  that case: `blockSync`'s take swap patches `asset_id` and keeps the ops, so
 *  a rect written against 1280x704 outlives the render it was drawn on. The
 *  worker clamps in ffmpeg's own expression language; this is the same
 *  arithmetic, so the stage shows the window the file will contain rather than
 *  one it cannot. */
export function clampCrop(r: Rect, src: Box): Rect | null {
  const w = Math.min(Math.round(r.w), src.w);
  const h = Math.min(Math.round(r.h), src.h);
  if (w <= 0 || h <= 0) return null;
  return {
    w, h,
    x: Math.min(Math.max(0, Math.round(r.x)), src.w - w),
    y: Math.min(Math.max(0, Math.round(r.y)), src.h - h),
  };
}

/** Largest rect of `aspect` fitting inside `box` — ffmpeg's
 *  `force_original_aspect_ratio=decrease`, which is what makes a crop
 *  letterbox rather than fill. */
function fitted(aspect: number, box: Box): Box {
  const h = Math.min(box.w / aspect, box.h);
  return { w: h * aspect, h };
}

/** How many times each axis is mirrored. Parity, not presence: two `flip h`
 *  ops are the identity, and the clip window has to agree with the transform
 *  about that or it lands on the wrong half of the picture. */
function mirrors(ops: ClipOp[]) {
  let x = 0, y = 0;
  for (const o of ops) {
    if (o.op !== "flip") continue;
    if ((o as FlipOp).dir === "v") y++; else x++;
  }
  return { x: x % 2 === 1, y: y % 2 === 1 };
}

/** CSS transform for the ops that need no geometry — flip and transform, in
 *  stored order. Unchanged from PreviewPlayer's original `opsTransform`; it
 *  moved here so every op that paints a layer is decided (and tested) in one
 *  place instead of half in a component. */
export function opsTransform(ops: ClipOp[]): string {
  let t = "";
  for (const o of ops) {
    if (o.op === "flip") t += (o as FlipOp).dir === "v" ? " scaleY(-1)" : " scaleX(-1)";
    if (o.op === "transform") {
      const { scale = 1, tx = 0, ty = 0 } = o as { scale?: number; tx?: number; ty?: number };
      t += ` translate(${tx}px, ${ty}px) scale(${scale})`;
    }
  }
  return t.trim();
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

export interface LayerStyle { transform?: string; clipPath?: string }

/** The style for one preview layer.
 *
 *  `box` is the STAGE in CSS px. The layer element fills it (`.pv-layer` is
 *  `inset: 0` at 100%/100%) and `object-fit: contain` letterboxes the picture
 *  inside, so the picture's own rect is derivable from the box and the media's
 *  dimensions — one measurement, no second observer, and no wrapper element
 *  (`.tl-preview video, .tl-preview img` is a DESCENDANT selector, so a nested
 *  media element would still be forced to `inset: 0; max-width: 100%` and the
 *  layout would silently collapse).
 *
 *  A zero box means "not measured yet": the crop is skipped for that one frame
 *  rather than divided by. */
export function layerStyle(ops: Clip["ops"], src: Box, box: Box): LayerStyle {
  const list = asArray<ClipOp>(ops);
  const inner = opsTransform(list);
  const raw = cropOf(list);
  const rect = raw && src.w > 0 && src.h > 0 ? clampCrop(raw, src) : null;
  if (!rect || box.w <= 0 || box.h <= 0) return inner ? { transform: inner } : {};

  const pic = fitted(src.w / src.h, box);   // the picture inside the layer
  const sp = pic.w / src.w;                 // source px -> css px
  const out = fitted(rect.w / rect.h, box); // where the window lands on stage
  const k = out.w / (rect.w * sp);

  // The clip window is stated in the element's OWN (pre-transform) space, so a
  // flip has to be undone in it: `transform` mirrors the already-clipped
  // result, while ffmpeg's [flip, crop] takes its window off the picture the
  // flip produced. Mirroring the rect here and letting the flip carry it back
  // is what makes those the same window.
  const m = mirrors(list);
  const cx = m.x ? src.w - rect.x - rect.w : rect.x;
  const cy = m.y ? src.h - rect.y - rect.h : rect.y;
  const left = (box.w - pic.w) / 2 + cx * sp;
  const top = (box.h - pic.h) / 2 + cy * sp;
  const clipPath = `inset(${px(top)} ${px(box.w - left - rect.w * sp)} `
    + `${px(box.h - top - rect.h * sp)} ${px(left)})`;

  // Centre the window on the stage. `scale(k) translate(-d)` composes
  // right-to-left, so the pre-scale shift lands the window's centre on the
  // element's centre — which is the transform-origin — and the scale then
  // grows it about that point, exactly filling one axis of the stage.
  const dx = (box.w - pic.w) / 2 + (rect.x + rect.w / 2) * sp - box.w / 2;
  const dy = (box.h - pic.h) / 2 + (rect.y + rect.h / 2) * sp - box.h / 2;
  const transform = `scale(${Math.round(k * 10000) / 10000}) `
    + `translate(${px(-dx)}, ${px(-dy)})` + (inner ? ` ${inner}` : "");
  return { transform, clipPath };
}

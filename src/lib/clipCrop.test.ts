// The crop preview has to agree with ffmpeg, and only one of the two can be
// checked by looking. So the tests do not assert the CSS strings — they PARSE
// them back into an on-screen rect and compare that against an independent
// reading of the worker's own filter chain (crop -> scale decrease -> pad
// centre). A preview that merely "looks cropped" while the render letterboxes
// differently is the divergence this file exists to catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_SRC, clampCrop, cropOf, layerStyle, opsTransform, sourceBox,
} from "./clipCrop.ts";
import type { Box, LayerStyle, Rect } from "./clipCrop.ts";
import type { Clip, ClipOp } from "./db/types";

const ops = (...o: ClipOp[]) => o as Clip["ops"];
const crop = (x: number, y: number, w: number, h: number): ClipOp =>
  ({ op: "crop", x, y, w, h });

/** What ffmpeg delivers: `scale=W:H:force_original_aspect_ratio=decrease`
 *  then `pad=W:H:(ow-iw)/2:(oh-ih)/2` — the window at its own aspect, as big
 *  as fits, centred, black elsewhere. Written out longhand here on purpose:
 *  sharing the module's own `fitted()` would make the test agree with a bug. */
function ffmpegDelivers(cropRect: Rect, box: Box) {
  const k = Math.min(box.w / cropRect.w, box.h / cropRect.h);
  const w = cropRect.w * k, h = cropRect.h * k;
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
}

/** Undo the CSS: where does the clipped window land on the stage? */
function onScreen(style: LayerStyle, box: Box) {
  const ins = /inset\(([-\d.]+)px ([-\d.]+)px ([-\d.]+)px ([-\d.]+)px\)/.exec(style.clipPath!);
  assert.ok(ins, `no parsable clip-path in ${style.clipPath}`);
  const [top, right, bottom, left] = ins.slice(1, 5).map(Number);
  const local = { x: left, y: top, w: box.w - left - right, h: box.h - top - bottom };

  const m = /^scale\(([-\d.]+)\) translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(style.transform!);
  assert.ok(m, `no parsable transform in ${style.transform}`);
  const [k, tx, ty] = m.slice(1, 4).map(Number);
  // `scale(k) translate(t)` composes right-to-left about the element centre:
  // a point p lands at C + k*((p - C) + t).
  const at = (p: number, c: number, t: number) => c + k * (p - c + t);
  return {
    x: at(local.x, box.w / 2, tx), y: at(local.y, box.h / 2, ty),
    w: local.w * k, h: local.h * k, local,
  };
}

const near = (a: number, b: number, msg: string, tol = 0.02) =>
  assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

test("a 1:1 crop lands pillarboxed, exactly where ffmpeg pads it", () => {
  const src = { w: 1280, h: 704 };
  const box = { w: 960, h: 528 };           // same aspect as the media
  const rect = { x: 288, y: 0, w: 704, h: 704 };   // the 1:1 preset, verbatim
  const got = onScreen(layerStyle(ops(crop(288, 0, 704, 704)), src, box), box);
  const want = ffmpegDelivers(rect, box);
  near(got.w, want.w, "width"); near(got.h, want.h, "height");
  near(got.x, want.x, "x"); near(got.y, want.y, "y");
  // The whole point of the letterbox: it does NOT fill the stage sideways.
  assert.ok(got.w < box.w - 1, "a square crop must not fill a wide stage");
  near(got.h, box.h, "a square crop fills the stage vertically");
});

test("the window is the region asked for, not the middle of the frame", () => {
  // An off-centre crop must move. The failure this catches is a preview that
  // zooms by the right factor and shows the wrong part of the picture.
  const src = { w: 1000, h: 500 }, box = { w: 1000, h: 500 };
  const centred = onScreen(layerStyle(ops(crop(400, 200, 200, 100)), src, box), box);
  const corner = onScreen(layerStyle(ops(crop(0, 0, 200, 100)), src, box), box);
  near(centred.local.x, 400, "centre window sits at its own x");
  near(corner.local.x, 0, "corner window sits at its own x");
  // Both are scaled and centred identically — only the source region differs.
  near(centred.x, corner.x, "both land centred on stage");
  near(centred.w, box.w, "a 2:1 window fills a 2:1 stage");
});

test("every preset aspect fits the stage on one axis and no more", () => {
  const src = { w: 1280, h: 704 }, box = { w: 800, h: 450 };
  for (const [w, h] of [[1280, 720], [1280, 960], [704, 704], [396, 704]]) {
    const r = { x: Math.round((src.w - Math.min(w, src.w)) / 2), y: 0,
                w: Math.min(w, src.w), h: Math.min(h, src.h) };
    const got = onScreen(layerStyle(ops(crop(r.x, r.y, r.w, r.h)), src, box), box);
    const want = ffmpegDelivers(r, box);
    near(got.w, want.w, `${w}x${h} width`); near(got.h, want.h, `${w}x${h} height`);
    assert.ok(got.w <= box.w + 0.02 && got.h <= box.h + 0.02, `${w}x${h} overflows the stage`);
  }
});

test("a stage that is not the media's aspect still lands the window right", () => {
  // The layer is `object-fit: contain`, so the picture is already letterboxed
  // inside the element before the crop is applied — the offset that hides is
  // the one that forgets it.
  const src = { w: 1280, h: 704 };
  const box = { w: 600, h: 600 };                 // square stage, wide media
  const rect = { x: 0, y: 0, w: 640, h: 704 };
  const got = onScreen(layerStyle(ops(crop(0, 0, 640, 704)), src, box), box);
  const want = ffmpegDelivers(rect, box);
  near(got.w, want.w, "width"); near(got.h, want.h, "height");
  near(got.x, want.x, "x"); near(got.y, want.y, "y");
});

test("a crop bigger than the media is clamped, not sent as an ffmpeg error", () => {
  // vf_crop REFUSES an oversized region; a take swap keeps the ops and can
  // shrink the media under them.
  assert.deepEqual(clampCrop({ x: 288, y: 0, w: 704, h: 704 }, { w: 864, h: 480 }),
                   { x: 160, y: 0, w: 704, h: 480 });  // ffmpeg's own x = min(x, iw - w)
  assert.deepEqual(clampCrop({ x: 900, y: 900, w: 100, h: 100 }, { w: 640, h: 360 }),
                   { x: 540, y: 260, w: 100, h: 100 });
  assert.equal(clampCrop({ x: 0, y: 0, w: 0, h: 100 }, { w: 640, h: 360 }), null);
});

test("a flip mirrors the window as well as the picture", () => {
  // ffmpeg applies [flip, crop] in order: the window is taken off the FLIPPED
  // picture. In CSS the clip is stated before the transform, so the rect has
  // to be mirrored there and carried back by the flip — otherwise a flipped
  // clip crops the opposite side of the shot.
  const src = { w: 1000, h: 500 }, box = { w: 1000, h: 500 };
  const plain = onScreen(layerStyle(ops(crop(0, 0, 200, 100)), src, box), box);
  const flipped = onScreen(layerStyle(ops({ op: "flip", dir: "h" }, crop(0, 0, 200, 100)), src, box), box);
  near(plain.local.x, 0, "unflipped window at the left edge");
  near(flipped.local.x, 800, "flipped window mirrored to the right edge");
  near(flipped.w, plain.w, "the delivered size is unchanged by a flip");
  // Two flips on one axis are the identity, so the window must not move.
  const twice = onScreen(
    layerStyle(ops({ op: "flip", dir: "h" }, { op: "flip", dir: "h" }, crop(0, 0, 200, 100)), src, box), box);
  near(twice.local.x, 0, "an even number of flips leaves the window alone");
});

test("the flip and transform preview is unchanged when there is no crop", () => {
  // This is PreviewPlayer's original opsTransform, moved: every clip in every
  // project that has ever been flipped must render exactly as it did.
  const box = { w: 800, h: 450 }, src = { w: 1280, h: 720 };
  assert.deepEqual(layerStyle(ops({ op: "flip", dir: "h" }), src, box), { transform: "scaleX(-1)" });
  assert.deepEqual(layerStyle(ops({ op: "flip", dir: "v" }), src, box), { transform: "scaleY(-1)" });
  assert.deepEqual(layerStyle(ops({ op: "transform", scale: 1.2, tx: 10, ty: -4 } as ClipOp), src, box),
                   { transform: "translate(10px, -4px) scale(1.2)" });
  assert.deepEqual(layerStyle(ops(), src, box), {});
  assert.equal(opsTransform([]), "");
});

test("an unmeasured stage previews uncropped rather than dividing by it", () => {
  // The box arrives from a ResizeObserver, so the first paint has none.
  const s = layerStyle(ops(crop(0, 0, 100, 100)), { w: 1280, h: 704 }, { w: 0, h: 0 });
  assert.equal(s.clipPath, undefined);
  assert.equal(s.transform, undefined);
});

test("a source with no recorded dimensions uses the picker's own fallback", () => {
  // The STORED rect was computed against these numbers by CROP_PRESETS, so a
  // preview assuming anything else draws a window the render does not cut.
  assert.deepEqual(sourceBox(undefined), FALLBACK_SRC);
  assert.deepEqual(sourceBox({ width: null, height: null }), FALLBACK_SRC);
  assert.deepEqual(sourceBox({ width: 0, height: 0 }), FALLBACK_SRC);
  assert.deepEqual(sourceBox({ width: 864, height: 480 }), { w: 864, h: 480 });
});

test("a malformed crop op is ignored, not rendered as NaN", () => {
  assert.equal(cropOf(ops({ op: "crop", x: 0, y: 0, w: "wide", h: 10 } as unknown as ClipOp)), null);
  assert.equal(cropOf(null as unknown as Clip["ops"]), null);
  assert.deepEqual(cropOf(ops(crop(1, 2, 3, 4))), { x: 1, y: 2, w: 3, h: 4 });
});

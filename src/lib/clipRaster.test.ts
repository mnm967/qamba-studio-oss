// node --test src/lib/clipRaster.test.ts
//
// The extractor drew the RAW video into a canvas, so a clip with `flip h` on
// it extracted an unmirrored frame — and that frame is `start_asset_id`, the
// picture the generated extend or chain opens on. A mirrored anchor is a hard
// flip at the cut, and the thumbnail agreed with the render rather than with
// the timeline, which is where you would look to catch it.
import test from "node:test";
import assert from "node:assert/strict";
import { describePlan, rasterPlan } from "./clipRaster.ts";

const A = { width: 1280, height: 720 } as never;
const clip = (ops: unknown[]) => ({ ops }) as never;

test("a clip with no ops is drawn straight", () => {
  const p = rasterPlan(clip([]), A);
  assert.equal(p.plain, true);
  assert.deepEqual(p.src, { x: 0, y: 0, w: 1280, h: 720 });
  assert.deepEqual(p.out, { w: 1280, h: 720 });
  assert.equal(describePlan(p), null);
});

test("FLIP H is carried — the case that made the anchor a mirror image", () => {
  const p = rasterPlan(clip([{ op: "flip", dir: "h" }]), A);
  assert.equal(p.flipH, true);
  assert.equal(p.flipV, false);
  assert.equal(p.plain, false);
  assert.match(describePlan(p) ?? "", /flip h/);
});

test("mirroring is PARITY, not presence", () => {
  // Two flips are the identity. Reporting a mirror there would flip an anchor
  // the timeline does not flip.
  assert.equal(rasterPlan(clip([{ op: "flip", dir: "h" }, { op: "flip", dir: "h" }]), A).flipH, false);
  assert.equal(rasterPlan(clip([{ op: "flip", dir: "v" }, { op: "flip", dir: "v" }]), A).flipV, false);
  const both = rasterPlan(clip([{ op: "flip", dir: "h" }, { op: "flip", dir: "v" }]), A);
  assert.equal(both.flipH, true);
  assert.equal(both.flipV, true);
});

test("a crop becomes the source rectangle, clamped like ffmpeg", () => {
  const p = rasterPlan(clip([{ op: "crop", x: 100, y: 50, w: 640, h: 360 }]), A);
  assert.deepEqual(p.src, { x: 100, y: 50, w: 640, h: 360 });
  assert.equal(p.cropped, true);
  assert.deepEqual(p.out, { w: 640, h: 360 });
});

test("a crop OUTLIVING its media is clamped, not obeyed", () => {
  // The normal case, not a corner one: a take swap patches `asset_id` and
  // keeps the ops, so a window drawn on a 1280x720 take meets a smaller
  // retake. ffmpeg REFUSES an oversized region, so the preview, the render
  // and this must all clamp the same way.
  const small = { width: 640, height: 360 } as never;
  const p = rasterPlan(clip([{ op: "crop", x: 0, y: 0, w: 1280, h: 720 }]), small);
  assert.ok(p.src.w <= 640 && p.src.h <= 360, JSON.stringify(p.src));
});

test("scale changes the drawn size and leaves the source rect alone", () => {
  const p = rasterPlan(clip([{ op: "transform", scale: 2 }]), A);
  assert.deepEqual(p.src, { x: 0, y: 0, w: 1280, h: 720 });
  assert.deepEqual(p.out, { w: 2560, h: 1440 });
  assert.match(describePlan(p) ?? "", /scale 2.00x/);
});

test("rotation accumulates and normalises into [0,360)", () => {
  assert.equal(rasterPlan(clip([{ op: "transform", rotate: 90 }, { op: "transform", rotate: 300 }]), A).rotate, 30);
  assert.equal(rasterPlan(clip([{ op: "transform", rotate: -90 }]), A).rotate, 270);
  assert.equal(rasterPlan(clip([{ op: "transform", rotate: 360 }]), A).rotate, 0);
});

test("a corrupt op never produces a NaN or a zero-size draw", () => {
  for (const bad of [
    [{ op: "transform", scale: 0 }],
    [{ op: "transform", scale: -1 }],
    [{ op: "transform", scale: NaN }],
    [{ op: "transform", rotate: Infinity }],
    [{ op: "crop", x: -50, y: -50, w: 0, h: 0 }],
  ]) {
    const p = rasterPlan(clip(bad), A);
    assert.ok(Number.isFinite(p.rotate), JSON.stringify(bad));
    assert.ok(p.out.w >= 1 && p.out.h >= 1, JSON.stringify(bad));
    assert.ok(p.src.w >= 0 && p.src.h >= 0, JSON.stringify(bad));
  }
});

test("ops arriving as jsonb junk degrade to a plain draw", () => {
  for (const junk of [null, undefined, "flip", 7, {}]) {
    assert.equal(rasterPlan(clip(junk as never), A).plain, true);
  }
});

test("an asset with no dimensions falls back rather than dividing by zero", () => {
  const p = rasterPlan(clip([{ op: "flip", dir: "h" }]), { width: null, height: null } as never);
  assert.ok(p.src.w > 0 && p.src.h > 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readStrip, cellBox, STRIP_FRAMES } from "./previewStrip.ts";

/** Every size H3 renders (worker/graphs.py H3_NATIVE_DIMS) plus its portrait
 *  flip — the full set of aspect ratios an ordinary preview can have. */
const NATIVE: Array<[number, number]> = [
  [608, 352], [736, 416], [864, 480], [960, 544], [1056, 608], [1152, 640],
  [1216, 672], [1280, 736], [1344, 768], [1376, 768], [1504, 832],
  [1664, 928], [1920, 1088], [1024, 832],
];
const REAL: Array<[number, number]> = [...NATIVE, ...NATIVE.map(([w, h]) => [h, w] as [number, number])];

/** PIL's ImageOps.contain, which ComfyUI applies to every preview on the way
 *  out (`--preview-size`, 1024 on the pod, 512 on an un-redeployed one). */
const contain = (w: number, h: number, cap: number): [number, number] => {
  if (w <= cap && h <= cap) return [w, h];
  const f = Math.min(cap / w, cap / h);
  return [Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))];
};

/** The sheet the pod builds for a render of this size: cells at 1024/N along
 *  the long axis, joined. Mirrors strip.py's plan plus _decode's 16x upscale. */
const sheet = (w: number, h: number): [number, number] => {
  const [lw, lh] = [Math.floor(w / 16), Math.floor(h / 16)];
  const cellPx = Math.min(512, Math.floor(1024 / STRIP_FRAMES));
  const scale = Math.min(1, cellPx / (Math.max(lw, lh) * 16));
  const r = (v: number) => (scale >= 1 ? v : Math.max(1, Math.round(v * scale))) * 16;
  const [cw, ch] = [r(lw), r(lh)];
  return w >= h ? [cw * STRIP_FRAMES, ch] : [cw, ch * STRIP_FRAMES];
};

test("an ordinary preview is never read as a strip", () => {
  // This runs for EVERY job in the queue. A Krea 2 still read as a 4-strip
  // shows the viewer the left quarter of the picture.
  for (const [w, h] of REAL) {
    assert.equal(readStrip(w, h).cells, 1, `${w}x${h}`);
    assert.equal(readStrip(...contain(w, h, 512)).cells, 1, `${w}x${h} contained`);
  }
});

test("every real render shape round-trips from the sheet the pod builds", () => {
  for (const [w, h] of REAL) {
    const [sw, sh] = sheet(w, h);
    const got = readStrip(sw, sh);
    assert.equal(got.cells, STRIP_FRAMES, `${w}x${h} -> ${sw}x${sh}`);
    assert.equal(got.cols, w >= h ? STRIP_FRAMES : 1);
    // ...and after core downscales it on a pod still at --preview-size 512.
    assert.equal(readStrip(...contain(sw, sh, 512)).cells, STRIP_FRAMES, `${w}x${h} contained`);
  }
});

test("the recovered cell aspect is the render's own, so the box keeps its shape", () => {
  for (const [w, h] of REAL) {
    const got = readStrip(...sheet(w, h));
    // Not exact: an H3 latent is 1/16 scale, so a 256px cell is ~16x9 latent
    // pixels and the rounding is coarse. The worker's twin pins the same 3%.
    assert.ok(Math.abs(got.cellAr - w / h) / (w / h) < 0.03, `${w}x${h}: ${got.cellAr}`);
  }
});

test("a square render is still read as a strip", () => {
  // The boundary case: a square cell puts the sheet's aspect exactly on N.
  assert.equal(readStrip(...sheet(1024, 1024)).cells, STRIP_FRAMES);
});

test("a degenerate size is a plain frame, not a division by zero", () => {
  // An <img> that has not loaded reports 0x0.
  for (const [w, h] of [[0, 0], [100, 0], [0, 100], [-1, 5]]) {
    const got = readStrip(w, h);
    assert.equal(got.cells, 1);
    assert.ok(Number.isFinite(got.cellAr));
  }
});

test("cellBox on a single frame is the box itself", () => {
  // The no-strip path has to be byte-identical to what inset:0 gave before,
  // or every non-H3 preview in the queue shifts.
  assert.deepEqual(cellBox(readStrip(1280, 736), 0),
                   { width: "100%", height: "100%", left: "0%", top: "0%" });
});

test("cellBox slides along the strip axis and nowhere else", () => {
  const horiz = readStrip(1024, 144);
  assert.deepEqual(cellBox(horiz, 2), { width: "400%", height: "100%", left: "-200%", top: "0%" });
  const vert = readStrip(144, 1024);
  assert.deepEqual(cellBox(vert, 2), { width: "100%", height: "400%", left: "0%", top: "-200%" });
});

test("cellBox clamps rather than sliding the sheet off the box", () => {
  // The animation index and the layout are separate state, so they can be one
  // render apart when a new frame arrives mid-scrub.
  const l = readStrip(1024, 144);
  assert.deepEqual(cellBox(l, 99), cellBox(l, STRIP_FRAMES - 1));
  assert.deepEqual(cellBox(l, -3), cellBox(l, 0));
});

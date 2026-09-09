// node --test src/lib/videoGrid.test.ts
//
// The duration control's arithmetic. Every case here is one where the slider
// and the render disagree silently: the number on screen is a plausible
// length, the file comes back a different one, and nothing errors.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_FRAMES, frameGrid, framesToMs, gridSteps, msToFrames, snapFrames } from "./videoGrid.ts";

const row = (over = {}) => ({ fps: 24, frame_base: 17, frame_rem: 5, max_seconds: null, ...over }) as never;

test("H3's grid is 17n+5 at 24fps", () => {
  const g = frameGrid(row());
  assert.equal(g.base, 17);
  assert.equal(g.rem, 5);
  assert.equal(g.minFrames, 5);
  // 365 is the ceiling but is NOT itself legal: 5 + 17*21 = 362 is.
  assert.equal(g.maxFrames, 362);
  assert.equal((g.maxFrames - g.rem) % g.base, 0);
});

test("LTX's grid is 8n+1, and its own ceiling wins", () => {
  const g = frameGrid(row({ frame_base: 8, frame_rem: 1, max_seconds: 10 }));
  assert.equal(g.minFrames, 1);
  // 10s * 24 = 240 frames of headroom; the largest 8n+1 at or under it is 233.
  // NOT 241 — snapping a ceiling has to go DOWN or the control offers a length
  // past the model's own limit.
  assert.equal(g.maxFrames, 233);
  assert.equal((g.maxFrames - 1) % 8, 0);
  assert.ok(framesToMs(g, g.maxFrames) <= 10_000);
});

test("a missing or corrupt row falls back to H3 rather than to NaN", () => {
  for (const bad of [undefined, null, row({ fps: 0 }), row({ frame_base: null }), row({ fps: "24" })]) {
    const g = frameGrid(bad as never);
    assert.ok(Number.isFinite(g.fps) && g.fps > 0);
    assert.ok(Number.isFinite(g.maxFrames) && g.maxFrames >= g.minFrames);
  }
  assert.equal(frameGrid(undefined).maxFrames, snapFrames(frameGrid(undefined), DEFAULT_MAX_FRAMES, "down"));
});

test("frame_rem of 0 is a real grid, not a missing value", () => {
  // >0 guards would read it as absent and substitute H3's 5.
  const g = frameGrid(row({ frame_base: 4, frame_rem: 0 }));
  assert.equal(g.rem, 0);
  assert.equal(g.minFrames, 4);            // zero frames is not a render
  assert.equal(g.maxFrames % 4, 0);
});

test("A ROW THAT DECLARES NO GRID GETS A FREE ONE, not H3's", () => {
  // Wan 2.2: frame_base null, 16fps, 8s. Its real grid is 4n+1 and nothing in
  // the catalog says so — quoting 17n+5 here would print a frame count the
  // render will not use.
  const g = frameGrid(row({ frame_base: null, frame_rem: null, fps: 16, max_seconds: 8 }));
  assert.equal(g.exact, false);
  assert.equal(g.fps, 16);            // fps IS declared, and is not H3's
  assert.equal(g.base, 1);
  assert.equal(g.minFrames, 1);
  assert.equal(g.maxFrames, 128);     // 8s * 16fps, every count allowed
  assert.equal(frameGrid(row()).exact, true);
});

test("snapping respects its direction", () => {
  const g = frameGrid(row());
  assert.equal(snapFrames(g, 22, "up"), 22);
  assert.equal(snapFrames(g, 23, "up"), 39);
  assert.equal(snapFrames(g, 38, "down"), 22);
  assert.equal(snapFrames(g, 32, "round"), 39);   // 32 is nearer 39 than 22
  assert.equal(snapFrames(g, 30, "round"), 22);   // and 30 is nearer 22
  assert.equal(snapFrames(g, 25, "round"), 22);
  // Never below the shortest legal count, whichever way it is asked.
  assert.equal(snapFrames(g, 0, "down"), 5);
  assert.equal(snapFrames(g, -100, "round"), 5);
});

test("THE ROUND TRIP IS EXACT — the worker's ceil-and-pad returns what we sent", () => {
  // resolve.frame_count is ceil(ms*fps/1000) padded UP onto the grid. Rounding
  // to nearest here overshoots a whole grid step: 22f -> 917ms -> ceil 23 -> 39.
  const workerWouldRender = (g: ReturnType<typeof frameGrid>, ms: number) =>
    snapFrames(g, Math.ceil((ms * g.fps) / 1000), "up");
  for (const r of [row(), row({ frame_base: 8, frame_rem: 1 }), row({ fps: 16, frame_base: 4, frame_rem: 1 })]) {
    const g = frameGrid(r);
    for (let f = g.minFrames; f <= g.maxFrames; f += g.base) {
      assert.equal(workerWouldRender(g, framesToMs(g, f)), f, `${f} frames on ${g.base}n+${g.rem}@${g.fps}`);
    }
  }
});

test("ms -> frames lands on the grid and inside the model's range", () => {
  const g = frameGrid(row({ max_seconds: 6 }));
  assert.equal(msToFrames(g, 2000), 56);     // 48f -> nearest legal (56, not 39)
  assert.equal((msToFrames(g, 2000) - g.rem) % g.base, 0);
  assert.equal(msToFrames(g, 999_000), g.maxFrames);
  assert.equal(msToFrames(g, 0), g.minFrames);
});

test("every slider position is legal", () => {
  const g = frameGrid(row());
  assert.equal(gridSteps(g), 22);
  for (let i = 0; i < gridSteps(g); i++) {
    const f = g.minFrames + i * g.base;
    assert.ok(f <= g.maxFrames);
    assert.equal(snapFrames(g, f, "round"), f);
  }
});

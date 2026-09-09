import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDims, snapTo } from "./resolution.ts";

const model = (dim_step: number | null) => ({ dim_step } as never);

test("a render inherits the size of the media it continues", () => {
  // The block either side of a chain is 1280x736; the bridge must match it.
  assert.deepEqual(renderDims(model(32), { width: 1280, height: 736 }), { w: 1280, h: 736 });
});

test("it falls through sources that carry no dimensions", () => {
  // A placeholder still registered by the browser has null width/height, so
  // the lane's own asset can be present and useless.
  assert.deepEqual(
    renderDims(model(32), { width: null, height: null }, undefined, { width: 1280, height: 720 }),
    { w: 1280, h: 736 },
  );
});

test("nothing known returns null, so the caller omits the keys", () => {
  // Falling back to a number of our own would be the handler's 1280x720 bug
  // moved one layer up.
  assert.equal(renderDims(model(32), null, undefined, { width: 0, height: 0 }), null);
});

test("the size sent is already on the model's grid, so resolve() cannot re-round it", () => {
  // THE WHOLE POINT. 720/32 is 22.5 — JS half-up gives 736, Python
  // ties-to-even gives 704 — so an unsnapped 720 rendered 16px shorter than
  // the blocks around it. Sending a multiple of the step makes the worker's
  // own snap a no-op whichever way it rounds.
  const d = renderDims(model(32), { width: 1280, height: 720 })!;
  assert.equal(d.h % 32, 0);
  assert.equal(d.h, snapTo(720, 32));
});

test("a model with a coarser grid gets its own legal size", () => {
  // LTX 2.5 is dim_step 64: 736 is legal at 32 and not at 64.
  assert.deepEqual(renderDims(model(64), { width: 1280, height: 736 }), { w: 1280, h: 768 });
});

test("a model that declares no step is treated as 32", () => {
  assert.deepEqual(renderDims(model(null), { width: 1280, height: 736 }), { w: 1280, h: 736 });
});

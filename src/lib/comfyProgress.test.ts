// The pure half of the local runner. The impure half (submit, poll, upload,
// register) is proven by rendering, which is the only thing that can prove it.
import assert from "node:assert/strict";
import test from "node:test";

import { progressFromLog } from "./comfyProgress.ts";

/** Exactly what ComfyUI 0.33 writes while sampling — tqdm, carriage-returned,
 *  so the whole render is ONE line by the time `engine_log` splits on \n. */
const REAL_TAIL =
  "[INFO] Requested to load WAN22\n"
  + "[INFO] loaded completely;  4099.47 MB loaded, full load: True\n"
  + "\r  0%|          | 0/6 [00:00<?, ?it/s]"
  + "\r 17%|█▋        | 1/6 [01:33<07:48, 93.61s/it]"
  + "\r 33%|███▎      | 2/6 [03:21<06:48, 102.08s/it]";

test("the sampler's position is read off the engine's own log", () => {
  assert.deepEqual(progressFromLog(REAL_TAIL), { done: 2, total: 6 });
});

test("the LAST step wins, not the first", () => {
  // The tail carries every step of the render; taking the first would pin the
  // bar at 0% for the whole thing.
  assert.equal(progressFromLog(REAL_TAIL)?.done, 2);
});

test("nothing to parse is null, never a guess", () => {
  // A bar at a wrong number is worse than a bar that says "loading" — this is
  // what the caller falls back to elapsed time on.
  assert.equal(progressFromLog(""), null);
  assert.equal(progressFromLog("[INFO] Starting server\n[INFO] got prompt"), null);
  // A timestamp is not a step count: `07:48` and `93.61s/it` must not match.
  assert.equal(progressFromLog("[01:33<07:48, 93.61s/it]"), null);
});

test("a nonsense ratio is refused", () => {
  assert.equal(progressFromLog("9/0 ["), null);
  assert.equal(progressFromLog("12/6 ["), null);
});

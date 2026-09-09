// `h3timing.ts` re-declares worker/h3_timing.py's constants, because the
// browser cannot import Python and `generation_blocks.frames` is NOT NULL —
// anything creating a block has to write a legal count before the worker ever
// sees it. So the two copies have to agree, and when they drift NOTHING
// errors: master_pass re-plans and patches the row, so the render comes out
// right and only the numbers the UI quoted (and the window it offered) are
// wrong. `DEFAULT_WARMUP_F` drifted to 12 against the worker's 22 exactly that
// way, and the visible symptom was a block created at the UI's own maximum
// silently losing motion-context chaining.
//
// Same treatment `workflows.test.ts` gives resolve.py: parse the Python, demand
// the numbers match.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_COOLDOWN_F, DEFAULT_WARMUP_F, FPS, MAX_FRAMES, MIN_FRAMES,
  maxContentMs, pad17, planBlock,
} from "./h3timing.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const py = fs.readFileSync(path.join(ROOT, "worker", "h3_timing.py"), "utf8");

/** `NAME = 123` at the top level of the module, comments and all. */
function pyInt(name: string): number {
  const m = py.match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, "m"));
  assert.ok(m, `${name} not found in worker/h3_timing.py`);
  return Number(m[1]);
}

test("the frame constants match worker/h3_timing.py", () => {
  assert.equal(FPS, pyInt("FPS"));
  assert.equal(MAX_FRAMES, pyInt("MAX_FRAMES"));
  assert.equal(DEFAULT_WARMUP_F, pyInt("DEFAULT_WARMUP_F"));
  assert.equal(DEFAULT_COOLDOWN_F, pyInt("DEFAULT_COOLDOWN_F"));
});

test("MIN_FRAMES matches the Python's 5 + 17 * 5 expression", () => {
  const m = py.match(/^MIN_FRAMES\s*=\s*(\d+)\s*\+\s*(\d+)\s*\*\s*(\d+)/m);
  assert.ok(m, "MIN_FRAMES not found in worker/h3_timing.py");
  assert.equal(MIN_FRAMES, Number(m[1]) + Number(m[2]) * Number(m[3]));
});

test("pad17 rounds UP onto the 17n+5 grid (invariant #5)", () => {
  for (const f of [5, 22, 39, 90, 101, 200, 361]) assert.equal(pad17(f) % 17, 5);
  assert.equal(pad17(5), 5);
  assert.equal(pad17(6), 22);
  assert.equal(pad17(22), 22);
  assert.equal(pad17(23), 39);
});

test("maxContentMs is the Python's own expression, not an inlined floor", () => {
  // They disagreed by a millisecond, and a millisecond is a whole frame once
  // msToFramesCeil rounds it up.
  assert.equal(maxContentMs(), Math.round(((MAX_FRAMES - DEFAULT_WARMUP_F) * 1000) / FPS));
});

test("the offered content window is one the worker can actually plan", () => {
  // The bug this file exists for. Note MAX_FRAMES (365) is a CEILING, not a
  // legal count — 362 is the largest 17n+5 under it — so a block at the very
  // top does shed padding. What must survive is the motion-context floor:
  // `_motion_ctx_wanted` refuses below warmup_f >= 5, and a UI that offers a
  // length the worker can only render by going under that silently drops
  // chained continuity.
  const plan = planBlock(maxContentMs());
  assert.ok(plan.renderF <= MAX_FRAMES, `${plan.renderF}f is over the ceiling`);
  assert.equal(plan.renderF % 17, 5, `${plan.renderF}f is not on the 17n+5 grid`);
  assert.ok(plan.warmupF >= 5, `warmup shed to ${plan.warmupF}f — motion context would be refused`);
});

test("planBlock sheds cooldown before warmup, as the Python does", () => {
  // Just under the ceiling: the pad overflows, cooldown goes first.
  const plan = planBlock(14_000);
  assert.ok(plan.renderF <= MAX_FRAMES);
  assert.ok(plan.cooldownF <= DEFAULT_COOLDOWN_F);
  assert.equal(plan.outMs, 14_000);
  assert.equal(plan.trimStartMs, Math.round((plan.warmupF * 1000) / FPS));
});

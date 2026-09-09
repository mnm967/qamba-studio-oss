// node --test src/lib/rippleDelete.test.ts
//
// Deleting several clips with the lane closing up behind them. Every case here
// is silent when wrong: the rows are written, nothing throws, and the lane
// comes out with two clips on top of each other — which the player resolves by
// picking one of them per frame, so a shot is simply absent from the cut.
import test from "node:test";
import assert from "node:assert/strict";
import { rippleShifts } from "./rippleDelete.ts";

const c = (id: string, track_id: string, t_start_ms: number, duration_ms: number) =>
  ({ id, track_id, t_start_ms, duration_ms }) as never;

// One lane, four clips back to back at 0 / 1000 / 2000 / 3000.
const LANE = [c("a", "V1", 0, 1000), c("b", "V1", 1000, 1000),
              c("c", "V1", 2000, 1000), c("d", "V1", 3000, 1000)];

test("a single deletion pulls everything after it left by its length", () => {
  assert.deepEqual(rippleShifts([LANE[0], LANE[2], LANE[3]], [LANE[1]]), [
    { id: "c", t_start_ms: 1000 },
    { id: "d", t_start_ms: 2000 },
  ]);
});

test("TWO deletions are ONE pass, not the single-clip ripple run twice", () => {
  // b and c go: d must land at 1000, having lost 2000ms of lane in front of
  // it. Applying the single-clip rule twice moves d to 2000 and then measures
  // the second gap against a lane already closed — d would end up at 2000, on
  // top of nothing but a second later than it belongs.
  assert.deepEqual(rippleShifts([LANE[0], LANE[3]], [LANE[1], LANE[2]]), [
    { id: "d", t_start_ms: 1000 },
  ]);
});

test("a clip BEFORE the deletion does not move", () => {
  assert.deepEqual(rippleShifts([LANE[0]], [LANE[2]]), []);
});

test("lanes are independent — a delete on V1 writes nothing on A1", () => {
  const audio = c("m", "A1", 2000, 5000);
  assert.deepEqual(rippleShifts([LANE[3], audio], [LANE[1]]), [
    { id: "d", t_start_ms: 2000 },
  ]);
});

test("a clip starting exactly where a deleted one did stays put", () => {
  // Strictly before: it is not BEHIND the gap, and pulling it left would put
  // it on top of whatever precedes it.
  const overlay = c("x", "V1", 1000, 500);
  assert.deepEqual(rippleShifts([overlay], [LANE[1]]), []);
});

test("nothing deleted, nothing moved", () => {
  assert.deepEqual(rippleShifts(LANE, []), []);
});

test("a shift never puts a clip before zero", () => {
  const late = c("z", "V1", 500, 100);
  assert.deepEqual(rippleShifts([late], [c("y", "V1", 0, 4000)]), [
    { id: "z", t_start_ms: 0 },
  ]);
});

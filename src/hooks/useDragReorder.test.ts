// The index math behind dragging a row into a new position. It is the one
// part of the gesture with an off-by-one in it, and the symptom of getting it
// wrong (a row that lands one place short of where it was dropped, but only
// when dragged downwards) is easy to mistake for a rendering problem.
import assert from "node:assert/strict";
import test from "node:test";

import { byIds, moveTo } from "./useDragReorder.ts";

const L = ["a", "b", "c", "d", "e"];

test("a row dropped in a gap above itself lands in that gap", () => {
  assert.deepEqual(moveTo(L, "d", 0), ["d", "a", "b", "c", "e"]);
  assert.deepEqual(moveTo(L, "d", 1), ["a", "d", "b", "c", "e"]);
  assert.deepEqual(moveTo(L, "e", 2), ["a", "b", "e", "c", "d"]);
});

test("a row dragged DOWN lands in the gap it was dropped in, not one short", () => {
  // The gap indices are measured against the list with "a" still in it: gap 2
  // is between b and c, so a lands between them.
  assert.deepEqual(moveTo(L, "a", 2), ["b", "a", "c", "d", "e"]);
  assert.deepEqual(moveTo(L, "a", 5), ["b", "c", "d", "e", "a"]);
  assert.deepEqual(moveTo(L, "b", 4), ["a", "c", "d", "b", "e"]);
});

test("dropping a row back where it started changes nothing", () => {
  // Identity, so the caller can skip the round trip on `next === ids`.
  assert.equal(moveTo(L, "c", 2), L);       // the gap above it
  assert.equal(moveTo(L, "c", 3), L);       // the gap below it
  assert.equal(moveTo(L, "a", 0), L);
  assert.equal(moveTo(L, "e", 5), L);
});

test("the order always keeps every row exactly once", () => {
  for (const id of L) {
    for (let gap = 0; gap <= L.length; gap++) {
      const out = moveTo(L, id, gap);
      assert.deepEqual([...out].sort(), [...L].sort(), `${id} -> ${gap}`);
      assert.equal(out.length, L.length);
    }
  }
});

test("an id that isn't in the list, or a gap outside it, is survivable", () => {
  // Both mean the list changed under the drag (a scene deleted in another tab).
  // The reorder RPC refuses a list that doesn't name every scene, so the worst
  // case has to be a no-op here rather than a scrambled order.
  assert.equal(moveTo(L, "zz", 2), L);
  assert.deepEqual(moveTo(L, "a", 99), ["b", "c", "d", "e", "a"]);
  assert.deepEqual(moveTo(L, "e", -3), ["e", "a", "b", "c", "d"]);
});

test("byIds re-orders rows and never drops one the order forgot", () => {
  const rows = L.map((id) => ({ id, n: id.toUpperCase() }));
  assert.deepEqual(byIds(rows, ["c", "a"]).map((r) => r.id), ["c", "a", "b", "d", "e"]);
  assert.deepEqual(byIds(rows, []).map((r) => r.id), L);
  // An id in the order that no longer has a row is skipped, not rendered blank.
  assert.deepEqual(byIds(rows, ["c", "gone", "a"]).map((r) => r.id),
                   ["c", "a", "b", "d", "e"]);
});

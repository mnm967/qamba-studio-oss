import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCells, swapCell } from "./multiview.ts";

const IDS = ["a", "b", "c", "d", "e", "f"];

test("with nothing picked the wall is the first n takes, in bench order", () => {
  assert.deepEqual(pickCells(IDS, [], 4), ["a", "b", "c", "d"]);
});

test("fewer takes than cells shows every take and no blanks", () => {
  assert.deepEqual(pickCells(["a", "b"], [], 4), ["a", "b"]);
});

test("a picked take keeps its slot and the gaps fill in bench order", () => {
  assert.deepEqual(pickCells(IDS, ["f"], 4), ["f", "a", "b", "c"]);
});

test("a take that no longer exists is replaced, not left as a hole", () => {
  // The wall was pointed at a take that has since been deleted.
  assert.deepEqual(pickCells(IDS, ["b", "zz", "e"], 4), ["b", "e", "a", "c"]);
});

test("a repeat in the stored selection cannot put one take on two cells", () => {
  assert.deepEqual(pickCells(IDS, ["c", "c", "a"], 4), ["c", "a", "b", "d"]);
});

test("n zero or negative is an empty wall rather than a crash", () => {
  assert.deepEqual(pickCells(IDS, ["a"], 0), []);
  assert.deepEqual(pickCells(IDS, ["a"], -1), []);
});

test("pointing a slot at a take that is not on the wall just replaces it", () => {
  assert.deepEqual(swapCell(["a", "b", "c", "d"], 1, "f"), ["a", "f", "c", "d"]);
});

test("pointing a slot at a take ALREADY on the wall trades their places", () => {
  // Never two cells of one take: the other slot takes what this one had.
  assert.deepEqual(swapCell(["a", "b", "c", "d"], 0, "d"), ["d", "b", "c", "a"]);
});

test("picking the take a slot already shows changes nothing", () => {
  const before = ["a", "b", "c"];
  assert.deepEqual(swapCell(before, 2, "c"), before);
});

test("a slot that does not exist is a no-op, and the input is never mutated", () => {
  const before = ["a", "b"];
  assert.deepEqual(swapCell(before, 5, "f"), before);
  assert.deepEqual(swapCell(before, -1, "f"), before);
  assert.notEqual(swapCell(before, 0, "f"), before);   // a copy, always
  assert.deepEqual(before, ["a", "b"]);
});

test("a swap survives normalisation verbatim", () => {
  // What the modal does: swap, store, re-normalise. The second step must not
  // quietly re-sort the wall back into bench order.
  const cells = pickCells(IDS, [], 4);
  const next = swapCell(cells, 0, "f");
  assert.deepEqual(pickCells(IDS, next, 4), ["f", "b", "c", "d"]);
});

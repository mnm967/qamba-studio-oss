import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayBlockStatus, missingChainParents, planBlockStatus, selectedSeconds,
  STALE_UI, type ChainRow,
} from "./staleBlocks.ts";

const row = (idx: number, from: number | null = null): ChainRow =>
  ({ id: `b${idx}`, idx, chain_from_block_id: from == null ? null : `b${from}` });

test("a stale block reads as what is on screen, not as stale", () => {
  assert.equal(displayBlockStatus("stale", true), "generated");
  // The take is gone: "generated" over an empty thumbnail is worse than stale.
  assert.equal(displayBlockStatus("stale", false), "planned");
});

test("every other status is passed through untouched", () => {
  for (const st of ["planned", "queued", "generating", "generated", "failed"]) {
    assert.equal(displayBlockStatus(st, true), st);
    assert.equal(displayBlockStatus(st, false), st);
  }
  // A clip whose block row has not loaded is not a planned block.
  assert.equal(displayBlockStatus(null, true), "generated");
});

test("a chained selection reports the stale block it opens on", () => {
  const stale = [row(6), row(7, 6), row(8, 7)];
  const gap = missingChainParents(["b8"], stale);
  // The whole way up: b8 opens on b7's final frame and b7 on b6's.
  assert.deepEqual(gap.map((b) => b.id), ["b6", "b7"]);
});

test("the walk stops at a parent that is not stale", () => {
  // b7 chains from b6, which is NOT in the stale set — it has already
  // re-rendered, so it is a fine anchor and nothing above it is reported.
  const stale = [row(7, 6), row(8, 7)];
  assert.deepEqual(missingChainParents(["b8"], stale).map((b) => b.id), ["b7"]);
});

test("a parent that is already selected is not a gap", () => {
  const stale = [row(6), row(7, 6)];
  assert.deepEqual(missingChainParents(["b6", "b7"], stale), []);
  // Nothing chains off b6, so it stands alone.
  assert.deepEqual(missingChainParents(["b6"], stale), []);
});

test("gaps are deduped across selections and ordered by idx", () => {
  const stale = [row(2), row(3, 2), row(4, 3), row(5, 4)];
  const gap = missingChainParents(["b5", "b4"], stale);
  assert.deepEqual(gap.map((b) => b.id), ["b2", "b3"]);
});

test("a chain cycle terminates", () => {
  // Not reachable through the planner, but a hand-edited row could say it and
  // an unbounded walk would hang the popup rather than mis-report it. `c` is
  // outside the cycle so neither member is excluded by being selected.
  const stale: ChainRow[] = [
    { id: "a", idx: 0, chain_from_block_id: "b" },
    { id: "b", idx: 1, chain_from_block_id: "a" },
    { id: "c", idx: 2, chain_from_block_id: "a" },
  ];
  assert.deepEqual(missingChainParents(["c"], stale).map((b) => b.id), ["a", "b"]);
  // Selecting one member of the cycle takes it out of the gap.
  assert.deepEqual(missingChainParents(["a"], stale).map((b) => b.id), ["b"]);
});

test("selected seconds prices only what is checked", () => {
  const blocks = [
    { id: "b1", t_start_ms: 0, t_end_ms: 8000 },
    { id: "b2", t_start_ms: 8000, t_end_ms: 20000 },
    { id: "b3", t_start_ms: 20000, t_end_ms: 21000 },
  ];
  assert.equal(selectedSeconds(["b1", "b3"], blocks), 9);
  assert.equal(selectedSeconds([], blocks), 0);
  // A negative window is a bad row, not negative footage.
  assert.equal(selectedSeconds(["x"], [{ id: "x", t_start_ms: 900, t_end_ms: 0 }]), 0);
});

/* ── the switch ──────────────────────────────────────────────────────────────
   `STALE_UI` is what took the storyboard and the director dock down to the same
   rule every working surface already followed. These pin the CURRENT setting on
   purpose: turning it back on is a deliberate act that should have to move a
   test with it, not something a refactor can do by accident. */

test("stale is off everywhere for now", () => {
  assert.equal(STALE_UI, false);
});

test("a plan surface says nothing a working surface would not, while it is off", () => {
  // The storyboard and the scene editor used to be the exception. They are not.
  for (const st of ["planned", "queued", "generating", "generated", "failed", "stale"]) {
    for (const take of [true, false]) {
      assert.equal(planBlockStatus(st, take), displayBlockStatus(st, take));
    }
  }
  assert.equal(planBlockStatus("stale", true), "generated");
  assert.equal(planBlockStatus("stale", false), "planned");
  assert.equal(planBlockStatus(null, true), "generated");
});

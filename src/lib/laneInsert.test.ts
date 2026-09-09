import { test } from "node:test";
import assert from "node:assert/strict";
import { insertIndexAt, lanePacks } from "./laneInsert.ts";

type C = { id: string; track_id: string; t_start_ms: number; linked_clip_id?: string | null };
const c = (id: string, t: number, dur = 1000, track = "V1"): C & { duration_ms: number } =>
  ({ id, track_id: track, t_start_ms: t, duration_ms: dur, linked_clip_id: null });

/** The lane order `insertAsset` used to produce: append, stable-sort by start,
 *  then pack. Kept here as the thing being fixed — the assertion below is only
 *  meaningful next to it. */
const oldOrder = (lane: C[], placed: C) =>
  [...lane, placed].sort((a, b) => a.t_start_ms - b.t_start_ms).map((x) => x.id);

const newOrder = (lane: C[], placed: C, atMs: number) => {
  const rest = lane.filter((x) => x.id !== placed.id);
  const i = insertIndexAt([...rest, placed], placed.track_id, atMs, placed.id);
  rest.splice(i, 0, placed);
  return rest.map((x) => x.id);
};

test("the reported case: extending a block puts the extension next, not after the block after it", () => {
  // Block 15 (1.5s) then the chain that was bridged off it (4.5s). An extend of
  // Block 15 asks for `t_start + duration` = 1500, which is exactly where the
  // chain starts.
  const lane = [c("block15", 0, 1500), c("chain16", 1500, 4500)];
  const ext = c("ext", 1500, 4500);

  assert.deepEqual(oldOrder(lane, ext), ["block15", "chain16", "ext"]);
  assert.deepEqual(newOrder(lane, ext, 1500), ["block15", "ext", "chain16"]);
});

test("duplicating a block puts the copy immediately next to the original block", () => {
  const lane = [c("b1", 0, 4000), c("b2", 4000, 4000), c("b3", 8000, 4000)];
  const b1Dup = c("b1_copy", 4000, 4000);
  assert.deepEqual(newOrder(lane, b1Dup, 4000), ["b1", "b1_copy", "b2", "b3"]);

  const b2Dup = c("b2_copy", 8000, 4000);
  assert.deepEqual(newOrder(lane, b2Dup, 8000), ["b1", "b2", "b2_copy", "b3"]);
});

test("a tie puts the new clip first, because that is what inserting AT a time means", () => {
  const lane = [c("a", 0, 1000), c("b", 1000, 1000)];
  assert.equal(insertIndexAt([...lane, c("new", 1000)], "V1", 1000, "new"), 1);
});

test("inserting at the very start of a lane goes before the clip already there", () => {
  const lane = [c("a", 0, 1000)];
  assert.equal(insertIndexAt([...lane, c("new", 0)], "V1", 0, "new"), 0);
});

test("no tie behaves exactly as the sort did — into a gap, and past the end", () => {
  const lane = [c("a", 0, 1000), c("b", 5000, 1000)];
  assert.equal(insertIndexAt([...lane, c("new", 3000)], "V1", 3000, "new"), 1);
  assert.equal(insertIndexAt([...lane, c("new", 9000)], "V1", 9000, "new"), 2);
});

test("other lanes are not counted", () => {
  const lane = [c("a", 0, 1000), c("other", 0, 1000, "V2"), c("other2", 500, 1000, "A1")];
  assert.equal(insertIndexAt([...lane, c("new", 4000)], "V1", 4000, "new"), 1);
});

test("an unsorted list gives the same answer, since the index is COUNTED", () => {
  const lane = [c("b", 1000, 1000), c("a", 0, 1000)];
  assert.equal(insertIndexAt([...lane, c("new", 1000)], "V1", 1000, "new"), 1);
});

test("without excludeId the clip would count itself — pinned so the argument is not dropped", () => {
  const all = [c("a", 0, 1000), c("new", 4000)];
  assert.equal(insertIndexAt(all, "V1", 4000, "new"), 1);
  assert.equal(insertIndexAt(all, "V1", 4000), 1); // "new" starts AT 4000, not before it
  // A clip already sitting before the insert point does count itself, which is
  // why the exclusion is not optional in the store.
  const moved = [c("a", 0, 1000), c("new", 100)];
  assert.equal(insertIndexAt(moved, "V1", 4000, "new"), 1);
  assert.equal(insertIndexAt(moved, "V1", 4000), 2);
});

test("an audio lane holding a linked clip does not pack; every other lane does", () => {
  const linked = [{ linked_clip_id: "v1" }, { linked_clip_id: null }];
  const loose = [{ linked_clip_id: null }];
  assert.equal(lanePacks({ kind: "audio" }, linked), false);
  assert.equal(lanePacks({ kind: "audio" }, loose), true);
  // A VIDEO lane packs even when its clips are linked — the audio halves
  // follow through the geometry mirror.
  assert.equal(lanePacks({ kind: "video" }, linked), true);
  assert.equal(lanePacks(undefined, linked), true);
});

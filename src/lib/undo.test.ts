// The undo model's arithmetic: what a step contains, what order it has to be
// applied in, and when two of them are really one gesture.
//
// The bug these exist for is silent by construction — a missing undo entry is
// not an error, it is a ⌘Z that does nothing — so the cases below are written
// against the operations that used to record NOTHING: a delete, a split, a
// lane re-pack, a track removal.
import assert from "node:assert/strict";
import test from "node:test";

import {
  COALESCE_MS, diffSnapshots, labelForPatch, phases, pushStep, touchedClipIds,
  touchedTrackIds,
  type Snapshot, type UndoStep,
} from "./undo.ts";
import type { Clip, Track } from "./db/types.ts";

const track = (id: string, over: Record<string, unknown> = {}) => ({
  id, timeline_id: "tl", kind: "video" as const, idx: 0, name: id.toUpperCase(),
  muted: false, solo: false, locked: false, gain_db: 0, automation: [],
  duck_under_track_id: null, ...over,
}) as Track;

const clip = (id: string, over: Record<string, unknown> = {}) => ({
  id, track_id: "v1", asset_id: "as1", block_id: null, t_start_ms: 0, duration_ms: 6000,
  in_ms: 0, out_ms: 6000, ops: [], transition_in: null, gain_db: 0, label: id,
  linked_clip_id: null, audio_detached: false, audio_fx: [], post: null,
  updated_at: "2026-01-01", ...over,
}) as Clip;

const snap = (clips: Clip[], tracks: Track[] = [track("v1")]): Snapshot => ({ clips, tracks });
const step = (ops: UndoStep["ops"]): UndoStep => ({ label: "test", ops });

// ── the diff ───────────────────────────────────────────────────────────────

test("a field change is one patch op carrying both sides", () => {
  const ops = diffSnapshots(snap([clip("c1")]), snap([clip("c1", { t_start_ms: 4000 })]));
  assert.deepEqual(ops, [{
    t: "clip.patch", id: "c1",
    before: { t_start_ms: 0 }, after: { t_start_ms: 4000 },
  }]);
});

test("a deleted clip is recorded WHOLE, because undoing needs to rebuild it", () => {
  const gone = clip("c1", { label: "Block 1", ops: [{ op: "reverse" }] });
  const ops = diffSnapshots(snap([gone]), snap([]));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].t, "clip.del");
  // Not just the id: the row has to come back with its media, its window, its
  // ops and its label, or "undo" returns something that is not what was there.
  assert.deepEqual(ops[0].t === "clip.del" ? ops[0].clip : null, gone);
});

test("a created clip is recorded whole too, so redo can put it back", () => {
  const made = clip("c2", { t_start_ms: 6000 });
  const ops = diffSnapshots(snap([clip("c1")]), snap([clip("c1"), made]));
  assert.deepEqual(ops, [{ t: "clip.add", clip: made }]);
});

test("a split is one step: the left half patched and the right half created", () => {
  const before = snap([clip("c1", { duration_ms: 6000, out_ms: 6000 })]);
  const after = snap([
    clip("c1", { duration_ms: 2000, out_ms: 2000 }),
    clip("c2", { t_start_ms: 2000, duration_ms: 4000, in_ms: 2000 }),
  ]);
  const ops = diffSnapshots(before, after);
  assert.deepEqual(ops.map((o) => o.t), ["clip.patch", "clip.add"]);
});

test("deleting a lane records the lane AND every clip that cascaded with it", () => {
  const before = snap([clip("c1"), clip("c2", { track_id: "v2" })],
                      [track("v1"), track("v2", { idx: 1 })]);
  const after = snap([clip("c1")], [track("v1")]);
  const ops = diffSnapshots(before, after);
  assert.deepEqual(ops.map((o) => o.t).sort(), ["clip.del", "track.del"]);
});

test("a lane re-pack is one step covering every clip it moved", () => {
  const before = snap([clip("a"), clip("b", { t_start_ms: 9000 }), clip("c", { t_start_ms: 20000 })]);
  const after = snap([clip("a"), clip("b", { t_start_ms: 6000 }), clip("c", { t_start_ms: 12000 })]);
  const ops = diffSnapshots(before, after);
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.map((o) => (o.t === "clip.patch" ? o.id : null)), ["b", "c"]);
});

test("jsonb columns compare by VALUE — a fresh array of the same points is not an edit", () => {
  // reconcile hands back new objects on every read; identity would report a
  // change on every tick and fill the stack with steps that changed nothing.
  const ops = diffSnapshots(
    snap([clip("c1", { ops: [{ op: "reverse" }], audio_fx: [{ id: "eq", params: {} }] })]),
    snap([clip("c1", { ops: [{ op: "reverse" }], audio_fx: [{ id: "eq", params: {} }] })]));
  assert.deepEqual(ops, []);
});

test("updated_at is not a field — the server rewrites it on every write", () => {
  const ops = diffSnapshots(snap([clip("c1")]), snap([clip("c1", { updated_at: "2026-09-09" })]));
  assert.deepEqual(ops, []);
});

test("an unchanged editor produces no step at all", () => {
  const c = [clip("c1"), clip("c2")];
  assert.deepEqual(diffSnapshots(snap(c), snap(c)), []);
});

// ── application order ──────────────────────────────────────────────────────

test("undoing a lane delete restores the LANE before the clips that sit on it", () => {
  // clips.track_id is a foreign key: the other order is a refused insert, and
  // the whole point of the step is that the clips come back.
  const s = step([
    { t: "track.del", track: track("v2", { idx: 1 }) },
    { t: "clip.del", clip: clip("c2", { track_id: "v2" }) },
  ]);
  const p = phases(s, "undo");
  assert.deepEqual(p.addTracks.map((t) => t.id), ["v2"]);
  assert.deepEqual(p.addClips.map((c) => c.id), ["c2"]);
  assert.deepEqual(p.delTracks, []);
  assert.deepEqual(p.delClips, []);
});

test("redoing that delete removes the clips before the lane", () => {
  const s = step([
    { t: "track.del", track: track("v2", { idx: 1 }) },
    { t: "clip.del", clip: clip("c2", { track_id: "v2" }) },
  ]);
  const p = phases(s, "redo");
  assert.deepEqual(p.delClips, ["c2"]);
  assert.deepEqual(p.delTracks, ["v2"]);
  assert.deepEqual(p.addClips, []);
});

test("undo takes `before` and redo takes `after` — one code path, one flag", () => {
  const s = step([{ t: "clip.patch", id: "c1", before: { t_start_ms: 0 }, after: { t_start_ms: 9 } }]);
  assert.deepEqual(phases(s, "undo").patchClips, [{ id: "c1", patch: { t_start_ms: 0 } }]);
  assert.deepEqual(phases(s, "redo").patchClips, [{ id: "c1", patch: { t_start_ms: 9 } }]);
});

test("undoing a creation deletes it, and redoing it puts the same row back", () => {
  const made = clip("c9");
  const s = step([{ t: "clip.add", clip: made }]);
  assert.deepEqual(phases(s, "undo").delClips, ["c9"]);
  assert.deepEqual(phases(s, "redo").addClips, [made]);
});

// ── the stack ──────────────────────────────────────────────────────────────

test("the stack is bounded, oldest first out", () => {
  let stack: UndoStep[] = [];
  for (let i = 0; i < 8; i++) stack = pushStep(stack, { label: `s${i}`, ops: [] }, 5);
  assert.equal(stack.length, 5);
  assert.deepEqual(stack.map((s) => s.label), ["s3", "s4", "s5", "s6", "s7"]);
});

test("one fader sweep is one step: same key inside the window merges", () => {
  const at = (t: number, from: number, to: number): UndoStep => ({
    label: "Lane volume", coalesce: { key: "gain:a1", at: t },
    ops: [{ t: "track.patch", id: "a1", before: { gain_db: from }, after: { gain_db: to } }],
  });
  let stack = pushStep([], at(1000, 0, -1));
  stack = pushStep(stack, at(1100, -1, -2));
  stack = pushStep(stack, at(1200, -2, -6));
  assert.equal(stack.length, 1);
  const op = stack[0].ops[0];
  assert.equal(op.t, "track.patch");
  // The step spans the WHOLE sweep: where it started, where it ended.
  assert.deepEqual(op.t === "track.patch" ? op.before : null, { gain_db: 0 });
  assert.deepEqual(op.t === "track.patch" ? op.after : null, { gain_db: -6 });
});

test("a pause longer than the window starts a new step", () => {
  const at = (t: number): UndoStep => ({
    label: "Lane volume", coalesce: { key: "gain:a1", at: t },
    ops: [{ t: "track.patch", id: "a1", before: { gain_db: 0 }, after: { gain_db: -1 } }],
  });
  const stack = pushStep(pushStep([], at(1000)), at(1000 + COALESCE_MS + 1));
  assert.equal(stack.length, 2);
});

test("different controls never merge, however close together", () => {
  const one: UndoStep = { label: "a", coalesce: { key: "gain:a1", at: 0 }, ops: [] };
  const two: UndoStep = { label: "b", coalesce: { key: "gain:a2", at: 10 }, ops: [] };
  assert.equal(pushStep(pushStep([], one), two).length, 2);
});

test("a discrete step never merges into a continuous one", () => {
  const drag: UndoStep = { label: "Lane volume", coalesce: { key: "gain:a1", at: 0 }, ops: [] };
  const del: UndoStep = { label: "Delete clip", ops: [{ t: "clip.del", clip: clip("c1") }] };
  assert.equal(pushStep(pushStep([], drag), del).length, 2);
});

test("merging keeps a key only the LATER move touched, with its own before", () => {
  // A curve drag that starts moving a second field mid-gesture still has to be
  // able to put that field back.
  const a: UndoStep = {
    label: "Trim", coalesce: { key: "trim:c1", at: 0 },
    ops: [{ t: "clip.patch", id: "c1", before: { duration_ms: 6000 }, after: { duration_ms: 5000 } }],
  };
  const b: UndoStep = {
    label: "Trim", coalesce: { key: "trim:c1", at: 50 },
    ops: [{ t: "clip.patch", id: "c1",
            before: { duration_ms: 5000, out_ms: 5000 }, after: { duration_ms: 4000, out_ms: 4000 } }],
  };
  const op = pushStep(pushStep([], a), b)[0].ops[0];
  assert.equal(op.t, "clip.patch");
  if (op.t !== "clip.patch") return;
  assert.deepEqual(op.before, { duration_ms: 6000, out_ms: 5000 });
  assert.deepEqual(op.after, { duration_ms: 4000, out_ms: 4000 });
});

// ── what a step touches ────────────────────────────────────────────────────

test("touched ids cover every shape of op, so no pending write survives an undo", () => {
  const s = step([
    { t: "clip.add", clip: clip("c1") },
    { t: "clip.del", clip: clip("c2") },
    { t: "clip.patch", id: "c3", before: {}, after: {} },
    { t: "track.add", track: track("v2") },
    { t: "track.patch", id: "v1", before: {}, after: {} },
  ]);
  assert.deepEqual(touchedClipIds(s).sort(), ["c1", "c2", "c3"]);
  assert.deepEqual(touchedTrackIds(s).sort(), ["v1", "v2"]);
});

// ── labels ─────────────────────────────────────────────────────────────────
// "Undo" on its own is a question. The button exists to answer it, so the
// label has to come off the patch rather than being a constant.

test("the label names the most specific field the patch carries", () => {
  assert.equal(labelForPatch({ t_start_ms: 1 }), "Move clip");
  assert.equal(labelForPatch({ track_id: "v2", t_start_ms: 1 }), "Move clip to lane");
  assert.equal(labelForPatch({ asset_id: "a" }), "Switch take");
  assert.equal(labelForPatch({ label: "x" }), "Rename clip");
  assert.equal(labelForPatch({ gain_db: -3 }), "Clip volume");
});

test("a trim writes three fields at once and still reads as a trim", () => {
  assert.equal(labelForPatch({ t_start_ms: 1, in_ms: 1, duration_ms: 2 }), "Trim clip");
});

test("an unrecognised patch degrades to a generic label rather than to nothing", () => {
  assert.equal(labelForPatch({ something_new: 1 }), "Edit clip");
});

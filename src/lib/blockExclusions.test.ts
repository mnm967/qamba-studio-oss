/**
 * The record that makes a deleted block STAY deleted.
 *
 * The bug: `syncBlocksToTimeline` re-adds any block that has a kept take and
 * no clip, and a delete left no trace — so "just rendered" and "the user threw
 * it away" were the same observation and the block came back on the next take,
 * the next re-render, or simply the next mount of the editor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusionsAfterStep } from "./blockExclusions.ts";
import type { Clip, Track } from "./db/types.ts";
import type { UndoOp } from "./undo.ts";

const V1 = { id: "v1", kind: "video" } as Track;
const A1 = { id: "a1", kind: "audio" } as Track;
const TRACKS = [V1, A1];

const clip = (id: string, block: string | null, track = "v1") =>
  ({ id, block_id: block, track_id: track, t_start_ms: 0, duration_ms: 1000 } as Clip);

const del = (c: Clip): UndoOp => ({ t: "clip.del", clip: c });
const add = (c: Clip): UndoOp => ({ t: "clip.add", clip: c });

test("deleting a block's clip excludes the block", () => {
  const gone = clip("c8", "b8");
  assert.deepEqual(exclusionsAfterStep([del(gone)], [], TRACKS),
                   { exclude: ["b8"], include: [] });
});

test("undoing that delete includes it again — no direction flag anywhere", () => {
  // Redo takes the same path back out: the answer is re-derived from the clips
  // that are there, so ⌘Z and ⇧⌘Z cannot disagree about it.
  const back = clip("c8", "b8");
  assert.deepEqual(exclusionsAfterStep([add(back)], [back], TRACKS),
                   { exclude: [], include: ["b8"] });
  assert.deepEqual(exclusionsAfterStep([del(back)], [], TRACKS),
                   { exclude: ["b8"], include: [] });
});

test("a SPLIT half is not a deleted block — the other half still holds it", () => {
  // Deleting one side of a split would otherwise exclude the block while its
  // other half is still on screen, and the next retake would then stop
  // repointing that half at the new take. Silent, and only visible in the
  // picture.
  const half = clip("c8b", "b8");
  const kept = clip("c8a", "b8");
  assert.deepEqual(exclusionsAfterStep([del(half)], [kept], TRACKS),
                   { exclude: [], include: ["b8"] });
});

test("a block clip on ANOTHER video lane counts — V2 is still this cut", () => {
  const v2: Track = { id: "v2", kind: "video" } as Track;
  const moved = clip("c8", "b8", "v2");
  assert.deepEqual(exclusionsAfterStep([del(clip("old", "b8"))], [moved], [V1, v2]),
                   { exclude: [], include: ["b8"] });
});

test("a DETACHED AUDIO half does not keep a deleted block in the cut", () => {
  // `detachedClipFrom` copies block_id onto the audio half. A block whose
  // picture is gone is not part of the cut because its sound outlived it —
  // and reading it that way would leave the picture permanently resurrectable.
  const audioHalf = clip("c8a", "b8", "a1");
  assert.deepEqual(exclusionsAfterStep([del(clip("c8", "b8"))], [audioHalf], TRACKS),
                   { exclude: ["b8"], include: [] });
});

test("only the blocks this step touched are named", () => {
  // The return is an INSTRUCTION about a few blocks, never a replacement list:
  // a step that removes b8 must not quietly un-exclude b3, which somebody
  // deleted an hour ago and which no clip mentions.
  const out = exclusionsAfterStep([del(clip("c8", "b8"))], [clip("c1", "b1")], TRACKS);
  assert.deepEqual(out, { exclude: ["b8"], include: [] });
});

test("clips with no block are ignored — dragged media is not a block", () => {
  assert.deepEqual(exclusionsAfterStep([del(clip("c0", null))], [], TRACKS),
                   { exclude: [], include: [] });
});

test("a step that only PATCHES clips says nothing at all", () => {
  // Trims, moves, take swaps and fader sweeps all land here. They must be free:
  // this runs at the close of every single undo step.
  const ops: UndoOp[] = [{ t: "clip.patch", id: "c8", before: { in_ms: 0 }, after: { in_ms: 40 } }];
  assert.deepEqual(exclusionsAfterStep(ops, [clip("c8", "b8")], TRACKS),
                   { exclude: [], include: [] });
});

test("deleting a LANE excludes every block that went with it", () => {
  // removeTrack cascades its clips, and the diff records each as its own
  // clip.del — so the lane delete needs no special case here.
  const ops = [del(clip("c1", "b1")), del(clip("c2", "b2"))];
  assert.deepEqual(exclusionsAfterStep(ops, [], TRACKS),
                   { exclude: ["b1", "b2"], include: [] });
});

/* ── the two halves that reach Supabase, pinned by parsing their source ──────
 *
 * `syncBlocksToTimeline` is almost entirely Supabase calls and the store's
 * `noteBlockExclusions` is module-private, so there is nothing to call — the
 * same situation `scoreTrack.test.ts` and `worker/tests/test_review_gate.py`
 * are in, and the same answer: read the text and assert the shape of the
 * decision. Weak on purpose, and still stronger than nothing: every failure
 * below is silent at runtime — the block just comes back. */

import { readFileSync } from "node:fs";

// Normalised to LF before anything indexes into it: git's default on Windows
// is core.autocrlf=true, and a regex `.` does not match `\r` — which is how a
// source-parsing test comes back reporting "found 0" instead of failing.
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const SYNC = (() => {
  const src = read("./db/timeline.ts");
  const at = src.indexOf("export async function syncBlocksToTimeline");
  assert.ok(at > 0, "syncBlocksToTimeline is gone — did it move or get renamed?");
  const end = src.indexOf("\n}\n", at);
  assert.ok(end > at, "could not find the end of syncBlocksToTimeline");
  return src.slice(at, end);
})();

test("the sync reads the exclusion list before it inserts anything", () => {
  const read_ = SYNC.indexOf("excluded_block_ids");
  assert.ok(read_ > 0, "the sync no longer consults excluded_block_ids — deleted blocks WILL come back");
  const skip = SYNC.indexOf("excluded.has(b.id)) {");
  const insert = SYNC.indexOf("insertClip({");
  assert.ok(skip > 0, "the skip branch is gone");
  assert.ok(skip < insert, "the skip branch must come BEFORE the insert, or it never runs");
});

test("a skipped block is REPORTED, never dropped in silence", () => {
  assert.match(SYNC, /skipped\.push\(\{ id: b\.id, idx: b\.idx \}\)/);
});

test("the exclusion self-heals: a block that has a clip stops being excluded", () => {
  // This is the whole restore path. Undo puts the clip back and the store
  // clears the exclusion; dragging the block on again is caught here instead,
  // since a drop writes no undo step this module can see.
  assert.match(SYNC, /if \(excluded\.has\(b\.id\)\) heal\.push\(b\.id\)/);
  assert.match(SYNC, /setBlockExclusions\(timelineId, \{ include: heal \}\)/);
});

test("'already on the timeline' spans every VIDEO lane, not just the first", () => {
  // Scoped to `vt.id` alone, a block clip dragged up to V2 read as missing and
  // the next sync laid a SECOND copy on V1 — the same resurrection as a
  // delete, wearing a different costume.
  assert.match(SYNC, /\.in\("track_id", videoIds\)/);
  assert.ok(!/from\("clips"\)[\s\S]*?\.eq\("track_id", vt\.id\)/.test(SYNC),
            "the clip lookup is back to a single lane");
});

test("the store records exclusions at BOTH choke points", () => {
  // endTx closes an ordinary action; applyStep closes an undo or a redo. A
  // recorder wired to one of them is one that reports a delete and then never
  // takes it back — see the top of undo.ts on why this is not per-mutator.
  const store = read("../stores/useTimelineStore.ts");
  const calls = [...store.matchAll(/noteBlockExclusions\(step, get\)/g)];
  assert.equal(calls.length, 2, "expected exactly the endTx and applyStep calls");
  const endTx = store.indexOf("function endTx(");
  const apply = store.indexOf("async function applyStep(");
  assert.ok(calls.some((m) => m.index! > endTx && m.index! < apply), "endTx does not record");
  assert.ok(calls.some((m) => m.index! > apply), "applyStep does not record");
});


/* ── a blank cut and a duplicate both have to leave the master track out ────
 *
 * `createBlankTimeline` and `duplicateTimeline` were written to stamp
 * `excluded_block_ids` for exactly this reason on the block side — before
 * `placed_audio_asset_ids` existed to say the same thing about the
 * storyboard's own audio asset. So a brand-new blank cut got the score put
 * back on it by the very first sync (nothing on it could ever satisfy
 * `present`), and a duplicate of a cut whose master track had been
 * deliberately removed got it back too (nothing to copy, nothing carried).
 * Both are silent: the row is created successfully and the music simply
 * reappears a moment later. */

test("createBlankTimeline seeds placed_audio_asset_ids, not just excluded_block_ids", () => {
  const src = read("./db/timeline.ts");
  const fn = src.slice(
    src.indexOf("export async function createBlankTimeline"),
    src.indexOf("\n}\n", src.indexOf("export async function createBlankTimeline")));
  assert.match(fn, /audioAssetId/, "a blank cut no longer asks the storyboard for its master track");
  assert.match(fn, /placed_audio_asset_ids: \[audioAssetId\]/,
    "a blank cut does not record the master track as already placed — it WILL come back");
});

test("duplicateTimeline carries placed_audio_asset_ids from the source row", () => {
  const src = read("./db/timeline.ts");
  const row = src.slice(
    src.indexOf("async function newTimelineRow"),
    src.indexOf("\n}\n", src.indexOf("async function newTimelineRow")));
  assert.match(row, /placed_audio_asset_ids: from\?\.placed_audio_asset_ids \?\? \[\]/,
    "newTimelineRow drops placed_audio_asset_ids — a duplicate of a cut whose "
    + "score was removed will get it back");
  // duplicateTimeline must actually PASS the source row as `from`, or the
  // field above has nothing to read.
  const dup = src.slice(
    src.indexOf("export async function duplicateTimeline"),
    src.indexOf("\n}\n", src.indexOf("export async function duplicateTimeline")));
  assert.match(dup, /newTimelineRow\(src\.timeline\.episode_id, name, src\.timeline\)/,
    "duplicateTimeline no longer hands newTimelineRow the source row");
});

test("Timeline carries the field so a duplicate's `from` can read it at all", () => {
  assert.match(read("./db/types.ts"), /placed_audio_asset_ids\?: string\[\];/);
});

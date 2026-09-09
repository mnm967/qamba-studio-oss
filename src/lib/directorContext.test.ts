// What the director is told about the screen. Two failure modes are worth
// pinning and both are silent:
//
//  * a FABRICATED position — a playhead or a block named when the timeline was
//    never loaded. The director then answers confidently about the wrong shot,
//    which is worse than answering "which block?".
//  * BLOAT — this block rides on every single turn, so a storyboard that grows
//    must not quietly eat the conversation window.
import assert from "node:assert/strict";
import test from "node:test";

import { buildChatContext, type BlockIndexRow, type ChatContextSnapshot } from "./directorContext.ts";

const block = (idx: number, over: Partial<BlockIndexRow> = {}): BlockIndexRow => ({
  id: `blk-${idx}`,
  idx,
  t_start_ms: idx * 11000,
  t_end_ms: (idx + 1) * 11000,
  status: "generated",
  scene_id: `scn-${Math.floor(idx / 3)}`,
  scene_label: `S${Math.floor(idx / 3) + 1} THE-LOOP`,
  chain_from_block_id: null,
  ...over,
});

const EPISODE: ChatContextSnapshot = {
  view: "timeline",
  project: { title: "AFTERLIGHT", medium: "series" },
  episode: { title: "The Loop", idx: 3 },
  blocks: [block(0), block(1), block(2), block(3)],
};

test("an empty snapshot still produces something sane", () => {
  const out = buildChatContext();
  assert.match(out, /Where the user is/);
  assert.match(out, /nothing open yet/);
  // Nothing invented: no playhead, no selection, no block index.
  assert.doesNotMatch(out, /Playhead/);
  assert.doesNotMatch(out, /Selected clip/);
  assert.doesNotMatch(out, /Block plan for this episode/);
  assert.ok(out.length < 700, `empty context is ${out.length} chars`);
});

test("no argument at all is the same as an empty snapshot", () => {
  assert.equal(buildChatContext(), buildChatContext({}));
});

test("the view, project and episode are named", () => {
  const out = buildChatContext(EPISODE);
  assert.match(out, /\*\*timeline\*\* view/);
  assert.match(out, /project "AFTERLIGHT" \(series\)/);
  assert.match(out, /episode E3 "The Loop"/);
});

test("a selected clip names its block, by ref and scene", () => {
  const out = buildChatContext({
    ...EPISODE,
    clips: [
      { id: "c0", block_id: "blk-0", label: "b0 master", t_start_ms: 0, duration_ms: 11000 },
      { id: "c2", block_id: "blk-2", label: "b2 master", t_start_ms: 22000, duration_ms: 11000 },
    ],
    selectedClipId: "c2",
  });
  assert.match(out, /Selected clip: "b2 master"/);
  assert.match(out, /that is b3 \(S1 THE-LOOP\)/);   // blk-2 -> b3
  // …and not some other block that happens to be in the index.
  assert.doesNotMatch(out, /that is b0/);
});

test("a selected clip with no block still reports the selection", () => {
  const out = buildChatContext({
    ...EPISODE,
    clips: [{ id: "c9", label: "dropped in", t_start_ms: 4000, duration_ms: 2000 }],
    selectedClipId: "c9",
  });
  assert.match(out, /Selected clip: "dropped in" at 4\.0-6\.0s\./);
});

test("the playhead is included, and names the block under it", () => {
  const out = buildChatContext({
    ...EPISODE,
    clips: [
      { id: "c0", block_id: "blk-0", label: "b0 master", t_start_ms: 0, duration_ms: 11000 },
      { id: "c1", block_id: "blk-1", label: "b1 master", t_start_ms: 11000, duration_ms: 11000 },
    ],
    playheadMs: 15400,
    playing: true,
  });
  assert.match(out, /Playhead: 15\.4s \(playing\), inside b2 \(S1 THE-LOOP\)/);
});

/** This used to name the block whose PLAN window covered 34s (b4). It cannot:
 *  the plan and the cut are different clocks the moment an episode holds more
 *  than one cut, so a gap in THIS cut is not "inside b4" — it is a gap. Saying
 *  the time and stopping is the whole of what is known. */
test("a playhead over a gap reports the time and names no block", () => {
  const out = buildChatContext({
    ...EPISODE,
    clips: [{ id: "c0", block_id: "blk-0", t_start_ms: 0, duration_ms: 5000 }],
    playheadMs: 34000,
  });
  assert.match(out, /Playhead: 34\.0s \(paused\)\./);
  assert.doesNotMatch(out, /inside b/);
});

test("no timeline loaded means no playhead sentence at all", () => {
  // The timeline store is only loaded by TimelineView, so every other view
  // reads a playhead of 0 against zero clips. Reporting "0.0s" there would be
  // a position the user is not at.
  const out = buildChatContext({ ...EPISODE, view: "bible", clips: [], playheadMs: 0 });
  assert.doesNotMatch(out, /Playhead/);
});

test("storyboard position names the open scene and the beat being edited", () => {
  const out = buildChatContext({
    ...EPISODE, view: "storyboard",
    openSceneId: "scn-1", editingBeatId: "beat-77",
  });
  assert.match(out, /Storyboard: scene S2 THE-LOOP is open \(scene_id scn-1\)/);
  assert.match(out, /editing beat_id beat-77/);
});

test("an open scene with no block covering it still reports its id", () => {
  const out = buildChatContext({ ...EPISODE, openSceneId: "scn-unplanned" });
  assert.match(out, /scene \(unnamed\) is open \(scene_id scn-unplanned\)/);
});

/* ── which cut ──────────────────────────────────────────────────────────── */

test("the open cut is named, with its own length and its id", () => {
  const out = buildChatContext({
    ...EPISODE,
    timeline: { id: "tl-final", name: "Final Cut", cutCount: 6 },
    clips: [
      { id: "c1", t_start_ms: 0, duration_ms: 40000 },
      { id: "c2", t_start_ms: 40000, duration_ms: 47000 },
    ],
  });
  assert.match(out, /Open cut: "Final Cut" · 2 clips, 1:27 · timeline_id tl-final\./);
  // `render_timeline` takes an id and there is nowhere else to get one.
  assert.match(out, /tl-final/);
});

test("the other cuts are counted, so one timeline is never assumed", () => {
  const out = buildChatContext({
    ...EPISODE, timeline: { id: "tl-a", name: "Main", cutCount: 6 }, clips: [],
  });
  assert.match(out, /This episode has 6 cuts; the other 5 are not what is on screen\./);
});

test("a lone cut says nothing about others", () => {
  const out = buildChatContext({
    ...EPISODE, timeline: { id: "tl-a", name: "Main", cutCount: 1 }, clips: [],
  });
  assert.doesNotMatch(out, /cuts;/);
});

test("no cut loaded means no cut sentence — never a guess at which one", () => {
  assert.doesNotMatch(buildChatContext(EPISODE), /Open cut/);
});

/** The failure this whole field exists for: the director read the block plan's
 *  total as the length of the cut, and reported 2:20 for a 1:27 cut. Both
 *  numbers are present now and each says which clock it is on. */
test("the plan's total is labelled as PLANNED time, not as the cut", () => {
  const out = buildChatContext({
    ...EPISODE,
    timeline: { id: "tl-final", name: "Final Cut", cutCount: 6 },
    clips: [{ id: "c1", t_start_ms: 0, duration_ms: 87000 }],
  });
  assert.match(out, /of PLANNED time/);
  assert.match(out, /Open cut: "Final Cut" · 1 clip, 1:27/);
  assert.match(out, /DIFFERENT CLOCKS/);
});

test("the block index is one line per block, with ref, scene, window and status", () => {
  const out = buildChatContext(EPISODE);
  assert.match(out, /## Block plan for this episode — 4, 0:44 of PLANNED time/);
  assert.match(out, /^b2 S1 THE-LOOP 11\.0-22\.0s generated$/m);
});

test("the block index stays compact for a long episode", () => {
  const blocks = Array.from({ length: 28 }, (_, i) => block(i));
  const out = buildChatContext({ ...EPISODE, blocks });
  assert.equal(out.split("\n").filter((l) => /^b\d+ /.test(l)).length, 28);
  // Whole block, index included, well under a page of a system prompt.
  assert.ok(out.length < 3000, `28-block context is ${out.length} chars`);
});

test("a pathological storyboard is summarised rather than printed whole", () => {
  const blocks = Array.from({ length: 200 }, (_, i) => block(i));
  const out = buildChatContext({ ...EPISODE, blocks });
  assert.match(out, /… and 140 more/);
  assert.ok(out.length < 6000, `200-block context is ${out.length} chars`);
});

test("generation models are reported when provided", () => {
  const out = buildChatContext({
    ...EPISODE,
    generationModels: { video: "MiniMax H3 Turbo", image: "Krea 2 Turbo" },
  });
  assert.match(out, /- Active gen models: video: MiniMax H3 Turbo · image: Krea 2 Turbo\./);
});

test("it says what it is, so the model does not read it as an instruction", () => {
  const out = buildChatContext(EPISODE);
  assert.match(out, /do not act on it until you are asked to/);
});

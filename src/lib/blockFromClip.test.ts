// Save as new block: the window it cuts, and what it refuses.
//
// Every failure here is silent in the output. A window one trim-gesture out of
// date still cuts, still registers a take, still lands on the lane — the block
// simply holds a different shot than the one on screen when the button was
// pressed. And a refusal that does not fire produces a block whose take
// contradicts its own clip, which `assemble_cut` then concatenates whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_BLOCK_MS, blockFromClipBlocker, blockFromClipPayload, clipGenRecipe,
  nearestLaneBlockId, sourceWindow,
} from "./blockFromClip.ts";
import type { Asset, Clip } from "./db/types";

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: "a1", project_id: "p1", kind: "video", b2_key: "blocks/EP01/006/master_x.mp4",
  content_type: "video/mp4", bytes: 1, width: 1280, height: 704, duration_ms: 5000,
  fps: 24, origin: "generated", source_job_id: null, meta: {}, tags: [],
  created_at: "2026-08-23T00:00:00Z", ...over,
} as Asset);

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: "c1", track_id: "t1", asset_id: "a1", block_id: "b1",
  t_start_ms: 50000, duration_ms: 2400, in_ms: 0, out_ms: 2400, ops: [],
  transition_in: null, gain_db: 0, label: "Block 7", linked_clip_id: null,
  audio_detached: false, audio_fx: [], post: null,
  updated_at: "2026-08-23T00:00:00Z", ...over,
} as Clip);

// ------------------------------------------------------------- the window ---

test("an untrimmed clip saves the whole take", () => {
  const w = sourceWindow(clip({ duration_ms: 5000, out_ms: 5000 }), asset());
  assert.deepEqual(w, { in_ms: 0, out_ms: 5000, duration_ms: 5000 });
});

test("a head trim starts the block where the clip starts", () => {
  const w = sourceWindow(clip({ in_ms: 1200, duration_ms: 2400 }), asset());
  assert.deepEqual(w, { in_ms: 1200, out_ms: 3600, duration_ms: 2400 });
});

test("the window is the PLAYED one, never out_ms", () => {
  // `_attach_to_clip` writes the whole render's length into `out_ms` while
  // only ever shrinking `duration_ms`, so the two disagree exactly where it
  // matters: reading `out_ms` here would save 4800ms of media for a clip that
  // is showing 2400 of it.
  const w = sourceWindow(clip({ in_ms: 0, duration_ms: 2400, out_ms: 4800 }), asset());
  assert.equal(w.out_ms, 2400);
});

test("the window never runs past the media", () => {
  // A clip longer than its own asset plays black past the end; ffmpeg would
  // simply stop, so the block would be shorter than the row claims.
  const w = sourceWindow(clip({ in_ms: 4000, duration_ms: 3000 }), asset({ duration_ms: 5000 }));
  assert.deepEqual(w, { in_ms: 4000, out_ms: 5000, duration_ms: 1000 });
});

test("an unprobed take is not clamped against a length nobody measured", () => {
  // An uploaded take registers before `asset_ingest` runs. Clamping against
  // null would cut every such block down to nothing.
  const w = sourceWindow(clip({ in_ms: 0, duration_ms: 2400 }), asset({ duration_ms: null }));
  assert.equal(w.out_ms, 2400);
});

// ----------------------------------------------------------- the refusals ---

test("a trimmed block clip is allowed", () => {
  assert.equal(blockFromClipBlocker(clip({ in_ms: 800, duration_ms: 2400 }), asset()), null);
});

test("a clip with no block is PROMOTABLE, not refused", () => {
  // The timeline's generate actions make blockless clips, and promotion is
  // what puts a landed extend/chain (or imported media) into the takes
  // system — the worker places it beside the nearest lane block.
  assert.equal(blockFromClipBlocker(clip({ block_id: null }), asset()), null);
});

test("a placeholder still is refused rather than cut into a one-frame block", () => {
  const why = blockFromClipBlocker(clip(), asset({ kind: "frame", b2_key: "f.png" }));
  assert.match(String(why), /placeholder/i);
});

test("a timeline effect is refused and NAMED", () => {
  // A block's take is the block's content — `assemble_cut` concatenates take
  // assets whole — so a take cut from media the crop was never applied to is a
  // block that plays differently from the lane it came from.
  const why = blockFromClipBlocker(
    clip({ ops: [{ op: "crop", x: 0, y: 0, w: 10, h: 10 }] as Clip["ops"] }), asset());
  assert.match(String(why), /crop/);
});

test("speed is refused, because the window mapping is 1:1 and would not be", () => {
  const why = blockFromClipBlocker(clip({ ops: [{ op: "speed", rate: 2 }] as Clip["ops"] }), asset());
  assert.match(String(why), /speed/);
});

test("a clip trimmed below the floor is refused", () => {
  const why = blockFromClipBlocker(clip({ duration_ms: MIN_BLOCK_MS - 1 }), asset());
  assert.match(String(why), /too short/i);
});

test("a jsonb ops column that is not an array does not crash the menu", () => {
  // ops is jsonb and is written by the worker, migrations and the director.
  assert.equal(blockFromClipBlocker(clip({ ops: null as unknown as Clip["ops"] }), asset()), null);
});

// ------------------------------------------------------------- the payload ---

test("the payload carries the window, not the clip", () => {
  // Sent explicitly so a drag between the enqueue and the claim cannot make
  // the pod save a different shot than the one that was asked for.
  const p = blockFromClipPayload(clip({ in_ms: 1200, duration_ms: 2400 }), asset());
  assert.equal(p.in_ms, 1200);
  assert.equal(p.out_ms, 3600);
  assert.equal(p.block_id, "b1");
  assert.equal(p.clip_id, "c1");
  assert.equal(p.asset_id, "a1");
});

test("the payload refuses exactly what the menu refuses", () => {
  // One rule, two consumers: a menu that greys the item and an action that
  // could otherwise queue a job the state no longer allows.
  assert.throws(() => blockFromClipPayload(
    clip({ ops: [{ op: "speed", rate: 2 }] as Clip["ops"] }), asset()), /speed/);
});

// ------------------------------------------------------------- promotion ---

test("a blockless clip's payload names its lane anchor, and a null block", () => {
  const p = blockFromClipPayload(clip({ block_id: null }), asset(),
                                 { afterBlockId: "b9" });
  assert.equal(p.block_id, null);
  assert.equal(p.after_block_id, "b9");
});

test("a lane with no blocks sends an explicit null anchor", () => {
  // The worker then appends to the episode's newest storyboard; an absent key
  // would be indistinguishable from a caller that forgot to look.
  const p = blockFromClipPayload(clip({ block_id: null }), asset(), {});
  assert.equal(p.after_block_id, null);
});

test("a block clip never carries an anchor — its source IS the anchor", () => {
  const p = blockFromClipPayload(clip(), asset(), { afterBlockId: "b9" });
  assert.equal(p.block_id, "b1");
  assert.equal("after_block_id" in p, false);
});

// ----------------------------------------------------- the lane neighbour ---

const lane = (id: string, t: number, block: string | null) =>
  ({ id, t_start_ms: t, block_id: block });

test("the nearest PRECEDING block clip wins", () => {
  const got = nearestLaneBlockId(
    [lane("c1", 0, "bA"), lane("c2", 5000, "bB"), lane("c3", 20000, "bC")],
    { id: "cx", t_start_ms: 12000 });
  assert.equal(got, "bB");
});

test("a clip before every block takes the first following one", () => {
  const got = nearestLaneBlockId(
    [lane("c2", 5000, "bB"), lane("c3", 20000, "bC")],
    { id: "cx", t_start_ms: 1000 });
  assert.equal(got, "bB");
});

test("blockless neighbours and the clip itself are invisible", () => {
  const got = nearestLaneBlockId(
    [lane("cx", 12000, null), lane("c1", 8000, null), lane("c2", 3000, "bA")],
    { id: "cx", t_start_ms: 12000 });
  assert.equal(got, "bA");
});

test("a lane with no blocks answers null, never a guess", () => {
  assert.equal(nearestLaneBlockId([lane("c1", 0, null)], { id: "cx", t_start_ms: 5 }), null);
});

// ------------------------------------------------------------- the recipe ---

test("a clip-born block's recipe is recognised by its prompt", () => {
  const r = clipGenRecipe({ clip_gen: { prompt: "she turns", mode: "i2v" } });
  assert.equal(r?.prompt, "she turns");
});

test("anything that is not a recipe is null — the beats path stays the default", () => {
  // The router sends these to PromptRefsModal; a false positive here would
  // strip a storyboard block of its whole retake surface.
  assert.equal(clipGenRecipe(null), null);
  assert.equal(clipGenRecipe({}), null);
  assert.equal(clipGenRecipe({ clip_gen: "yes" }), null);
  assert.equal(clipGenRecipe({ clip_gen: { prompt: "  " } }), null);
  assert.equal(clipGenRecipe({ clip_gen: [1] }), null);
});

// ---------------------------------------------------------------------------
// PLACEMENT is the save dialog's question, and the key is sent only when the
// answer is "append" — a worker that predates it must behave exactly as it
// always did rather than reading a key it does not know.

test("the default payload says nothing about placement", () => {
  const p = blockFromClipPayload(clip({ in_ms: 1200, duration_ms: 2400 }), asset());
  assert.equal("append" in p, false,
    "an absent key is the documented default, not `append: false`");
});

test("choosing 'add to the end' travels as append", () => {
  const p = blockFromClipPayload(clip({ in_ms: 1200, duration_ms: 2400 }), asset(),
    { append: true });
  assert.equal(p.append, true);
});

test("append is placement only — the window still travels with it", () => {
  // The trim is what the user was looking at when they pressed save; where the
  // block lands must not change WHAT is saved.
  const c = clip({ in_ms: 1200, duration_ms: 2400 });
  const plain = blockFromClipPayload(c, asset());
  const ended = blockFromClipPayload(c, asset(), { append: true });
  assert.equal(ended.in_ms, plain.in_ms);
  assert.equal(ended.out_ms, plain.out_ms);
  assert.equal(ended.asset_id, plain.asset_id);
});

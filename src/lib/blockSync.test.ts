/**
 * The take-swap rule, and the bug it exists to stop.
 *
 * REPORTED: "sometimes when a new take is added to the block, it causes the
 * block to become misaligned in the timeline." The block clip jumped back to
 * the position the PLANNER chose, leaving it overlapping or gapped against
 * neighbours the editor had packed around it.
 *
 * Everything below is about one property: nothing this function returns can
 * move a clip. `t_start_ms` is not in the patch type, and these tests are what
 * keep it out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIN_SYNC_MS, pinnedTakeAsset, takeSwapPatch } from "./blockSync.ts";

const clip = (over: Partial<Parameters<typeof takeSwapPatch>[0]> = {}) =>
  ({ asset_id: "old", duration_ms: 12000, in_ms: 0, ...over });

test("a take swap repoints the media and moves nothing", () => {
  const patch = takeSwapPatch(clip(), "new", 12000);
  assert.deepEqual(patch, { asset_id: "new" });
});

test("A CLIP THE EDITOR MOVED STAYS WHERE THE EDITOR PUT IT", () => {
  // The reported bug, stated as the property that failed. A packed lane, a
  // rippled delete and a drag all write `t_start_ms` and NOTHING else, so the
  // clip reads as untrimmed — which is exactly the state the old code took as
  // permission to rewrite its position from the block.
  const patch = takeSwapPatch(clip({ in_ms: 0, duration_ms: 12000 }), "new", 20000);
  assert.ok(!("t_start_ms" in patch),
    "the sync is moving a block clip again — a packed cut will jump on the next take");
});

test("a trim survives a new take", () => {
  // The half that was already fixed, kept fixed: neither end of a cut window
  // may be rewritten from the block's planned duration.
  const patch = takeSwapPatch(clip({ in_ms: 2000, duration_ms: 5000 }), "new", 12000);
  assert.deepEqual(patch, { asset_id: "new" });
});

test("a shorter take clamps the clip rather than leaving it playing black", () => {
  // 12s of clip over 8s of media is 4s of black and a preview parked on
  // "buffering…". Shrinking is the same rule `_attach_to_clip` follows.
  const patch = takeSwapPatch(clip({ in_ms: 0, duration_ms: 12000 }), "new", 8000);
  assert.deepEqual(patch, { asset_id: "new", duration_ms: 8000, out_ms: 8000 });
});

test("the clamp counts from the clip's IN point, not from zero", () => {
  const patch = takeSwapPatch(clip({ in_ms: 3000, duration_ms: 9000 }), "new", 8000);
  assert.deepEqual(patch, { asset_id: "new", duration_ms: 5000, out_ms: 8000 });
});

test("it never GROWS a clip — that would overlap whatever is next on the lane", () => {
  const patch = takeSwapPatch(clip({ in_ms: 0, duration_ms: 4000 }), "new", 60000);
  assert.equal(patch.duration_ms, undefined);
});

test("an unmeasured take leaves the window alone", () => {
  // An uploaded take registers before `asset_ingest` probes it. Clamping
  // against a length nobody has measured would cut every clip to the floor.
  for (const media of [null, undefined, 0]) {
    assert.deepEqual(takeSwapPatch(clip(), "new", media), { asset_id: "new" },
      `duration_ms ${String(media)} must not be read as "the take is empty"`);
  }
});

test("a clip is never clamped away to nothing", () => {
  // Unselectable is unfixable: there would be no way to repair it by hand.
  const patch = takeSwapPatch(clip({ in_ms: 11900, duration_ms: 12000 }), "new", 12000);
  assert.equal(patch.duration_ms, MIN_SYNC_MS);
});

/* ── the half that reaches Supabase, pinned by parsing its source ────────────
 *
 * `syncBlocksToTimeline` is almost entirely Supabase calls, so there is
 * nothing to call — the same situation `blockExclusions.test.ts` and
 * `scoreTrack.test.ts` are in, and the same answer. Weak on purpose, and
 * still stronger than nothing: both failures below are silent at runtime. */

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

test("the sync writes t_start_ms only on the INSERT, never on a repoint", () => {
  const insert = SYNC.indexOf("insertClip({");
  assert.ok(insert > 0, "the insert branch is gone");
  const writes = [...SYNC.matchAll(/t_start_ms:/g)].map((m) => m.index ?? -1);
  assert.deepEqual(writes.filter((i) => i < insert), [],
    "something above the insert is writing t_start_ms again — a moved block " +
    "clip will jump back to its planned position on the next take");
});

test("every clip of a block is repointed, not whichever the read returned last", () => {
  // `splitAt` copies `block_id` onto both halves, and live cuts carry exact
  // duplicate block clips. Keyed by block in a plain Map, the others went on
  // playing the take they were repointed off — measured: 9 blocks whose clips
  // were already playing two different takes.
  assert.match(SYNC, /new Map<string, Placed\[\]>/,
    "the block lookup holds one clip per block again — the others will keep " +
    "playing a superseded take");
  assert.match(SYNC, /for \(const clip of stale\)/);
});

test("the repoint goes through the rule above rather than reimplementing it", () => {
  assert.match(SYNC, /takeSwapPatch\(/);
});

// ---------------------------------------------------- where a new one lands
import { placeNewBlockClip } from "./blockSync.ts";

const lane = (id: string, block: string | null, at: number, dur: number, track = "v1") =>
  ({ id, block_id: block, track_id: track, t_start_ms: at, duration_ms: dur, linked_clip_id: null });
const row = (id: string, idx: number, at: number) => ({ id, idx, t_start_ms: at });

test("a new block lands after its predecessor's clip and pushes the rest along", () => {
  // b1 and b3 are on the lane; b2 was just added between them, with a PLAN
  // window (12000) that is nowhere near where the cut has b1 (it was moved).
  const blocks = [row("b1", 0, 0), row("b2", 1, 12000), row("b3", 2, 18000)];
  const clips = [lane("c1", "b1", 30000, 6000), lane("c3", "b3", 36000, 6000), lane("cx", null, 50000, 2000)];
  const p = placeNewBlockClip(blocks[1], blocks, clips, 6000, "v1");
  assert.equal(p.atMs, 36000, "right after b1's clip, on the cut's clock, not the plan's");
  assert.equal(p.afterBlockId, "b1");
  assert.deepEqual(p.shift, [{ id: "c3", t_start_ms: 42000 }, { id: "cx", t_start_ms: 56000 }],
                   "everything from that point moves right by the new clip's length");
});

test("a predecessor in several pieces is followed after its LAST piece", () => {
  const blocks = [row("b1", 0, 0), row("b2", 1, 6000)];
  const clips = [lane("c1a", "b1", 0, 3000), lane("c1b", "b1", 3000, 3000)];
  const p = placeNewBlockClip(blocks[1], blocks, clips, 4000, "v1");
  assert.equal(p.atMs, 6000);
  assert.deepEqual(p.shift, []);
});

test("with no earlier block on the cut it goes in front of the nearest later one", () => {
  const blocks = [row("b1", 0, 0), row("b2", 1, 6000), row("b3", 2, 12000)];
  const clips = [lane("c3", "b3", 9000, 6000)];
  const p = placeNewBlockClip(blocks[0], blocks, clips, 6000, "v1");
  assert.equal(p.atMs, 9000);
  assert.equal(p.afterBlockId, null);
  assert.deepEqual(p.shift, [{ id: "c3", t_start_ms: 15000 }]);
});

test("an empty cut keeps the plan window, which is how a fresh episode lays down", () => {
  const blocks = [row("b1", 0, 0), row("b2", 1, 6000)];
  const p = placeNewBlockClip(blocks[1], blocks, [], 6000, "v1");
  assert.equal(p.atMs, 6000);
  assert.equal(p.trackId, "v1");
  assert.deepEqual(p.shift, []);
});

test("it joins the lane its predecessor is on, and only that lane moves", () => {
  const blocks = [row("b1", 0, 0), row("b2", 1, 6000)];
  const clips = [lane("c1", "b1", 0, 6000, "v2"), lane("other", null, 6000, 3000, "v1")];
  const p = placeNewBlockClip(blocks[1], blocks, clips, 6000, "v1");
  assert.equal(p.trackId, "v2");
  assert.deepEqual(p.shift, [], "a clip on another lane is not in the way");
});

test("a clip starting exactly where the new one lands is pushed, not overlapped", () => {
  const blocks = [row("b1", 0, 0), row("b2", 1, 6000), row("b3", 2, 12000)];
  const clips = [lane("c1", "b1", 0, 6000), lane("c3", "b3", 6000, 6000)];
  const p = placeNewBlockClip(blocks[1], blocks, clips, 6000, "v1");
  assert.deepEqual(p.shift, [{ id: "c3", t_start_ms: 12000 }]);
});


/* ── two copies of a block, two takes ──────────────────────────────────────
 *
 * A block can be on a cut more than once, and the reason to put a shot down
 * twice is to show two takes of it. That was not expressible: the sync
 * repointed EVERY clip of a block at its `active_take_id` and has to — that
 * repoint is how "activate this take" reaches a lane nobody had open — so a
 * hand-picked take survived until the next take landed, the next re-render or
 * the next reload, and then quietly became the block's again. `clips.take_id`
 * is the record that separates "deliberately playing take 2" from "has not
 * caught up to take 3", which are the same thing seen from outside. */

const takes: Record<string, { asset_id: string; block_id: string }> = {
  "t1": { asset_id: "a1", block_id: "b1" },
  "t2": { asset_id: "a2", block_id: "b1" },
  "other": { asset_id: "a9", block_id: "b9" },
};
const takeOf = (id: string) => takes[id];

test("no pin means follow the block — which is every clip that exists today", () => {
  assert.equal(pinnedTakeAsset(null, "b1", takeOf), null);
  assert.equal(pinnedTakeAsset(undefined, "b1", takeOf), null);
});

test("a pin names the media that copy plays", () => {
  assert.equal(pinnedTakeAsset("t2", "b1", takeOf), "a2");
});

test("A PIN NAMING ANOTHER BLOCK'S TAKE IS IGNORED", () => {
  // `take_id` is an ordinary uuid and a clip's `block_id` moves under it —
  // `block_from_clip` promotes a clip to a block of its own, and a copied clip
  // carries both fields. Honouring it would repoint a shot at a DIFFERENT
  // shot's footage: renders perfectly, wrong film, nothing to see.
  assert.equal(pinnedTakeAsset("other", "b1", takeOf), null);
});

test("a pin whose take has been deleted falls back to the block", () => {
  // The FK is `on delete set null`, so this is belt to that brace — and it is
  // what covers the window before a local project's own delete runs.
  assert.equal(pinnedTakeAsset("gone", "b1", takeOf), null);
});

test("the sync asks per CLIP, not per block", () => {
  // One answer for the whole block is what made two copies unable to show two
  // takes. `wantOf` is that question; `stale` and the patch both have to use
  // it, or the sync decides correctly and then writes the old answer.
  assert.match(SYNC, /const wantOf = \(c: Placed\) =>/);
  assert.match(SYNC, /pinnedTakeAsset\(c\.take_id, b\.id,/);
  assert.match(SYNC, /placed\.filter\(\(c\) => c\.asset_id !== wantOf\(c\)\)/);
  assert.match(SYNC, /takeSwapPatch\(clip, want, mediaMs\.get\(want\)\)/);
});

test("the take fetch asks for PINNED takes as well as active ones", () => {
  // A pinned take that is not any block's active one is not in that `.in()`
  // otherwise — so it resolves to nothing, the clip falls back to the block's
  // take, and the pin is undone on the very next sync. The clip read has to
  // come FIRST for the same reason.
  assert.match(SYNC, /select\("id,block_id,take_id,asset_id/,
               "the sync no longer reads take_id off the clips");
  assert.match(SYNC, /\.\.\.pinnedIds\]/,
               "the take fetch does not include the pinned takes");
  assert.ok(SYNC.indexOf("const pinnedIds") < SYNC.indexOf('from("block_takes")'),
            "the clips are read AFTER the takes — a pin cannot be resolved");
});


/* ── and the surface that sets one ─────────────────────────────────────────
 *
 * The strip is shown for the SELECTED clip and reads its block off it, so with
 * a block on the cut twice "use this take" stops being one question. Parsed
 * rather than called: TakesStrip reaches supabase at import. */

const STRIP = (() => {
  const src = read("../components/shell/TakesStrip.tsx");
  const at = src.indexOf("export default function TakesStrip");
  assert.ok(at > 0, "TakesStrip is gone");
  return src.slice(at);
})();

test("a take a person picks is PINNED, not just repointed", () => {
  // Writing `asset_id` alone lasts until the next take lands, the next
  // re-render or the next reload — the sync then puts the block's take back
  // with nothing saying so, which is the whole failure being fixed.
  assert.match(STRIP, /take_id: t\.id/,
               "picking a take writes no pin — it will be undone by the next sync");
});

test("with ONE copy on the cut, picking a take still activates it", () => {
  // Pinning and activating cannot differ there, and activating is the one
  // that also moves the storyboard and a chained block's anchor. Every
  // project that has never duplicated a block is unchanged by all of this.
  assert.match(STRIP, /many \? useHere\(t\) : activate\(t\)/);
});

test("picking the block's OWN take is how a copy stops being pinned", () => {
  // The way out, without a control: pinning a copy to the take the block is
  // already on says nothing that following it does not, and the unpinned
  // state is the one that keeps up when the block moves. Without this the pin
  // is a one-way door — the same "the user slot cannot be undone" bug the
  // scene editor's own clear-still exists for.
  assert.match(STRIP, /const follows = t\.id === block\.active_take_id/);
  assert.match(STRIP, /take_id: follows \? null : t\.id/);
});

test("activating clears the pin rather than leaving a redundant one", () => {
  // A pin naming the take the block now uses says nothing, and would outlive
  // the next block-wide change as a silent divergence.
  assert.match(STRIP, /active_take_id: t\.id[\s\S]{0,400}?take_id: null/);
});

test("the copy count is PICTURE clips, not a detached audio half", () => {
  // `detachedClipFrom` copies `block_id` onto the sound, and a block's sound
  // is not a second copy of the shot — counted, every detached block would
  // read as duplicated and the strip would stop activating anything.
  assert.match(STRIP, /videoLanes\.has\(c\.track_id\)/);
  assert.match(STRIP, /c\.id !== clip\.id/,
               "a clip counts itself as a copy — every block would read as duplicated");
});

test("the lit tile is what THIS clip plays", () => {
  // Not `block.active_take_id`: on a pinned copy that lights a take the clip
  // is not playing, which is the one thing this strip must not get wrong.
  assert.match(STRIP, /const playing = clip\.take_id \?\? block\.active_take_id/);
  assert.match(STRIP, /const here = t\.id === playing/);
});

/* ── the placeholder, and the duplicate that landed beside it ──────────────
 *
 * REPORTED: "when a chain or extension is finished rendering and put into
 * timeline, instead of just replacing the placeholder it creates duplicates."
 *
 * `_publish_clip_block` inserts the block and activates its take BEFORE
 * `_attach_to_clip` writes `block_id` onto the still the modal parked on the
 * lane. In between, the block is a kept take with no clip — the insert
 * branch's own condition — so the sync laid a second clip of it on the cut.
 * Confirmed on the live data: 11 chain and 4 extension blocks carrying two
 * picture clips on one cut, and every duplicated one was inserted with 33+
 * blocks after it (average 46) against 30 for the ones that came out clean —
 * which is `_relabel_block_clips`, one sequential round trip per renumbered
 * block, holding the window open for seconds. */
import { placeholderClipFor, placeholderStillId } from "./blockSync.ts";

const free = (id: string, asset: string, over: Record<string, unknown> = {}) =>
  ({ id, block_id: null, take_id: null, asset_id: asset, ...over });
const recipe = (start: string | null) =>
  ({ clip_gen: start === null ? {} : { start_asset_id: start }, clip_kind: "chain" });

test("A LANDING CHAIN FINDS THE STILL IT WAS PARKED ON", () => {
  const clips = [free("c1", "someone-else"), free("ph", "frame-a")];
  assert.equal(placeholderClipFor(recipe("frame-a"), clips)?.id, "ph");
});

test("a clip that already names a block is somebody else's", () => {
  // The commonest way to get this wrong: adopt the clip of the block the
  // extension was made FROM, which points at that block's own media and
  // would repoint a finished shot at the extension.
  const clips = [free("taken", "frame-a", { block_id: "b-source" })];
  assert.equal(placeholderClipFor(recipe("frame-a"), clips), null);
});

test("a PINNED clip is never adopted", () => {
  // `clips.take_id` is a deliberate choice — a block on the cut twice showing
  // two takes — and overwriting it is the failure `pinnedTakeAsset` exists for.
  const clips = [free("pin", "frame-a", { take_id: "t9" })];
  assert.equal(placeholderClipFor(recipe("frame-a"), clips), null);
});

test("ONE PLACEHOLDER CANNOT SERVE TWO BLOCKS", () => {
  // Two chains can land in one pass; without the claimed set the second would
  // adopt the first's clip and the first block would lose its picture.
  const clips = [free("ph", "frame-a")];
  const claimed = new Set(["ph"]);
  assert.equal(placeholderClipFor(recipe("frame-a"), clips, claimed), null);
});

test("add_after has no frame to match on, so nothing is adopted", () => {
  // Its placeholder points at the SOURCE clip's own media, which is a real
  // shot on the lane — matching on that would eat it. That mode is covered by
  // the worker claiming the clip instead.
  const clips = [free("ph", "frame-a")];
  assert.equal(placeholderStillId(recipe(null)), null);
  assert.equal(placeholderClipFor(recipe(null), clips), null);
  assert.equal(placeholderClipFor({}, clips), null);
  assert.equal(placeholderClipFor(null, clips), null);
});

test("a planner block is not clip-born and is placed as it always was", () => {
  assert.equal(placeholderStillId({ review: true }), null);
});

test("THE SYNC ADOPTS BEFORE IT INSERTS", () => {
  // Order is the whole fix: reached after the insert, the duplicate is
  // already on the lane.
  const adopt = SYNC.indexOf("placeholderClipFor(");
  const insert = SYNC.indexOf("insertClip({");
  assert.ok(adopt > 0, "the sync no longer looks for the placeholder — a "
    + "landing chain will lay a second clip beside the one it was parked on");
  assert.ok(adopt < insert, "the placeholder lookup moved below the insert");
  assert.match(SYNC, /claimed\.add\(/,
    "nothing marks an adopted clip taken — two blocks landing in one pass "
    + "will both claim it");
});

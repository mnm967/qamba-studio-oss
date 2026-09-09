// Copy / paste / duplicate: where a copy lands, and what it is made of.
//
// Every case here is silent in the output rather than loud. An overlapping
// paste loses a shot the player simply never picks; a copied
// `linked_clip_id` makes a delete take somebody else's audio away; a copied
// `transition_in` plays a dissolve rendered for a different cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyLabel, firstFreeAt, nextCopyLabel, pairOf, pasteTarget, seedFrom,
  type ClipboardEntry,
} from "./clipClipboard.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Clip, Track } from "./db/types";

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: "c1", track_id: "v1", asset_id: "a1", block_id: "b1",
  t_start_ms: 4000, duration_ms: 2000, in_ms: 300, out_ms: 2300, ops: [],
  transition_in: null, gain_db: 0, label: "Block 7", linked_clip_id: null,
  audio_detached: false, audio_fx: [], post: null,
  updated_at: "2026-08-23T00:00:00Z", ...over,
} as Clip);

const track = (over: Partial<Track> = {}): Track => ({
  id: "v1", timeline_id: "t", kind: "video", idx: 0, name: "V1", muted: false,
  solo: false, locked: false, gain_db: 0, duck_under_track_id: null, automation: [],
  ...over,
} as Track);

const box = (t: number, d: number) => ({ t_start_ms: t, duration_ms: d });

// ------------------------------------------------------------- placement ---

test("an empty lane takes the copy exactly where it was asked for", () => {
  assert.equal(firstFreeAt([[]], 4000, 2000), 4000);
});

test("a copy slides past whatever is in the way", () => {
  // Sliding rather than rippling: nobody else's clip moves, and on a lane
  // holding a linked clip a ripple would slide dialogue off its own shot.
  assert.equal(firstFreeAt([[box(4000, 3000)]], 4000, 2000), 7000);
});

test("it keeps sliding through a run of clips", () => {
  const lane = [box(0, 1000), box(1000, 1000), box(2000, 1000)];
  assert.equal(firstFreeAt([lane], 0, 500), 3000);
});

test("a gap big enough is used rather than the end of the lane", () => {
  assert.equal(firstFreeAt([[box(0, 1000), box(3000, 1000)]], 0, 1500), 1000);
});

test("touching ends do not count as overlapping", () => {
  // Two blocks back to back is exactly what a lane should hold.
  assert.equal(firstFreeAt([[box(0, 2000)]], 2000, 1000), 2000);
});

test("a linked pair needs BOTH lanes free at the same instant", () => {
  // Their geometry is mirrored, so they cannot be placed independently: the
  // picture's lane is clear at 2000 and the sound's is not.
  const picture = [box(0, 2000)];
  const sound = [box(0, 5000)];
  assert.equal(firstFreeAt([picture, sound], 0, 1000), 5000);
});

test("a negative or fractional request is cleaned up", () => {
  // `clips.t_start_ms` is an int column: an unrounded local value differs from
  // the row Postgres stores, and the next reconcile reports a change that
  // never happened.
  assert.equal(firstFreeAt([[]], -50, 1000), 0);
  assert.equal(firstFreeAt([[]], 1000.4, 1000), 1000);
});

// ----------------------------------------------------------------- naming ---

test("a copy is named as one", () => {
  assert.equal(copyLabel("Block 7"), "Block 7 copy");
});

test("copying a copy counts rather than stuttering", () => {
  assert.equal(copyLabel("Block 7 copy"), "Block 7 copy 2");
  assert.equal(copyLabel("Block 7 copy 2"), "Block 7 copy 3");
});

test("an unnamed clip still gets a name", () => {
  assert.equal(copyLabel(null), "clip copy");
});

// ------------------------------------------------------------- what carries ---

test("the media and its window travel", () => {
  const s = seedFrom(clip(), { trackId: "v2", tStartMs: 9000 });
  assert.equal(s.asset_id, "a1");
  assert.equal(s.in_ms, 300);
  assert.equal(s.out_ms, 2300);
  assert.equal(s.duration_ms, 2000);
  assert.equal(s.track_id, "v2");
  assert.equal(s.t_start_ms, 9000);
});

test("the block link travels — a duplicated block clip is still that block", () => {
  // `splitAt` already puts several clips on one block, and
  // `syncBlocksToTimeline` repoints every one of them.
  assert.equal(seedFrom(clip(), { trackId: "v1", tStartMs: 0 }).block_id, "b1");
});

test("the look and the sound travel", () => {
  const s = seedFrom(clip({
    ops: [{ op: "crop", x: 0, y: 0, w: 5, h: 5 }] as Clip["ops"],
    gain_db: -6, audio_fx: [{ id: "eq", params: {} }], post: { upscale: true } as Clip["post"],
  }), { trackId: "v1", tStartMs: 0 });
  assert.equal(s.ops.length, 1);
  assert.equal(s.gain_db, -6);
  assert.equal(s.audio_fx.length, 1);
  assert.deepEqual(s.post, { upscale: true });
});

test("a detached clip's silence travels", () => {
  // Dropping `audio_detached` would make the copy play audio the original
  // does not — and next to its still-detached sibling, in doubled.
  assert.equal(seedFrom(clip({ audio_detached: true }), { trackId: "v1", tStartMs: 0 })
    .audio_detached, true);
});

test("the A/V link is NOT copied", () => {
  // Three clips claiming one partner: `unlinkAudio`, `reattachAudio` and
  // `removeClip` all follow that id, so the copy's delete would take the
  // ORIGINAL's sound away. The store links the two copies to each other once
  // both rows exist.
  const s = seedFrom(clip({ linked_clip_id: "aud1" }), { trackId: "v1", tStartMs: 0 });
  assert.ok(!("linked_clip_id" in s));
});

test("the transition is NOT copied", () => {
  // It describes the join with the PREVIOUS clip, and a copy has a different
  // neighbour. A `generated` one names an asset rendered between two specific
  // shots — the copy would play a dissolve built for a cut that is not this.
  const s = seedFrom(clip({
    transition_in: { type: "generated", dur_ms: 800, asset_id: "tr1" },
  }), { trackId: "v1", tStartMs: 0 });
  assert.ok(!("transition_in" in s));
});

// ------------------------------------------------------------ paste target ---

const V1 = track({ id: "v1", kind: "video", idx: 0, name: "V1" });
const V2 = track({ id: "v2", kind: "video", idx: 1, name: "V2" });
const A1 = track({ id: "a1", kind: "audio", idx: 0, name: "A1" });
const entry = (over: Partial<ClipboardEntry> = {}): ClipboardEntry =>
  ({ clip: clip(), partner: null, kind: "video", ...over });

test("a paste lands on the lane the user aimed at", () => {
  const t = pasteTarget(entry(), [V1, V2, A1], "v2");
  assert.deepEqual("error" in t ? t : t.main.id, "v2");
});

test("pasting a picture onto an audio lane is refused, with a reason", () => {
  // The mixer would feed a video row to ffmpeg as an audio input and the
  // player would render it in an <audio> element.
  const t = pasteTarget(entry(), [V1, A1], "a1");
  assert.match("error" in t ? t.error : "", /picture clip/i);
});

test("a locked lane is refused by name", () => {
  const t = pasteTarget(entry(), [track({ id: "v1", locked: true, name: "V1" })], "v1");
  assert.match("error" in t ? t.error : "", /V1 is locked/);
});

test("with no lane aimed at, the first unlocked one of the right kind is used", () => {
  const t = pasteTarget(entry(), [V2, V1, A1], null);
  assert.equal("error" in t ? t.error : t.main.id, "v1");
});

test("a linked pair is given a lane for each half", () => {
  const t = pasteTarget(
    entry({ partner: clip({ id: "c2", track_id: "a1" }) }), [V1, A1], "v1");
  assert.equal("error" in t ? t.error : t.main.id, "v1");
  assert.equal("error" in t ? "" : t.partner?.id, "a1");
});

test("a pair with nowhere to put its sound is refused rather than half pasted", () => {
  // Pasting only the picture leaves an `audio_detached` clip with no audio
  // clip — silent, with nothing on screen saying so.
  const t = pasteTarget(entry({ partner: clip({ id: "c2", track_id: "a1" }) }), [V1], "v1");
  assert.match("error" in t ? t.error : "", /audio lane/i);
});

test("no lane at all is a refusal, not a crash", () => {
  assert.match("error" in pasteTarget(entry(), [], null)
    ? (pasteTarget(entry(), [], null) as { error: string }).error : "", /no unlocked video lane/i);
});


// ------------------------------------------------------ which half is which ---
const PIC = clip({ id: "v", track_id: "v1", audio_detached: true, linked_clip_id: "a" });
const SND = clip({ id: "a", track_id: "a1", audio_detached: false, linked_clip_id: "v" });

test("copying the picture keeps it as the main half", () => {
  const e = pairOf(PIC, SND, "video");
  assert.equal(e.clip.id, "v");
  assert.equal(e.partner?.id, "a");
  assert.equal(e.kind, "video");
});

test("copying the SOUND of a pair still makes the picture the main half", () => {
  // Rebuilt the other way round, the paste writes a sound clip as the main
  // half with a picture linked back to it and never silenced — so the copy
  // plays its audio from both lanes at once, which is a comb filter rather
  // than a louder take.
  const e = pairOf(SND, PIC, "audio");
  assert.equal(e.clip.id, "v");
  assert.equal(e.partner?.id, "a");
  assert.equal(e.kind, "video", "the main half is a picture, so the lane kind is too");
});

test("an unlinked clip is its own main half", () => {
  const e = pairOf(clip({ id: "solo", track_id: "a1" }), null, "audio");
  assert.equal(e.clip.id, "solo");
  assert.equal(e.partner, null);
  assert.equal(e.kind, "audio");
});

test("a linked pair where NEITHER is detached keeps the clicked half", () => {
  // Unlink leaves `audio_detached` alone on purpose, and a hand-made link has
  // never had it — with no picture to find, the half in hand is the answer.
  const a = clip({ id: "x", track_id: "a1", linked_clip_id: "y" });
  const b = clip({ id: "y", track_id: "a2", linked_clip_id: "x" });
  assert.equal(pairOf(a, b, "audio").clip.id, "x");
  assert.equal(pairOf(a, b, "audio").kind, "audio");
});


/* ── a block dropped twice ─────────────────────────────────────────────────
 *
 * Dragging a block from the shots rail onto a lane REFUSED a second copy
 * ("Block 8 is already on the timeline") — while the rail's own tooltip said
 * "drag onto a lane to place another copy", ⌘D on a block clip made one, and
 * `splitAt` made two out of one. The sync has keyed its repoint and its
 * relabel to a LIST of clips per block since it was measured finding 51
 * blocks with more than one, so nothing downstream ever needed the rule the
 * refusal implied.
 *
 * The loud half of that is now fixed by removing a branch. The SILENT half is
 * the name: two clips both reading "Block 8" are indistinguishable on the
 * lane, and the sync leaves anything that is not one of the studio's own auto
 * forms alone, so nothing downstream would ever tell them apart either. */

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const DROP_BLOCK = (() => {
  const src = readSrc("../components/shell/WsTimeline.tsx");
  const at = src.indexOf("const dropBlock = async (");
  assert.ok(at > 0, "dropBlock is gone from WsTimeline");
  const end = src.indexOf("\n  };", at);
  assert.ok(end > at, "could not find the end of dropBlock");
  return src.slice(at, end);
})();

test("nextCopyLabel takes the first free name rather than stuttering", () => {
  assert.equal(nextCopyLabel("Block 8", []), "Block 8 copy");
  assert.equal(nextCopyLabel("Block 8", ["Block 8"]), "Block 8 copy");
  assert.equal(nextCopyLabel("Block 8", ["Block 8", "Block 8 copy"]), "Block 8 copy 2");
  assert.equal(
    nextCopyLabel("Block 8", ["Block 8", "Block 8 copy", "Block 8 copy 2"]),
    "Block 8 copy 3");
});

test("nextCopyLabel reads names rather than parsing them", () => {
  // Case and surrounding space are how a label is TYPED, not what it means —
  // "block 8 copy" beside "Block 8 copy" is two rows nobody can tell apart.
  assert.equal(nextCopyLabel("Block 8", ["  BLOCK 8 COPY  "]), "Block 8 copy 2");
  assert.equal(nextCopyLabel("Block 8", ["", "   "]), "Block 8 copy",
               "a blank label is not a name in use");
});

test("a gap in the numbering is filled, not skipped", () => {
  // Delete "Block 8 copy" and the next drop takes its name back. Counting the
  // clips instead would leave the gap open forever and drift the numbers away
  // from what is on the lane.
  assert.equal(nextCopyLabel("Block 8", ["Block 8", "Block 8 copy 2"]), "Block 8 copy");
});

test("dropping a block already on the cut is no longer refused", () => {
  assert.ok(!/is already on the timeline/.test(DROP_BLOCK),
            "the drop handler refuses a duplicate again — the rail's own tooltip offers one");
});

test("the second copy is NAMED, or the lane holds two identical rows", () => {
  assert.match(DROP_BLOCK, /nextCopyLabel\(/);
  // The bare block name may only be used when nothing of this block is on the
  // cut. Passing `name` straight to insertAsset is the silent regression:
  // the drop works, and two rows read "Block 8".
  assert.ok(!/label: name,/.test(DROP_BLOCK),
            "the dropped clip takes the bare block name whether or not it is a copy");
  assert.match(DROP_BLOCK, /const already = \w+\.filter\(/,
               "nothing counts the copies already on the cut");
});

test("a copy is a PICTURE clip, not a surviving detached audio half", () => {
  // `detachedClipFrom` copies `block_id` onto the sound. Counting every lane
  // is what made the old refusal unrecoverable: delete a block's picture,
  // keep its detached audio, and the rail could never put the picture back
  // because the block still read as "already on the timeline".
  assert.match(DROP_BLOCK, /videoLanes\.has\(c\.track_id\)/,
               "the copy count spans audio lanes — a detached half reads as a copy");
});

test("an automatic insert still refuses a duplicate", () => {
  // A drag is a gesture; a placeholder is not. `placeBlockPlaceholder` puts a
  // block's place on the cut while its FIRST render runs, so a block that is
  // already there needs nothing — and a copy appearing on its own is not an
  // edit anybody made.
  const ph = readSrc("./blockPlaceholder.ts");
  assert.match(ph, /if \(store\.clips\.some\(\(c\) => c\.block_id === blockId\)\) return "already";/);
});

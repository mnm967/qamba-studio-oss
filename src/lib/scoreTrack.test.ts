/**
 * The film-score half of `syncBlocksToTimeline`, pinned by parsing its source.
 *
 * `syncMasterTrack` is not exported and every line of it is a Supabase call,
 * so there is nothing to call in a unit test — the same situation
 * `worker/tests/test_review_gate.py` is in, and the same answer: read the
 * function's own text and assert the shape of the decision.
 *
 * The bug this exists to prevent was live for as long as a film could have a
 * score. `syncMasterTrack` muted the base VIDEO track whenever the storyboard
 * carried `audio_asset_id`. That rule is correct for a locked-audio music
 * video, where the takes have the same master baked in and a second copy on
 * A1 would double it — and catastrophic for a film, where the takes carry
 * H3's native DIALOGUE and the column holds a generated score. Opening the
 * timeline silenced the entire film and left only the music, with nothing on
 * screen saying so.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// Normalised to LF before anything indexes into it: git's default on Windows
// is core.autocrlf=true, and a regex `.` does not match `\r` — which is how a
// source-parsing test comes back reporting "found 0" instead of failing.
const SRC = readFileSync(new URL("./db/timeline.ts", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

const FN = (() => {
  const at = SRC.indexOf("async function syncMasterTrack");
  assert.ok(at > 0, "syncMasterTrack is gone — did it move or get renamed?");
  const end = SRC.indexOf("\n}\n", at);
  assert.ok(end > at, "could not find the end of syncMasterTrack");
  return SRC.slice(at, end);
})();

test("the picture is muted only for a LOCKED track, never for a score", () => {
  const mute = FN.indexOf('.update({ muted: true })');
  assert.ok(mute > 0, "the video-track mute is gone entirely");
  const gate = FN.search(/if \(isLocked[ &)]/);
  assert.ok(gate >= 0, "isLocked gate is missing — a film's dialogue will be muted");
  assert.ok(gate < mute, "the mute is not inside the isLocked branch");
});

test("…and only while the master track is actually going onto the lane", () => {
  // MUTING V1 IS PART OF PLACING THE TRACK. Re-asserting it for a master the
  // editor has REMOVED leaves the cut silent with the picture's own audio
  // switched off — the same failure as muting a film for its score, reached
  // from the other side.
  assert.match(FN, /if \(isLocked && \(present \|\| !placed\.has\(audioId\)\)\)/,
    "the mute is unconditional on isLocked again");
});

test("locked is read off the BLOCKS, not off the project's medium", () => {
  // The block is what actually rendered. A project whose medium says one thing
  // and whose blocks rendered another is exactly the case a medium check gets
  // wrong, and `_mix_score` asks the same question the same way.
  assert.match(FN, /from\("generation_blocks"\)[\s\S]*?audio_mode", "locked"/);
});

test("a score is laid at a bed level, not at unity over the dialogue", () => {
  assert.match(FN, /gain_db: isLocked \? 0 : SCORE_BED_DB/);
  const bed = SRC.match(/const SCORE_BED_DB = (-?\d+)/);
  assert.ok(bed, "SCORE_BED_DB is gone");
  assert.ok(Number(bed[1]) < 0, "a bed at or above unity is not a bed");
});

test("the master clip's length is MEASURED, not defaulted to a flat minute", () => {
  // `assets.duration_ms` is written by the pod's ingest job, so a track
  // uploaded in the wizard while the box is stopped carries null — and
  // `?? 60000` then laid a 60s clip over a song of any length. On a music
  // video that is the worst place for it: the blocks are planned against
  // `beats_ms` for the track's real duration while the lane says a minute.
  assert.match(FN, /ensureAssetDuration\(/,
    "the master clip is sized from a constant again — see mediaProbe.ts");
  // ensureAssetDuration takes a whole Asset; `select("duration_ms")` would
  // typecheck, probe nothing (no b2_key to read) and silently do nothing.
  assert.match(FN, /from\("assets"\)\.select\("\*"\)/,
    "the probe needs the whole row — b2_key is what it reads");
  // The probe is a network round trip: it must sit AFTER the early-out that
  // returns when the clip already exists, or every timeline open pays for it.
  const early = FN.indexOf("if (present) { await record(); return null; }");
  assert.ok(early > 0, "the already-present early-out is gone");
  assert.ok(early < FN.indexOf("ensureAssetDuration"),
    "the probe must not run when the master clip is already on the lane");
});

test("the clip says which of the two things it is", () => {
  // "Master track" and "Score" behave differently in the mix; a lane labelled
  // for the wrong one is the only clue the editor gets. Hoisted out of the
  // insert because the skip path names it too — the note that says the track
  // was left off has to call it what the lane called it.
  assert.match(FN, /const label = isLocked \? "Master track" : "Score"/);
  assert.match(FN, /\n\s+label,\n/, "the insert no longer uses it");
});


// ---------------------------------------------------------------------------
// A CLIP LABEL IS A SNAPSHOT OF SOMETHING DERIVABLE. `add_block` shifts every
// follower's `idx` back by one and nothing re-labelled their clips, so after a
// few inserts the lane read "Block 1, Block 2, Block 3" against a sidebar
// reading "Block 2, Block 5, Block 6" — off by however many shots had been
// added ahead of each one. Measured on RIVALS: 12 of 15 clips drifted.
// ---------------------------------------------------------------------------

test("block sync refreshes a clip label that no longer matches its block", () => {
  const src = readFileSync(
    new URL("./db/timeline.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("export async function syncBlocksToTimeline"));
  assert.match(fn, /clipLabelFor\(kind, b\.idx/,
    "the label must be recomputed from the block's CURRENT idx");
  assert.match(fn, /if \(want === c\.label\) continue/,
    "…and only written when it actually differs, or every sync is a write storm");
  // KIND-AWARE. It wrote `Block ${idx+1}` over anything starting with
  // "Block ", which ate the detached half's "· audio" suffix on every pass
  // and would rename a chain to a block. `clipLabelFor` owns both rules (a
  // written name is kept, the kind names the auto form) and is tested in
  // blockKind.test.ts — what must not come back is a prefix test here.
  assert.match(fn, /blockKind\(/,
    "a chain must not be relabelled as a block");
  assert.doesNotMatch(fn, /startsWith\("Block "\)/,
    "the keep-my-name rule belongs to clipLabelFor, not to a prefix test here");
  // the refresh has to happen BEFORE the take-swap short-circuit, or a block
  // already playing the right media never gets its label looked at.
  assert.ok(fn.indexOf("clipLabelFor") < fn.indexOf("if (!stale.length) continue"),
    "label refresh must precede the `no write` early-out");
});

/* ── the master track is the same bug one slot over ─────────────────────────
 *
 * `syncMasterTrack` decided "have I already laid the storyboard's audio on
 * A1?" by looking for a clip with that asset — which a delete answers "no",
 * so the next sync put it straight back. Recorded as a PLACEMENT rather than
 * as a deletion, because unlike a block clip (which sync keeps repointing at
 * new takes) nothing ever touches this one again once it exists. */

const MASTER = (() => {
  const src = SRC;
  const at = src.indexOf("async function syncMasterTrack");
  assert.ok(at > 0, "syncMasterTrack is gone — did it move or get renamed?");
  const end = src.indexOf("\n}\n", at);
  assert.ok(end > at, "could not find the end of syncMasterTrack");
  return src.slice(at, end);
})();

test("the master track is placed ONCE, off a record — not off the clip", () => {
  const record = MASTER.indexOf("placed_audio_asset_ids");
  assert.ok(record > 0, "the placement record is gone — the score WILL come back");
  const bail = MASTER.indexOf("if (placed.has(audioId)) return label;");
  const insert = MASTER.indexOf("await insertClip({");
  assert.ok(bail > 0, "nothing returns for a track the editor removed");
  assert.ok(bail < insert, "the bail must come BEFORE the insert, or it never runs");
});

test("a placement is recorded, or it is placed again every sync", () => {
  const insert = MASTER.indexOf("await insertClip({");
  assert.ok(MASTER.indexOf("await record();", insert) > insert,
            "the insert does not record itself");
});

test("an existing clip is ADOPTED, so a timeline that predates this is safe", () => {
  // The column starts empty on every timeline that already carries the track.
  // Without this, the first sync after the migration lays a second copy.
  assert.match(MASTER, /if \(present\) \{ await record\(\); return null; \}/);
});

test("'is it already here' spans every lane, not just A1", () => {
  assert.match(MASTER, /\.in\("track_id", lanes\.map\(\(t\) => t\.id\)\)/);
  assert.ok(!/from\("clips"\)[\s\S]*?\.eq\("track_id", (track|a1)\.id\)/.test(MASTER),
            "the lookup is back to a single lane — moving the clip duplicates it");
});

test("V1 is muted only while the master track is actually going on", () => {
  // A locked music video mutes V1 because the takes carry the same master
  // baked in. Re-asserting that for a track the editor REMOVED leaves the cut
  // silent — the score-mutes-the-film failure from the other side.
  const mute = MASTER.indexOf('.update({ muted: true })');
  assert.ok(mute > 0, "the V1 mute is gone entirely");
  const gate = MASTER.indexOf("if (isLocked && (present || !placed.has(audioId)))");
  assert.ok(gate > 0 && gate < mute, "the mute is not gated on the track being there");
});

test("a skipped master track is REPORTED, like a skipped block", () => {
  assert.match(SRC, /skippedAudio: string \| null;/);
});

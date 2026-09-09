/* One cut, one storyboard, ONE EPISODE.
 *
 * `syncBlocksToTimeline(timelineId, storyboardId)` lays whichever storyboard
 * it is handed onto whichever cut it is handed. The two ids reach it from
 * separate pieces of React state in TimelineView, which is NOT remounted
 * across a project or episode switch — so for a few hundred milliseconds
 * either side of a switch the pair can straddle two episodes, and every line
 * of the sync then does exactly what it says: the previous episode's blocks
 * land on this one's V1 at their own planned positions, its score lands on A1,
 * and nothing errors. The clips carry plausible `Block N` labels and no later
 * sync ever touches them again, because their `block_id` is not in this
 * storyboard.
 *
 * Measured on the live rows before the guard existed: 173 foreign clips across
 * 8 cuts in 6 projects, 2 foreign master tracks, 2 foreign exclusion entries.
 *
 * Both halves are pinned by PARSING SOURCE, the answer `scoreTrack.test.ts`
 * and `blockExclusions.test.ts` already reached for the same reason: the sync
 * is almost entirely Supabase calls and the caller is an effect inside a
 * 1,700-line component. Weak on purpose, and much stronger than nothing —
 * every failure below is silent at runtime. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Normalised to LF before anything indexes into it: git's default on Windows
// is core.autocrlf=true, and a regex `.` does not match `\r` — which is how a
// source-parsing test comes back reporting "found 0" instead of failing.
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/* ── the sync refuses a mismatched pair ─────────────────────────────────── */

const SYNC = (() => {
  const src = read("./db/timeline.ts");
  const at = src.indexOf("export async function syncBlocksToTimeline");
  assert.ok(at > 0, "syncBlocksToTimeline is gone — did it move or get renamed?");
  const end = src.indexOf("\n}\n", at);
  assert.ok(end > at, "could not find the end of syncBlocksToTimeline");
  return src.slice(at, end);
})();

test("the sync compares the cut's episode against the storyboard's", () => {
  assert.match(SYNC, /timelines"\)\.select\("episode_id"\)/,
    "the cut's episode is no longer read — a storyboard from another episode " +
    "will be laid onto this cut and nothing will say so");
  assert.match(SYNC, /storyboards"\)\.select\("episode_id"\)/,
    "the storyboard's episode is no longer read");
  assert.match(SYNC, /tlEpisode !== sbEpisode/,
    "the two episodes are no longer compared");
});

test("a mismatched pair THROWS rather than quietly doing less", () => {
  // A silent no-op would hide the caller's stale id, which is the actual bug.
  assert.match(SYNC, /throw new Error\(\s*\n?\s*`syncBlocksToTimeline:/,
    "the mismatch no longer refuses — it must not degrade to a partial sync");
});

test("the guard runs before the master track and before any insert", () => {
  const guard = SYNC.indexOf("tlEpisode !== sbEpisode");
  const master = SYNC.indexOf("syncMasterTrack(");
  const insert = SYNC.indexOf("insertClip({");
  assert.ok(guard > 0 && master > 0 && insert > 0, "one of the three landmarks is gone");
  // syncMasterTrack sits ABOVE the `no blocks with takes` early return, so a
  // guard placed after the block fetch would still have laid another
  // episode's score on A1 — measured twice on the live rows.
  assert.ok(guard < master,
    "the episode check must precede syncMasterTrack, or a foreign score still lands on A1");
  assert.ok(guard < insert,
    "the episode check must precede the insert, or foreign blocks still land on V1");
});

/* ── the caller can no longer hold a stale storyboard id ─────────────────── */

const LOAD_EFFECT = (() => {
  const src = read("../routes/Workspace.tsx");
  const at = src.indexOf("THE STORYBOARD ID IS DROPPED THE MOMENT THE EPISODE CHANGES");
  assert.ok(at > 0,
    "TimelineView's episode-load effect lost its marker comment — find it and " +
    "repoint this test rather than deleting it");
  const end = src.indexOf("}, [episode.id]);", at);
  assert.ok(end > at, "could not find the end of the [episode.id] effect");
  return src.slice(at, end);
})();

test("switching episode drops the storyboard id immediately", () => {
  // Not at the bottom of the async body: the whole window between the switch
  // and the load settling is when the pair straddles two episodes.
  const drop = LOAD_EFFECT.indexOf("setSbId(null);");
  const body = LOAD_EFFECT.indexOf("(async () => {");
  assert.ok(drop > 0, "sbId is no longer cleared when the episode changes");
  assert.ok(body > 0 && drop < body,
    "sbId must be cleared BEFORE the async body, or the stale id is live for " +
    "the whole load");
});

test("the storyboard id is written unconditionally, null included", () => {
  // The old `if (sbs[0])` left the PREVIOUS episode's id standing whenever the
  // new episode had no storyboard — the deterministic half of the bug.
  assert.match(LOAD_EFFECT, /setSbId\(sbs\[0\]\?\.id \?\? null\)/,
    "an episode with no storyboard must set null, not leave the last one's id");
  assert.doesNotMatch(LOAD_EFFECT, /if \(sbs\[0\]\) \{/,
    "the conditional write is back — a storyboard-less episode will inherit " +
    "the previous one's blocks");
});

test("a superseded load cannot land after the one that replaced it", () => {
  assert.match(LOAD_EFFECT, /let alive = true;/, "the cancellation flag is gone");
  assert.match(LOAD_EFFECT, /return \(\) => \{ alive = false; \};/,
    "the effect no longer cancels itself on cleanup");
  const load = LOAD_EFFECT.indexOf("await store.load(tl.id);");
  assert.ok(load > 0, "the timeline load is gone");
  const before = LOAD_EFFECT.lastIndexOf("if (!alive) return;", load);
  assert.ok(before > 0 && before < load,
    "store.load must be guarded by an `alive` check immediately above it, or a " +
    "superseded run still writes the outgoing cut into the store");
});

test("the store discards a load that a newer one has superseded", () => {
  // The belt to the effect's braces, and the half that covers every other
  // caller: `alive` cannot help once `store.load` is already awaiting.
  const src = read("../stores/useTimelineStore.ts");
  const at = src.indexOf("  async load(timelineId) {");
  assert.ok(at > 0, "useTimelineStore.load is gone — did it move or get renamed?");
  const fn = src.slice(at, src.indexOf("\n  },\n", at));
  assert.match(fn, /const gen = \+\+loadGen;/, "load no longer takes a generation");
  assert.match(fn, /if \(gen !== loadGen\) return;/,
    "a superseded load can write the outgoing cut back over the incoming one");
  assert.ok(fn.indexOf("if (gen !== loadGen) return;") < fn.indexOf("set((s) => ({"),
    "the generation check must come before the set, or it checks nothing");
});

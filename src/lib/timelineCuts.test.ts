/**
 * Duplicating a cut.
 *
 * The case worth pinning is the SELF-REFERENCE. `clips.linked_clip_id` and
 * `tracks.duck_under_track_id` point at rows in the same table, so a copy that
 * carries them across verbatim satisfies its foreign key, raises nothing, and
 * leaves the new cut's rows wired into the old cut's rows — after which
 * trimming a clip in the copy moves a clip in the original.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicatePlan, nextCutName } from "./timelineCuts.ts";
import type { Clip, Track } from "./db/types.ts";

const track = (id: string, over: Partial<Track> = {}) => ({
  id, timeline_id: "tl-old", kind: "video", idx: 0, name: "V1", muted: false,
  solo: false, locked: false, gain_db: 0, automation: [], duck_under_track_id: null,
  ...over,
} as Track);

const clip = (id: string, over: Partial<Clip> = {}) => ({
  id, track_id: "v1", asset_id: "a1", block_id: null, t_start_ms: 0,
  duration_ms: 1000, in_ms: 0, out_ms: null, ops: [], transition_in: null,
  gain_db: 0, label: null, linked_clip_id: null, audio_detached: false,
  audio_fx: [], post: null, updated_at: "",
  ...over,
} as Clip);

/** Readable, ordered ids: tracks are numbered before clips. */
const ids = () => { let n = 0; return () => `new${++n}`; };

/* ── naming ─────────────────────────────────────────────────────────────── */

test("an unused name is used as it stands", () => {
  assert.equal(nextCutName(["Main"], "Main copy"), "Main copy");
});

test("the series starts at 2, because the bare name is the first one", () => {
  assert.equal(nextCutName(["Main", "Main copy"], "Main copy"), "Main copy 2");
  assert.equal(nextCutName(["Main copy", "Main copy 2"], "Main copy"), "Main copy 3");
});

test("a gap in the series is filled rather than stepped over", () => {
  assert.equal(nextCutName(["New cut", "New cut 3"], "New cut"), "New cut 2");
});

test("names differing only in case are the same name on screen", () => {
  assert.equal(nextCutName(["main copy"], "Main copy"), "Main copy 2");
  assert.equal(nextCutName([" Main copy "], "Main copy"), "Main copy 2");
});

/* ── the copy ───────────────────────────────────────────────────────────── */

test("every lane and clip is copied under a fresh id, onto the new timeline", () => {
  const p = duplicatePlan([track("v1"), track("a1", { kind: "audio", idx: 0, name: "A1" })],
                          [clip("c1"), clip("c2", { t_start_ms: 1000 })], "tl-new", ids());
  assert.deepEqual(p.tracks.map((t) => t.id), ["new1", "new2"]);
  assert.deepEqual(p.tracks.map((t) => t.timeline_id), ["tl-new", "tl-new"]);
  assert.deepEqual(p.clips.map((c) => c.id), ["new3", "new4"]);
  // …and onto the COPY's lanes, not the original's.
  assert.deepEqual(p.clips.map((c) => c.track_id), ["new1", "new1"]);
});

test("a lane's own settings ride along", () => {
  const [t] = duplicatePlan(
    [track("a1", { kind: "audio", name: "A1", muted: true, solo: true, locked: true,
                   gain_db: -6, automation: [{ t_ms: 0, gain_db: -3 }] })],
    [], "tl-new", ids()).tracks;
  assert.equal(t.muted, true);
  assert.equal(t.solo, true);
  assert.equal(t.locked, true);
  assert.equal(t.gain_db, -6);
  assert.deepEqual(t.automation, [{ t_ms: 0, gain_db: -3 }]);
});

test("a clip's trim, ops, effects and block provenance ride along", () => {
  const [c] = duplicatePlan([track("v1")], [clip("c1", {
    block_id: "b4", in_ms: 500, out_ms: 4000, duration_ms: 3500,
    ops: [{ op: "flip", dir: "h" }], gain_db: -3, label: "Block 5",
    audio_detached: true, audio_fx: [{ id: "eq", params: {} }],
    transition_in: { type: "xfade", dur_ms: 250 },
  })], "tl-new", ids()).clips;
  assert.equal(c.block_id, "b4");        // the copy syncs new takes too
  assert.equal(c.in_ms, 500);
  assert.equal(c.out_ms, 4000);
  assert.equal(c.audio_detached, true);
  assert.deepEqual(c.ops, [{ op: "flip", dir: "h" }]);
  assert.deepEqual(c.audio_fx, [{ id: "eq", params: {} }]);
  assert.deepEqual(c.transition_in, { type: "xfade", dur_ms: 250 });
  assert.equal(c.label, "Block 5");
});

test("NO self-reference is carried across in the insert itself", () => {
  const p = duplicatePlan(
    [track("v1"), track("a1", { kind: "audio", duck_under_track_id: "v1" })],
    [clip("cv", { linked_clip_id: "ca" }), clip("ca", { linked_clip_id: "cv" })],
    "tl-new", ids());
  // Held back so neither insert can land before the row it names exists.
  for (const t of p.tracks) assert.equal("duck_under_track_id" in t, false);
  for (const c of p.clips) assert.equal("linked_clip_id" in c, false);
});

test("the A/V link is re-asserted from BOTH halves, remapped into the copy", () => {
  const p = duplicatePlan([track("v1")],
    [clip("cv", { linked_clip_id: "ca" }), clip("ca", { linked_clip_id: "cv" })],
    "tl-new", ids());
  // new1 = the lane; new2 = cv; new3 = ca.
  assert.deepEqual(p.clipLinks, [
    { id: "new2", linked_clip_id: "new3" },
    { id: "new3", linked_clip_id: "new2" },
  ]);
  // The old ids appear nowhere: this is the bug the whole module exists for.
  assert.equal(JSON.stringify(p).includes('"cv"'), false);
  assert.equal(JSON.stringify(p).includes('"ca"'), false);
});

test("a lane's duck target is remapped, never left pointing at the original", () => {
  const p = duplicatePlan(
    [track("v1"), track("a1", { kind: "audio", duck_under_track_id: "v1" })],
    [], "tl-new", ids());
  assert.deepEqual(p.trackLinks, [{ id: "new2", duck_under_track_id: "new1" }]);
});

test("a link pointing outside the copied set is dropped, not carried", () => {
  const p = duplicatePlan([track("v1")], [clip("cv", { linked_clip_id: "somewhere-else" })],
                          "tl-new", ids());
  assert.deepEqual(p.clipLinks, []);
  assert.equal(p.clips.length, 1);
});

test("a clip on a lane this timeline does not own is dropped, not misfiled", () => {
  const p = duplicatePlan([track("v1")], [clip("c1"), clip("c2", { track_id: "elsewhere" })],
                          "tl-new", ids());
  assert.deepEqual(p.clips.map((c) => c.track_id), ["new1"]);
});

/* ── end to end, against a store that enforces the constraints ──────────── */

/**
 * The plan written through the LOCAL PLANE, in the same statement order
 * `duplicateTimeline` uses — tracks, then clips, then the two self-FK passes.
 *
 * `LocalStore` implements the schema's primary keys, foreign keys and ON
 * DELETE rules (they are generated from the migrations), so this exercises the
 * real failure rather than a mock's opinion of it: the proof at the end is
 * that deleting the ORIGINAL leaves the copy whole. Carry `track_id` across
 * and the copy's clips are CASCADED away with the original's lanes; carry
 * `linked_clip_id` across and the copy's A/V pairs are silently unlinked by
 * `on delete set null`. Both are 200-OK bugs you only find later, in the cut.
 */
test("a duplicate written through the plane survives deleting the original", async () => {
  const { LocalStore } = await import("./localStore.ts");
  const { localFrom } = await import("./localQuery.ts");
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const s = new LocalStore(PROJECT, "owner-1");
  s.insert("projects", [{ id: PROJECT, title: "Local one", medium: "film" }]);
  const from = (t: string) => localFrom(s, t);

  const asset = (await from("assets").insert({ b2_key: "b.mp4", kind: "video" })
    .select().single()).data;
  const src = (await from("timelines").insert({ episode_id: null, name: "Main" })
    .select().single()).data;
  const v1 = (await from("tracks").insert({ timeline_id: src.id, kind: "video", idx: 0, name: "V1" })
    .select().single()).data;
  const a1 = (await from("tracks")
    .insert({ timeline_id: src.id, kind: "audio", idx: 0, name: "A1", duck_under_track_id: v1.id })
    .select().single()).data;
  const cv = (await from("clips").insert({
    track_id: v1.id, asset_id: asset.id, t_start_ms: 0, duration_ms: 6000,
    label: "Block 1", audio_detached: true,
  }).select().single()).data;
  const ca = (await from("clips").insert({
    track_id: a1.id, asset_id: asset.id, t_start_ms: 0, duration_ms: 6000,
    linked_clip_id: cv.id,
  }).select().single()).data;
  await from("clips").update({ linked_clip_id: ca.id }).eq("id", cv.id);

  // ── the copy, as duplicateTimeline writes it ──────────────────────────
  const tracks = (await from("tracks").select("*").eq("timeline_id", src.id)).data;
  const clips = (await from("clips").select("*")
    .in("track_id", tracks.map((t: { id: string }) => t.id))).data;
  const copy = (await from("timelines")
    .insert({ episode_id: null, name: nextCutName([src.name], `${src.name} copy`) })
    .select().single()).data;
  assert.equal(copy.name, "Main copy");

  let n = 0;
  const plan = duplicatePlan(tracks, clips, copy.id, () => `${copy.id.slice(0, 8)}-${++n}`);
  assert.equal((await from("tracks").insert(plan.tracks)).error, null);
  assert.equal((await from("clips").insert(plan.clips)).error, null);
  for (const l of plan.trackLinks) {
    await from("tracks").update({ duck_under_track_id: l.duck_under_track_id }).eq("id", l.id);
  }
  for (const l of plan.clipLinks) {
    await from("clips").update({ linked_clip_id: l.linked_clip_id }).eq("id", l.id);
  }

  // ── delete the original, and look at what is left ─────────────────────
  await from("timelines").delete().eq("id", src.id);

  const left = (await from("tracks").select("*").eq("timeline_id", copy.id)).data;
  assert.equal(left.length, 2, "the copy's lanes survive the original's deletion");
  const leftClips = (await from("clips").select("*")
    .in("track_id", left.map((t: { id: string }) => t.id))).data;
  assert.equal(leftClips.length, 2, "…and so do its clips (they were never on the old lanes)");

  const dupV = left.find((t: { kind: string }) => t.kind === "video");
  const dupA = left.find((t: { kind: string }) => t.kind === "audio");
  assert.equal(dupA.duck_under_track_id, dupV.id, "the duck points inside the copy");

  const pair = leftClips.map((c: { id: string; linked_clip_id: string | null }) =>
    [c.id, c.linked_clip_id]);
  const ids = new Set(leftClips.map((c: { id: string }) => c.id));
  for (const [id, link] of pair) {
    assert.ok(link, `clip ${id} kept its A/V link through the original's deletion`);
    assert.ok(ids.has(link as string), "…and the link points at the copy's own clip");
  }
  assert.equal(leftClips.find((c: { audio_detached: boolean }) => c.audio_detached)?.label,
               "Block 1", "the clip's own settings came across");
  // The media is a placement, not a copy: both cuts play the same asset.
  assert.equal((await from("assets").select("id")).data.length, 1);
});

/** The order above is the one `duplicateTimeline` has to keep: a clip cannot
 *  name a lane that does not exist yet, and a self-FK cannot be filled before
 *  the row it names is in. Parsed rather than trusted, because a reorder is a
 *  one-line edit and its failure is a 23503 at the far end of a copy. */
test("duplicateTimeline writes tracks, then clips, then the self-FK passes", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./db/timeline.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("export async function duplicateTimeline"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    assert.notEqual(i, -1, `duplicateTimeline no longer contains ${needle}`);
    return i;
  };
  assert.ok(at('from("tracks").insert') < at('from("clips").insert'),
            "lanes before the clips that name them");
  assert.ok(at('from("clips").insert') < at("relinkClips"),
            "clips before the pass that links them to each other");
  assert.ok(at('from("tracks").insert') < at("duck_under_track_id"),
            "lanes before the pass that ducks them under each other");
});

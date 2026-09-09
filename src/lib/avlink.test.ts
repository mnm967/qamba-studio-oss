// Where a detached block's audio lands, and what the audio clip is made of.
//
// The store's own writes need a database; these are the decisions it makes
// before it writes, which is where the behaviour that would surprise someone
// lives — an audio clip dropped on top of the master track, or a half that
// starts life a few frames out of sync with its picture.
import assert from "node:assert/strict";
import test from "node:test";

import { canDetach, detachedClipFrom, overlaps, pickAudioLane } from "./avlink.ts";

const track = (id: string, over: Record<string, unknown> = {}) => ({
  id, timeline_id: "tl", kind: "audio" as const, idx: 0, name: id.toUpperCase(),
  muted: false, solo: false, locked: false, gain_db: 0, automation: [],
  duck_under_track_id: null, ...over,
});
const clip = (id: string, over: Record<string, unknown> = {}) => ({
  id, track_id: "v1", asset_id: "as1", block_id: "b1", t_start_ms: 0, duration_ms: 6000,
  in_ms: 0, out_ms: 6000, ops: [], transition_in: null, gain_db: 0, label: "Block 1",
  linked_clip_id: null, audio_detached: false, updated_at: "", ...over,
});

const LANES = [
  track("a1", { idx: 0 }),
  track("a2", { idx: 1 }),
  track("a3", { idx: 2 }),
];

test("clips that merely touch do not overlap", () => {
  assert.equal(overlaps({ t_start_ms: 0, duration_ms: 6000 }, 6000, 12000), false);
  assert.equal(overlaps({ t_start_ms: 6000, duration_ms: 6000 }, 0, 6000), false);
  assert.equal(overlaps({ t_start_ms: 5999, duration_ms: 6000 }, 6000, 12000), true);
});

test("the first free lane wins, in lane order", () => {
  const lane = pickAudioLane(LANES, [], { t_start_ms: 0, duration_ms: 6000 });
  assert.equal(lane?.id, "a1");
});

test("a lane already busy in that window is skipped", () => {
  const busy = [{ track_id: "a1", t_start_ms: 0, duration_ms: 60000 }];
  assert.equal(pickAudioLane(LANES, busy, { t_start_ms: 0, duration_ms: 6000 })?.id, "a2");
});

test("a busy lane is still offered for a window it does not cover", () => {
  const busy = [{ track_id: "a1", t_start_ms: 0, duration_ms: 6000 }];
  assert.equal(pickAudioLane(LANES, busy, { t_start_ms: 6000, duration_ms: 6000 })?.id, "a1");
});

test("consecutive blocks fill ONE lane rather than one lane each", () => {
  const placed: { track_id: string; t_start_ms: number; duration_ms: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const lane = pickAudioLane(LANES, placed, { t_start_ms: i * 6000, duration_ms: 6000 });
    assert.equal(lane?.id, "a1");
    placed.push({ track_id: lane!.id, t_start_ms: i * 6000, duration_ms: 6000 });
  }
});

test("locked lanes are not offered", () => {
  const lanes = [track("a1", { idx: 0, locked: true }), track("a2", { idx: 1 })];
  assert.equal(pickAudioLane(lanes, [], { t_start_ms: 0, duration_ms: 6000 })?.id, "a2");
});

test("every lane busy means the caller has to make one", () => {
  const busy = LANES.map((t) => ({ track_id: t.id, t_start_ms: 0, duration_ms: 60000 }));
  assert.equal(pickAudioLane(LANES, busy, { t_start_ms: 0, duration_ms: 6000 }), null);
});

test("video lanes are never picked, however free", () => {
  const lanes = [track("v1", { kind: "video" as const, idx: 0 })];
  assert.equal(pickAudioLane(lanes, [], { t_start_ms: 0, duration_ms: 6000 }), null);
});

test("the audio half starts life exactly on its picture", () => {
  const c = clip("c1", { t_start_ms: 12000, duration_ms: 5500, in_ms: 250, out_ms: 5750 });
  const made = detachedClipFrom(c, "a1");
  assert.equal(made.t_start_ms, 12000);
  assert.equal(made.duration_ms, 5500);
  assert.equal(made.in_ms, 250);
  assert.equal(made.out_ms, 5750);
  assert.equal(made.asset_id, "as1");
  assert.equal(made.linked_clip_id, "c1");
});

test("an untrimmed clip takes its out point from the media, not from null", () => {
  const c = clip("c1", { out_ms: null });
  const made = detachedClipFrom(c, "a1", { duration_ms: 8000 } as never);
  assert.equal(made.out_ms, 8000);
});

test("the block link travels, so the audio half knows which shot it is", () => {
  assert.equal(detachedClipFrom(clip("c1"), "a1").block_id, "b1");
});

test("only an unlinked clip on an unlocked video lane can be detached", () => {
  const v = track("v1", { kind: "video" as const });
  assert.equal(canDetach(clip("c1"), v), true);
  assert.equal(canDetach(clip("c1", { linked_clip_id: "x" }), v), false, "already detached");
  assert.equal(canDetach(clip("c1"), track("a1")), false, "audio lane");
  assert.equal(canDetach(clip("c1"), track("v1", { kind: "video" as const, locked: true })), false);
  assert.equal(canDetach(undefined, v), false);
});

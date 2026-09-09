// node --test src/lib/playheadFrame.test.ts
//
// Every case here produces a perfectly good picture of the wrong thing when it
// is wrong: the grab succeeds, an asset registers, and the frame simply is not
// the one that was on screen. So the cases are the ones where the obvious
// implementation and the player disagree — lane order, a trim, a speed op, and
// reverse, and the one op the render honours and the preview does not.
import test from "node:test";
import assert from "node:assert/strict";
import { frameAtPlayhead } from "./playheadFrame.ts";

const lane = (id: string, idx: number, kind = "video") =>
  ({ id, idx, kind }) as never;
const clip = (over = {}) =>
  ({ id: "c", track_id: "v1", t_start_ms: 0, duration_ms: 10000, in_ms: 0,
     ops: [], transition_in: null, ...over }) as never;

const V1 = lane("v1", 0);
const V2 = lane("v2", 1);

test("an untrimmed clip maps the playhead straight onto its source", () => {
  const got = frameAtPlayhead([V1], [clip()], 3000);
  assert.equal(got?.srcMs, 3000);
  assert.equal(got?.midTransition, false);
});

test("a HEAD trim offsets the grab by the trim", () => {
  // in_ms is the head handle; 2s into the clip is 6.5s of source.
  const got = frameAtPlayhead([V1], [clip({ in_ms: 4500 })], 2000);
  assert.equal(got?.srcMs, 6500);
});

test("the clip's own position on the lane is subtracted", () => {
  const got = frameAtPlayhead([V1], [clip({ t_start_ms: 8000 })], 9500);
  assert.equal(got?.srcMs, 1500);
});

test("a SPEED op stretches source time under the playhead", () => {
  // 2x eats two seconds of source per second of timeline — the same mapping
  // PreviewPlayer's localSec uses, so the frame matches the stage.
  const fast = clip({ ops: [{ op: "speed", rate: 2 }] });
  assert.equal(frameAtPlayhead([V1], [fast], 3000)?.srcMs, 6000);
  const slow = clip({ ops: [{ op: "speed", rate: 0.5 }] });
  assert.equal(frameAtPlayhead([V1], [slow], 3000)?.srcMs, 1500);
});

test("REVERSE is followed, because the preview plays it now", () => {
  // The player scrubs a reversed clip backwards (PreviewPlayer.scrubTo),
  // so the frame under the playhead is the mirrored one and this has to say
  // so — grabbing the forward frame would hand back a picture the stage never
  // showed. The default clip is in_ms 0, duration 10000 at t_start 0, so the
  // mirror of 3000 is 7000.
  const rev = clip({ ops: [{ op: "reverse" }] });
  assert.equal(frameAtPlayhead([V1], [rev], 3000)?.srcMs, 7000);
  // It opens on the end of its window and ends on its in-point.
  assert.equal(frameAtPlayhead([V1], [rev], 0)?.srcMs, 10000);
  assert.equal(frameAtPlayhead([V1], [rev], 9999)?.srcMs, 1);
});

test("a reversed clip mirrors its own TRIMMED window, not the whole file", () => {
  // in 2000, 3s long: it opens on 5000 and ends on 2000, which is what the
  // render's `reverse` filter produces over the same window.
  const rev = clip({ in_ms: 2000, duration_ms: 3000, ops: [{ op: "reverse" }] });
  assert.equal(frameAtPlayhead([V1], [rev], 0)?.srcMs, 5000);
  assert.equal(frameAtPlayhead([V1], [rev], 1500)?.srcMs, 3500);
});

test("reverse and speed compose — the mirror is over the source the clip eats", () => {
  // 2x over a 10s slot eats 20s of source, so it opens on 20000 and the
  // playhead runs back at two seconds of source per second of timeline.
  const rev2x = clip({ ops: [{ op: "reverse" }, { op: "speed", rate: 2 }] });
  assert.equal(frameAtPlayhead([V1], [rev2x], 0)?.srcMs, 20000);
  assert.equal(frameAtPlayhead([V1], [rev2x], 3000)?.srcMs, 14000);
});

test("FREEZE is ignored for the same reason", () => {
  const frozen = clip({ ops: [{ op: "freeze", at_ms: 1000, dur_ms: 2000 }] });
  assert.equal(frameAtPlayhead([V1], [frozen], 3000)?.srcMs, 3000);
});

test("the TOPMOST video lane wins, whatever order the rows arrive in", () => {
  // PreviewPlayer sorts lanes by idx ascending and gives zIndex i+1, so the
  // highest idx is the layer you can see. Rows come back from the database in
  // no particular order, so the sort has to be here and not the caller's.
  const under = clip({ id: "under", track_id: "v1" });
  const over = clip({ id: "over", track_id: "v2" });
  assert.equal(frameAtPlayhead([V1, V2], [under, over], 3000)?.clip.id, "over");
  assert.equal(frameAtPlayhead([V2, V1], [over, under], 3000)?.clip.id, "over");
});

test("an empty top lane falls through to the one below", () => {
  const under = clip({ id: "under", track_id: "v1" });
  const over = clip({ id: "over", track_id: "v2", t_start_ms: 20000 });
  assert.equal(frameAtPlayhead([V1, V2], [under, over], 3000)?.clip.id, "under");
});

test("AUDIO lanes are never grabbed from", () => {
  const a = lane("a1", 9, "audio");
  const song = clip({ id: "song", track_id: "a1" });
  assert.equal(frameAtPlayhead([V1, a], [song], 3000), null);
});

test("a gap is null, not an error", () => {
  assert.equal(frameAtPlayhead([V1], [clip({ duration_ms: 1000 })], 3000), null);
  assert.equal(frameAtPlayhead([V1], [], 3000), null);
});

test("the clip's END is the cut — the first instant it is no longer on screen", () => {
  const c = clip({ duration_ms: 5000 });
  assert.equal(frameAtPlayhead([V1], [c], 4999)?.srcMs, 4999);
  assert.equal(frameAtPlayhead([V1], [c], 5000), null);
});

test("mid-xfade is reported, so the note can say the blend was not reproduced", () => {
  const fading = clip({ transition_in: { type: "xfade", dur_ms: 1000 } });
  assert.equal(frameAtPlayhead([V1], [fading], 400)?.midTransition, true);
  assert.equal(frameAtPlayhead([V1], [fading], 1400)?.midTransition, false);
});

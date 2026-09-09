// The preview and the render read the mix through two implementations
// (src/lib/mix.ts, worker/mix.py). Everything here is the contract they share;
// worker/tests/test_mix.py asserts the same cases against the Python twin.
import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_MAX_DB, AUTO_MIN_DB, addPoint, clipVolume, dbToFrac, elementVolume, fracToDb,
  gainAtMs, hitPoint, isAudible, linearGain, movePoint, removePoint, soloActive,
  trackGainDbAt,
} from "./mix.ts";

const track = (over: Record<string, unknown> = {}) => ({
  id: "t1", kind: "audio" as const, muted: false, solo: false, gain_db: 0,
  automation: [], ...over,
});

test("no points leaves the fader in charge", () => {
  assert.equal(gainAtMs([], 5000, -6), -6);
  assert.equal(trackGainDbAt(track({ gain_db: -6 }), 5000), -6);
});

test("automation replaces the fader rather than offsetting it", () => {
  const t = track({ gain_db: -12, automation: [{ t_ms: 0, gain_db: 0 }] });
  assert.equal(trackGainDbAt(t, 1234), 0);
});

test("the curve is flat outside its first and last point", () => {
  const pts = [{ t_ms: 1000, gain_db: -6 }, { t_ms: 3000, gain_db: 0 }];
  assert.equal(gainAtMs(pts, 0), -6);
  assert.equal(gainAtMs(pts, 1000), -6);
  assert.equal(gainAtMs(pts, 9999), 0);
});

test("between points it interpolates linearly", () => {
  const pts = [{ t_ms: 0, gain_db: -12 }, { t_ms: 1000, gain_db: 0 }];
  assert.equal(gainAtMs(pts, 500), -6);
  assert.equal(gainAtMs(pts, 250), -9);
});

test("points out of order still describe the same curve", () => {
  const pts = [{ t_ms: 2000, gain_db: 0 }, { t_ms: 0, gain_db: -12 }];
  assert.equal(gainAtMs(pts, 1000), -6);
});

test("two points at one instant are a step, not a divide by zero", () => {
  const pts = [{ t_ms: 1000, gain_db: 0 }, { t_ms: 1000, gain_db: -20 }];
  assert.equal(Number.isFinite(gainAtMs(pts, 1000)), true);
});

test("the bottom of the automation range is silence, not -30dB of signal", () => {
  assert.equal(linearGain(AUTO_MIN_DB), 0);
  assert.ok(linearGain(0) === 1);
  assert.ok(Math.abs(linearGain(-6) - 0.501) < 0.002);
});

test("element volume clamps the boost the browser cannot do", () => {
  assert.equal(elementVolume(AUTO_MAX_DB), 1);
  assert.equal(elementVolume(-100), 0);
});

test("a muted lane is silent; solo elsewhere silences the rest", () => {
  const a = track({ id: "a" });
  const b = track({ id: "b" });
  assert.equal(isAudible(a, [a, b]), true);
  assert.equal(soloActive([a, b]), false);

  const bSolo = track({ id: "b", solo: true });
  assert.equal(isAudible(a, [a, bSolo]), false);
  assert.equal(isAudible(bSolo, [a, bSolo]), true);
});

test("mute wins over the lane's own solo", () => {
  const muted = track({ id: "a", solo: true, muted: true });
  const other = track({ id: "b" });
  assert.equal(isAudible(muted, [muted, other]), false);
  // and it still silences the others: something IS soloed
  assert.equal(isAudible(other, [muted, other]), false);
});

test("solo on an audio lane silences a video lane's baked audio", () => {
  const v = track({ id: "v", kind: "video" as const });
  const a = track({ id: "a", solo: true });
  assert.equal(isAudible(v, [v, a]), false);
});

test("a detached video clip is silent on its video lane", () => {
  const v = track({ id: "v", kind: "video" as const });
  const clip = { track_id: "v", gain_db: 0, audio_detached: true };
  assert.equal(clipVolume(clip, [v], 0), 0);
  assert.equal(clipVolume({ ...clip, audio_detached: false }, [v], 0), 1);
});

test("clip gain rides on top of the lane's level at that moment", () => {
  const t = track({ id: "a", automation: [{ t_ms: 0, gain_db: -6 }, { t_ms: 1000, gain_db: -6 }] });
  const clip = { track_id: "a", gain_db: 6 };
  assert.ok(Math.abs(clipVolume(clip, [t], 500) - 1) < 1e-9);
});

test("a clip on a lane that is out of the mix is silent, whatever its gain", () => {
  const t = track({ id: "a", muted: true });
  assert.equal(clipVolume({ track_id: "a", gain_db: 6 }, [t], 0), 0);
});

test("adding a point twice in the same place adjusts it", () => {
  let pts = addPoint([], { t_ms: 1000, gain_db: 0 });
  pts = addPoint(pts, { t_ms: 1010, gain_db: -12 });
  assert.equal(pts.length, 1);
  assert.equal(pts[0].gain_db, -12);
});

test("added points are clamped to the drawable range and kept sorted", () => {
  let pts = addPoint([], { t_ms: 5000, gain_db: 99 });
  pts = addPoint(pts, { t_ms: 1000, gain_db: -99 });
  assert.deepEqual(pts.map((p) => p.t_ms), [1000, 5000]);
  assert.equal(pts[0].gain_db, AUTO_MIN_DB);
  assert.equal(pts[1].gain_db, AUTO_MAX_DB);
});

test("a point dragged past its neighbour reorders instead of sticking", () => {
  const pts = [{ t_ms: 0, gain_db: 0 }, { t_ms: 1000, gain_db: -6 }];
  const moved = movePoint(pts, 0, { t_ms: 2000, gain_db: 0 });
  assert.deepEqual(moved.map((p) => p.t_ms), [1000, 2000]);
});

test("moving a point that isn't there changes nothing", () => {
  const pts = [{ t_ms: 0, gain_db: 0 }];
  assert.deepEqual(movePoint(pts, 4, { t_ms: 9, gain_db: 0 }), pts);
});

test("removePoint drops exactly one", () => {
  const pts = [{ t_ms: 0, gain_db: 0 }, { t_ms: 1000, gain_db: -6 }];
  assert.deepEqual(removePoint(pts, 0), [{ t_ms: 1000, gain_db: -6 }]);
});

test("dB and lane position round-trip", () => {
  assert.equal(dbToFrac(AUTO_MAX_DB), 0);
  assert.equal(dbToFrac(AUTO_MIN_DB), 1);
  assert.ok(Math.abs(fracToDb(dbToFrac(-9)) - -9) < 1e-9);
});

test("hitPoint finds the nearest point inside the radius and nothing outside", () => {
  const pts = [{ t_ms: 0, gain_db: 0 }, { t_ms: 1000, gain_db: 0 }];
  const toXY = (p: { t_ms: number }) => ({ x: p.t_ms / 10, y: 20 });
  assert.equal(hitPoint(pts, { x: 98, y: 21 }, toXY), 1);
  assert.equal(hitPoint(pts, { x: 50, y: 20 }, toXY), -1);
});

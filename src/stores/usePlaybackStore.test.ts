import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The store schedules its tick with requestAnimationFrame, which node has not
// got. A manual scheduler lets a test step the clock deliberately.
const frames: Array<() => void> = [];
(globalThis as unknown as { requestAnimationFrame: (cb: (t: number) => void) => number }).requestAnimationFrame =
  (cb) => { frames.push(() => cb(performance.now())); return frames.length; };
(globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = () => {};

const { usePlaybackStore } = await import("./usePlaybackStore.ts");
const st = () => usePlaybackStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  if (st().playing) st().pause();
  st().setStartHold(0);
  st().setDuration(60_000);
  st().seek(0);
  frames.length = 0;
});

test("with no hold configured, play() runs the clock at once — every caller that predates the hold is unchanged", async () => {
  st().seek(1000);
  st().play();
  assert.equal(st().isHeld(), false);
  await sleep(30);
  assert.ok(st().nowMs() > 1000, `clock should have moved, got ${st().nowMs()}`);
});

test("a held clock sits at the start position, ticks emit that position, and release(anchor) starts it from the anchor", async () => {
  st().setStartHold(2000);
  st().seek(5000);
  const seen: number[] = [];
  const off = st().onTick((ms) => seen.push(ms));
  st().play();
  assert.equal(st().isHeld(), true);
  await sleep(40);
  assert.equal(st().nowMs(), 5000, "held: the clock must not advance");
  frames.shift()?.();                       // one rAF tick while held
  assert.equal(seen.at(-1), 5000, "a tick while held emits the start position");
  st().release(5120);                       // the picture reports in 120ms into the shot
  assert.equal(st().isHeld(), false);
  assert.equal(seen.at(-1), 5120, "release emits the new origin");
  await sleep(30);
  assert.ok(st().nowMs() > 5120 && st().nowMs() < 5400, `runs from the anchor, got ${st().nowMs()}`);
  off();
});

test("release() with no anchor starts from where it was holding", async () => {
  st().setStartHold(2000);
  st().seek(700);
  st().play();
  st().release();
  await sleep(20);
  assert.ok(st().nowMs() >= 700 && st().nowMs() < 900);
});

test("the cap releases a clock nobody reports to, so a stalled element cannot pin the transport", async () => {
  st().setStartHold(60);
  st().seek(0);
  st().play();
  assert.equal(st().isHeld(), true);
  await sleep(120);
  assert.equal(st().isHeld(), false);
  assert.ok(st().nowMs() > 0);
});

test("release() when nothing is held is a no-op and does not move the clock", async () => {
  st().seek(3000);
  st().play();
  await sleep(20);
  const before = st().nowMs();
  st().release(0);
  assert.ok(st().nowMs() >= before, "a stray release must not rewind a running clock");
});

test("pause() while held commits the held position and clears the hold", () => {
  st().setStartHold(5000);
  st().seek(2500);
  st().play();
  st().pause();
  assert.equal(st().isHeld(), false);
  assert.equal(st().playheadMs, 2500);
});

test("the anchor is clamped to the timeline, like every other position", () => {
  st().setStartHold(5000);
  st().seek(0);
  st().play();
  st().release(-50);
  assert.equal(st().nowMs() >= 0, true);
  st().pause();
  st().play();
  st().release(999_999);
  assert.ok(st().nowMs() <= 60_000 + 5);
});

test("a seek while playing holds the clock again until the picture reports in; a seek while paused does not", async () => {
  st().setStartHold(2000);
  st().seek(1000);
  st().play();
  st().release(1000);
  await sleep(20);
  st().seek(9000);
  assert.equal(st().isHeld(), true, "playing + seek => held at the new position");
  assert.equal(st().nowMs(), 9000);
  await sleep(20);
  assert.equal(st().nowMs(), 9000, "does not run until released");
  st().release(9050);
  await sleep(20);
  assert.ok(st().nowMs() > 9050 && st().nowMs() < 9300);
  st().pause();
  st().seek(500);
  assert.equal(st().isHeld(), false, "a paused seek has nothing to wait for");
});

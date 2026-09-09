import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_DRIFT, ASSUMED_SOURCE_FPS, DEFAULT_DISPLAY_HZ, START_GRACE_MS,
  VIDEO_DRIFT_LEAN, VIDEO_DRIFT_SEEK,
  isWebKitMedia, shouldScrub, snapAfterPlay, startHoldMs, videoDriftProfile, warmLeadMs,
} from "./driftProfile.ts";

const UA = {
  wkwebviewMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  safariIOS: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  webview2: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  chromeIOS: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0",
};

test("WebKit proper is detected; every Chromium that borrows the AppleWebKit token is not", () => {
  assert.equal(isWebKitMedia(UA.wkwebviewMac), true, "the packaged macOS build");
  assert.equal(isWebKitMedia(UA.safariMac), true);
  assert.equal(isWebKitMedia(UA.safariIOS), true);
  assert.equal(isWebKitMedia(UA.chromeMac), false, "the web build in Chrome");
  assert.equal(isWebKitMedia(UA.webview2), false, "the Windows build");
  assert.equal(isWebKitMedia(UA.chromeIOS), false);
  assert.equal(isWebKitMedia(UA.firefox), false);
  assert.equal(isWebKitMedia(""), false);
});

test("the picture is never leaned on WebKit and still leaned on Chromium", () => {
  const wk = videoDriftProfile(true);
  assert.equal(wk.nudge, Infinity);
  assert.equal(wk.settled, Infinity);
  assert.equal(wk, VIDEO_DRIFT_SEEK);
  const cr = videoDriftProfile(false);
  assert.ok(Number.isFinite(cr.nudge) && cr.nudge > 0);
  assert.equal(cr, VIDEO_DRIFT_LEAN);
});

test("a seek threshold stays finite everywhere — an element that drifts a whole shot is still brought back", () => {
  for (const p of [VIDEO_DRIFT_LEAN, VIDEO_DRIFT_SEEK, AUDIO_DRIFT]) {
    assert.ok(Number.isFinite(p.seek) && p.seek > 0);
    assert.ok(p.cooldownMs >= 500);
  }
});

test("the seek band is wider than the observed post-write jitter on WebKit (0.01-0.20s)", () => {
  assert.ok(VIDEO_DRIFT_SEEK.seek > 0.2);
  assert.ok(AUDIO_DRIFT.seek > 0.2);
});

test("the start grace covers AVFoundation's start latency without hiding a real stall", () => {
  assert.ok(START_GRACE_MS >= 200, "under 200ms and a normal WebKit start still trips a correction");
  assert.ok(START_GRACE_MS < 500, "past the seek threshold and a genuinely late element goes uncorrected");
});

test("a rate the screen can show is PLAYED; one it cannot is scrubbed", () => {
  const at = (rate: number) => shouldScrub(true, 24, rate, 60);
  assert.equal(at(1), false, "a plain clip");
  assert.equal(at(0.5), false, "slow motion plays fine");
  assert.equal(at(2), false, "48fps fits inside 60Hz — and playing carries sound");
  assert.equal(at(2.5), false, "exactly 60fps: one frame per refresh");
  assert.equal(at(3), true, "72fps — the surplus cannot be shown");
  assert.equal(at(4), true);
});

test("the threshold follows the DISPLAY, so a 120Hz screen plays what a 60Hz one scrubs", () => {
  assert.equal(shouldScrub(true, 24, 4, 60), true);
  assert.equal(shouldScrub(true, 24, 4, 120), false, "96fps fits in 120Hz");
  assert.equal(shouldScrub(true, 24, 6, 120), true, "144 does not");
});

test("the threshold follows the SOURCE fps too", () => {
  assert.equal(shouldScrub(true, 60, 1.5, 60), true, "60fps source needs no help to overflow");
  assert.equal(shouldScrub(true, 12, 4, 60), false, "48fps still fits");
});

test("Chromium is never scrubbed — it drops frames itself and keeps the clock", () => {
  for (const r of [2, 3, 4, 8]) {
    assert.equal(shouldScrub(false, 24, r, 60), false, `x${r} on Chromium`);
  }
});

test("a source with no recorded fps is assumed, not guessed high", () => {
  // Guessing high would scrub a clip that plays perfectly well AND take its
  // sound away. Every asset this studio renders is 24.
  assert.equal(ASSUMED_SOURCE_FPS, 24);
  assert.equal(shouldScrub(true, null, 2, 60), false);
  assert.equal(shouldScrub(true, undefined, 3, 60), true);
  assert.equal(shouldScrub(true, 0, 3, 60), true, "0 is 'not recorded', not 'no frames'");
});

test("a display rate that was never measured falls back rather than scrubbing everything", () => {
  assert.equal(DEFAULT_DISPLAY_HZ, 60);
  assert.equal(shouldScrub(true, 24, 2, 0), false, "0 Hz means nobody measured");
  assert.equal(shouldScrub(true, 24, 4, 0), true);
});

test("a nonsense rate is not a reason to stop playing", () => {
  assert.equal(shouldScrub(true, 24, NaN, 60), false);
  assert.equal(shouldScrub(true, 24, Infinity, 60), false);
});

// ---- startup, per engine ------------------------------------------------
// Measured in the desktop build 2026-09-08: play() blocks the main thread for
// its own latency (~55ms typical, 240-300ms on some starts), and a seek issued
// into that startup took 1.4-1.9s to land. See the block above the constants.

test("a WebKit element is never seeked into its own startup; Chromium keeps its cheap snap", () => {
  assert.equal(snapAfterPlay(true), false);
  assert.equal(snapAfterPlay(false), true);
});

test("the transport clock's hold outlasts a seek issued just before play on WebKit (measured 1.2-1.9s to land)", () => {
  assert.ok(startHoldMs(true) > 1900, "a cap shorter than the seek starts the clock on an element that is still seeking");
  assert.ok(startHoldMs(true) <= 4000, "it is a backstop for an element that never reports, not a budget");
  assert.ok(startHoldMs(false) < startHoldMs(true), "Chromium lands the same seek in tens of ms and needs less rope");
  assert.ok(startHoldMs(false) > 0, "the clock still waits for the picture on Chromium");
});

test("the next clip is warmed just far enough ahead to cover a warmed play()'s own latency", () => {
  // A warmed play() resolved in 3-8ms, p90 25ms, on WebKit (RUN 2); the lead
  // covers that plus one rAF frame, and no more — a warmed element runs from
  // its opening frame, so every extra millisecond is picture skipped at the
  // cut, and the shortest clips on a real cut are 208ms.
  assert.ok(warmLeadMs(true) > 25, "must cover the measured p90 of a warmed play() on WebKit");
  assert.ok(warmLeadMs(true) <= 60, "at 50 the cut already landed a median 18ms ahead");
  assert.ok(warmLeadMs(false) >= 16 && warmLeadMs(false) <= warmLeadMs(true), "Chrome: one rAF frame over a 3-5ms start");
});

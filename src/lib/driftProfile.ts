// How the preview player keeps a playing media element on the clock, per
// ENGINE — and which engine this is.
//
// A correction is not free, and its cost is not the same everywhere. Chromium
// absorbs a `playbackRate` write in silence, so LEANING an element a few
// percent is the cheapest way to close a small drift there. WebKit backs every
// media element with AVFoundation, where a rate write re-primes the renderer:
// an audible dropout on an element that carries sound, and a `currentTime`
// that reports BACKWARDS for a moment afterwards — which the loop then reads
// as fresh drift and corrects again. Measured twice in the packaged macOS build
// (WKWebView): 155 rate writes on one audio element over a single playback in
// August, then 25 writes a minute on the video element in September, pinned at
// the cooldown, with the seconds carrying a write off-pace twice as often as
// the seconds without one (52% vs 25%, from /tmp/qamba-diag.log). The August
// fix exempted `<audio>` only; this exempts the picture on the same engine.
//
// Pure and dependency-free so `node --test` can pin the table: PreviewPlayer
// imports the supabase client and cannot be tested.

export interface DriftProfile {
  /** start leaning beyond this many seconds of drift (Infinity = never lean) */
  nudge: number;
  /** stop leaning inside this (hysteresis) */
  settled: number;
  /** beyond this, jump */
  seek: number;
  /** at most one seek per element per window */
  cooldownMs: number;
}

/** Chromium: lean on a wide band, seek as a last resort. */
export const VIDEO_DRIFT_LEAN: DriftProfile = { nudge: 0.12, settled: 0.06, seek: 0.5, cooldownMs: 1000 };
/** WebKit: never lean the picture. A frame 100ms off the clock is invisible;
 *  a rate write on AVFoundation is not. Seek only for a real desync. */
export const VIDEO_DRIFT_SEEK: DriftProfile = { nudge: Infinity, settled: Infinity, seek: 0.5, cooldownMs: 1000 };
/** Audio is never leaned on ANY engine — a lean is the audible operation, and
 *  `baseRate` for an audio lane is always 1, so an element left alone tracks a
 *  `performance.now()` clock by construction. Seeked only for a drift big
 *  enough to be a real desync rather than renderer jitter. */
export const AUDIO_DRIFT: DriftProfile = { nudge: Infinity, settled: Infinity, seek: 0.75, cooldownMs: 2000 };

/** No correction of any kind this long after `play()` resolves.
 *
 *  `play()` resolving is not the picture moving: AVFoundation takes 100-200ms
 *  to actually advance `currentTime` after the promise lands, and Chromium a
 *  few tens of ms. Read as drift, that latency tripped the nudge band at EVERY
 *  cut — 166 of the 306 video rate writes in the September log were within
 *  1.5s of a play(). The element is only frames old here, so whatever it is
 *  behind by is absorbed on the first real tick after the grace. */
export const START_GRACE_MS = 250;

export function videoDriftProfile(webkit: boolean): DriftProfile {
  return webkit ? VIDEO_DRIFT_SEEK : VIDEO_DRIFT_LEAN;
}

/**
 * WHAT A `play()` COSTS, PER ENGINE — measured in the desktop build (WKWebView,
 * `tauri dev`, 2026-09-08) with the dev playback diagnostic over a real cut of
 * 59 clips, and the numbers below are read straight off it.
 *
 * ON WEBKIT `play()` BLOCKS THE MAIN THREAD for as long as it takes AVFoundation
 * to start: ~55ms on most elements and 240-300ms on some, with the rAF gap at
 * each cut matching the play() latency to the millisecond (55/59, 58/59,
 * 282/292, 292/294). During that block the clock (`performance.now`) runs on
 * and the element has not moved, so it comes out of the block behind — and the
 * post-play SNAP then seeked it INTO its own startup, which on AVFoundation took
 * **1.4-1.9 seconds to land** (SEEKING -> SEEKED), after which the drift seek
 * fired and seeked it a second time. That is a frozen frame for two seconds at
 * the cut, on a clip that may itself be shorter than a second, and it is what
 * "laggy" was. The same chase on the audio lane at transport start — a 384ms
 * snap seek, then a 750ms drift seek — is the song audibly jumping forward a
 * second and a half after pressing play.
 *
 * Three rules follow, each a constant here so the engine decides once:
 * - `snapAfterPlay`: NEVER seek into a WebKit element's startup. A start that
 *   came out 300ms behind stays 300ms behind for that clip, which is under the
 *   seek threshold and invisible against two seconds of freeze. Chromium's
 *   snap costs nothing and stays.
 * - `startHoldMs`: at transport start (and on a scrub while playing) the CLOCK
 *   waits for the picture rather than the picture chasing the clock —
 *   `usePlaybackStore.play()` holds at the start position until the player
 *   releases it with where the element really is, or this cap passes. The cap
 *   is a backstop against an element that never reports, not a budget: a seek
 *   issued just before play takes 1.2-1.9s to LAND on WebKit (measured, RUN 1
 *   and RUN 6), and a cap shorter than that starts the clock on an element
 *   that is still seeking — after which the drift seek that follows is the
 *   very jump the hold exists to prevent. Chromium lands the same seek in tens
 *   of milliseconds.
 * - `warmLeadMs`: mid-play, the NEXT clip's `play()` is issued this long before
 *   its cut, muted and hidden. Measured on the same cut once warming was in:
 *   a play() issued a few frames early, on a parked element in a frame with
 *   nothing else happening, RESOLVES IN 3-8ms (p90 25ms, n=19; 3-5ms in a
 *   real Chrome) — the block is a property of asking on the boundary frame,
 *   not of play(). So the lead is only what covers that latency plus a frame
 *   of rAF granularity; longer puts the picture visibly AHEAD of its cut,
 *   since a warmed element runs from its opening frame: at 50ms the cut landed
 *   a median 18ms ahead on WebKit, at 40ms 35-47ms ahead in Chrome, and on a
 *   five-frame bridge clip a 150ms lead skipped most of the shot.
 */
export const snapAfterPlay = (webkit: boolean): boolean => !webkit;
export const startHoldMs = (webkit: boolean): number => (webkit ? 2500 : 400);
export const warmLeadMs = (webkit: boolean): number => (webkit ? 35 : 20);

/** True where media elements are AVFoundation-backed: Safari, and every
 *  WKWebView — which is what the desktop build is on a Mac, packaged or under
 *  `tauri dev` alike. The builds this code behaves differently in are the WEB
 *  build in Chrome and the Windows build in WebView2: both Chromium, and both
 *  carry a `Chrome/` token that WebKit proper never does. */
export function isWebKitMedia(ua: string): boolean {
  if (!/AppleWebKit\//.test(ua)) return false;
  return !/\b(Chrome|Chromium|CriOS|Edg|EdgiOS|OPR)\//.test(ua);
}

/** The screen's refresh rate when nothing has measured it. By far the commonest
 *  value, and what a hidden tab (where rAF never fires) has to fall back to. */
export const DEFAULT_DISPLAY_HZ = 60;
/** The frame rate assumed for a source that records none. This studio renders
 *  at 24 throughout, and guessing high would mean scrubbing a clip that plays
 *  perfectly well. */
export const ASSUMED_SOURCE_FPS = 24;

/**
 * Should this clip be SCRUBBED rather than played — element paused, its
 * `currentTime` driven from the clock, one seek in flight at a time?
 *
 * WEBKIT LOSES TIME WHERE CHROMIUM DROPS FRAMES, and that is the whole reason
 * this exists. Measured by driving AVFoundation directly — the stack WebKit
 * uses for `<video>` on macOS — over one of this studio's own 24fps takes on an
 * M3 Air, asking for a rate and reading back how fast the item clock actually
 * advanced:
 *
 *   | asked | delivered |
 *   |-------|-----------|
 *   | x2    | 2.00x     |
 *   | x3    | 3.00x     |
 *   | x4    | **3.19x** |
 *   | x6    | **2.83x** |
 *
 * i.e. a hard ceiling around 70-76 fps, above which it PLAYS SLOWER THAN ASKED
 * instead of dropping what it cannot show. Controls: identical with no video
 * output attached at all (so it is not a harness copying pixels), and a
 * 1280x704 clip — 2.2x the pixels — hits the same wall (2.91x at x4), so it is
 * a pipeline limit rather than the decoder. Chromium holds the clock and drops
 * frames, which is why the same timeline is smooth in the web build.
 *
 * On WebKit the element therefore falls behind at a steady ~200ms of wall clock
 * per second at x4, `converge` seeks it, the seek is a hitch, and it is behind
 * again immediately. Scrubbing has none of that: measured 194 FRAME-ACCURATE
 * SEEKS A SECOND on the same clip (5.2ms mean, 17ms worst), three times what a
 * 60Hz screen can show, always at exactly the right timeline position.
 *
 * THE THRESHOLD IS THE DISPLAY, NOT THE CEILING, and that is what matches the
 * report this came from ("fine at x2, lags for anything above"). Past the
 * refresh rate the surplus frames cannot be shown at all, so sampling at
 * display cadence beats playing and dropping unevenly — and 24 x 2.5 = 60 is
 * exactly where x2 stops and x3 starts. Below it, playing is better: it is
 * smoother, and it is the only one of the two that carries SOUND.
 *
 * Chromium is excluded outright. It already samples correctly, and scrubbing
 * there would trade a working preview for a silent one.
 */
export function shouldScrub(
  webkit: boolean,
  sourceFps: number | null | undefined,
  rate: number,
  displayHz: number,
): boolean {
  if (!webkit) return false;
  if (!Number.isFinite(rate) || rate <= 1) return false;   // 1x and slow-mo play fine
  const fps = (sourceFps && sourceFps > 0 ? sourceFps : ASSUMED_SOURCE_FPS) * rate;
  const hz = displayHz > 0 ? displayHz : DEFAULT_DISPLAY_HZ;
  return fps > hz;
}

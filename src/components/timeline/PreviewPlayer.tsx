import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { mediaUrl } from "../../lib/supabase";
import { clipVolume, isAudible, linearGain, trackGainDbAt } from "../../lib/mix";
import { normalizeFx, previewFx } from "../../lib/audioFx";
import { cachedCorsUrl, ensureCorsUrl, needsCorsProxy, retainCorsUrls } from "../../lib/corsMedia";
import { isLocalMediaUrl } from "../../lib/desktop";
import {
  AUDIO_DRIFT, DEFAULT_DISPLAY_HZ, START_GRACE_MS, isWebKitMedia, shouldScrub, snapAfterPlay,
  startHoldMs, videoDriftProfile, warmLeadMs, type DriftProfile,
} from "../../lib/driftProfile";
import { isStill } from "../../lib/assetKind";
import { diag } from "../../lib/playbackDiag";
import { clipRate, clipReversed, clipSourceAt } from "../../lib/clipFrames.ts";
import { layerStyle, sourceBox } from "../../lib/clipCrop";
import {
  applyBusFx, applyFx, busIds, busOf, disposeAllBuses, disposeFx, fxSupported,
  onCorsChange, probeCors, recheckCors, releaseBus, resumeAudio, setBusGain, setClipGain,
} from "../../lib/audioGraph";
import type { Asset, Clip, Track } from "../../lib/db/types";

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 100))}`;
};

const srcOf = (a: Asset | undefined) => (a ? mediaUrl(a.b2_key) ?? undefined : undefined);
/** Dev-only: how a diag line names an element (see lib/playbackDiag.ts). */
const tagOf = (el: HTMLMediaElement) => `${el.tagName[0]}:${(el.dataset.clip ?? "").slice(0, 8)}`;

/** The same media, under a cache key of its own, for the CORS-mode element.
 *
 *  B2 answers a request that carries no `Origin` with no ACAO **and no
 *  `Vary`** — so a plain media load leaves a response in the browser cache
 *  that is not keyed by origin and answers every later CORS request for that
 *  URL. The element usually loads before the probe can run, so that is the
 *  normal order of events, and the result is permanent: measured on a real
 *  project, the same URL was `BLOCKED` on a cached fetch and `200 cors` with
 *  the cache bypassed, and a `crossOrigin` element failed with
 *  MEDIA_ERR_SRC_NOT_SUPPORTED while curl was being served the file correctly.
 *
 *  A distinct query string is the whole fix: the CORS load and the plain load
 *  can no longer collide, so the poisoning cannot happen and an ALREADY
 *  poisoned cache is stepped around. B2 ignores the parameter (verified). It
 *  costs one re-download of a clip that was already fetched plainly and then
 *  had an effect put on it. */
const CORS_MARK = "qambacors=1";
const corsSrcOf = (a: Asset | undefined) => {
  const url = srcOf(a);
  return url ? url + (url.includes("?") ? "&" : "?") + CORS_MARK : undefined;
};

/** Timeline ms -> source-media seconds for a clip: speed AND direction.
 *
 *  The arithmetic is `clipFrames.clipSourceAt`, which also caches the ops scan
 *  per clip object — this is asked for every clip near the playhead on every
 *  rAF tick. It used to be a private copy here that knew about `speed` and not
 *  about `reverse`, which is the whole reason a reversed clip played
 *  forwards. */
const localSec = (clip: Clip, ms: number) => clipSourceAt(clip, ms) / 1000;
/** The inverse: where on the TIMELINE a forward-playing clip's element is,
 *  from its current source position. Null when the element has not reached
 *  the clip's window yet (it is still at its parked frame, or before it) —
 *  there is no honest timeline position to hand the clock then. */
const timelineMsAt = (clip: Clip, srcSec: number): number | null => {
  if (clipReversed(clip)) return null;
  const rate = clipRate(clip);
  const head = Math.max(0, clip.in_ms ?? 0);
  const into = (srcSec * 1000 - head) / rate;
  if (into < -20 || into > clip.duration_ms + 20) return null;
  return clip.t_start_ms + Math.max(0, into);
};

/** CSS for one layer's picture ops — flip, transform AND crop; see
 * lib/clipCrop.ts, which owns the geometry and is pinned against the worker's
 * own filter chain. `reverse` is not one of these — it changes WHICH frame is
 * on screen rather than how it is drawn, so it lives in localSec and
 * scrubTo instead. `freeze` remains render-only: it is a change to the
 * clip's timing that nothing on the lane expresses, so there is nothing
 * honest to show for it short of the render. */

interface Slot {
  clip: Clip;
  active: boolean;
}

/** Drift-correction tuning. A playing element is kept on the clock by LEANING
 *  its playbackRate a few percent (pitch is preserved by default, so a lean is
 *  inaudible) and only SEEKED as a last resort: a seek flushes the decode
 *  pipeline and re-issues the network fetch, so correcting on a tight seek
 *  threshold IS the stutter it is trying to fix. The old code seeked audio at
 *  45ms of drift every 500ms — but play() start latency alone leaves an
 *  element ~50-200ms behind the free-running clock, so lanes glitched on a
 *  timer — and seeked video at 200ms EVERY FRAME, which on a slow connection
 *  became a 60fps storm of aborted range requests that stalled playback
 *  entirely. */
const NUDGE = 0.06;            // 6% rate lean while correcting
/** One snap right after play() lands, to absorb pipeline start latency
 *  (50-200ms) while the clip is only frames old — far less visible than the
 *  same correction arriving mid-shot. Deliberately its own constant: it is a
 *  one-shot at a known-cheap moment, not part of the steady-state loop the
 *  drift profiles below are trying to keep quiet. */
const START_SNAP_S = 0.12;

/** Correction profiles. VIDEO AND AUDIO ARE NOT THE SAME PROBLEM.
 *
 *  Measured in a packaged macOS build (WKWebView), one audio element, one
 *  playback: with a single shared profile the effective rate oscillated
 *  between **0.62x and 1.36x** — far outside the +/-6% a lean can produce, so
 *  those were hard SEEKS firing over and over. Every correction (a rate write
 *  or a seek) re-primes the AVFoundation renderer and costs real time, which
 *  shows up as fresh drift, which provokes the next correction. The loop is
 *  self-sustaining and it is audible as continuous stuttering.
 *
 *  So a correction is treated as EXPENSIVE rather than free:
 *  - Audio is never rate-leaned at all. A lean is the destructive operation
 *    here, and `baseRate` for an audio lane is always 1 anyway — an element
 *    left alone at rate 1.0 tracks a `performance.now()` clock by
 *    construction. It is seeked only for a drift big enough to be a real
 *    desync rather than renderer jitter, and at most once every 2s.
 *  - Video keeps the lean ON CHROMIUM (a frame 100ms early is invisible
 *    where a click is not), on a wider band and a longer seek cooldown — and
 *    is NOT leaned on WebKit at all. That August fix exempted `<audio>` only;
 *    the September log from the packaged macOS build showed the same loop on
 *    the VIDEO element, 25 rate writes a minute pinned at RATE_COOLDOWN_MS,
 *    with the seconds carrying a write off-pace twice as often as the seconds
 *    without (52% vs 25%), and half of them within 1.5s of a cut. Same
 *    engine, same cost, same fix.
 *
 *  Chromium absorbs both operations cheaply, which is why the Windows build
 *  of this same code never showed any of it. The profiles themselves live in
 *  lib/driftProfile.ts, pure and pinned; the engine is decided ONCE here. */
const IS_WEBKIT = isWebKitMedia(navigator.userAgent);
const VIDEO_DRIFT: DriftProfile = videoDriftProfile(IS_WEBKIT);
/** See lib/driftProfile.ts — what a play() costs on this engine decides all
 *  three: whether the post-play snap exists, how long the transport clock waits
 *  for the picture at play, and how early the next clip is started at a cut. */
const SNAP_AFTER_PLAY = snapAfterPlay(IS_WEBKIT);
const START_HOLD_MS = startHoldMs(IS_WEBKIT);
const WARM_LEAD_MS = warmLeadMs(IS_WEBKIT);
/** At most one playbackRate write per element per window.
 *
 *  A LEAN IS NOT FREE ON WEBKIT, and the band above used to be narrow enough
 *  that it oscillated across it about once a second. Measured in a packaged
 *  macOS build (`tauri://localhost`, WKWebView): 155 rate writes on ONE audio
 *  element over a single playback — a sustained 2-4 per second — on an element
 *  that was otherwise perfectly healthy (readyState ENOUGH, 120s buffered,
 *  unmuted, full volume). Each write re-primes the AVFoundation audio
 *  renderer, which is audible as a dropout AND reports `currentTime`
 *  BACKWARDS afterwards (0.01-0.20s, all well under DRIFT_SEEK_S, so none of
 *  them were our seeks). That jitter is then read as fresh drift and provokes
 *  the next correction: a positive feedback loop that ends with the audio
 *  gone and the picture hitching. Chromium absorbs rate changes smoothly, so
 *  the Windows build of the same code sounds fine — which is exactly why this
 *  went unnoticed.
 *
 *  So the band is now wider than the observed jitter (0.06-0.12 rather than
 *  0.015-0.05), and writes are rate-limited on top. Worst case the picture
 *  sits up to 120ms off the clock, which is under a quarter of the seek
 *  threshold and far below what the old thrash was costing. On WebKit the
 *  picture is no longer leaned at all (VIDEO_DRIFT), so this cooldown only
 *  ever paces Chromium now. */
const RATE_COOLDOWN_MS = 750;
const STALL_SHOW_MS = 400;     // a video stalled this long shows the badge
/** How far the mirrored target has to move before a reversed clip is seeked
 *  again — one frame at 24fps, this studio's grid. Below that the picture on
 *  screen is already the right frame and a seek would only flush the decoder.
 *  It is also what settles the scrub when the transport is paused. */
const REVERSE_STEP_S = 0.04;
/** How far ahead of the playhead an audio clip starts buffering. Mounting
 *  every audio lane clip at preload="auto" fetched the whole timeline's audio
 *  the moment the editor opened, starving the active video stream. */
const AUDIO_PRELOAD_MS = 12000;
/** Same idea for the pre-rolled NEXT video on each lane: it mounts at
 *  preload="metadata" and only pulls frames in earnest this far ahead. It used
 *  to mount at preload="auto", so every lane ran a second full-rate download
 *  beside the stream actually playing — which is exactly the condition that
 *  starves the active element (readyState < 3) and reads as chop. */
const VIDEO_PRELOAD_MS = 10000;
/** How far ahead the MOUNTED run has to reach, and the ceiling on how many
 *  elements may be spent reaching it.
 *
 *  Mounting exactly one upcoming clip is ten seconds of runway on an ordinary
 *  shot and half a second on a half-second one — the next element only appears
 *  when the playhead crosses a boundary, so a lane of very short clips gives
 *  every element the length of ONE clip to fetch its metadata, seek and buffer
 *  to readyState 3 before the cut lands on it. Below about a second that is not
 *  enough, and a cold element at the cut is the chop.
 *
 *  So the run is measured in TIME. For any clip at or over the lookahead this
 *  is byte-for-byte the single upcoming clip it always was, which is why it
 *  cannot regress the case the element budget was tuned against; it engages
 *  only where the old rule was already starved. The cap is what stops a lane of
 *  quarter-second clips mounting a wall of decoders. */
const VIDEO_LOOKAHEAD_MS = 2000;
const MAX_PREROLL = 3;

/** How often a failed media load is re-tried, and how many times.
 *
 *  A MEDIA ELEMENT NEVER RETRIES ON ITS OWN. One `error` event is permanent
 *  until the element unmounts or something calls `load()` — so a miss that
 *  lasted a second presented as a dead clip for as long as the playhead sat
 *  still, and moving it (which remounts the element) was the only cure.
 *
 *  The miss that prompted this is real and routine: on a LOCAL project the
 *  pipeline's Python writes a render into the project's media folder and
 *  registers the row through the loopback proxy, while the browser's own
 *  present-set (localPlane's `mediaKeys`) learns the key on a debounced
 *  rescan. Between the two, `mediaUrl()` correctly falls through to the CDN —
 *  where a local project's media has never been — and the element 404s.
 *
 *  So the retry has to be a RE-RENDER and not a bare `load()`: what changes is
 *  the URL. `load()` rides along for the case where it does not (a cold object
 *  at the edge), because React leaves an unchanged attribute alone. */
const MEDIA_RETRIES = 4;
const MEDIA_RETRY_MS = 800;

/** RAF-driven preview player.
 *
 * Engine: for every video track we keep the clip under the playhead plus the
 * next clip mounted (keyed by clip id, so the pre-rolled element *becomes*
 * the active one at a boundary — no remount, no gap). All time/play state is
 * pushed imperatively from the master clock; React renders only when the
 * (active, next) pair changes, i.e. once per boundary crossing.
 * Audio lanes ride along as one <audio> per clip. Drift is corrected by
 * leaning playbackRate, never by seeking while healthy — see converge().
 * Track mute + per-clip gain are honoured for video and audio alike (a locked
 * -audio MV mutes V1 so the master track on A1 is the only copy you hear). */
export default function PreviewPlayer({ bare = false }: { bare?: boolean } = {}) {
  // Selectors, not the bare hook: subscribing to the whole store re-rendered
  // the player — and scheduled a full media-sync pass — on EVERY store change,
  // selection clicks included. These three are the only fields it reads.
  const clips = useTimelineStore((s) => s.clips);
  const tracks = useTimelineStore((s) => s.tracks);
  const assets = useTimelineStore((s) => s.assets);
  const onTick = usePlaybackStore((s) => s.onTick);
  const setDuration = usePlaybackStore((s) => s.setDuration);
  const durationMs = useTimelineStore((s) => s.durationMs());
  const timeRef = useRef<HTMLSpanElement>(null);
  const videoEls = useRef(new Map<string, HTMLVideoElement>());
  // Stills are their own map rather than a widened `videoEls`: everything the
  // sync loop does to a video (play, seek, converge, mute) is meaningless on a
  // picture, and one map of HTMLElement would have every call site asking
  // which it had.
  const stillEls = useRef(new Map<string, HTMLImageElement>());
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  const lastSeekAt = useRef(new WeakMap<HTMLMediaElement, number>());
  /** When play() last RESOLVED, per element. converge() corrects nothing for
   *  START_GRACE_MS after it: the promise landing is not the picture moving,
   *  and the gap between the two read as drift at every cut. */
  const playedAt = useRef(new WeakMap<HTMLMediaElement, number>());
  const stallSince = useRef(0);
  /** Mirrors `stalled` so the tick loop only dispatches on a transition. */
  const stalledRef = useRef(false);
  /** Per-tick mix snapshot (lane id -> audible), reused across ticks. */
  const laneAudible = useRef(new Map<string, boolean>()).current;
  // elements with a play() promise in flight — touching currentTime while one
  // is pending ABORTS it ("interrupted by a seek"), which left media scrubbed
  // by the clock instead of playing. Never seek an element in this set.
  const pendingPlay = useRef(new WeakSet<HTMLMediaElement>());
  const [, force] = useState(0); // bumped when the mounted slot set changes
  const [mediaErr, setMediaErr] = useState<string | null>(null);
  /** Clips whose media failed to load, and how many attempts each has had.
   *  A ref: the retry is what re-renders, and the tally must not be part of
   *  what a render reads. An entry lives until that clip's own element
   *  reports a successful load. */
  const failed = useRef(new Map<string, number>());
  const [retry, setRetry] = useState(0);
  const [stalled, setStalled] = useState(false);
  // The stage in CSS px. A crop is the one picture op whose preview needs the
  // box: the layer fills it and `object-fit: contain` letterboxes the picture
  // inside, so the window's placement is derivable from this plus the media's
  // own dimensions — see lib/clipCrop.ts. Nothing else re-renders on it (the
  // transport is imperative), and it changes only when the panel is resized.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });

  /** The screen's refresh rate, sampled once. It is what decides whether a
   *  clip can be PLAYED at all (`shouldScrub`): past it the surplus frames
   *  cannot be shown. Measured rather than assumed because a ProMotion Mac is
   *  120 and would play — WITH SOUND — everything a 60Hz one has to scrub. A
   *  hidden tab fires no rAF, so it keeps the default and nothing is scrubbed
   *  that would not have been anyway. */
  /** `assets` as of the last render, for the sync loop to read.
   *
   *  NOT a dependency of the sync effect: `ensureAssets` replaces that map
   *  whenever a row arrives, and rebuilding the loop on that cadence is churn.
   *  NOT read from the effect's own closure either — that is the stale-copy
   *  trap the deps comment at the bottom of the effect already names, and here
   *  it would silently fall back to the assumed frame rate. */
  const assetsRef = useRef(assets);
  useEffect(() => { assetsRef.current = assets; });

  // The transport clock waits for the picture at play (usePlaybackStore's
  // header). Set for the life of this player and withdrawn with it, so a
  // timeline with no player mounted keeps the clock it always had.
  useEffect(() => {
    usePlaybackStore.getState().setStartHold(START_HOLD_MS);
    return () => usePlaybackStore.getState().setStartHold(0);
  }, []);

  const displayHz = useRef(DEFAULT_DISPLAY_HZ);
  useEffect(() => {
    let raf = 0, prev = 0, n = 0;
    const gaps: number[] = [];
    const step = (t: number) => {
      if (prev) gaps.push(t - prev);
      prev = t;
      if (++n < 24) { raf = requestAnimationFrame(step); return; }
      if (!gaps.length) return;
      // MEDIAN, not mean: the first frames after mount are routinely long, and
      // one 200ms hitch in the sample would halve the answer.
      const mid = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
      if (mid > 2 && mid < 100) displayHz.current = Math.round(1000 / mid);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekTo = (el: HTMLMediaElement, sec: number, threshold: number) => {
    if (pendingPlay.current.has(el)) return;
    if (el.readyState < 1) { el.dataset.seekTo = String(sec); return; }
    if (Math.abs(el.currentTime - sec) > threshold) el.currentTime = sec;
  };
  /** Write playbackRate at most once per RATE_COOLDOWN_MS per element.
   *
   *  The `!==` check alone is not enough: the oscillation writes a DIFFERENT
   *  value each time (lean, then base, then lean), so every write passed it.
   *  See RATE_COOLDOWN_MS for the measurement this exists to stop. */
  const lastRateAt = useRef(new WeakMap<HTMLMediaElement, number>());
  const setRate = (el: HTMLMediaElement, r: number, now: number) => {
    if (el.playbackRate === r) return;
    if (now - (lastRateAt.current.get(el) ?? 0) < RATE_COOLDOWN_MS) return;
    lastRateAt.current.set(el, now);
    el.playbackRate = r;
    if (import.meta.env.DEV) diag(`RATE ${tagOf(el)} ${r}`);
  };

  /** Keep a PLAYING element on the clock without glitching it (see the tuning
   *  block above). Returns true when the element is stalled waiting on data —
   *  nothing to correct until it recovers, and a seek would abort the very
   *  fetch it is waiting on. */
  const converge = (el: HTMLMediaElement, sec: number, baseRate: number, now: number, prof: DriftProfile) => {
    if (pendingPlay.current.has(el)) return el.readyState < 3; // a slow start IS a stall
    if (el.seeking || el.readyState < 3) {
      // Correctness, not tuning: an element that cannot advance must not be
      // left leaning. Exempt from the cooldown, and rare by construction.
      if (el.playbackRate !== baseRate) { el.playbackRate = baseRate; lastRateAt.current.set(el, now); }
      return el.readyState < 3;
    }
    // Just started: whatever it is behind by is start latency, not drift, and
    // a correction here is the glitch it would be trying to prevent. The
    // stall check above is deliberately NOT inside the grace.
    if (now - (playedAt.current.get(el) ?? 0) < START_GRACE_MS) return false;
    const drift = el.currentTime - sec; // > 0 ahead of the clock, < 0 behind
    // DRIFT IS SOURCE SECONDS AND THE THRESHOLDS ARE ABOUT THE WALL CLOCK, so
    // it is divided by the clip's own speed before either is consulted.
    //
    // `seek: 0.5` means "half a second of visible desync, i.e. a real one
    // rather than renderer jitter" — and on a x4 clip half a second of SOURCE
    // is 125ms of wall clock, which is one decode hiccup, one React render at
    // a cut, one GC pause. Every one of those crossed the threshold and took a
    // seek, and a seek flushes the decode pipeline, which is the next hiccup:
    // the feedback loop the profiles exist to break, re-entering through the
    // rate. `cooldownMs` does not bound it either, because it is keyed per
    // ELEMENT and a lane of short clips hands every cut a fresh one.
    //
    // Reported from the fixed build at exactly the boundary this predicts —
    // fine at x2 (a 250ms hiccup), lagging above it (x4 needs only 125ms).
    // Dividing makes the threshold a constant HALF A SECOND OF WALL CLOCK at
    // every speed, which is what it always meant; at rate 1 it is arithmetic
    // that changes nothing, so no case measured before this can move.
    const off = Math.abs(drift) / baseRate;
    if (off > prof.seek) {
      const at = lastSeekAt.current.get(el) ?? 0;
      // A held clock means the user just seeked and is waiting on exactly this
      // element; the cooldown is for corrections nobody asked for.
      if (now - at > prof.cooldownMs || usePlaybackStore.getState().isHeld()) {
        lastSeekAt.current.set(el, now);
        if (import.meta.env.DEV) diag(`SEEK ${tagOf(el)} off=${Math.round(off * 1000)}ms drift=${drift.toFixed(3)} rate=${baseRate} t=${el.currentTime.toFixed(3)} want=${sec.toFixed(3)}`);
        el.currentTime = sec;
      } else if (import.meta.env.DEV) {
        diag(`SEEK-HELD ${tagOf(el)} off=${Math.round(off * 1000)}ms`);
      }
      setRate(el, baseRate, now);
    } else if (off > prof.nudge) {
      setRate(el, baseRate * (drift < 0 ? 1 + NUDGE : 1 - NUDGE), now);
    } else if (off < prof.settled) {
      setRate(el, baseRate, now);
    }
    return false;
  };
  /** Where the element is on the TIMELINE right now, for the clock to adopt.
   *  Null when it cannot be said (a reversed clip, an element still at its
   *  parked frame). */
  type Anchor = () => number | null;
  /** Is a video the cut needs still on its way — its play() pending, or its
   *  element not even mounted yet? A seek onto a clip that was not mounted
   *  changes the slot set in the same pass; React commits the element after
   *  it, so for a frame the active slot has no element at all. Both release
   *  paths ask this, or the audio lane (which mounts once for the whole cut and
   *  starts in tens of ms) hands the clock its own position while the picture
   *  is still being created — measured as the first clip after a scrub landing
   *  105ms late while every other cut was within a frame. */
  const videoStarting = () => {
    for (const slots of slotsRef.current.values()) {
      for (const s of slots) {
        if (!s.active || stillEls.current.has(s.clip.id)) continue;
        // A scrubbed clip is paused on purpose and never "starts".
        if (clipReversed(s.clip) || shouldScrub(
          IS_WEBKIT, assetsRef.current.get(s.clip.asset_id)?.fps, clipRate(s.clip), displayHz.current)) continue;
        const v = videoEls.current.get(s.clip.id);
        // Not mounted yet, play() in flight, mounted and not yet TOLD to play
        // (the tick that will is the next one), still seeking to its frame, or
        // without enough data to move — all still starting. play()'s promise
        // resolves while the element is still seeking (RUN 6: `playing` fired
        // at +80ms, the seek landed at +1290ms), so the promise alone is not
        // "the picture moves".
        if (!v || pendingPlay.current.has(v) || v.paused || v.seeking || v.readyState < 3) return true;
      }
    }
    return false;
  };
  const ensurePlaying = (el: HTMLMediaElement, sec: number, rate: number, getSec: () => number, anchor?: Anchor) => {
    delete el.dataset.stopWhenReady;
    delete el.dataset.warm;   // an element that reaches here is the shot on screen, warmed or not
    if (!el.paused || pendingPlay.current.has(el)) return; // converge() owns it now
    // NEVER play() INTO A SEEK. A scrub while paused seeks the parked element,
    // and the press of play routinely lands before that seek has: on WebKit a
    // play() on a still-seeking element is the startup pathology this player
    // was reported for — RUN 6 measured the seek taking 1.2s to land WITH the
    // main thread blocked for the same 1.2s, and RUN 1 the same shape at
    // 1.4-1.9s. Left alone until the next tick after `seeked`, the same
    // element starts in tens of milliseconds. The held clock waits meanwhile
    // (`videoStarting` counts a seeking element as starting).
    if (el.seeking) return;
    // THE CLIP'S OWN SPEED, WRITTEN WHILE THE ELEMENT IS STILL PAUSED. A
    // retimed clip's rate is a fact about the clip, not a correction — and it
    // used to be set only by converge(), which cannot write it until the
    // element is playing, past the start grace and past the cooldown. So a x4
    // clip PLAYED ITS FIRST ~250-450ms AT 1x on every cut: the target advances
    // at 4x wall clock (localSec), so by the time the rate landed the element
    // was ~1s of source behind, over the seek threshold, and took a seek AND a
    // rate write together — both of them the expensive AVFoundation operations
    // the drift profiles exist to ration. On a half-second clip that is the
    // whole clip. Here there is nothing to fight (converge only leans a
    // PLAYING element) and no cooldown to wait out.
    if (el.playbackRate !== rate) {
      el.playbackRate = rate;
      lastRateAt.current.set(el, performance.now());
    }
    // Scaled for the same reason converge()'s thresholds are: 0.08 source
    // seconds is 20ms of wall clock on a x4 clip, so unscaled this fired on
    // every play of a retimed clip whether or not anything was wrong.
    if (el.readyState >= 1 && Math.abs(el.currentTime - sec) > 0.08 * rate) el.currentTime = sec;
    else if (el.readyState < 1) el.dataset.seekTo = String(sec);
    // An element routed through the effect graph is silent while the
    // AudioContext is suspended by the autoplay policy. No-op when there is no
    // context, i.e. whenever nothing on the timeline has effects.
    resumeAudio();
    pendingPlay.current.add(el);
    const playCalledAt = performance.now();
    if (import.meta.env.DEV) diag(`PLAY ${tagOf(el)} want=${sec.toFixed(3)} rate=${rate} rs=${el.readyState} t=${el.currentTime.toFixed(3)}`);
    const settle = () => {
      pendingPlay.current.delete(el);
      playedAt.current.set(el, performance.now());
      if (import.meta.env.DEV) diag(`PLAYED ${tagOf(el)} +${Math.round(performance.now() - playCalledAt)}ms rs=${el.readyState} t=${el.currentTime.toFixed(3)} want=${getSec().toFixed(3)} paused=${el.paused}`);
      if (el.dataset.stopWhenReady) { delete el.dataset.stopWhenReady; el.pause(); return; }
      const pb = usePlaybackStore.getState();
      if (el.paused || !pb.playing) return;
      // TRANSPORT START: the clock has been waiting for this. Hand it where the
      // picture actually is and let it run from there — the picture is the
      // clock, not the other way round. A video element decides it; an audio
      // one only when no video is still starting, so a cut with both does not
      // anchor the clock to whichever lane happened to spin up first.
      if (pb.isHeld()) {
        // A seeking element has a position that is a TARGET, not a place; the
        // per-tick "landed" check releases once it is really there.
        if (el.seeking) return;
        if (el instanceof HTMLVideoElement || !videoStarting()) {
          const at = anchor?.() ?? undefined;
          if (import.meta.env.DEV) diag(`RELEASE ${tagOf(el)} anchor=${at == null ? "-" : Math.round(at)} t=${el.currentTime.toFixed(3)}`);
          pb.release(at ?? undefined);
        }
        return;
      }
      // MID-PLAY CUT. play() start latency leaves the element behind by however
      // long the pipeline took to spin up. On Chromium a snap now, while the
      // clip is frames old, is far less visible than the same correction
      // landing mid-shot. On WebKit it is NEVER done: a seek issued into
      // AVFoundation's startup took 1.4-1.9s to land (measured), which is the
      // freeze this player was reported for — a start that came out 300ms
      // behind is left 300ms behind for the length of the clip instead.
      if (SNAP_AFTER_PLAY) {
        const t = getSec();
        if (Math.abs(el.currentTime - t) > START_SNAP_S * rate) el.currentTime = t;
      }
    };
    el.play().then(settle, settle);
  };
  /** Start an upcoming clip's element EARLY — muted, still hidden — so the
   *  play() block (see lib/driftProfile.ts) lands during the outgoing shot
   *  rather than on the boundary frame. It runs from the frame it was parked
   *  on, so at the cut it is at most WARM_LEAD_MS ahead — a frame or two in the
   *  common case — and converge() takes it from there like any other element.
   *  `data-warm` is what stops the park logic pausing it again, and what lets
   *  `unwarm` stop it if the playhead moves away before the cut. */
  const warmUp = (el: HTMLMediaElement) => {
    if (!el.paused || pendingPlay.current.has(el) || el.seeking) return;   // its park seek is still landing
    el.dataset.warm = "1";
    if (!el.muted) el.muted = true;
    pendingPlay.current.add(el);
    const at = performance.now();
    if (import.meta.env.DEV) diag(`WARM ${tagOf(el)} rs=${el.readyState} t=${el.currentTime.toFixed(3)}`);
    const settle = () => {
      pendingPlay.current.delete(el);
      playedAt.current.set(el, performance.now());
      if (import.meta.env.DEV) diag(`WARMED ${tagOf(el)} +${Math.round(performance.now() - at)}ms paused=${el.paused}`);
      if (el.dataset.stopWhenReady) { delete el.dataset.stopWhenReady; el.pause(); }
    };
    el.play().then(settle, settle);
  };
  /** A warmed element whose cut is no longer coming: stop it and let the park
   *  logic re-aim it (it has run past its opening frame). */
  const unwarm = (el: HTMLMediaElement) => {
    if (el.dataset.warm !== "1") return;
    delete el.dataset.warm;
    delete el.dataset.parked;
    stopEl(el);
  };
  /** pause that survives an in-flight play() (play → immediate pause). */
  const stopEl = (el: HTMLMediaElement) => {
    if (pendingPlay.current.has(el)) { el.dataset.stopWhenReady = "1"; return; }
    if (!el.paused) el.pause();
  };

  /** DRIVE AN ELEMENT FROM THE CLOCK INSTEAD OF PLAYING IT.
   *
   *  Two kinds of clip need this, for the same underlying reason — the engine
   *  will not play them the way the timeline requires:
   *
   *  - a REVERSED clip, because `playbackRate` must be positive everywhere;
   *  - a clip whose `source fps x rate` is past the display's refresh rate,
   *    which on WebKit is also where AVFoundation stops keeping time. See
   *    `shouldScrub` in lib/driftProfile.ts for the measurements.
   *
   *  REVERSED PLAYBACK, which no browser will do for us.
   *
   *  `playbackRate` must be POSITIVE in every shipping engine — the HTML spec
   *  allows a negative one and Chromium, WebKit and Gecko all refuse it — so a
   *  reversed clip cannot be played at all. It can only be SCRUBBED: the
   *  element stays paused and the clock drives `currentTime` backwards through
   *  the mirrored mapping in localSec.
   *
   *  ONE SEEK IN FLIGHT AT A TIME is the whole tuning, and it is not the same
   *  problem the drift profiles solve. Seeking backwards decodes from the
   *  previous keyframe every time, so a seek per rAF frame would queue faster
   *  than the decoder retires them and the picture would freeze on whichever
   *  one was in flight when the clip started. Issuing the next only once the
   *  last has landed makes it self-pacing: near-smooth on a cheap file, a
   *  slideshow that still tracks the clock on an expensive one, and never a
   *  storm. For the same reason it never raises the stall badge — a scrubbing
   *  clip is not waiting on the network.
   *
   *  It is SILENT, and that is the medium rather than a decision: a paused
   *  element makes no sound, and there is no way to run an audio stream
   *  backwards in a browser either. The render does (`areverse`), so the
   *  soundtrack of a reversed clip is one of the few things only the flatten
   *  can show. */
  const scrubTo = (el: HTMLMediaElement, sec: number) => {
    if (import.meta.env.DEV && el.dataset.diagScrub !== "1") {
      el.dataset.diagScrub = "1";
      diag(`SCRUB ${tagOf(el)} rs=${el.readyState} want=${sec.toFixed(3)}`);
    }
    stopEl(el);   // a stray play() would run it FORWARDS, which is the bug
    if (el.readyState < 1) { el.dataset.seekTo = String(sec); return; }
    if (el.seeking || pendingPlay.current.has(el)) return;   // one at a time
    if (Math.abs(el.currentTime - sec) > REVERSE_STEP_S) el.currentTime = sec;
  };
  /** The half of a layer that is the same for a clip and for a still: which
   *  one is on top, and the crossfade ramp into it. */
  const paintLayer = (el: HTMLElement, s: Slot, ms: number) => {
    if (!s.active) {
      el.classList.remove("active");
      // An xfade ramp leaves an INLINE opacity, which beats .pv-layer's own
      // rule — so a clip that finished a crossfade and then left the active
      // slot stayed fully visible over whatever replaced it. Only reachable by
      // scrubbing backwards onto a clip that has already played, and more
      // reachable now that a lane of short clips pre-rolls several.
      if (el.style.opacity !== "") el.style.opacity = "";
      return;
    }
    const tr = s.clip.transition_in;
    if (tr?.type === "xfade" && tr.dur_ms) {
      const f = Math.min(1, Math.max(0, (ms - s.clip.t_start_ms) / tr.dur_ms));
      el.style.opacity = String(0.05 + 0.95 * f);
    } else if (el.style.opacity !== "") {
      el.style.opacity = "";
    }
    el.classList.add("active");
  };
  const onMeta = (e: React.SyntheticEvent<HTMLMediaElement>, clipId?: string) => {
    const el = e.currentTarget;
    if (clipId) failed.current.delete(clipId);
    setMediaErr(null);
    if (el.dataset.seekTo != null) {
      el.currentTime = +el.dataset.seekTo;
      delete el.dataset.seekTo;
    }
  };
  /** A failed media load must never present as an unexplained black frame —
   *  and must never present as a PERMANENT one either.
   *
   *  THE BANNER WAITS OUT THE WHOLE RETRY BUDGET. A miss that heals in a
   *  second otherwise flashed a red error at a clip that was about to play,
   *  which is worse than saying nothing: the stage already shows "buffering…"
   *  while an element has no data. It is armed once, on the first failure, and
   *  fires only if the clip is still failing when the budget runs out —
   *  including for a still, whose <img> may never re-error because an
   *  unchanged `src` is never re-fetched. */
  const onMediaError = (clipId: string, label: string, key?: string) => {
    const n = failed.current.get(clipId) ?? 0;
    failed.current.set(clipId, n + 1);
    if (n === 0) {
      const msg = `Couldn't load "${label}"${key ? ` (${key.split("/").pop()})` : ""} — check the B2 URL is reachable.`;
      window.setTimeout(() => {
        if (failed.current.has(clipId)) setMediaErr(msg);
      }, MEDIA_RETRY_MS * (MEDIA_RETRIES + 1));
    }
    if (n >= MEDIA_RETRIES) return;
    window.setTimeout(() => {
      if (failed.current.has(clipId)) setRetry((t) => t + 1);
    }, MEDIA_RETRY_MS);
  };
  // The retry itself, AFTER the render its bump caused — which is the point:
  // `srcOf` has been recomputed by then, so an element whose URL has since
  // changed is already loading the right one and this `load()` merely
  // restarts it. An element whose URL did NOT change gets the only retry it
  // can have. Only ever aimed at elements that are actually failing, since
  // load() on a healthy one would interrupt it.
  useEffect(() => {
    if (!retry) return;
    for (const id of [...failed.current.keys()]) {
      const el = videoEls.current.get(id) ?? audioEls.current.get(id);
      if (el) el.load();
      // A clip that has gone from the lane takes its tally with it, or the
      // map keeps a failure nothing can clear.
      else if (!stillEls.current.has(id)) failed.current.delete(id);
    }
  }, [retry]);

  const videoTracks = useMemo(
    () => tracks.filter((t) => t.kind === "video").sort((a, b) => a.idx - b.idx),
    [tracks]);
  const audioTracks = useMemo(() => {
    const m = new Map<string, Track>();
    for (const t of tracks) if (t.kind === "audio") m.set(t.id, t);
    return m;
  }, [tracks]);
  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  const byTrack = useMemo(() => {
    const m = new Map<string, Clip[]>();
    for (const t of videoTracks) m.set(t.id, []);
    for (const c of clips) m.get(c.track_id)?.push(c);
    for (const arr of m.values()) arr.sort((a, b) => a.t_start_ms - b.t_start_ms);
    return m;
  }, [clips, videoTracks]);
  const aclips = useMemo(
    () => clips.filter((c) => audioTracks.has(c.track_id)),
    [clips, audioTracks]);

  useEffect(() => setDuration(durationMs), [durationMs, setDuration]);

  // ---- audio effects -------------------------------------------------------
  // Live effects need Web Audio, and Web Audio needs a CORS-readable media
  // host: a MediaElementAudioSourceNode built from a cross-origin element the
  // host has not approved outputs silence rather than an error. So the probe
  // runs once, against a URL we were going to load anyway, and only when some
  // clip actually carries an effect — no effects, no request.
  const [corsOk, setCorsOk] = useState(false);
  /** Lanes carrying a rack of their own, and what is on it. */
  const fxLanes = useMemo(
    () => new Map([...audioTracks.values()]
      .map((t) => [t.id, previewFx(normalizeFx(t.audio_fx))] as const)
      .filter(([, fx]) => fx.length)),
    [audioTracks]);
  // previewFx, not activeFx: an EQ that is currently flat still needs its
  // chain, because its display is a spectrum read off that chain's analyser.
  //
  // A clip on a lane WITH a rack is in here too, with an empty chain of its
  // own: it has to be summed into the lane's bus, and an element that is not
  // attached to the graph cannot reach one. That is also why the map is what
  // the CORS gate and the `crossOrigin` key are both keyed off — a clip whose
  // bytes the browser may not read cannot join a bus either.
  const fxClips = useMemo(
    () => new Map(aclips
      .map((c) => [c.id, previewFx(normalizeFx(c.audio_fx))] as const)
      .filter(([id, fx]) => fx.length
        || fxLanes.has(aclips.find((c) => c.id === id)?.track_id ?? ""))),
    [aclips, fxLanes]);
  // Probe the URL the CORS element will actually request, marker and all.
  const probeUrl = fxClips.size
    ? corsSrcOf(assets.get(aclips.find((c) => fxClips.has(c.id))!.asset_id)) : undefined;

  useEffect(() => {
    if (!probeUrl || !fxSupported()) return;
    // On desktop the bytes come through Rust and become a same-origin blob, so
    // there is no origin for the host to refuse and nothing to probe. Asking
    // anyway is what produced a CORS error in the console on every session.
    if (needsCorsProxy()) { setCorsOk(true); return; }
    let alive = true;
    void probeCors(probeUrl).then((ok) => alive && setCorsOk(ok));
    return onCorsChange(() => alive && setCorsOk(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeUrl]);

  /** Blob URLs for the effect-carrying clips, on the builds that need them.
   *  `nBlobs` exists only to re-render when one lands — the cache itself is
   *  module-level, so it survives this component and is shared with the
   *  panel. */
  const [, setNBlobs] = useState(0);
  useEffect(() => {
    if (!needsCorsProxy() || !fxSupported()) return;
    let alive = true;
    // The full in-use set FIRST: the cache frees blobs by being told what is
    // still referenced (retainCorsUrls), never by an internal LRU — an evicted
    // blob under a mounted element is a clip that silently stops playing.
    const inUse = new Set<string>();
    const bytesOf = new Map<string, number | null>();
    for (const id of fxClips.keys()) {
      const a = assets.get(aclips.find((c) => c.id === id)?.asset_id ?? "");
      const url = srcOf(a);
      if (!url) continue;
      inUse.add(url);
      bytesOf.set(url, a?.bytes ?? null);
    }
    retainCorsUrls(inUse);
    for (const url of inUse) {
      if (cachedCorsUrl(url)) continue;
      void ensureCorsUrl(url, bytesOf.get(url) ?? null).then((got) => {
        if (got && alive) setNBlobs((n) => n + 1);
      });
    }
    return () => { alive = false; };
  }, [fxClips, aclips, assets]);

  // The lane a clip is on, by clip id — the applyFx pass and the sync loop both
  // need it, and neither should scan the clip list per element. Declared above
  // the effect deliberately: a dependency array is built during render, so a
  // `const` declared below it would still be in its temporal dead zone there.
  const clipTrack = useMemo(
    () => new Map(aclips.map((c) => [c.id, c.track_id])), [aclips]);

  // Attach / update / release, once per render rather than per frame. A chain
  // relinks only when its shape changed — see audioGraph.applyFx.
  useEffect(() => {
    if (!corsOk) return;
    // Lanes first: `applyFx` routes an element into its bus, and the bus's
    // input has to exist by then. It is created synchronously (the rack's own
    // nodes land later), so one pass in this order is enough.
    for (const [id, fx] of fxLanes) applyBusFx(id, fx);
    for (const [id, fx] of fxClips) {
      const el = audioEls.current.get(id);
      const lane = clipTrack.get(id) ?? "";
      if (el) applyFx(el, fx, fxLanes.has(lane) ? lane : null);
    }
    // A lane that lost its rack: every element on it was re-routed straight to
    // the destination in the loop above, so the bus is safe to drop now.
    for (const id of busIds()) if (!fxLanes.has(id)) releaseBus(id);
  }, [corsOk, fxClips, fxLanes, clipTrack]);

  /** A STABLE ref callback per clip.
   *
   *  An inline `ref={(el) => …}` is a new function every render, and React
   *  answers that by calling the old one with null and the new one with the
   *  element — on EVERY render, not just on unmount. Harmless while the
   *  callback only wrote to a Map; with an effect chain hanging off it, every
   *  re-render tore the chain down and left the element routed through
   *  nothing. Memoised per id, React only calls it when the element really
   *  arrives or really goes. */
  const audioRefs = useRef(new Map<string, (el: HTMLAudioElement | null) => void>());
  const audioRef = (id: string) => {
    let cb = audioRefs.current.get(id);
    if (!cb) {
      cb = (el: HTMLAudioElement | null) => {
        if (el) {
          audioEls.current.set(id, el);
        } else {
          const prev = audioEls.current.get(id);
          if (prev) disposeFx(prev);      // or its LFOs outlive the element
          audioEls.current.delete(id);
        }
      };
      audioRefs.current.set(id, cb);
    }
    return cb;
  };

  // The mounted slot set, recomputed against the playhead. Kept in a ref so
  // the tick handler can detect changes without re-rendering per frame.
  //
  // NB the change test compares the clip OBJECT, not its id. It used to compare
  // ids alone, which meant an edit that changed a clip without changing which
  // clip was on screen — every effect in the inspector, a gain change, a
  // transition, a take swap (asset_id) — left this ref holding the clip as it
  // was when the playhead last crossed a boundary. The store had the new
  // values, the timeline drew them, and the player went on reading the stale
  // copy: the flip/scale transform, the playback rate and the <video> src are
  // all taken from here. That is "the effect doesn't apply until I refresh".
  // The store replaces a patched clip with a new object, so reference equality
  // is the exact signal, and it stays one comparison per lane per frame.
  const slotsRef = useRef(new Map<string, Slot[]>());
  const computeSlots = (ms: number) => {
    const next = new Map<string, Slot[]>();
    let changed = false;
    for (const t of videoTracks) {
      const lane = byTrack.get(t.id) ?? [];
      const active = lane.find((c) => ms >= c.t_start_ms && ms < c.t_start_ms + c.duration_ms);
      const slots: Slot[] = [];
      if (active) slots.push({ clip: active, active: true });
      // See VIDEO_LOOKAHEAD_MS. The FIRST upcoming clip is mounted whatever the
      // distance, exactly as before; further ones only while the run is still
      // short of the lookahead.
      let from = active ? active.t_start_ms + active.duration_ms : ms;
      // `taken` is not belt-and-braces: a zero-length clip does not advance
      // `from`, so a bare time test would pick it again and mount a second
      // slot under the same React key.
      const taken = new Set<string>(active ? [active.id] : []);
      for (let n = 0; n < MAX_PREROLL; n++) {
        const up = lane.find((c) => c.t_start_ms >= from && !taken.has(c.id));
        if (!up) break;
        taken.add(up.id);
        slots.push({ clip: up, active: false });
        from = up.t_start_ms + up.duration_ms;
        if (from >= ms + VIDEO_LOOKAHEAD_MS) break;
      }
      next.set(t.id, slots);
      const prev = slotsRef.current.get(t.id) ?? [];
      if (prev.length !== slots.length ||
          prev.some((s, i) => s.clip !== slots[i].clip || s.active !== slots[i].active)) {
        changed = true;
      }
    }
    if (changed || slotsRef.current.size !== next.size) {
      if (import.meta.env.DEV) {
        for (const [tid, slots] of next) {
          diag(`SLOTS lane=${trackById.get(tid)?.idx ?? "?"} at=${Math.round(ms)} ` + slots.map((s) =>
            `${s.active ? "*" : ""}${s.clip.id.slice(0, 8)}:${s.clip.label ?? ""}@${s.clip.t_start_ms}+${s.clip.duration_ms}` +
            `${clipRate(s.clip) !== 1 ? "x" + clipRate(s.clip) : ""}`).join(" "));
        }
      }
      slotsRef.current = next;
      force((n) => n + 1);
    }
  };

  // The whole per-tick media sync, kept in a ref so (a) the tick handler and
  // (b) a post-render pass share one implementation — the post-render pass is
  // what converges elements that mounted AFTER the last transport event
  // (e.g. a paused seek into a clip that wasn't mounted yet).
  const syncRef = useRef<(ms: number) => void>(() => {});

  useEffect(() => {
    computeSlots(usePlaybackStore.getState().nowMs());
    syncRef.current = (ms: number) => {
      const playing = usePlaybackStore.getState().playing;
      const now = performance.now();
      if (timeRef.current) {
        const s = `${fmt(ms)} / ${fmt(durationMs)}`;
        if (timeRef.current.textContent !== s) timeRef.current.textContent = s;
      }
      computeSlots(ms);

      // The mix, ONCE per tick per lane. isAudible is an O(tracks) solo scan
      // and this loop used to ask it per clip per frame — with the audio walk
      // below running over every clip on the timeline, that alone was
      // thousands of scans a second on a real cut.
      laneAudible.clear();
      for (const t of tracks) laneAudible.set(t.id, isAudible(t, tracks));

      // ---- video layers ----
      let videoStalled = false;
      for (const [trackId, slots] of slotsRef.current) {
        const track = trackById.get(trackId);
        for (const s of slots) {
          // A still has nothing to sync — it is already showing every frame it
          // has. Painted and skipped, so it can never be counted as stalled.
          const still = stillEls.current.get(s.clip.id);
          if (still) { paintLayer(still, s, ms); continue; }
          const el = videoEls.current.get(s.clip.id);
          if (!el) continue;
          paintLayer(el, s, ms);   // active layer + xfade-in ramp
          const rate = clipRate(s.clip);
          if (s.active) {
            delete el.dataset.parked;
            // The mix decides: lane mute, solo anywhere on the timeline, this
            // lane's fader/automation at this instant, the clip's own gain,
            // and whether this clip's audio was detached onto an audio lane
            // (in which case the picture is silent and the lane plays it).
            // WRITES ARE GUARDED: setting muted/volume is a call into the
            // media pipeline on WKWebView even when the value is unchanged.
            const muted = !(laneAudible.get(trackId) ?? false) || !!s.clip.audio_detached;
            if (el.muted !== muted) el.muted = muted;
            const vol = clipVolume(s.clip, tracks, ms, track);
            if (Math.abs(el.volume - vol) > 0.001) el.volume = vol;
            const local = localSec(s.clip, ms);
            // Asking for more frames a second than the screen can show, on an
            // engine that answers that by playing SLOW rather than by dropping
            // frames — so it is driven from the clock instead of played.
            const overRate = shouldScrub(
              IS_WEBKIT, assetsRef.current.get(s.clip.asset_id)?.fps, rate, displayHz.current);
            if (clipReversed(s.clip) || (playing && overRate)) {
              // Scrubbed, playing or paused alike — see scrubTo. It owns the
              // element outright: converge() would fight it and ensurePlaying()
              // would run the shot forwards.
              scrubTo(el, local);
            } else if (playing) {
              if (import.meta.env.DEV && el.dataset.cutLogged !== "1" && el.readyState >= 1) {
                el.dataset.cutLogged = "1";
                diag(`CUT ${tagOf(el)} ahead=${Math.round((el.currentTime - local) * 1000 / rate)}ms rs=${el.readyState} ${el.paused ? "PAUSED" : "rolling"}`);
              }
              ensurePlaying(el, local, rate, () => localSec(s.clip, usePlaybackStore.getState().nowMs()),
                () => timelineMsAt(s.clip, el.currentTime));
              if (converge(el, local, rate, now, VIDEO_DRIFT)) videoStalled = true;
              // A SCRUB WHILE PLAYING onto a clip that was already rolling: the
              // clock is held, converge() has seeked the element, and the moment
              // it is back within the seek band it is the picture the clock
              // should run from. (A fresh element releases from its own
              // settle, above.)
              {
                const pb = usePlaybackStore.getState();
                if (pb.isHeld() && !el.paused && !el.seeking && !pendingPlay.current.has(el)
                    && el.readyState >= 3 && Math.abs(el.currentTime - local) / rate < VIDEO_DRIFT.seek) {
                  const at = timelineMsAt(s.clip, el.currentTime) ?? undefined;
                  if (import.meta.env.DEV) diag(`RELEASE ${tagOf(el)} landed anchor=${at == null ? "-" : Math.round(at)} t=${el.currentTime.toFixed(3)}`);
                  pb.release(at);
                }
              }
            } else {
              if (el.playbackRate !== rate) el.playbackRate = rate;
              stopEl(el);
              seekTo(el, local, 0.04);
            }
          } else {
            // The next clip starts fetching in earnest only as the playhead
            // approaches — it mounts at preload="metadata", so the ACTIVE
            // stream isn't sharing bandwidth with a full-rate download of a
            // shot minutes away.
            if (el.preload !== "auto" && ms >= s.clip.t_start_ms - VIDEO_PRELOAD_MS) {
              el.preload = "auto";
            }
            // THE NEXT CUT'S play() IS ISSUED BEFORE THE CUT (see warmUp). Only
            // the first upcoming clip on the lane, only while the transport
            // runs, only once it is a clip this engine PLAYS (a reversed or
            // over-rate clip is scrubbed, and a stray play() would run it the
            // wrong way), and only with data to start on. Everything else
            // about it — muted, hidden, parked at its opening frame — is
            // already true of a pre-rolled element.
            const upcoming = slots.find((x) => !x.active);
            const warmable = playing && s === upcoming && el.dataset.parked === "1"
              && !clipReversed(s.clip)
              && !shouldScrub(IS_WEBKIT, assetsRef.current.get(s.clip.asset_id)?.fps, rate, displayHz.current)
              && ms >= s.clip.t_start_ms - WARM_LEAD_MS && ms < s.clip.t_start_ms;
            if (warmable) { if (el.readyState >= 2) warmUp(el); }
            else unwarm(el);
            if (el.dataset.warm === "1") continue;   // rolling, hidden; the cut will claim it
            // Parked ONCE per transition. A paused element does not move on
            // its own, so stopping and re-aiming it every frame was a
            // per-frame currentTime read (a real AVFoundation query on
            // WKWebView) on every lane's pre-rolled clip.
            if (el.dataset.parked !== "1") {
              el.dataset.parked = "1";
              stopEl(el);
              // Pay the RATE WRITE during pre-roll rather than at the cut. On
              // AVFoundation it re-primes the renderer, so on the boundary
              // frame it is a hitch and here it is free — and the element is
              // then already at speed the instant it goes active.
              if (el.playbackRate !== rate) el.playbackRate = rate;
              // The frame this clip OPENS on, which for a reversed one is the
              // far end of its window rather than its in-point. Parked at the
              // in-point instead, a reversed clip showed the wrong end of
              // itself for however long the first seek took after the cut.
              const open = localSec(s.clip, s.clip.t_start_ms);
              seekTo(el, clipReversed(s.clip)
                ? Math.max(0, open - 0.001)
                : open + 0.001, 0.25); // preroll
            }
          }
        }
      }
      // The badge, debounced past the flash a boundary crossing would cause:
      // a stall is otherwise a mysterious freeze that reads as a broken player
      // when it is really the network. State moves only on TRANSITIONS — the
      // old unconditional setStalled(false) was a React dispatch per frame.
      let showStall = false;
      if (playing && videoStalled) {
        if (!stallSince.current) stallSince.current = now;
        showStall = now - stallSince.current > STALL_SHOW_MS;
      } else {
        stallSince.current = 0;
      }
      if (stalledRef.current !== showStall) {
        stalledRef.current = showStall;
        if (import.meta.env.DEV) diag(`STALL ${showStall ? "on" : "off"}`);
        setStalled(showStall);
      }

      // ---- audio lanes ----
      // A lane with a rack holds its own fader, on the bus, AFTER its inserts
      // — console order, and the order the renderer uses (worker/mix.py's
      // lane_bus). `linearGain`, not `elementVolume`: a GainNode has no 1.0
      // ceiling, so a lane pushed past 0dB finally sounds in the preview the
      // way it renders.
      for (const id of fxLanes.keys()) {
        setBusGain(id, linearGain(trackGainDbAt(trackById.get(id), ms)));
      }
      for (const c of aclips) {
        const el = audioEls.current.get(c.id);
        if (!el) continue;
        // A clip far from the playhead needs NOTHING per frame — it is parked
        // once (so a jump away from it stops it) and skipped until the
        // playhead comes near. Without this the loop touched every audio
        // element on the timeline every frame, and a real cut has dozens.
        const end = c.t_start_ms + c.duration_ms;
        const near = ms >= c.t_start_ms - AUDIO_PRELOAD_MS && ms < end + 1000;
        if (!near) {
          if (el.dataset.parked !== "1") {
            el.dataset.parked = "1";
            stopEl(el);
          }
          continue;
        }
        delete el.dataset.parked;
        // Buffer only what is coming up: elements mount at preload="metadata"
        // and upgrade as the playhead approaches (React never rewrites the
        // attribute — the prop is constant — so the upgrade sticks).
        if (el.preload !== "auto" && ms < end) {
          el.preload = "auto";
        }
        const track = audioTracks.get(c.track_id);
        const audible = laneAudible.get(c.track_id) ?? false;
        const inside = ms >= c.t_start_ms && ms < end;
        const local = localSec(c, ms);
        if (el.muted !== !audible) el.muted = !audible;
        // Read every tick, so an automation curve is a fade you HEAR while it
        // is being drawn rather than a shape you find out about in the render.
        //
        // On a lane with a rack the level is split in two — the clip's own
        // gain after the clip's own inserts, the lane's on the bus after the
        // lane's — which is what ffmpeg does and what `<audio>.volume` alone
        // cannot express, since it sits upstream of every node. Asked of the
        // GRAPH rather than of the rows: the two disagree for a tick on every
        // change, and reading "bussed" one tick early would set the element to
        // unity while nothing yet holds the fader.
        const bus = busOf(el);
        if (bus) {
          if (el.volume !== 1) el.volume = 1;
          setClipGain(el, linearGain(Number(c.gain_db) || 0));
        } else {
          const vol = clipVolume(c, tracks, ms, track);
          if (Math.abs(el.volume - vol) > 0.001) el.volume = vol;
        }
        if (inside && playing && audible) {
          if (el.paused || pendingPlay.current.has(el)) {
            ensurePlaying(el, local, 1, () => localSec(c, usePlaybackStore.getState().nowMs()),
              () => timelineMsAt(c, el.currentTime));
          } else {
            converge(el, local, 1, now, AUDIO_DRIFT);
          }
        } else {
          stopEl(el);
          if (!playing && inside) seekTo(el, local, 0.1);
        }
      }

      // A HELD CLOCK WITH NOTHING STARTING has nothing to wait for — an empty
      // stretch of the cut, or every element already rolling. Asked at the END
      // of the pass, once both loops have registered their play() calls in
      // `pendingPlay`, and NOT while an active slot's element is still on its
      // way: a seek onto a clip that was not mounted yet changes the slot set
      // in this very pass, React commits the element after it, and releasing
      // here would start the clock a frame before the picture even exists —
      // which is exactly what the first version did.
      {
        const pb = usePlaybackStore.getState();
        if (playing && pb.isHeld()) {
          let waiting = videoStarting();
          if (!waiting) {
            for (const a of audioEls.current.values()) {
              if (pendingPlay.current.has(a) || (!a.paused && a.seeking)) { waiting = true; break; }
            }
          }
          if (!waiting) {
            if (import.meta.env.DEV) diag(`RELEASE - nothing starting`);
            pb.release();
          }
        }
      }
    };
    return onTick((ms) => syncRef.current(ms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `tracks` is listed even though trackById/audioTracks are derived from it:
    // the mix (mute, solo, fader, automation) is read out of `tracks` itself,
    // and a dependency that only holds by way of a memo is one refactor away
    // from a player that ignores the fader until the clip list changes.
  }, [onTick, byTrack, aclips, durationMs, videoTracks, tracks, trackById, audioTracks, fxLanes]);

  // The buses are keyed by a row id, not by an element, so nothing collects
  // them when this unmounts — and a Tuna LFO in a lane rack would go on
  // running its ScriptProcessor callback for the life of the page. The element
  // chains look after themselves through the ref callback above.
  useEffect(() => disposeAllBuses, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      // Only on a real change: the observer fires on every layout pass, and a
      // set() with equal numbers would still re-render the whole layer stack.
      setStageBox((b) => (Math.abs(b.w - r.width) < 0.5 && Math.abs(b.h - r.height) < 0.5
        ? b : { w: r.width, h: r.height }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // post-render convergence: newly mounted elements pick up the current
  // transport state even when the clock is paused (no tick will fire).
  useEffect(() => {
    const id = requestAnimationFrame(() => syncRef.current(usePlaybackStore.getState().nowMs()));
    return () => cancelAnimationFrame(id);
  });

  const anyVideo = videoTracks.some((t) => (byTrack.get(t.id) ?? []).length > 0);

  return (
    <div className={bare ? "tl-preview tl-preview-bare" : "tl-preview"} ref={stageRef}>
      {!anyVideo && <span className="tl-prev-empty">No clips on the timeline yet — sync blocks or drop media from the library.</span>}
      {anyVideo && mediaErr && <span className="tl-prev-empty err">{mediaErr}</span>}
      {stalled && <span className="tl-prev-buffering">buffering…</span>}
      {videoTracks.map((t, zi) =>
        (slotsRef.current.get(t.id) ?? []).map((s) => {
          const a = assets.get(s.clip.asset_id);
          // A still is shown as a picture, held for the clip's whole window.
          // In a <video> it is a permanent stall (see isStill) — and holding
          // the frame is also what the lane MEANS here: a generate action's
          // placeholder is the last frame of the shot before it, sitting
          // where its render will land.
          if (isStill(a)) {
            return (
              <img
                key={s.clip.id}
                className={"pv-layer" + (s.active ? " active" : "")}
                style={{ zIndex: zi + 1, ...layerStyle(s.clip.ops, sourceBox(a), stageBox) }}
                ref={(el) => {
                  if (el) stillEls.current.set(s.clip.id, el);
                  else stillEls.current.delete(s.clip.id);
                }}
                src={srcOf(a)}
                alt=""
                draggable={false}
                onLoad={() => { failed.current.delete(s.clip.id); setMediaErr(null); }}
                onError={() => onMediaError(s.clip.id, s.clip.label ?? "still", a?.b2_key)}
              />
            );
          }
          return (
            <video
              key={s.clip.id}
              data-clip={s.clip.id}
              className={"pv-layer" + (s.active ? " active" : "")}
              style={{ zIndex: zi + 1, ...layerStyle(s.clip.ops, sourceBox(a), stageBox) }}
              ref={(el) => {
                if (el) videoEls.current.set(s.clip.id, el);
                else videoEls.current.delete(s.clip.id);
              }}
              src={srcOf(a)}
              // The ACTIVE clip buffers at full rate; the pre-rolled next one
              // starts at metadata and is upgraded by the sync loop as the
              // playhead approaches (see VIDEO_PRELOAD_MS). React re-writes
              // this when the slot flips active, which is the emergency path.
              preload={s.active ? "auto" : "metadata"}
              playsInline
              // NB: no crossOrigin — the B2 CDN serves media without
              // Access-Control-Allow-Origin, and a CORS-mode media fetch that
              // gets no ACAO header fails outright (a silent black frame).
              // We never read pixels off these elements, so anonymous mode
              // buys nothing.
              onLoadedMetadata={(e) => onMeta(e, s.clip.id)}
              onError={() => onMediaError(s.clip.id, s.clip.label ?? "clip", a?.b2_key)}
            />
          );
        })
      )}
      {aclips.map((c) => {
        const a = assets.get(c.asset_id);
        if (!a) return null;
        // `crossOrigin` has to be on the element BEFORE its src loads or the
        // graph gets a tainted stream, so the key carries it: turning the
        // first effect on remounts this one element (a reload of its audio),
        // and further edits within 1..4 effects do not.
        // The URL whose bytes Web Audio is allowed to read: a same-origin blob
        // on desktop (fetched through Rust — see lib/corsMedia.ts), the
        // marked B2 URL on the web, where the origin is already approved.
        // Null until the blob lands, so the clip plays plainly in the
        // meantime rather than not at all.
        const plain = srcOf(a);
        const inGraph = corsOk && fxClips.has(c.id);
        // A LOCAL PROJECT'S MEDIA NEEDS CORS MODE AND NOT A PROXY.
        //
        // This machine serves it (lib/localPlane's media server) with
        // `Access-Control-Allow-Origin: *` on every response, so Web Audio may
        // read it as it stands — but ONLY in CORS mode. An element without
        // `crossOrigin` loads it opaquely, and a MediaElementAudioSourceNode
        // built from an opaque element outputs ZEROES rather than failing:
        // video plays, audio goes silent, and nothing anywhere says why.
        // Measured against exactly those headers — peak amplitude 0.00000
        // without the attribute and 0.548 with it, on the same file, with the
        // browser logging "MediaElementAudioSource outputs zeroes due to CORS
        // access restrictions".
        //
        // It needs no `?qambacors=1` marker either, unlike B2: that marker
        // exists because a plain load leaves a cache entry with NO ACAO and no
        // `Vary` to key it by, which then answers every later CORS request.
        // This server sends the header on every response, so a cached plain
        // response is already CORS-valid and there is nothing to step around.
        const localCors = inGraph && !!plain && isLocalMediaUrl(plain);
        const fxUrl = !inGraph ? null
          : localCors ? plain
          : needsCorsProxy() ? (plain ? cachedCorsUrl(plain) : null)
          : corsSrcOf(a);
        const wantsFx = !!fxUrl;
        return (
          <audio
            key={wantsFx ? `${c.id}:fx` : c.id}
            ref={audioRef(c.id)}
            // The inspector's meter taps this element's chain, and the panel
            // has no other way to reach it: these elements are mounted here,
            // by id, and are not in any store.
            data-clip={c.id}
            src={fxUrl ?? plain}
            // A blob: URL is same-origin already; asking for CORS mode on one
            // is meaningless and only risks the load.
            crossOrigin={wantsFx && !fxUrl.startsWith("blob:") ? "anonymous" : undefined}
            // metadata only until the playhead approaches — the sync loop
            // upgrades it (AUDIO_PRELOAD_MS). "auto" here fetched every audio
            // clip on the timeline at once the moment the editor opened.
            preload="metadata"
            onLoadedMetadata={(e) => onMeta(e, c.id)}
            onError={() => {
              // A CORS-mode load the host refuses fails outright — but so does
              // a missing file, and the element cannot tell you which. Ask the
              // host again: if CORS is fine this was an ordinary media error,
              // and if it is not, recheckCors tells the surfaces so this
              // element re-mounts without the attribute and at least plays.
              if (!wantsFx) { onMediaError(c.id, c.label ?? "audio", a.b2_key); return; }
              const url = corsSrcOf(a);
              if (!url) return;
              void recheckCors(url).then((ok) => ok && onMediaError(c.id, c.label ?? "audio", a.b2_key));
            }}
          />
        );
      })}
      {!bare && (
        <span className="tl-prev-overlay mono" ref={timeRef}>
          0:00.0 / {fmt(durationMs)}
        </span>
      )}
    </div>
  );
}

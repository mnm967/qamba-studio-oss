// Playback engine state. The RAF master clock lives OUTSIDE React state —
// components read playheadMs via subscription refs at 60fps; React re-renders
// only on play/pause/seek boundaries.
//
// Contract with media components: listeners fire on EVERY transport change —
// per-frame while playing, and once on play/pause/seek/duration — so a
// listener can always converge <video>/<audio> elements to the clock (pause
// used to skip notification, which left media running against a stopped
// clock: the "pause doesn't pause" bug).
//
// THE CLOCK WAITS FOR THE PICTURE AT PLAY. A media element does not start the
// instant `play()` is called — on WKWebView the call itself blocks the main
// thread for 55-300ms while AVFoundation spins up (measured 2026-09-08, see
// lib/driftProfile.ts) — while `performance.now()` runs on regardless. Left
// alone, every element came out of its own start behind the clock, and the
// corrections that followed (a snap seek into the startup, then a drift seek)
// were the freeze and the audible jump in the song that were reported as lag.
// So `play()` HOLDS the clock at the start position for up to `startHoldMs`,
// emitting that position on every tick so the player keeps converging to it,
// and the player RELEASES it once an element has actually started — handing
// back where that element really is, which becomes the clock's new origin.
// The cap is what stops a stalled element pinning the transport: with nothing
// to release it, the clock starts on its own. `setStartHold(0)` disables the
// hold entirely, which is the default and what every other caller of this
// store sees.
import { create } from "zustand";

type Listener = (ms: number) => void;

interface PlaybackState {
  playing: boolean;
  /** last committed playhead (updated on pause/seek, not per frame) */
  playheadMs: number;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(ms: number): void;
  /** subscribe to clock ticks + transport changes (returns unsubscribe) */
  onTick(fn: Listener): () => void;
  /** current live position (during playback, ahead of playheadMs) */
  nowMs(): number;
  durationMs: number;
  setDuration(ms: number): void;
  /** How long `play()` may hold the clock at its start position waiting for
   *  the player to `release()` it. 0 (the default) never holds. */
  startHoldMs: number;
  setStartHold(ms: number): void;
  /** True between `play()` and the release, while the clock sits at its
   *  start position. */
  isHeld(): boolean;
  /** Start the held clock — from `anchorMs` when the player knows where the
   *  picture actually is, else from the position it was holding at. No-op
   *  when nothing is held. */
  release(anchorMs?: number): void;
}

let raf = 0;
let baseMs = 0;
let startedAt = 0;
/** The clock is parked at `baseMs` (see the header). */
let held = false;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();
const emit = (ms: number) => listeners.forEach((l) => l(ms));
const elapsed = () => (held ? 0 : performance.now() - startedAt);
const endHold = () => {
  held = false;
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
};

export const usePlaybackStore = create<PlaybackState>((set, get) => {
  function tick() {
    const st = get();
    const now = baseMs + elapsed();
    if (st.durationMs > 0 && now >= st.durationMs) {
      set({ playing: false, playheadMs: st.durationMs });
      emit(st.durationMs);
      return;
    }
    emit(now);
    raf = requestAnimationFrame(tick);
  }
  return {
    playing: false,
    playheadMs: 0,
    durationMs: 0,
    play() {
      const st = get();
      if (st.playing) return;
      baseMs = st.durationMs > 0 && st.playheadMs >= st.durationMs ? 0 : st.playheadMs;
      startedAt = performance.now();
      endHold();
      if (st.startHoldMs > 0) {
        held = true;
        // The cap: a picture that never reports in must not pin the transport.
        holdTimer = setTimeout(() => get().release(), st.startHoldMs);
      }
      set({ playing: true });
      emit(baseMs);
      raf = requestAnimationFrame(tick);
    },
    pause() {
      if (!get().playing) return;
      cancelAnimationFrame(raf);
      const now = Math.min(baseMs + elapsed(), get().durationMs || Infinity);
      endHold();
      set({ playing: false, playheadMs: now });
      emit(now); // media elements converge to "paused at now"
    },
    toggle() {
      get().playing ? get().pause() : get().play();
    },
    seek(ms) {
      const dur = get().durationMs;
      const clamped = Math.max(0, dur > 0 ? Math.min(ms, dur) : ms);
      baseMs = clamped;
      startedAt = performance.now();
      // A SEEK WHILE PLAYING HOLDS TOO. The elements are about to be re-aimed —
      // a fresh element mounted and started, or a playing one seeked — and
      // until one of them reports in the clock has nothing real to run
      // against; left running, the picture came out 80-160ms behind on every
      // scrub onto a new clip (measured), uncorrected because that is under the
      // seek threshold. Same release, same cap.
      endHold();
      if (get().playing && get().startHoldMs > 0) {
        held = true;
        holdTimer = setTimeout(() => get().release(), get().startHoldMs);
      }
      set({ playheadMs: clamped });
      emit(clamped);
    },
    onTick(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    nowMs() {
      return get().playing ? baseMs + elapsed() : get().playheadMs;
    },
    startHoldMs: 0,
    setStartHold(ms) {
      set({ startHoldMs: Math.max(0, ms) });
    },
    isHeld() { return held; },
    release(anchorMs) {
      if (!held) return;
      endHold();
      if (anchorMs != null && Number.isFinite(anchorMs)) {
        const dur = get().durationMs;
        baseMs = Math.max(0, dur > 0 ? Math.min(anchorMs, dur) : anchorMs);
      }
      startedAt = performance.now();
      emit(baseMs);
    },
    setDuration(ms) {
      if (ms === get().durationMs) return;
      set({ durationMs: ms });
      if (get().playheadMs > ms) set({ playheadMs: ms });
    },
  };
});

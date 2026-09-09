// Playing an assembly without rendering it.
//
// An assembly is an ordered list of slices packed end to end (see
// lib/assembly.ts), so previewing it means running the takes and switching
// which one you are looking at — and WHERE IN IT you are looking — as the
// playhead crosses a join. No ffmpeg, no round trip: the preview updates the
// instant a selection changes, which is the whole point of assembling rather
// than editing.
//
// THERE ARE TWO CLOCKS AND THE ELEMENTS ONLY UNDERSTAND ONE. `posRef` is CUT
// time — where you are in the assembled result — and `srcRef` is where that
// lands inside the take on screen. They agreed for the life of the tiling
// model (a piece could only ever play at its own timestamps), which is why
// nothing needed to say so; the moment a slice can be moved they part company,
// and every `currentTime` in this file is the second one.
//
// Three rules make it work:
//  - The playhead is read from ONE element (the visible take) and mapped back
//    through the slice it belongs to. Averaging or trusting `timeupdate` gives
//    a jittery clock and cuts that land a frame or two off where the user put
//    them.
//  - The handover is keyed on the SLICE, not on the take. Two slices of one
//    take (a split, a jump cut) are one element that has to seek at the join,
//    and a take-keyed check sees no change at all and plays straight through.
//  - Position updates run through a per-frame subscription, not React state.
//    Re-rendering a lane strip sixty times a second is what makes a scrub feel
//    heavy, and the DOM writes involved are two transforms and a text node.
//
// THE MULTIVIEW RUNS ON ITS OWN CLOCK, AND THAT IS A REVERSAL. Its cells used
// to sit at the current SOURCE time so every one of them showed the same
// instant of the shot — coherent while a slice could only ever play at its own
// timestamps, because source time then advanced with the cut. Under an ordered
// list of slices it does not: a reordered, repeated or dropped piece sends
// source time backwards and forwards, so "the shared moment" jumps around and
// the wall stops being a playback of anything. So a cell plays its take
// straight through and loops, and comparing ONE instant across takes is the
// bench's job instead — every strip draws the source playhead and the scrubber
// moves all of them together.
//
// A take can be on screen TWICE — big on the stage and small in the multiview
// — and one element cannot be in two places, so `registerAux` takes a second
// element per take. The two are driven for different jobs and out of different
// budgets now: `hot` says whose STAGE element rolls (the takes the cut plays,
// so a join costs no seek), `live` says whose CELL rolls (what the wall shows).
// Both are capped, because every take on screen is a decoder.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layout, totalMs, type Placed, type Segment } from "../lib/assembly";

/** Decoding more than this many videos at once stutters on a laptop; beyond
 *  it, only the visible take plays and the rest are seeked at the cut. */
const MAX_HOT = 4;
/** The same budget again for the wall, because a cell is a SECOND decoder for
 *  the same take. Four each is what one shared list already cost at its worst
 *  (four hot takes, two elements apiece); splitting it only stops the cut and
 *  the wall competing for the same four slots — which they would now lose
 *  differently, a stuttering cut against a frozen cell. */
const MAX_LIVE = 4;
const DRIFT_MS = 110;
/** Hand over half a frame early rather than late: overshooting shows frames
 *  from past the slice's out point, which is the one thing the trim was for. */
const HANDOVER_MS = 20;
/** How long before a join the incoming slice is put where it will be needed.
 *  Below this the seek lands as a visible stall at the cut; above it the
 *  multiview cell for that take is off the shared moment for no good reason. */
const PREROLL_MS = 450;

/** Seek an element that may not have its metadata yet. Setting `currentTime`
 *  before `loadedmetadata` is silently dropped, which is how an element that
 *  mounts mid-playback ends up frozen on frame 0.
 *
 *  EVERY seek that is not inside the rAF loop goes through this, and it stopped
 *  being optional when the two clocks parted company: while cut time and source
 *  time were one number, a dropped seek at position 0 left the element at 0,
 *  which is where it was going anyway. Now a cut can OPEN on 3.2s of a take, so
 *  the same dropped write leaves the stage showing the wrong moment with
 *  nothing to correct it until playback starts. */
function seekWhenReady(el: HTMLVideoElement, ms: number) {
  const go = () => { try { el.currentTime = ms / 1000; } catch { /* not seekable */ } };
  if (el.readyState >= 1) go();
  else el.addEventListener("loadedmetadata", go, { once: true });
}

export interface AssemblyPlayer {
  /** ref callback for each take's <video> */
  register(takeId: string): (el: HTMLVideoElement | null) => void;
  /** ref callback for a SECOND element showing the same take (the multiview).
   *  Free-running, looping and always silent — it follows play/pause and
   *  nothing else. */
  registerAux(takeId: string): (el: HTMLVideoElement | null) => void;
  /** the take the viewer should be looking at right now */
  activeTakeId: string | null;
  segIndex: number;
  playing: boolean;
  muted: boolean;
  loop: boolean;
  /** current position in CUT time, ms — always fresh, never triggers a render */
  posRef: React.MutableRefObject<number>;
  /** the same instant as a timestamp inside the take on screen */
  srcRef: React.MutableRefObject<number>;
  /** how long the thing being played is: the cut, or the take when soloing */
  spanMs: number;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(ms: number): void;
  /** nudge by whole frames (default 24fps) */
  step(frames: number): void;
  setMuted(v: boolean): void;
  setLoop(v: boolean): void;
  /** watch one take on its own instead of the assembly */
  solo: string | null;
  setSolo(id: string | null): void;
  /** per-frame position callback (cut ms, source ms); returns an unsubscribe */
  onTick(cb: (ms: number, srcMs: number) => void): () => void;
}

export function useAssemblyPlayer(opts: {
  segments: Segment[];
  /** the length the takes were measured against — the block's window. Used
   *  while soloing (a take is its own length, not the cut's) and as the span
   *  when there is nothing assembled yet. */
  durationMs: number;
  /** takes whose STAGE element keeps decoding, most important first — the
   *  ones the cut plays, so crossing a join costs no seek. */
  hot: string[];
  /** takes whose multiview CELL rolls: what is on the wall. Defaults to `hot`
   *  for a caller with one list, which is what the wall was before it got a
   *  clock of its own. */
  live?: string[];
  fps?: number;
}): AssemblyPlayer {
  const { segments, durationMs, fps = 24 } = opts;
  const els = useRef(new Map<string, HTMLVideoElement>());
  const auxEls = useRef(new Map<string, HTMLVideoElement>());
  const posRef = useRef(0);
  const srcRef = useRef(0);
  const idxRef = useRef(0);
  const ticks = useRef(new Set<(ms: number, srcMs: number) => void>());
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(true);
  const [solo, setSoloState] = useState<string | null>(null);
  const [segIndex, setSegIndex] = useState(0);

  const items = useMemo(() => layout(segments), [segments]);
  const cutMs = useMemo(() => totalMs(segments), [segments]);
  const spanMs = solo ? durationMs : (cutMs || durationMs);

  const hot = useMemo(() => {
    const want = solo ? [solo, ...opts.hot] : opts.hot;
    return [...new Set(want)].slice(0, MAX_HOT);
  }, [opts.hot, solo]);
  const live = useMemo(
    () => [...new Set(opts.live ?? opts.hot)].slice(0, MAX_LIVE), [opts.live, opts.hot]);

  // Mutable mirrors: the rAF loop must not be torn down and rebuilt on every
  // edit, or a drag re-creates the loop sixty times and the video stutters
  // under the cursor.
  const state = useRef({ items, cutMs, durationMs, solo, hot, live, loop, muted, playing });
  state.current = { items, cutMs, durationMs, solo, hot, live, loop, muted, playing };

  /** Which slice covers a cut time. Linear over a handful of items. */
  const indexOfPos = useCallback((ms: number) => {
    const list = state.current.items;
    for (let i = 0; i < list.length; i++) if (ms < list[i].t1_ms) return i;
    return Math.max(0, list.length - 1);
  }, []);

  const itemAt = useCallback((ms: number): Placed | null => {
    const list = state.current.items;
    return list.length ? list[indexOfPos(ms)] : null;
  }, [indexOfPos]);

  const leaderId = useCallback((ms: number) => {
    const s = state.current;
    if (s.solo) return s.solo;
    return itemAt(ms)?.take_id ?? s.hot[0] ?? null;
  }, [itemAt]);

  const [activeTakeId, setActiveTakeId] = useState<string | null>(() => leaderId(0));

  const register = useCallback((takeId: string) => (el: HTMLVideoElement | null) => {
    if (!el) { els.current.delete(takeId); return; }
    els.current.set(takeId, el);
    // An element that mounts after the position was decided has to be told
    // where it is, exactly as an aux one does — a stage that opens on 3.2s of
    // a take is a frame that nothing else will correct until playback starts.
    seekWhenReady(el, srcRef.current);
  }, []);

  // The inner function is a new identity every render, so React calls the old
  // one with null before the new one with the element — delete then set, which
  // is why one entry per take is enough and no element bookkeeping is needed.
  const registerAux = useCallback((takeId: string) => (el: HTMLVideoElement | null) => {
    if (!el) { auxEls.current.delete(takeId); return; }
    auxEls.current.set(takeId, el);
    el.muted = true;                       // the stage element carries the sound
    // It is never seeked here, and that is the whole difference: a cell plays
    // its take from wherever it is, and `loop` is what makes "continuously"
    // true at the end of one — a take that simply ran out reads as a frozen
    // cell, which is the failure this replaced.
    el.loop = true;
    const s = state.current;
    if (s.playing && s.live.includes(takeId)) void el.play().catch(() => { /* not ready */ });
  }, []);

  const seek = useCallback((ms: number) => {
    const s = state.current;
    if (s.solo) {
      const t = Math.max(0, Math.min(s.durationMs, ms));
      posRef.current = t;
      srcRef.current = t;
      const solEl = els.current.get(s.solo);
      if (solEl) seekWhenReady(solEl, t);
      for (const cb of ticks.current) cb(t, t);
      return;
    }
    const total = s.cutMs || s.durationMs;
    const t = Math.max(0, Math.min(total, ms));
    const i = indexOfPos(t);
    const it = s.items[i];
    // Every hot take goes to the SAME SOURCE moment, whichever one is visible:
    // that is the comparison the multiview is for.
    const src = it ? Math.max(it.in_ms, Math.min(it.out_ms, it.in_ms + (t - it.t0_ms))) : t;
    posRef.current = t;
    srcRef.current = src;
    idxRef.current = i;
    // The wall is deliberately not moved: it is not on this clock.
    for (const id of new Set([...s.hot, it?.take_id ?? ""])) {
      const el = els.current.get(id);
      if (el) seekWhenReady(el, src);
    }
    for (const cb of ticks.current) cb(t, src);
    setSegIndex(i);
    setActiveTakeId(it?.take_id ?? s.hot[0] ?? null);
  }, [indexOfPos]);

  /** Watch one take on its own, FROM THE MOMENT YOU WERE LOOKING AT.
   *
   *  Every take of a block is a render of one plan, so "the same second of the
   *  shot" is the only reading of solo that keeps the picture continuous — and
   *  it stopped being free when the wall got its own clock: a take the cut does
   *  not use is no longer kept anywhere near the playhead, so soloing it would
   *  otherwise start at zero while soloing one the cut DOES use continued from
   *  here. One rule, stated once. */
  const setSolo = useCallback((id: string | null) => {
    if (id) {
      const el = els.current.get(id);
      if (el) seekWhenReady(el, srcRef.current);
      posRef.current = srcRef.current;
    }
    setSoloState(id);
  }, []);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => setPlaying((p) => !p), []);
  const step = useCallback((frames: number) => {
    setPlaying(false);
    seek(posRef.current + (frames * 1000) / fps);
  }, [seek, fps]);

  const onTick = useCallback((cb: (ms: number, srcMs: number) => void) => {
    ticks.current.add(cb);
    cb(posRef.current, srcRef.current);
    return () => { ticks.current.delete(cb); };
  }, []);

  // Play/pause + mute follow state; only the visible take is audible, and a
  // multiview cell never is — two elements of one take playing aloud is a
  // flanged echo, not a louder take. The two kinds roll off different lists,
  // so a take can be on the wall without the cut paying for it and vice versa.
  useEffect(() => {
    const s = state.current;
    const ids = new Set([...els.current.keys(), ...auxEls.current.keys()]);
    for (const id of ids) {
      const lead = els.current.get(id);
      if (lead) {
        lead.muted = s.muted || id !== activeTakeId;
        if (!s.hot.includes(id)) { if (!lead.paused) lead.pause(); }
        else if (playing && lead.paused) void lead.play().catch(() => setPlaying(false));
        else if (!playing && !lead.paused) lead.pause();
      }
      const cell = auxEls.current.get(id);
      if (cell) {
        cell.muted = true;
        // A cell that cannot start must not stop the transport — the cut is
        // still perfectly playable with a dead square on the wall.
        if (!s.live.includes(id)) { if (!cell.paused) cell.pause(); }
        else if (playing && cell.paused) void cell.play().catch(() => { /* not ready */ });
        else if (!playing && !cell.paused) cell.pause();
      }
    }
  }, [playing, muted, activeTakeId, hot, live]);

  // The clock. One rAF loop for the life of the player.
  useEffect(() => {
    let raf = 0;
    let lastResync = 0;

    /** Move to slice `i`, putting its take where the slice starts. */
    const goTo = (i: number) => {
      const s = state.current;
      const it = s.items[i];
      if (!it) return;
      idxRef.current = i;
      posRef.current = it.t0_ms;
      srcRef.current = it.in_ms;
      const el = els.current.get(it.take_id);
      if (el) {
        if (Math.abs(el.currentTime * 1000 - it.in_ms) > HANDOVER_MS) seekWhenReady(el, it.in_ms);
        if (s.playing && el.paused) void el.play().catch(() => { /* not ready */ });
      }
      setActiveTakeId(it.take_id);
      setSegIndex(i);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const s = state.current;

      // Soloing is the simple case: one take, its own clock, no slices.
      if (s.solo) {
        const el = els.current.get(s.solo);
        if (!el) return;
        if (s.playing && !el.paused) posRef.current = srcRef.current = el.currentTime * 1000;
        if (posRef.current >= s.durationMs - 1) {
          if (s.loop) seek(0);
          else { setPlaying(false); posRef.current = srcRef.current = s.durationMs; }
        }
        for (const cb of ticks.current) cb(posRef.current, srcRef.current);
        return;
      }

      if (!s.items.length) return;
      // Repair rather than return: an index past the end (an edit that removed
      // the slice being played, in the frame before the effect catches up)
      // would otherwise park the loop on a slice that does not exist, and the
      // playhead simply stops with nothing to show why.
      const i = Math.max(0, Math.min(s.items.length - 1, idxRef.current));
      if (idxRef.current !== i) idxRef.current = i;
      const it = s.items[i];
      const lead = els.current.get(it.take_id);
      if (!lead) return;

      if (s.playing && !lead.paused) {
        const src = lead.currentTime * 1000;
        if (src >= it.out_ms - HANDOVER_MS) {
          if (i + 1 < s.items.length) { goTo(i + 1); return; }
          if (s.loop) { goTo(0); return; }
          setPlaying(false);
          posRef.current = it.t1_ms;
          srcRef.current = it.out_ms;
        } else {
          srcRef.current = src;
          posRef.current = it.t0_ms + Math.max(0, src - it.in_ms);
        }
      }

      if (it.take_id !== activeTakeId) setActiveTakeId(it.take_id);

      // The take the NEXT slice needs is put where it will be needed rather
      // than where the resync below wants it — otherwise every join costs a
      // seek the viewer sees. In the common case (slices in source order) the
      // two wants are the same number and nothing moves.
      const remain = it.t1_ms - posRef.current;
      const nxt = s.playing && remain < PREROLL_MS ? s.items[i + 1] : null;
      const prerollId = nxt && nxt.take_id !== it.take_id ? nxt.take_id : null;
      if (nxt && prerollId) {
        const want = Math.max(0, nxt.in_ms - remain);
        const pre = els.current.get(prerollId);
        if (pre && Math.abs(pre.currentTime * 1000 - want) > DRIFT_MS) {
          try { pre.currentTime = want / 1000; } catch { /* ignore */ }
        }
      }

      if (s.playing && now - lastResync > 400) {
        lastResync = now;
        // Stage elements only: a hot take that is about to be cut to should
        // already be at the moment it will be needed. The wall is not here.
        for (const id of s.hot) {
          if (id === prerollId) continue;
          const el = els.current.get(id);
          if (!el || el === lead) continue;
          if (Math.abs(el.currentTime * 1000 - srcRef.current) > DRIFT_MS) {
            try { el.currentTime = srcRef.current / 1000; } catch { /* ignore */ }
          }
        }
      }
      for (const cb of ticks.current) cb(posRef.current, srcRef.current);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [seek, activeTakeId]);

  // An edit under the playhead — a slice removed, reordered, retrimmed — moves
  // what is on screen. Re-deriving from the position rather than from the old
  // index is what keeps the viewer on the same MOMENT of the cut instead of on
  // whatever the Nth slice has become.
  useEffect(() => {
    if (solo) return;
    const s = state.current;
    const i = indexOfPos(Math.min(posRef.current, Math.max(0, (s.cutMs || 1) - 1)));
    const it = s.items[i];
    idxRef.current = i;
    if (it) {
      srcRef.current = Math.max(it.in_ms, Math.min(it.out_ms, it.in_ms + (posRef.current - it.t0_ms)));
      posRef.current = Math.min(posRef.current, s.cutMs);
      for (const id of s.hot) {
        const el = els.current.get(id);
        if (el && Math.abs(el.currentTime * 1000 - srcRef.current) > DRIFT_MS) {
          seekWhenReady(el, srcRef.current);
        }
      }
    }
    setSegIndex(i);
    setActiveTakeId(it?.take_id ?? s.hot[0] ?? null);
    for (const cb of ticks.current) cb(posRef.current, srcRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, solo]);

  return {
    register, registerAux, activeTakeId, segIndex, playing, muted, loop, posRef, srcRef,
    spanMs, play, pause, toggle, seek, step, setMuted, setLoop, solo, setSolo, onTick,
  };
}

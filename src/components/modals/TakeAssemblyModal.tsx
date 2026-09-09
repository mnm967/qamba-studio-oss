// Take assembly — the bench. One screen that decides the canonical performance.
//
// The question this screen answers is not "which take is better?" but "which
// PIECES of each do I want?", so comparison is structural: every take is on
// screen at once, as a filmstrip you can read, and there are no tabs.
//
// THE BENCH IS SOURCE TIME AND THE ASSEMBLY IS CUT TIME. A strip is a whole
// take, always drawn against the block's own window, and dragging across one
// selects a slice of it. The assembly below is an ordered list of those slices
// packed end to end (`lib/assembly.ts`) — so a piece goes wherever you drop it,
// everything after it ripples, and the cut is as long as its pieces make it.
//
// It used to be neither: a piece could only ever land back at its own
// timestamps, because an assembly was a tiling of the block's window and source
// time and cut time were one clock. That is a true statement about takes and it
// made half of editing unsayable — "her look from take 3, then the line from
// take 1" had no expression at all. What survives from it is the thing that was
// right: every take is an alternate render of ONE plan, so every strip, every
// multiview cell and the trim you are dragging are all the same moment of the
// same shot, and the source playhead on each strip is where that is.
//
// The preview needs no render — `useAssemblyPlayer` runs the takes and maps the
// cut's clock onto each one's, so the stage shows the assembled result the
// instant a selection lands. Committing is the only thing that costs anything.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, Check, ChevronDown, FolderOpen, GripVertical, Loader2, Pause, Play,
  RefreshCw, Scissors, Sparkles, Redo2, Trash2, Undo2, Volume2, VolumeX, X,
} from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { useAssemblyPlayer } from "../../hooks/useAssemblyPlayer";
import { assetUrl } from "../../lib/db/assets";
import {
  FIT_EPS, MIN_SEGMENT_MS, autoAssemble, coalesce, cutTimeNear, cutTimeOf, cutWarnings,
  fitToBlock, fmtTime,
  insertIndexAt, insertSlice, layout, moveBoundary, moveSegment, placedAt, removeSegment,
  setSegmentTake, shotSpans, sliceMs, splitAt, takesUsed, totalMs, trimSegment, wholeTakeId,
  type CutWarning, type Placed, type Segment, type Span, type TakeEvidence,
} from "../../lib/assembly";
import {
  commitAssembly, discardDraft, loadAssemblyContext, saveDraft,
} from "../../lib/db/assembly";
import { DEFAULT_AR, aspectOf, fitBox, fitGrid, type Box } from "../../lib/fitGrid";
import { pickCells, swapCell } from "../../lib/multiview";
import TrimFramePopover from "../timeline/TrimFramePopover";
import { trimReadout } from "../../lib/clipFrames";
import type { Asset, BlockTake } from "../../lib/db/types";
import { labelIsAuto } from "../../lib/blockKind";

/** One hue per take index, reused on the row label, the filmstrip ring, the
 *  multiview ring, the assembly span and the viewer chip. The colour IS how
 *  you read the cut, so it must not collide with the UI accent that marks
 *  "this is the thing you press". */
const HUES = ["#7fa8d4", "#d4a87f", "#84c9a1", "#9184d9"];
const hueOf = (i: number) => HUES[i % HUES.length];
/** Cells in the multiview. Four is the hue count, the player's own `MAX_LIVE`
 *  and about what a laptop will decode beside the stage — raise it here alone
 *  and the extra cells are capped out of `live` and freeze. Past it the takes
 *  are still reachable: any cell can be pointed at any of them. */
const MV_CELLS = 4;
const MV_GAP = 8;
const ACCENT = "#9184d9";
const BAD = "#c98a8a";
const SEV_RANK = { high: 3, medium: 2, low: 1 } as const;

const scoreColor = (v: number) => (v >= 0.9 ? "#84c9a1" : v >= 0.6 ? "#d4a87f" : BAD);
const pct = (ms: number, total: number) => `${(ms / Math.max(1, total)) * 100}%`;

/** Keep the pointer on the element for a drag. It throws for a pointer the
 *  browser no longer tracks, and an exception here aborts the handler that
 *  starts the gesture — losing it entirely. */
function capture(e: React.PointerEvent) {
  try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* no capture */ }
}

// ---------------------------------------------------------------- history ---
/** Undo/redo over one value. Stack and cursor live in ONE state object and
 *  every mutation is functional: holding them apart meant `replace` read the
 *  cursor from the render that scheduled `push`, so a drag wrote its result
 *  into the entry behind the cursor. */
function useHistory<T>(initial: T) {
  const [h, setH] = useState<{ stack: T[]; i: number }>({ stack: [initial], i: 0 });
  const push = useCallback((next: T) => setH(({ stack, i }) => {
    const s = [...stack.slice(0, i + 1), next].slice(-60);
    return { stack: s, i: s.length - 1 };
  }), []);
  const replace = useCallback((fn: (prev: T) => T) => setH(({ stack, i }) => ({
    stack: stack.map((v, k) => (k === i ? fn(v) : v)), i,
  })), []);
  const reset = useCallback((next: T) => setH({ stack: [next], i: 0 }), []);
  return {
    value: h.stack[h.i], push, replace, reset,
    undo: () => setH((s) => ({ ...s, i: Math.max(0, s.i - 1) })),
    redo: () => setH((s) => ({ ...s, i: Math.min(s.stack.length - 1, s.i + 1) })),
    canUndo: h.i > 0, canRedo: h.i < h.stack.length - 1,
  };
}

/** Element size, for laying pictures out at their own aspect ratio.
 *
 *  Both numbers in ONE state: two `setState`s per resize is two renders, and
 *  the stage and the multiview re-measure on every window drag.
 *
 *  It MEASURES ONCE ON MOUNT rather than waiting for the observer to say hello.
 *  A ResizeObserver callback is delivered in the rendering steps, so a document
 *  that is not painting — a background tab, an automation surface that is not
 *  compositing — never gets one, and everything sized from this stays at zero:
 *  the stage and every multiview cell collapse to nothing, which reads as a
 *  broken player rather than a stalled measurement. Neither element has padding
 *  or a border, so the border box is the content box. */
function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<Box>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width: w, height: h } = el.getBoundingClientRect();
      // Subpixel churn (a scrollbar appearing, a font settling) must not
      // re-render the players.
      setBox((p) => (Math.abs(p.w - w) < 0.5 && Math.abs(p.h - h) < 0.5 ? p : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/** Element width, for deciding how many filmstrip frames fit. */
function useWidth<T extends HTMLElement>() {
  const [ref, box] = useBox<T>();
  return [ref, box.w] as const;
}

/** A slice in flight: what is being dragged, and where it came from. */
export interface DragSlice { takeId: string; in_ms: number; out_ms: number }
export interface PieceDrag {
  x: number; y: number;
  /** the join it would drop into, or null when the pointer is off the cut */
  at: number | null;
  /** its index in the cut when it was lifted OUT of the cut, else null */
  from: number | null;
  slice: DragSlice;
}

/** THE PIECE IN FLIGHT — from the press that lifts it to the release that puts
 *  it down, and THE WINDOW is what ends it.
 *
 *  A drag starts on a bench strip and finishes over the cut, so it spans two
 *  components and neither of them can be trusted to finish it. A pointerup goes
 *  to whichever element captured the pointer, and an implicit capture is lost
 *  whenever the element under the press is re-rendered away, the release lands
 *  outside the window, or the browser cancels the pointer. It is then delivered
 *  to whatever happens to be under the cursor — another strip, a piece, the
 *  track — and every one of those answers "not my gesture" and returns, which
 *  leaves the piece glued to the pointer with nothing on screen able to put it
 *  down. That is the stuck ghost.
 *
 *  So the gesture is owned here: the components only ever LIFT a piece, and the
 *  pointer itself decides where it lands. `end` is idempotent, so a component
 *  that does still see its own pointerup costs nothing. */
export function useDragPiece(opts: {
  caretAt: (x: number, y: number) => number | null;
  onDrop: (slice: DragSlice, from: number | null, at: number) => void;
}) {
  const [drag, setDrag] = useState<PieceDrag | null>(null);
  const live = useRef<PieceDrag | null>(null);
  live.current = drag;
  // Read through a ref so the window listeners are subscribed once per drag
  // rather than re-bound on every pointermove.
  const cb = useRef(opts);
  cb.current = opts;

  const start = useCallback((slice: DragSlice, from: number | null, x: number, y: number) => {
    const d: PieceDrag = { x, y, at: cb.current.caretAt(x, y), from, slice };
    live.current = d;
    setDrag(d);
  }, []);

  const end = useCallback((x: number, y: number) => {
    const d = live.current;
    if (!d) return;
    live.current = null;
    setDrag(null);
    const at = cb.current.caretAt(x, y);
    if (at != null) cb.current.onDrop(d.slice, d.from, at);
  }, []);

  const cancel = useCallback(() => { live.current = null; setDrag(null); }, []);

  const active = !!drag;
  useEffect(() => {
    if (!active) return;
    const onMove = (e: PointerEvent) => {
      // No button held: the release happened somewhere this window never saw
      // it — over another application, say. The first move afterwards is the
      // only notice there is, and dropping the piece there is better than
      // carrying it around.
      if (e.buttons === 0) return end(e.clientX, e.clientY);
      const d = live.current;
      if (!d) return;
      const next = { ...d, x: e.clientX, y: e.clientY, at: cb.current.caretAt(e.clientX, e.clientY) };
      live.current = next;
      setDrag(next);
    };
    const onEnd = (e: PointerEvent) => end(e.clientX, e.clientY);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [active, end]);

  return { drag, start, end, cancel };
}

// ============================================================================
export default function TakeAssemblyModal({ blockId }: { blockId: string }) {
  const ws = useWorkspaceStore();
  const tl = useTimelineStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [trim, setTrim] = useState<{ takeId: string; in_ms: number; out_ms: number } | null>(null);
  const [focusTake, setFocusTake] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ segments: Segment[]; notes: Record<string, string> } | null>(null);
  const [flagsOpen, setFlagsOpen] = useState(false);
  const [newBlockOpen, setNewBlockOpen] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const { data, reload } = useLiveQuery(
    () => loadAssemblyContext(blockId),
    ["block_takes", "generation_blocks", "take_assemblies", "jobs"],
    [blockId],
  );

  const hist = useHistory<Segment[]>([]);
  const segments = hist.value;
  const segsRef = useRef(segments);
  segsRef.current = segments;
  const loaded = useRef<string | null>(null);
  const durationMs = data?.durationMs ?? 0;

  // Seed once per block: after that the draft in the DB is downstream of what
  // is on screen, and re-seeding on a realtime tick would fight the user.
  useEffect(() => {
    if (!data || loaded.current === blockId) return;
    loaded.current = blockId;
    hist.reset(data.initial);
    const first = data.takes.find((t) => t.id !== data.block.active_take_id) ?? data.takes[0];
    setFocusTake(first?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, blockId]);

  const takes = data?.takes ?? [];
  const idxOf = useMemo(() => new Map(takes.map((t, i) => [t.id, i])), [takes]);
  const hue = useCallback((id: string) => hueOf(idxOf.get(id) ?? 0), [idxOf]);
  const label = useCallback((id: string) => `Take ${(idxOf.get(id) ?? 0) + 1}`, [idxOf]);
  const urlOf = useCallback(
    (id: string) => {
      const t = takes.find((x) => x.id === id);
      return t ? assetUrl(data?.assets.get(t.asset_id)) ?? undefined : undefined;
    }, [takes, data]);

  const shots: Span[] = useMemo(
    () => (data ? shotSpans(data.beats, durationMs) : []), [data, durationMs]);
  const warnings: CutWarning[] = useMemo(
    () => (data && segments.length ? cutWarnings(segments, data.evidence) : []),
    [data, segments]);
  /** The cut's own length. It is the sum of the slices now, so it is a number
   *  that moves while you edit rather than a property of the block. */
  const cutMs = useMemo(() => totalMs(segments), [segments]);
  /** A take's own measured length, where the asset row carries one. Only some
   *  do — most generated media registers before anything probes it — so the
   *  block's window is the fallback everywhere this is used. */
  const mediaMsOf = useCallback((id: string) => {
    const t = takes.find((x) => x.id === id);
    return t ? data?.assets.get(t.asset_id)?.duration_ms ?? null : null;
  }, [takes, data]);

  // The picture's shape. Every take of a block is a render of one plan, so
  // they agree, and the first that reports dimensions speaks for all of them.
  // `assets.width/height` is the fast path (it is on the row already, so the
  // stage opens at the right size instead of flashing 16:9); an element's own
  // `videoWidth` is the backstop for a row ingested before geometry was
  // probed — and a picture laid out at the wrong ratio is cropped, so guessing
  // is not free.
  const [probedAr, setProbedAr] = useState<number | null>(null);
  const aspect = useMemo(() => {
    for (const t of takes) {
      const a = data?.assets.get(t.asset_id);
      if (a?.width && a?.height) return aspectOf(a.width, a.height);
    }
    return probedAr ?? DEFAULT_AR;
  }, [takes, data, probedAr]);
  const onProbe = useCallback((w: number, h: number) => {
    const ar = aspectOf(w, h, 0);
    if (ar) setProbedAr((p) => (p && Math.abs(p - ar) < 0.001 ? p : ar));
  }, []);

  const used = useMemo(() => takesUsed(segments), [segments]);

  // Which takes the wall shows. A stored pick, normalised against the takes
  // that exist — so it is "the first four" until somebody says otherwise, and
  // a take deleted out from under a cell is replaced rather than leaving a
  // hole. See lib/multiview.
  const [cellPick, setCellPick] = useState<string[]>([]);
  const cellIds = useMemo(
    () => pickCells(takes.map((t) => t.id), cellPick, MV_CELLS), [takes, cellPick]);

  // The STAGE budget: the takes the CUT plays (so crossing a join costs no
  // seek), whatever is focused or soloed, and one to look at while nothing is
  // assembled yet. The wall is deliberately NOT in here — its cells roll off
  // `live`, on their own clock, and making the two compete for four slots is
  // what used to freeze a cell whenever the cut reached a fourth take.
  const hot = useMemo(
    () => [...new Set([...used, focusTake ?? "", cellIds[0] ?? ""])].filter(Boolean),
    [used, focusTake, cellIds]);
  const player = useAssemblyPlayer({ segments, durationMs, hot, live: cellIds });
  const { seek, posRef } = player;

  // -------------------------------------------------------------- editing --
  const persist = useCallback((next: Segment[]) => {
    if (data) void saveDraft({ blockId, segments: next }).catch(
      (e) => console.warn("assembly draft save failed", e.message));
  }, [data, blockId]);

  const apply = useCallback((next: Segment[]) => {
    hist.push(next);
    persist(next);
  }, [hist, persist]);

  /** Put a slice into the cut at `at`. It takes the SLICE rather than reading
   *  the bench's current trim: a drop is about the piece that was picked up,
   *  and by the time it lands the trim may have been cleared or moved on. */
  const insertAt = useCallback((slice: DragSlice, at: number) => {
    if (slice.out_ms - slice.in_ms < 1) return;
    const next = insertSlice(
      segments, { take_id: slice.takeId, in_ms: slice.in_ms, out_ms: slice.out_ms }, at);
    apply(next);
    setTrim(null);
    // The insert may have MERGED with a neighbour (one continuous piece of one
    // take is one piece), so the index it went in at is not always the index it
    // ended up at.
    setSel(next.length ? Math.min(at, next.length - 1) : null);
  }, [segments, apply]);

  /** The trim, with no drop point of its own: it lands at the join nearest the
   *  playhead. The piece has to go SOMEWHERE, and "where you are watching" is
   *  the only answer that is not arbitrary. */
  const addTrim = useCallback(() => {
    if (trim) insertAt(trim, insertIndexAt(segments, posRef.current));
  }, [trim, segments, insertAt, posRef]);

  /** A drop: the same operation whether the piece came from a strip or from
   *  somewhere else in the cut. */
  const onDrop = useCallback((slice: DragSlice, from: number | null, at: number) => {
    if (from == null) return insertAt(slice, at);
    const next = moveSegment(segments, from, at);
    apply(next);
    setSel(Math.max(0, Math.min(next.length - 1, at > from ? at - 1 : at)));
  }, [insertAt, apply, segments]);

  // A gesture is ONE undo entry and ONE write, not one of each per
  // pointermove — the rule the timeline's own drags follow.
  const gestureEdit = useCallback(
    (phase: "start" | "move" | "end", fn?: (prev: Segment[]) => Segment[]) => {
      if (phase === "start") return hist.push(segsRef.current);
      if (phase === "end") return persist(segsRef.current);
      if (fn) hist.replace(fn);
    }, [hist, persist]);

  const dragBoundary = useCallback((i: number, ms: number, phase: "start" | "move" | "end") => {
    gestureEdit(phase, (prev) => moveBoundary(prev, i, ms, mediaMsOf));
  }, [gestureEdit, mediaMsOf]);

  const dragTrim = useCallback(
    (i: number, patch: { in_ms?: number; out_ms?: number }, phase: "start" | "move" | "end") => {
      gestureEdit(phase, (prev) => trimSegment(prev, i, patch,
        mediaMsOf(prev[i]?.take_id ?? "") ?? undefined));
    }, [gestureEdit, mediaMsOf]);

  const removeAt = useCallback((i: number) => {
    const next = removeSegment(segments, i);
    apply(next);
    setSel(next.length ? Math.min(i, next.length - 1) : null);
  }, [apply, segments]);

  /** Snap the cut back to the block's window, as an EDIT — visible, and one
   *  ⌘Z away. The alternative was doing it inside the commit, where the user
   *  never sees which piece gave up the time. */
  const fitToPlan = useCallback(() => {
    const fit = fitToBlock(segments, durationMs, mediaMsOf);
    if (fit.remaining !== 0) {
      setErr(fit.remaining < 0
        ? `the last piece is already at the end of its take — ${fmtTime(-fit.remaining)} short. `
          + "Add another piece, or save this as a block of its own."
        : `nothing left to trim — ${fmtTime(fit.remaining)} over.`);
    } else {
      setErr(null);
    }
    if (fit.segments !== segments) apply(fit.segments);
  }, [segments, durationMs, mediaMsOf, apply]);

  const splitHere = useCallback(() => {
    const next = splitAt(segments, posRef.current);
    if (next !== segments) apply(next);
  }, [segments, apply, posRef]);

  /** Where a pointer at `clientX` would drop a piece: the nearest join. The
   *  track's own pointer events cannot answer this during a drag that started
   *  on a strip — the capture routes every move to the strip — so the geometry
   *  is read off the element directly. */
  const caretAt = useCallback((clientX: number, clientY: number) => {
    const el = trackRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (clientY < r.top - 24 || clientY > r.bottom + 24) return null;
    if (clientX < r.left - 40 || clientX > r.right + 40) return null;
    const total = Math.max(1, totalMs(segsRef.current));
    return insertIndexAt(segsRef.current, ((clientX - r.left) / r.width) * total);
  }, []);

  const pieces = useDragPiece({ caretAt, onDrop });
  const drag = pieces.drag;

  const runAuto = useCallback(() => {
    if (!data) return;
    setProposal(autoAssemble(takes.map((t) => t.id), data.evidence, shots, durationMs,
                             data.block.active_take_id));
  }, [data, takes, shots, durationMs]);

  const acceptProposal = useCallback(() => {
    if (!proposal) return;
    hist.push(proposal.segments);
    void saveDraft({ blockId, segments: proposal.segments, notes: proposal.notes })
      .catch((e) => console.warn("assembly draft save failed", e.message));
    setProposal(null);
  }, [proposal, hist, blockId]);

  // ------------------------------------------------------------- commit ----
  // A copy that is FOLLOWING the block, preferred over one playing its own
  // take. A block can be on a cut more than once, and everything this screen
  // does is block-wide — it publishes a take and activates it — so the clip it
  // keeps in step should be one the block's take actually reaches. Repointing
  // a PINNED copy here would undo that pick on every open, silently and
  // repeatedly, since the sync would put it straight back.
  const clip = tl.clips.find((c) => c.block_id === blockId && !c.take_id)
    ?? tl.clips.find((c) => c.block_id === blockId);
  // The worker owns `active_take_id`; the timeline clip is editor state it does
  // not reach into (a block can sit on more than one timeline). So when a
  // render lands and repoints the block, this is what puts them back in step.
  const activeAssetId = data?.takes.find((t) => t.id === data.block.active_take_id)?.asset_id;
  useEffect(() => {
    if (!clip || clip.take_id || !activeAssetId || clip.asset_id === activeAssetId) return;
    useTimelineStore.getState().patchClip(clip.id, { asset_id: activeAssetId });
  }, [clip, activeAssetId]);

  const commit = useCallback(async (asNewBlock = false, appendBlock = false) => {
    if (!data) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await commitAssembly({
        blockId, segments, durationMs, takes,
        projectId: data.projectId, episodeId: data.episodeId, clipId: clip?.id,
        assetOf: (id) => takes.find((t) => t.id === id)?.asset_id,
        mediaMsOf, asNewBlock, appendBlock,
      });
      if (res.kind === "activated") ws.closeModal();
      else reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setNewBlockOpen(false);
    }
  }, [data, blockId, segments, durationMs, takes, clip?.id, ws, reload, mediaMsOf]);

  // ---------------------------------------------------------- keyboard -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // A piece in flight is what Escape is FOR before the screen is: the
      // press that lifted it may be over, and putting it down has to be
      // reachable without throwing the whole cut away.
      if (e.key === "Escape") {
        if (pieces.drag) return pieces.cancel();
        return ws.closeModal();
      }
      if (e.key === " ") { e.preventDefault(); return player.toggle(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); return player.step(e.shiftKey ? -12 : -1); }
      if (e.key === "ArrowRight") { e.preventDefault(); return player.step(e.shiftKey ? 12 : 1); }
      // I/O still mark in/out off the playhead, for people who prefer it
      if (e.key.toLowerCase() === "i" || e.key.toLowerCase() === "o") {
        const id = player.solo ?? focusTake;
        if (!id) return;
        const t = Math.round(posRef.current);
        return setTrim((p) => e.key.toLowerCase() === "i"
          ? { takeId: id, in_ms: t, out_ms: Math.max(t + 1, p?.takeId === id ? p.out_ms : durationMs) }
          : { takeId: id, in_ms: Math.min(p?.takeId === id ? p.in_ms : 0, t - 1), out_ms: t });
      }
      if (e.key === "Enter" && trim) return addTrim();
      if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        return splitHere();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel != null) {
        e.preventDefault();
        return removeAt(sel);
      }
      // alt+arrow moves the selected piece along the cut — the keyboard half
      // of the drag, and the only way to reorder without a pointer.
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && sel != null) {
        e.preventDefault();
        const to = e.key === "ArrowLeft" ? sel - 1 : sel + 2;
        if (to < 0 || to > segments.length) return;
        apply(moveSegment(segments, sel, to));
        return setSel(e.key === "ArrowLeft" ? sel - 1 : sel + 1);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        return e.shiftKey ? hist.redo() : hist.undo();
      }
      // ctrl+Y is the Windows spelling of redo, and the desktop app ships
      // there — same pair the timeline's own key map answers.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        return hist.redo();
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= takes.length) {
        const id = takes[n - 1].id;
        setFocusTake(id);
        player.setSolo(player.solo === id ? null : id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws, player, focusTake, posRef, durationMs, trim, addTrim, hist, takes,
      sel, segments, apply, removeAt, splitHere, pieces]);

  // ------------------------------------------------------------- render ----
  if (!data) {
    // Same scrim-close as the loaded branch: without it, Esc-out and click-out
    // were dead for the length of the load.
    return (
      <div className="tas-scrim"
           onPointerDown={(e) => { if (e.target === e.currentTarget) ws.closeModal(); }}>
        <div className="tas">
          <div className="tas-empty" style={{ display: "flex", alignItems: "center",
                                              justifyContent: "center", gap: 9 }}>
            <Loader2 size={15} className="ns-spin" /> Loading takes…
          </div>
        </div>
      </div>
    );
  }

  const { block } = data;
  const rendering = data.assemblies.find((a) => a.status === "rendering");
  const dirty = JSON.stringify(coalesce(segments)) !== JSON.stringify(coalesce(data.initial));
  // One take WHOLE commits for nothing; one take TRIMMED is a render like any
  // other, and calling it "use this take" would hand back the untrimmed one.
  const single = !!wholeTakeId(segments, durationMs, mediaMsOf);
  /** Near enough to the block's window to commit as an ordinary take of it. */
  const fits = Math.abs(cutMs - durationMs) <= FIT_EPS;
  const shown = proposal?.segments ?? segments;
  // A label the studio wrote adds nothing here — the header already names
  // the block. One a PERSON wrote ("Chain: How the reference pi") is the
  // whole reason to show it.
  const sceneLabel = clip?.label && !labelIsAuto(clip.label) ? `${clip.label} · ` : "";

  return (
    <div className="tas-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) ws.closeModal(); }}>
      <div className="tas">
        <header className="tas-head">
          <span className="tas-title">Block {block.idx + 1}</span>
          {/* Two lengths, because they are two different facts now: the block
              is the slot on the timeline, the cut is what this screen is
              building, and the second is free to differ from the first. */}
          <span className="mono tas-sub">
            {sceneLabel}{takes.length} take{takes.length === 1 ? "" : "s"} · block {fmtTime(durationMs)}
            {Math.abs(cutMs - durationMs) > 40 && (
              <b style={{ color: "var(--tas-warn)", fontWeight: 400 }}>
                {" "}· cut {fmtTime(cutMs)}
              </b>
            )}
          </span>
          <span style={{ flex: 1 }} />
          {dirty && <span className="mono tas-dirty">unsaved cut</span>}
          <button className="tas-ico" onClick={ws.closeModal} title="Close (Esc)"><X size={14} /></button>
        </header>

        <div className="tas-top">
          <div className="tas-viewcol">
            <Stage player={player} takes={takes} urlOf={urlOf} label={label} hue={hue}
                   segments={segments} aspect={aspect} onProbe={onProbe} />
            <Transport player={player} />
          </div>

          <div className="tas-multicol">
            <Multiview takes={takes} cells={cellIds} evidence={data.evidence} urlOf={urlOf}
                       label={label} hue={hue}
                       aspect={aspect} player={player} trimTake={trim?.takeId ?? null}
                       onPick={(id) => { setFocusTake(id); player.setSolo(null); }}
                       onSolo={(id) => player.setSolo(player.solo === id ? null : id)}
                       onSwapCell={(slot, id) => setCellPick(swapCell(cellIds, slot, id))} />
            <TrimBar trim={trim} label={label} hue={hue} urlOf={urlOf}
                     onAdd={addTrim} onClear={() => setTrim(null)} />
          </div>
        </div>

        <div className="tas-bench">
          <div className="tas-secthead">
            <b>Bench</b>
            <span>drag across a strip to trim · drag the trim into the cut · double-click to solo</span>
          </div>
          <div className="tas-rows">
            <BenchScrub player={player} segments={segments} durationMs={durationMs} />
            {takes.map((t) => (
              <TakeRow
                key={t.id} take={t} asset={data.assets.get(t.asset_id) ?? null}
                ev={data.evidence.get(t.id)}
                score={data.reviews.get(t.id)?.scores?.overall}
                shots={shots} durationMs={durationMs}
                takeCount={takes.length}
                hue={hue(t.id)} label={label(t.id)} url={urlOf(t.id)}
                active={t.id === block.active_take_id}
                focused={focusTake === t.id} solo={player.solo === t.id}
                trim={trim?.takeId === t.id ? trim : null}
                usedSpans={segments.filter((s) => s.take_id === t.id)}
                onFocus={() => setFocusTake(t.id)}
                onSolo={() => player.setSolo(player.solo === t.id ? null : t.id)}
                onTrim={(a, b) => { setFocusTake(t.id); setTrim({ takeId: t.id, in_ms: a, out_ms: b }); }}
                onSeekSource={(srcMs) => {
                  // A strip is the whole take; the cut may use that moment
                  // anywhere, or not at all. Moving the playhead to the same
                  // NUMBER would be the tiling's assumption surviving where it
                  // is no longer true.
                  const t2 = cutTimeOf(segments, t.id, srcMs);
                  if (t2 != null) seek(t2);
                }}
                player={player}
                onLift={(x, y) => { if (trim) pieces.start(trim, null, x, y); }}
              />
            ))}
            {!takes.length && <div className="tas-empty">No takes for this block yet.</div>}
          </div>

          <div className="tas-secthead" style={{ height: 26, marginTop: 6 }}>
            <b className="accent">Cut</b>
            <span>
              {proposal
                ? "proposed — accept to make it the cut"
                : "drop a piece anywhere · drag one to reorder · edges retrim · S splits"}
            </span>
            <span style={{ flex: 1 }} />
            {proposal && (
              <>
                <button className="tas-btn primary" style={{ height: 22 }} onClick={acceptProposal}>
                  <Check size={11} />Accept
                </button>
                <button className="tas-btn" style={{ height: 22 }} onClick={() => setProposal(null)}>
                  Dismiss
                </button>
              </>
            )}
          </div>
          <AssemblyTrack
            trackRef={trackRef}
            segments={shown} preview={!!proposal} notes={proposal?.notes}
            planMs={durationMs} takes={takes} hue={hue} label={label} urlOf={urlOf}
            assetOf={(id) => {
              const t = takes.find((x) => x.id === id);
              return (t ? data.assets.get(t.asset_id) : null) ?? null;
            }}
            player={player} drag={drag} sel={proposal ? null : sel}
            onSelect={setSel}
            onBoundary={dragBoundary}
            onTrim={dragTrim}
            onRemove={removeAt}
            onSwap={(i, id) => apply(setSegmentTake(segments, i, id))}
            onSeek={seek}
            onLift={(i, x, y) => pieces.start(
              { takeId: segments[i].take_id, in_ms: segments[i].in_ms, out_ms: segments[i].out_ms },
              i, x, y)}
          />
        </div>

        <footer className="tas-foot">
          {/* AUTO ASSEMBLE PICKS FROM MEASURED EVIDENCE, and this build
              measures none — the automatic take reviewer is not part of it, so
              `take_reviews` is a table nothing writes and `data.evidence` is
              empty. With nothing to compare, the Viterbi below would score
              every take identically and return the active one whole, which is
              what committing without touching anything already does. Disabled
              WITH THE REASON rather than hidden: a fork that plugs a judge
              back in gets the button working again with no change here, and a
              control that silently does nothing is worse than one that says
              why. */}
          <button className="tas-btn" onClick={runAuto}
                  disabled={takes.length < 2 || data.evidence.size === 0}
                  title={takes.length < 2 ? "Needs at least two takes"
                    : data.evidence.size === 0
                    ? "Nothing has measured these takes — this build has no automatic reviewer"
                    : "Pick the best take per shot from the measured evidence"}>
            <Sparkles size={13} />Auto assemble
          </button>
          <button className="tas-ico" onClick={hist.undo} disabled={!hist.canUndo} title="Undo (⌘Z)">
            <Undo2 size={14} />
          </button>
          <button className="tas-ico" onClick={hist.redo} disabled={!hist.canRedo} title="Redo (⇧⌘Z)">
            <Redo2 size={14} />
          </button>
          <button className="tas-ico" onClick={splitHere} disabled={!segments.length}
                  title="Split the piece under the playhead (S)">
            <Scissors size={14} />
          </button>
          {/* Emptying the cut is allowed: it is a legitimate way to start
              over, commit is off while it is empty, and ⌘Z is right there. */}
          <button className="tas-ico" onClick={() => sel != null && removeAt(sel)}
                  disabled={sel == null || !segments.length}
                  title={sel == null ? "Select a piece in the cut first"
                    : "Remove the selected piece (Delete)"}>
            <Trash2 size={14} />
          </button>
          <span className="tas-rule" />
          <button className="tas-btn" onClick={() => ws.openModal({ kind: "prompt", blockId })}>
            <RefreshCw size={13} />Retake
          </button>
          <button className="tas-btn"
                  onClick={() => ws.openModal({ kind: "pickTake", blockId, clipId: clip?.id })}>
            <FolderOpen size={13} />From library
          </button>
          {dirty && (
            <button className="tas-btn" onClick={() => {
              hist.reset(data.initial);
              setProposal(null);
              const d = data.assemblies.find((a) => a.status === "draft" && a.source === "manual");
              if (d) void discardDraft(d.id).catch(() => {});
            }}>Revert</button>
          )}
          <span style={{ flex: 1 }} />
          {err && <span className="tas-err">{err}</span>}
          {warnings.length > 0 && (
            <button className={"tas-flagbtn" + (flagsOpen ? " on" : "")}
                    onClick={() => setFlagsOpen((v) => !v)}>
              <AlertTriangle size={11} />
              {warnings.length} flag{warnings.length === 1 ? "" : "s"}
            </button>
          )}
          {rendering ? (
            <span className="tas-count" style={{ color: "#d4a87f", display: "flex", alignItems: "center", gap: 6 }}>
              <Loader2 size={12} className="ns-spin" />
              {data.job?.status === "running"
                ? `assembling… ${Math.round((data.job.progress ?? 0) * 100)}%`
                : "assembly queued"}
            </span>
          ) : (
            <>
              {/* While a proposal is up the track shows IT, not the cut — so
                  the footer must not stand next to it quoting different
                  numbers for the same track. */}
              <span className="tas-count">
                {proposal ? "proposal shown — accept or dismiss it"
                  : !segments.length ? "nothing in the cut yet"
                  : single ? "one take, whole · commits instantly"
                  : !fits
                    ? `${fmtTime(cutMs)} against the block's ${fmtTime(durationMs)}`
                  : `${segments.length} pieces · ${segments.length - 1} cut`
                    + `${segments.length === 2 ? "" : "s"} · renders on commit`}
              </span>
              {/* A CUT EITHER FITS ITS BLOCK OR BECOMES ONE. There is no third
                  outcome to warn about: a take that is quietly the wrong length
                  for its slot is played short or leaves a gap on the lane, and
                  the only place that fork can be answered honestly is the
                  moment it is committed. */}
              {!fits && !single && !!segments.length && !proposal && (
                <button className="tas-btn" onClick={fitToPlan} disabled={busy}
                        title={`Take the ${fmtTime(Math.abs(cutMs - durationMs))} off the end `
                          + "(or put it back), so this commits as an ordinary take"}>
                  <Scissors size={13} />Fit to block
                </button>
              )}
              <button className={"tas-btn primary big" + (fits ? "" : " alt")}
                      onClick={() => (fits ? void commit() : setNewBlockOpen((v) => !v))}
                      disabled={busy || !!proposal || !segments.length || (!dirty && single)}>
                {busy ? <Loader2 size={13} className="ns-spin" /> : <Check size={13} />}
                {single ? "Use this take" : fits ? "Render cut" : "Save as new block"}
              </button>
              {newBlockOpen && !fits && (
                <div className="tas-flagpop" style={{ width: 320 }}>
                  <p className="tas-npop">
                    This cut is <b>{fmtTime(cutMs)}</b> and block {block.idx + 1} is{" "}
                    <b>{fmtTime(durationMs)}</b>, so it becomes a block of its own —
                    rendered, given its own window, and put on this cut in place of
                    block {block.idx + 1}. The block and its takes are untouched.
                  </p>
                  <button className="tas-flagrow" onClick={() => void commit(true, false)}>
                    <span className="tas-cd" style={{ color: "#e9e9ed" }}>
                      Insert after block {block.idx + 1}
                      <span className="tas-dt">
                        Story order is kept; every block after it is renumbered.
                      </span>
                    </span>
                  </button>
                  <button className="tas-flagrow" onClick={() => void commit(true, true)}>
                    <span className="tas-cd" style={{ color: "#e9e9ed" }}>
                      Add at the end
                      <span className="tas-dt">
                        Nothing is renumbered; it renders last until you move it.
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
          {flagsOpen && warnings.length > 0 && (
            <div className="tas-flagpop">
              {[...warnings]
                .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.at_ms - b.at_ms)
                .map((w, i) => (
                  <button key={i} className="tas-flagrow"
                          onClick={() => { seek(w.at_ms); setFlagsOpen(false); }}>
                    <AlertTriangle size={12} style={{ marginTop: 2, flex: "none" }}
                                   color={w.severity === "high" ? BAD : w.severity === "medium" ? "#d4a87f" : "#9397ab"} />
                    <span>
                      <span className="tas-cd" style={{ color: w.severity === "high" ? BAD : "#d4a87f" }}>
                        {w.code} <span style={{ color: "#75798c" }}>@{fmtTime(w.at_ms)}</span>
                      </span>
                      <span className="tas-dt">{w.detail}</span>
                    </span>
                  </button>
                ))}
              <p style={{ margin: "6px 7px 2px", font: "400 10.5px/1.5 var(--font-ui)", color: "#75798c" }}>
                Measured without pixels. Continuity across a cut is judged after the render —
                the assembled take is reviewed like any other.
              </p>
            </div>
          )}
        </footer>
      </div>

      {drag && createPortal(
        <div className="tas-ghost" style={{ left: drag.x + 14, top: drag.y - 20 }}>
          <div className="tas-in" style={{
            boxShadow: `0 0 0 1.5px ${hue(drag.slice.takeId)}, 0 14px 30px rgba(0,0,0,.6)`,
            opacity: drag.at == null ? 0.5 : 1,
          }}>
            <Frame src={urlOf(drag.slice.takeId)} at={drag.slice.in_ms} />
            <span className="tas-tx">
              {label(drag.slice.takeId)} · {((drag.slice.out_ms - drag.slice.in_ms) / 1000).toFixed(1)}s
              {drag.at == null && <i style={{ color: "#75798c" }}> · off the cut</i>}
            </span>
          </div>
        </div>, document.body)}
    </div>
  );
}

// ============================================================== frames ======
/** One paused video showing the frame at `at`.
 *
 *  Not a canvas sprite: the B2 bucket sends no `Access-Control-Allow-Origin`,
 *  so a `crossOrigin` video will not load at all and one drawn without it
 *  taints the canvas — `toDataURL` throws. A poster sheet would have to come
 *  from the worker. Until it does, each cell is its own element at
 *  `preload="metadata"`, which fetches headers plus the one range it needs. */
function Frame({ src, at, className, style }: {
  src?: string; at: number; className?: string; style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || !src) return;
    const seek = () => { try { v.currentTime = at / 1000; } catch { /* not seekable */ } };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
  }, [src, at]);
  return <video ref={ref} src={src} className={className} style={style}
                muted playsInline preload="metadata" tabIndex={-1} />;
}

// =============================================================== stage ======
/** The viewer.
 *
 *  The BOX is sized to the picture, not the other way round: a stage stretched
 *  to fill the column letterboxed a 16:9 render inside a portrait slab, so the
 *  chips, the ribbon and the border all sat far away from the image they
 *  annotate. Here the bordered frame is the picture's own rectangle, centred in
 *  whatever room the column has. */
export function Stage({ player, takes, urlOf, label, hue, segments, aspect, onProbe }: {
  player: ReturnType<typeof useAssemblyPlayer>;
  takes: BlockTake[];
  urlOf: (id: string) => string | undefined;
  label: (id: string) => string;
  hue: (id: string) => string;
  segments: Segment[];
  aspect: number;
  onProbe: (w: number, h: number) => void;
}) {
  const active = player.solo ?? player.activeTakeId;
  // The chip names the SOURCE window on screen, not where it plays: "which
  // part of take 2 am I looking at" is the question a viewer has, and the
  // playhead already answers the other one.
  const seg = active ? placedAt(segments, player.posRef.current) : null;
  const items = useMemo(() => layout(segments), [segments]);
  const total = items.length ? items[items.length - 1].t1_ms : 0;
  const [boxRef, box] = useBox<HTMLDivElement>();
  const fit = fitBox(box, aspect);
  return (
    <div className="tas-stage" ref={boxRef}>
      <div className="tas-frame" style={fit.w ? { width: fit.w, height: fit.h } : undefined}>
        {takes.map((t) => (
          <video key={t.id} ref={player.register(t.id)} src={urlOf(t.id)} playsInline preload="auto" muted
                 className={"tas-video" + (t.id === active ? " on" : "")}
                 onLoadedMetadata={(e) => onProbe(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                 onClick={() => player.toggle()} />
        ))}
        {active && (
          <span className="tas-chip" style={{ boxShadow: `0 0 0 1px ${hue(active)}8c` }}>
            <span className="tas-dot" style={{ background: hue(active) }} />
            {label(active)}
            {player.solo
              ? " · solo"
              : seg ? ` · ${fmtTime(seg.in_ms)}–${fmtTime(seg.out_ms)}` : ""}
          </span>
        )}
        <span className="tas-chip right mono">{player.solo ? "single take" : "assembled cut"}</span>
        {!player.solo && items.length > 1 && (
          <div className="tas-ribbon">
            {items.map((s, i) => (
              <span key={i} style={{ width: pct(s.t1_ms - s.t0_ms, total), background: hue(s.take_id) }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Transport({ player }: { player: ReturnType<typeof useAssemblyPlayer> }) {
  const readout = useRef<HTMLSpanElement>(null);
  useEffect(() => player.onTick((ms) => {
    if (readout.current) readout.current.textContent = fmtTime(ms);
  }), [player]);
  return (
    <div className="tas-transport">
      <button className="tas-ico" onClick={player.toggle} title="Play / pause (Space)">
        {player.playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button className="tas-ico" style={{ fontSize: 9 }} onClick={() => player.step(-1)}
              title="Back one frame (←)">◀</button>
      <button className="tas-ico" style={{ fontSize: 9 }} onClick={() => player.step(1)}
              title="Forward one frame (→)">▶</button>
      <span className="mono tas-time">
        <span ref={readout}>0:00.0</span> <i>/ {fmtTime(player.spanMs)}</i>
      </span>
      <button className="tas-ico" onClick={() => player.setMuted(!player.muted)}
              title={player.muted ? "Unmute" : "Mute"}>
        {player.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
      <span style={{ flex: 1 }} />
      <span className="mono tas-keys">space play · I/O mark · S split · ⌘Z undo</span>
    </div>
  );
}

// =========================================================== multiview ======
/** The takes, playing, side by side.
 *
 *  IT IS A WALL OF MONITORS, NOT A WALL OF ONE MOMENT, and that is a reversal.
 *  The cells ran in lockstep with the stage — every one of them seeked to the
 *  source time of whatever the cut was showing — which was a coherent thing to
 *  do while a slice could only play at its own timestamps. Once a slice can be
 *  put anywhere, source time stops being monotonic: reorder two pieces and the
 *  "shared moment" jumps backwards mid-play, so the wall stopped being a
 *  playback of anything and became a slideshow driven by the edit. Each cell
 *  now runs its own take end to end and loops (`registerAux`); the ring and the
 *  IN CUT tag are what still tie it to the cut. Comparing one instant across
 *  takes is the bench's job — every strip carries the source playhead.
 *
 *  The grid is FITTED rather than stretched: `1fr` tracks in a tall column
 *  handed a 16:9 render a portrait cell and `object-fit: cover` cut it to a
 *  strip. */
export function Multiview({ takes, cells, evidence, urlOf, label, hue, aspect, player, trimTake,
                           onPick, onSolo, onSwapCell }: {
  takes: BlockTake[];
  /** the take in each cell, in slot order — see lib/multiview */
  cells: string[];
  /** the reviewer's measurements, for the trouble dot — the only thing the
   *  cells read off the context, so the whole context is not the prop */
  evidence: Map<string, TakeEvidence>;
  urlOf: (id: string) => string | undefined;
  label: (id: string) => string;
  hue: (id: string) => string;
  aspect: number;
  player: ReturnType<typeof useAssemblyPlayer>;
  trimTake: string | null;
  onPick: (id: string) => void;
  onSolo: (id: string) => void;
  /** point a cell at another take; absent leaves the wall fixed */
  onSwapCell?: (slot: number, takeId: string) => void;
}) {
  const num = useMemo(() => new Map(takes.map((t, i) => [t.id, i + 1])), [takes]);
  const shown = useMemo(() => cells.filter((id) => num.has(id)), [cells, num]);
  const onScreen = player.solo ?? player.activeTakeId;
  const [boxRef, box] = useBox<HTMLDivElement>();
  const fit = fitGrid(box, shown.length, aspect, MV_GAP);
  const size = fit.w ? { width: fit.w, height: fit.h } : undefined;
  // A picker is only offered when a take is OFF the wall: with four takes in
  // four cells it could not change anything, and a control that cannot reach
  // what it names is worse than no control.
  const swappable = !!onSwapCell && takes.length > shown.length;
  const spare = takes.length - shown.length;
  return (
    <div className="tas-mv" ref={boxRef}>
      {shown.map((id, slot) => {
        const isTrim = id === trimTake;
        const isCut = id === onScreen;
        const ev = evidence.get(id);
        const flagged = !!ev && (ev.bad.length > 0 || ev.global.length > 0);
        const ring = isTrim ? `0 0 0 2px ${hue(id)}`
          : isCut ? `0 0 0 2px ${ACCENT}` : "0 0 0 1px rgba(233,233,237,.09)";
        return (
          // Keyed by TAKE, not by slot: a swap between two cells is then a
          // reorder React performs by moving the nodes, so both elements keep
          // playing instead of remounting and restarting from zero.
          <div key={id} className={"tas-cell" + (isTrim || isCut ? " lit" : "")}
               style={{ ...size, boxShadow: ring }} data-cell={slot}
               onClick={() => onPick(id)} onDoubleClick={() => onSolo(id)}
               title={`${label(id)} — click to view, double-click to solo`}>
            <video ref={player.registerAux(id)} src={urlOf(id)}
                   muted playsInline loop preload="auto" tabIndex={-1} />
            {swappable && onSwapCell
              ? <CellPicker takes={takes} cells={shown} slot={slot} num={num.get(id) ?? 0}
                            label={label} hue={hue} onPick={onSwapCell} />
              : (
                <span className="tas-nm">
                  <span style={{ color: hue(id) }}>{num.get(id)}</span> {label(id)}
                </span>
              )}
            {isTrim && <span className="tas-tag" style={{ background: hue(id) }}>TRIMMED</span>}
            {!isTrim && isCut && <span className="tas-tag" style={{ background: ACCENT }}>IN CUT</span>}
            {flagged && <span className="tas-flagdot" title="the reviewer measured trouble in this take" />}
          </div>
        );
      })}
      {spare > 0 && (
        <span className="mono tas-mvmore">
          +{spare} more on the bench{swappable ? " — click a cell's name to bring one up" : ""}
        </span>
      )}
    </div>
  );
}

/** Point one cell at another take.
 *
 *  It PORTALS, for the reason everything fixed in this modal does — `.tas-scrim`
 *  carries a backdrop-filter, so the modal is a containing block for fixed
 *  descendants — and for one of its own: a cell clips its content (`overflow:
 *  hidden` is what keeps the picture inside its box), so a menu rendered inside
 *  one is cut off at the edge of the frame. */
function CellPicker({ takes, cells, slot, num, label, hue, onPick }: {
  takes: BlockTake[];
  cells: string[];
  slot: number;
  num: number;
  label: (id: string) => string;
  hue: (id: string) => string;
  onPick: (slot: number, takeId: string) => void;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const here = cells[slot];

  useEffect(() => {
    if (!at) return;
    const shut = () => setAt(null);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // CAPTURE, so the modal's own window listener never sees it: Escape with
      // a menu open shuts the menu, not the whole bench.
      e.stopPropagation();
      setAt(null);
    };
    window.addEventListener("pointerdown", shut);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", shut);
      window.removeEventListener("keydown", key, true);
    };
  }, [at]);

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();                       // the cell beneath means "view"
    if (at) return setAt(null);
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const h = takes.length * 25 + 8;
    // Flip up rather than run off the bottom — a cell on the lower row is
    // exactly where a long take list would fall off the screen.
    const below = r.bottom + 5;
    setAt({
      left: r.left,
      top: below + h > window.innerHeight - 8 ? Math.max(8, r.top - 5 - h) : below,
    });
  };

  return (
    <>
      <button ref={btn} className="tas-nm tas-nmbtn" data-pick={slot} onClick={open}
              onDoubleClick={(e) => e.stopPropagation()}
              title="Show a different take in this cell">
        <span style={{ color: hue(here) }}>{num}</span> {label(here)}
        <ChevronDown size={10} />
      </button>
      {at && createPortal(
        <div className="tas-cellpop" style={{ left: at.left, top: at.top }}
             onPointerDown={(e) => e.stopPropagation()}>
          {takes.map((t) => {
            const on = cells.indexOf(t.id);
            return (
              <button key={t.id} className="tas-flagrow" data-take={t.id}
                      style={{ padding: "4px 8px", alignItems: "center" }}
                      onClick={() => { onPick(slot, t.id); setAt(null); }}>
                <span className="tas-hue" style={{
                  width: 3, height: 12, borderRadius: 2, background: hue(t.id), flex: "none",
                }} />
                <span className="tas-cd" style={{ color: "#e9e9ed" }}>{label(t.id)}</span>
                <span style={{ flex: 1 }} />
                {/* Where it is now, so a swap is predictable rather than a
                    surprise: picking a take that is already up TRADES cells. */}
                {on === slot && <i className="tas-cellon">here</i>}
                {on >= 0 && on !== slot && <i className="tas-cellon">cell {on + 1}</i>}
              </button>
            );
          })}
        </div>, document.body)}
    </>
  );
}

function TrimBar({ trim, label, hue, urlOf, onAdd, onClear }: {
  trim: { takeId: string; in_ms: number; out_ms: number } | null;
  label: (id: string) => string;
  hue: (id: string) => string;
  urlOf: (id: string) => string | undefined;
  onAdd: () => void;
  onClear: () => void;
}) {
  if (!trim || trim.out_ms <= trim.in_ms) {
    return (
      <div className="tas-trimbar">
        <span className="mono tas-hint">
          Drag across a take's strip below to trim it, then drop it into the cut.
        </span>
      </div>
    );
  }
  return (
    <div className="tas-trimbar">
      <Frame src={urlOf(trim.takeId)} at={trim.in_ms}
             style={{ boxShadow: `0 0 0 1px ${hue(trim.takeId)}` }} />
      <span className="mono tas-rd">
        {label(trim.takeId)} · {fmtTime(trim.in_ms)}→{fmtTime(trim.out_ms)}{" "}
        <i>· {((trim.out_ms - trim.in_ms) / 1000).toFixed(1)}s</i>
      </span>
      <span style={{ flex: 1 }} />
      <button className="tas-btn primary" onClick={onAdd}
              title="Insert it at the join nearest the playhead">Add to cut</button>
      <button className="tas-btn" onClick={onClear}>Clear</button>
    </div>
  );
}

// ============================================================ scrubber ======
/** THE BENCH'S PLAYHEAD, with something to hold.
 *
 *  It is STICKY at the top of the strips rather than a row above them: the
 *  strips scroll (eight takes is past `.tas-rows`' cap) and a handle that
 *  scrolls away with them is a handle you cannot reach, while a sibling ABOVE
 *  the scroll container is misaligned by exactly the scrollbar's width the
 *  moment one appears. Inside it, pinned, the gutter and the strip column are
 *  the ones the strips themselves are laid out in.
 *
 *  Every strip already draws a line at the current SOURCE moment — that is what
 *  makes the bench a comparison of one instant rather than four unrelated clips
 *  — and until now it was a 1px mark with no way to grab it. This is the top of
 *  that line: an arrow in its own gutter-aligned track above the strips, and
 *  the whole track is the drag surface, so a click jumps and a drag scrubs.
 *
 *  IT SCRUBS SOURCE TIME AND THE VIEWER RUNS ON CUT TIME, so every position
 *  goes through `cutTimeNear`: the moment under the pointer, where the cut
 *  holds it, and the nearest one it does hold otherwise. The handle therefore
 *  lands where the viewer can actually go, which is visible against the strips'
 *  own in-use bands rather than needing to be explained. */
export function BenchScrub({ player, segments, durationMs }: {
  player: ReturnType<typeof useAssemblyPlayer>;
  segments: Segment[];
  durationMs: number;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);

  useEffect(() => player.onTick((_ms, srcMs) => {
    const at = `${(srcMs / Math.max(1, durationMs)) * 100}%`;
    if (arrow.current) arrow.current.style.left = at;
    if (readout.current) readout.current.textContent = fmtTime(srcMs);
  }), [player, durationMs]);

  const seekTo = useCallback((clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    const src = Math.max(0, Math.min(durationMs, ((clientX - r.left) / r.width) * durationMs));
    const at = cutTimeNear(segments, src, player.solo ?? player.activeTakeId);
    if (at != null) player.seek(at);
  }, [segments, durationMs, player]);

  return (
    <div className="tas-row tas-scrubrow">
      <div className="tas-rowlabel ghost" title="where the bench is looking, on the take's own clock">
        <span className="mono tas-srcof">src</span>
        <span className="mono tas-srctime" ref={readout}>0:00.0</span>
      </div>
      <div ref={bar} className="tas-scrub"
           onPointerDown={(e) => {
             if (e.button !== 0) return;
             capture(e);
             dragging.current = true;
             player.pause();               // a scrub the clock fights is a jitter
             seekTo(e.clientX);
           }}
           onPointerMove={(e) => {
             if (!dragging.current) return;
             // The release went somewhere this element never saw it — the same
             // rule every other gesture on this screen follows.
             if (e.buttons === 0) { dragging.current = false; return; }
             seekTo(e.clientX);
           }}
           onPointerUp={() => { dragging.current = false; }}
           onPointerCancel={() => { dragging.current = false; }}>
        <span className="tas-scrubhead" ref={arrow}>
          <svg width="11" height="7" viewBox="0 0 11 7" aria-hidden>
            <path d="M0 0h11L5.5 7z" fill="currentColor" />
          </svg>
        </span>
      </div>
    </div>
  );
}

// ============================================================ take row ======
export function TakeRow(props: {
  take: BlockTake;
  /** the take's media row — the frame card reads its fps, length and key */
  asset?: Asset | null;
  /** the reviewer's measurements for THIS take — the bad-range marks, the
   *  under-spoken lines and the dim on a take the cut is not using */
  ev?: TakeEvidence;
  /** its overall score, for the row label */
  score?: number;
  shots: Span[];
  durationMs: number;
  takeCount: number;
  hue: string;
  label: string;
  url?: string;
  active: boolean;
  focused: boolean;
  solo: boolean;
  trim: { in_ms: number; out_ms: number } | null;
  usedSpans: Segment[];
  onFocus: () => void;
  onSolo: () => void;
  onTrim: (a: number, b: number) => void;
  /** the strip is SOURCE time — the caller decides where that is in the cut,
   *  and whether it is in the cut at all */
  onSeekSource: (srcMs: number) => void;
  player: ReturnType<typeof useAssemblyPlayer>;
  /** the press that LIFTS the trim off the bench. Where it lands is the
   *  pointer's business, not this row's — see `useDragPiece`. */
  onLift: (x: number, y: number) => void;
}) {
  const { take, asset, ev, score, shots, durationMs, takeCount, hue, label, url, active, focused, solo,
          trim, usedSpans, onFocus, onSolo, onTrim, onSeekSource, player, onLift } = props;
  const [stripRef, width] = useWidth<HTMLDivElement>();
  // A frame roughly every 140px, so the strip reads as film rather than a row
  // of postage stamps. Each frame is its own <video>, so the count is also an
  // element budget: eight across four takes is 32 decoders plus the stage and
  // the multiview, which is near what a laptop will hold. Past four takes the
  // strips get coarser rather than the page getting slower.
  const n = Math.max(3, Math.min(takeCount > 4 ? 4 : 8, Math.round(width / 140) || 6));
  const times = useMemo(
    () => Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * durationMs), [n, durationMs]);

  // Where the cut is looking INSIDE this take. Every strip carries it, at the
  // same place, because every take is a render of one plan — that is what makes
  // the bench a comparison rather than four unrelated clips. It is a ref write
  // per frame, never state.
  const headRef = useRef<HTMLSpanElement>(null);
  useEffect(() => player.onTick((_ms, srcMs) => {
    if (headRef.current) headRef.current.style.left = `${(srcMs / Math.max(1, durationMs)) * 100}%`;
  }), [player, durationMs]);

  const gesture = useRef<
    { kind: "trim"; from: number } | { kind: "drag" } | { kind: "grip"; other: number } | null>(null);
  /** The frame the grip in flight will land on — the same card the timeline's
   *  own trim shows, and for the same reason: "does this land before or after
   *  she turns her head" is not answerable from a width and a duration. */
  const [grip, setGrip] = useState<{ side: "l" | "r"; base: number } | null>(null);
  const msAt = useCallback((clientX: number) => {
    const el = stripRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(durationMs, ((clientX - r.left) / r.width) * durationMs));
  }, [stripRef, durationMs]);

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    capture(e);
    onFocus();
    const at = msAt(e.clientX);
    // Inside the take's own trimmed range, a press starts a DRAG to the
    // assembly; anywhere else it starts a new trim. (spec: grab the trim)
    if (trim && at > trim.in_ms && at < trim.out_ms) {
      gesture.current = { kind: "drag" };
      onLift(e.clientX, e.clientY);
      return;
    }
    gesture.current = { kind: "trim", from: at };
    onTrim(at, at);
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    // No button held: this gesture's pointerup went somewhere this element
    // never saw it, and a ref that outlives its press turns every later hover
    // across the strip into a silent drag. Same rule as the EQ plot's.
    if (e.buttons === 0) { gesture.current = null; setGrip(null); return; }
    if (g.kind === "drag") return;             // the pointer drives it now
    const at = msAt(e.clientX);
    if (g.kind === "grip") return onTrim(Math.min(g.other, at), Math.max(g.other, at));
    onTrim(Math.min(g.from, at), Math.max(g.from, at));
  };
  const up = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    setGrip(null);
    if (!g) return;
    if (g.kind === "drag") return;              // useDragPiece ends it
    if (g.kind === "grip") return;
    const at = msAt(e.clientX);
    // Under 12px of travel is a click, and a click takes the whole beat —
    // "take 2's reaction" without touching a handle.
    if (Math.abs(at - g.from) < (durationMs / Math.max(1, width)) * 12) {
      const shot = shots.find((s) => at >= s.t0_ms && at < s.t1_ms);
      if (shot) onTrim(shot.t0_ms, shot.t1_ms);
      onSeekSource(at);
    }
  };

  return (
    <div className="tas-row">
      <button className="tas-rowlabel" onClick={onFocus} onDoubleClick={onSolo}
              style={focused || solo
                ? { background: "#232532", boxShadow: `0 0 0 1px ${hue}80` } : undefined}>
        <span className="tas-hue" style={{ background: hue }} />
        <span className="tas-nm">{label}</span>
        {active && (
          <span className="tas-act" title="the block's committed take right now" />
        )}
        <span style={{ flex: 1 }} />
        {score != null && (
          <span className="tas-sc" style={{ color: scoreColor(score) }}>{score.toFixed(2)}</span>
        )}
      </button>

      <div ref={stripRef}
           className={"tas-strip" + (ev && ev.bad.length && !usedSpans.length ? " dim" : "")}
           style={trim ? { boxShadow: `0 0 0 1px ${hue}80` } : undefined}
           onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
           onDoubleClick={onSolo}>
        <div className="tas-frames">
          {times.map((t, i) => <Frame key={i} src={url} at={t} />)}
        </div>
        {shots.slice(0, -1).map((s, i) => (
          <span key={`b${i}`} className="tas-beat"
                style={{ left: 0, width: pct(s.t1_ms, durationMs) }} title={s.label} />
        ))}

        {/* the parts of this take the cut is already using */}
        {usedSpans.map((s, i) => (
          <span key={`u${i}`} className="tas-inuse"
                style={{ left: pct(s.in_ms, durationMs), width: pct(s.out_ms - s.in_ms, durationMs),
                         boxShadow: `inset 0 0 0 1.5px ${hue}`, background: `${hue}22` }} />
        ))}

        <span ref={headRef} className={"tas-srchead" + (focused || solo || active ? " lit" : "")} />

        {/* measured trouble: 2px, no label */}
        {ev?.bad.map((b, i) => (
          <span key={`x${i}`} className="tas-bad"
                style={{ left: pct(b.in_ms, durationMs), width: pct(b.out_ms - b.in_ms, durationMs) }}
                title={`${b.code}${b.detail ? ` — ${b.detail}` : ""}`} />
        ))}
        {ev?.lines.filter((l) => l.coverage < 0.9).map((l, i) => (
          <span key={`w${i}`} className="tas-bad"
                style={{ left: pct(l.t0_ms, durationMs), width: pct(Math.max(1, l.t1_ms - l.t0_ms), durationMs),
                         background: "#d4a87f" }}
                title={`${l.speaker}: only ${Math.round(l.coverage * 100)}% of the line is spoken here`} />
        ))}

        {/* the trim: keep it bright, dim everything else */}
        {trim && trim.out_ms > trim.in_ms && (
          <>
            <span className="tas-outside" style={{ left: 0, width: pct(trim.in_ms, durationMs) }} />
            <span className="tas-outside"
                  style={{ left: pct(trim.out_ms, durationMs), right: 0 }} />
            <span className="tas-keep"
                  style={{ left: pct(trim.in_ms, durationMs), width: pct(trim.out_ms - trim.in_ms, durationMs),
                           boxShadow: `inset 0 0 0 2px ${hue}`, cursor: "grab" }} />
            <span className="tas-grip" style={{ left: pct(trim.in_ms, durationMs), background: hue }}
                  onPointerDown={(e) => {
                    e.stopPropagation(); capture(e);
                    gesture.current = { kind: "grip", other: trim.out_ms };
                    setGrip({ side: "l", base: trim.out_ms - trim.in_ms });
                  }}>
              <GripVertical size={9} />
            </span>
            <span className="tas-grip"
                  style={{ left: `calc(${pct(trim.out_ms, durationMs)} - 9px)`, background: hue }}
                  onPointerDown={(e) => {
                    e.stopPropagation(); capture(e);
                    gesture.current = { kind: "grip", other: trim.in_ms };
                    setGrip({ side: "r", base: trim.out_ms - trim.in_ms });
                  }}>
              <GripVertical size={9} />
            </span>
            <span className="tas-pill mono"
                  style={{ left: `calc(${pct(trim.in_ms, durationMs)} + 14px)`, color: hue }}>
              {((trim.out_ms - trim.in_ms) / 1000).toFixed(1)}s
            </span>
            {grip && stripRef.current && (
              <TrimFramePopover
                asset={asset ?? null}
                readout={trimReadout(
                  { in_ms: trim.in_ms, duration_ms: trim.out_ms - trim.in_ms, ops: [] },
                  grip.side, asset ?? null,
                  { origDurationMs: grip.base, minMs: 1 })}
                x={stripRef.current.getBoundingClientRect().left
                   + (((grip.side === "l" ? trim.in_ms : trim.out_ms) / Math.max(1, durationMs))
                      * stripRef.current.getBoundingClientRect().width)}
                y={stripRef.current.getBoundingClientRect().top}
                audio={false} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================== cut track ====
/** THE CUT: the pieces, in order, each as wide as its own length.
 *
 *  Laid out ABSOLUTELY rather than as flex tracks. Everything on it is a
 *  position in one clock — the caret a drop would land on, the join you roll,
 *  the playhead, the block's planned end — and a flex row can only express the
 *  pieces.
 *
 *  EVERY GESTURE FREEZES THE px<->ms SCALE IT STARTED WITH. A ripple trim
 *  changes the total, which re-scales the whole track under the cursor, so a
 *  live scale walks the edge away from the pointer as you drag it — the same
 *  trap `frozenTotal` exists for on the main timeline, arriving here the moment
 *  the cut stopped being a fixed length.
 *
 *  Three gestures, three meanings, and they are deliberately different shapes
 *  so they cannot be confused: the BODY of a piece drags it somewhere else, its
 *  EDGES retrim it and change the cut's length, and the JOIN between two pieces
 *  rolls (one gives up what the other takes, so the length holds). */
export function AssemblyTrack(props: {
  trackRef: React.RefObject<HTMLDivElement | null>;
  segments: Segment[];
  preview: boolean;
  notes?: Record<string, string>;
  /** the block's planned window — drawn as a marker, never as a limit */
  planMs: number;
  takes: BlockTake[];
  hue: (id: string) => string;
  label: (id: string) => string;
  urlOf: (id: string) => string | undefined;
  /** the take's media row — the frame card reads its fps, length and key */
  assetOf: (id: string) => Asset | null;
  player: ReturnType<typeof useAssemblyPlayer>;
  drag: PieceDrag | null;
  sel: number | null;
  onSelect: (i: number | null) => void;
  onBoundary: (i: number, ms: number, phase: "start" | "move" | "end") => void;
  onTrim: (i: number, patch: { in_ms?: number; out_ms?: number },
           phase: "start" | "move" | "end") => void;
  onRemove: (i: number) => void;
  onSwap: (i: number, takeId: string) => void;
  onSeek: (ms: number) => void;
  /** the press that LIFTS a piece out of the cut. Where it lands is the
   *  pointer's business, not this track's — see `useDragPiece`. */
  onLift: (i: number, x: number, y: number) => void;
}) {
  const { trackRef, segments, preview, notes, planMs, takes, hue, label, urlOf, assetOf, player,
          drag, sel, onSelect, onBoundary, onTrim, onRemove, onSwap, onSeek, onLift } = props;
  const head = useRef<HTMLDivElement>(null);
  const [swapAt, setSwapAt] = useState<number | null>(null);
  /** The retrim in flight, for the frame card. `base` is the piece's length
   *  when the handle was grabbed, so the card can say what the drag has cost
   *  so far — the same readout the timeline's own trim shows. */
  const [trimFp, setTrimFp] = useState<{ i: number; side: "l" | "r"; base: number } | null>(null);

  const items = useMemo(() => layout(segments), [segments]);
  const total = items.length ? items[items.length - 1].t1_ms : 0;

  useEffect(() => player.onTick((ms) => {
    if (head.current) head.current.style.left = `${(ms / Math.max(1, total)) * 100}%`;
  }), [player, total]);

  /** ms per pixel, read once at the start of a gesture. */
  const scale = () => {
    const r = trackRef.current?.getBoundingClientRect();
    return r && r.width ? Math.max(1, total) / r.width : 1;
  };
  const g = useRef<
    | { kind: "roll"; i: number; x0: number; base: number; k: number }
    | { kind: "trim"; i: number; edge: "in" | "out"; x0: number; base: number; k: number }
    | { kind: "grab"; i: number; x0: number; y0: number; moved: boolean }
    | null>(null);

  const move = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s) return;
    // A press whose release this element never saw must not resume on the next
    // hover — the rule the EQ plot already states, and the reason a lost
    // pointerup is a stuck gesture rather than a stuck one AND a phantom one.
    if (e.buttons === 0) { g.current = null; setTrimFp(null); return; }
    if (s.kind === "grab") {
      if (!s.moved && Math.abs(e.clientX - s.x0) + Math.abs(e.clientY - s.y0) < 5) return;
      if (!s.moved) { s.moved = true; onLift(s.i, e.clientX, e.clientY); }
      return;                                   // the pointer drives it now
    }
    const at = s.base + (e.clientX - s.x0) * s.k;
    if (s.kind === "roll") return onBoundary(s.i, at, "move");
    onTrim(s.i, s.edge === "in" ? { in_ms: at } : { out_ms: at }, "move");
  };

  const up = (e: React.PointerEvent) => {
    const s = g.current;
    g.current = null;
    setTrimFp(null);
    if (!s) return;
    if (s.kind === "grab") {
      if (s.moved) return;                      // useDragPiece ends it
      // A press that never travelled is a pick: select it AND go there, so the
      // viewer is showing the piece whose buttons just appeared.
      onSelect(s.i);
      return onSeek(items[s.i] ? items[s.i].t0_ms + 1 : 0);
    }
    if (s.kind === "roll") return onBoundary(s.i, 0, "end");
    onTrim(s.i, {}, "end");
  };

  const caret = drag?.at != null
    ? (drag.at >= items.length ? total : items[drag.at]?.t0_ms ?? 0)
    : null;

  return (
    <div className="tas-asmrow">
      <div className="tas-asmlabel">
        <span className="tas-dur mono">{fmtTime(total)}</span>
        <span className="tas-cnt mono">
          {segments.length} piece{segments.length === 1 ? "" : "s"} ·{" "}
          {Math.max(0, segments.length - 1)} cut{segments.length === 2 ? "" : "s"}
        </span>
        {/* The cut is free to be a different length from the block it belongs
            to — that is the point of the model — so the delta is stated rather
            than prevented. It is what decides how much of it the clip on the
            timeline can play. */}
        {Math.abs(total - planMs) > 40 && (
          <span className="tas-cnt mono" style={{ color: "var(--tas-warn)" }}>
            {total > planMs ? "+" : "−"}{fmtTime(Math.abs(total - planMs))} vs block
          </span>
        )}
      </div>
      <div ref={trackRef} className={"tas-track" + (drag?.at != null ? " over" : "")}
           onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {!items.length && (
          <span className="mono tas-trackhint">
            Nothing in the cut. Drag across a strip above, then drop the piece here.
          </span>
        )}

        {items.map((p, i) => {
          const w = (p.t1_ms - p.t0_ms) / Math.max(1, total);
          const narrow = w < 0.09;
          const lifted = drag?.from === i;
          return (
            <div key={i}
                 className={"tas-span" + (preview ? " preview" : "") + (sel === i ? " sel" : "")
                   + (lifted ? " lifted" : "")}
                 style={{
                   left: pct(p.t0_ms, total),
                   width: `calc(${pct(p.t1_ms - p.t0_ms, total)} - 3px)`,
                   boxShadow: `inset 0 0 0 ${sel === i ? 2 : 1.5}px ${hue(p.take_id)}`,
                 }}
                 onPointerDown={(e) => {
                   if (e.button !== 0 || preview) return;
                   capture(e);
                   g.current = { kind: "grab", i, x0: e.clientX, y0: e.clientY, moved: false };
                 }}
                 title={notes?.[String(i)]
                   ?? `${label(p.take_id)} ${fmtTime(p.in_ms)}–${fmtTime(p.out_ms)} of the take, `
                      + `playing at ${fmtTime(p.t0_ms)}`}>
              <Frame src={urlOf(p.take_id)} at={(p.in_ms + p.out_ms) / 2} />
              <span className="tas-lb">
                {label(p.take_id)}
                {!narrow && <i className="tas-src"> {fmtTime(p.in_ms)}</i>}
              </span>
              {!preview && !narrow && (
                <>
                  <button className="tas-sw" title="Swap this piece's take"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); setSwapAt(swapAt === i ? null : i); }}>
                    <ChevronDown size={11} />
                  </button>
                  <button className="tas-rm" title="Take this piece out of the cut"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); onRemove(i); }}>
                    <X size={11} />
                  </button>
                </>
              )}
              {!preview && (
                <>
                  <span className="tas-hnd l" title="Retrim this piece's start"
                        onPointerDown={(e) => {
                          e.stopPropagation(); capture(e);
                          g.current = { kind: "trim", i, edge: "in", x0: e.clientX,
                                        base: p.in_ms, k: scale() };
                          setTrimFp({ i, side: "l", base: p.t1_ms - p.t0_ms });
                          onTrim(i, {}, "start");
                        }} />
                  <span className="tas-hnd r" title="Retrim this piece's end"
                        onPointerDown={(e) => {
                          e.stopPropagation(); capture(e);
                          g.current = { kind: "trim", i, edge: "out", x0: e.clientX,
                                        base: p.out_ms, k: scale() };
                          setTrimFp({ i, side: "r", base: p.t1_ms - p.t0_ms });
                          onTrim(i, {}, "start");
                        }} />
                </>
              )}
            </div>
          );
        })}

        {/* The take menu is a child of the TRACK, not of the piece: a piece
            clips its own content (`overflow: hidden` is what keeps a frame
            inside its box), so a menu inside one is cut off at the height of
            the track. It opens upward, over the bench, which has the room. */}
        {swapAt != null && items[swapAt] && (
          <div className="tas-swpop" style={{ left: pct(items[swapAt].t0_ms, total) }}
               onPointerDown={(e) => e.stopPropagation()}
               onClick={(e) => e.stopPropagation()}>
            {takes.map((t) => (
              <button key={t.id} className="tas-flagrow" style={{ padding: "4px 8px" }}
                      onClick={() => { onSwap(swapAt, t.id); setSwapAt(null); }}>
                <span className="tas-hue" style={{
                  width: 3, height: 12, borderRadius: 2, background: hue(t.id), flex: "none",
                }} />
                <span className="tas-cd" style={{ color: "#e9e9ed" }}>{label(t.id)}</span>
              </button>
            ))}
          </div>
        )}

        {/* the joins: rolling one hands time from the outgoing piece to the
            incoming one, so the cut stays the length it is */}
        {!preview && items.slice(1).map((p, i) => (
          <span key={`d${i}`} className="tas-divider" title="Drag to move this cut"
                style={{ left: `calc(${pct(p.t0_ms, total)} - 1.5px)` }}
                onPointerDown={(e) => {
                  e.stopPropagation(); capture(e);
                  g.current = { kind: "roll", i, x0: e.clientX, base: p.t0_ms, k: scale() };
                  onBoundary(i, 0, "start");
                }} />
        ))}

        {/* Where the piece in flight would land. It is an insertion point, not
            a destination band: under the tiling a piece could only go back to
            its own timestamps, and this is the thing that replaced that. */}
        {caret != null && (
          <span className="tas-caret" style={{ left: `calc(${pct(caret, total)} - 1.5px)` }} />
        )}

        {/* The block's planned end, when the cut has run past it. */}
        {total > planMs + 40 && (
          <span className="tas-planmark" style={{ left: pct(planMs, total) }}
                title={`the block's slot ends here (${fmtTime(planMs)})`} />
        )}
        <div className="tas-playhead" ref={head} />
      </div>

      {/* The frame a retrim will land on, while the handle is still moving.
          It is the TIMELINE's own card and its own readout — the question is
          identical ("does this land before or after she turns her head") and a
          second implementation of it would be a second set of off-by-one
          rules about frame boundaries. `minMs` is the cut's floor rather than
          the lane's, so the card says "shortest clip allowed" at the same
          point the algebra stops. */}
      {trimFp && items[trimFp.i] && trackRef.current && (() => {
        const p = items[trimFp.i];
        const r = trackRef.current.getBoundingClientRect();
        const at = trimFp.side === "l" ? p.t0_ms : p.t1_ms;
        return (
          <TrimFramePopover
            asset={assetOf(p.take_id)}
            readout={trimReadout(
              { in_ms: p.in_ms, duration_ms: p.t1_ms - p.t0_ms, ops: [] },
              trimFp.side, assetOf(p.take_id),
              { origDurationMs: trimFp.base, minMs: MIN_SEGMENT_MS })}
            x={r.left + (at / Math.max(1, total)) * r.width}
            y={r.top}
            audio={false} />
        );
      })()}
    </div>
  );
}

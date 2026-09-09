// MARQUEE SELECTION on the timeline — the pure half.
//
// Split out for the reason `avlink.ts`, `clipFrames.ts` and `mix.ts` are: the
// component owns the pointer and the DOM rects, and the decisions are the part
// with branches and the part a test can reach without a browser. Two of them
// are silent when wrong — a rubber band that takes one clip too few looks
// exactly like one the user drew badly, and a selection carrying an id no clip
// answers to is a clip that lights up, moves with a drag and cannot be found.
import { overlaps } from "./avlink.ts";
import type { Clip } from "./db/types";

/** How far the pointer has to travel before a press becomes a drag.
 *
 *  Under this a press is a CLICK, which on empty lane means "select nothing" —
 *  so without a floor, the tremor in an ordinary click draws a one-pixel band
 *  and the deselect never happens. */
export const MARQUEE_MIN_PX = 4;

/** A marquee's footprint on ONE lane: the window of time it covers there.
 *
 *  Bands rather than a screen rectangle because the conversion from x to ms is
 *  per lane — every lane has its own `.ws-track` box — and doing it once per
 *  lane is exact where comparing a clip's own rendered rect is at the mercy of
 *  sub-pixel rounding: at fit zoom a 200ms clip is a couple of pixels wide. */
export interface MarqueeBand {
  trackId: string;
  fromMs: number;
  toMs: number;
}

/** Which clips a marquee covers.
 *
 *  TOUCH, not containment. An NLE rubber band takes everything it crosses, and
 *  requiring a clip to sit wholly inside the box makes the gesture useless at
 *  fit zoom, where one shot is routinely wider than the whole drag. `overlaps`
 *  is the timeline's own half-open test, so a band ending exactly on the join
 *  between two back-to-back clips takes the one it is actually over rather
 *  than both.
 *
 *  Order follows `clips`, so the PRIMARY (the last id) is stable for one
 *  rectangle however the pointer got there. */
export function clipsInMarquee(
  clips: readonly Clip[],
  bands: readonly MarqueeBand[],
): string[] {
  if (!bands.length) return [];
  const byTrack = new Map<string, MarqueeBand>();
  for (const b of bands) byTrack.set(b.trackId, b);
  const hits: string[] = [];
  for (const c of clips) {
    const b = byTrack.get(c.track_id);
    if (!b) continue;
    // A band with no width covers nothing — a click is not a marquee.
    if (b.toMs <= b.fromMs) continue;
    if (overlaps(c, b.fromMs, b.toMs)) hits.push(c.id);
  }
  return hits;
}

/** How a fresh set of hits combines with what is already selected.
 *
 *  `replace` is a plain drag or click, `add` a shift-drag (a rubber band that
 *  removed clips the user could not see would be the opposite of additive),
 *  and `toggle` a shift-click on a single clip — the one gesture that has to
 *  be able to take something back OUT of a selection. */
export type SelectMode = "replace" | "add" | "toggle";

/** Combine, preserving order and dropping duplicates. */
export function mergeSelection(
  current: readonly string[],
  hits: readonly string[],
  mode: SelectMode = "replace",
): string[] {
  if (mode === "replace") return dedupe(hits);
  if (mode === "add") return dedupe([...current, ...hits]);
  const drop = new Set<string>();
  const add: string[] = [];
  for (const id of dedupe(hits)) {
    if (current.includes(id)) drop.add(id); else add.push(id);
  }
  return [...current.filter((id) => !drop.has(id)), ...add];
}

const dedupe = (ids: readonly string[]) => [...new Set(ids)];

/** The rectangle two pointer positions describe, normalised so a drag up and
 *  to the left is the same box as one down and to the right. */
export function normalizeRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Has the pointer travelled far enough for this to be a drag rather than a
 *  click? Chebyshev distance, not Euclidean: the threshold is about "did the
 *  hand move", and a diagonal twitch is no more a drag than a level one. */
export const isDrag = (dx: number, dy: number) =>
  Math.abs(dx) >= MARQUEE_MIN_PX || Math.abs(dy) >= MARQUEE_MIN_PX;

/** How far the slab should scroll this frame, for a pointer held near its edge.
 *
 *  Split out from the rAF loop that calls it because the loop is untestable
 *  where this is not: a headless page never composites, so `requestAnimation
 *  Frame` does not fire and nothing driven by it can be exercised at all.
 *
 *  `leftInset` is the sticky lane-label column. Measuring the left edge from
 *  the scroller's own box instead would put the trigger zone UNDER the labels,
 *  where the band is not even visible — so a drag would start running away
 *  before the pointer had reached anything the user could see.
 */
export function edgeScroll(
  pointer: { x: number; y: number },
  box: { left: number; right: number; top: number; bottom: number },
  opts: { edge?: number; step?: number; leftInset?: number } = {},
): { dx: number; dy: number } {
  const edge = opts.edge ?? 44;
  const step = opts.step ?? 18;
  const left = box.left + (opts.leftInset ?? 0);
  let dx = 0, dy = 0;
  if (pointer.x < left + edge) dx = -step;
  else if (pointer.x > box.right - edge) dx = step;
  if (pointer.y < box.top + edge) dy = -step;
  else if (pointer.y > box.bottom - edge) dy = step;
  return { dx, dy };
}

/** Where a group of clips may start, given the delta the pointer asks for.
 *
 *  A multi-clip drag is RIGID: every clip keeps its offset from every other,
 *  so the delta is clamped ONCE by whichever clip would be pushed past zero
 *  rather than per clip. Clamping per clip is the bug that looks like it
 *  works — drag a group left into the head of the timeline and the clips pile
 *  up on top of each other at 0, and nothing puts them back.
 */
export function groupMove(
  movers: readonly Pick<Clip, "id" | "t_start_ms">[],
  deltaMs: number,
): { id: string; t_start_ms: number }[] {
  if (!movers.length) return [];
  let d = deltaMs;
  for (const m of movers) d = Math.max(d, -m.t_start_ms);
  return movers.map((m) => ({ id: m.id, t_start_ms: Math.round(m.t_start_ms + d) }));
}

// Take assembly: the algebra behind "I like this moment from take 1 and that
// moment from take 2".
//
// AN ASSEMBLY IS AN ORDERED LIST OF SLICES. Each entry names a take and a
// window INSIDE that take — `in_ms`/`out_ms` are SOURCE timestamps — and where
// a slice plays is decided by its position in the list, because slices are
// packed end to end. That packing IS the auto-align: there is no `t_start` to
// keep in step with anything, a gap is not expressible, and moving a piece is
// a reorder rather than an arithmetic problem.
//
// It used to be a gapless TILING of [0, duration) in which source time and cut
// time were one clock, so a piece could only ever go back where it came from.
// That is a true statement about takes — every take of a block is an alternate
// render of the same plan — and it is not what an editor wants: "her look from
// take 3, then the line from take 1" was not expressible at all, and neither
// was dropping a beat or holding one twice. Only the CONSTRAINT is gone: every
// row written under the old model reads identically here, because a tiling
// laid end to end in order is exactly the sequence of source windows it
// already was.
//
// What that costs: the cut's LENGTH is now the sum of its slices, and a block
// is a planned slot on a timeline. So `take_assemblies.duration_ms` is the
// assembly's OWN length (the browser writes the sum, the worker checks it),
// and the two are reconciled at COMMIT rather than while editing — edit
// freely, then either `fitToBlock` snaps the tail back to the block's window
// and it commits as an ordinary spliced take, or the cut becomes a BLOCK OF
// ITS OWN. Those are the only two outcomes: a take that is quietly the wrong
// length for its slot is the third, and it is what this replaces.
//
// Everything here is pure and unit-tested (assembly.test.ts). The worker's
// renderer (worker/assembly.py) validates the same shape before it runs
// ffmpeg — its filtergraph already trimmed each span at its own timestamps and
// concatenated them in order, which is why the render needed no change.

export interface Segment {
  take_id: string;
  /** the SOURCE window inside that take */
  in_ms: number;
  out_ms: number;
  /** why this slice picked this take (auto-assemble writes it, UI shows it) */
  note?: string;
}

/** A slice with the cut time it lands at, which is derived and never stored. */
export interface Placed extends Segment {
  t0_ms: number;
  t1_ms: number;
  i: number;
}

/** Shorter than this and a slice reads as a flicker rather than a choice.
 *  6 frames at 24fps. The floor is enforced here AND in the renderer: by the
 *  time the file exists nobody can tell a 3-frame span from a decode glitch. */
export const MIN_SEGMENT_MS = 250;

/** How far off "the whole take" still counts as the whole take. A render lands
 *  a frame or two either side of its plan, and asking someone to drag a handle
 *  onto an exact millisecond to get the free commit path back is a trap. */
export const WHOLE_EPS = 60;

/** Near enough to the block's window to commit as an ordinary take. A frame
 *  and a half at 24fps — the same slack `WHOLE_EPS` allows, and for the same
 *  reason: a render lands either side of its plan, and demanding an exact
 *  millisecond would send a correct cut down the new-block route. */
export const FIT_EPS = 60;

// ---------------------------------------------------------------- building --

export const sliceMs = (s: Segment) => Math.max(0, Math.round(s.out_ms) - Math.round(s.in_ms));

/** The cut's own length: the sum of its slices. */
export function totalMs(segs: Segment[]): number {
  return segs.reduce((a, s) => a + sliceMs(s), 0);
}

/** Pack the list end to end. This is the only place cut time is computed. */
export function layout(segs: Segment[]): Placed[] {
  const out: Placed[] = [];
  let t = 0;
  segs.forEach((s, i) => {
    const d = sliceMs(s);
    out.push({ ...s, in_ms: Math.round(s.in_ms), out_ms: Math.round(s.out_ms), t0_ms: t, t1_ms: t + d, i });
    t += d;
  });
  return out;
}

/** The assembly every block starts from: one take, whole. */
export function tile(takeId: string, durationMs: number): Segment[] {
  return [{ take_id: takeId, in_ms: 0, out_ms: Math.max(0, Math.round(durationMs)) }];
}

/** Drop empty slices and merge neighbours that are one continuous piece of one
 *  take. It MUST NOT SORT: order is the cut, and sorting by `in_ms` — which is
 *  what the tiling version did, correctly, when in_ms was cut time — would
 *  silently un-reorder every assembly the moment anything was moved. */
export function coalesce(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (sliceMs(s) <= 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.take_id === s.take_id && prev.out_ms === s.in_ms) {
      prev.out_ms = s.out_ms;
      // keep the first note; a merged slice has one reason, not two
      continue;
    }
    out.push({ ...s, in_ms: Math.round(s.in_ms), out_ms: Math.round(s.out_ms) });
  }
  return out;
}

/** Structurally sound: at least one slice, each naming a take and running
 *  forwards for at least a shot's worth of time. `expectMs`, when given, also
 *  asserts the total — that is the cross-check between the length the browser
 *  computed and the one it stored, and it is what the renderer re-runs. */
export function isValid(segs: Segment[], expectMs?: number): boolean {
  if (!segs.length) return false;
  for (const s of segs) {
    if (!s.take_id) return false;
    if (!(s.in_ms >= 0)) return false;
    if (sliceMs(s) < MIN_SEGMENT_MS) return false;
  }
  return expectMs == null || totalMs(segs) === Math.round(expectMs);
}

// ----------------------------------------------------------------- reading --

/** Which slice is playing at cut time `tMs`. */
export function indexAt(segs: Segment[], tMs: number): number {
  let t = 0;
  for (let i = 0; i < segs.length; i++) {
    const d = sliceMs(segs[i]);
    if (tMs < t + d) return i;
    t += d;
  }
  return segs.length - 1;
}

export function placedAt(segs: Segment[], tMs: number): Placed | null {
  if (!segs.length) return null;
  const list = layout(segs);
  return list[Math.max(0, Math.min(list.length - 1, indexAt(segs, tMs)))] ?? null;
}

/** Cut time -> the timestamp inside the take that is on screen. The whole
 *  point of the model: these are two clocks now, and everything that touches a
 *  media element wants the second one. */
export function srcAt(segs: Segment[], tMs: number): number {
  const p = placedAt(segs, tMs);
  if (!p) return Math.max(0, tMs);
  return Math.max(p.in_ms, Math.min(p.out_ms, p.in_ms + (tMs - p.t0_ms)));
}

/** Interior cut points, in cut time (the joins the reviewer cares about). */
export function cuts(segs: Segment[]): number[] {
  return layout(segs).slice(1).map((p) => p.t0_ms);
}

/** Where a piece dropped at cut time `tMs` should be inserted: the nearest
 *  join, so a drop always lands between two slices rather than inside one. */
export function insertIndexAt(segs: Segment[], tMs: number): number {
  const list = layout(segs);
  if (!list.length) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= list.length; i++) {
    const at = i === list.length ? list[list.length - 1].t1_ms : list[i].t0_ms;
    const d = Math.abs(at - tMs);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** WHERE a moment of a take plays in the cut, or null when the cut does not
 *  use it. The inverse of `srcAt`, and the bench needs it: a strip is source
 *  time, so clicking one means "show me this moment", which is a different
 *  number from the position it is clicked at the instant a piece can be moved.
 *  The FIRST piece that covers it wins — the same moment can be in the cut
 *  more than once now, and the earliest is the one the playhead reaches. */
export function cutTimeOf(segs: Segment[], takeId: string, srcMs: number): number | null {
  for (const p of layout(segs)) {
    if (p.take_id !== takeId) continue;
    if (srcMs < p.in_ms || srcMs >= p.out_ms) continue;
    return p.t0_ms + (srcMs - p.in_ms);
  }
  return null;
}

/** Where a SOURCE moment plays in the cut — the BENCH's clock mapped onto the
 *  viewer's, which is what a scrubber over the strips needs.
 *
 *  Exact containment wins, and `preferTakeId` (the take on screen) breaks a tie
 *  so scrubbing does not jump between takes that both hold the moment.
 *  Otherwise it lands on the NEAREST edge of any piece: a cut need not contain
 *  every second of its takes, and a handle that goes dead over the parts it
 *  left out is a scrubber that stops working halfway along for no stated
 *  reason. The strips already show which parts are in the cut, so landing on
 *  the closest one reads as the handle refusing to go where there is nothing. */
export function cutTimeNear(
  segs: Segment[],
  srcMs: number,
  preferTakeId?: string | null,
): number | null {
  const list = layout(segs);
  if (!list.length) return null;
  let best: number | null = null;
  let bestD = Infinity;
  for (const p of list) {
    const inside = srcMs >= p.in_ms && srcMs < p.out_ms;
    const clamped = Math.max(p.in_ms, Math.min(p.out_ms - 1, srcMs));
    // An exact hit always beats a near miss, and among exact hits the take
    // already on screen wins.
    const d = (inside ? 0 : Math.abs(clamped - srcMs)) - (inside && p.take_id === preferTakeId ? 0.5 : 0);
    if (d < bestD) { bestD = d; best = p.t0_ms + (clamped - p.in_ms); }
  }
  return best;
}

/** Takes actually used, in first-appearance order. */
export function takesUsed(segs: Segment[]): string[] {
  const seen: string[] = [];
  for (const s of segs) if (!seen.includes(s.take_id)) seen.push(s.take_id);
  return seen;
}

/** The take this assembly IS, whole — or null when it is a cut.
 *
 *  Committing one take whole needs no render at all, just a repoint of the
 *  active take, and getting this wrong is the expensive direction: a single
 *  slice that has been TRIMMED is not the take, and activating the take
 *  instead would hand back the untrimmed render with nothing saying so.
 *
 *  `referenceMs` is the length the screen measured the takes against (the
 *  block's window); `durationOf` overrides it per take where the asset row
 *  actually carries a duration. */
export function wholeTakeId(
  segs: Segment[],
  referenceMs: number,
  durationOf?: (takeId: string) => number | null | undefined,
): string | null {
  const list = coalesce(segs);
  if (list.length !== 1) return null;
  const s = list[0];
  const full = durationOf?.(s.take_id) || referenceMs;
  if (!full) return null;
  return s.in_ms <= WHOLE_EPS && s.out_ms >= full - WHOLE_EPS ? s.take_id : null;
}

export function isSingleTake(
  segs: Segment[],
  referenceMs: number,
  durationOf?: (takeId: string) => number | null | undefined,
): boolean {
  return wholeTakeId(segs, referenceMs, durationOf) !== null;
}

// ---------------------------------------------------------------- editing --

const clampSlice = (s: Segment, maxMs?: number): Segment | null => {
  const a = Math.max(0, Math.round(Math.min(s.in_ms, s.out_ms)));
  let b = Math.max(0, Math.round(Math.max(s.in_ms, s.out_ms)));
  if (maxMs != null && maxMs > 0) b = Math.min(b, Math.round(maxMs));
  if (b - a < MIN_SEGMENT_MS) return null;
  return { ...s, in_ms: a, out_ms: b };
};

/** Put a slice into the cut at position `at` (an index between slices).
 *  Everything after it moves later — that is the ripple, and it is the whole
 *  reason nothing carries a start time. */
export function insertSlice(segs: Segment[], slice: Segment, at = segs.length): Segment[] {
  const s = clampSlice(slice);
  if (!s) return segs;
  const i = Math.max(0, Math.min(segs.length, Math.round(at)));
  return coalesce([...segs.slice(0, i), s, ...segs.slice(i)]);
}

export function removeSegment(segs: Segment[], i: number): Segment[] {
  if (i < 0 || i >= segs.length) return segs;
  return coalesce(segs.filter((_, k) => k !== i));
}

/** Reorder. `to` is an insertion index read against the ORIGINAL list, which
 *  is what a caret between two slices reports — so dropping a piece back where
 *  it already is (`to === from` or `from + 1`) is a no-op rather than an
 *  off-by-one shuffle. */
export function moveSegment(segs: Segment[], from: number, to: number): Segment[] {
  if (from < 0 || from >= segs.length) return segs;
  if (to === from || to === from + 1) return segs;
  const item = segs[from];
  const rest = segs.filter((_, k) => k !== from);
  const j = Math.max(0, Math.min(rest.length, to > from ? to - 1 : to));
  return coalesce([...rest.slice(0, j), { ...item }, ...rest.slice(j)]);
}

/** Retrim one slice's SOURCE window. The cut gets shorter or longer with it —
 *  a ripple trim, because the alternative (holding the length by stealing from
 *  a neighbour) is `moveBoundary`, and having one gesture do both silently is
 *  how an edit becomes unpredictable. */
export function trimSegment(
  segs: Segment[],
  i: number,
  patch: { in_ms?: number; out_ms?: number },
  maxMs?: number,
): Segment[] {
  if (i < 0 || i >= segs.length) return segs;
  const cur = segs[i];
  const hi = maxMs != null && maxMs > 0 ? Math.round(maxMs) : Infinity;
  const next = { ...cur };
  if (patch.in_ms != null) {
    next.in_ms = Math.max(0, Math.min(Math.round(patch.in_ms), next.out_ms - MIN_SEGMENT_MS));
  }
  if (patch.out_ms != null) {
    next.out_ms = Math.min(hi, Math.max(Math.round(patch.out_ms), next.in_ms + MIN_SEGMENT_MS));
  }
  if (sliceMs(next) < MIN_SEGMENT_MS) return segs;
  return coalesce(segs.map((s, k) => (k === i ? next : { ...s })));
}

/** Move the join between slices i and i+1 to cut time `tMs`, taking the
 *  difference out of one and giving it to the other. A ROLL: the cut's total
 *  length does not change, which is what makes it the right gesture for a
 *  divider — the pieces either side stay where they are on screen.
 *
 *  `limit` is the length of a take, so rolling cannot run a slice off the end
 *  of its own media. */
export function moveBoundary(
  segs: Segment[],
  i: number,
  tMs: number,
  limit?: (takeId: string) => number | null | undefined,
): Segment[] {
  if (i < 0 || i >= segs.length - 1) return segs;
  const list = layout(segs);
  const a = segs[i];
  const b = segs[i + 1];
  const at = list[i].t1_ms;
  const aMax = limit?.(a.take_id) || Infinity;
  // How far the join may travel in each direction, from all four constraints.
  const lo = Math.max(
    at - (sliceMs(a) - MIN_SEGMENT_MS),      // a must keep MIN
    at - b.in_ms,                            // b cannot start before its take does
  );
  const hi = Math.min(
    at + (sliceMs(b) - MIN_SEGMENT_MS),      // b must keep MIN
    at + Math.max(0, aMax - a.out_ms),       // a cannot run past its own end
  );
  if (hi < lo) return segs;
  const d = Math.round(Math.max(lo, Math.min(hi, tMs))) - at;
  if (!d) return segs;
  return coalesce(segs.map((s, k) => (
    k === i ? { ...s, out_ms: s.out_ms + d }
      : k === i + 1 ? { ...s, in_ms: s.in_ms + d }
        : { ...s })));
}

export interface Fit {
  segments: Segment[];
  /** ms still unaccounted for. 0 is an exact fit; anything else is the amount
   *  the tail could not give up or make up, and the UI has to say so rather
   *  than pretend. */
  remaining: number;
}

/** Snap the cut to `targetMs` by moving its TAIL.
 *
 *  The tail, and only the tail, because every other rule is a guess about
 *  intent: scaling retimes footage, trimming the head changes what the block
 *  opens on (and a chained block opens on the one before it), and taking a
 *  little from everywhere quietly re-cuts a sequence somebody arranged. Coming
 *  off the end is what "it runs long" means.
 *
 *  Too long: shed whole pieces from the end while they fit inside the excess,
 *  then trim what is left of the last one, never below MIN_SEGMENT_MS.
 *  Too short: extend the last piece into the rest of its own take —
 *  `mediaMsOf` is how far that goes, and when it does not go far enough the
 *  shortfall is REPORTED. There is nothing honest to invent there: holding a
 *  frame is a freeze the assembly cannot express, and stretching is a retime. */
export function fitToBlock(
  segs: Segment[],
  targetMs: number,
  mediaMsOf?: (takeId: string) => number | null | undefined,
): Fit {
  const target = Math.round(targetMs);
  let out = coalesce(segs);
  if (!out.length) return { segments: out, remaining: -target };

  // `d` is always (what the cut is now) − (what it should be), so the two
  // phases below read as one number moving toward zero.
  let d = totalMs(out) - target;

  // Too long: shed a piece whenever trimming it would leave a FLICKER rather
  // than a shot. Overshooting into the piece before it is fine — the extend
  // below takes it back, capped by that take's own footage, which is the only
  // honest source of the difference.
  while (d > 0 && out.length > 1 && sliceMs(out[out.length - 1]) - d < MIN_SEGMENT_MS) {
    d -= sliceMs(out[out.length - 1]);
    out = out.slice(0, -1);
  }
  if (d > 0) {
    const last = out[out.length - 1];
    const room = Math.min(d, sliceMs(last) - MIN_SEGMENT_MS);
    if (room > 0) {
      out = [...out.slice(0, -1), { ...last, out_ms: last.out_ms - room }];
      d -= room;
    }
  }

  // Too short — either it always was, or the shed above went one piece past.
  if (d < 0) {
    const last = out[out.length - 1];
    const media = mediaMsOf?.(last.take_id);
    const room = Math.max(0, (media && media > 0 ? Math.round(media) : last.out_ms) - last.out_ms);
    const grow = Math.min(-d, room);
    if (grow > 0) {
      out = [...out.slice(0, -1), { ...last, out_ms: last.out_ms + grow }];
      d += grow;
    }
  }
  return { segments: out, remaining: Math.abs(d) <= FIT_EPS ? 0 : d };
}

/** Cut the slice under the playhead in two, so the halves can be reordered,
 *  swapped or thrown away separately. */
export function splitAt(segs: Segment[], tMs: number): Segment[] {
  const p = placedAt(segs, tMs);
  if (!p) return segs;
  const src = srcAt(segs, tMs);
  if (src - p.in_ms < MIN_SEGMENT_MS || p.out_ms - src < MIN_SEGMENT_MS) return segs;
  const out = segs.flatMap((s, k) => (k === p.i
    ? [{ ...s, out_ms: src }, { ...s, in_ms: src, note: undefined }]
    : [{ ...s }]));
  // NOT coalesce: the two halves are contiguous in source and would merge
  // straight back together. Splitting is a deliberate act.
  return out;
}

/** Swap which take a slice comes from, keeping its source window. */
export function setSegmentTake(segs: Segment[], i: number, takeId: string): Segment[] {
  if (i < 0 || i >= segs.length) return segs;
  return coalesce(segs.map((s, k) => (k === i ? { ...s, take_id: takeId, note: undefined } : { ...s })));
}

// --------------------------------------------------------------- evidence ---

export interface LineWindow {
  speaker: string;
  line: string;
  t0_ms: number;
  t1_ms: number;
  coverage: number;
}

export interface BadRange {
  code: string;
  severity: string;
  detail?: string;
  in_ms: number;
  out_ms: number;
}

/** What the reviewer measured about one take, on the take's own clock. */
export interface TakeEvidence {
  take_id: string;
  overall: number;
  /** the take's own length — a slice may not reach past it */
  duration_ms?: number;
  /** ASR-measured spoken lines — cutting inside one is audible */
  lines: LineWindow[];
  /** ranged issues: spans of this take known to be bad */
  bad: BadRange[];
  /** issues with no range — they damage the take everywhere */
  global: { code: string; severity: string; detail?: string }[];
}

export interface ReviewRowLike {
  take_id?: string | null;
  scores?: Record<string, number> | null;
  issues?: { code: string; severity: string; detail?: string; range_ms?: [number, number] | number[] }[] | null;
  transcript?: {
    matches?: { speaker?: string; line?: string; coverage?: number; t0?: number; t1?: number }[] | null;
  } | null;
}

/** Fold a `take_reviews` row into the shape the planner and the cut checker
 *  read. Transcript times are ASR seconds; everything downstream is ms. */
export function evidenceFromReview(
  takeId: string,
  r: ReviewRowLike | undefined,
  durationMs?: number,
): TakeEvidence {
  const lines: LineWindow[] = [];
  for (const m of r?.transcript?.matches ?? []) {
    if (m?.t0 == null || m?.t1 == null) continue;
    lines.push({
      speaker: m.speaker ?? "",
      line: m.line ?? "",
      t0_ms: Math.round(m.t0 * 1000),
      t1_ms: Math.round(m.t1 * 1000),
      coverage: m.coverage ?? 1,
    });
  }
  const bad: BadRange[] = [];
  const global: TakeEvidence["global"] = [];
  for (const i of r?.issues ?? []) {
    const rg = i.range_ms;
    if (Array.isArray(rg) && rg.length === 2 && rg[1] > rg[0]) {
      bad.push({ code: i.code, severity: i.severity, detail: i.detail, in_ms: rg[0], out_ms: rg[1] });
    } else {
      global.push({ code: i.code, severity: i.severity, detail: i.detail });
    }
  }
  return {
    take_id: takeId, overall: r?.scores?.overall ?? 0.8,
    ...(durationMs ? { duration_ms: durationMs } : {}),
    lines, bad, global,
  };
}

// ------------------------------------------------------------- cut quality --

export interface CutWarning {
  at_ms: number;
  code: "MID_LINE_CUT" | "FLICKER_CUT" | "SELECTED_BAD_RANGE" | "WEAK_SOURCE"
      | "MANY_CUTS" | "SHORT_SOURCE" | "REPEATED_MOMENT" | "JUMP_CUT";
  severity: "high" | "medium" | "low";
  detail: string;
}

const SEV_RANK = { high: 3, medium: 2, low: 1 } as const;
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/** Deterministic checks on an assembly, from evidence already measured and
 *  stored — no GPU, no round trip, so they can update as the user drags.
 *
 *  Everything the evidence knows is on a TAKE's clock and everything the user
 *  points at is on the CUT's, so each finding is measured in source time and
 *  reported at the cut time it lands on: a flag you cannot seek to is a flag
 *  nobody reads.
 *
 *  This is deliberately not frame-level continuity across a cut (is she still
 *  facing left?) — that is a picture question, and it is answered where every
 *  other picture question is: the assembled take goes through `take_review`
 *  like any other take. What lands here is everything measurable without
 *  looking at pixels, which is most of what actually goes wrong. */
export function cutWarnings(
  segs: Segment[],
  evidence: Map<string, TakeEvidence>,
  opts: { maxCuts?: number } = {},
): CutWarning[] {
  const out: CutWarning[] = [];
  const list = layout(coalesce(segs));
  /** a moment inside slice `p`, as a time on the assembly's own clock */
  const cutOf = (p: Placed, srcMs: number) =>
    Math.round(p.t0_ms + Math.max(0, Math.min(p.out_ms - p.in_ms, srcMs - p.in_ms)));

  for (const p of list) {
    if (p.t1_ms - p.t0_ms < MIN_SEGMENT_MS) {
      out.push({
        at_ms: p.t0_ms, code: "FLICKER_CUT", severity: "medium",
        detail: `${p.t1_ms - p.t0_ms}ms slice — too short to read as a shot`,
      });
    }
    const ev = evidence.get(p.take_id);
    if (!ev) continue;
    // A take shorter than the window asked of it does not error — ffmpeg just
    // trims to EOF and the finished block comes out short, which nothing
    // downstream checks.
    if (ev.duration_ms != null && p.out_ms > ev.duration_ms + 40) {
      out.push({
        at_ms: cutOf(p, ev.duration_ms), code: "SHORT_SOURCE", severity: "high",
        detail: `this take ends at ${fmtTime(ev.duration_ms)}, ${p.out_ms - ev.duration_ms}ms `
              + "before the window asked of it — the cut would come out short",
      });
    }
    for (const b of ev.bad) {
      if (!overlaps(p.in_ms, p.out_ms, b.in_ms, b.out_ms)) continue;
      out.push({
        at_ms: cutOf(p, Math.max(p.in_ms, b.in_ms)),
        code: "SELECTED_BAD_RANGE",
        severity: (b.severity as CutWarning["severity"]) ?? "medium",
        detail: `${b.code} in the selected part of this take${b.detail ? ` — ${b.detail}` : ""}`,
      });
    }
    for (const ln of ev.lines) {
      if (ln.coverage >= 0.9) continue;
      if (!overlaps(p.in_ms, p.out_ms, ln.t0_ms, ln.t1_ms)) continue;
      out.push({
        at_ms: cutOf(p, Math.max(p.in_ms, ln.t0_ms)), code: "WEAK_SOURCE", severity: "medium",
        detail: `${ln.speaker || "dialogue"} is only ${Math.round(ln.coverage * 100)}% spoken in this take here`,
      });
    }
  }

  // The joins. A cut through a spoken line is audible on both sides of it, and
  // each side is now measured against its OWN source timestamp rather than
  // against one shared clock.
  for (let i = 1; i < list.length; i++) {
    const before = list[i - 1];
    const after = list[i];
    const at = after.t0_ms;
    const hit =
      evidence.get(before.take_id)?.lines.find(
        (ln) => ln.t0_ms + 60 < before.out_ms && before.out_ms < ln.t1_ms - 60)
      ?? evidence.get(after.take_id)?.lines.find(
        (ln) => ln.t0_ms + 60 < after.in_ms && after.in_ms < ln.t1_ms - 60);
    if (hit) {
      out.push({
        at_ms: at, code: "MID_LINE_CUT", severity: "high",
        detail: `cuts through ${hit.speaker || "a line"}: "${(hit.line || "").slice(0, 44)}"`,
      });
    }
    // Two slices of ONE take, end to end, that are not continuous in it: the
    // classic jump cut. Free placement is what makes this expressible, so it
    // is what has to report it.
    if (before.take_id === after.take_id && before.out_ms !== after.in_ms) {
      out.push({
        at_ms: at, code: "JUMP_CUT", severity: "low",
        detail: `${fmtTime(before.out_ms)} to ${fmtTime(after.in_ms)} of the same take — `
              + "a jump cut unless the framing changes",
      });
    }
  }

  // The same instant of one take used twice. Under the tiling this could not
  // be said at all; now it is one drag away, and on screen it is a stutter
  // whose cause is nowhere in the picture.
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.take_id !== b.take_id) continue;
      if (!overlaps(a.in_ms, a.out_ms, b.in_ms, b.out_ms)) continue;
      const ov = Math.min(a.out_ms, b.out_ms) - Math.max(a.in_ms, b.in_ms);
      out.push({
        at_ms: b.t0_ms, code: "REPEATED_MOMENT", severity: "medium",
        detail: `${(ov / 1000).toFixed(1)}s of this take also plays at ${fmtTime(a.t0_ms)}`,
      });
    }
  }

  const maxCuts = opts.maxCuts ?? 4;
  if (list.length - 1 > maxCuts) {
    out.push({
      at_ms: 0, code: "MANY_CUTS", severity: "low",
      detail: `${list.length - 1} cuts inside one block — the join count itself reads as a glitch`,
    });
  }

  // The cut's LENGTH is deliberately not a warning. A cut that does not fit
  // its block is not a defect to be noticed later — it is a fork in what
  // committing means, so it is answered at the commit (fit it, or make it a
  // block of its own) rather than added to a list of things to read.

  // dedupe on (code, at) and rank worst-first
  const seen = new Set<string>();
  return out
    .filter((w) => { const k = `${w.code}@${w.at_ms}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.at_ms - b.at_ms);
}

// --------------------------------------------------------- auto assemble ----

export interface Span { t0_ms: number; t1_ms: number; label?: string }

/** A shot label for a chip, from whatever the beat carries. H3 camera grammar
 *  is a full prose sentence ("close-up; the camera pulls back with large
 *  amplitude at fast speed…") and the storyboard's action text is markdown —
 *  neither is a label until it is cut down to one. */
export function shotLabel(camera?: string | null, action?: string | null, n = 0): string {
  const raw = (camera || action || "").replace(/\*+/g, "").trim();
  if (!raw) return `shot ${n + 1}`;
  const head = raw.split(/[;,.]/)[0].trim() || raw;
  return head.length > 34 ? `${head.slice(0, 33).trimEnd()}…` : head;
}

/** The block's semantic segments: one span per beat (a beat IS a shot — see
 *  the storyplan hierarchy), cumulative from 0 and scaled onto the take's
 *  actual duration, since a render lands within a few ms of the plan. These
 *  are SOURCE spans: they describe every take, not the cut. */
export function shotSpans(
  beats: { duration_ms: number; camera?: string | null; action?: string | null }[],
  durationMs: number,
): Span[] {
  const total = beats.reduce((a, b) => a + (b.duration_ms || 0), 0);
  if (!beats.length || total <= 0) return [{ t0_ms: 0, t1_ms: Math.round(durationMs) }];
  const k = durationMs / total;
  const out: Span[] = [];
  let t = 0;
  beats.forEach((b, i) => {
    const t1 = i === beats.length - 1 ? Math.round(durationMs) : Math.round((t + (b.duration_ms || 0)) * k);
    out.push({
      t0_ms: out.length ? out[out.length - 1].t1_ms : 0,
      t1_ms: t1,
      label: shotLabel(b.camera, b.action, i),
    });
    t += b.duration_ms || 0;
  });
  return out.filter((s) => s.t1_ms > s.t0_ms);
}

const SEV_COST = { high: 0.35, medium: 0.15, low: 0.05 } as const;

/** How good a take is over one span, from measured evidence alone. */
export function spanScore(ev: TakeEvidence | undefined, span: Span): number {
  if (!ev) return 0.5;
  let s = ev.overall;
  const width = Math.max(1, span.t1_ms - span.t0_ms);
  for (const b of ev.bad) {
    if (!overlaps(span.t0_ms, span.t1_ms, b.in_ms, b.out_ms)) continue;
    const frac = (Math.min(span.t1_ms, b.out_ms) - Math.max(span.t0_ms, b.in_ms)) / width;
    s -= (SEV_COST[b.severity as keyof typeof SEV_COST] ?? 0.1) * Math.max(0.35, frac);
  }
  for (const ln of ev.lines) {
    if (ln.coverage >= 0.9) continue;
    if (!overlaps(span.t0_ms, span.t1_ms, ln.t0_ms, ln.t1_ms)) continue;
    s -= (1 - ln.coverage) * 0.4;
  }
  return Math.max(0, s);
}

/** Cost of changing take at a shot boundary. Without it the planner
 *  alternates on noise: a 0.01 difference is not worth a cut, and eight cuts
 *  in fifteen seconds is worse than the best single take. */
export const SWITCH_COST = 0.08;

export interface AutoAssembly {
  segments: Segment[];
  /** per-segment rationale, keyed by index in `segments` */
  notes: Record<string, string>;
}

/** Pick the best take for each semantic span, penalising changes — a small
 *  Viterbi over (span x take). Deterministic, evidence-only, and it runs in
 *  the browser: this is arithmetic over rows already loaded, and making it a
 *  job would mean waking a $3.36/hr GPU box to do it.
 *
 *  It proposes the plan's own shots in the plan's own order, so its output is
 *  a cut whose source time and cut time still agree — the assembly the tiling
 *  model could express, which is exactly the right starting point to edit.
 *
 *  `prefer` (normally the active take) breaks ties, so an assembly with
 *  nothing to gain comes back as the take you already had. */
export function autoAssemble(
  takeIds: string[],
  evidence: Map<string, TakeEvidence>,
  spans: Span[],
  durationMs: number,
  prefer?: string | null,
): AutoAssembly {
  if (!takeIds.length) return { segments: [], notes: {} };
  if (takeIds.length === 1 || !spans.length) {
    return { segments: tile(takeIds[0], durationMs), notes: {} };
  }
  const score = (t: string, s: Span) =>
    spanScore(evidence.get(t), s) + (prefer && t === prefer ? 0.001 : 0);

  // best[i][t] = best total score for spans 0..i ending on take t
  const best: Record<string, number>[] = [];
  const from: Record<string, string>[] = [];
  spans.forEach((span, i) => {
    const row: Record<string, number> = {};
    const back: Record<string, string> = {};
    for (const t of takeIds) {
      const here = score(t, span);
      if (i === 0) { row[t] = here; continue; }
      let bestPrev = -Infinity;
      let bestId = t;
      for (const p of takeIds) {
        const v = best[i - 1][p] - (p === t ? 0 : SWITCH_COST);
        if (v > bestPrev) { bestPrev = v; bestId = p; }
      }
      row[t] = here + bestPrev;
      back[t] = bestId;
    }
    best.push(row);
    from.push(back);
  });

  let cur = takeIds.reduce((a, b) => (best[spans.length - 1][b] > best[spans.length - 1][a] ? b : a));
  const chosen: string[] = new Array(spans.length);
  for (let i = spans.length - 1; i >= 0; i--) {
    chosen[i] = cur;
    cur = from[i][cur] ?? cur;
  }

  const raw: Segment[] = spans.map((s, i) => ({ take_id: chosen[i], in_ms: s.t0_ms, out_ms: s.t1_ms }));
  raw[raw.length - 1].out_ms = Math.round(durationMs);
  const segments = coalesce(raw);

  const notes: Record<string, string> = {};
  segments.forEach((seg, i) => {
    const covered = spans.filter((s) => overlaps(seg.in_ms, seg.out_ms, s.t0_ms, s.t1_ms));
    const mine = covered.reduce((a, s) => a + spanScore(evidence.get(seg.take_id), s), 0) / Math.max(1, covered.length);
    const rivals = takeIds
      .filter((t) => t !== seg.take_id)
      .map((t) => covered.reduce((a, s) => a + spanScore(evidence.get(t), s), 0) / Math.max(1, covered.length));
    const bestRival = rivals.length ? Math.max(...rivals) : 0;
    const gain = mine - bestRival;
    const label = covered.map((s) => s.label).filter(Boolean).slice(0, 2).join(" → ");
    notes[String(i)] = gain > 0.02
      ? `scores ${mine.toFixed(2)} here vs ${bestRival.toFixed(2)} for the next best${label ? ` (${label})` : ""}`
      : `no measured difference here — kept for continuity${label ? ` (${label})` : ""}`;
  });
  return { segments, notes };
}

// ------------------------------------------------------------------ misc ----

export function fmtTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

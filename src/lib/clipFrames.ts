// WHICH FRAME OF THE SOURCE A CLIP OPENS AND ENDS ON — the pure half of
// lib/frameExtractor.ts.
//
// Split out for the reason panelSpec.ts and assetKind.ts are: frameExtractor
// reaches B2 and Supabase at import time, so nothing in it can run under
// `node --test`, and this is the part that fails SILENTLY. An extract that
// grabs the wrong instant still uploads a plausible picture, registers a
// plausible asset and hands it to a generator as "what the shot ends on" —
// nothing errors, the bridge is just built between the wrong two frames.
import { asArray } from "./jsonb.ts";
import type { Asset, Clip, ClipOp } from "./db/types";

/** Assumed when the asset row records no fps. 24 is this studio's grid
 *  everywhere (invariant #5) and what `insertAsset` stamps on a placeholder. */
export const DEFAULT_FPS = 24;

/** Shorter than this and a clip is a handle with no body left to grab. Shared
 *  with WsTimeline's trim handles and the inspector's numeric trim fields so a
 *  floor enforced in one place cannot drift from the other. */
export const MIN_CLIP_MS = 200;

/** The two ops that decide how source time runs under the playhead, scanned
 *  once per clip OBJECT.
 *
 *  Cached here rather than at the call site because PreviewPlayer asks for
 *  these on every rAF tick for every clip near the playhead, and the scan
 *  allocated a closure per call. The store never mutates a clip in place
 *  (every edit is `{...clip, ...patch}`), so identity is an exact key — the
 *  same reasoning the player used for the private cache this replaces. It
 *  lives in this module so the player, the frame extractor and the trim
 *  readout cannot end up with three readings of one op list. */
const motionCache = new WeakMap<object, { rate: number; reversed: boolean }>();
function clipMotion(clip: Pick<Clip, "ops">) {
  let m = motionCache.get(clip);
  if (!m) {
    let rate = 1;
    let reversed = false;
    for (const o of asArray<{ op?: string; rate?: number }>(clip.ops)) {
      if (o?.op === "speed") {
        const r = o.rate;
        // COMPOUNDED, because that is what the render does: every speed op
        // appends its own `setpts`, so two of them multiply
        // (`worker/handlers/render.py::speed_rate`, and `_clip_effective_ms`
        // has always divided in a loop). The UI writes at most one — `retime`
        // strips the existing ones first — so for every clip that exists this
        // is the same number the old single-op read returned; it is the
        // multi-op case where taking one of them would put the preview's
        // window somewhere the render will not go.
        if (typeof r === "number" && Number.isFinite(r) && r > 0) rate *= r;
      } else if (o?.op === "reverse") {
        reversed = true;
      }
    }
    m = { rate, reversed };
    motionCache.set(clip, m);
  }
  return m;
}

/** A clip's playback rate. `speed` is the only op that changes how fast source
 *  time runs under the playhead, and the player reads this same function
 *  deliberately: "the last frame of this clip" has to mean "the frame the
 *  player is showing when the cut arrives", or the bridge opens on something
 *  the viewer never saw. A non-positive or non-finite rate is a corrupt op,
 *  not an instruction to divide by zero. */
export function clipRate(clip: Pick<Clip, "ops">): number {
  return clipMotion(clip).rate;
}

/** Does this clip play its source backwards? Then the frame it ENDS on is the
 *  in-point and the frame it OPENS on is the out-point. */
export function clipReversed(clip: Pick<Clip, "ops">): boolean {
  return clipMotion(clip).reversed;
}

/**
 * TIMELINE ms -> SOURCE-MEDIA ms, in the direction the clip actually plays.
 * The one mapping: PreviewPlayer drives every element through it, the
 * grab-frame button answers "which frame am I looking at" with it, and
 * `clipSourceMs` below is its two endpoints.
 *
 *     forward   src = in + into
 *     reversed  src = in + window - into        (window = duration * rate)
 *
 * where `into` is `(ms - t_start_ms) * rate`. So a reversed clip OPENS on the
 * end of its window and ENDS on its in-point, which is what the render's
 * `reverse` filter produces and what the trim readout has always said.
 *
 * `out_ms` is deliberately not consulted — see clipSourceMs. The window is
 * `duration_ms * rate` (the source this clip eats), which agrees with `out_ms`
 * after every trim gesture and is the honest answer after `_attach_to_clip`,
 * which writes a whole render's length into `out_ms` while only shrinking
 * `duration_ms`.
 */
export function clipSourceAt(
  clip: Pick<Clip, "in_ms" | "duration_ms" | "ops" | "t_start_ms">,
  ms: number
): number {
  const { rate, reversed } = clipMotion(clip);
  const head = Math.max(0, clip.in_ms ?? 0);
  const into = (ms - clip.t_start_ms) * rate;
  const window = reversed ? Math.max(0, clip.duration_ms ?? 0) * rate : 0;
  return Math.max(0, head + (reversed ? window - into : into));
}

/** One frame in ms, from the source asset's own fps. */
export function frameMs(asset?: Asset | null): number {
  const fps = asset?.fps;
  return 1000 / (typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS);
}

/**
 * Source-media milliseconds of the FIRST or LAST frame this clip actually
 * SHOWS — i.e. the trim is respected in both directions.
 *
 * These are the two endpoints of `clipSourceAt` above — the mapping the
 * player drives every element through:
 *
 *     srcMs = in_ms + (t - t_start_ms) * rate      (reversed: mirrored)
 *
 * so the clip's last instant (`t = t_start_ms + duration_ms`) is the CUT —
 * the first moment the clip is no longer on screen — and the last frame it
 * holds sits one frame earlier. Trimming the tail shortens `duration_ms`
 * (WsTimeline's `onTrimDown`, right handle) and trimming the head advances
 * `in_ms`, so both land here for free.
 *
 * `out_ms` is deliberately NOT consulted, though it looks like the obvious
 * source of a trim point. It agrees with `in_ms + duration_ms` after every
 * trim gesture and after the inspector's Out field — and it DISAGREES after
 * `_attach_to_clip`, which writes the whole render's length into `out_ms`
 * while only ever shrinking `duration_ms`. There the played window is the
 * shorter one, and `out_ms` names a frame nobody sees. It also knows nothing
 * about `rate`. The played window is the honest answer in every case.
 */
export function clipSourceMs(
  clip: Pick<Clip, "in_ms" | "duration_ms" | "ops">,
  position: "first" | "last",
  asset?: Asset | null
): number {
  const head = Math.max(0, clip.in_ms ?? 0);
  const dur = Math.max(0, clip.duration_ms ?? 0);
  const tail = Math.max(head, head + dur * clipRate(clip) - frameMs(asset));
  const wantTail = clipReversed(clip) ? position === "first" : position === "last";
  return wantTail ? tail : head;
}

/**
 * The longest this clip can run ON THE TIMELINE at `rate` — the source it has
 * left from its in-point, divided by how fast the playhead eats it.
 *
 * The ceiling is rate-dependent because the mapping above is, and that is the
 * whole reason a retime cannot be an op on its own: a clip consumes
 * `duration_ms * rate` of source, so setting 2x and leaving the width alone
 * asks a 10s file for 20s of media and plays the back half off the end of it —
 * whatever the decoder is holding there, for as long as the clip is on screen,
 * with nothing to say why.
 *
 * Infinity when the asset records no length. A placeholder clip is on the lane
 * from the moment a generate action is pressed until `_attach_to_clip` lands,
 * and clamping to a length nobody has measured is how a real shot gets cut to
 * a default — the failure `assets.duration_ms ?? 4000` already caused once.
 */
export function maxClipMs(
  clip: Pick<Clip, "in_ms" | "ops">,
  asset?: Asset | null,
  rate: number = clipRate(clip)
): number {
  const src = asset?.duration_ms;
  if (typeof src !== "number" || !Number.isFinite(src) || src <= 0) return Infinity;
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Math.max(0, src - Math.max(0, clip.in_ms ?? 0)) / r;
}

/**
 * The geometry a retime lands on: CONTRACT to what the media can still fill,
 * never grow.
 *
 * Never growing is the deliberate half. Doubling a clip's width because it was
 * slowed to 0.5x would shove or overlap everything after it on the lane — an
 * edit nobody asked for, made by a control that is about one clip — so a
 * slow-down keeps its slot and plays less of the source inside it. Speeding up
 * has no such choice: the media runs out.
 *
 * `out_ms` is rewritten from the played window rather than left alone, because
 * that column is what the RENDER trims to (`build_clip_filter` cuts
 * `in_ms..out_ms` and `setpts` divides what it cut) while the preview reads
 * `in_ms + duration_ms * rate`. Derived from the played window the two agree
 * in both directions: at 2x the intermediate is `(out - in) / 2`, exactly the
 * contracted width, and at 0.5x it stays that width instead of rendering
 * double and pushing every later clip along. It is a no-op on a clip whose
 * out-point already agreed with its length.
 *
 * That derivation is also what makes the contraction recoverable: the max is
 * read off the MEDIA, never off `out_ms`, so dragging the right handle back
 * out at 1x restores the whole shot.
 */
export function retimeGeometry(
  clip: Pick<Clip, "in_ms" | "duration_ms" | "ops">,
  rate: number,
  asset?: Asset | null
): { duration_ms: number; out_ms: number } {
  const head = Math.max(0, clip.in_ms ?? 0);
  const cur = Math.max(0, clip.duration_ms ?? 0);
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  // The floor never GROWS a clip: a cap under it means the media itself is
  // shorter than a grabbable clip, and a few frames of overrun is better than
  // a row with no body to click.
  const dur = Math.round(Math.max(Math.min(cur, maxClipMs(clip, asset, r)),
                                  Math.min(cur, MIN_CLIP_MS)));
  return { duration_ms: dur, out_ms: Math.round(head + dur * r) };
}

/** How many frames the source holds, when the row records a length. */
export function frameCount(asset?: Asset | null): number | null {
  const d = asset?.duration_ms;
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) return null;
  return Math.max(1, Math.round(d / frameMs(asset)));
}

/**
 * WHICH FRAME of the source is on screen at a given source instant.
 *
 * A decoder holds frame k for `[k·frameMs, (k+1)·frameMs)`, so this is a
 * floor — with an epsilon, because the boundary case is the COMMON one here
 * rather than a corner. An untrimmed 10s clip at 24fps ends at
 * `10000 - 1000/24 = 9958.333…`, which IS frame 239's own start and divides
 * to `238.99999999999997` in binary: a bare floor reports the
 * second-to-last frame of every untrimmed clip on the timeline, off by one,
 * consistently, and only ever by one — which is exactly the size of error
 * nobody notices until they cut on it.
 */
export function frameAt(srcMs: number, asset?: Asset | null): number {
  return Math.max(0, Math.floor(Math.max(0, srcMs) / frameMs(asset) + 1e-6));
}

/** `M:SS.mmm` — source time, where a clip is short enough that hours are noise. */
export function formatTc(ms: number): string {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(Math.floor(t % 1000)).padStart(3, "0")}`;
}

/** Why the edge stopped following the pointer, when it has. */
/** The clip fields a trim gesture writes. */
export interface TrimPatch {
  t_start_ms?: number;
  in_ms: number;
  duration_ms: number;
  out_ms: number;
}

/**
 * WHAT A TRIM HANDLE WRITES — and for a REVERSED clip the two handles move the
 * opposite ends of the source window.
 *
 * A clip's window is `[in_ms, in_ms + duration_ms * rate]`, and the handles are
 * named for the SCREEN: the left one is the edge the viewer reaches first. So
 * for a forward clip left moves the window's start and right moves its end,
 * and for a reversed clip — which plays that window backwards — it is the
 * other way round. `trimReadout` has always said so ("the left handle decides
 * what the clip opens on, the right what it ends on") and the gesture never
 * did: it moved `in_ms` on the left and `duration_ms` on the right whatever
 * the direction.
 *
 * The result was reported as "I trimmed the reversed clip and the start frame
 * changed", and both halves of it were wrong at once. Dragging the RIGHT
 * handle shortened the window from its far end, so the frame the clip OPENS on
 * moved — the one thing a tail trim must never touch. And dragging the LEFT
 * handle held that same frame fixed, so the readout above it named a number
 * that could not move for the whole gesture while the end it was really
 * cutting went unreported.
 *
 * The CLAMPS swap with it, or the drag binds against the wrong end of the
 * media: a reversed clip grown from the left runs its window past the file's
 * end, and one grown from the right runs `in_ms` below zero. Neither is the
 * ceiling the forward case checks.
 *
 * `edgeMs` is where the dragged edge wants to sit in TIMELINE ms, already
 * snapped — the component owns the pointer and the grid, this owns everything
 * that has to agree with the render.
 */
export function trimPatch(
  clip: Pick<Clip, "in_ms" | "duration_ms" | "t_start_ms" | "ops">,
  side: "l" | "r",
  edgeMs: number,
  asset?: Asset | null
): TrimPatch {
  const rate = clipRate(clip);
  const rev = clipReversed(clip);
  const head = Math.max(0, clip.in_ms ?? 0);
  const dur = Math.max(0, clip.duration_ms ?? 0);
  // What the media can still fill from the in-point, at this rate.
  const cap = maxClipMs(clip, asset, rate);

  if (side === "l") {
    let delta = edgeMs - clip.t_start_ms;
    delta = Math.max(delta, -clip.t_start_ms);           // not before the timeline starts
    delta = Math.max(delta, rev
      // Growing leftward pushes the window's END later, and the media ends.
      ? dur - cap
      // Forward it pulls the window's START earlier, and the media starts.
      : -head / rate);
    delta = Math.min(delta, dur - MIN_CLIP_MS);
    const nextIn = rev ? head : head + delta * rate;
    const nextDur = dur - delta;
    return {
      t_start_ms: Math.round(clip.t_start_ms + delta),
      in_ms: Math.round(nextIn),
      duration_ms: Math.round(nextDur),
      out_ms: Math.round(nextIn + nextDur * rate),
    };
  }

  let nextDur = Math.max(MIN_CLIP_MS, edgeMs - clip.t_start_ms);
  nextDur = Math.min(nextDur, Math.max(MIN_CLIP_MS, rev
    // Growing rightward walks the window's START back toward zero.
    ? dur + head / rate
    // Forward it walks the END on, and the media runs out.
    : cap));
  const nextIn = rev ? head + (dur - nextDur) * rate : head;
  return {
    in_ms: Math.round(nextIn),
    duration_ms: Math.round(nextDur),
    out_ms: Math.round(nextIn + nextDur * rate),
  };
}

export type TrimLimit = "media-start" | "media-end" | "min-length" | null;

export interface TrimReadout {
  /** In PLAYBACK terms: the left handle decides what the clip opens on, the
   *  right what it ends on. A reversed clip therefore reads its source
   *  backwards here, exactly as `clipSourceMs` already does. */
  edge: "in" | "out";
  frame: number;
  frames: number | null;
  /** The EXACT source instant the edge lands on, unquantised. What an audio
   *  lane wants: ffmpeg cuts sound at sample precision and there are no
   *  frames there to round to, so quoting the picture's grid on a music clip
   *  is a made-up number that happens to look precise. */
  cutMs: number;
  /** The START of the frame in source time — deliberately NOT the raw cut
   *  point. The two disagree by up to a frame, and a card showing
   *  `frame 239 · 0:09.981` is stating a time at which frame 239 is no
   *  longer the frame. Quoting the frame's own start makes the two halves of
   *  the readout describe one thing, and it is also what makes the card sit
   *  still while a drag moves within a frame — nothing has changed yet. */
  srcMs: number;
  /** Where a `<video>` has to seek to be SHOWING that frame: its middle.
   *  Seeking to a boundary lands on either side of it depending on the
   *  container's own timestamps. */
  seekMs: number;
  /** The clip's length if the gesture ended here, and the change so far. */
  durationMs: number;
  deltaMs: number;
  limit: TrimLimit;
}

/**
 * The frame a trim in flight will land on.
 *
 * Read off the PATCHED clip rather than off the pointer, deliberately: the
 * handler clamps to the media, to the timeline start, to a minimum length and
 * to the snap grid, so the pointer and the edge disagree the moment any of
 * those bind — and the whole promise of this card is that it names the frame
 * you will actually get.
 */
export function trimReadout(
  clip: Pick<Clip, "in_ms" | "duration_ms" | "ops">,
  side: "l" | "r",
  asset?: Asset | null,
  opts: { origDurationMs?: number; minMs?: number } = {}
): TrimReadout {
  const f = frameMs(asset);
  const srcMs = clipSourceMs(clip, side === "l" ? "first" : "last", asset);
  const frame = frameAt(srcMs, asset);
  const dur = Math.max(0, clip.duration_ms ?? 0);
  const head = Math.max(0, clip.in_ms ?? 0);
  const srcMax = asset?.duration_ms ?? null;

  // WHICH END OF THE MEDIA A HANDLE CAN RUN OUT OF, which is decided by the
  // SOURCE edge it moves rather than by the side it is on — the same swap
  // `trimPatch` makes, and for the same reason. A reversed clip's left handle
  // walks the window's END toward the file's end, so reporting "media-start"
  // there names a bound it cannot reach while the one that is actually binding
  // goes unsaid.
  const movesHead = (side === "l") !== clipReversed(clip);
  let limit: TrimLimit = null;
  if (opts.minMs != null && dur <= opts.minMs) limit = "min-length";
  else if (movesHead && head <= 0) limit = "media-start";
  else if (!movesHead && srcMax != null && head + dur * clipRate(clip) >= srcMax - 0.5) {
    limit = "media-end";
  }

  const start = frame * f;
  const mid = start + f / 2;
  return {
    edge: side === "l" ? "in" : "out",
    cutMs: srcMs,
    frame,
    frames: frameCount(asset),
    srcMs: start,
    seekMs: srcMax != null ? Math.min(mid, Math.max(0, srcMax - f / 2)) : mid,
    durationMs: dur,
    deltaMs: opts.origDurationMs == null ? 0 : dur - opts.origDurationMs,
    limit,
  };
}

/** A blade closer than this to either edge is a mis-click, not a cut. Shared
 *  with the inspector's Cut button so the control and the store agree about
 *  when the blade does nothing. */
export const SPLIT_EDGE_MS = 80;

export interface SplitGeometry {
  /** The cut, as a timeline offset into the clip. Both halves' widths are
   *  derived from it, so they sum to the original exactly and the lane keeps
   *  its geometry. */
  rel: number;
  /** Patch for the clip being cut. `in_ms` is present only on a reversed
   *  clip, where the LEFT half is the tail of the media. */
  left: { in_ms?: number; duration_ms: number; out_ms: number; ops: ClipOp[] };
  /** The new row. */
  right: {
    t_start_ms: number; in_ms: number; duration_ms: number; out_ms: number; ops: ClipOp[];
  };
}

/**
 * WHERE IN THE SOURCE A SPLIT LANDS — the pure half of the store's `splitAt`.
 *
 * A split must not change what the render delivers: the two halves' source
 * windows have to tile the original's exactly, in the order they play. The
 * blade is placed in TIMELINE ms and `in_ms`/`out_ms` are SOURCE ms, and the
 * mapping between them is `clipSourceMs`'s, carrying the rate:
 *
 *     srcMs = in_ms + (t - t_start_ms) * rate
 *
 * Dropping that rate is how a retimed clip's right half opens on the wrong
 * frame — at 1.5x a cut 3.3s in advanced the source by 3.3s where the picture
 * had already run 4.95s, so the new clip re-played 1.65s the left half had
 * just shown, and nothing about the row or the lane looked wrong.
 *
 * `reverse` swaps which END of the media each half gets, because a reversed
 * clip shows `end - t * rate`: the piece that plays FIRST is the tail. Left
 * with the forward assignment the two halves reconstruct the shot inside out
 * — each half backwards, the halves themselves in forward order. That is the
 * one place this follows the RENDER over the preview, which does not play
 * `reverse` at all (`clipReversed` says why): after the cut the stage shows
 * the halves' source in the other order, and the delivered file is unchanged,
 * which is the half that has to be true.
 *
 * Both `out_ms` values are derived from the PLAYED window rather than carried
 * from the row, for `retimeGeometry`'s reason: the column disagrees with the
 * window after `_attach_to_clip`, and it is what the render trims to.
 *
 * `ops` are carried to both halves, except `freeze` — the one POSITIONAL op,
 * whose `at_ms` is a source offset into the clip that holds it. Copied to both
 * (which is what the split did) one hold becomes two, and the copy on the half
 * whose in-point moved is measured from the wrong place besides.
 *
 * Null when the blade is outside the clip or within `SPLIT_EDGE_MS` of an
 * edge — a split that leaves a handle with no body is not one.
 */
export function splitGeometry(
  clip: Pick<Clip, "t_start_ms" | "duration_ms" | "in_ms" | "ops">,
  relMs: number
): SplitGeometry | null {
  const dur = Math.max(0, clip.duration_ms ?? 0);
  const rel = Math.round(relMs);
  if (rel <= SPLIT_EDGE_MS || rel >= dur - SPLIT_EDGE_MS) return null;

  const rate = clipRate(clip);
  const head = Math.max(0, clip.in_ms ?? 0);
  // One rounded offset, used for both halves, so the boundary is a single
  // integer: rounding each side on its own duplicates or drops a frame at the
  // join depending on which way the halves land.
  const off = Math.round(rel * rate);
  const end = head + Math.round(dur * rate);
  const t = Math.round(clip.t_start_ms + rel);

  const rev = clipReversed(clip);
  const cut = rev ? end - off : head + off;
  // ONE rule covers both directions, because only two source windows exist:
  // the half that keeps the clip's in-point, and the half that starts at the
  // cut. A freeze belongs to whichever holds it, and is re-based only on the
  // second — where the in-point advanced by exactly this much. Which half is
  // WHICH is what reverse swaps, and that is already decided above.
  const [keepOps, cutOps] = partitionFreezes(clip, cut - head);
  if (rev) {
    return {
      rel,
      left: { in_ms: cut, duration_ms: rel, out_ms: end, ops: cutOps },
      right: { t_start_ms: t, in_ms: head, duration_ms: dur - rel, out_ms: cut, ops: keepOps },
    };
  }
  return {
    rel,
    left: { duration_ms: rel, out_ms: cut, ops: keepOps },
    right: { t_start_ms: t, in_ms: cut, duration_ms: dur - rel, out_ms: end, ops: cutOps },
  };
}

/** `[ops for the half that keeps in_ms, ops for the half that starts at the
 *  cut]`, `boundary` source ms in. Every op rides both ways except a freeze,
 *  which goes to the one whose window holds it — re-based for the second,
 *  since `at_ms` is measured from its own half's in-point. Order is preserved
 *  on both sides; the renderer applies the first freeze it finds. */
function partitionFreezes(clip: Pick<Clip, "ops">, boundary: number): [ClipOp[], ClipOp[]] {
  const keep: ClipOp[] = [];
  const cut: ClipOp[] = [];
  for (const o of asArray<ClipOp>(clip.ops)) {
    if (!o || o.op !== "freeze") {
      if (o) { keep.push(o); cut.push(o); }
      continue;
    }
    const a = Math.max(0, Math.round(Number(o.at_ms) || 0));
    if (a >= boundary) cut.push({ ...o, at_ms: a - boundary });
    else keep.push(o);
  }
  return [keep, cut];
}

/**
 * WHERE A FREEZE LANDS IN THE SOURCE — `clips.ops`' `freeze.at_ms`.
 *
 * The renderer splits a frozen clip into three pieces and cuts them out of the
 * TRIMMED, un-sped source (`render_clip_file` builds `base` with the trim and
 * nothing else, then trims `[0, at]` and `[at, end]` out of it BEFORE the
 * speed op runs). So `at_ms` is a source offset from the clip's in-point, and
 * both write sites were storing the playhead's TIMELINE offset instead —
 * identical at 1x and nowhere else. At 1.5x a hold placed 3.3s into the clip
 * was cut at 3.3s of source, which is 2.2s into the picture: the shot stops on
 * a frame a third of the way earlier than the one that was on screen.
 *
 * Reversed, the frame under the playhead is measured from the other end, for
 * `splitGeometry`'s reason — playback shows `end - t * rate`.
 *
 * Clamped inside the played window: `at` past the media's end makes
 * `extract_frame` produce no file, which fails the whole timeline render.
 */
export function freezeSourceMs(
  clip: Pick<Clip, "duration_ms" | "ops">,
  relMs: number
): number {
  const dur = Math.max(0, clip.duration_ms ?? 0);
  const rate = clipRate(clip);
  const rel = Math.max(0, Math.min(relMs, dur));
  return Math.round((clipReversed(clip) ? dur - rel : rel) * rate);
}

// The mix: which tracks are audible, and how loud, at a given moment.
//
// Two consumers have to agree exactly — the preview player (PreviewPlayer) and
// the renderer (worker/mix.py, its Python twin). If they disagree, the preview
// is a lie about what the render will sound like, and nothing on screen says
// so. Everything here is pure and unit-tested; the Python side mirrors it
// function for function.
import type { Clip, Track } from "./db/types";

/** One automation point: a lane's output level at a moment in TIMELINE time. */
export interface AutoPoint {
  t_ms: number;
  gain_db: number;
}

/** The drawable/editable range of the automation lane. Wider than a fader
 *  needs to be useful and narrow enough that a 40px lane still resolves ~1dB
 *  per two pixels. */
export const AUTO_MIN_DB = -30;
export const AUTO_MAX_DB = 6;
/** Past this a curve is a drawing, not an edit — and the renderer compiles
 *  every point into one nested ffmpeg expression. */
export const MAX_AUTO_POINTS = 64;

export const clampDb = (db: number) => Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, db));

/** dB -> linear multiplier, floored at silence. -inf isn't representable in a
 *  slider, so the bottom of the range IS silence. */
export function linearGain(db: number): number {
  if (!Number.isFinite(db) || db <= AUTO_MIN_DB) return 0;
  return Math.pow(10, db / 20);
}

/** Media-element volume: the same curve, clamped to what HTMLMediaElement
 *  accepts (it throws on > 1, and boosting isn't possible in the browser —
 *  the renderer does honour gain above 0dB). */
export const elementVolume = (db: number) => Math.min(1, Math.max(0, linearGain(db)));

export const sortPoints = (pts: AutoPoint[]): AutoPoint[] =>
  [...pts].sort((a, b) => a.t_ms - b.t_ms);

/** Validated+sorted copy per points ARRAY, cached by identity. The preview
 *  player asks for lane levels on every rAF tick for every clip, and
 *  re-filtering and re-sorting an unchanged array 60×/s per clip was real
 *  main-thread work (and garbage) on WKWebView. Edits replace the array —
 *  the store never mutates one in place — so identity is an exact cache key,
 *  and a WeakMap lets dropped curves collect. */
const sortedCache = new WeakMap<AutoPoint[], AutoPoint[]>();
function sortedValidPoints(points: AutoPoint[] | null | undefined): AutoPoint[] {
  if (!points || !points.length) return [];
  let s = sortedCache.get(points);
  if (!s) {
    s = sortPoints(points.filter((p) => Number.isFinite(p?.t_ms) && Number.isFinite(p?.gain_db)));
    sortedCache.set(points, s);
  }
  return s;
}

/** The lane's level at `ms`: piecewise-linear between points, flat before the
 *  first and after the last. No points at all means the curve isn't in play
 *  and the fader value stands. */
export function gainAtMs(points: AutoPoint[] | null | undefined, ms: number, fallbackDb = 0): number {
  const pts = sortedValidPoints(points);
  if (!pts.length) return fallbackDb;
  if (ms <= pts[0].t_ms) return pts[0].gain_db;
  const last = pts[pts.length - 1];
  if (ms >= last.t_ms) return last.gain_db;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (ms <= b.t_ms) {
      const span = b.t_ms - a.t_ms;
      if (span <= 0) return b.gain_db;
      return a.gain_db + ((b.gain_db - a.gain_db) * (ms - a.t_ms)) / span;
    }
  }
  return last.gain_db;
}

type MixTrack = Pick<Track, "id" | "kind" | "muted" | "solo" | "gain_db"> & {
  automation?: AutoPoint[] | null;
};

/** Is anything soloed anywhere on the timeline? Solo is global by design: it
 *  answers "let me hear just this", so it has to silence the video lanes'
 *  baked audio too, not only the other audio lanes. */
export const soloActive = (tracks: MixTrack[]): boolean => tracks.some((t) => t.solo);

/** Mute wins over the track's own solo — a lane that is both is silent, which
 *  is what every NLE does and the only reading that lets you solo a group and
 *  still drop one member. */
export function isAudible(track: MixTrack | undefined, tracks: MixTrack[]): boolean {
  if (!track) return false;
  if (track.muted) return false;
  return !soloActive(tracks) || !!track.solo;
}

/** The lane's contribution at `ms`, in dB. Automation REPLACES the fader when
 *  it has points (see the migration note) — reading them as an offset would
 *  make every curve depend on where the fader happened to be. */
export function trackGainDbAt(track: MixTrack | undefined, ms: number): number {
  if (!track) return 0;
  const pts = track.automation ?? [];
  return pts.length ? gainAtMs(pts, ms, Number(track.gain_db) || 0) : Number(track.gain_db) || 0;
}

/** What one clip should actually be playing back at, right now: lane level +
 *  the clip's own trim, or silence if its lane isn't in the mix. A video
 *  clip whose audio has been detached is silent on the video lane — its audio
 *  is a separate clip on an audio lane now, and playing both doubles it. */
export function clipVolume(
  clip: Pick<Clip, "gain_db" | "track_id"> & { audio_detached?: boolean | null },
  tracks: MixTrack[],
  ms: number,
  /** Pre-resolved lane, for callers in a per-frame loop — the find below is an
   *  O(tracks) scan per clip per tick otherwise. Same answer either way. */
  track: MixTrack | undefined = undefined
): number {
  track ??= tracks.find((t) => t.id === clip.track_id);
  if (!isAudible(track, tracks)) return 0;
  if (clip.audio_detached && track?.kind === "video") return 0;
  return elementVolume(trackGainDbAt(track, ms) + (Number(clip.gain_db) || 0));
}

// ------------------------------------------------------- automation editing --

/** Add a point, replacing any within `epsMs` of it — clicking twice in the
 *  same spot must adjust that point, not stack an invisible second one on top
 *  of it. */
export function addPoint(points: AutoPoint[], p: AutoPoint, epsMs = 40): AutoPoint[] {
  const t = Math.max(0, Math.round(p.t_ms));
  const kept = (points ?? []).filter((q) => Math.abs(q.t_ms - t) > epsMs);
  if (kept.length >= MAX_AUTO_POINTS) return sortPoints(points ?? []);
  return sortPoints([...kept, { t_ms: t, gain_db: clampDb(p.gain_db) }]);
}

/** Move point `idx`. Time is free (the list re-sorts) so a point dragged past
 *  its neighbour reorders instead of sticking. */
export function movePoint(points: AutoPoint[], idx: number, p: AutoPoint): AutoPoint[] {
  const pts = points ?? [];
  if (idx < 0 || idx >= pts.length) return sortPoints(pts);
  const next = pts.map((q, i) =>
    i === idx ? { t_ms: Math.max(0, Math.round(p.t_ms)), gain_db: clampDb(p.gain_db) } : q
  );
  return sortPoints(next);
}

export function removePoint(points: AutoPoint[], idx: number): AutoPoint[] {
  return sortPoints((points ?? []).filter((_, i) => i !== idx));
}

/** Which point a pointer landed on, in the lane's own pixel space. */
export function hitPoint(
  points: AutoPoint[],
  at: { x: number; y: number },
  toXY: (p: AutoPoint) => { x: number; y: number },
  radiusPx = 7
): number {
  let best = -1;
  let bestD = radiusPx;
  (points ?? []).forEach((p, i) => {
    const { x, y } = toXY(p);
    const d = Math.hypot(x - at.x, y - at.y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** dB -> fraction down the automation lane (0 = top). */
export const dbToFrac = (db: number) => (AUTO_MAX_DB - clampDb(db)) / (AUTO_MAX_DB - AUTO_MIN_DB);
/** The inverse, for a pointer landing in the lane. */
export const fracToDb = (frac: number) =>
  clampDb(AUTO_MAX_DB - Math.min(1, Math.max(0, frac)) * (AUTO_MAX_DB - AUTO_MIN_DB));

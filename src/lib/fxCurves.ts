// What the effect displays draw: the actual response of the actual filters,
// not a shape that looks about right.
//
// Every curve here is computed from the same biquad coefficients Web Audio and
// ffmpeg use (RBJ's cookbook, the reference both implement), evaluated at the
// render sample rate. That matters because the graph is the thing people will
// trust: a decorative curve that says "+6dB at 200Hz" while the filter does
// something else is worse than no graph at all. `fxCurves.test.ts` checks the
// known points, and the browser check compares it against
// BiquadFilterNode.getFrequencyResponse — the authoritative implementation.
// The `.ts` extension is load-bearing: this used to be `import type`, which is
// erased, and these are VALUES. `node --test` strips types but does not guess
// extensions, so fxCurves.test.ts cannot load this module without it.
import {
  EQ_Q_MAX, EQ_Q_MIN, PHASER_BASE_HZ, SHELF_Q, bandAudible, bandTraits, dbToLin, eqBands,
  panMatrix, reverbTaps, shaper, type ClipFx, type EqBand,
} from "./audioFx.ts";

/** The grid every display shares: the audible band on a log axis. */
const n = (fx: ClipFx, k: string) => Number(fx.params[k]) || 0;

export const F_MIN = 20;
export const F_MAX = 20000;
export const SAMPLE_RATE = 48000;

export const fracToFreq = (t: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, t)));
export const freqToFrac = (f: number) =>
  Math.log(Math.min(F_MAX, Math.max(F_MIN, f)) / F_MIN) / Math.log(F_MAX / F_MIN);

/** The WIDTH axis, on the same log footing as the frequency one — and it lives
 *  here, next to that pair, for the reason it exists at all: a band with no
 *  gain (a cut, a notch) puts its width on the plot's vertical, and the handle's
 *  position and the drag that moves it were each computing their own formula.
 *  They ran opposite ways over different spans, so the handle jumped on grab
 *  and then moved AWAY from the cursor. One invertible pair, tested, is what
 *  stops that coming back; the plot applies the orientation and nothing else. */
export const qToFrac = (q: number) =>
  Math.log(Math.min(EQ_Q_MAX, Math.max(EQ_Q_MIN, q)) / EQ_Q_MIN) / Math.log(EQ_Q_MAX / EQ_Q_MIN);
export const fracToQ = (t: number) =>
  EQ_Q_MIN * Math.pow(EQ_Q_MAX / EQ_Q_MIN, Math.min(1, Math.max(0, t)));

export type BiquadKind =
  "peaking" | "lowshelf" | "highshelf" | "lowpass" | "highpass" | "allpass" | "notch";

export interface Biquad { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number }

/** RBJ cookbook coefficients. `gainDb` is used by the peaking and shelf kinds
 *  only; `q` by everything except the shelves (which use S = 1, exactly as
 *  Web Audio's shelving filters do). */
export function coeffs(kind: BiquadKind, f0: number, q: number, gainDb: number,
                       fs = SAMPLE_RATE): Biquad {
  const w0 = (2 * Math.PI * Math.min(f0, fs / 2 - 1)) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const Q = Math.max(0.0001, q);

  if (kind === "peaking") {
    const alpha = sin / (2 * Q);
    return {
      b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A,
      a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A,
    };
  }
  if (kind === "lowshelf" || kind === "highshelf") {
    const alpha = (sin / 2) * Math.sqrt(2);      // S = 1
    const sq = 2 * Math.sqrt(A) * alpha;
    if (kind === "lowshelf") {
      return {
        b0: A * ((A + 1) - (A - 1) * cos + sq),
        b1: 2 * A * ((A - 1) - (A + 1) * cos),
        b2: A * ((A + 1) - (A - 1) * cos - sq),
        a0: (A + 1) + (A - 1) * cos + sq,
        a1: -2 * ((A - 1) + (A + 1) * cos),
        a2: (A + 1) + (A - 1) * cos - sq,
      };
    }
    return {
      b0: A * ((A + 1) + (A - 1) * cos + sq),
      b1: -2 * A * ((A - 1) + (A + 1) * cos),
      b2: A * ((A + 1) + (A - 1) * cos - sq),
      a0: (A + 1) - (A - 1) * cos + sq,
      a1: 2 * ((A - 1) - (A + 1) * cos),
      a2: (A + 1) - (A - 1) * cos - sq,
    };
  }
  const alpha = sin / (2 * Q);
  if (kind === "notch") {
    return {
      b0: 1, b1: -2 * cos, b2: 1,
      a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha,
    };
  }
  if (kind === "allpass") {
    // Flat magnitude, all phase. Useless on its own and the entire mechanism
    // of a phaser: four of these summed back with the dry is what puts the
    // notches in.
    return {
      b0: 1 - alpha, b1: -2 * cos, b2: 1 + alpha,
      a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha,
    };
  }
  if (kind === "lowpass") {
    return {
      b0: (1 - cos) / 2, b1: 1 - cos, b2: (1 - cos) / 2,
      a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha,
    };
  }
  return {
    b0: (1 + cos) / 2, b1: -(1 + cos), b2: (1 + cos) / 2,
    a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha,
  };
}

/** |H(e^jw)| in dB at `f`, for the transfer function those coefficients define. */
export function magnitudeDb(c: Biquad, f: number, fs = SAMPLE_RATE): number {
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const num = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2
    + 2 * (c.b0 * c.b1 + c.b1 * c.b2) * cw + 2 * c.b0 * c.b2 * c2w;
  const den = c.a0 * c.a0 + c.a1 * c.a1 + c.a2 * c.a2
    + 2 * (c.a0 * c.a1 + c.a1 * c.a2) * cw + 2 * c.a0 * c.a2 * c2w;
  if (den <= 0) return -120;
  const mag = Math.sqrt(Math.max(1e-12, num / den));
  return Math.max(-120, 20 * Math.log10(mag));
}

/** One EQ band as the biquad both engines build from it.
 *
 *  A shelf is given `SHELF_Q` whatever it stores, because that is the only
 *  width Web Audio's shelving filters have and it is what the render is
 *  pinned to — drawing a shelf at some other slope would make the plot the
 *  odd one out of three. */
export const bandCoeffs = (b: EqBand, fs = SAMPLE_RATE) =>
  coeffs(b.type as BiquadKind, b.freq, bandTraits(b.type).q ? b.q : SHELF_Q,
         bandTraits(b.type).gain ? b.gain : 0, fs);

/** One band's own contribution, in dB over the log-frequency grid. What the
 *  plot draws faintly under the summed curve so a band can be picked out of a
 *  stack of them. */
export function bandCurve(b: EqBand, points = 128): number[] {
  const c = bandCoeffs(b);
  return Array.from({ length: points }, (_, i) => magnitudeDb(c, fracToFreq(i / (points - 1))));
}

/** The whole EQ: every audible band summed.
 *
 *  Summing dB is exactly right here and not an approximation — the bands are
 *  in SERIES in both engines, and cascaded filters multiply in magnitude,
 *  which is addition in dB. */
export function eqCurve(bands: EqBand[], points = 128): number[] {
  const cs = bands.filter(bandAudible).map((b) => bandCoeffs(b));
  return Array.from({ length: points }, (_, i) => {
    const f = fracToFreq(i / (points - 1));
    let db = 0;
    for (const c of cs) db += magnitudeDb(c, f);
    return db;
  });
}

/** H(e^jw) as a complex number.
 *
 *  `magnitudeDb` throws the phase away, which is fine for a filter you only
 *  sum with nothing. The phaser sums four allpasses back with the dry signal,
 *  and an allpass has magnitude 1 everywhere — so phase is the ONLY thing
 *  carrying its notches, and a magnitude-only evaluation would draw a flat
 *  line for an effect you can plainly hear. */
export function complexResponse(c: Biquad, f: number, fs = SAMPLE_RATE) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = c.a0 + c.a1 * c1 + c.a2 * c2;
  const di = -(c.a1 * s1 + c.a2 * s2);
  const den = dr * dr + di * di || 1e-12;
  return { re: (nr * dr + ni * di) / den, im: (ni * dr - nr * di) / den };
}

const cmul = (a: { re: number; im: number }, b: { re: number; im: number }) =>
  ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });

/** How many allpass stages a phaser runs. Tuna builds four; four is also what
 *  makes two notches, which is the sound. */
export const PHASER_STAGES = 4;

/** The phaser's magnitude response with its sweep parked at `pos` (0..1).
 *
 *  Real arithmetic, not a drawing: four cascaded allpasses with the last stage
 *  fed back into the first, summed with the dry path — exactly the graph Tuna
 *  wires. `H = 1 + A^4/(1 - fb*A^4)`. */
export function phaserCurve(fx: ClipFx, pos: number, points = 96): number[] {
  const depth = Math.min(1, Math.max(0, n(fx, "depth")));
  const fb = Math.min(0.9, Math.max(0, n(fx, "feedback")));
  // Tuna's LFO offsets by the base frequency and swings base*depth either way.
  const f0 = Math.max(20, PHASER_BASE_HZ + PHASER_BASE_HZ * depth * (pos * 2 - 1));
  const c = coeffs("allpass", f0, 1, 0);
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const f = fracToFreq(i / (points - 1));
    const a = complexResponse(c, f);
    let a4 = { re: 1, im: 0 };
    for (let k = 0; k < PHASER_STAGES; k++) a4 = cmul(a4, a);
    const dr = 1 - fb * a4.re, di = -fb * a4.im;
    const den = dr * dr + di * di || 1e-12;
    const wr = (a4.re * dr + a4.im * di) / den;
    const wi = (a4.im * dr - a4.re * di) / den;
    // Halved, because summing a unit-magnitude wet path with a unit dry path
    // is +6dB where they agree. Both engines run a level trim for the same
    // reason (aphaser's in_gain/out_gain), so the plot shows the same shape at
    // the same place on the scale.
    const mag = Math.sqrt((1 + wr) * (1 + wr) + wi * wi) / 2;
    out.push(Math.max(-40, 20 * Math.log10(Math.max(1e-6, mag))));
  }
  return out;
}

/** The overdrive's transfer curve: input amplitude -> output amplitude, drive
 *  and output gain included, so the plot is what the shaper actually does to a
 *  signal rather than the bare curve shape. `shaper` is ffmpeg's own — its
 *  `asoftclip=type=tanh:param=2` is `tanh(2x)`, measured against the binary. */
export function shaperCurve(fx: ClipFx, points = 96): { x: number; y: number }[] {
  const drive = dbToLin(n(fx, "drive"));
  const out = dbToLin(n(fx, "output"));
  return Array.from({ length: points }, (_, i) => {
    const x = -1 + (2 * i) / (points - 1);
    return { x, y: Math.max(-1.4, Math.min(1.4, shaper(drive * x) * out)) };
  });
}

/** The reverb's impulse response, as the display draws it: the dry hit, every
 *  reflection at its own level, and the -60dB envelope they sit on. */
export function reverbImpulse(fx: ClipFx) {
  const taps = reverbTaps(n(fx, "size"), n(fx, "decay"), n(fx, "mix"));
  const windowMs = Math.max(200, n(fx, "decay") * 1000);
  return { taps, windowMs, envelope: (ms: number) => Math.pow(10, (-3 * ms) / windowMs) };
}

/** Where a pan setting puts the sound, and what it costs each channel.
 *
 *  `l`/`r` are the gains a CORRELATED signal comes out at — which is why hard
 *  left reads +6dB rather than 0: the stereo law folds the right channel into
 *  the left rather than throwing it away. That is what the render does too, so
 *  it is what the meter shows. */
export function panDisplay(pan: number) {
  const m = panMatrix(pan);
  const lin = (v: number) => (v <= 1e-6 ? -60 : Math.max(-60, 20 * Math.log10(v)));
  const l = m.l.own + m.l.cross;
  const r = m.r.own + m.r.cross;
  return { l, r, lDb: lin(l), rDb: lin(r), pos: Math.min(1, Math.max(-1, pan)) };
}

/** The three fixed bands the EQ used to be. Kept only so the migration has a
 *  name to be checked against — the EQ is parametric now and its bands live on
 *  the row (`eqBands`), one per handle on the plot. */
export const EQ_BANDS: { key: string; kind: BiquadKind; freq: number; q: number }[] = [
  { key: "low", kind: "lowshelf", freq: 200, q: SHELF_Q },
  { key: "mid", kind: "peaking", freq: 1200, q: 1 },
  { key: "high", kind: "highshelf", freq: 5000, q: SHELF_Q },
];

/** A spectrum frame mapped onto the plot's log-frequency grid.
 *
 *  `getByteFrequencyData` hands back LINEARLY spaced bins (bin i is
 *  `i * sampleRate / fftSize` Hz), and the display is logarithmic — so the top
 *  octave is thousands of bins and the bottom one is a handful. Taking the
 *  MAX across each column's bins is what keeps a narrow peak visible up there
 *  instead of being averaged into the noise around it; interpolating between
 *  the two neighbouring bins is what stops the bottom octaves looking like a
 *  staircase. */
export function spectrumPoints(bins: ArrayLike<number>, sampleRate: number, points = 128): number[] {
  const nyq = sampleRate / 2;
  const binHz = nyq / bins.length;
  const out = new Array<number>(points);
  let prev = 0;
  for (let i = 0; i < points; i++) {
    const f = fracToFreq(i / (points - 1));
    const exact = f / binHz;
    const hi = i === points - 1 ? bins.length - 1
      : Math.min(bins.length - 1, Math.floor(fracToFreq((i + 0.5) / (points - 1)) / binHz));
    let v: number;
    if (hi > prev + 1) {
      v = 0;
      for (let k = prev + 1; k <= hi; k++) v = Math.max(v, bins[k]);
    } else {
      const a = Math.min(bins.length - 1, Math.floor(exact));
      const t = exact - a;
      v = (bins[a] ?? 0) * (1 - t) + (bins[Math.min(bins.length - 1, a + 1)] ?? 0) * t;
    }
    prev = Math.max(prev, hi);
    out[i] = v / 255;                                   // 0..1 over the analyser's dB window
  }
  return out;
}

/** Sampled dB response over the log-frequency grid, `points` wide. */
export function responseCurve(fx: ClipFx, points = 96): number[] {
  if (fx.id === "eq") return eqCurve(eqBands(fx), points);
  const filters: Biquad[] = [];
  if (fx.id === "filter") {
    const kind = fx.params.mode === "lowpass" ? "lowpass" : "highpass";
    filters.push(coeffs(kind, n(fx, "freq"), n(fx, "q"), 0));
  }
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const f = fracToFreq(i / (points - 1));
    let db = 0;
    for (const c of filters) db += magnitudeDb(c, f);
    out.push(db);
  }
  return out;
}

/** A compressor's static transfer curve: input dB -> output dB.
 *
 *  Drawn with a mild soft knee because that is what both engines default to
 *  (ffmpeg's `acompressor` knee is 2.83, and a hard corner is a lie about
 *  every real compressor). Makeup is added after, so the curve shows the level
 *  you actually get. */
export function transferDb(inputDb: number, thresholdDb: number, ratio: number,
                           makeupDb = 0, kneeDb = 3): number {
  const r = Math.max(1, ratio);
  const over = inputDb - thresholdDb;
  let out: number;
  if (over <= -kneeDb / 2) out = inputDb;
  else if (over >= kneeDb / 2) out = thresholdDb + over / r;
  else {
    // quadratic through the knee, tangent to both segments at its ends
    const x = over + kneeDb / 2;
    out = inputDb + ((1 / r - 1) * x * x) / (2 * kneeDb);
  }
  return out + makeupDb;
}

export function compressorCurve(fx: ClipFx, points = 64, minDb = -60): { x: number; y: number }[] {
  const th = n(fx, "threshold");
  const ratio = n(fx, "ratio") || 1;
  const makeup = n(fx, "makeup");
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < points; i++) {
    const x = minDb + ((0 - minDb) * i) / (points - 1);
    out.push({ x, y: transferDb(x, th, ratio, makeup) });
  }
  return out;
}

/** Echo taps: where the repeats land and how loud, until they fall below
 *  audibility or run off the end of the display window.
 *
 *  The levels are Tuna's, not a plausible-looking decay: its Delay puts the
 *  feedback gain in the direct wet path as well as in the loop, so repeat `n`
 *  comes out at `mix * feedback^n` and the FIRST one is already scaled once.
 *  `worker/audio_fx.echo_taps` writes the same series into `aecho`, which has
 *  no loop of its own. The dry stays at 1 in both. */
export function echoTaps(fx: ClipFx, windowMs = 2000, floor = 0.005): { t: number; level: number }[] {
  const time = Math.max(1, n(fx, "time"));
  const fb = Math.min(0.95, Math.max(0, n(fx, "feedback")));
  const mix = Math.min(1, Math.max(0, n(fx, "mix")));
  const taps = [{ t: 0, level: 1 }];
  let level = mix;
  for (let t = time; t <= windowMs; t += time) {
    level *= fb;
    if (level <= floor) break;
    taps.push({ t, level });
  }
  return taps;
}

/** One period-and-a-bit of the LFO a chorus or tremolo is running, as points
 *  in [0,1]x[0,1]. Depth scales the excursion; rate sets how many cycles fit
 *  in the window, so a faster setting visibly bunches up. */
export function lfoPoints(rateHz: number, depth: number, windowMs = 2000, points = 64) {
  const cycles = Math.max(0.25, (rateHz * windowMs) / 1000);
  const amp = Math.min(1, Math.max(0, depth));
  return Array.from({ length: points }, (_, i) => {
    const t = i / (points - 1);
    return { x: t, y: 0.5 - (Math.sin(2 * Math.PI * cycles * t) * amp) / 2 };
  });
}

/** Waveform peaks for the part of the asset a clip actually plays.
 *
 *  `meta.peaks` covers the whole file, so a trimmed clip has to show its own
 *  window or the panel draws a waveform that does not match what you hear. */
export function clipPeaks(peaks: number[], inMs: number, outMs: number | null,
                          durationMs: number | null, want = 96): number[] {
  if (!peaks?.length) return [];
  const total = durationMs && durationMs > 0 ? durationMs : null;
  const from = total ? Math.min(1, Math.max(0, inMs / total)) : 0;
  const to = total ? Math.min(1, Math.max(from, (outMs ?? total) / total)) : 1;
  const a = Math.floor(from * peaks.length);
  const b = Math.max(a + 1, Math.ceil(to * peaks.length));
  const slice = peaks.slice(a, b);
  if (slice.length <= want) return slice;
  // Downsample by MAX, not by average: an average smears the transients that
  // make a waveform readable in the first place.
  const out: number[] = [];
  const step = slice.length / want;
  for (let i = 0; i < want; i++) {
    let m = 0;
    for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) m = Math.max(m, slice[j] ?? 0);
    out.push(m);
  }
  return out;
}

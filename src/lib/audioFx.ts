// The audio effect catalog: ten effects, defined ONCE and converted by each
// engine that has to render them.
//
// Two engines play these: Tuna (https://github.com/Theodeus/tuna) in the
// preview, ffmpeg in the render (worker/audio_fx.py). So the stored parameters
// are engine-neutral and human — dB, Hz, ms, 0..1 — and every conversion to a
// Tuna property or an ffmpeg filter argument happens at the edge. Storing
// Tuna's own units would have baked one library's scaling (its chorus `delay`
// is a 0..1 knob over 0.4–4ms, its compressor makeup is a linear multiplier)
// into rows the renderer also has to read.
//
// The catalog is deliberately small. Every effect here maps to an ffmpeg
// filter that has existed for years — a preview the render cannot reproduce
// is the divergence this codebase keeps paying for — and every parameter is
// one both engines can honour over the SAME range, which is why chorus
// exposes rate and depth but not delay (Tuna caps that at ~4ms, ffmpeg does
// not, so the knob would mean two different things), and why the phaser
// exposes rate up to 2Hz and not Tuna's 8 (`aphaser`'s speed stops at 2).
//
// Where the two engines' internals genuinely differ, the difference is
// MEASURED against the real binary and written down rather than assumed. The
// three that matter are noted at their entries: the overdrive's curve (max
// 0.036 of full scale), the reverb's tail (exact — same taps, both sides) and
// a mono source through the panner (same image, up to +3dB of level).
export type FxParamKind = "number" | "choice" | "bands";

// ------------------------------------------------------------ the EQ's bands

/** Every band shape BOTH engines implement as the same RBJ biquad. Web Audio
 *  takes these names verbatim on a BiquadFilterNode; the ffmpeg column is what
 *  `worker/audio_fx.py` emits. */
export type EqBandType = "highpass" | "lowshelf" | "peaking" | "highshelf" | "lowpass" | "notch";

export interface EqBand {
  type: EqBandType;
  freq: number;
  /** dB. Ignored by the cut and notch shapes, which have no gain. */
  gain: number;
  q: number;
  /** Per-band bypass. Absent means on, like the effect's own power button. */
  on?: boolean;
}

export const BAND_TYPES: { type: EqBandType; label: string; gain: boolean; q: boolean }[] = [
  { type: "highpass",  label: "HP",    gain: false, q: true },
  { type: "lowshelf",  label: "Shelf", gain: true,  q: false },
  { type: "peaking",   label: "Bell",  gain: true,  q: true },
  { type: "highshelf", label: "Shelf", gain: true,  q: false },
  { type: "lowpass",   label: "LP",    gain: false, q: true },
  { type: "notch",     label: "Notch", gain: false, q: true },
];
const BAND_BY_TYPE = new Map(BAND_TYPES.map((b) => [b.type, b]));
export const bandTraits = (t: EqBandType) => BAND_BY_TYPE.get(t) ?? BAND_BY_TYPE.get("peaking")!;

/** How many bands one EQ may carry. Each is a biquad in the preview and a
 *  filter in the render's graph, and past a handful they stop being separable
 *  by eye on a plot this size. */
export const MAX_EQ_BANDS = 8;
export const EQ_FREQ_MIN = 20;
export const EQ_FREQ_MAX = 20000;
export const EQ_GAIN_MAX = 18;
/** The width range, exported because the PLOT has to map it onto a vertical
 *  axis and the two must be the same range: a display built on one span and a
 *  drag built on another is a handle that runs the wrong way, which is exactly
 *  what it did. */
export const EQ_Q_MIN = 0.1;
export const EQ_Q_MAX = 18;

/** **Shelf Q is NOT a control, and that is a parity constraint, not a
 *  simplification.** Web Audio's lowshelf/highshelf ignore `Q` entirely — the
 *  spec fixes their slope at S = 1 — while ffmpeg's `bass`/`treble` take a
 *  width and default it to 0.5. So a shelf Q would be a knob only one engine
 *  could honour, and leaving ffmpeg's default in place is itself a mismatch:
 *  RBJ's shelf alpha at S = 1 is `sin(w0)/2 * sqrt(2)`, which equals the
 *  Q form at exactly `1/sqrt(2)`. Both sides pin it there. */
export const SHELF_Q = Math.SQRT1_2;

/** A band's type from where it was DROPPED on the plot, which is the whole of
 *  "click at the left edge to get a high-pass": the ends of a spectrum are
 *  where cuts live, and asking for a bell at 25Hz is almost never the intent. */
export function bandTypeAt(freq: number): EqBandType {
  if (freq <= 60) return "highpass";
  if (freq >= 9000) return "lowpass";
  return "peaking";
}

export const defaultBand = (freq: number, gain = 0): EqBand => {
  const type = bandTypeAt(freq);
  return { type, freq, gain: bandTraits(type).gain ? gain : 0, q: type === "peaking" ? 1 : 0.707, on: true };
};

/** The three the old fixed EQ was, at the frequencies it used, so a row
 *  written before bands existed keeps sounding exactly as it did. */
const legacyBands = (low: number, mid: number, high: number): EqBand[] => [
  { type: "lowshelf",  freq: 200,  gain: low,  q: SHELF_Q, on: true },
  { type: "peaking",   freq: 1200, gain: mid,  q: 1,       on: true },
  { type: "highshelf", freq: 5000, gain: high, q: SHELF_Q, on: true },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** One stored band, made safe. A `jsonb` column can hold anything and both
 *  engines read it straight, so an out-of-range width is a filtergraph that
 *  fails the whole render. */
export function normalizeBand(raw: unknown): EqBand | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<EqBand>;
  const type = BAND_BY_TYPE.has(b.type as EqBandType) ? (b.type as EqBandType) : "peaking";
  const traits = bandTraits(type);
  const num = (v: unknown, d: number) => {
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : d;
  };
  return {
    type,
    freq: clamp(num(b.freq, 1000), EQ_FREQ_MIN, EQ_FREQ_MAX),
    gain: traits.gain ? clamp(num(b.gain, 0), -EQ_GAIN_MAX, EQ_GAIN_MAX) : 0,
    // A shelf's width is pinned rather than clamped: see SHELF_Q.
    q: traits.q ? clamp(num(b.q, 1), EQ_Q_MIN, EQ_Q_MAX) : SHELF_Q,
    on: b.on !== false,
  };
}

export function normalizeBands(raw: unknown): EqBand[] {
  if (!Array.isArray(raw)) return [];
  const out: EqBand[] = [];
  for (const item of raw) {
    const b = normalizeBand(item);
    if (b) out.push(b);
    if (out.length >= MAX_EQ_BANDS) break;
  }
  return out;
}

/** Does this band change the signal? A bell or shelf at unity gain is a biquad
 *  that costs a pass over the samples to produce its input; a cut or a notch
 *  always does something. */
export function bandAudible(b: EqBand): boolean {
  if (b.on === false) return false;
  return bandTraits(b.type).gain ? Math.abs(b.gain) >= 0.25 : true;
}

/** The bands on an `eq` entry, already normalised.
 *
 *  Falls back to the legacy migration for a row that has never been through
 *  `normalizeFx` — `worker/audio_fx.eq_bands` does exactly the same, and the
 *  two engines disagreeing about whether a raw row has bands is the kind of
 *  asymmetry that only shows up on the one code path nobody normalises. */
export const eqBands = (fx: ClipFx): EqBand[] => {
  const bands = normalizeBands(fx.params.bands);
  if (bands.length) return bands;
  return legacyBands(Number(fx.params.low) || 0, Number(fx.params.mid) || 0,
                     Number(fx.params.high) || 0);
};


export interface FxParam {
  key: string;
  label: string;
  kind: FxParamKind;
  /** number */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** choice */
  choices?: { value: string; label: string }[];
  default: number | string | EqBand[];
}

export interface FxDef {
  id: string;
  label: string;
  hint: string;
  params: FxParam[];
  /** This effect draws its own controls instead of a row of knobs. Only the
   *  EQ, whose parameter is a LIST of bands rather than a set of scalars. */
  editor?: "eq";
}

const db = (key: string, label: string, min = -18, max = 18): FxParam =>
  ({ key, label, kind: "number", min, max, step: 0.5, unit: "dB", default: 0 });

export const FX_CATALOG: FxDef[] = [
  {
    id: "eq",
    label: "EQ",
    hint: "A parametric EQ over the live spectrum. Click the curve to add a band "
      + "— at the far left it comes in as a high-pass, at the far right a "
      + "low-pass — then drag it for frequency and gain, wheel for width. "
      + "Double-click a band to remove it.",
    editor: "eq",
    params: [{
      key: "bands", label: "Bands", kind: "bands",
      default: legacyBands(0, 0, 0),
    }],
  },
  {
    id: "filter",
    label: "Filter",
    hint: "One sweepable pole. High-pass to take rumble off a voice, low-pass to "
      + "put a sound behind a wall or a phone.",
    params: [
      {
        key: "mode", label: "Mode", kind: "choice", default: "highpass",
        choices: [{ value: "highpass", label: "High-pass" }, { value: "lowpass", label: "Low-pass" }],
      },
      { key: "freq", label: "Freq", kind: "number", min: 40, max: 18000, step: 10, unit: "Hz", default: 120 },
      { key: "q", label: "Res", kind: "number", min: 0.1, max: 10, step: 0.1, default: 0.7 },
    ],
  },
  {
    id: "compressor",
    label: "Compressor",
    hint: "Evens out a performance. Threshold is where it starts working; ratio is "
      + "how hard. Makeup brings the level back up afterwards.",
    params: [
      { key: "threshold", label: "Thresh", kind: "number", min: -60, max: 0, step: 1, unit: "dB", default: -24 },
      { key: "ratio", label: "Ratio", kind: "number", min: 1, max: 20, step: 0.5, unit: ":1", default: 4 },
      { key: "attack", label: "Attack", kind: "number", min: 0.1, max: 200, step: 0.1, unit: "ms", default: 5 },
      { key: "release", label: "Release", kind: "number", min: 10, max: 2000, step: 10, unit: "ms", default: 250 },
      { key: "makeup", label: "Makeup", kind: "number", min: 0, max: 24, step: 0.5, unit: "dB", default: 0 },
    ],
  },
  {
    id: "echo",
    label: "Echo",
    hint: "Repeats. Short time with low feedback reads as a room; long time with "
      + "high feedback is the effect itself. Feedback drives the repeats — at "
      + "zero there are none. Its tail rings past the end of the clip.",
    params: [
      { key: "time", label: "Time", kind: "number", min: 20, max: 1000, step: 10, unit: "ms", default: 250 },
      { key: "feedback", label: "Feedback", kind: "number", min: 0, max: 0.9, step: 0.05, default: 0.35 },
      { key: "mix", label: "Mix", kind: "number", min: 0, max: 1, step: 0.05, default: 0.3 },
    ],
  },
  {
    id: "chorus",
    label: "Chorus",
    hint: "Doubles and detunes. Thickens a thin voice or a lone instrument; at high "
      + "depth it is a seasick wobble.",
    params: [
      { key: "rate", label: "Rate", kind: "number", min: 0.1, max: 8, step: 0.1, unit: "Hz", default: 1.5 },
      { key: "depth", label: "Depth", kind: "number", min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    id: "tremolo",
    label: "Tremolo",
    hint: "Volume pulsing at a fixed rate. Radio, helicopter, unease.",
    params: [
      { key: "rate", label: "Rate", kind: "number", min: 0.1, max: 20, step: 0.1, unit: "Hz", default: 5 },
      { key: "depth", label: "Depth", kind: "number", min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
  },
  {
    id: "overdrive",
    label: "Overdrive",
    hint: "Drives the signal into a soft clip. Grit on a voice, a speaker pushed "
      + "past its limit, a radio at the wrong end of a transmission. Drive is the "
      + "whole effect; Output is there to give back the level it costs you.",
    params: [
      { key: "drive", label: "Drive", kind: "number", min: 0, max: 36, step: 0.5, unit: "dB", default: 12 },
      { key: "output", label: "Output", kind: "number", min: -24, max: 6, step: 0.5, unit: "dB", default: -6 },
    ],
  },
  {
    id: "reverb",
    label: "Reverb",
    hint: "Puts the sound in a space. Size is how far the walls are, Decay is how "
      + "long it rings, Mix is how much of the room you hear. Its tail rings past "
      + "the end of the clip.",
    params: [
      { key: "size", label: "Size", kind: "number", min: 0, max: 1, step: 0.05, default: 0.4 },
      { key: "decay", label: "Decay", kind: "number", min: 0.2, max: 6, step: 0.1, unit: "s", default: 1.6 },
      { key: "mix", label: "Mix", kind: "number", min: 0, max: 1, step: 0.05, default: 0.3 },
    ],
  },
  {
    id: "phaser",
    label: "Phaser",
    hint: "Notches sweeping up and down the spectrum. Jet whoosh, tape wobble, "
      + "anything that should feel unmoored. Feedback resonates the peaks BETWEEN "
      + "the notches — that is the whistle, and it fills the notches in as it "
      + "rises.",
    params: [
      { key: "rate", label: "Rate", kind: "number", min: 0.1, max: 2, step: 0.05, unit: "Hz", default: 0.5 },
      { key: "depth", label: "Depth", kind: "number", min: 0, max: 1, step: 0.05, default: 0.6 },
      { key: "feedback", label: "Feedback", kind: "number", min: 0, max: 0.9, step: 0.05, default: 0.5 },
    ],
  },
  {
    id: "pan",
    label: "Pan",
    hint: "Where the sound sits between the speakers. Constant power, so moving it "
      + "off centre does not make it quieter.",
    params: [
      { key: "pan", label: "Pan", kind: "number", min: -1, max: 1, step: 0.02, default: 0 },
    ],
  },
];

/** The overdrive's shaper, shared by both engines and by the display.
 *
 *  ffmpeg's `asoftclip=type=tanh:param=P` is exactly `tanh(P*x)` — measured
 *  against the real binary to 3.5e-8, not read off the docs — so the curve the
 *  panel draws is the curve the render applies. Tuna's Overdrive builds its
 *  own table instead (algorithm 0, `(1+k)x / (1+k|x|)`), and 0.46 is the
 *  `curveAmount` that fits this one best: max error 0.036 of full scale
 *  (~-29dB) over the whole input range, found by sweeping both engines' curves
 *  against each other. That number is the honest size of the divergence. */
export const OD_CURVE = 2;
export const OD_TUNA_CURVE_AMOUNT = 0.46;
export const shaper = (x: number) => Math.tanh(OD_CURVE * x);

export const dbToLin = (db: number) => Math.pow(10, db / 20);

/** The centre the phaser's notch sweeps around, in both engines and in the
 *  display. Tuna takes it directly; ffmpeg's `aphaser` has no such input, so
 *  it is the frequency the display draws the sweep around. */
export const PHASER_BASE_HZ = 700;

/** How many reflections a reverb tail is built from. A budget, not a taste:
 *  every tap is a term in an `aecho` argument list (~1.7KB of filtergraph at
 *  128) and an impulse in the browser's IR. */
export const REVERB_TAPS = 128;
/** Below this a tap is inaudible and only costs filtergraph. */
const REVERB_FLOOR = 5e-4;
/** How fast the gap between reflections closes. 0.985^128 = 0.15, i.e. the
 *  tail ends about seven times denser than it starts. */
const REVERB_R = 0.985;
const PHI = 0.6180339887498949;

export interface ReverbTap { ms: number; gain: number }

/** The reverb, as the list of reflections BOTH engines play.
 *
 *  This is the whole effect and it is deliberately shared arithmetic rather
 *  than two implementations of "a reverb": `worker/audio_fx.py` has the same
 *  function, `aecho` is a pure feed-forward tap set (measured — an impulse in
 *  gives exactly `in_gain` at 0 and `decay_j` at `delay_j`, nothing
 *  recirculates), and the browser convolves with an impulse response built
 *  from these same numbers. So the two engines are not similar, they are the
 *  same filter. Values are rounded HERE, once, for the same reason.
 *
 *  Shape:
 *   - `size` sets how far away the first reflection is (13ms to 90ms).
 *   - The gap between reflections shrinks geometrically, so density grows
 *     through the tail: early reflections you can pick out, a late tail you
 *     cannot. Jittered so the comb has no period to ring on.
 *   - Gains sit on `10^(-3t/decay)`, i.e. exactly -60dB at the decay time.
 *   - `mix` scales the reflections only. The dry path is the `in_gain=1` tap
 *     at 0 that neither engine touches. */
export function reverbTaps(size: number, decaySec: number, mix: number): ReverbTap[] {
  const sz = Math.min(1, Math.max(0, size));
  const decayMs = Math.max(200, Math.min(6000, decaySec * 1000));
  const wet = Math.min(1, Math.max(0, mix));
  if (wet <= 0) return [];
  const base = 13 + 77 * sz;
  const span = Math.max(base + 40, decayMs);
  // Gaps SHRINK geometrically, so echo density grows through the tail the way
  // a real room's does. `g0` is solved from the sum so the last tap lands on
  // `span` whatever the decay — which also makes the pre-delay scale with the
  // space for free: 20ms into a short room, ~200ms into a hall.
  const sum = (REVERB_R * (1 - Math.pow(REVERB_R, REVERB_TAPS))) / (1 - REVERB_R);
  const g0 = (span - base) / sum;
  const out: ReverbTap[] = [];
  let t = base;
  for (let i = 1; i <= REVERB_TAPS; i++) {
    // ±35%, from the golden ratio: plain double arithmetic (so the Python twin
    // agrees bit for bit) that never repeats, which is what stops 128 evenly
    // spaced taps ringing as one metallic pitch.
    const jitter = 1 + 0.7 * (((i * PHI) % 1) - 0.5);
    t += g0 * Math.pow(REVERB_R, i) * jitter;
    const ms = Math.round(t * 10) / 10;
    const gain = Math.round(wet * Math.pow(10, (-3 * ms) / decayMs) * 1e4) / 1e4;
    if (gain < REVERB_FLOOR) continue;
    out.push({ ms, gain });
  }
  return out;
}

/** The two channel gain pairs a `pan` setting resolves to, straight out of the
 *  Web Audio spec's StereoPannerNode algorithm for a STEREO input:
 *  `outL = L + R*gl, outR = R*gr` panning left, mirrored panning right.
 *  `worker/audio_fx.py` writes exactly this into ffmpeg's `pan` matrix, so the
 *  image is identical rather than merely similar. */
export function panMatrix(pan: number) {
  const p = Math.min(1, Math.max(-1, pan));
  const x = p <= 0 ? p + 1 : p;
  const gl = Math.cos((x * Math.PI) / 2);
  const gr = Math.sin((x * Math.PI) / 2);
  return p <= 0
    ? { l: { own: 1, cross: gl }, r: { own: gr, cross: 0 } }
    : { l: { own: gl, cross: 0 }, r: { own: 1, cross: gr } };
}

export const FX_BY_ID = new Map(FX_CATALOG.map((d) => [d.id, d]));

/** How many effects one clip may carry. The preview builds a Web Audio node
 *  per effect per clip, so this is a budget, not a taste: eight clips with
 *  four effects each is already 32 chains on one timeline. */
export const MAX_FX = 4;

export interface ClipFx {
  id: string;
  /** Scalars for nine of the ten effects; the EQ's one entry is a LIST of
   *  bands, which is why this is not `Record<string, number | string>`. */
  params: Record<string, number | string | EqBand[]>;
  /** A plugin's power button. Off keeps the effect and its settings on the
   *  clip and takes it out of the signal path — in BOTH engines, which is why
   *  it is stored rather than being panel state. Absent means on, so every row
   *  written before this existed still plays. */
  enabled?: boolean;
}

export const fxDef = (id: string) => FX_BY_ID.get(id) ?? null;

export function defaultFx(id: string): ClipFx | null {
  const def = fxDef(id);
  if (!def) return null;
  const params: Record<string, number | string | EqBand[]> = {};
  // Deep-copied, or every EQ ever added would share one band array and moving
  // a band on one clip would move it on all of them.
  for (const p of def.params) {
    params[p.key] = Array.isArray(p.default) ? p.default.map((b) => ({ ...b })) : p.default;
  }
  return { id, params, enabled: true };
}

const clampNum = (p: FxParam, v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return p.default as number;
  return Math.min(p.max ?? n, Math.max(p.min ?? n, n));
};

/** Fill in what a row is missing and drop what it should not have.
 *
 *  A `jsonb` column can hold anything — an older build's shape, a hand-written
 *  row, a catalog entry that has since gained a parameter — and both engines
 *  read it directly. Everything downstream can then assume every parameter is
 *  present and in range. */
export function normalizeFx(raw: unknown): ClipFx[] {
  if (!Array.isArray(raw)) return [];
  const out: ClipFx[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const def = fxDef((item as ClipFx).id);
    if (!def) continue;                              // unknown effect: dropped
    const given = ((item as ClipFx).params ?? {}) as Record<string, unknown>;
    const params: Record<string, number | string | EqBand[]> = {};
    for (const p of def.params) {
      if (p.kind === "bands") {
        // The migration: a row written before the EQ was parametric carries
        // `low`/`mid`/`high` and no bands, and becomes the three fixed bands
        // it always was — same shapes, same frequencies, so it keeps sounding
        // exactly as it did and is now editable.
        const bands = normalizeBands(given.bands);
        params[p.key] = bands.length
          ? bands
          : legacyBands(Number(given.low) || 0, Number(given.mid) || 0, Number(given.high) || 0);
      } else if (p.kind === "choice") {
        const v = String(given[p.key] ?? p.default);
        params[p.key] = p.choices?.some((c) => c.value === v) ? v : (p.default as string);
      } else {
        params[p.key] = clampNum(p, given[p.key]);
      }
    }
    out.push({ id: def.id, params, enabled: (item as ClipFx).enabled !== false });
    if (out.length >= MAX_FX) break;
  }
  return out;
}

/** Does this chain do anything at all? An EQ flat across all three bands is a
 *  node chain that costs CPU to produce the input signal unchanged — worth
 *  skipping in the preview and worth leaving out of the render's filtergraph. */
export function isAudible(fx: ClipFx): boolean {
  if (fx.enabled === false) return false;    // powered off
  switch (fx.id) {
    case "eq":
      return eqBands(fx).some(bandAudible);
    case "echo":
      // Feedback as well as mix: Tuna's Delay routes the wet signal THROUGH
      // its feedback gain on the way out, so feedback 0 is silence rather than
      // a single slap-back, and a node chain that produces the dry signal
      // unchanged is one neither engine should be building.
      return (Number(fx.params.mix) || 0) > 0.01 && (Number(fx.params.feedback) || 0) > 0.01;
    case "chorus":
    case "tremolo":
    case "phaser":
      return (Number(fx.params.depth) || 0) > 0.01;
    case "reverb":
      return (Number(fx.params.mix) || 0) > 0.01;
    case "pan":
      return Math.abs(Number(fx.params.pan) || 0) > 0.01;
    case "overdrive":
      // Drive is what makes it an overdrive, but Output alone is a real level
      // change, and even at unity the shaper rounds off anything approaching
      // full scale — which is a legitimate reason to put one on a clip.
      return true;
    default:
      return true;   // a filter or a compressor always does something
  }
}

export const activeFx = (fx: ClipFx[]) => fx.filter(isAudible);

/** The effects the PREVIEW has to build nodes for.
 *
 *  The audible ones, plus a switched-on EQ whatever its bands are doing: the
 *  EQ's display is a live spectrum read off the chain's OWN analyser, so a
 *  flat EQ with no chain draws a dead graph at exactly the moment someone is
 *  about to shape something — which is what "I added an EQ and nothing
 *  happens" was. It costs nothing: `tunaNodes` gives a flat band a peaking
 *  filter at 0dB, which is exactly transparent.
 *
 *  The RENDER keeps using `activeFx`/`isAudible` — there is no display there,
 *  so a transparent filter would be a pass over the samples for nothing. */
export const previewFx = (fx: ClipFx[]) =>
  fx.filter((f) => isAudible(f) || (f.enabled !== false && f.id === "eq"));

/** One effect's NODE shape, ignoring parameter values.
 *
 *  The id is enough for nine of them, whose node count is fixed. The EQ's is
 *  not: it builds one biquad per band, so adding or removing one has to relink
 *  — and because the props are applied POSITIONALLY, a chain that kept its old
 *  node count would silently drop the extra bands (or leave removed ones still
 *  filtering). Measured as exactly that: five bands on a three-node chain
 *  reported `nodes: 3` and played the previous EQ.
 *
 *  Deliberately NOT `tunaNodes(f).length`, which would be the general answer:
 *  the reverb's entry builds a 128-tap list to return one node, and this is
 *  called from a render pass. */
export const fxShape = (f: ClipFx) => (f.id === "eq" ? `eq:${eqBands(f).length}` : f.id);

/** The chain's shape, ignoring parameter VALUES.
 *
 *  What the preview rebuilds its Web Audio nodes on. Turning a knob must not
 *  tear down and re-create the graph — that clicks, and it drops the effect's
 *  own state (an echo's tail, a compressor's envelope) every few pixels of a
 *  drag — so a parameter change updates the live nodes in place and only a
 *  change to THIS string relinks anything. */
export const fxSignature = (fx: ClipFx[]) => previewFx(fx).map(fxShape).join(">");

/** One line for a chip: "EQ +3/0/−2", "Echo 250ms". */
export function describeFx(fx: ClipFx): string {
  const def = fxDef(fx.id);
  if (!def) return fx.id;
  const n = (k: string) => Number(fx.params[k]) || 0;
  const sign = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  switch (fx.id) {
    case "eq": {
      const on = eqBands(fx).filter(bandAudible);
      if (!on.length) return `${def.label} flat`;
      if (on.length === 1) {
        const b = on[0];
        const hz = b.freq >= 1000 ? `${Math.round(b.freq / 100) / 10}k` : `${Math.round(b.freq)}`;
        return bandTraits(b.type).gain
          ? `${def.label} ${sign(Math.round(b.gain * 10) / 10)}dB @${hz}`
          : `${def.label} ${bandTraits(b.type).label} ${hz}`;
      }
      return `${def.label} ${on.length} bands`;
    }
    case "filter": return `${fx.params.mode === "lowpass" ? "Low-pass" : "High-pass"} ${Math.round(n("freq"))}Hz`;
    case "compressor": return `${def.label} ${n("ratio")}:1 @${n("threshold")}dB`;
    case "echo": return `${def.label} ${Math.round(n("time"))}ms`;
    case "overdrive": return `${def.label} ${sign(n("drive"))}dB`;
    case "reverb": return `${def.label} ${n("decay")}s`;
    case "pan": {
      const p = Math.round(n("pan") * 100);
      return p === 0 ? `${def.label} C` : `${def.label} ${p < 0 ? "L" : "R"}${Math.abs(p)}`;
    }
    default: return `${def.label} ${Math.round(n("rate") * 10) / 10}Hz`;
  }
}

// ------------------------------------------------------------ Tuna mapping --

/** The Tuna effect name and properties for one entry.
 *
 *  Kept here rather than in the graph builder so the conversion is testable
 *  without a Web Audio context — the arithmetic (dB to a linear makeup
 *  multiplier, ms to seconds, our chorus depth onto Tuna's) is exactly where a
 *  preview quietly stops matching the render. `eq` returns THREE nodes: Tuna's
 *  Filter is one biquad, and three bands are three of them. */
export function tunaNodes(fx: ClipFx): { effect: string; props: Record<string, unknown> }[] {
  const n = (k: string) => Number(fx.params[k]) || 0;
  switch (fx.id) {
    case "eq":
      // One Tuna Filter — i.e. one BiquadFilterNode — per STORED band, in
      // order, including the ones that currently do nothing.
      //
      // Not per AUDIBLE band, which is what the render does: a band whose gain
      // is dragged through zero would then add and remove a node mid-gesture,
      // and relinking the graph is what clicks. A peaking filter at 0dB is
      // exactly transparent (A = 1 makes b == a term for term), so carrying
      // one costs a pass over the samples and changes nothing — which is also
      // why ffmpeg is free to leave it out. `filterType` reaches
      // BiquadFilterNode.type verbatim; that is why the catalog's type names
      // are Web Audio's.
      return eqBands(fx).map((b) => (bandAudible(b) ? {
        effect: "Filter",
        props: {
          filterType: b.type, frequency: b.freq,
          gain: bandTraits(b.type).gain ? b.gain : 0,
          resonance: bandTraits(b.type).q ? b.q : SHELF_Q,
        },
      } : {
        effect: "Filter",
        props: { filterType: "peaking", frequency: b.freq, gain: 0, resonance: 1 },
      }));
    case "filter":
      return [{
        effect: "Filter",
        props: { filterType: String(fx.params.mode), frequency: n("freq"), resonance: n("q"), gain: 0 },
      }];
    case "compressor":
      return [{
        effect: "Compressor",
        props: {
          threshold: n("threshold"), ratio: n("ratio"),
          attack: n("attack"), release: n("release"),
          // Tuna's makeupGain is a LINEAR multiplier (1..100), ours is dB.
          makeupGain: Math.pow(10, n("makeup") / 20), automakeup: false,
        },
      }];
    case "echo":
      return [{
        effect: "Delay",
        props: {
          delayTime: n("time"), feedback: n("feedback"),
          wetLevel: n("mix"), dryLevel: 1, cutoff: 8000,
        },
      }];
    case "chorus":
      // Tuna's `delay` is a 0..1 knob over roughly 0.4–4ms; 0.6 is ~1.6ms,
      // which is the middle of what it can do and what ffmpeg is told to use.
      return [{ effect: "Chorus", props: { rate: n("rate"), depth: n("depth"), feedback: 0.4, delay: 0.6 } }];
    case "tremolo":
      return [{ effect: "Tremolo", props: { rate: n("rate"), intensity: n("depth"), stereoPhase: 0 } }];
    case "overdrive":
      // THREE nodes, because Tuna's own gains cannot carry this. Its `drive` is
      // a linear 0..1 input gain, so it can only ever ATTENUATE into the
      // shaper; and its `outputGain` runs through `dbToWAVolume`, which is
      // `2^(dB/6)` rounded to two decimals rather than `10^(dB/20)`. Plain Gain
      // nodes either side, converted here, are the same arithmetic ffmpeg's
      // `volume` does.
      return [
        { effect: "Gain", props: { gain: dbToLin(n("drive")) } },
        {
          effect: "Overdrive",
          props: {
            drive: 1, algorithmIndex: 0, curveAmount: OD_TUNA_CURVE_AMOUNT, outputGain: 0,
          },
        },
        { effect: "Gain", props: { gain: dbToLin(n("output")) } },
      ];
    case "reverb":
      // The one effect not played by Tuna: its Convolver takes an impulse URL
      // and XHRs it, and this impulse is generated, not fetched. `audioGraph`
      // builds a bare ConvolverNode from these taps (normalize OFF, or the
      // node would rescale the tail and the two engines would stop matching).
      // ONE prop, not two, because the graph applies props by assignment: a
      // `{key, taps}` pair would fire the rebuild twice and once with the new
      // key against the old taps.
      return [{
        effect: "IR",
        props: {
          ir: {
            // The cache key. Rebuilding a 6s buffer on every render pass of a
            // knob drag is the whole cost of this effect; a key that moves
            // only when the taps do is what stops that.
            key: `rv:${n("size")}:${n("decay")}:${n("mix")}`,
            taps: reverbTaps(n("size"), n("decay"), n("mix")),
          },
        },
      }];
    case "phaser":
      // Tuna sweeps four allpass stages around `baseModulationFrequency` with
      // an excursion of base*depth; ffmpeg's `aphaser` sweeps a modulated
      // delay. Both are one notch family walking the spectrum, and rate,
      // depth and feedback mean the same thing on each — the internals differ,
      // which is said out loud rather than implied.
      return [{
        effect: "Phaser",
        props: {
          rate: n("rate"), depth: n("depth"), feedback: n("feedback"),
          stereoPhase: 30, baseModulationFrequency: PHASER_BASE_HZ,
        },
      }];
    case "pan":
      return [{ effect: "Panner", props: { pan: n("pan") } }];
    default:
      return [];
  }
}

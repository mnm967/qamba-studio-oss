// The graphs are only worth drawing if they are TRUE — a curve claiming +6dB
// at 200Hz while the filter does something else is worse than no curve. These
// are the known points of the RBJ filters both engines implement; the browser
// check additionally compares the whole curve against Web Audio's own
// BiquadFilterNode.getFrequencyResponse.
import assert from "node:assert/strict";
import test from "node:test";

import {
  EQ_BANDS, PHASER_STAGES, clipPeaks, coeffs, complexResponse, compressorCurve, echoTaps,
  fracToFreq, fracToQ, freqToFrac, lfoPoints, magnitudeDb, panDisplay, phaserCurve, qToFrac,
  responseCurve, reverbImpulse, shaperCurve, transferDb,
} from "./fxCurves.ts";
import { EQ_Q_MAX, EQ_Q_MIN } from "./audioFx.ts";

const at = (fx: { id: string; params: Record<string, number | string> }, f: number) => {
  const curve = responseCurve(fx as never, 512);
  const idx = Math.round(freqToFrac(f) * 511);
  return curve[idx];
};

test("the EQ width axis round-trips, so a dragged handle follows the cursor", () => {
  // THE BUG THIS PINS: a cut or a notch has no gain, so the plot puts its WIDTH
  // on the vertical — and the handle's position and the drag that moved it were
  // each computing their own formula. They ran opposite ways over different
  // spans, so grabbing a q=1 handle wrote q≈7.4 on the first pixel of movement
  // and the handle then travelled AWAY from the pointer. One invertible pair is
  // the fix; these assertions are what keeps it one.
  assert.ok(Math.abs(fracToQ(0) - EQ_Q_MIN) < 1e-9, "the bottom of the axis is the widest band");
  assert.ok(Math.abs(fracToQ(1) - EQ_Q_MAX) < 1e-9, "the top is the narrowest");
  for (const q of [EQ_Q_MIN, 0.707, 1, 2, 4, 8, EQ_Q_MAX]) {
    assert.ok(Math.abs(fracToQ(qToFrac(q)) - q) < 1e-9, `q=${q} round-trips`);
  }
  // Every position on the axis maps back to itself: this is the equality the
  // two hand-written formulas did not have.
  for (const t of [0, 0.13, 0.5, 0.87, 1]) {
    assert.ok(Math.abs(qToFrac(fracToQ(t)) - t) < 1e-9, `frac=${t} round-trips`);
  }
  // Monotonic, so the handle can never reverse mid-drag...
  assert.ok(qToFrac(0.5) < qToFrac(1) && qToFrac(1) < qToFrac(4));
  // ...and log, like the wheel (a ratio per notch) and the Q knob, so an
  // octave of width is the same distance anywhere. Linear crushed 0.1..1 — a
  // third of the useful range — into the last tenth of the plot.
  assert.ok(Math.abs((qToFrac(1) - qToFrac(0.5)) - (qToFrac(8) - qToFrac(4))) < 1e-9);
  // Out of range clamps rather than running off the plot.
  assert.equal(qToFrac(EQ_Q_MAX * 10), 1);
  assert.equal(qToFrac(0), 0);
  assert.ok(Math.abs(fracToQ(-3) - EQ_Q_MIN) < 1e-9);
});

test("the log frequency axis round-trips and spans the audible band", () => {
  assert.equal(Math.round(fracToFreq(0)), 20);
  assert.equal(Math.round(fracToFreq(1)), 20000);
  assert.ok(Math.abs(freqToFrac(fracToFreq(0.42)) - 0.42) < 1e-9);
  // a decade should occupy the same width anywhere on the axis
  const decadeLow = freqToFrac(200) - freqToFrac(20);
  const decadeHigh = freqToFrac(2000) - freqToFrac(200);
  assert.ok(Math.abs(decadeLow - decadeHigh) < 1e-9);
});

test("a flat EQ is flat", () => {
  const flat = responseCurve({ id: "eq", params: { low: 0, mid: 0, high: 0 } } as never);
  assert.ok(flat.every((db) => Math.abs(db) < 1e-6));
});

test("a peaking band delivers its gain AT its centre", () => {
  const fx = { id: "eq", params: { low: 0, mid: 9, high: 0 } };
  assert.ok(Math.abs(at(fx, 1200) - 9) < 0.15, `got ${at(fx, 1200)}`);
  // ...and much less an octave and a half away
  assert.ok(at(fx, 300) < 2, `got ${at(fx, 300)}`);
  assert.ok(at(fx, 5000) < 2.5, `got ${at(fx, 5000)}`);
});

test("a cut is the mirror of a boost", () => {
  const up = at({ id: "eq", params: { mid: 6 } }, 1200);
  const down = at({ id: "eq", params: { mid: -6 } }, 1200);
  assert.ok(Math.abs(up + down) < 0.05, `${up} vs ${down}`);
});

test("shelves reach their gain at the edges and let the far end alone", () => {
  const low = { id: "eq", params: { low: 8, mid: 0, high: 0 } };
  assert.ok(Math.abs(at(low, 20) - 8) < 0.6, `got ${at(low, 20)}`);
  assert.ok(Math.abs(at(low, 12000)) < 0.5, `got ${at(low, 12000)}`);

  const high = { id: "eq", params: { low: 0, mid: 0, high: 8 } };
  assert.ok(Math.abs(at(high, 19000) - 8) < 0.6, `got ${at(high, 19000)}`);
  assert.ok(Math.abs(at(high, 40)) < 0.5, `got ${at(high, 40)}`);
});

test("bands add, because they are cascaded", () => {
  const both = at({ id: "eq", params: { low: 6, mid: 6, high: 0 } }, 1200);
  const midOnly = at({ id: "eq", params: { low: 0, mid: 6, high: 0 } }, 1200);
  assert.ok(both > midOnly, "the low shelf still contributes at 1.2kHz");
});

test("a Butterworth low-pass is -3dB at its corner and falls 12dB/octave", () => {
  const fx = { id: "filter", params: { mode: "lowpass", freq: 1000, q: 0.7071 } };
  assert.ok(Math.abs(at(fx, 1000) + 3) < 0.35, `got ${at(fx, 1000)}`);
  const oct = at(fx, 2000);
  const twoOct = at(fx, 4000);
  assert.ok(Math.abs((twoOct - oct) + 12) < 1.5, `${oct} -> ${twoOct}`);
  assert.ok(Math.abs(at(fx, 100)) < 0.15, "the pass band is flat");
});

test("a high-pass passes what is above it and stops what is below", () => {
  const fx = { id: "filter", params: { mode: "highpass", freq: 1000, q: 0.7071 } };
  assert.ok(Math.abs(at(fx, 8000)) < 0.2);
  assert.ok(at(fx, 125) < -30, `got ${at(fx, 125)}`);
});

test("resonance is a peak at the corner, and the graph shows it", () => {
  const tame = { id: "filter", params: { mode: "lowpass", freq: 1000, q: 0.7071 } };
  const ringing = { id: "filter", params: { mode: "lowpass", freq: 1000, q: 8 } };
  assert.ok(at(ringing, 1000) > at(tame, 1000) + 12, "Q 8 should ring ~+18dB above -3");
});

test("every EQ band the graph draws is one the compiler actually makes", () => {
  // The handles are positioned from EQ_BANDS; if those drifted from what
  // audioFx/tunaNodes emit, the graph would be drawing someone else's filter.
  assert.deepEqual(EQ_BANDS.map((b) => b.key), ["low", "mid", "high"]);
  assert.deepEqual(EQ_BANDS.map((b) => b.freq), [200, 1200, 5000]);
  assert.deepEqual(EQ_BANDS.map((b) => b.kind), ["lowshelf", "peaking", "highshelf"]);
});

test("magnitude of a bypassed (unity) biquad is 0dB everywhere", () => {
  const c = coeffs("peaking", 1000, 1, 0);
  for (const f of [50, 500, 5000, 15000]) assert.ok(Math.abs(magnitudeDb(c, f)) < 1e-9);
});

test("the compressor passes signal below the threshold and squeezes above it", () => {
  assert.equal(transferDb(-40, -20, 4), -40);
  // 12dB over a 4:1 threshold comes out 3dB over
  assert.ok(Math.abs(transferDb(-8, -20, 4) - -17) < 0.01);
  // ratio 1 is a straight wire
  assert.ok(Math.abs(transferDb(-5, -20, 1) - -5) < 0.01);
});

test("makeup lifts the whole transfer curve by exactly its own dB", () => {
  assert.ok(Math.abs(transferDb(-40, -20, 4, 6) - -34) < 0.01);
  const p = { threshold: -20, ratio: 4 };
  const dry = compressorCurve({ id: "compressor", params: { ...p, makeup: 0 } } as never);
  const wet = compressorCurve({ id: "compressor", params: { ...p, makeup: 6 } } as never);
  assert.ok(dry.every((q, i) => Math.abs(wet[i].y - q.y - 6) < 1e-9));
});

test("the knee rounds the corner: continuous, monotonic, and inside it", () => {
  // The textbook soft knee (y = x + (1/R-1)(x-T+W/2)^2 / 2W) cuts the corner
  // rather than sitting above it — gain reduction starts a little BEFORE the
  // threshold and the curve passes just inside the hard-knee elbow. A display
  // that drew a sharp corner would be showing a compressor nobody ships.
  const th = -20, r = 8, knee = 3;
  const ratioLine = (x: number) => th + (x - th) / r;

  assert.equal(transferDb(th - knee / 2, th, r), th - knee / 2, "unity at the knee's foot");
  assert.ok(Math.abs(transferDb(th + knee / 2, th, r) - ratioLine(th + knee / 2)) < 1e-9,
            "meets the ratio line at the knee's top");

  const inside = transferDb(-19, th, r);
  assert.ok(inside < -19, "already compressing");
  assert.ok(inside < ratioLine(-19), "inside the elbow, not above it");
  // Across the knee it stays inside a fixed budget of both hard segments:
  // never above unity (a compressor does not boost) and never more than
  // (1-1/R)·W/2 under the ratio line.
  const budget = (1 - 1 / r) * (knee / 2);
  for (let x = th - knee / 2; x <= th + knee / 2; x += 0.1) {
    const y = transferDb(x, th, r);
    assert.ok(y <= x + 1e-9, `boosting at ${x.toFixed(2)}`);
    assert.ok(ratioLine(x) - y <= budget + 1e-9, `too far under the ratio line at ${x.toFixed(2)}`);
  }
  // at the threshold itself it sits a quarter of that budget under the line
  assert.ok(Math.abs((ratioLine(th) - transferDb(th, th, r)) - budget / 4) < 1e-9);

  let prev = -Infinity;
  for (let x = -60; x <= 0; x += 0.25) {
    const y = transferDb(x, th, r);
    assert.ok(y > prev, "monotonic: louder in is never quieter out");
    prev = y;
  }
});

test("echo taps decay by feedback and stop when inaudible", () => {
  const taps = echoTaps({ id: "echo", params: { time: 250, feedback: 0.5, mix: 0.8 } } as never);
  assert.deepEqual(taps.slice(0, 3).map((t) => t.t), [0, 250, 500]);
  assert.equal(taps[0].level, 1, "the dry hit, at unity");
  assert.ok(Math.abs(taps[1].level - 0.4) < 1e-9, "the first repeat is already mix x feedback");
  assert.ok(Math.abs(taps[2].level - 0.2) < 1e-9, "and each one after is feedback x the last");
  assert.ok(taps.every((t) => t.level > 0.005));
});

test("no feedback is no echo at all, which is what Tuna's graph does", () => {
  // Its Delay sends the wet signal THROUGH the feedback gain on the way out,
  // not only around the loop, so feedback 0 mutes the effect rather than
  // leaving one slap-back. Surprising, and worth agreeing about: the render
  // writes the same series, and `isAudible` drops the whole effect so neither
  // engine spends a node on it.
  const taps = echoTaps({ id: "echo", params: { time: 300, feedback: 0, mix: 0.5 } } as never);
  assert.equal(taps.length, 1, "the dry hit and nothing else");
});

test("the LFO drawing follows rate and depth", () => {
  const slow = lfoPoints(1, 1);
  const fast = lfoPoints(4, 1);
  const zeroCrossings = (pts: { y: number }[]) =>
    pts.reduce((n2, p, i) => n2 + (i && (p.y - 0.5) * (pts[i - 1].y - 0.5) < 0 ? 1 : 0), 0);
  assert.ok(zeroCrossings(fast) > zeroCrossings(slow), "a faster rate shows more cycles");
  const shallow = lfoPoints(1, 0.2);
  const range = (pts: { y: number }[]) => Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
  assert.ok(range(shallow) < range(slow), "less depth is a smaller excursion");
});

test("the waveform shows the clip's own window, not the whole file", () => {
  const peaks = Array.from({ length: 100 }, (_, i) => (i < 50 ? 0.1 : 0.9));
  const firstHalf = clipPeaks(peaks, 0, 5000, 10000, 10);
  const secondHalf = clipPeaks(peaks, 5000, 10000, 10000, 10);
  assert.ok(Math.max(...firstHalf) < 0.5, "the quiet half is quiet");
  assert.ok(Math.min(...secondHalf) > 0.5, "the loud half is loud");
});

test("downsampling keeps transients rather than averaging them away", () => {
  const peaks = Array.from({ length: 200 }, (_, i) => (i === 137 ? 1 : 0.05));
  assert.equal(Math.max(...clipPeaks(peaks, 0, null, null, 20)), 1);
});

test("no peaks is an empty waveform, not a crash", () => {
  assert.deepEqual(clipPeaks([], 0, 1000, 1000), []);
  assert.deepEqual(clipPeaks(undefined as never, 0, null, null), []);
});

// ---------------------------------- the displays the new four effects draw --

test("an allpass passes everything — which is why the phaser needs phase", () => {
  const c = coeffs("allpass", 700, 1, 0);
  for (const f of [50, 200, 700, 3000, 15000]) {
    assert.ok(Math.abs(magnitudeDb(c, f)) < 0.01, `${f}Hz: ${magnitudeDb(c, f)}dB`);
  }
  // The defining property, and the one magnitudeDb throws away: at its corner
  // the response is real and NEGATIVE — a clean inversion at unit gain. That
  // inversion summed with the dry path is where a phaser's notches come from.
  const at700 = complexResponse(c, 700);
  assert.ok(at700.re < -0.999 && Math.abs(at700.im) < 0.01, `${JSON.stringify(at700)}`);
  // ...and it walks there from ~0 and back, rather than sitting at one value.
  const deg = (f: number) => {
    const v = complexResponse(c, f);
    return (Math.atan2(v.im, v.re) * 180) / Math.PI;
  };
  assert.ok(deg(50) > -20 && deg(350) < -50, "phase should be turning below the corner");
  assert.ok(deg(1400) > 50 && deg(15000) < 20, "and unwinding above it");
});

test("complexResponse agrees with magnitudeDb on magnitude", () => {
  for (const kind of ["peaking", "lowshelf", "lowpass"] as const) {
    const c = coeffs(kind, 800, 1, 6);
    for (const f of [60, 800, 6000]) {
      const v = complexResponse(c, f);
      const db = 20 * Math.log10(Math.sqrt(v.re * v.re + v.im * v.im));
      assert.ok(Math.abs(db - magnitudeDb(c, f)) < 1e-6, `${kind} @${f}Hz`);
    }
  }
});

test("the phaser is a comb, and feedback RESONATES it rather than deepening it", () => {
  // Worth pinning because the obvious guess is wrong and the panel's hint used
  // to repeat it. With the feedback taken around the allpass chain and summed
  // with the dry path, `H = 1 + u/(1 - fb*u)`: at the null (u = -1) that is
  // `fb/(1 + fb)`, which RISES with feedback, while at u = +1 it is
  // `1 + 1/(1 - fb)`, which runs away. So more feedback means taller peaks and
  // shallower notches — the whistle, not a deeper hole.
  const mk = (feedback: number, depth = 0.6) =>
    phaserCurve({ id: "phaser", params: { rate: 0.5, depth, feedback } }, 0.5, 192);
  const none = mk(0), soft = mk(0.1), hard = mk(0.9);
  assert.ok(Math.min(...none) < -20, "with no feedback the null is very deep");
  assert.ok(Math.max(...hard) > Math.max(...soft) + 6,
            `feedback should raise the peaks: ${Math.max(...soft)} -> ${Math.max(...hard)}`);
  assert.ok(Math.min(...hard) > Math.min(...soft),
            "and fill the notches in as it does so");
  assert.equal(PHASER_STAGES, 4);
  const dips = soft.filter((v, i) => i > 0 && i < soft.length - 1 && v < soft[i - 1] && v < soft[i + 1]);
  assert.ok(dips.length >= 2, `expected a comb, got ${dips.length} dips`);
});

test("the phaser's sweep MOVES with depth, and stands still without it", () => {
  const still = { id: "phaser", params: { rate: 0.5, depth: 0, feedback: 0.5 } };
  assert.deepEqual(phaserCurve(still, 0), phaserCurve(still, 1),
                   "depth 0 is no excursion, so both ends of the sweep are the same curve");
  const moving = { id: "phaser", params: { rate: 0.5, depth: 0.9, feedback: 0.5 } };
  const lowEnd = phaserCurve(moving, 0), highEnd = phaserCurve(moving, 1);
  const argmin = (a: number[]) => a.indexOf(Math.min(...a));
  assert.ok(argmin(highEnd) > argmin(lowEnd), "the notch should travel up the spectrum");
});

test("the shaper curve is what a soft clipper does", () => {
  const pts = shaperCurve({ id: "overdrive", params: { drive: 0, output: 0 } });
  // Odd-symmetric through the origin: no DC offset, and the negative half is
  // the mirror of the positive one. (No sample lands exactly on x=0 with an
  // even point count, so this is asserted on the shape rather than one point.)
  for (let i = 0; i < pts.length; i++) {
    const m = pts[pts.length - 1 - i];
    assert.ok(Math.abs(pts[i].x + m.x) < 1e-12 && Math.abs(pts[i].y + m.y) < 1e-12);
  }
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].y >= pts[i - 1].y, "monotone");
  const hot = shaperCurve({ id: "overdrive", params: { drive: 30, output: 0 } });
  assert.ok(hot[hot.length - 1].y <= 1.0001, "and it never exceeds full scale");
  assert.ok(hot[hot.length - 1].y > 0.99, "however hard it is driven");
});

test("the shaper curve includes the output trim, so the plot is the real level", () => {
  const cut = shaperCurve({ id: "overdrive", params: { drive: 30, output: -12 } });
  assert.ok(cut[cut.length - 1].y < 0.3, "-12dB out should visibly pull the curve down");
});

test("the reverb display draws the taps the engines actually play", () => {
  const { taps, windowMs, envelope } = reverbImpulse({
    id: "reverb", params: { size: 0.4, decay: 1.6, mix: 0.3 },
  });
  assert.equal(windowMs, 1600);
  assert.ok(Math.abs(envelope(1600) - 0.001) < 1e-9, "-60dB at the decay time");
  assert.equal(envelope(0), 1);
  assert.equal(taps.length, 107, "the same list the render hands aecho");
  assert.ok(taps.every((t) => t.ms <= windowMs * 1.01), "and none beyond the window drawn");
});

test("the pan meter reports what the stereo law really costs each channel", () => {
  const c = panDisplay(0);
  assert.ok(Math.abs(c.lDb) < 1e-6 && Math.abs(c.rDb) < 1e-6, "centre is unity both sides");
  const l = panDisplay(-1);
  // +6dB, not 0: hard left FOLDS the right channel in rather than discarding
  // it, which is the law both engines implement. A meter that hid that would
  // be lying about a level the render really produces.
  assert.ok(Math.abs(l.lDb - 6.0206) < 1e-3, `hard left reads ${l.lDb}dB`);
  assert.equal(l.rDb, -60);
  const r = panDisplay(1);
  assert.ok(Math.abs(r.rDb - 6.0206) < 1e-3);
  assert.equal(r.pos, 1);
  assert.equal(panDisplay(-9).pos, -1, "and it is clamped to the pot's travel");
});

test("the echo display shows Tuna's levels, not a plausible decay", () => {
  // Repeat n is mix * feedback^n: the feedback gain is in the direct wet path
  // as well as the loop, so the FIRST repeat is already scaled once. Drawing
  // it at `mix` would overstate every echo in the app by 1/feedback.
  const taps = echoTaps({ id: "echo", params: { time: 200, feedback: 0.5, mix: 0.3 } });
  assert.deepEqual(taps[0], { t: 0, level: 1 }, "the dry hit is untouched");
  assert.equal(taps[1].t, 200);
  assert.ok(Math.abs(taps[1].level - 0.15) < 1e-9);
  assert.ok(Math.abs(taps[2].level - 0.075) < 1e-9);
});

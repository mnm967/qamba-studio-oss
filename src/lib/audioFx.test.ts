// The effect catalog is read by two engines that must agree, and by a jsonb
// column that can hold anything. These are the seams: normalisation of a row,
// what counts as audible, what makes the preview relink its nodes, and the
// unit conversions into Tuna. worker/tests/test_audio_fx.py does the same for
// the ffmpeg side.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BAND_TYPES, FX_CATALOG, MAX_EQ_BANDS, MAX_FX, OD_CURVE, REVERB_TAPS, SHELF_Q, activeFx, bandTypeAt,
  dbToLin, defaultBand, defaultFx, describeFx, eqBands, fxSignature, isAudible, normalizeFx,
  panMatrix, previewFx, reverbTaps, shaper, tunaNodes, type EqBand,
} from "./audioFx.ts";

test("every catalogued effect has a usable default", () => {
  for (const def of FX_CATALOG) {
    const fx = defaultFx(def.id);
    assert.ok(fx, `${def.id} has no default`);
    for (const p of def.params) {
      assert.notEqual(fx!.params[p.key], undefined, `${def.id}.${p.key} missing`);
    }
  }
});

test("an unknown effect id is not invented", () => {
  assert.equal(defaultFx("vocoder"), null);
  assert.deepEqual(normalizeFx([{ id: "vocoder", params: {} }]), []);
});

test("normalize fills in parameters a stored row never had", () => {
  const [fx] = normalizeFx([{ id: "compressor", params: { ratio: 8 } }]);
  assert.equal(fx.params.ratio, 8);
  assert.equal(fx.params.threshold, -24);   // the catalog default
  assert.equal(fx.params.makeup, 0);
});

test("normalize clamps a parameter that would break the engine", () => {
  const [fx] = normalizeFx([{ id: "filter", params: { freq: 999999, q: -5, mode: "bandpass" } }]);
  assert.equal(fx.params.freq, 18000);
  assert.equal(fx.params.q, 0.1);
  assert.equal(fx.params.mode, "highpass", "an unlisted choice falls back to the default");
});

test("normalize survives junk without throwing", () => {
  assert.deepEqual(normalizeFx(null), []);
  assert.deepEqual(normalizeFx("eq" as never), []);
  assert.deepEqual(normalizeFx([null, 7, { nope: 1 }] as never), []);
  const [fx] = normalizeFx([{ id: "eq", params: { low: "loud" } }]);
  assert.equal((fx.params.bands as EqBand[])[0].gain, 0,
               "an unparseable number falls back rather than becoming NaN");
});

test("the chain is capped", () => {
  const long = Array.from({ length: 12 }, () => ({ id: "eq", params: {} }));
  assert.equal(normalizeFx(long).length, MAX_FX);
});

test("a flat EQ is not audible and does not earn a node chain", () => {
  assert.equal(isAudible({ id: "eq", params: { low: 0, mid: 0, high: 0 } }), false);
  assert.equal(isAudible({ id: "eq", params: { low: 0, mid: 3, high: 0 } }), true);
  assert.equal(isAudible({ id: "eq", params: { bands: [] } }), false);
  assert.equal(isAudible({ id: "eq", params: { bands: [{ type: "peaking", freq: 900, gain: 0, q: 1 }] } }), false);
  assert.equal(isAudible({ id: "eq", params: { bands: [{ type: "highpass", freq: 90, gain: 0, q: 1 }] } }), true,
               "a cut has no gain to be flat at — it always does something");
  assert.equal(isAudible({ id: "echo", params: { mix: 0 } }), false);
  assert.equal(isAudible({ id: "tremolo", params: { depth: 0 } }), false);
  assert.equal(isAudible({ id: "filter", params: { freq: 120 } }), true);
});

test("the signature ignores values, so turning a knob does not relink nodes", () => {
  const a = normalizeFx([{ id: "eq", params: { low: 3 } }, { id: "echo", params: {} }]);
  const b = normalizeFx([{ id: "eq", params: { low: 9 } }, { id: "echo", params: { time: 500 } }]);
  assert.equal(fxSignature(a), fxSignature(b));
  assert.equal(fxSignature(a), "eq:3>echo",
               "the EQ carries its BAND COUNT, because that is its node count");
});

test("the signature DOES change when an effect stops being audible", () => {
  const on = normalizeFx([{ id: "eq", params: { low: 6 } }, { id: "tremolo", params: { depth: 0.5 } }]);
  const off = normalizeFx([{ id: "eq", params: { low: 6 } }, { id: "tremolo", params: { depth: 0 } }]);
  assert.notEqual(fxSignature(on), fxSignature(off));
  assert.equal(activeFx(off).length, 1);
});

test("order is the signal path, and it is preserved", () => {
  const fx = normalizeFx([{ id: "echo", params: {} }, { id: "compressor", params: {} }]);
  assert.equal(fxSignature(fx), "echo>compressor");
});

test("EQ becomes one Tuna filter per band", () => {
  const nodes = tunaNodes({ id: "eq", params: { low: 3, mid: -2, high: 1 } });
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((n) => n.props.filterType), ["lowshelf", "peaking", "highshelf"]);
  assert.equal(nodes[1].props.gain, -2);
  assert.ok(Math.abs((nodes[0].props.resonance as number) - Math.SQRT1_2) < 1e-12,
            "a shelf gets SHELF_Q, the only width Web Audio's shelving filters have");
});

test("compressor makeup converts dB to Tuna's linear multiplier", () => {
  const [node] = tunaNodes({ id: "compressor", params: { makeup: 6, threshold: -20, ratio: 4, attack: 5, release: 250 } });
  assert.ok(Math.abs((node.props.makeupGain as number) - 1.995) < 0.01);
  assert.equal(node.props.automakeup, false, "automakeup would ignore the value we just set");
  assert.equal(node.props.attack, 5, "Tuna takes attack in ms, same as we store it");
});

test("echo maps mix onto the wet level and keeps the dry signal", () => {
  const [node] = tunaNodes({ id: "echo", params: { time: 400, feedback: 0.5, mix: 0.25 } });
  assert.equal(node.props.delayTime, 400);
  assert.equal(node.props.wetLevel, 0.25);
  assert.equal(node.props.dryLevel, 1);
});

test("echo keeps the dry signal, and the render writes out what Tuna loops", () => {
  // The preview's Delay recirculates; `aecho` does not, so the render spells
  // the repeats out. Both start from dryLevel 1 — the old ffmpeg form put the
  // mix on `out_gain`, which scales the dry tap too and quietly cost 11dB.
  const [node] = tunaNodes({ id: "echo", params: { time: 200, feedback: 0.5, mix: 0.3 } });
  assert.equal(node.props.dryLevel, 1);
  assert.equal(node.props.feedback, 0.5, "and it is the loop that makes the repeats here");
});

test("chips say what the effect is doing", () => {
  assert.equal(describeFx({ id: "eq", params: { low: 3, mid: 0, high: -2 } }), "EQ 2 bands");
  assert.equal(describeFx({ id: "eq", params: { bands: [] } }), "EQ flat");
  assert.equal(describeFx({ id: "eq", params: {
    bands: [{ type: "peaking", freq: 2400, gain: -4, q: 2 }] } }), "EQ -4dB @2.4k");
  assert.equal(describeFx({ id: "filter", params: { mode: "lowpass", freq: 800 } }), "Low-pass 800Hz");
  assert.equal(describeFx({ id: "echo", params: { time: 250 } }), "Echo 250ms");
});

test("the power button takes an effect out of the chain, keeping its settings", () => {
  const chain = normalizeFx([
    { id: "eq", params: { low: 6 }, enabled: false },
    { id: "echo", params: { mix: 0.4 } },
  ]);
  assert.equal(chain.length, 2, "still on the clip");
  assert.equal((chain[0].params.bands as EqBand[])[0].gain, 6, "settings kept");
  assert.equal(isAudible(chain[0]), false);
  assert.equal(fxSignature(chain), "echo", "and out of the preview's node chain");
});

test("an effect stored before the power button existed is on", () => {
  const [fx] = normalizeFx([{ id: "eq", params: { low: 6 } }]);
  assert.equal(fx.enabled, true);
  assert.equal(isAudible(fx), true);
});

// --------------------------------------------- overdrive, reverb, phaser, pan

test("overdrive is a gain, a shaper and a gain — Tuna's own cannot carry it", () => {
  const nodes = tunaNodes({ id: "overdrive", params: { drive: 12, output: -6 } });
  assert.deepEqual(nodes.map((n) => n.effect), ["Gain", "Overdrive", "Gain"]);
  // Tuna's `drive` is a linear 0..1 input gain, so it can only attenuate;
  // its `outputGain` is 2^(dB/6) rounded to two decimals, not 10^(dB/20).
  // Plain Gain nodes converted here are what ffmpeg's `volume` does.
  assert.ok(Math.abs((nodes[0].props.gain as number) - 3.981) < 0.001, "+12dB in");
  assert.ok(Math.abs((nodes[2].props.gain as number) - 0.5012) < 0.001, "-6dB out");
  assert.equal(nodes[1].props.drive, 1, "the shaper must not attenuate as well");
});

test("the shaper is ffmpeg's own curve", () => {
  // `asoftclip=type=tanh:param=2` is exactly tanh(2x), measured against the
  // binary. Anything else here and the panel draws one curve while the render
  // applies another.
  assert.equal(OD_CURVE, 2);
  for (const x of [-1, -0.4, 0, 0.25, 1]) assert.equal(shaper(x), Math.tanh(2 * x));
  assert.ok(shaper(4) < 1 && shaper(4) > 0.999, "it saturates rather than clipping hard");
});

test("reverb taps sit on the -60dB-at-the-decay-time envelope", () => {
  // Which is not decoration: an exponential envelope is what makes a tail
  // sound like a room emptying rather than a delay being switched off, and
  // -60dB at the stated decay is what "decay" means everywhere else.
  const decayMs = 1600;
  const taps = reverbTaps(0.4, decayMs / 1000, 1);
  for (const t of taps) {
    const want = Math.pow(10, (-3 * t.ms) / decayMs);
    assert.ok(Math.abs(t.gain - want) <= 5e-5, `${t.ms}ms: ${t.gain} vs ${want}`);
  }
  const last = taps[taps.length - 1];
  assert.ok(last.ms > decayMs * 0.9, `the tail should reach the decay time, stopped at ${last.ms}`);
  assert.ok(last.gain <= 0.002, `and be gone by then, not ${last.gain}`);
  const early = taps[0];
  assert.ok(early.ms > 13 && early.ms < 200, `first reflection at ${early.ms}ms`);
  assert.ok(early.gain > 0.5, "and it is not already buried");
});

test("reverb density grows through the tail, and never repeats a period", () => {
  const taps = reverbTaps(0.5, 3, 1);
  const gaps = taps.slice(1).map((t, i) => t.ms - taps[i].ms);
  const first = gaps.slice(0, 10).reduce((a, b) => a + b) / 10;
  const last = gaps.slice(-10).reduce((a, b) => a + b) / 10;
  assert.ok(last < first / 2, `gaps should close: ${first} -> ${last}`);
  assert.equal(new Set(gaps.map((g) => g.toFixed(1))).size > 20, true, "not a comb");
});

test("reverb tap numbers are pinned, because Python has to produce them too", () => {
  // worker/tests/test_audio_fx.py asserts these same literals. The two
  // implementations are one filter — the browser convolves with the taps
  // ffmpeg is handed — so a drift in either is a preview that lies.
  const a = reverbTaps(0.4, 1.6, 0.3);
  assert.equal(a.length, 107);
  assert.deepEqual(a[0], { ms: 73.3, gain: 0.2186 });
  assert.deepEqual(a[a.length - 1], { ms: 1500.4, gain: 0.0005 });
  const b = reverbTaps(1, 6, 1);
  assert.equal(b.length, REVERB_TAPS);
  assert.deepEqual(b[0], { ms: 202.2, gain: 0.7923 });
});

test("a dry reverb is no taps at all, not a silent chain of them", () => {
  assert.deepEqual(reverbTaps(0.4, 1.6, 0), []);
  assert.equal(isAudible({ id: "reverb", params: { size: 0.4, decay: 1.6, mix: 0 } }), false);
});

test("reverb reaches the graph as ONE prop, so the buffer is built once", () => {
  const [node] = tunaNodes({ id: "reverb", params: { size: 0.4, decay: 1.6, mix: 0.3 } });
  assert.equal(node.effect, "IR");
  assert.deepEqual(Object.keys(node.props), ["ir"], "a {key, taps} pair would rebuild twice");
  const ir = node.props.ir as { key: string; taps: unknown[] };
  assert.equal(ir.key, "rv:0.4:1.6:0.3");
  assert.equal(ir.taps.length, 107);
});

test("pan is the Web Audio stereo law, which is what the render writes", () => {
  const c = panMatrix(0);
  // cos(pi/2) is 6e-17 rather than 0 in every language that has doubles, which
  // is -324dB of crosstalk and reaches neither engine (pan 0 is not audible).
  assert.ok(Math.abs(c.l.own - 1) < 1e-12 && c.l.cross < 1e-12, "centre is identity");
  assert.ok(Math.abs(c.r.own - 1) < 1e-12 && c.r.cross === 0);
  const l = panMatrix(-1);
  assert.equal(l.l.cross, 1, "hard left folds the right channel in, it does not discard it");
  assert.ok(l.r.own < 1e-12);
  const r = panMatrix(1);
  assert.equal(r.r.cross, 1);
  assert.ok(r.l.own < 1e-12);
  const h = panMatrix(-0.5);
  assert.ok(Math.abs(h.l.cross - Math.SQRT1_2) < 1e-12, "constant power at the halfway point");
});

test("pan and phaser only earn a node when they are doing something", () => {
  assert.equal(isAudible({ id: "pan", params: { pan: 0 } }), false);
  assert.equal(isAudible({ id: "pan", params: { pan: -0.3 } }), true);
  assert.equal(isAudible({ id: "phaser", params: { depth: 0 } }), false);
  assert.equal(isAudible({ id: "phaser", params: { depth: 0.4 } }), true);
});

test("the phaser's rate stops where ffmpeg's does", () => {
  // Tuna would take 8Hz; `aphaser`'s speed maxes at 2, so 2 is the catalog's
  // ceiling — a knob that only one engine could honour is the divergence the
  // whole design exists to prevent.
  const def = FX_CATALOG.find((d) => d.id === "phaser")!;
  assert.equal(def.params.find((p) => p.key === "rate")!.max, 2);
  const [node] = tunaNodes({ id: "phaser", params: { rate: 2, depth: 0.6, feedback: 0.5 } });
  assert.equal(node.effect, "Phaser");
  assert.equal(node.props.rate, 2);
  assert.equal(node.props.feedback, 0.5);
});

test("dbToLin is the conversion both engines use", () => {
  assert.equal(dbToLin(0), 1);
  assert.ok(Math.abs(dbToLin(6) - 1.9953) < 1e-4);
  assert.ok(Math.abs(dbToLin(-6) - 0.5012) < 1e-4);
});

test("the new chips read as something a person would say", () => {
  assert.equal(describeFx({ id: "overdrive", params: { drive: 12, output: -6 } }), "Overdrive +12dB");
  assert.equal(describeFx({ id: "reverb", params: { decay: 2.4 } }), "Reverb 2.4s");
  assert.equal(describeFx({ id: "pan", params: { pan: 0 } }), "Pan C");
  assert.equal(describeFx({ id: "pan", params: { pan: -0.5 } }), "Pan L50");
  assert.equal(describeFx({ id: "pan", params: { pan: 0.34 } }), "Pan R34");
  assert.equal(describeFx({ id: "phaser", params: { rate: 0.5 } }), "Phaser 0.5Hz");
});

test("every catalogued parameter is in range at its own default", () => {
  for (const def of FX_CATALOG) {
    for (const p of def.params) {
      if (p.kind !== "number") continue;
      const v = Number(p.default);
      assert.ok(v >= (p.min ?? -Infinity) && v <= (p.max ?? Infinity),
                `${def.id}.${p.key} default ${v} is outside ${p.min}..${p.max}`);
    }
  }
});

// ----------------------------------------------------- the parametric EQ ---

test("a row from before the EQ was parametric migrates to the shape it was", () => {
  // The whole point: it must keep SOUNDING the same, so the three bands are
  // the three the fixed EQ had, at its frequencies, with its gains.
  const [fx] = normalizeFx([{ id: "eq", params: { low: 4, mid: -3, high: 2 } }]);
  const bands = fx.params.bands as EqBand[];
  assert.deepEqual(bands.map((b) => [b.type, b.freq, b.gain]),
                   [["lowshelf", 200, 4], ["peaking", 1200, -3], ["highshelf", 5000, 2]]);
  assert.equal(bands[0].q, SHELF_Q);
});

test("bands survive a round trip, and junk in one does not take the rest down", () => {
  const [fx] = normalizeFx([{ id: "eq", params: { bands: [
    { type: "highpass", freq: 80, gain: 0, q: 0.7 },
    { type: "banana", freq: 1e9, gain: "loud", q: -5 },     // every field wrong
    { type: "peaking", freq: 3000, gain: -4, q: 2.5, on: false },
  ] } }]);
  const b = fx.params.bands as EqBand[];
  assert.equal(b.length, 3, "the bad one is repaired, not dropped");
  assert.deepEqual([b[0].type, b[0].freq], ["highpass", 80]);
  assert.deepEqual([b[1].type, b[1].freq, b[1].gain, b[1].q], ["peaking", 20000, 0, 0.1]);
  assert.equal(b[2].on, false, "a bypassed band keeps its settings");
});

test("the band list is capped", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ type: "peaking", freq: 100 + i * 100, gain: 3, q: 1 }));
  const [fx] = normalizeFx([{ id: "eq", params: { bands: many } }]);
  assert.equal((fx.params.bands as EqBand[]).length, MAX_EQ_BANDS);
});

test("where you click decides the band you get", () => {
  // "click at the left end for a high-pass" — the ends of a spectrum are where
  // cuts live, and a bell at 25Hz is almost never what was meant.
  assert.equal(bandTypeAt(25), "highpass");
  assert.equal(bandTypeAt(60), "highpass");
  assert.equal(bandTypeAt(61), "peaking");
  assert.equal(bandTypeAt(3000), "peaking");
  assert.equal(bandTypeAt(9000), "lowpass");
  assert.equal(bandTypeAt(19000), "lowpass");
  assert.equal(defaultBand(30, 6).gain, 0, "a cut has no gain to carry");
  assert.equal(defaultBand(1000, 6).gain, 6);
});

test("a shelf's width is pinned, because only one engine has it", () => {
  // Web Audio's lowshelf/highshelf ignore Q outright (the spec fixes S = 1),
  // so a shelf Q would be a control that could only ever move the render.
  const [fx] = normalizeFx([{ id: "eq", params: {
    bands: [{ type: "lowshelf", freq: 200, gain: 5, q: 9 }] } }]);
  assert.equal((fx.params.bands as EqBand[])[0].q, SHELF_Q, "the stored 9 is discarded");
  const [node] = tunaNodes(fx);
  assert.equal(node.props.resonance, SHELF_Q);
});

test("a band that is doing nothing still gets a NODE, and it is transparent", () => {
  // Not an optimisation miss: dragging a gain through zero would otherwise add
  // and remove a node mid-gesture, and relinking is what clicks. A peaking
  // filter at 0dB is exactly transparent, so it changes nothing.
  const fx: import("./audioFx.ts").ClipFx = { id: "eq", params: { bands: [
    { type: "peaking", freq: 900, gain: 0, q: 4 },
    { type: "peaking", freq: 3000, gain: 5, q: 1 },
    { type: "highshelf", freq: 8000, gain: 4, q: SHELF_Q, on: false },
  ] } };
  const nodes = tunaNodes(fx);
  assert.equal(nodes.length, 3, "one per STORED band");
  assert.equal(nodes[0].props.gain, 0);
  assert.equal(nodes[2].props.filterType, "peaking", "a bypassed band flattens rather than vanishing");
  assert.equal(nodes[2].props.gain, 0);
  assert.equal(nodes[1].props.gain, 5);
});

test("adding a band relinks the chain; moving one does not", () => {
  // The bug this pins: five bands on a three-node chain reported `nodes: 3`
  // and went on playing the previous EQ, because props are applied by INDEX.
  const three = normalizeFx([{ id: "eq", params: { low: 3 } }]);
  const moved = normalizeFx([{ id: "eq", params: {
    bands: (normalizeFx([{ id: "eq", params: { low: 3 } }])[0].params.bands as EqBand[])
      .map((b, i) => (i === 1 ? { ...b, freq: 4000, gain: -6 } : b)) } }]);
  assert.equal(fxSignature(three), fxSignature(moved), "a band moving is a knob turn");
  const four = normalizeFx([{ id: "eq", params: {
    bands: [...(three[0].params.bands as EqBand[]), { type: "peaking", freq: 7000, gain: 2, q: 1 }] } }]);
  assert.notEqual(fxSignature(three), fxSignature(four), "a band arriving is a new graph");
  assert.equal(tunaNodes(four[0]).length, 4);
});

test("every band type the catalog offers is one BOTH engines have", () => {
  // Web Audio takes these names verbatim on a BiquadFilterNode; the twin test
  // in worker/tests/test_audio_fx.py checks each maps to a real ffmpeg filter.
  const webAudio = ["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"];
  for (const t of BAND_TYPES) {
    assert.ok(webAudio.includes(t.type), `${t.type} is not a BiquadFilterNode type`);
  }
  assert.equal(eqBands({ id: "eq", params: { bands: [] } }).length, 3,
               "an empty list falls back to the legacy shape rather than staying empty");
});

test("a FLAT eq still gets a preview chain, because its display needs one", () => {
  // What "I added an EQ and nothing happens" was: a freshly added EQ is flat,
  // so it was not `active`, so no graph was attached, so the analyser it draws
  // its spectrum from did not exist — dead display at exactly the moment
  // someone is about to shape something.
  const flat = normalizeFx([{ id: "eq", params: {} }]);
  assert.equal(activeFx(flat).length, 0, "the RENDER still skips it");
  assert.equal(previewFx(flat).length, 1, "the PREVIEW still builds it");
  assert.equal(fxSignature(flat), "eq:3");
  // ...and the nodes it builds are transparent, so it costs nothing audible.
  const nodes = tunaNodes(flat[0]);
  assert.equal(nodes.length, 3);
  assert.ok(nodes.every((n) => n.props.gain === 0 && n.props.filterType === "peaking"));
});

test("a switched-off eq gets no chain either", () => {
  const off = normalizeFx([{ id: "eq", params: { low: 6 }, enabled: false }]);
  assert.equal(previewFx(off).length, 0, "the power button still means off");
  assert.equal(fxSignature(off), "");
});

test("previewFx and activeFx agree on everything that is not an eq", () => {
  const chain = normalizeFx([
    { id: "echo", params: { mix: 0 } },              // inaudible
    { id: "compressor", params: {} },                // always does something
    { id: "tremolo", params: { depth: 0.4 } },
  ]);
  assert.deepEqual(previewFx(chain).map((f) => f.id), activeFx(chain).map((f) => f.id));
});

// The parametric EQ: the clip's live spectrum, the curve the bands make, and
// a handle per band you can drag.
//
// It is its own file because it is the only effect in the rack whose parameter
// is a LIST rather than a set of scalars — the generic knob row cannot express
// "add a band here", so this draws its own controls under the plot.
//
// Two things it does that the other displays deliberately do not:
//
//   - It runs an animation frame. Every other plot in the rack is static until
//     a knob moves, and says so; a spectrum is not. The loop runs ONLY while
//     the transport is playing and the panel is open, writes the path through
//     a ref rather than React state (the same discipline as the meter and the
//     playhead), and reuses one byte array.
//   - It reads the analyser, which is the tail of the clip's chain. So the
//     spectrum is POST-effects: it shows what the EQ is actually putting out,
//     which is what makes a cut visible as a hole rather than as a promise.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Power, Trash2 } from "lucide-react";
import {
  BAND_TYPES, EQ_FREQ_MAX, EQ_FREQ_MIN, EQ_GAIN_MAX, EQ_Q_MAX, EQ_Q_MIN, MAX_EQ_BANDS,
  bandTraits, defaultBand, eqBands, type ClipFx, type EqBand, type EqBandType,
} from "../../lib/audioFx";
import {
  bandCurve, eqCurve, fracToFreq, fracToQ, freqToFrac, qToFrac, spectrumPoints,
} from "../../lib/fxCurves";
import {
  audioSampleRate, rackAnalyser, releaseRackAnalyser, type FxTap,
} from "../../lib/audioGraph";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import Knob from "./Knob";

const W = 100;
const H = 56;
const PTS = 128;
/** A pointer that moved less than this between down and up was a CLICK, and a
 *  click on empty space adds a band. Without it every stray drag across the
 *  plot would leave one behind. */
const CLICK_SLOP = 2.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const dbToY = (db: number) => H / 2 - (clamp(db, -EQ_GAIN_MAX, EQ_GAIN_MAX) / EQ_GAIN_MAX) * (H / 2 - 2);
const yToDb = (y: number) => clamp(((H / 2 - y) / (H / 2 - 2)) * EQ_GAIN_MAX, -EQ_GAIN_MAX, EQ_GAIN_MAX);

/** **The width axis, which is ONE mapping applied both ways.** A band with no
 *  gain (a cut, a notch) puts its width on the vertical, and the handle's
 *  position and the drag that moves it used to be two hand-written formulas
 *  running OPPOSITE ways over different spans — narrow at the bottom over
 *  0..16 to draw it, narrow at the top over 0.1..8.1 to drag it. So grabbing a
 *  q=1 handle at y≈5 and moving one pixel wrote q≈7.4, teleporting it to y≈30,
 *  after which dragging down moved it up. The scale is `qToFrac`/`fracToQ`
 *  (log, tested, invertible) and all that is left here is the ORIENTATION:
 *  narrow at the top, which is the way the wheel (scroll down widens) and the
 *  arrows (up narrows) already ran. */
const qToY = (q: number) => (1 - qToFrac(q)) * H;
const yToQ = (y: number) => fracToQ(1 - y / H);
const path = (ys: number[]) =>
  ys.map((y, i) => `${i ? "L" : "M"}${((i / (ys.length - 1)) * W).toFixed(2)} ${y.toFixed(2)}`).join(" ");

const hz = (f: number) => (f >= 1000 ? `${Math.round(f / 100) / 10}k` : `${Math.round(f)}`);

export default function EqPlot({ fx, tap: rack, onInput, onCommit }: {
  fx: ClipFx;
  /** Whose rack this is — a clip's or a lane's. The spectrum is read off that
   *  rack's own analyser, and a lane has no element to hang one on. */
  tap: FxTap;
  onInput: (key: string, v: EqBand[]) => void;
  onCommit: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const specRef = useRef<SVGPathElement>(null);
  const drag = useRef<{ i: number; moved: number; x: number; y: number } | null>(null);
  const [sel, setSel] = useState(0);
  const playing = usePlaybackStore((s) => s.playing);

  const bands = useMemo(() => eqBands(fx), [fx]);
  const curve = useMemo(() => eqCurve(bands, PTS), [bands]);
  const perBand = useMemo(() => bands.map((b) => bandCurve(b, PTS)), [bands]);
  const selected = bands[sel] ?? null;

  // Every edit reads the bands from HERE, not from the render's closure.
  //
  // Two edits in one tick otherwise both start from the same array and the
  // second discards the first — measured: five wheel notches in a frame moved
  // Q from 1 to 1.11 instead of 1.69, because all five computed from 1. Wheel
  // events from a trackpad arrive faster than React re-renders, so this is the
  // common case rather than a corner. The automation lane has the same rule
  // for the same reason.
  const bandsRef = useRef(bands);
  useEffect(() => { bandsRef.current = bands; }, [bands]);
  const write = useCallback((next: EqBand[]) => {
    bandsRef.current = next;
    onInput("bands", next);
  }, [onInput]);
  const patch = useCallback((i: number, p: Partial<EqBand>) =>
    write(bandsRef.current.map((b, k) => (k === i ? { ...b, ...p } : b))), [write]);

  // ---------------------------------------------------------- the spectrum --
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let an: AnalyserNode | null = null;
    let tries = 0;
    // Backed by an explicit ArrayBuffer: `getByteFrequencyData` will not take
    // a view that might be over a SharedArrayBuffer.
    let bins: Uint8Array<ArrayBuffer> | null = null;
    // Same wait-for-it as the meter: the element and its chain are mounted by
    // the PLAYER, so a transport restart or a chain rebuild can land after
    // this effect and giving up on the first miss leaves a dead display.
    const find = () => {
      an = rackAnalyser(rack);
      if (an) { bins = new Uint8Array(new ArrayBuffer(an.frequencyBinCount)); return true; }
      return ++tries > 20;
    };
    const tick = () => {
      if (!an) {
        if (!find()) { raf = requestAnimationFrame(tick); return; }
        if (!an) return;                        // gave up: this rack has no chain
      }
      an.getByteFrequencyData(bins!);
      const sr = audioSampleRate();
      if (sr && specRef.current) {
        const ys = spectrumPoints(bins!, sr, PTS).map((v) => H - v * H);
        specRef.current.setAttribute("d", `${path(ys)} L ${W} ${H} L 0 ${H} Z`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      specRef.current?.setAttribute("d", "");
      if (an) releaseRackAnalyser(rack);
    };
  }, [rack, playing]);

  // ------------------------------------------------------------ gestures ----
  const local = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // No button down means the gesture is over and we never heard about it —
    // a pointerup delivered outside the window, a capture lost, a synthetic
    // click elsewhere. Without this the ref survives, and every later mouse
    // movement across the plot silently drags the selected band: measured, a
    // 900Hz bell that nobody touched was sitting at 476Hz.
    if (e.buttons === 0) { drag.current = null; return; }
    const p = local(e);
    d.moved += Math.abs(p.x - d.x) + Math.abs(p.y - d.y);
    d.x = p.x; d.y = p.y;
    if (d.i < 0) return;                        // a drag that began on empty space
    const b = bandsRef.current[d.i];
    if (!b) return;
    const t = bandTraits(b.type);
    const freq = Math.round(fracToFreq(Math.min(1, Math.max(0, p.x / W))));
    // Sideways is always frequency. Vertical is the gain where the shape HAS
    // one, and the width where it does not — a cut and a notch have nothing
    // else a vertical drag could mean, and leaving it inert makes the handle
    // feel broken.
    patch(d.i, t.gain
      ? { freq, gain: Math.round(yToDb(p.y) * 2) / 2 }
      : { freq, q: Math.round(yToQ(p.y) * 100) / 100 });
  };

  const down = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Focus the plot, so Delete means "this band" rather than falling through
    // to the editor's global map — where it means "this CLIP", and deleted the
    // whole block off the timeline.
    wrapRef.current?.focus();
    if (i >= 0) setSel(i);
    // Alt-click removes, the way it removes an automation point on the lane.
    // Never the last one: an EQ with no bands falls back to the legacy shape
    // rather than staying empty, so it would silently reappear as three.
    if (i >= 0 && (e.altKey || e.metaKey) && bandsRef.current.length > 1) {
      write(bandsRef.current.filter((_, k) => k !== i));
      setSel(0); onCommit();
      return;
    }
    // Capture can refuse a pointer id the browser does not consider active;
    // it must not take the gesture down with it.
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* no capture */ }
    const p = local(e);
    drag.current = { i, moved: 0, x: p.x, y: p.y };
  };

  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    // A click on empty space ADDS a band there, typed by where it landed: a
    // high-pass at the left edge, a low-pass at the right, a bell in between.
    if (d.i < 0 && d.moved < CLICK_SLOP && bandsRef.current.length < MAX_EQ_BANDS) {
      const freq = Math.round(fracToFreq(Math.min(1, Math.max(0, d.x / W))));
      const band = defaultBand(freq, Math.round(yToDb(d.y) * 2) / 2);
      const next = [...bandsRef.current, band].sort((a, b) => a.freq - b.freq);
      write(next);
      setSel(next.indexOf(band));
      onCommit();
      return;
    }
    if (d.moved >= CLICK_SLOP) onCommit();
  };

  /** The plot's own keys. Every one it acts on stops propagating: the editor's
   *  global map is listening on `window`, and without this Delete reached it
   *  and removed the timeline clip, while the arrows moved the playhead. */
  const keys = (e: React.KeyboardEvent) => {
    const b = bandsRef.current[sel];
    if (!b) return;
    const traits = bandTraits(b.type);
    const step = e.shiftKey ? 5 : 1;
    switch (e.key) {
      case "Delete":
      case "Backspace":
        if (bandsRef.current.length < 2) return;   // never the last one
        e.preventDefault(); e.stopPropagation();
        write(bandsRef.current.filter((_, k) => k !== sel));
        setSel(0); onCommit();
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault(); e.stopPropagation();
        // A semitone-ish nudge in RATIO, so it feels the same at 40Hz and 15k.
        const mul = Math.pow(2, (e.key === "ArrowRight" ? 1 : -1) * step / 12);
        patch(sel, { freq: Math.round(Math.min(EQ_FREQ_MAX, Math.max(EQ_FREQ_MIN, b.freq * mul))) });
        onCommit();
        return;
      }
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault(); e.stopPropagation();
        const dir = e.key === "ArrowUp" ? 1 : -1;
        patch(sel, traits.gain
          ? { gain: Math.min(EQ_GAIN_MAX, Math.max(-EQ_GAIN_MAX, b.gain + dir * 0.5 * step)) }
          : { q: Math.round(clamp(b.q * Math.pow(1.1, dir * step), EQ_Q_MIN, EQ_Q_MAX) * 100) / 100 });
        onCommit();
        return;
      }
      case "Tab":
        // Step through the bands rather than out of the plot — shift walks back.
        if (bandsRef.current.length < 2) return;
        e.preventDefault(); e.stopPropagation();
        setSel((sel + (e.shiftKey ? -1 : 1) + bandsRef.current.length) % bandsRef.current.length);
        return;
      default:
    }
  };

  // The width gesture, on the plot rather than only on a knob — it is the one
  // parameter you want while looking at the curve.
  const wheel = (e: React.WheelEvent) => {
    const b = bandsRef.current[sel];
    if (!b || !bandTraits(b.type).q) return;
    e.preventDefault();
    const q = clamp(b.q * (e.deltaY > 0 ? 0.9 : 1 / 0.9), EQ_Q_MIN, EQ_Q_MAX);
    patch(sel, { q: Math.round(q * 100) / 100 });
    onCommit();
  };

  const setType = (t: EqBandType) => {
    const traits = bandTraits(t);
    patch(sel, { type: t, gain: traits.gain ? (bandsRef.current[sel]?.gain ?? 0) : 0 });
    onCommit();
  };

  const addBand = () => {
    if (bandsRef.current.length >= MAX_EQ_BANDS) return;
    const band = defaultBand(1000, 0);
    const next = [...bandsRef.current, band].sort((a, b) => a.freq - b.freq);
    write(next); setSel(next.indexOf(band)); onCommit();
  };

  const filled = `${path(curve.map(dbToY))} L ${W} ${H / 2} L 0 ${H / 2} Z`;

  return (
    <div className="ws-eq">
      <div ref={wrapRef} className="ws-fxgwrap ws-eqwrap"
           tabIndex={0} data-keys="own" role="group"
           aria-label="EQ curve — click to add a band, drag to move, Delete to remove"
           onPointerMove={move} onPointerUp={up} onPointerLeave={up} onPointerCancel={up}
           onPointerDown={down(-1)} onWheel={wheel} onKeyDown={keys}>
        <svg className="ws-fxg eq" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <g className="grid">
            <line className="zero" x1={0} y1={H / 2} x2={W} y2={H / 2} />
            {[50, 100, 500, 1000, 5000, 10000].map((f) => (
              <line key={f} x1={freqToFrac(f) * W} y1={0} x2={freqToFrac(f) * W} y2={H} />
            ))}
            {[-12, -6, 6, 12].map((d) => (
              <line key={d} className="db" x1={0} y1={dbToY(d)} x2={W} y2={dbToY(d)} />
            ))}
          </g>
          {/* live spectrum, written by the animation frame above */}
          <path ref={specRef} className="spec" d="" />
          <path className="fill" d={filled} />
          {perBand.map((c, i) => (
            <path key={i} className={"band" + (i === sel ? " sel" : "")} d={path(c.map(dbToY))}
                  vectorEffect="non-scaling-stroke" />
          ))}
          <path className="curve" d={path(curve.map(dbToY))} vectorEffect="non-scaling-stroke" />
          {[100, 1000, 10000].map((f) => (
            <text key={f} className="ax" x={freqToFrac(f) * W + 0.8} y={H - 1.2}>{hz(f)}</text>
          ))}
        </svg>
        {/* HTML handles, not SVG circles: the plot stretches to the panel width
            with preserveAspectRatio="none", which turns a circle into an
            ellipse. Percent positions keep them round. */}
        {bands.map((b, i) => (
          <i key={i}
             className={"ws-eqh" + (i === sel ? " sel" : "") + (b.on === false ? " off" : "")}
             data-band={i}
             style={{
               left: `${freqToFrac(b.freq) * 100}%`,
               top: `${((bandTraits(b.type).gain ? dbToY(b.gain) : qToY(b.q)) / H) * 100}%`,
             }}
             title={`${bandTraits(b.type).label} ${hz(b.freq)}Hz — drag, wheel for width, alt-click to remove`}
             onPointerDown={down(i)} />
        ))}
      </div>

      <div className="ws-eqbar">
        <div className="ws-seg tiny">
          {BAND_TYPES.map((t) => (
            <button key={t.type} className={selected?.type === t.type ? "on" : ""}
                    disabled={!selected} title={t.type}
                    onClick={() => setType(t.type)}>{t.label}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button className="ws-eqbtn" onClick={addBand} disabled={bands.length >= MAX_EQ_BANDS}
                title={bands.length >= MAX_EQ_BANDS ? `${MAX_EQ_BANDS} bands is the ceiling`
                                                    : "Add a band (or click the curve)"}>
          <Plus size={11} />
        </button>
        <button className="ws-eqbtn" disabled={!selected} title="Bypass this band"
                onClick={() => { patch(sel, { on: bandsRef.current[sel]?.on === false }); onCommit(); }}>
          <Power size={11} className={selected?.on === false ? "" : "lit"} />
        </button>
        <button className="ws-eqbtn" disabled={bands.length < 2} title="Remove this band"
                onClick={() => { write(bandsRef.current.filter((_, k) => k !== sel)); setSel(0); onCommit(); }}>
          <Trash2 size={11} />
        </button>
      </div>

      {selected && (
        <div className="ws-knobs">
          <Knob label="Freq" value={selected.freq} min={EQ_FREQ_MIN} max={EQ_FREQ_MAX} step={1}
                defaultValue={1000} log
                format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : `${Math.round(v)}`)}
                onInput={(v) => patch(sel, { freq: Math.round(v) })} onCommit={onCommit} />
          {bandTraits(selected.type).gain && (
            <Knob label="Gain" value={selected.gain} min={-EQ_GAIN_MAX} max={EQ_GAIN_MAX} step={0.5}
                  defaultValue={0} bipolar
                  format={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}`}
                  onInput={(v) => patch(sel, { gain: v })} onCommit={onCommit} />
          )}
          {bandTraits(selected.type).q && (
            <Knob label="Q" value={selected.q} min={EQ_Q_MIN} max={EQ_Q_MAX} step={0.1} defaultValue={1} log
                  format={(v) => `${Math.round(v * 100) / 100}`}
                  onInput={(v) => patch(sel, { q: Math.round(v * 100) / 100 })} onCommit={onCommit} />
          )}
          <span className="ws-eqnote">
            {bandTraits(selected.type).q
              ? "drag · wheel for width · arrows nudge · del removes"
              : /* A shelf has no width control, and that is a parity constraint
                   rather than an omission — Web Audio's shelving filters ignore
                   Q entirely, so a knob here could only ever move the render. */
                "shelf slope is fixed — Web Audio has no Q for it"}
          </span>
        </div>
      )}
    </div>
  );
}

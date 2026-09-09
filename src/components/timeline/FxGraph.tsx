// The display above each effect's knobs: the response it is actually
// producing, drawn from the same filter coefficients the engines use
// (src/lib/fxCurves.ts), and draggable where dragging is the natural way to
// say what you want.
//
// One SVG per effect, re-rendered only when its parameters change. No canvas,
// no animation frame — a filter curve is a static thing until someone moves a
// knob, and 96 sampled points is a path short enough that React re-rendering
// it during a drag costs nothing measurable.
import React, { useMemo, useRef } from "react";
import {
  EQ_BANDS, F_MAX, F_MIN, clipPeaks, compressorCurve, echoTaps, fracToFreq, freqToFrac,
  lfoPoints, panDisplay, phaserCurve, responseCurve, reverbImpulse, shaperCurve,
} from "../../lib/fxCurves";
import EqPlot from "./EqPlot";
import type { ClipFx, EqBand } from "../../lib/audioFx";
import type { FxTap } from "../../lib/audioGraph";

const W = 100;   // viewBox units; the SVG stretches to the panel's width
const H = 46;
/** The response plot spans +/- this. Matched to the EQ's own parameter
 *  range, so a band pushed to its limit touches the top of the box and
 *  everything short of that has room to read. */
const DB_RANGE = 18;

const num = (fx: ClipFx, k: string) => Number(fx.params[k]) || 0;
const dbToY = (db: number) => H / 2 - (Math.max(-DB_RANGE, Math.min(DB_RANGE, db)) / DB_RANGE) * (H / 2 - 3);
const yToDb = (y: number) => ((H / 2 - y) / (H / 2 - 3)) * DB_RANGE;

/** The 0dB line plus a couple of decade marks, so the curve has a scale. */
function Grid({ freqs = true }: { freqs?: boolean }) {
  return (
    <g className="grid">
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} className="zero" />
      {freqs && [100, 1000, 10000].map((f) => (
        <line key={f} x1={freqToFrac(f) * W} y1={0} x2={freqToFrac(f) * W} y2={H} />
      ))}
      {!freqs && [0.25, 0.5, 0.75].map((t) => (
        <line key={t} x1={t * W} y1={0} x2={t * W} y2={H} />
      ))}
    </g>
  );
}

const pathOf = (pts: { x: number; y: number }[]) =>
  pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

/** A frequency-response plot with a draggable handle per band.
 *
 *  Dragging a handle vertically is the gain, horizontally is nothing — our EQ
 *  bands sit at fixed frequencies in BOTH engines, so a handle that slid
 *  sideways would be promising a filter the render cannot make. The filter
 *  effect below is the opposite case: its frequency is a real parameter, so
 *  there the handle moves in x. */
function ResponsePlot({ fx, onInput, onCommit }: {
  fx: ClipFx; onInput: (key: string, v: number | EqBand[]) => void; onCommit: () => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<string | null>(null);
  const curve = useMemo(() => responseCurve(fx), [fx]);
  const isEq = fx.id === "eq";

  const pts = curve.map((db, i) => ({ x: (i / (curve.length - 1)) * W, y: dbToY(db) }));
  const filled = `${pathOf(pts)} L ${W} ${H / 2} L 0 ${H / 2} Z`;

  const local = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = local(e);
    if (isEq) {
      onInput(drag.current, Math.round(yToDb(p.y) * 2) / 2);
    } else {
      onInput("freq", Math.round(fracToFreq(Math.min(1, Math.max(0, p.x / W)))));
      // vertical is resonance: up is a sharper, more resonant corner
      onInput("q", Math.round(Math.min(10, Math.max(0.1, (1 - p.y / H) * 12)) * 10) / 10);
    }
  };
  const grab = (key: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = key;
    move(e);
  };
  const release = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    onCommit();
  };

  const handles = isEq
    ? EQ_BANDS.map((b) => ({ key: b.key, x: freqToFrac(b.freq) * W, y: dbToY(num(fx, b.key)), label: b.key }))
    : [{
        key: "freq",
        x: freqToFrac(num(fx, "freq")) * W,
        y: H - (Math.min(10, num(fx, "q")) / 12) * H,
        label: fx.params.mode === "lowpass" ? "LP" : "HP",
      }];

  // The handles are HTML, not SVG circles: the plot stretches to the panel's
  // width with `preserveAspectRatio="none"`, which turns any circle in the
  // viewBox into an ellipse. Strokes survive that (non-scaling-stroke); shapes
  // do not. Positioning them in percent over the box keeps them round.
  return (
    <div className="ws-fxgwrap" onPointerMove={move} onPointerUp={release} onPointerLeave={release}>
      <svg ref={ref} className="ws-fxg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <Grid />
        <path className="fill" d={filled} />
        <path className="curve" d={pathOf(pts)} vectorEffect="non-scaling-stroke" />
        <text className="ax" x={1} y={H - 1.5}>{F_MIN}</text>
        <text className="ax" x={W - 1} y={H - 1.5} textAnchor="end">{F_MAX / 1000}k</text>
      </svg>
      {handles.map((h) => (
        <i key={h.key} className="ws-fxh" style={{ left: `${h.x}%`, top: `${(h.y / H) * 100}%` }}
           title={h.label} onPointerDown={grab(h.key)} />
      ))}
    </div>
  );
}

/** Input dB against output dB, with the threshold draggable along the curve —
 *  the display every compressor has, for the reason every compressor has it:
 *  the ratio is a slope you can see. */
function CompressorPlot({ fx, onInput, onCommit }: {
  fx: ClipFx; onInput: (key: string, v: number | EqBand[]) => void; onCommit: () => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const MIN = -60;
  const toX = (db: number) => ((db - MIN) / -MIN) * W;
  const toY = (db: number) => H - ((Math.max(MIN, db) - MIN) / -MIN) * H;
  const curve = useMemo(() => compressorCurve(fx, 64, MIN), [fx]);
  const th = num(fx, "threshold");

  const move = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const r = ref.current!.getBoundingClientRect();
    const db = MIN + ((e.clientX - r.left) / r.width) * -MIN;
    onInput("threshold", Math.round(Math.min(0, Math.max(MIN, db))));
  };

  const dotY = toY(curve.find((p) => p.x >= th)?.y ?? th);
  return (
    <div className="ws-fxgwrap"
         onPointerDown={(e) => { dragging.current = true; move(e); }}
         onPointerMove={move}
         onPointerUp={() => { if (dragging.current) { dragging.current = false; onCommit(); } }}
         onPointerLeave={() => { if (dragging.current) { dragging.current = false; onCommit(); } }}>
      <svg ref={ref} className="ws-fxg comp" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <g className="grid">
          <line x1={0} y1={H} x2={W} y2={0} className="unity" />
          {[-40, -20].map((d) => <line key={d} x1={toX(d)} y1={0} x2={toX(d)} y2={H} />)}
        </g>
        <line className="thresh" x1={toX(th)} y1={0} x2={toX(th)} y2={H} />
        <path className="curve" vectorEffect="non-scaling-stroke"
              d={pathOf(curve.map((p) => ({ x: toX(p.x), y: toY(p.y) })))} />
        <text className="ax" x={1} y={H - 1.5}>-60</text>
        <text className="ax" x={W - 1} y={H - 1.5} textAnchor="end">0dB</text>
      </svg>
      <i className="ws-fxh amber" title="Threshold — drag"
         style={{ left: `${toX(th)}%`, top: `${(dotY / H) * 100}%` }} />
    </div>
  );
}

/** The repeats, on a time axis: dry hit, then each tap at its own level. */
function EchoPlot({ fx }: { fx: ClipFx }) {
  const WINDOW = 2000;
  const taps = useMemo(() => echoTaps(fx, WINDOW), [fx]);
  return (
    <svg className="ws-fxg echo" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <Grid freqs={false} />
      {taps.map((t, i) => (
        <line key={i} className={i ? "tap" : "tap dry"}
              x1={(t.t / WINDOW) * W} y1={H / 2 - (t.level * (H / 2 - 3))}
              x2={(t.t / WINDOW) * W} y2={H / 2 + (t.level * (H / 2 - 3))}
              vectorEffect="non-scaling-stroke" />
      ))}
      <text className="ax" x={W - 1} y={H - 1.5} textAnchor="end">{WINDOW / 1000}s</text>
    </svg>
  );
}

/** The modulator itself — rate as cycles across the window, depth as height. */
function LfoPlot({ fx }: { fx: ClipFx }) {
  const pts = useMemo(
    () => lfoPoints(num(fx, "rate"), num(fx, "depth")).map((p) => ({ x: p.x * W, y: p.y * H })),
    [fx]);
  return (
    <svg className="ws-fxg lfo" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <Grid freqs={false} />
      <path className="curve" d={pathOf(pts)} vectorEffect="non-scaling-stroke" />
      <text className="ax" x={W - 1} y={H - 1.5} textAnchor="end">2s</text>
    </svg>
  );
}

/** The transfer curve: what comes out for what goes in, drive and output gain
 *  included. Display-only — a shaper has no handle that means anything on
 *  these axes (the input side is the signal's, not a parameter's), so the
 *  gesture is the Drive knob, exactly as it is on a real one. The dotted
 *  diagonal is unity: how far the curve bends off it IS the distortion. */
function ShaperPlot({ fx }: { fx: ClipFx }) {
  const pts = useMemo(() => shaperCurve(fx), [fx]);
  const toX = (x: number) => ((x + 1) / 2) * W;
  const toY = (y: number) => H / 2 - (y / 1.4) * (H / 2);
  const path = pathOf(pts.map((p) => ({ x: toX(p.x), y: toY(p.y) })));
  // Where the curve has given up more than a dB of slope — the part of the
  // signal's range that is being squashed rather than passed.
  const clipped = pts.filter((p) => Math.abs(p.y) > 0.98).length / pts.length;
  return (
    <svg className="ws-fxg shaper" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <g className="grid">
        <line className="unity" x1={toX(-1)} y1={toY(-1)} x2={toX(1)} y2={toY(1)} />
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} />
        <line x1={W / 2} y1={0} x2={W / 2} y2={H} />
      </g>
      <line className="ceil" x1={0} y1={toY(1)} x2={W} y2={toY(1)} />
      <line className="ceil" x1={0} y1={toY(-1)} x2={W} y2={toY(-1)} />
      <path className="curve" d={path} vectorEffect="non-scaling-stroke" />
      <text className="ax" x={1} y={H - 1.5}>in</text>
      {clipped > 0.02 && (
        <text className="ax hot" x={W - 1} y={5} textAnchor="end">
          {Math.round(clipped * 100)}% clipped
        </text>
      )}
    </svg>
  );
}

/** The room, as an impulse response: the dry hit, every reflection at its own
 *  level, and the -60dB envelope they sit on. These are the SAME taps the
 *  render feeds `aecho` and the preview convolves with, so counting the sticks
 *  is counting the reflections you hear. */
function ReverbPlot({ fx }: { fx: ClipFx }) {
  const { taps, windowMs, envelope } = useMemo(() => reverbImpulse(fx), [fx]);
  const toX = (ms: number) => Math.min(W, (ms / windowMs) * W);
  const top = H - 3;
  const env = Array.from({ length: 48 }, (_, i) => {
    const ms = (i / 47) * windowMs;
    return { x: toX(ms), y: H - Math.max(0.4, envelope(ms) * top) };
  });
  return (
    <svg className="ws-fxg rev" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <Grid freqs={false} />
      <path className="env" d={pathOf(env)} vectorEffect="non-scaling-stroke" />
      <line className="tap dry" x1={0.4} y1={H} x2={0.4} y2={H - top} vectorEffect="non-scaling-stroke" />
      {taps.map((t, i) => (
        <line key={i} className="tap" x1={toX(t.ms)} y1={H}
              x2={toX(t.ms)} y2={H - Math.max(0.5, t.gain * top)} vectorEffect="non-scaling-stroke" />
      ))}
      <text className="ax" x={W - 1} y={H - 1.5} textAnchor="end">{windowMs / 1000}s</text>
      <text className="ax" x={1} y={5}>{taps.length} refl</text>
    </svg>
  );
}

/** The notch family, drawn where the sweep actually puts it.
 *
 *  Five positions of the LFO at once rather than an animation: the shape a
 *  phaser makes is a moving comb, and a still frame of one position says
 *  nothing about depth. The current-centre curve is drawn solid over the
 *  ghosts, so Feedback (which deepens the notch) and Depth (which widens the
 *  travel) are separately visible. */
function PhaserPlot({ fx }: { fx: ClipFx }) {
  const curves = useMemo(
    () => [0, 0.25, 0.5, 0.75, 1].map((pos) => phaserCurve(fx, pos)), [fx]);
  const toPts = (c: number[]) =>
    c.map((db, i) => ({ x: (i / (c.length - 1)) * W, y: H / 2 - (db / 24) * (H / 2 - 2) }));
  return (
    <svg className="ws-fxg phase" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <Grid />
      {curves.map((c, i) => (
        i === 2 ? null
          : <path key={i} className="ghost" d={pathOf(toPts(c))} vectorEffect="non-scaling-stroke" />
      ))}
      <path className="curve" d={pathOf(toPts(curves[2]))} vectorEffect="non-scaling-stroke" />
      <text className="ax" x={1} y={H - 1.5}>{F_MIN}</text>
      <text className="ax" x={W - 1} y={H - 1.5} textAnchor="end">{F_MAX / 1000}k</text>
    </svg>
  );
}

/** A pan pot: the position on an arc, and what each channel is left carrying.
 *
 *  Draggable horizontally, which is the whole gesture. The +6dB the left bar
 *  reaches at hard left is not a drawing error — the stereo law folds the
 *  right channel in rather than discarding it, and the render does the same. */
function PanPlot({ fx, onInput, onCommit }: {
  fx: ClipFx; onInput: (key: string, v: number | EqBand[]) => void; onCommit: () => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const d = panDisplay(num(fx, "pan"));
  const R = 30, CX = W / 2, CY = H - 6;
  const SWEEP = 1.082;            // ±62°, the throw of a real pan pot
  const px = CX + Math.sin(d.pos * SWEEP) * R;
  const py = CY - Math.cos(d.pos * SWEEP) * R;
  const bar = (db: number) => Math.max(0, Math.min(1, (db + 30) / 36));

  const move = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const r = ref.current!.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * 2 - 1;
    onInput("pan", Math.round(Math.min(1, Math.max(-1, t)) * 50) / 50);
  };
  const stop = () => { if (dragging.current) { dragging.current = false; onCommit(); } };
  return (
    <div className="ws-fxgwrap"
         onPointerDown={(e) => { dragging.current = true; move(e); }}
         onPointerMove={move} onPointerUp={stop} onPointerLeave={stop}>
      <svg ref={ref} className="ws-fxg pan" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <path className="arc" vectorEffect="non-scaling-stroke"
              d={`M${CX - Math.sin(SWEEP) * R} ${CY - Math.cos(SWEEP) * R}`
                 + ` A ${R} ${R} 0 0 1 ${CX + Math.sin(SWEEP) * R} ${CY - Math.cos(SWEEP) * R}`} />
        <line className="centre" x1={CX} y1={CY - R - 3} x2={CX} y2={CY - R + 3}
              vectorEffect="non-scaling-stroke" />
        <line className="needle" x1={CX} y1={CY} x2={px} y2={py} vectorEffect="non-scaling-stroke" />
        <rect className="lvl l" x={4} y={H - 5} width={bar(d.lDb) * (W / 2 - 8)} height={3} />
        <rect className="lvl r" x={W / 2 + 4} y={H - 5} width={bar(d.rDb) * (W / 2 - 8)} height={3} />
        <text className="ax" x={1} y={7}>L</text>
        <text className="ax" x={W - 1} y={7} textAnchor="end">R</text>
      </svg>
      <i className="ws-fxh amber" title="Pan — drag"
         style={{ left: `${(px / W) * 100}%`, top: `${(py / H) * 100}%` }} />
    </div>
  );
}

export default function FxGraph({ fx, tap, onInput, onCommit }: {
  fx: ClipFx;
  /** Which clip's audio to read the spectrum off. Only the EQ needs it. */
  /** Whose rack this is — see EqPlot, the one graph that reads live audio. */
  tap: FxTap;
  onInput: (key: string, v: number | EqBand[]) => void;
  onCommit: () => void;
}) {
  // The EQ draws its own controls as well as its plot — its parameter is a
  // LIST of bands, which a row of knobs cannot express.
  if (fx.id === "eq") {
    return <EqPlot fx={fx} tap={tap}
                   onInput={(k, v) => onInput(k, v)} onCommit={onCommit} />;
  }
  if (fx.id === "filter") {
    return <ResponsePlot fx={fx} onInput={onInput} onCommit={onCommit} />;
  }
  if (fx.id === "compressor") return <CompressorPlot fx={fx} onInput={onInput} onCommit={onCommit} />;
  if (fx.id === "pan") return <PanPlot fx={fx} onInput={onInput} onCommit={onCommit} />;
  if (fx.id === "echo") return <EchoPlot fx={fx} />;
  if (fx.id === "overdrive") return <ShaperPlot fx={fx} />;
  if (fx.id === "reverb") return <ReverbPlot fx={fx} />;
  if (fx.id === "phaser") return <PhaserPlot fx={fx} />;
  return <LfoPlot fx={fx} />;
}

/** The clip's own waveform — the window it actually plays, not the whole file.
 *  Drawn once per clip; `peaks` comes from the asset row the ingest wrote. */
export function ClipWave({ peaks, inMs, outMs, durationMs, playhead }: {
  peaks: number[]; inMs: number; outMs: number | null; durationMs: number | null;
  /** 0..1 through the clip, or null when the playhead is elsewhere */
  playhead?: number | null;
}) {
  const bars = useMemo(() => clipPeaks(peaks, inMs, outMs, durationMs, 120),
                       [peaks, inMs, outMs, durationMs]);
  if (!bars.length) return null;
  return (
    <svg className="ws-fxwave" viewBox="0 0 120 24" preserveAspectRatio="none">
      <path d={bars.map((p, i) => `M${i} ${12 - Math.max(0.6, p * 11)}V${12 + Math.max(0.6, p * 11)}`).join("")}
            vectorEffect="non-scaling-stroke" />
      {playhead != null && playhead >= 0 && playhead <= 1 && (
        <line className="ph" x1={playhead * 120} y1={0} x2={playhead * 120} y2={24}
              vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

// A rotary knob, behaving the way a plugin's does.
//
// Drag UP/RIGHT to increase; hold shift for fine. Double-click returns it to
// the catalog default. Arrow keys step, page keys jump, home/end go to the
// ends — it is a real `role="slider"`, so it is reachable without a mouse.
//
// The drag is deliberately RELATIVE, not "jump to where I clicked": a knob
// has no linear track for an absolute position to mean anything on, and every
// DAW resolves that the same way. Pointer capture keeps the gesture alive
// outside the 34px circle it started in.
//
// It reports `onInput` continuously and `onCommit` once on release — the same
// contract the panel uses to keep one undo entry per gesture.
import React, { useRef } from "react";

/** Full sweep, in degrees, centred on straight up: the classic 270° knob with
 *  a 45° dead zone at the bottom so the ends are visually distinct. */
const SWEEP = 270;
const R = 15;
const CX = 18;
const CY = 18;

/** Pixels of drag for the whole range. A knob that crosses its range in 40px
 *  is unusable for a 40Hz-18kHz sweep; 220 is about a hand's travel. */
const TRAVEL_PX = 220;

const polar = (deg: number, radius: number) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
};

/** SVG arc path from `a` to `b` degrees at `radius`. */
function arc(a: number, b: number, radius: number) {
  const s = polar(a, radius);
  const e = polar(b, radius);
  const large = Math.abs(b - a) > 180 ? 1 : 0;
  const sweep = b > a ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${radius} ${radius} 0 ${large} ${sweep} ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

export default function Knob({
  label, value, min, max, step = 0.1, unit, defaultValue, format, bipolar = false, log = false,
  onInput, onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  defaultValue: number;
  /** how the number reads under the knob (Hz -> kHz, ratios, …) */
  format?: (v: number) => string;
  /** fill from the centre rather than from the left end — what a dB knob wants */
  bipolar?: boolean;
  /** Travel in RATIO rather than in units, which is what frequency wants: on a
   *  linear 20Hz–20kHz knob everything below 2kHz is the first tenth of the
   *  sweep, i.e. the whole of a voice lives in a few pixels. Requires min > 0.
   *  Never combined with `bipolar` — a log range cannot straddle zero. */
  log?: boolean;
  onInput: (v: number) => void;
  onCommit: () => void;
}) {
  const drag = useRef<{ y: number; x: number; from: number } | null>(null);

  const span = max - min;
  const useLog = log && min > 0 && max > min;
  const ratio = useLog ? Math.log(max / min) : 1;
  /** value -> 0..1 along the sweep, and back. The only difference a log knob
   *  makes, so every gesture below goes through this pair rather than through
   *  the raw range. */
  const toPos = (v: number) =>
    Math.min(1, Math.max(0, useLog ? Math.log(Math.max(min, v) / min) / ratio : (v - min) / span));
  const fromPos = (p: number) => {
    const t = Math.min(1, Math.max(0, p));
    return useLog ? min * Math.exp(t * ratio) : min + t * span;
  };

  const frac = toPos(value);
  const a0 = -SWEEP / 2;
  const a1 = SWEEP / 2;
  const angle = a0 + frac * SWEEP;
  const zero = bipolar && !useLog ? a0 + ((0 - min) / span) * SWEEP : a0;

  const quantise = (v: number) => {
    const snapped = Math.round(v / step) * step;
    // step can be fractional (0.05), and floating point turns 0.35 into
    // 0.35000000000000003 — which then renders as that, on a knob.
    const decimals = (String(step).split(".")[1] ?? "").length;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(decimals))));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, x: e.clientX, from: value };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // vertical is the primary axis; horizontal helps on a trackpad
    const px = (d.y - e.clientY) + (e.clientX - d.x) * 0.35;
    const scale = e.shiftKey ? 0.2 : 1;             // fine drag
    onInput(quantise(fromPos(toPos(d.from) + (px / TRAVEL_PX) * scale)));
  };
  const end = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    onCommit();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // A key this knob acts on must not ALSO reach the editor's global map —
    // preventDefault does not stop propagation, so an arrow here was moving
    // the playhead as well, and Delete on a focused knob deleted the clip.
    const mine = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                  "PageUp", "PageDown", "Home", "End"];
    if (mine.includes(e.key)) e.stopPropagation();
    // A log knob steps along the SWEEP, not along the units: one arrow press
    // near 40Hz and one near 15kHz should feel like the same nudge.
    const small = useLog ? 0.01 : step;
    const big = useLog ? 0.1 : span / 10;
    const map: Record<string, number> = {
      ArrowUp: small, ArrowRight: small, ArrowDown: -small, ArrowLeft: -small,
      PageUp: big, PageDown: -big,
    };
    if (e.key in map) {
      e.preventDefault();
      const by = map[e.key] * (e.shiftKey ? 5 : 1);
      onInput(quantise(useLog ? fromPos(toPos(value) + by) : value + by));
      onCommit();
    } else if (e.key === "Home") {
      e.preventDefault(); onInput(min); onCommit();
    } else if (e.key === "End") {
      e.preventDefault(); onInput(max); onCommit();
    }
  };

  const text = format ? format(value) : `${Math.round(value * 100) / 100}${unit ?? ""}`;
  const tip = polar(angle, R - 3.5);
  const hub = polar(angle, 5.5);

  return (
    <div className="ws-knob" title={`${label} — drag to set, shift for fine, double-click to reset`}>
      <svg viewBox="0 0 36 36" role="slider" tabIndex={0} data-keys="own"
           aria-label={label} aria-valuemin={min} aria-valuemax={max}
           aria-valuenow={value} aria-valuetext={text}
           onPointerDown={onPointerDown} onPointerMove={onPointerMove}
           onPointerUp={end} onPointerCancel={end} onKeyDown={onKeyDown}
           onDoubleClick={() => { onInput(defaultValue); onCommit(); }}>
        <path className="track" d={arc(a0, a1, R)} />
        {/* the travelled arc reads from the centre on a bipolar control, so a
            cut and a boost of the same size look like opposites */}
        <path className={"fill" + (bipolar && value < 0 ? " neg" : "")}
              d={arc(Math.min(zero, angle), Math.max(zero, angle), R)}
              style={{ opacity: Math.abs(angle - zero) < 0.5 ? 0 : 1 }} />
        <circle className="hub" cx={CX} cy={CY} r={10.5} />
        <line className="ptr" x1={hub.x} y1={hub.y} x2={tip.x} y2={tip.y} />
      </svg>
      <span className="lbl">{label}</span>
      <span className="val mono">{text}</span>
    </div>
  );
}

// Camera picker (design: 1060px, full height) — shot size / angle / movement
// (animated schematics: the marker traces the move it names) / lens & feel.
// Diagrams are 68×44 SVG in three colours: camera #5aa2ff, subject #ffb454,
// structure #3d4658. Positioning and animation live on separate <g>s — a CSS
// transform overrides SVG's transform attribute, so animating the placed
// element would throw the marker to the origin.
// The compound choice compiles to the prose fragment stored on beat.camera
// (the H3 compiler turns it into official camera grammar downstream).
import React, { useMemo, useState } from "react";
import { Camera, Check, Sparkles } from "lucide-react";
import ModalShell from "./ModalShell";

const CAM = "#5aa2ff", SUBJ = "#ffb454", STRUCT = "#3d4658";

/** Camera marker: outer group positions/rotates, inner group animates. */
function Marker({ x, y, rot = 0, anim, animStyle }: {
  x: number; y: number; rot?: number; anim?: string; animStyle?: React.CSSProperties;
}) {
  const body = (
    <g transform={`rotate(${rot})`}>
      <path d="M0 -5.5 L7.5 4 L-7.5 4 Z" fill={CAM} opacity=".22" />
      <rect x="-3.4" y="-3.4" width="6.8" height="6.8" rx="1.6" fill={CAM} />
    </g>
  );
  return (
    <g transform={`translate(${x} ${y})`}>
      {anim ? <g className="ns-cam-anim" style={{ animationName: anim, ...animStyle }}>{body}</g> : body}
    </g>
  );
}
const Subject = ({ x = 34, y = 13 }: { x?: number; y?: number }) => (
  <>
    <circle cx={x} cy={y} r="3.4" fill={SUBJ} />
    <circle cx={x} cy={y} r="7" fill="none" stroke={SUBJ} strokeWidth="1" opacity=".28" />
  </>
);
const Standing = ({ x = 46, y = 12 }: { x?: number; y?: number }) => (
  <>
    <rect x={x - 2} y={y + 3} width="4" height="26" rx="2" fill={SUBJ} opacity=".7" />
    <circle cx={x} cy={y} r="4" fill={SUBJ} />
  </>
);
const Frame = () => <rect x="4.5" y="4.5" width="59" height="35" rx="3.5" fill="none" stroke={STRUCT} strokeWidth="1" />;
const Sight = (p: { x1: number; y1: number; x2: number; y2: number }) => (
  <line {...p} stroke={CAM} strokeWidth="1" opacity=".45" className="ns-cam-path" />
);

interface Tile { id: string; label: string; note: string; svg: React.ReactNode }

const SIZES: Tile[] = [
  { id: "wide", label: "Wide", note: "establishes geography", svg: <><Frame /><circle cx="34" cy="14" r="2.6" fill={SUBJ} opacity=".9" /><rect x="31" y="17.6" width="6" height="12" rx="2.6" fill={SUBJ} opacity=".55" /></> },
  { id: "medium", label: "Medium", note: "the working default", svg: <><Frame /><circle cx="34" cy="15" r="4.6" fill={SUBJ} opacity=".9" /><rect x="28.7" y="20.6" width="10.6" height="18" rx="4.6" fill={SUBJ} opacity=".55" /></> },
  { id: "close-up", label: "Close-up", note: "eyes carry it", svg: <><Frame /><circle cx="34" cy="18" r="9" fill={SUBJ} opacity=".9" /><rect x="23.65" y="28" width="20.7" height="22" rx="9" fill={SUBJ} opacity=".55" /></> },
  { id: "extreme close-up", label: "Extreme close", note: "one detail only", svg: <><Frame /><circle cx="34" cy="26" r="17" fill={SUBJ} opacity=".85" /><circle cx="34" cy="20" r="4" fill="#0b0e14" opacity=".7" /></> },
  { id: "two-shot", label: "Two-shot", note: "relationship in one frame", svg: <><Frame /><circle cx="24" cy="17" r="5" fill={SUBJ} opacity=".9" /><rect x="18.5" y="23" width="11" height="16" rx="5" fill={SUBJ} opacity=".5" /><circle cx="45" cy="17" r="5" fill={SUBJ} opacity=".9" /><rect x="39.5" y="23" width="11" height="16" rx="5" fill={SUBJ} opacity=".5" /></> },
  { id: "over-the-shoulder", label: "Over-shoulder", note: "their view of them", svg: <><Frame /><circle cx="18" cy="20" r="8" fill={STRUCT} /><rect x="6" y="29" width="24" height="12" rx="6" fill={STRUCT} /><circle cx="45" cy="18" r="5.5" fill={SUBJ} opacity=".9" /><rect x="38.5" y="25" width="13" height="15" rx="6" fill={SUBJ} opacity=".5" /></> },
];

const ANGLES: Tile[] = [
  { id: "eye level", label: "Eye level", note: "neutral, honest", svg: <><Standing /><Sight x1={24} y1={20} x2={42} y2={20} /><Marker x={18} y={20} rot={90} /></> },
  { id: "low angle", label: "Low angle", note: "gives them power", svg: <><Standing /><Sight x1={22} y1={34} x2={43} y2={16} /><Marker x={16} y={35} rot={60} /></> },
  { id: "high angle", label: "High angle", note: "diminishes them", svg: <><Standing /><Sight x1={22} y1={8} x2={43} y2={26} /><Marker x={16} y={7} rot={122} /></> },
  { id: "overhead", label: "Overhead", note: "pattern, fate", svg: <><circle cx="36" cy="34" r="4" fill={SUBJ} /><rect x="32" y="30" width="8" height="9" rx="4" fill={SUBJ} opacity=".5" /><Sight x1={36} y1={14} x2={36} y2={27} /><Marker x={36} y={9} rot={180} /></> },
  { id: "dutch tilt", label: "Dutch tilt", note: "something is wrong", svg: (
    <g className="ns-cam-anim" style={{ animationName: "ns-cam-tilt", transformOrigin: "34px 22px" }}>
      <Frame /><circle cx="34" cy="16" r="5" fill={SUBJ} opacity=".9" /><rect x="28.25" y="22" width="11.5" height="16" rx="5" fill={SUBJ} opacity=".55" />
    </g>) },
];

const MOVES: Tile[] = [
  { id: "push in", label: "Push in", note: "raises the stakes", svg: <><Subject x={34} y={12} /><Sight x1={34} y1={20} x2={34} y2={34} /><Marker x={34} y={34} anim="ns-cam-in" /></> },
  { id: "pull out", label: "Pull out", note: "reveals the room", svg: <><Subject x={34} y={12} /><Sight x1={34} y1={20} x2={34} y2={34} /><Marker x={34} y={34} anim="ns-cam-out" /></> },
  { id: "tracking", label: "Tracking", note: "stays with them", svg: <><Subject x={34} y={13} /><Sight x1={14} y1={34} x2={54} y2={34} /><Marker x={34} y={34} anim="ns-cam-truck" /></> },
  { id: "orbit", label: "Orbit", note: "holds and circles", svg: <><Subject x={34} y={22} /><circle cx="34" cy="22" r="15" fill="none" stroke={CAM} strokeWidth="1" opacity=".35" className="ns-cam-path" /><g className="ns-cam-anim" style={{ animationName: "ns-cam-orbit", animationTimingFunction: "linear", transformOrigin: "34px 22px" }}><Marker x={34} y={37} /></g></> },
  { id: "crane", label: "Crane", note: "scale, arrival", svg: <><Standing x={46} y={13} /><Sight x1={18} y1={12} x2={18} y2={32} /><Marker x={18} y={22} rot={90} anim="ns-cam-crane" /></> },
  { id: "handheld", label: "Handheld", note: "urgency, doubt", svg: <><Subject x={34} y={13} /><Marker x={34} y={32} anim="ns-cam-hand" /></> },
  { id: "whip pan", label: "Whip pan", note: "comic reveal", svg: <><g className="ns-cam-anim" style={{ animationName: "ns-cam-whip", transformOrigin: "34px 34px" }}><Marker x={34} y={34} /></g><path d="M14 16 A24 24 0 0 1 54 16" fill="none" stroke={CAM} strokeWidth="1" opacity=".35" className="ns-cam-path" /></> },
  { id: "static", label: "Static", note: "let it breathe", svg: <><Subject x={34} y={13} /><Marker x={34} y={32} /><line x1="26" y1="39" x2="42" y2="39" stroke={STRUCT} strokeWidth="1.5" /></> },
  { id: "one-take", label: "One-take", note: "no cut at all", svg: <><path d="M12 34 C22 34 22 14 34 14 C46 14 46 30 56 30" fill="none" stroke={CAM} strokeWidth="1.2" opacity=".5" className="ns-cam-path" /><Subject x={34} y={32} /><Marker x={12} y={34} anim="ns-cam-hand" /></> },
];

const LENSES = ["18mm", "24mm", "35mm", "50mm", "85mm", "135mm"];
const FEELS = ["shallow", "deep focus", "anamorphic", "rack focus"];

export function parseCamera(v: string | null) {
  const s = (v ?? "").toLowerCase();
  const find = (tiles: Tile[]) => tiles.find((t) => s.includes(t.id))?.id ?? null;
  return {
    size: find(SIZES), angle: find(ANGLES), move: find(MOVES),
    lens: LENSES.find((l) => s.includes(l)) ?? null,
    feel: FEELS.find((f) => s.includes(f)) ?? null,
  };
}

/** The recognized picks out of a compiled camera string, as short display
 *  labels in size/angle/move/lens/feel order — a beat card's alternative to
 *  showing the whole joined description in one truncating line. Prose the
 *  director wrote free-hand (rather than through this picker) may name a
 *  size in words this can't match; callers should still show the raw string
 *  too, since real camera direction the parser doesn't recognize must never
 *  read as empty. */
export function cameraChips(v: string | null): string[] {
  const p = parseCamera(v);
  const label = (tiles: Tile[], id: string | null) => tiles.find((t) => t.id === id)?.label ?? null;
  return [label(SIZES, p.size), label(ANGLES, p.angle), label(MOVES, p.move), p.lens, p.feel]
    .filter((x): x is string => !!x);
}

function Section({ title, note, tiles, value, onPick }: {
  title: string; note?: string; tiles: Tile[]; value: string | null; onPick: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <span className="ws-mlabel">{title}</span>
        <span style={{ height: 1, flex: 1, background: "linear-gradient(90deg, rgba(255,255,255,.12), transparent)" }} />
        {note && <span className="mono" style={{ fontSize: 11.5, color: "#5e6678" }}>{note}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 11 }}>
        {tiles.map((t) => {
          const on = value === t.id;
          return (
            <button key={t.id} className={"ws-camtile" + (on ? " on" : "")} onClick={() => onPick(t.id)}>
              <span className="diagram">
                <svg viewBox="0 0 68 44" style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}>
                  {t.svg}
                </svg>
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: on ? "#8fc2ff" : "#eaeef6" }}>{t.label}</span>
                <span style={{ fontSize: 11, lineHeight: 1.4, color: "#5e6678" }}>{t.note}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function CameraPicker({ current, context, prevMove, onApply, onClose }: {
  current: string | null;
  context: string;
  /** the previous beat's movement, for the redundancy note */
  prevMove?: string | null;
  onApply: (camera: string) => void;
  onClose: () => void;
}) {
  const init = useMemo(() => parseCamera(current), [current]);
  const [size, setSize] = useState(init.size);
  const [angle, setAngle] = useState(init.angle);
  const [move, setMove] = useState(init.move);
  const [lens, setLens] = useState(init.lens);
  const [feel, setFeel] = useState(init.feel);

  const compound = [size, angle, move, lens, feel].filter(Boolean).join(" · ") || "no choice yet";
  const restless = prevMove && move && move !== "static" && prevMove !== "static";

  return (
    <ModalShell
      width={1060} tall z={96}
      icon={<Camera size={16} />}
      title="Camera"
      context={<>{context} · currently <span style={{ color: "#8fc2ff" }}>{current || "unset"}</span></>}
      onClose={onClose}
      footer={<>
        <span className="sum" style={{ color: "#9aa4b6" }}>{compound}</span>
        <button className="ws-ghost" onClick={onClose}>Cancel</button>
        <button className="ws-primary glow"
                onClick={() => onApply([size, angle, move, lens, feel].filter(Boolean).join(", "))}>
          <Check size={15} />Apply to beat
        </button>
      </>}
    >
      <div className="ns-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 22px 6px",
                                          display: "flex", flexDirection: "column", gap: 20 }}>
        <Section title="Shot size" note="how much of them you see" tiles={SIZES} value={size}
                 onPick={(v) => setSize((s) => (s === v ? null : v))} />
        <Section title="Angle" note="where the camera sits" tiles={ANGLES} value={angle}
                 onPick={(v) => setAngle((s) => (s === v ? null : v))} />
        <Section title="Movement" note="diagrams play the move" tiles={MOVES} value={move}
                 onPick={(v) => setMove((s) => (s === v ? null : v))} />
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span className="ws-mlabel">Lens & feel</span>
            <span style={{ height: 1, flex: 1, background: "linear-gradient(90deg, rgba(255,255,255,.12), transparent)" }} />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {LENSES.map((l) => (
              <button key={l} className={"ws-pill mono" + (lens === l ? "" : "")} onClick={() => setLens((s) => (s === l ? null : l))}
                      style={{ height: 32, fontSize: 12.5, fontWeight: 600,
                               ...(lens === l ? { borderColor: "rgba(90,162,255,.42)", background: "rgba(90,162,255,.1)", color: "#8fc2ff" } : {}) }}>
                {l}
              </button>
            ))}
            <span style={{ width: 1, height: 22, background: "rgba(255,255,255,.1)", margin: "0 4px" }} />
            {FEELS.map((f) => (
              <button key={f} className="ws-pill" onClick={() => setFeel((s) => (s === f ? null : f))}
                      style={{ height: 32, fontSize: 12.5,
                               ...(feel === f ? { borderColor: "rgba(90,162,255,.42)", background: "rgba(90,162,255,.1)", color: "#8fc2ff" } : {}) }}>
                {f}
              </button>
            ))}
          </div>
        </div>
        {restless && (
          <div style={{ display: "flex", gap: 11, padding: 14, borderRadius: 18,
                        background: "rgba(201,122,255,.055)", border: "1px solid rgba(201,122,255,.24)", marginBottom: 4 }}>
            <Sparkles size={15} style={{ color: "#c97aff", flexShrink: 0, marginTop: 2 }} />
            <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.65, color: "#c4a8dd" }}>
              The previous beat already moves ({prevMove}). Two moving shots back to back reads as
              restless — the director suggests holding this one static and letting the moment land.
            </span>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

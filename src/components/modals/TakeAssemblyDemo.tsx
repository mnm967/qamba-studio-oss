// The assembly viewer and multiview on their own, for /ui/takes.
//
// Reaching the real bench means signing in, opening a project, planning an
// episode, rendering a block and rendering it AGAIN — and the two things this
// harness exists to check are both things only a moving picture can answer:
//
//   * the cells are the SHAPE of the render. A stretched track handed a 16:9
//     take a portrait cell and `cover` cut it to a strip, which is a layout
//     bug that every still screenshot of a correct build also looks like.
//   * THE CUT IS AN EDIT NOW: pieces are dropped where you point, dragged into
//     a new order and retrimmed by their own edges. Every one of those is a
//     gesture, and a gesture is not a thing an assertion about state can see —
//     the caret has to be in the right place, the piece has to be as wide as
//     its own length, and the drop has to land where the caret said it would.
//   * the cells are the same MOMENT — and the moment is a timestamp inside the
//     TAKE, not a position in the cut. Those were one number for as long as an
//     assembly had to be a tiling; now a piece can play anywhere, so `shuffled`
//     builds a cut whose second half is the FIRST half of take 2 and the claim
//     becomes falsifiable: every cell and the viewer still read the same
//     second, which is a second the playhead has already gone past.
//
// So the clips are SYNTHESISED here rather than fetched: a canvas with the
// take's number and its own elapsed time burned into it, recorded through
// MediaRecorder into a blob URL. Reading four cells and the stage off one
// screenshot is then a direct check that they agree — which no amount of
// asserting about `currentTime` would be.
//
// Nothing here touches Supabase or the network.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssemblyTrack, BenchScrub, Multiview, Stage, TakeRow, useDragPiece,
} from "./TakeAssemblyModal";
import { pickCells, swapCell } from "../../lib/multiview";
import { useAssemblyPlayer } from "../../hooks/useAssemblyPlayer";
import {
  cutTimeOf, insertIndexAt, insertSlice, moveBoundary, moveSegment, removeSegment, setSegmentTake,
  shotSpans, tile, totalMs, trimSegment,
  type Segment, type TakeEvidence,
} from "../../lib/assembly";
import type { BlockTake } from "../../lib/db/types";

const HUES = ["#7fa8d4", "#d4a87f", "#84c9a1", "#9184d9"];
// MediaRecorder records in REAL TIME — there is no way to hurry it — so the
// clip length is also how long this screen takes to open. Six seconds is long
// enough to watch a cut land and short enough that an automated run is not
// mostly waiting; the four clips are recorded at once for the same reason.
const DUR_MS = 6000;
const FPS = 12;                       // enough to read a clock, cheap to encode

/** Shapes worth looking at: the studio's own default, the vertical cut, an
 *  academy-ish one and scope. Each puts the fit under different pressure. */
const SHAPES: { label: string; w: number; h: number }[] = [
  { label: "16:9", w: 1280, h: 720 },
  { label: "9:16", w: 720, h: 1280 },
  { label: "4:3", w: 1024, h: 768 },
  { label: "2.39:1", w: 1912, h: 800 },
];

/** One test clip: a coloured card counting its own seconds.
 *
 *  Recorded rather than drawn live because the thing under test is a <video>
 *  element — a canvas would prove the layout and none of the playback. */
function makeClip(idx: number, w: number, h: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    if (!c.captureStream || typeof MediaRecorder === "undefined" || !g) {
      return reject(new Error("this browser cannot synthesise a clip"));
    }
    const stream = c.captureStream(FPS);
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => resolve(URL.createObjectURL(new Blob(chunks, { type: "video/webm" })));
    rec.onerror = () => reject(new Error("recorder failed"));

    let frame = 0;
    const total = Math.round((DUR_MS / 1000) * FPS);
    const draw = () => {
      const t = frame / FPS;
      g.fillStyle = HUES[idx % HUES.length];
      g.fillRect(0, 0, w, h);
      // A diagonal band so a CROP is obvious: cut the sides off and the band
      // stops touching the corners.
      g.strokeStyle = "rgba(0,0,0,.35)";
      g.lineWidth = Math.max(2, Math.min(w, h) * 0.02);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();
      g.strokeRect(g.lineWidth, g.lineWidth, w - g.lineWidth * 2, h - g.lineWidth * 2);
      g.fillStyle = "#12131e";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.font = `700 ${Math.round(Math.min(w, h) * 0.3)}px ui-monospace, monospace`;
      g.fillText(`${idx + 1}`, w / 2, h * 0.38);
      g.font = `700 ${Math.round(Math.min(w, h) * 0.16)}px ui-monospace, monospace`;
      g.fillText(`${t.toFixed(2)}s`, w / 2, h * 0.68);
      if (frame++ >= total) { rec.stop(); return; }
      setTimeout(draw, 1000 / FPS);
    };
    rec.start();
    draw();
  });
}

const fakeTake = (i: number): BlockTake => ({
  id: `take-${i + 1}`, block_id: "demo", asset_id: `asset-${i + 1}`, idx: i,
  kind: "render", status: "ready", created_at: new Date(0).toISOString(),
} as unknown as BlockTake);

export default function TakeAssemblyDemo() {
  const [n, setN] = useState(2);
  const [shape, setShape] = useState(0);
  const [shuffled, setShuffled] = useState(false);
  const [urls, setUrls] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { w, h } = SHAPES[shape];

  // Four clips, recorded once per shape. They are blob URLs, so the cleanup
  // matters: a revoked URL on a live <video> is a black cell, hence the swap
  // only after the whole set is in hand.
  useEffect(() => {
    let dead = false;
    setUrls(null); setErr(null);
    Promise.all([0, 1, 2, 3].map((i) => makeClip(i, w, h)))
      .then((made) => {
        if (dead) { made.forEach(URL.revokeObjectURL); return; }
        setUrls((prev) => { prev?.forEach(URL.revokeObjectURL); return made; });
      })
      .catch((e) => { if (!dead) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { dead = true; };
  }, [w, h]);

  const takes = useMemo(() => Array.from({ length: n }, (_, i) => fakeTake(i)), [n]);
  const idxOf = useMemo(() => new Map(takes.map((t, i) => [t.id, i])), [takes]);
  const hue = (id: string) => HUES[(idxOf.get(id) ?? 0) % HUES.length];
  const label = (id: string) => `Take ${(idxOf.get(id) ?? 0) + 1}`;
  // Four clips serve any number of takes: recording is real time, and what a
  // fifth take is here for is the wall's picker, not a fifth picture.
  const urlOf = (id: string) => urls?.[(idxOf.get(id) ?? 0) % urls.length];

  // Two pieces when there is more than one take, so the stage actually cuts
  // and the IN CUT ring moves while it plays. `shuffled` makes the second
  // piece take 2's OPENING half — a cut the old tiling model could not hold,
  // and the one that proves the player maps the two clocks rather than
  // assuming they agree.
  const segments: Segment[] = useMemo(() => (
    n < 2
      ? tile("take-1", DUR_MS)
      : [{ take_id: "take-1", in_ms: 0, out_ms: DUR_MS / 2 },
         shuffled
           ? { take_id: "take-2", in_ms: 0, out_ms: DUR_MS / 2 }
           : { take_id: "take-2", in_ms: DUR_MS / 2, out_ms: DUR_MS }]
  ), [n, shuffled]);

  // The EDITED cut. `segments` is the fixture the shape/order buttons build;
  // this is what the gestures have done to it since. Reset when the fixture
  // changes, or the harness would keep an edit made against two takes after
  // being switched to four.
  const [cut, setCut] = useState<Segment[]>(segments);
  useEffect(() => setCut(segments), [segments]);

  // The modal wires these same components through an undo stack and a draft
  // write; here it is plain state, and the difference is the point — every
  // gesture under test lives INSIDE the components, so what is duplicated is
  // glue and not behaviour.
  const [trim, setTrim] = useState<{ takeId: string; in_ms: number; out_ms: number } | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const cutRef = useRef(cut);
  cutRef.current = cut;

  const caretAt = useCallback((x: number, y: number) => {
    const el = trackRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (y < r.top - 24 || y > r.bottom + 24 || x < r.left - 40 || x > r.right + 40) return null;
    const total = Math.max(1, totalMs(cutRef.current));
    return insertIndexAt(cutRef.current, ((x - r.left) / r.width) * total);
  }, []);

  // The same hook the modal uses, for the same reason: the drop belongs to the
  // pointer, not to whichever component happens to see its release.
  const pieces = useDragPiece({
    caretAt,
    onDrop: (slice, from, at) => {
      setCut((c) => (from == null
        ? insertSlice(c, { take_id: slice.takeId, in_ms: slice.in_ms, out_ms: slice.out_ms }, at)
        : moveSegment(c, from, at)));
      if (from == null) setTrim(null);          // the modal does this too
    },
  });

  const shots = useMemo(() => shotSpans([{ duration_ms: 1, camera: "a" },
                                         { duration_ms: 1, camera: "b" }], DUR_MS), []);
  const evidence = useMemo(() => new Map<string, TakeEvidence>(), []);

  // Which takes are on the wall, and which the STAGE keeps decoding: two
  // budgets, as in the modal, because the cells run on their own clock now.
  const [cellPick, setCellPick] = useState<string[]>([]);
  const cellIds = useMemo(
    () => pickCells(takes.map((t) => t.id), cellPick, 4), [takes, cellPick]);
  const hot = useMemo(() => takes.map((t) => t.id), [takes]);
  const player = useAssemblyPlayer({
    segments: cut, durationMs: DUR_MS, hot, live: cellIds, fps: FPS });

  return (
    <div className="tas-scrim">
      <div className="tas" data-demo="takes">
        <header className="tas-head">
          <span className="tas-title">Take assembly — viewer</span>
          <span className="mono tas-sub">
            {SHAPES[shape].label} · {n} take{n === 1 ? "" : "s"} · synthesised clips
          </span>
          <span style={{ flex: 1 }} />
          {SHAPES.map((s, i) => (
            <button key={s.label} className={"tas-btn" + (i === shape ? " primary" : "")}
                    data-shape={s.label} onClick={() => setShape(i)}>{s.label}</button>
          ))}
          <span className="tas-rule" />
          {[1, 2, 3, 4, 5, 6].map((k) => (
            <button key={k} className={"tas-btn" + (k === n ? " primary" : "")}
                    data-takes={k} onClick={() => setN(k)}>{k}</button>
          ))}
          <span className="tas-rule" />
          <button className={"tas-btn" + (shuffled ? " primary" : "")} data-act="shuffle"
                  onClick={() => setShuffled((v) => !v)}
                  title="Play take 2's opening half second — source time and cut time disagree">
            {shuffled ? "Shuffled" : "In order"}
          </button>
          <button className="tas-btn" data-act="play" onClick={player.toggle}>
            {player.playing ? "Pause" : "Play"}
          </button>
        </header>

        <div className="tas-top">
          <div className="tas-viewcol">
            <Stage player={player} takes={takes} urlOf={urlOf} label={label} hue={hue}
                   segments={segments}
                   aspect={w / h} onProbe={() => { /* the shape is known here */ }} />
            <div className="tas-transport">
              <span className="mono tas-keys">
                {err ? `clips unavailable — ${err}`
                     : urls ? "each cell runs its own take · the viewer runs the cut"
                            : "recording test clips…"}
              </span>
            </div>
          </div>
          <div className="tas-multicol">
            <Multiview takes={takes} cells={cellIds} evidence={evidence} urlOf={urlOf}
                       label={label} hue={hue}
                       aspect={w / h} player={player} trimTake={trim?.takeId ?? null}
                       onPick={() => { /* focus is the modal's state */ }}
                       onSolo={(id) => player.setSolo(player.solo === id ? null : id)}
                       onSwapCell={(slot, id) => setCellPick(swapCell(cellIds, slot, id))} />
            <div className="tas-trimbar">
              <span className="mono tas-hint">
                {trim
                  ? `${label(trim.takeId)} ${(trim.in_ms / 1000).toFixed(1)}→${(trim.out_ms / 1000).toFixed(1)}s`
                    + " — drag it into the cut"
                  : "Drag across a strip to trim · drop it anywhere in the cut"}
              </span>
            </div>
          </div>
        </div>

        {/* The bench and the cut, the real components, against fixtures. */}
        <div className="tas-bench">
          <div className="tas-secthead">
            <b>Bench</b>
            <span>drag across a strip to trim · drag the trim into the cut</span>
          </div>
          <div className="tas-rows">
            <BenchScrub player={player} segments={cut} durationMs={DUR_MS} />
            {takes.map((t) => (
              <TakeRow
                key={t.id} take={t} shots={shots} durationMs={DUR_MS} takeCount={takes.length}
                hue={hue(t.id)} label={label(t.id)} url={urlOf(t.id)}
                active={t.id === "take-1"} focused={trim?.takeId === t.id}
                solo={player.solo === t.id}
                trim={trim?.takeId === t.id ? trim : null}
                usedSpans={cut.filter((c) => c.take_id === t.id)}
                onFocus={() => { /* the modal owns focus */ }}
                onSolo={() => player.setSolo(player.solo === t.id ? null : t.id)}
                onTrim={(a, b) => setTrim({ takeId: t.id, in_ms: a, out_ms: b })}
                onSeekSource={(srcMs) => {
                  const at = cutTimeOf(cut, t.id, srcMs);
                  if (at != null) player.seek(at);
                }}
                player={player}
                onLift={(x, y) => { if (trim) pieces.start(trim, null, x, y); }}
              />
            ))}
          </div>
          <div className="tas-secthead" style={{ height: 26, marginTop: 6 }}>
            <b className="accent">Cut</b>
            <span>drop a piece anywhere · drag one to reorder · edges retrim</span>
          </div>
          <AssemblyTrack
            trackRef={trackRef} segments={cut} preview={false} planMs={DUR_MS}
            takes={takes} hue={hue} label={label} urlOf={urlOf}
            assetOf={() => null} player={player}
            drag={pieces.drag} sel={sel} onSelect={setSel}
            onBoundary={(i, ms, phase) => {
              if (phase === "move") setCut((c) => moveBoundary(c, i, ms));
            }}
            onTrim={(i, patch, phase) => {
              if (phase === "move") setCut((c) => trimSegment(c, i, patch, DUR_MS));
            }}
            onRemove={(i) => setCut((c) => removeSegment(c, i))}
            onSwap={(i, id) => setCut((c) => setSegmentTake(c, i, id))}
            onSeek={player.seek}
            onLift={(i, x, y) => pieces.start(
              { takeId: cut[i].take_id, in_ms: cut[i].in_ms, out_ms: cut[i].out_ms }, i, x, y)}
          />
        </div>
      </div>
    </div>
  );
}

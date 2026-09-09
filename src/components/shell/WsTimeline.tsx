// The timeline slab, recreated from the design file: 120px sticky lane
// labels, a 28px ruler, V2/V1 video lanes and A1..A3 audio lanes, clips with
// filmstrip + take strip, and a white playhead with a triangular cap.
// Data comes from useTimelineStore / usePlaybackStore exactly as before.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft, AudioLines, Clapperboard, Headphones, Link2, Lock, Move, Plus, Redo2, RefreshCw, Scissors, SlidersHorizontal, Trash2, Undo2, Unlock, Volume2, VolumeX, ZoomIn, ZoomOut,
} from "lucide-react";
import { useTimelineStore } from "../../stores/useTimelineStore";
import TimelineMenu from "../timeline/TimelineMenu";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { isMacUA } from "../../lib/titlebar";
import { updateTrack } from "../../lib/db/timeline";
import {
  AUTO_MAX_DB, AUTO_MIN_DB, addPoint, clampDb, dbToFrac, fracToDb, hitPoint, movePoint,
  removePoint, soloActive, type AutoPoint,
} from "../../lib/mix";
import { activeFx, describeFx, normalizeFx } from "../../lib/audioFx";
import type { Asset, BlockTake, Clip, GenerationBlock, Track } from "../../lib/db/types";
import { asArray, asNumberList } from "../../lib/jsonb";
import AudioClipMenu from "../timeline/AudioClipMenu";
import BlockContextMenu from "../timeline/BlockContextMenu";
import BlockActionModal, { BlockModalMode } from "../timeline/BlockActionModal";
import TrimFramePopover from "../timeline/TrimFramePopover";
import { trimPatch, trimReadout, MIN_CLIP_MS } from "../../lib/clipFrames";
import { isStill } from "../../lib/assetKind";
import { displayBlockStatus } from "../../lib/staleBlocks";
import { extractAndSaveClipFrame } from "../../lib/frameExtractor";
import { blockFromClipBlocker, nearestLaneBlockId } from "../../lib/blockFromClip";
import { blockKind, blockLabel, clipKindClass } from "../../lib/blockKind";
import { nextCopyLabel, pasteTarget } from "../../lib/clipClipboard";
import {
  clipsInMarquee, edgeScroll, groupMove, isDrag, normalizeRect, type MarqueeBand,
} from "../../lib/marquee";
import { onTimelineNote } from "../../lib/timelineSignals";
import { queueBlockFromClip } from "../../lib/db/jobs";
import SaveAsBlockModal, { type BlockPlacement } from "../timeline/SaveAsBlockModal";

const LANE_LABEL_W = 120;
const AUDIO_LANE_H = 54;

/** Payloads a lane accepts. Blocks come from the scene rail, assets from the
 *  library grid — both already set these on dragstart; nothing accepted them. */
export const DND_BLOCK = "application/x-qamba-block";
export const DND_ASSET = "application/x-qamba-asset";

const LANE_ROLE: Record<string, string> = {
  V1: "video", V2: "overlays", V3: "titles",
  A1: "music", A2: "sfx", A3: "vox",
};

/** Lane header: name + role, mute/solo (audio), lock, and delete — plus, on an
 * audio lane, the mixer strip: a fader and the automation arm.
 *
 * Deleting a lane takes its clips with it (FK cascade), so a non-empty lane
 * arms the trash button first (it goes red and says what it will take) and
 * only deletes on a second click — the label column is too narrow for a
 * confirm row. It refuses to remove the last lane of its kind. */
function LaneLabel({ track, tone, fallback, clips, audio = false, autoArmed = false, onArmAuto }: {
  track: Track; tone: string; fallback: string; clips: number; audio?: boolean;
  autoArmed?: boolean; onArmAuto?: () => void;
}) {
  const store = useTimelineStore();
  const sameKind = store.tracks.filter((t) => t.kind === track.kind).length;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);   // don't stay armed
    return () => clearTimeout(t);
  }, [armed]);
  const remove = () => {
    if (sameKind <= 1) return;
    if (clips && !armed) { setArmed(true); return; }
    void store.removeTrack(track.id);
  };
  const delTitle = sameKind <= 1 ? "Can't remove the last lane of this kind"
    : armed ? `Click again — takes ${clips} clip${clips === 1 ? "" : "s"} with it`
    : clips ? `Delete lane (${clips} clip${clips === 1 ? "" : "s"})` : "Delete lane";
  const pts = (track.automation ?? []) as AutoPoint[];
  // What the FX button reports: how many effects are actually DOING something,
  // the same test both engines make. A rack of four bypassed effects is not a
  // lane anyone needs told about.
  const nFx = activeFx(normalizeFx(track.audio_fx)).length;
  const rackOpen = store.selectedTrackId === track.id;
  return (
    <div className={"ws-lanelabel" + (audio ? " audio" : "")}>
      <span className="ws-lanetop">
        <span className="k" style={{ color: tone }}
              title={LANE_ROLE[track.name ?? ""] ?? (audio ? "audio" : "video")}>
          {track.name ?? fallback}
        </span>
        {/* The role word is the first thing to go on an audio lane: four act
            buttons and a 120px sticky column leave it no room, and it is a
            static hint derived from the lane's own name — the fader, the
            meter-less dB readout and M/S are all live state. It stays in the
            name's tooltip. */}
        <span className="d">{LANE_ROLE[track.name ?? ""] ?? (audio ? "audio" : "video")}</span>
        {/* Mute and solo are on VIDEO lanes too. A block's audio is baked into
            the picture, `syncBlocksToTimeline` silently mutes V1 for a
            locked-audio music video, and soloing an audio lane silences the
            picture's audio as well — none of which had any UI at all, so the
            lane that carries the dialogue was the one lane whose sound could
            not be seen or switched. */}
        <span className="ws-laneacts">
          <button className={track.muted ? "on danger" : ""}
                  title={track.muted ? "Unmute lane" : audio ? "Mute lane" : "Mute this lane's clip audio"}
                  onClick={() => store.setTrackMuted(track.id, !track.muted)}>
            {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          <button className={track.solo ? "on solo" : ""}
                  title={track.solo ? "Un-solo lane" : "Solo lane — silences every lane that isn't soloed"}
                  onClick={() => store.setTrackSolo(track.id, !track.solo)}>
            <Headphones size={12} />
          </button>
          <button className={track.locked ? "on warn" : ""}
                  title={track.locked ? "Unlock lane" : "Lock lane"}
                  onClick={() => {
                    useTimelineStore.setState((st) => ({
                      tracks: st.tracks.map((t) => (t.id === track.id ? { ...t, locked: !t.locked } : t)),
                    }));
                    void updateTrack(track.id, { locked: !track.locked });
                  }}>
            {track.locked ? <Lock size={11} /> : <Unlock size={11} />}
          </button>
          <button title={delTitle} onBlur={() => setArmed(false)}
                  className={armed ? "on danger" : ""}
                  style={{ opacity: sameKind <= 1 ? 0.35 : undefined }}
                  onClick={remove}>
            <Trash2 size={11} />
          </button>
        </span>
      </span>

      {audio && (
        <span className="ws-lanemix">
          <input type="range" min={AUTO_MIN_DB} max={AUTO_MAX_DB} step={0.5}
                 value={pts.length ? 0 : Number(track.gain_db) || 0}
                 disabled={pts.length > 0}
                 title={pts.length
                   ? "The automation curve owns this lane's level — clear it to use the fader"
                   : "Lane volume"}
                 onChange={(e) => store.setTrackGain(track.id, +e.target.value)} />
          <span className="db mono">
            {pts.length ? "auto" : `${(Number(track.gain_db) || 0).toFixed(1)}`}
          </span>
          <button className={"ws-autobtn" + (autoArmed ? " on" : "") + (pts.length ? " has" : "")}
                  title={autoArmed
                    ? "Done editing volume automation (clips on this lane are draggable again)"
                    : "Draw volume automation — click the lane to add a point, alt-click to remove"}
                  onClick={onArmAuto}>
            <AudioLines size={12} />
          </button>
          {!!pts.length && (
            <button className="ws-autobtn" title={`Clear ${pts.length} automation point${pts.length === 1 ? "" : "s"}`}
                    onClick={() => store.setTrackAutomation(track.id, [])}>
              <Trash2 size={10} />
            </button>
          )}
          {/* The lane's effect rack. Here rather than in the acts row above:
              it is a mixer-strip control like the fader beside it, and that
              row is already four buttons wide in a 120px column. It opens the
              inspector on the LANE — which closes any clip selection, since
              the two are alternatives. */}
          <button className={"ws-autobtn" + (rackOpen ? " on" : "") + (nFx ? " has" : "")}
                  title={rackOpen ? "Close the lane's effects"
                    : nFx ? `Lane effects — ${nFx} on this lane`
                    : "Lane effects — inserts every clip on this lane passes through"}
                  onClick={() => store.selectTrack(rackOpen ? null : track.id)}>
            <SlidersHorizontal size={11} />
          </button>
        </span>
      )}
    </div>
  );
}

/** The lane's volume curve, drawn over its clips and editable when armed.
 *
 * Armed, the overlay takes the lane's pointer events — so a lane in
 * automation mode edits the curve and not the clips, which is the modality
 * every DAW uses and the only way one surface can host both without a
 * modifier key nobody discovers. Unarmed it is a read-only line. */
function AutomationLane({ track, total, armed }: { track: Track; total: number; armed: boolean }) {
  const setAutomation = useTimelineStore((s) => s.setTrackAutomation);
  const ref = useRef<HTMLDivElement>(null);
  const pts = useMemo(() => (track.automation ?? []) as AutoPoint[], [track.automation]);
  const base = Number(track.gain_db) || 0;

  const x = (p: AutoPoint) => (p.t_ms / Math.max(1, total)) * 100;
  const y = (p: AutoPoint) => dbToFrac(p.gain_db) * 100;

  const poly = pts.length
    ? [`0,${y(pts[0])}`, ...pts.map((p) => `${x(p)},${y(p)}`), `100,${y(pts[pts.length - 1])}`].join(" ")
    : `0,${dbToFrac(base) * 100} 100,${dbToFrac(base) * 100}`;

  const fromEvent = (e: { clientX: number; clientY: number }): AutoPoint => {
    const r = ref.current!.getBoundingClientRect();
    return {
      t_ms: Math.max(0, ((e.clientX - r.left) / r.width) * total),
      gain_db: fracToDb((e.clientY - r.top) / r.height),
    };
  };
  /** The curve as the STORE has it, not as this render closed over it. Two
   *  points added in one tick (a double-click) both read the same stale props
   *  otherwise, and the second write silently discards the first. */
  const live = () =>
    ((useTimelineStore.getState().tracks.find((t) => t.id === track.id)?.automation ?? []) as AutoPoint[]);
  const hit = (e: { clientX: number; clientY: number }, list = live()) => {
    const r = ref.current!.getBoundingClientRect();
    return hitPoint(list, { x: e.clientX - r.left, y: e.clientY - r.top },
                    (p) => ({ x: (x(p) / 100) * r.width, y: (y(p) / 100) * r.height }));
  };

  const onDown = (e: React.PointerEvent) => {
    if (!armed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cur = live();
    const idx = hit(e, cur);
    if (idx >= 0 && (e.altKey || e.metaKey)) {           // alt-click removes
      setAutomation(track.id, removePoint(cur, idx));
      return;
    }
    // A new point is born under the cursor and dragged in the same gesture —
    // click-then-drag-to-place is one interaction, not two.
    let list = cur;
    let i = idx;
    if (i < 0) {
      const p = fromEvent(e);
      list = addPoint(cur, p);
      i = list.findIndex((q) => q.t_ms === Math.round(p.t_ms));
      if (i < 0) return;                                  // point cap reached
      setAutomation(track.id, list);
    }
    const move = (ev: PointerEvent) => {
      const p = fromEvent(ev);
      const want = { t_ms: Math.max(0, Math.round(p.t_ms)), gain_db: clampDb(p.gain_db) };
      list = movePoint(list, i, p);
      // The list re-sorts as a point passes its neighbour, so the index is
      // recovered from the values just written rather than remembered.
      i = list.findIndex((q) => q.t_ms === want.t_ms && q.gain_db === want.gain_db);
      if (i < 0) i = 0;
      setAutomation(track.id, list);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!armed && !pts.length) return null;
  return (
    <div ref={ref} className={"ws-auto" + (armed ? " armed" : "")}
         onPointerDown={onDown}
         onContextMenu={(e) => {
           if (!armed) return;
           const cur = live();
           const idx = hit(e, cur);
           if (idx < 0) return;
           e.preventDefault();
           e.stopPropagation();
           setAutomation(track.id, removePoint(cur, idx));
         }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={poly} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      {armed && pts.map((p, i) => (
        <i key={`${p.t_ms}:${i}`} style={{ left: `${x(p)}%`, top: `${y(p)}%` }}
           title={`${(p.t_ms / 1000).toFixed(2)}s · ${p.gain_db.toFixed(1)} dB`} />
      ))}
      {armed && !pts.length && (
        <span className="ws-autohint mono">click to add a volume point</span>
      )}
    </div>
  );
}

function fmtClock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function getInsertionIndexAndMs(
  atMs: number,
  targetTrackId: string,
  clips: Clip[],
  excludeClipId?: string
): { insertIndex: number; insertMs: number } {
  // All clips currently on target track, sorted visually by t_start_ms
  const allTrackClips = clips
    .filter((c) => c.track_id === targetTrackId)
    .sort((a, b) => a.t_start_ms - b.t_start_ms);

  // Clips excluding the one being dragged/reordered
  const targetClips = allTrackClips.filter((c) => c.id !== excludeClipId);

  if (targetClips.length === 0) {
    return { insertIndex: 0, insertMs: 0 };
  }

  // If hovering before the midpoint of the first clip on track
  const first = allTrackClips[0];
  const firstMid = first.t_start_ms + first.duration_ms / 2;
  if (atMs < firstMid) {
    const insertIdx = first.id === excludeClipId ? 0 : 0;
    return { insertIndex: insertIdx, insertMs: first.t_start_ms };
  }

  for (let i = 0; i < allTrackClips.length; i++) {
    const c = allTrackClips[i];
    const mid = c.t_start_ms + c.duration_ms / 2;
    const nextMid = i < allTrackClips.length - 1
      ? allTrackClips[i + 1].t_start_ms + allTrackClips[i + 1].duration_ms / 2
      : Infinity;

    if (atMs >= mid && atMs < nextMid) {
      if (c.id === excludeClipId) {
        const idxInTarget = targetClips.findIndex((x) => x.t_start_ms > c.t_start_ms);
        const idx = idxInTarget === -1 ? targetClips.length : idxInTarget;
        return { insertIndex: idx, insertMs: c.t_start_ms + c.duration_ms };
      }
      const idxInTarget = targetClips.indexOf(c);
      const insertIndex = idxInTarget !== -1 ? idxInTarget + 1 : targetClips.length;
      return { insertIndex, insertMs: c.t_start_ms + c.duration_ms };
    }

    if (atMs < mid) {
      if (c.id === excludeClipId) {
        const idxInTarget = targetClips.findIndex((x) => x.t_start_ms >= c.t_start_ms);
        const idx = idxInTarget === -1 ? 0 : idxInTarget;
        return { insertIndex: idx, insertMs: c.t_start_ms };
      }
      const idxInTarget = targetClips.indexOf(c);
      const insertIndex = idxInTarget !== -1 ? idxInTarget : 0;
      return { insertIndex, insertMs: c.t_start_ms };
    }
  }

  const last = allTrackClips[allTrackClips.length - 1];
  return {
    insertIndex: targetClips.length,
    insertMs: last.t_start_ms + last.duration_ms,
  };
}

/** The undo chord, spelled for the platform — the desktop app ships on both.
 *  Reuses titlebar.ts's sniff rather than adding a second one. */
const MOD = isMacUA() ? "⌘" : "Ctrl+";

export default function WsTimeline({
  onRender,
}: {
  onRender?: () => void;
  /** Only provided once the cut has a rendered asset. */
}) {
  const ws = useWorkspaceStore();
  const { clips, tracks, assets, beatsMs, selectedClipId, selectedClipIds,
          select, selectMany, patchClip, snap } = useTimelineStore();
  // A Set for the render: every clip on every lane asks "am I selected", and
  // `.includes` over a 40-clip marquee is that question answered 40 times per
  // clip on every frame of a group drag.
  const selSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);
  const durationMs = useTimelineStore((s) => s.durationMs());
  const beginGesture = useTimelineStore((s) => s.beginGesture);
  const endGesture = useTimelineStore((s) => s.endGesture);
  // Subscribed to the DEPTH, not to the stacks: the arrays are replaced on
  // every edit and re-rendering the whole slab for a step nobody can see is
  // the stutter reconcile already goes out of its way to avoid.
  const undoDepth = useTimelineStore((s) => s.undoStack.length);
  const redoDepth = useTimelineStore((s) => s.redoStack.length);
  const seek = usePlaybackStore((s) => s.seek);
  const onTick = usePlaybackStore((s) => s.onTick);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [dropLane, setDropLane] = useState<string | null>(null);
  const [dropNote, setDropNote] = useState<string | null>(null);
  /** A job this panel queued and is still waiting on. The timeline's own
   *  actions are the only ones whose OUTCOME has nowhere else to appear:
   *  the queue popover reports the whole studio, and the note that says
   *  "queued…" clears itself after five seconds — so a job that failed two
   *  seconds later left the last thing on screen saying it was working.
   *  That is indistinguishable from a pod that has not got to it yet. */
  const [watchJob, setWatchJob] = useState<{ id: string; verb: string } | null>(null);
  /** The clip whose "Save as new block…" dialog is open. The menu item has
   *  always carried an ellipsis; this is what it now opens. */
  const [saveBlock, setSaveBlock] = useState<Clip | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  /** Lanes whose automation curve is being edited (UI only, never persisted —
   *  arming a lane is about this minute, not about the project). */
  const [autoLanes, setAutoLanes] = useState<Set<string>>(new Set());
  /** The time scale, held still for the length of a gesture.
   *
   *  Every position on this timeline is a percentage of the whole duration, so
   *  trimming the clip that DEFINES the duration re-scales the ruler under the
   *  cursor and the edge crawls away from the pointer. Freezing the scale
   *  while a drag is in flight makes the edge track the pointer exactly; it
   *  re-fits on release. */
  const [frozenTotal, setFrozenTotal] = useState<number | null>(null);
  /** The trim in flight, for the frame card. Everything here is fixed for the
   *  length of the gesture — the readout itself is derived from the store's
   *  own clip on every render, so the card cannot drift from what a release
   *  would commit. */
  const [trimHud, setTrimHud] = useState<
    { clipId: string; side: "l" | "r"; origDur: number; scale: number;
      lane: HTMLElement; audio: boolean } | null>(null);
  const [assemblyIndicator, setAssemblyIndicator] = useState<{
    trackId: string; insertMs: number; insertIndex: number;
  } | null>(null);
  /** The rubber band in flight, in `.ws-tinner` coordinates and NOT in client
   *  ones: the slab scrolls under the gesture (it auto-scrolls at the edges),
   *  and an anchor held in viewport pixels slides off the content it was
   *  dropped on the moment it does. `n` is what the badge reports while the
   *  drag is live — a band whose hit count you only learn on release is one
   *  you have to draw twice. */
  const [marquee, setMarquee] = useState<
    { x0: number; y0: number; x1: number; y1: number; n: number } | null>(null);
  const dragRef = useRef<
    { id: string; startX: number; startMs: number; kind: string; laneW: number } | null>(null);
  const store = useTimelineStore;

  const [contextMenu, setContextMenu] = useState<{
    clip: Clip; x: number; y: number; hasNext: boolean; nextClip: Clip | null;
  } | null>(null);
  const [audioMenu, setAudioMenu] = useState<{ clip: Clip; x: number; y: number } | null>(null);
  const [blockModal, setBlockModal] = useState<{
    mode: BlockModalMode; clip: Clip; nextClip?: Clip | null;
  } | null>(null);

  /** Zoom around a fixed viewport x (keeps the time under the cursor put). */
  const zoomAt = (factor: number, clientX?: number) => {
    const el = scrollRef.current;
    setZoom((z) => {
      const next = Math.min(40, Math.max(1, z * factor));
      if (el) {
        const r = el.getBoundingClientRect();
        const anchorX = (clientX ?? r.left + r.width / 2) - r.left - LANE_LABEL_W;
        const contentX = el.scrollLeft + anchorX;               // px into the track area
        const laneW = (r.width - LANE_LABEL_W);
        const ratio = next / z;
        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, contentX * ratio - anchorX);
          void laneW;
        });
      }
      return next;
    });
  };

  const total = frozenTotal ?? Math.max(1000, durationMs);
  const pct = (ms: number) => (ms / total) * 100;

  // Live playhead without re-rendering the tree — moved by TRANSFORM, not
  // `left`. A percentage `left` write is a layout pass per frame, and the
  // playhead carries a 12px blurred glow the full height of the lanes, so on
  // WKWebView every tick was layout + a blurred repaint band. A translate on
  // a promoted layer (will-change in workspace.css) is compositor-only. The
  // pixel width comes from a ResizeObserver on the wrap, and the position is
  // re-applied on resize so a paused playhead doesn't drift off its time.
  const headWrapRef = useRef<HTMLDivElement>(null);
  const headWrapW = useRef(0);
  const lastHeadMs = useRef(0);
  useEffect(() => {
    const place = () => {
      if (headRef.current) {
        headRef.current.style.transform =
          `translateX(${(lastHeadMs.current / total) * headWrapW.current}px)`;
      }
    };
    const wrap = headWrapRef.current;
    let ro: ResizeObserver | null = null;
    if (wrap) {
      headWrapW.current = wrap.clientWidth;
      ro = new ResizeObserver(() => {
        headWrapW.current = wrap.clientWidth;
        place();
      });
      ro.observe(wrap);
    }
    lastHeadMs.current = usePlaybackStore.getState().nowMs();
    place();
    const off = onTick((ms) => { lastHeadMs.current = ms; place(); });
    return () => { ro?.disconnect(); off(); };
  }, [onTick, total]);

  const videoTracks = useMemo(
    () => tracks.filter((t) => t.kind === "video").sort((a, b) => b.idx - a.idx), [tracks]);
  const audioTracks = useMemo(
    () => tracks.filter((t) => t.kind === "audio").sort((a, b) => a.idx - b.idx), [tracks]);
  const anySolo = useMemo(() => soloActive(tracks), [tracks]);

  const blockIds = useMemo(
    () => clips.map((c) => c.block_id).filter(Boolean) as string[], [clips]);
  const { data: blockData } = useLiveQuery(
    async () => {
      if (!blockIds.length) return null;
      const { data: blocks } = await supabase
        .from("generation_blocks").select("*").in("id", blockIds);
      const { data: takes } = await supabase
        .from("block_takes").select("*").in("block_id", blockIds).order("created_at");
      const byBlock = new Map<string, BlockTake[]>();
      for (const t of (takes ?? []) as BlockTake[]) {
        byBlock.set(t.block_id, [...(byBlock.get(t.block_id) ?? []), t]);
      }
      const takeAssetIds = [...new Set((takes ?? []).map((t) => t.asset_id))];
      const { data: takeAssets } = takeAssetIds.length
        ? await supabase.from("assets").select("*").in("id", takeAssetIds)
        : { data: [] };
      return {
        blocks: new Map(((blocks ?? []) as GenerationBlock[]).map((b) => [b.id, b])),
        takes: byBlock,
        takeAssets: new Map(((takeAssets ?? []) as { id: string; b2_key: string }[]).map((a) => [a.id, a])),
      };
    },
    ["generation_blocks", "block_takes"], [blockIds.join(",")]
  );

  // ruler ticks every 10s major / 5s minor
  const ticks = useMemo(() => {
    const out: { at: number; major: boolean; label?: string }[] = [];
    const step = total > 240000 ? 30000 : total > 90000 ? 20000 : 10000;
    for (let t = 0; t <= total; t += step / 2) {
      const major = t % step === 0;
      out.push({ at: t, major, label: major ? fmtClock(t) : undefined });
    }
    return out;
  }, [total]);

  const divisorPct = 100 / (total / 10000) / ws.divisor;

  /** Press anywhere on the ruler (or grab the playhead) and drag to scrub. */
  const startScrub = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const lane = (scrollRef.current?.querySelector(".ws-ruler .ws-rulertrack") as HTMLElement) ?? null;
    const rect = (lane ?? e.currentTarget).getBoundingClientRect();
    const to = (clientX: number) => {
      const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      seek(f * total);
    };
    to(e.clientX);
    setScrubbing(true);
    const move = (ev: PointerEvent) => to(ev.clientX);
    const up = () => {
      setScrubbing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** ── DRAG ON EMPTY LANE = RUBBER BAND ────────────────────────────────────
   *
   *  Attached to `.ws-track` rather than to the lane, so it can never fire on
   *  the sticky label column's buttons; clips `stopPropagation` on their own
   *  pointerdown, so anything that reaches here is genuinely empty lane. The
   *  automation overlay is `pointer-events: none` until its lane is armed and
   *  stops propagation once it is, so an armed lane still edits its curve.
   *
   *  A PRESS THAT DOES NOT TRAVEL IS A CLICK, and on empty lane a click means
   *  "select nothing" — which is also the only way out of a selection without
   *  one, and something this timeline simply did not do before. */
  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || ws.tool === "blade") return;
    const scroller = scrollRef.current;
    const tinner = lanesRef.current;
    if (!scroller || !tinner) return;
    e.preventDefault();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? [...useTimelineStore.getState().selectedClipIds] : [];

    // Anchored in CONTENT coordinates, once. Everything downstream re-reads
    // the live rect, so a slab that scrolls mid-gesture (below) keeps the
    // anchor glued to the lane it was dropped on.
    const t0 = tinner.getBoundingClientRect();
    const anchor = { x: e.clientX - t0.left, y: e.clientY - t0.top };
    const startX = e.clientX, startY = e.clientY;
    let last = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let hits: string[] = [];
    let raf = 0;

    /** The band each lane sees, in ms. Converted per lane off its own
     *  `.ws-track` box: that is exact at any zoom, where comparing a clip's
     *  rendered rect is at the mercy of sub-pixel rounding — at fit zoom a
     *  200ms clip is a couple of pixels wide. */
    const bandsFor = (box: { top: number; bottom: number; left: number; right: number }) => {
      const out: MarqueeBand[] = [];
      for (const el of tinner.querySelectorAll<HTMLElement>("[data-track-id]")) {
        const id = el.dataset.trackId;
        const track = el.querySelector<HTMLElement>(".ws-track");
        if (!id || !track) continue;
        const lr = el.getBoundingClientRect();
        if (box.bottom <= lr.top || box.top >= lr.bottom) continue;   // misses this lane
        const tr = track.getBoundingClientRect();
        if (tr.width <= 0) continue;
        const toMs = (x: number) => ((x - tr.left) / tr.width) * total;
        out.push({
          trackId: id,
          fromMs: Math.max(0, toMs(Math.max(box.left, tr.left))),
          toMs: Math.max(0, toMs(Math.min(box.right, tr.right))),
        });
      }
      return out;
    };

    const paint = () => {
      const t = tinner.getBoundingClientRect();
      const cur = { x: last.x - t.left, y: last.y - t.top };
      const r = normalizeRect(anchor, cur);
      const box = {
        left: t.left + r.x, right: t.left + r.x + r.w,
        top: t.top + r.y, bottom: t.top + r.y + r.h,
      };
      hits = clipsInMarquee(useTimelineStore.getState().clips, bandsFor(box));
      setMarquee({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h,
                   n: additive ? new Set([...base, ...hits]).size : hits.length });
    };

    /** Reaching past the viewport. Without it a marquee at any zoom above
     *  "fit" can only take what happens to be on screen, and the gesture stops
     *  dead at the edge — which reads as the band being broken rather than as
     *  a missing feature. Driven by rAF off the LAST pointer position, so it
     *  keeps scrolling while the pointer is held still at the edge; a
     *  pointermove-driven version silently stops the moment the hand does. */
    const tick = () => {
      const { dx, dy } = edgeScroll(last, scroller.getBoundingClientRect(),
                                    { leftInset: LANE_LABEL_W });
      if (dx || dy) {
        scroller.scrollLeft += dx;
        scroller.scrollTop += dy;
        paint();
      }
      raf = requestAnimationFrame(tick);
    };

    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (!isDrag(ev.clientX - startX, ev.clientY - startY)) return;
        dragging = true;
        raf = requestAnimationFrame(tick);
      }
      paint();
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      setMarquee(null);
      if (!dragging) {
        // A click on empty lane clears the selection — and clears the lane
        // rack with it, since the two are alternatives.
        if (!additive) { select(null); useTimelineStore.getState().selectTrack(null); }
        return;
      }
      selectMany(hits, { mode: additive ? "add" : "replace" });
      if (hits.length && !ws.inspOpen) ws.set("inspOpen", true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onClipDown = (e: React.PointerEvent, c: Clip) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const st0 = useTimelineStore.getState();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // Shift-click PICKS rather than drags: it is the one gesture that has to
    // be able to take a clip back out of a selection, and starting a move on
    // the same press would drag whatever it had just added.
    if (additive && ws.tool === "select") {
      selectMany([c.id], { mode: "toggle" });
      if (!ws.inspOpen) ws.set("inspOpen", true);
      return;
    }
    // A press INSIDE an existing selection keeps the set — that is what makes
    // a group drag possible at all — and only moves the primary onto what was
    // pressed. Collapsing here instead would mean a group could never be
    // dragged by any of its own members. A press outside replaces it.
    const inSel = st0.selectedClipIds.includes(c.id);
    const group = inSel && st0.selectedClipIds.length > 1;
    if (group) selectMany(st0.selectedClipIds, { primary: c.id });
    else select(c.id);
    if (!ws.inspOpen) ws.set("inspOpen", true);
    if (ws.tool === "blade") {
      const lane = (e.currentTarget as HTMLElement).parentElement!;
      const r = lane.getBoundingClientRect();
      const atMs = ((e.clientX - r.left) / r.width) * total;
      void useTimelineStore.getState().splitAt(c.id, atMs);
      return;
    }
    if (ws.tool !== "select") return;
    const track = tracks.find((t) => t.id === c.track_id);
    if (track?.locked) return;

    // ── a GROUP drag: rigid, horizontal, on the lanes the clips are already on
    //
    // Deliberately not the single-clip drag N times over. Cross-lane movement
    // is meaningless for a set spanning several lanes, and assembly mode packs
    // ONE lane end to end — so a group in assembly mode falls back to dragging
    // the clip that was grabbed, and SAYS so rather than appearing to move a
    // selection it did not.
    if (group && !ws.autoAlign) {
      const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
      const movers = clips
        .filter((x) => selSet.has(x.id) && !locked.has(x.track_id))
        .map((x) => ({ id: x.id, t_start_ms: x.t_start_ms }));
      if (!movers.length) return;
      const laneEl = (e.currentTarget as HTMLElement).parentElement!;
      const laneW = laneEl.getBoundingClientRect().width;
      const startX = e.clientX;
      const scale = total;
      let moved = false;
      setFrozenTotal(total);
      beginGesture(movers.length > 1 ? "Move clips" : "Move clip");
      const gmove = (ev: PointerEvent) => {
        if (!moved && !isDrag(ev.clientX - startX, 0)) return;
        moved = true;
        // Snap the clip UNDER THE POINTER and take the delta from where it
        // landed, so the whole set stays rigid: snapping each clip on its own
        // would let them drift apart onto different beats.
        const rawDelta = ((ev.clientX - startX) / laneW) * scale;
        const want = Math.max(0, c.t_start_ms + rawDelta);
        const snapped = ws.snap ? snap(want, { excludeClipId: c.id }) : want;
        useTimelineStore.getState()
          .moveClips(groupMove(movers, snapped - c.t_start_ms), { undoable: false });
      };
      const gup = () => {
        window.removeEventListener("pointermove", gmove);
        window.removeEventListener("pointerup", gup);
        endGesture();
        setFrozenTotal(null);
        // A press that never travelled is a CLICK, and a click on one member
        // of a group means "just this one" — otherwise there is no way to pick
        // a single clip out of a selection without first clicking empty lane.
        if (!moved) select(c.id);
      };
      window.addEventListener("pointermove", gmove);
      window.addEventListener("pointerup", gup);
      return;
    }
    if (group && ws.autoAlign) {
      setDropNote(`Assembly mode re-orders one clip at a time — the other `
        + `${selSet.size - 1} stayed put. Turn Auto Align off to move them together.`);
    }

    const lane = (e.currentTarget as HTMLElement).parentElement!;
    const laneW = lane.getBoundingClientRect().width;
    dragRef.current = { id: c.id, startX: e.clientX, startMs: c.t_start_ms,
                        kind: track?.kind ?? "video", laneW };
    setFrozenTotal(total);
    beginGesture("Move clip");
    let targetLane: string | null = c.track_id;
    let currentInsertIndex: number | null = null;

    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;

      const laneEls = lanesRef.current?.querySelectorAll<HTMLElement>("[data-track-id]") ?? [];
      targetLane = c.track_id;
      for (const el of laneEls) {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
          const t = tracks.find((x) => x.id === el.dataset.trackId);
          if (t && t.kind === d.kind && !t.locked) targetLane = t.id;
          break;
        }
      }
      setDropLane(targetLane && targetLane !== c.track_id ? targetLane : null);

      if (ws.autoAlign && targetLane) {
        const laneEl = lanesRef.current?.querySelector<HTMLElement>(`[data-track-id="${targetLane}"] .ws-track`);
        if (laneEl) {
          const r = laneEl.getBoundingClientRect();
          const atMs = Math.max(0, ((ev.clientX - r.left) / r.width) * total);
          const ins = getInsertionIndexAndMs(atMs, targetLane, clips, d.id);
          currentInsertIndex = ins.insertIndex;
          setAssemblyIndicator({ trackId: targetLane, insertMs: ins.insertMs, insertIndex: ins.insertIndex });
        }
      } else {
        setAssemblyIndicator(null);
        const deltaMs = ((ev.clientX - d.startX) / d.laneW) * total;
        const raw = Math.max(0, d.startMs + deltaMs);
        // `undoable: false` through the drag — one undo entry is committed on
        // release. Patching undoably per pointermove filled the 60-deep stack
        // with one gesture, so ⌘Z could not reach past the last drag.
        patchClip(d.id, { t_start_ms: Math.round(ws.snap ? snap(raw, { excludeClipId: d.id }) : raw) },
                  { undoable: false });
      }
    };

    const up = () => {
      const d = dragRef.current;
      if (d) {
        if (ws.autoAlign && targetLane && currentInsertIndex != null) {
          store.getState().reorderClipOnTrack(d.id, targetLane, currentInsertIndex);
        } else if (targetLane && targetLane !== c.track_id) {
          store.getState().moveClipToTrack(d.id, targetLane);
        }
      }
      endGesture();   // after the re-pack: it is part of this gesture
      dragRef.current = null;
      setDropLane(null);
      setFrozenTotal(null);
      setAssemblyIndicator(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Trim by dragging an end.
   *
   *  The left edge moves the source in-point WITH the clip start, so the
   *  frames you see are the frames you keep; the right edge moves the
   *  out-point. Both are clamped to the source media — a clip cannot be
   *  dragged longer than the file it plays — and to a floor that leaves
   *  something to grab. In assembly mode the lane closes up behind the trim,
   *  which is the whole point of that mode. */
  const onTrimDown = (e: React.PointerEvent, c: Clip, side: "l" | "r") => {
    if (e.button !== 0 || ws.tool !== "select") return;
    e.preventDefault();
    e.stopPropagation();
    const track = tracks.find((t) => t.id === c.track_id);
    if (track?.locked) return;
    select(c.id);
    if (!ws.inspOpen) ws.set("inspOpen", true);
    const laneEl = (e.currentTarget as HTMLElement).closest(".ws-track") as HTMLElement | null;
    if (!laneEl) return;
    const laneW = laneEl.getBoundingClientRect().width;
    const scale = total;                       // frozen for the gesture, below
    setFrozenTotal(total);
    setTrimHud({ clipId: c.id, side, origDur: c.duration_ms, scale, lane: laneEl,
                 audio: track?.kind === "audio" });
    beginGesture("Trim clip");
    const orig = { ...c };
    // A handle moves in TIMELINE ms; `in_ms`/`out_ms` are SOURCE ms. The two
    // scales are the same only at 1x, so every clamp and every write across
    // them carries the rate — and on a REVERSED clip the two handles move the
    // opposite ends of the source window, which is what this used to get
    // wrong. All of that lives in `clipFrames.trimPatch`, with tests: this
    // component owns the pointer and the snap grid and nothing else, the same
    // split `marquee.edgeScroll` already follows.
    const asset = assets.get(c.asset_id);
    const startX = e.clientX;

    const move = (ev: PointerEvent) => {
      const dMs = ((ev.clientX - startX) / laneW) * scale;
      let edge = orig.t_start_ms + (side === "l" ? 0 : orig.duration_ms) + dMs;
      if (ws.snap) edge = snap(edge, { excludeClipId: orig.id });
      patchClip(orig.id, trimPatch(orig, side, edge, asset), { undoable: false });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // Close the gap the trim left BEFORE committing, so undo puts the lane
      // back the way it was rather than half-way.
      if (ws.autoAlign) useTimelineStore.getState().autoAlignTrack(orig.track_id);
      endGesture();
      setFrozenTotal(null);
      setTrimHud(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const trimHandles = (c: Clip) => (
    <>
      <span className="ws-trim l" title="Drag to trim the start"
            onPointerDown={(e) => onTrimDown(e, c, "l")} />
      <span className="ws-trim r" title="Drag to trim the end"
            onPointerDown={(e) => onTrimDown(e, c, "r")} />
    </>
  );

  /** The frame card for a trim in flight.
   *
   *  It follows the EDGE rather than the pointer: the two part company the
   *  moment a clamp binds, and an edge that has stopped moving under a card
   *  that has not is the one reading that would make the card a liar. The
   *  lane's rect is re-read per render rather than captured — the slab scrolls
   *  horizontally, and a card anchored to a stale rect drifts off its own
   *  clip. */
  const trimCard = (() => {
    if (!trimHud) return null;
    const c = clips.find((x) => x.id === trimHud.clipId);
    if (!c) return null;
    const asset = assets.get(c.asset_id) ?? null;
    const r = trimHud.lane.getBoundingClientRect();
    const edgeMs = trimHud.side === "l" ? c.t_start_ms : c.t_start_ms + c.duration_ms;
    return (
      <TrimFramePopover
        asset={asset}
        audio={trimHud.audio}
        readout={trimReadout(c, trimHud.side, asset,
                             { origDurationMs: trimHud.origDur, minMs: MIN_CLIP_MS })}
        x={r.left + (edgeMs / trimHud.scale) * r.width}
        y={r.top}
      />
    );
  })();

  // ── drop a block or a library asset onto a lane ───────────────────────────
  const dropAt = (e: React.DragEvent) => {
    const track = (e.currentTarget as HTMLElement).querySelector(".ws-track");
    const r = (track ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
    const raw = Math.max(0, ((e.clientX - r.left) / r.width) * total);
    return Math.round(ws.snap ? snap(raw) : raw);
  };

  const dropBlock = async (blockId: string, track: Track, atMs: number, insertIndex?: number) => {
    const { data: b } = await supabase.from("generation_blocks")
      .select("id,idx,status,active_take_id,t_start_ms,t_end_ms,params")
      .eq("id", blockId).maybeSingle();
    if (!b) { setDropNote("That block no longer exists."); return; }
    const block = b as Pick<GenerationBlock,
      "id" | "idx" | "status" | "active_take_id" | "t_start_ms" | "t_end_ms" | "params">;
    // Named for what it IS on every line it appears in, the lane's label
    // included — "Block 9 has no kept take yet" about a chain sends someone
    // looking for a shot that is not there.
    const name = blockLabel(blockKind(block), block.idx);
    if (!block.active_take_id) {
      setDropNote(`${name} has no kept take yet (${block.status}) — ` +
                  `it can go on the timeline once a render lands.`);
      return;
    }
    const { data: take } = await supabase.from("block_takes")
      .select("asset_id").eq("id", block.active_take_id).maybeSingle();
    const assetId = (take as { asset_id?: string } | null)?.asset_id;
    if (!assetId) { setDropNote("That take has no media."); return; }
    const { data: asset } = await supabase.from("assets").select("*").eq("id", assetId).maybeSingle();
    if (!asset) { setDropNote("That take's media is missing."); return; }

    // A SECOND COPY IS A REAL EDIT, so a drag gets one. This refused outright
    // — and nothing else in the app has ever held the one-clip-per-block rule
    // that implied: the rail's own tooltip offers "another copy", ⌘D on a
    // block clip makes one, `splitAt` copies `block_id` onto both halves, and
    // the sync has keyed its repoint and its relabel to a LIST of clips per
    // block since it was measured finding 51 blocks with more than one. Every
    // copy plays the block's active take and follows it there. What keeps
    // refusing is the AUTOMATIC inserts — `placeBlockPlaceholder` and the
    // sync's own insert branch — because nobody asked for those, and a copy
    // appearing on its own is not an edit anyone made.
    //
    // PICTURE clips only, the rule `exclusionsAfterStep` and the sync already
    // state: `detachedClipFrom` copies `block_id` onto the detached audio
    // half, so counting every lane called a block whose picture was deleted
    // and whose sound outlived it "already on the timeline" — with no way to
    // put the picture back. Read from the STORE rather than this render's
    // closure, so two quick drops name themselves in order.
    const live = store.getState().clips;
    const videoLanes = new Set(videoTracks.map((t) => t.id));
    const already = live.filter((c) => c.block_id === block.id && videoLanes.has(c.track_id));
    // Named the way ⌘D names a copy — one spelling — and that is also what
    // keeps it legible: the sync rewrites the studio's own auto forms on a
    // renumber and leaves everything else alone, so two clips both called
    // "Block 8" would stay identical on the lane forever. The trade is ⌘D's
    // own: a copy's number goes stale if shots are inserted ahead of it.
    const label = already.length
      ? nextCopyLabel(name, live.map((c) => c.label ?? ""))
      : name;
    await store.getState().insertAsset(asset as Asset, track.id, atMs, {
      blockId: block.id,
      label,
      durationMs: block.t_end_ms - block.t_start_ms,
      insertIndex,
    });
    // Said rather than silent: dropping the wrong row is easy, and "there are
    // now two of these" is the fact the old refusal was carrying.
    setDropNote(already.length
      ? `${label} — ${already.length + 1} copies of ${name} are on this cut, all playing its take.`
      : null);
  };

  const dropAsset = async (assetId: string, track: Track, atMs: number, insertIndex?: number) => {
    const known = assets.get(assetId);
    const asset = known ?? ((await supabase.from("assets").select("*").eq("id", assetId)
      .maybeSingle()).data as Asset | null);
    if (!asset) { setDropNote("That asset is missing."); return; }
    const wantAudio = track.kind === "audio";
    if (wantAudio !== (asset.kind === "audio")) {
      setDropNote(asset.kind === "audio"
        ? "Audio belongs on an audio lane."
        : `${asset.kind} media belongs on a video lane.`);
      return;
    }
    // Measuring a file the registry could not size is a network round trip
    // (~1s on a 6MB track), and a drop that appears to do nothing for a second
    // reads as a drop that failed.
    if (asset.duration_ms == null && !isStill(asset)) {
      setDropNote(`Reading how long ${asset.b2_key.split("/").pop()} is…`);
    }
    const clip = await store.getState().insertAsset(asset, track.id, atMs, { insertIndex });
    // A dropped file lands at its FULL length. When neither the registry nor
    // the browser can size it the clip falls back to a constant, and a clip
    // that is quietly the wrong length reads as the drop being broken — so it
    // is said, with the reason and the way out.
    const sized = store.getState().assets.get(asset.id);
    setDropNote(clip && sized?.duration_ms == null && !isStill(asset)
      ? `Couldn't read how long ${asset.b2_key.split("/").pop()} is — it landed at `
        + `${((clip.duration_ms ?? 0) / 1000).toFixed(1)}s. Drag its right edge to the length you want.`
      : null);
  };

  const laneDrop = (track: Track) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = Array.from(e.dataTransfer.types);
      if (!types.includes(DND_BLOCK) && !types.includes(DND_ASSET)) return;
      e.preventDefault();                       // without this, no drop fires
      e.dataTransfer.dropEffect = "copy";
      if (!track.locked && dropLane !== track.id) setDropLane(track.id);

      if (ws.autoAlign && !track.locked) {
        const laneEl = (e.currentTarget as HTMLElement).querySelector(".ws-track");
        const r = (laneEl ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
        const atMs = Math.max(0, ((e.clientX - r.left) / r.width) * total);
        const ins = getInsertionIndexAndMs(atMs, track.id, clips);
        setAssemblyIndicator({ trackId: track.id, insertMs: ins.insertMs, insertIndex: ins.insertIndex });
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
      setDropLane((l) => (l === track.id ? null : l));
      setAssemblyIndicator(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropLane(null);
      const targetInsertIndex = (ws.autoAlign && assemblyIndicator?.trackId === track.id)
        ? assemblyIndicator.insertIndex : undefined;
      setAssemblyIndicator(null);

      if (track.locked) { setDropNote(`${track.name ?? "That lane"} is locked.`); return; }
      const atMs = dropAt(e);
      const blockId = e.dataTransfer.getData(DND_BLOCK);
      const assetId = e.dataTransfer.getData(DND_ASSET);
      if (blockId) {
        if (track.kind !== "video") { setDropNote("Blocks are video — drop them on a video lane."); return; }
        void dropBlock(blockId, track, atMs, targetInsertIndex);
      } else if (assetId) {
        void dropAsset(assetId, track, atMs, targetInsertIndex);
      }
    },
  });

  /** Copy / paste / duplicate, shared by both context menus and the key map.
   *
   *  One implementation rather than two: the picture menu and the sound menu
   *  offer the same three actions on the same clips (a detached pair is two
   *  rows), and the note they report through lives here. The store does the
   *  work and hands back a sentence when there is something to say — a paste
   *  that landed somewhere other than the playhead, or could not run at all.
   *  Silence means it did exactly what the label promised. */
  const clipCopy = (clip: Clip) => {
    const ok = store.getState().copyClip(clip.id);
    setDropNote(ok
      ? `Copied “${clip.label ?? "clip"}”${clip.linked_clip_id ? " and its linked half" : ""}.`
      : "Couldn't copy that clip.");
  };
  const clipPaste = (clip: Clip) => {
    void store.getState().pasteClip(clip.track_id, usePlaybackStore.getState().nowMs())
      .then((note) => note && setDropNote(note), (err) => {
        console.error("paste failed", err);
        setDropNote(`Couldn't paste: ${(err as Error)?.message ?? err}`);
      });
  };
  const clipDuplicate = (clip: Clip) => {
    void store.getState().duplicateClip(clip.id)
      .then((note) => note && setDropNote(note), (err) => {
        console.error("duplicate failed", err);
        setDropNote(`Couldn't duplicate: ${(err as Error)?.message ?? err}`);
      });
  };
  /** Why paste is unavailable on this clip's lane, in the words the tooltip
   *  should use. `pasteTarget` answers the same question the store asks at
   *  write time, so a greyed item and a refused action always agree. */
  const pasteBlockerFor = (clip: Clip): string | null => {
    const cb = clips.length ? store.getState().clipboard : null;
    if (!cb) return "Nothing has been copied yet.";
    const t = pasteTarget(cb, tracks, clip.track_id);
    return "error" in t ? t.error : null;
  };

  /** Save this clip's trimmed window as a block of its own. Given the PICTURE
   *  clip: on an audio menu the caller passes the linked half, because the
   *  block is made from the picture and a detached pair mirrors its geometry,
   *  so the trim is the same one either way. */
  const saveAsNewBlock = (clip: Clip) => setSaveBlock(clip);

  /** Queue it, once the dialog has answered WHERE it goes. Split from the
   *  menu handler so the placement is a decision the user made rather than
   *  one this function assumed. */
  const doSaveAsNewBlock = (clip: Clip, placement: BlockPlacement) => {
    const a = assets.get(clip.asset_id);
    void queueBlockFromClip(clip, a, {
      projectId: a?.project_id,
      episodeId: store.getState().timeline?.episode_id,
      append: placement === "append",
      // A BLOCKLESS clip (a landed extend/chain from before those made blocks,
      // or imported media) is PROMOTED into the storyboard beside its nearest
      // lane neighbour — chosen here, where the lane is on screen.
      afterBlockId: clip.block_id ? undefined
        : nearestLaneBlockId(store.getState().clips, clip),
    }).then((job) => {
      // The cut is one ffmpeg pass on the pod's cpu lane, so it is seconds
      // rather than GPU-minutes — but it is still queued work, and the clip
      // does not change until it lands. Watched to the end: a job that fails
      // two seconds later must not leave the note saying it is working.
      setWatchJob({ id: job.id, verb: `Saving “${clip.label ?? "block"}” as a new block` });
      setDropNote(
        `Saving “${clip.label ?? "block"}” as a new block — the trim is being cut `
        + "to its own take. The clip will repoint when it lands.");
    }, (err) => {
      console.error("save as new block failed", err);
      setDropNote(`Couldn't save that as a new block: ${(err as Error)?.message ?? err}`);
    });
  };

  // The keyboard's actions report here. `useTimelineKeys` is mounted by
  // Workspace and cannot reach this component's state, so the note travels as
  // a signal — see lib/timelineSignals.ts.
  useEffect(() => onTimelineNote(setDropNote), []);

  useEffect(() => {
    // A note about work still in flight stays until the work settles —
    // otherwise the outcome arrives with nothing left on screen to correct.
    if (!dropNote || watchJob) return;
    const t = setTimeout(() => setDropNote(null), 5000);
    return () => clearTimeout(t);
  }, [dropNote, watchJob]);

  useLiveQuery(async () => {
    if (!watchJob) return null;
    const { data } = await supabase.from("jobs")
      .select("id,status,error_msg").eq("id", watchJob.id).maybeSingle();
    const row = data as { status?: string; error_msg?: string | null } | null;
    if (!row || row.status === "queued" || row.status === "running") return null;
    setWatchJob(null);
    if (row.status === "done") setDropNote(`${watchJob.verb} — done.`);
    else if (row.status === "canceled") setDropNote(`${watchJob.verb} — canceled.`);
    else {
      // The provider's own sentence, verbatim. "unknown job kind
      // 'block_from_clip'" says the pod is on an older build, and rewording it
      // into something friendlier would cost the one word that identifies it.
      setDropNote(`${watchJob.verb} — failed: ${row.error_msg || "no reason recorded"}`);
    }
    return null;
    // Polled as well as subscribed: a cpu-lane job can start AND finish inside
    // one realtime debounce, and a missed event here means the note says
    // "working" for good.
  }, ["jobs"], [watchJob?.id], 300, watchJob ? 2000 : 0);

  // ── pinch / ctrl-wheel zoom, anchored at the pointer ──────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // trackpad pinch arrives as wheel + ctrlKey; ⌘/ctrl + wheel too
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // clamp per event: a mouse wheel notch is ~120px and a pinch is ~1-10,
      // so an unclamped exponent turns one flick into 10x zoom
      const d = Math.max(-40, Math.min(40, e.deltaY));
      zoomAt(Math.exp(-d * 0.008), e.clientX);
    };
    let pinch = 0;
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = dist(e.touches);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !pinch) return;
      e.preventDefault();
      const d = dist(e.touches);
      const mid = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      if (Math.abs(d - pinch) > 2) { zoomAt(d / pinch, mid); pinch = d; }
    };
    const onTouchEnd = () => { pinch = 0; };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const takeChips = (c: Clip) => {
    const takes = c.block_id ? blockData?.takes.get(c.block_id) ?? [] : [];
    if (!takes.length) return null;
    return (
      <div className="takes">
        {takes.slice(0, 6).map((t) => (
          <span key={t.id} style={
            t.state === "kept" ? { height: 11, background: "#ffb454" }
              : t.state === "rejected" ? { height: 8, background: "rgba(255,90,90,.5)" }
              : { height: 8, background: "rgba(255,255,255,.16)" }
          } />
        ))}
      </div>
    );
  };

  const renderVideoClip = (c: Clip) => {
    const block = c.block_id ? blockData?.blocks.get(c.block_id) : null;
    const asset = assets.get(c.asset_id);
    // `displayBlockStatus` is what keeps `stale` off the cut: the clip plays
    // the take that rendered, and painting it purple while you edit says the
    // picture is wrong when what moved on is the PLAN. Stale is reported on the
    // storyboard and on the director's banner — see lib/staleBlocks.
    const status = displayBlockStatus(block?.status, !!block?.active_take_id);
    const speed = asArray<{ op: string; rate?: number }>(c.ops).find((o) => o.op === "speed");
    // A CHAIN IS NOT A SHOT. It is the join between two of them, so it reads
    // as its own thing on the lane rather than as another block of the plan —
    // and an extension likewise. `blockKind` is the one place that decides; a
    // clip with no block yet (a placeholder still, a render in flight) has no
    // kind and stays neutral.
    const kind = block ? blockKind(block) : null;
    const sub = status === "planned" ? `planned · ${(c.duration_ms / 1000).toFixed(1)}s`
      : `${(c.duration_ms / 1000).toFixed(1)}s${speed ? ` · ×${speed.rate}` : ""}`;
    return (
      <div
        key={c.id}
        className={"ws-clip" + (selSet.has(c.id) ? " on" : "")
          + (selSet.size > 1 && selectedClipId === c.id ? " pri" : "")
          + (status === "planned" ? " planned" : "")
          + (kind ? clipKindClass(kind) : "")}
        style={{ left: `${pct(c.t_start_ms)}%`, width: `${pct(c.duration_ms)}%` }}
        onPointerDown={(e) => onClipDown(e, c)}
        onDoubleClick={() => c.block_id && ws.openModal({ kind: "takes", blockId: c.block_id })}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          select(c.id);
          const trackClips = clips
            .filter((x) => x.track_id === c.track_id)
            .sort((a, b) => a.t_start_ms - b.t_start_ms);
          const idx = trackClips.findIndex((x) => x.id === c.id);
          const nextC = idx !== -1 && idx < trackClips.length - 1 ? trackClips[idx + 1] : null;

          setContextMenu({
            clip: c,
            x: e.clientX,
            y: e.clientY,
            hasNext: Boolean(nextC),
            nextClip: nextC,
          });
        }}
      >
        <div className="body">
          {status !== "planned" && (
            <div className="strip">
              {[0, 1, 2].map((i) => (
                <span key={i} style={{
                  background: `linear-gradient(160deg, ${["#2c3a58", "#26334f", "#2f3a52"][i]}, #121a29)`,
                }} />
              ))}
            </div>
          )}
          {c.transition_in?.type === "xfade" && (
            <span className="ws-xfade mono">
              Xfade<br />{((c.transition_in.dur_ms ?? 0) / 1000).toFixed(1)}s
            </span>
          )}
          {c.transition_in?.type === "generated" && (
            <span style={{
              position: "absolute", left: 0, top: 0, bottom: 0, width: 14,
              background: "linear-gradient(90deg, rgba(201,122,255,.55), transparent)",
            }} />
          )}
          <span className="lbl" style={status === "planned" ? { color: "#8b93a7" } : undefined}>
            {c.label ?? asset?.b2_key.split("/").pop() ?? "clip"}
          </span>
          <span className="sub" style={
            status === "planned" ? { color: "#5e6678" } : undefined
          }>{sub}</span>
          {/* A silent picture has to say it is silent — otherwise "detach"
              reads as "the audio vanished". */}
          {c.audio_detached && (
            <span className="ws-detached" title={c.linked_clip_id
              ? "Audio is on an audio lane, linked to this clip"
              : "Audio is on an audio lane and unlinked — they move separately now"}>
              {c.linked_clip_id ? <Link2 size={9} /> : <AudioLines size={9} />}
              {c.linked_clip_id ? "A/V" : "AUD"}
            </span>
          )}
        </div>
        {takeChips(c)}
        {trimHandles(c)}
      </div>
    );
  };

  /** Every video clip whose block audio is still baked into the picture. */
  const attachedBlockClips = useMemo(() => {
    const videoIds = new Set(tracks.filter((t) => t.kind === "video" && !t.locked).map((t) => t.id));
    return clips.filter((c) => videoIds.has(c.track_id) && !c.audio_detached && !c.linked_clip_id);
  }, [clips, tracks]);

  const detachAll = async () => {
    const store_ = useTimelineStore.getState();
    let n = 0;
    try {
      for (const c of attachedBlockClips) {
        if (await store_.detachAudio(c.id)) n++;
      }
    } catch (err) {
      // Half-done is the honest report: the clips already detached stay
      // detached, and saying which one stopped is what makes it fixable.
      console.error("detach audio failed", err);
      setDropNote(`Detached ${n} of ${attachedBlockClips.length} — the rest failed. `
        + `${(err as Error)?.message ?? "See the console."}`);
      return;
    }
    setDropNote(n
      ? `Moved ${n} clip${n === 1 ? "'s" : "s'"} audio onto audio lanes — faders, solo and automation reach it now.`
      : "Nothing to detach.");
  };

  return (
    <div className="ws-slab ns-l2">
      <div className="ws-slab-head">
        {/* The title was a static word describing a table that has always held
            a LIST per episode — `timelinesForEpisode` returns every row and
            `ensureTimeline` merely picks "Main" out of it. This is the picker
            that word was standing in for, plus the two ways to make another. */}
        <TimelineMenu />
        <span style={{ flex: 1 }} />
        {/* ⌘Z has always been bound; the buttons are here because a keyboard
            shortcut nobody is told about is not a recoverable delete, and the
            tooltip is the only thing that says WHAT will be rewound. */}
        <div className="ws-toolsseg" role="group" aria-label="History">
          <button disabled={!undoDepth} aria-label="Undo"
                  title={undoDepth
                    ? `Undo ${useTimelineStore.getState().undoLabel()} (${MOD}Z)`
                    : "Nothing to undo"}
                  onClick={() => useTimelineStore.getState().undo()}>
            <Undo2 size={14} />
          </button>
          <button disabled={!redoDepth} aria-label="Redo"
                  title={redoDepth
                    ? `Redo ${useTimelineStore.getState().redoLabel()} (${MOD}⇧Z)`
                    : "Nothing to redo"}
                  onClick={() => useTimelineStore.getState().redo()}>
            <Redo2 size={14} />
          </button>
        </div>
        <div className="ws-toolsseg" role="group" aria-label="Edit tools">
          {(["select", "blade", "ripple"] as const).map((t) => (
            <button key={t} className={ws.tool === t ? "on" : ""}
                    title={t === "select" ? "Select & move clips"
                      : t === "blade" ? "Blade — click a clip to split it at the playhead"
                      : "Ripple edit"}
                    aria-label={t[0].toUpperCase() + t.slice(1)}
                    onClick={() => ws.set("tool", t)}>
              {t === "select" ? <Move size={14} />
                : t === "blade" ? <Scissors size={14} /> : <RefreshCw size={14} />}
            </button>
          ))}
        </div>
        <button className={"ws-pillbtn" + (ws.autoAlign ? " on" : "")}
                title="Auto-align blocks end-to-end with zero gaps (Assembly mode)"
                onClick={() => {
                  ws.toggle("autoAlign");
                  if (!ws.autoAlign) {
                    useTimelineStore.getState().autoAlignAllTracks();
                  }
                }}>
          <AlignLeft size={14} />AUTO ALIGN
        </button>
        {/* Icon + count: this row already overflows below ~1000px, and a
            second worded pill was what pushed the drop note off the end. */}
        <button className="ws-pillbtn" disabled={!attachedBlockClips.length}
                style={{ opacity: attachedBlockClips.length ? 1 : 0.4, padding: "0 11px" }}
                title={attachedBlockClips.length
                  ? `Detach audio: move ${attachedBlockClips.length} clip`
                    + `${attachedBlockClips.length === 1 ? "'s" : "s'"} baked audio onto audio lanes, `
                    + "linked to the picture — where a fader, solo and automation can reach it"
                  : "Detach audio — every video clip's audio is already on an audio lane"}
                onClick={() => void detachAll()}>
          <AudioLines size={14} />
          {!!attachedBlockClips.length && <b style={{ opacity: 0.7 }}>{attachedBlockClips.length}</b>}
        </button>
        <div className="ws-zoom">
          <button onClick={() => setZoom((z) => Math.max(1, z / 1.4))}><ZoomOut size={14} /></button>
          <span>{zoom < 1.05 ? "fit" : `${zoom.toFixed(1)}×`}</span>
          <button onClick={() => setZoom((z) => Math.min(12, z * 1.4))}><ZoomIn size={14} /></button>
        </div>
        {onRender && (
          <button className="ws-render" onClick={onRender}>
            <Clapperboard size={14} />
            <span style={{ whiteSpace: "nowrap" }}>Render</span>
          </button>
        )}
      </div>

      {/* The note reports a refused drop or a failed detach. It floats over
          the lanes rather than sitting in the toolbar, where it was the item
          an overflowing row squeezed out — i.e. the message was reliably
          invisible on exactly the narrow windows that need it most. */}
      {dropNote && (
        <div className="ws-tlnote mono" title={dropNote} onClick={() => setDropNote(null)}>
          {dropNote}
        </div>
      )}

      <div className="ws-tracks ns-scroll" ref={scrollRef}>
        <div className="ws-tinner" style={{ width: `${zoom * 100}%` }} ref={lanesRef}>
          {/* ruler */}
          <div className="ws-ruler">
            <div className="ws-lanelabel">TC</div>
            <div className="ws-rulertrack" onPointerDown={startScrub}>
              {ticks.map((t, i) => (
                <React.Fragment key={i}>
                  <span className={"ws-tick" + (t.major ? "" : " minor")} style={{ left: `${pct(t.at)}%` }} />
                  {t.label && <span className="ws-ticklabel" style={{ left: `${pct(t.at)}%` }}>{t.label}</span>}
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* add video lane */}
          <div className="ws-addlanes">
            <div className="ws-lanelabel" style={{ gap: 5 }}>
              <button className="ws-lanebtn" title="Add a video lane"
                      onClick={() => void store.getState().addTrack("video")}>
                <Plus size={11} />V
              </button>
            </div>
            <div style={{ flex: 1 }} />
          </div>

          {/* video lanes */}
          {videoTracks.map((t, i) => {
            const isBase = i === videoTracks.length - 1;
            const laneClips = clips.filter((c) => c.track_id === t.id);
            // A video lane is never dimmed — only its SOUND leaves the mix.
            const silenced = t.muted || (anySolo && !t.solo);
            return (
              <div className={"ws-lane vid" + (dropLane === t.id ? " drop" : "")
                    + (silenced ? " silenced" : "") + (t.solo ? " soloed" : "")} key={t.id}
                   data-track-id={t.id} style={{ height: isBase ? 100 : 48 }}
                   {...laneDrop(t)}>
                <LaneLabel track={t} tone={isBase ? "#5aa2ff" : "#8b93a7"}
                           fallback={t.name ?? `V${videoTracks.length - i}`}
                           clips={laneClips.length} />
                <div className="ws-track" onPointerDown={onLaneDown}
                     style={{ ["--div" as string]: `${divisorPct}%` }}>
                  {laneClips.map(renderVideoClip)}
                  {ws.autoAlign && assemblyIndicator?.trackId === t.id && (
                    <div className="ws-assembly-indicator" style={{ left: `${pct(assemblyIndicator.insertMs)}%` }}>
                      <div className="ws-assembly-badge">INSERT #{assemblyIndicator.insertIndex + 1}</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* audio lanes */}
          {audioTracks.map((t, i) => {
            const laneClips = clips.filter((c) => c.track_id === t.id);
            const dialogue = i === 0;
            const armed = autoLanes.has(t.id);
            // A lane out of the mix (muted, or not soloed while something is)
            // reads as one — the fader is not the only thing that silences it.
            const silenced = t.muted || (anySolo && !t.solo);
            return (
              <div className={"ws-lane aud" + (i === 0 ? " first-audio" : "") + (dropLane === t.id ? " drop" : "")
                    + (silenced ? " silenced" : "") + (t.solo ? " soloed" : "")} key={t.id}
                   data-track-id={t.id} style={{ height: AUDIO_LANE_H }}
                   {...laneDrop(t)}>
                <LaneLabel track={t} tone={dialogue ? "#6fd08c" : "#8b93a7"}
                           fallback={t.name ?? `A${i + 1}`} clips={laneClips.length} audio
                           autoArmed={armed}
                           onArmAuto={() => setAutoLanes((s) => {
                             const next = new Set(s);
                             if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                             return next;
                           })} />
                <div className="ws-track" onPointerDown={onLaneDown}
                     style={{ ["--div" as string]: `${divisorPct}%` }}>
                  {laneClips.map((c) => {
                    const a = assets.get(c.asset_id);
                    const peaks = asNumberList(a?.meta?.peaks).slice(0, 120);
                    return (
                      <div key={c.id}
                           className={"ws-aclip" + (dialogue ? " dlg" : "")
                             + (selSet.has(c.id) ? " on" : "")
                             + (selSet.size > 1 && selectedClipId === c.id ? " pri" : "")
                             + (c.linked_clip_id ? " linked" : "")}
                           style={{ left: `${pct(c.t_start_ms)}%`, width: `${pct(c.duration_ms)}%` }}
                           onPointerDown={(e) => onClipDown(e, c)}
                           onContextMenu={(e) => {
                             e.preventDefault();
                             e.stopPropagation();
                             select(c.id);
                             setAudioMenu({ clip: c, x: e.clientX, y: e.clientY });
                           }}>
                        {!!peaks.length && (
                          <svg viewBox="0 0 120 24" preserveAspectRatio="none"
                               style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: dialogue ? 0.75 : 0.6 }}>
                            <path
                              d={peaks.map((p, k) => `M${k} 24V${Math.max(1, 24 - p * 22)}`).join("")}
                              stroke={dialogue ? "#6fd08c" : "#8b93a7"} strokeWidth="1.6" strokeLinecap="round"
                            />
                          </svg>
                        )}
                        <span className="lbl">{c.label ?? a?.b2_key.split("/").pop()}</span>
                        {/* An effect chain is otherwise invisible unless the
                            clip happens to be selected. */}
                        {(() => {
                          const fx = activeFx(normalizeFx(c.audio_fx));
                          return fx.length ? (
                            <span className="ws-afx" title={fx.map(describeFx).join(" → ")}>
                              {fx.map(describeFx).join(" · ")}
                            </span>
                          ) : null;
                        })()}
                        {!!c.linked_clip_id && (
                          <span className="ws-alink" title="Linked to its video clip — they move and trim together">
                            <Link2 size={9} />
                          </span>
                        )}
                        {trimHandles(c)}
                      </div>
                    );
                  })}
                  <AutomationLane track={t} total={total} armed={armed} />
                  {ws.autoAlign && assemblyIndicator?.trackId === t.id && (
                    <div className="ws-assembly-indicator" style={{ left: `${pct(assemblyIndicator.insertMs)}%` }}>
                      <div className="ws-assembly-badge">INSERT #{assemblyIndicator.insertIndex + 1}</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* add audio lane */}
          <div className="ws-addlanes">
            <div className="ws-lanelabel" style={{ gap: 5 }}>
              <button className="ws-lanebtn" title="Add an audio lane"
                      onClick={() => void store.getState().addTrack("audio")}>
                <Plus size={11} />A
              </button>
            </div>
            <div style={{ flex: 1 }} />
          </div>

          {/* playhead + beat grid */}
          <div className="ws-playhead-wrap" ref={headWrapRef}>
            {beatsMs.filter((_, i) => i % 8 === 0).map((b) => (
              <span key={b} className="ws-beatline" style={{ left: `${pct(b)}%`, opacity: 0.25 }} />
            ))}
            <div className={"ws-playhead" + (scrubbing ? " grabbing" : "")} ref={headRef} style={{ left: 0 }}>
              <i />
              <b title="Drag to scrub" onPointerDown={startScrub} />
            </div>
          </div>

          {/* The rubber band. Last child of `.ws-tinner` and positioned in its
              coordinates, so it scrolls with the lanes; the sticky lane labels
              carry z-index 5 and the ruler 8, so both stay on top of it rather
              than being painted over. */}
          {marquee && (
            <div className="ws-marquee" style={{
              left: marquee.x0, top: marquee.y0,
              width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0,
            }}>
              {!!marquee.n && (
                <b className="mono">{marquee.n} clip{marquee.n === 1 ? "" : "s"}</b>
              )}
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <BlockContextMenu
          clip={contextMenu.clip}
          x={contextMenu.x}
          y={contextMenu.y}
          hasNextClip={contextMenu.hasNext}
          onClose={() => setContextMenu(null)}
          onAssemble={() => {
            if (contextMenu.clip.block_id) {
              ws.openModal({ kind: "takes", blockId: contextMenu.clip.block_id });
            }
          }}
          onRetake={() => {
            if (contextMenu.clip.block_id) {
              ws.openModal({ kind: "prompt", blockId: contextMenu.clip.block_id });
            }
          }}
          onCompareTakes={() => {
            if (contextMenu.clip.block_id) {
              ws.openModal({ kind: "takes", blockId: contextMenu.clip.block_id });
            }
          }}
          onPickTakeFromLibrary={() => {
            if (contextMenu.clip.block_id) {
              ws.openModal({ kind: "pickTake", blockId: contextMenu.clip.block_id, clipId: contextMenu.clip.id });
            }
          }}
          onChangeAudio={() => {
            if (contextMenu.clip.block_id) {
              ws.openModal({ kind: "blockAudio", blockId: contextMenu.clip.block_id,
                             clipId: contextMenu.clip.id });
            }
          }}
          onSaveLastFrame={async () => {
            try {
              const a = assets.get(contextMenu.clip.asset_id);
              const saved = await extractAndSaveClipFrame(contextMenu.clip, a, "last");
              setDropNote(`Last frame saved to library (${saved.b2_key.split("/").pop()})`);
            } catch (err) {
              console.error("Save last frame failed", err);
              setDropNote("Failed to extract & save last frame");
            }
          }}
          saveAsNewBlockBlocker={
            blockFromClipBlocker(contextMenu.clip, assets.get(contextMenu.clip.asset_id))}
          onSaveAsNewBlock={() => saveAsNewBlock(contextMenu.clip)}
          onDuplicate={() => clipDuplicate(contextMenu.clip)}
          onCopy={() => clipCopy(contextMenu.clip)}
          onPaste={() => clipPaste(contextMenu.clip)}
          pasteBlocker={pasteBlockerFor(contextMenu.clip)}
          onAddBlockAfter={() => setBlockModal({ mode: "add_after", clip: contextMenu.clip })}
          onExtendBlock={() => setBlockModal({ mode: "extend", clip: contextMenu.clip })}
          onChainWithNext={() =>
            setBlockModal({ mode: "chain", clip: contextMenu.clip, nextClip: contextMenu.nextClip })
          }
          onDetachAudio={() => {
            useTimelineStore.getState().detachAudio(contextMenu.clip.id).then(
              (made) => setDropNote(made
                ? `Audio moved to ${useTimelineStore.getState().tracks
                    .find((t) => t.id === made.track_id)?.name ?? "an audio lane"} — `
                  + "linked to the picture until you unlink it."
                : "Couldn't detach that clip's audio."),
              (err) => {
                console.error("detach audio failed", err);
                setDropNote(`Couldn't detach that clip's audio: ${(err as Error)?.message ?? err}`);
              });
          }}
          onReattachAudio={() => void useTimelineStore.getState().reattachAudio(contextMenu.clip.id)}
          onUnlinkAudio={() => useTimelineStore.getState().unlinkAudio(contextMenu.clip.id)}
        />
      )}

      {audioMenu && (() => {
        // The block is made from the PICTURE, and a detached pair mirrors its
        // geometry — so the window on screen here is the same window as on the
        // video half, and the action is the same action from either menu.
        const pic = audioMenu.clip.linked_clip_id
          ? clips.find((c) => c.id === audioMenu.clip.linked_clip_id) ?? null : null;
        return (
          <AudioClipMenu clip={audioMenu.clip} x={audioMenu.x} y={audioMenu.y}
                         onClose={() => setAudioMenu(null)}
                         onSaveAsNewBlock={() => pic && saveAsNewBlock(pic)}
                         saveAsNewBlockBlocker={pic
                           ? blockFromClipBlocker(pic, assets.get(pic.asset_id))
                           : "This sound is not linked to a picture, so there is no shot to "
                             + "save. A block is made from its video — detach a block's audio "
                             + "and the two halves stay linked."}
                         onDuplicate={() => clipDuplicate(audioMenu.clip)}
                         onCopy={() => clipCopy(audioMenu.clip)}
                         onPaste={() => clipPaste(audioMenu.clip)}
                         pasteBlocker={pasteBlockerFor(audioMenu.clip)} />
        );
      })()}

      {trimCard}

      {blockModal && (
        <BlockActionModal
          mode={blockModal.mode}
          clip={blockModal.clip}
          nextClip={blockModal.nextClip}
          onClose={() => setBlockModal(null)}
        />
      )}

      {saveBlock && (
        <SaveAsBlockModal
          windowMs={saveBlock.duration_ms ?? 0}
          // The clip's own label is the anchor's name as the user sees it on
          // the lane. Null for a blockless clip — that one has nothing to
          // insert after, so the dialog offers no choice.
          sourceLabel={saveBlock.block_id ? (saveBlock.label ?? "this block") : null}
          onSave={(placement) => doSaveAsNewBlock(saveBlock, placement)}
          onClose={() => setSaveBlock(null)}
        />
      )}
    </div>
  );
}

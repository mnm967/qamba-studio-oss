// The preview player's home. Mounted once by the shell so it never unmounts —
// on the timeline view it sits over the stage box; on every other view it
// shrinks to a draggable corner window and keeps playing.
//
// Why not the browser's native Picture-in-Picture: requestPictureInPicture()
// takes a single <video>, and this player is a stack of layered videos (one
// per mounted clip) plus separate <audio> elements for the audio lanes. Native
// PiP would show one clip and drop out at every boundary, with no lane audio.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import PreviewPlayer from "../timeline/PreviewPlayer";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { subscribeStageAnchor } from "../../lib/stageAnchor";

const SIZES = [280, 400, 560];
const MARGIN = 14;

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

export default function PlayerDock({ onTimeline, timelineHref }: {
  onTimeline: boolean;
  timelineHref: string | null;
}) {
  const nav = useNavigate();
  const ws = useWorkspaceStore();
  const playing = usePlaybackStore((s) => s.playing);
  const toggle = usePlaybackStore((s) => s.toggle);
  const seek = usePlaybackStore((s) => s.seek);
  const onTick = usePlaybackStore((s) => s.onTick);
  const durationMs = usePlaybackStore((s) => s.durationMs);
  const hasClips = useTimelineStore((s) => s.clips.length > 0);
  const label = useTimelineStore((s) => {
    const c = s.clips.find((x) => x.id === s.selectedClipId);
    return c?.label ?? s.timeline?.name ?? "Timeline";
  });

  const boxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => subscribeStageAnchor(setStage), []);

  // pip is only *shown* off the timeline; on the timeline the same node fills
  // the stage regardless of the toggle.
  const pipShown = !onTimeline && ws.pipOn && hasClips;
  const visible = (onTimeline && !!stage) || pipShown;

  // Leaving the timeline with pip off should stop playback — the audio lanes
  // would otherwise keep playing with nothing on screen to pause them.
  useEffect(() => {
    if (!onTimeline && !pipShown && usePlaybackStore.getState().playing) {
      usePlaybackStore.getState().pause();
    }
  }, [onTimeline, pipShown]);

  // ── position: match the stage box, or the pip corner ──────────────────────
  useLayoutEffect(() => {
    const place = () => {
      const el = boxRef.current;
      if (!el) return;
      if (onTimeline && stage) {
        const r = stage.getBoundingClientRect();
        el.style.left = `${r.left}px`;
        el.style.top = `${r.top}px`;
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
        el.style.borderRadius = "22px";
        return;
      }
      const w = SIZES[ws.pipSize] ?? SIZES[0];
      const h = Math.round(w * 9 / 16) + 30;             // + the pip title bar
      const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
      const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
      const x = ws.pipX == null ? MARGIN : Math.min(Math.max(MARGIN, ws.pipX), maxX);
      const y = ws.pipY == null ? maxY : Math.min(Math.max(MARGIN, ws.pipY), maxY);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.borderRadius = "16px";
    };
    place();
    // Scroll fires per event, capture-phase, from ANY scrolling box — the
    // timeline lanes included — and place() forces layout with
    // getBoundingClientRect. Coalesced to one rAF: scrolling the lanes during
    // playback used to re-lay-out the video's own container per scroll event.
    let raf = 0;
    const placeSoon = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; place(); });
    };
    const ro = new ResizeObserver(placeSoon);
    if (stage) ro.observe(stage);
    window.addEventListener("resize", placeSoon);
    window.addEventListener("scroll", placeSoon, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", placeSoon);
      window.removeEventListener("scroll", placeSoon, true);
    };
  }, [stage, onTimeline, ws.pipSize, ws.pipX, ws.pipY]);

  // pip transport readouts (no re-render per frame)
  useEffect(() => onTick((ms) => {
    if (tcRef.current) tcRef.current.textContent = fmt(ms);
    if (barRef.current && durationMs > 0) {
      barRef.current.style.width = `${Math.min(100, (ms / durationMs) * 100)}%`;
    }
  }), [onTick, durationMs]);

  const startDrag = (e: React.PointerEvent) => {
    if (onTimeline) return;
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      ws.set("pipX", ev.clientX - dx);
      ws.set("pipY", ev.clientY - dy);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={boxRef}
      className={"ws-playerdock" + (onTimeline ? " staged" : " pip")
        + (dragging ? " dragging" : "") + (visible ? "" : " hidden")}
      aria-hidden={!visible}
    >
      {pipShown && (
        <div className="ws-pipbar" onPointerDown={startDrag}>
          <span className="ws-pipttl">{label}</span>
          <span style={{ flex: 1 }} />
          <button title="Resize"
                  onClick={() => ws.set("pipSize", (ws.pipSize + 1) % SIZES.length)}>
            {ws.pipSize === SIZES.length - 1 ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button title="Stop and close"
                  onClick={() => { usePlaybackStore.getState().pause(); ws.set("pipOn", false); }}>
            <X size={13} />
          </button>
        </div>
      )}

      <div className="ws-playerbody"
           onDoubleClick={() => pipShown && timelineHref && nav(timelineHref)}>
        <PreviewPlayer bare />
      </div>

      {pipShown && (
        <div className="ws-piptransport">
          <button className="ws-pipplay" onClick={toggle} title={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <span className="mono ws-piptc" ref={tcRef}>00:00.0</span>
          <span className="ws-pipbarwrap"
                onPointerDown={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const to = (cx: number) =>
                    seek(Math.min(1, Math.max(0, (cx - r.left) / r.width)) * durationMs);
                  to(e.clientX);
                  const move = (ev: PointerEvent) => to(ev.clientX);
                  const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}>
            <span ref={barRef} />
          </span>
          {timelineHref && (
            <button className="ws-pipback" title="Back to the timeline"
                    onClick={() => nav(timelineHref)}>
              open
            </button>
          )}
        </div>
      )}
    </div>
  );
}

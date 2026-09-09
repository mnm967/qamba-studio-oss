import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { mediaUrl } from "../../lib/supabase";
import TakesPopover from "./TakesPopover";
import BlockContextMenu from "./BlockContextMenu";
import BlockActionModal, { BlockModalMode } from "./BlockActionModal";
import { extractAndSaveClipFrame } from "../../lib/frameExtractor";
import type { Clip } from "../../lib/db/types";

const LABEL_W = 44;

function Ruler({ widthPx, pxPerMs }: { widthPx: number; pxPerMs: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const seek = usePlaybackStore((s) => s.seek);
  const beats = useTimelineStore((s) => s.beatsMs);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = widthPx * dpr;
    el.height = 26 * dpr;
    el.style.width = `${widthPx}px`;
    const ctx = el.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, widthPx, 26);
    // beat grid (faint)
    ctx.fillStyle = "rgba(255,180,84,0.35)";
    for (const b of beats) {
      const x = b * pxPerMs;
      if (x > widthPx) break;
      ctx.fillRect(x, 18, 1, 8);
    }
    // second ticks
    const stepMs = pxPerMs > 0.15 ? 500 : pxPerMs > 0.04 ? 1000 : 5000;
    ctx.fillStyle = "rgba(154,164,182,0.8)";
    ctx.font = "9.5px JetBrains Mono, monospace";
    for (let ms = 0; ms * pxPerMs < widthPx; ms += stepMs) {
      const x = ms * pxPerMs;
      ctx.fillRect(x, ms % 5000 === 0 ? 12 : 17, 1, ms % 5000 === 0 ? 14 : 9);
      if (ms % (stepMs * 2) === 0) {
        const s = ms / 1000;
        ctx.fillText(`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`, x + 3, 10);
      }
    }
  }, [widthPx, pxPerMs, beats]);
  return (
    <div
      className="tl-ruler"
      style={{ marginLeft: LABEL_W }}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        seek((e.clientX - r.left + e.currentTarget.parentElement!.parentElement!.scrollLeft * 0) / pxPerMs);
      }}
    >
      <canvas ref={canvas} />
    </div>
  );
}

function WaveCanvas({ peaks, width }: { peaks: number[]; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !peaks.length) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 40;
    el.width = width * dpr;
    el.height = h * dpr;
    const ctx = el.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, h);
    ctx.fillStyle = "rgba(120,220,160,0.65)";
    const n = Math.min(peaks.length, Math.max(16, Math.floor(width / 2)));
    for (let i = 0; i < n; i++) {
      const p = peaks[Math.floor((i / n) * peaks.length)] ?? 0;
      const bh = Math.max(1, p * (h - 6));
      ctx.fillRect((i / n) * width, (h - bh) / 2, 1.4, bh);
    }
  }, [peaks, width]);
  return <canvas className="clip-wave" ref={ref} />;
}

type Drag =
  | { kind: "move"; clipId: string; startX: number; origStart: number }
  | { kind: "trim-l" | "trim-r"; clipId: string; startX: number; orig: Clip };

export default function Timeline() {
  const store = useTimelineStore();
  const { tracks, clips, assets, pxPerMs, selectedClipId } = store;
  const playing = usePlaybackStore((s) => s.playing);
  const seek = usePlaybackStore((s) => s.seek);
  const onTick = usePlaybackStore((s) => s.onTick);
  const nowMs = usePlaybackStore((s) => s.nowMs);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [hover, setHover] = useState<{ clip: Clip; x: number; y: number; frac: number } | null>(null);
  const [takesFor, setTakesFor] = useState<{ clip: Clip; x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    clip: Clip; x: number; y: number; hasNext: boolean; nextClip: Clip | null;
  } | null>(null);
  const [blockModal, setBlockModal] = useState<{
    mode: BlockModalMode; clip: Clip; nextClip?: Clip | null;
  } | null>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hoverVideo = useRef<HTMLVideoElement>(null);

  const durationMs = store.durationMs();
  const widthPx = Math.max(800, (durationMs + 10_000) * pxPerMs);

  // playhead follows the RAF clock without React re-renders
  useEffect(
    () =>
      onTick((ms) => {
        if (playheadRef.current) playheadRef.current.style.left = `${LABEL_W + ms * pxPerMs}px`;
      }),
    [onTick, pxPerMs]
  );
  useEffect(() => {
    if (playheadRef.current) playheadRef.current.style.left = `${LABEL_W + nowMs() * pxPerMs}px`;
  }, [pxPerMs, nowMs]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      const pb = usePlaybackStore.getState();
      if (e.code === "Space") {
        e.preventDefault();
        pb.toggle();
      } else if (e.key === "s" || e.key === "S") {
        const at = pb.nowMs();
        const target = clips.find(
          (c) => at > c.t_start_ms + 80 && at < c.t_start_ms + c.duration_ms - 80 &&
            tracks.find((t) => t.id === c.track_id)?.kind === "video"
        );
        if (target) void store.splitAt(target.id, at);
      } else if (e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if ((e.key === "z" && (e.metaKey || e.ctrlKey) && e.shiftKey) || (e.key === "y" && e.ctrlKey)) {
        e.preventDefault();
        store.redo();
      } else if (e.key === "Z" && !e.metaKey && !e.ctrlKey) {
        store.zoomBy(1); // fit: reset zoom
      } else if (e.key === "ArrowLeft") {
        pb.seek(pb.nowMs() - (e.shiftKey ? 1000 : 1000 / 24));
      } else if (e.key === "ArrowRight") {
        pb.seek(pb.nowMs() + (e.shiftKey ? 1000 : 1000 / 24));
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedClipId) void store.removeClip(selectedClipId, e.shiftKey);
      } else if (e.key === "=" || e.key === "+") {
        store.zoomBy(1.3);
      } else if (e.key === "-") {
        store.zoomBy(1 / 1.3);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clips, tracks, selectedClipId, store]);

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: Clip, zone: "body" | "l" | "r") => {
      if (e.button !== 0) return;
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      store.select(clip.id);
      // One undo step for the whole drag: the moves below patch with
      // `undoable: false` and this bracket is what records them. Without it a
      // move or trim here was not undoable AT ALL — the entries were suppressed
      // per pointermove and nothing ever committed them.
      store.beginGesture(zone === "body" ? "Move clip" : "Trim clip");
      if (zone === "body") setDrag({ kind: "move", clipId: clip.id, startX: e.clientX, origStart: clip.t_start_ms });
      else setDrag({ kind: zone === "l" ? "trim-l" : "trim-r", clipId: clip.id, startX: e.clientX, orig: { ...clip } });
    },
    [store]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const dMs = (e.clientX - drag.startX) / pxPerMs;
      if (drag.kind === "move") {
        let next = Math.max(0, drag.origStart + dMs);
        const snapped = store.snap(next, { excludeClipId: drag.clipId });
        const clip = clips.find((c) => c.id === drag.clipId);
        const endSnap = store.snap(next + (clip?.duration_ms ?? 0), { excludeClipId: drag.clipId });
        if (Math.abs(snapped - next) <= Math.abs(endSnap - (next + (clip?.duration_ms ?? 0)))) {
          setSnapLine(snapped !== next ? snapped : null);
          next = snapped;
        } else {
          const shifted = endSnap - (clip?.duration_ms ?? 0);
          setSnapLine(shifted !== next ? endSnap : null);
          next = shifted;
        }
        store.patchClip(drag.clipId, { t_start_ms: Math.round(next) }, { undoable: false });
      } else {
        const o = drag.orig;
        if (drag.kind === "trim-l") {
          const delta = Math.max(-(o.in_ms ?? 0), Math.min(dMs, o.duration_ms - 200));
          store.patchClip(
            drag.clipId,
            {
              t_start_ms: Math.round(o.t_start_ms + delta),
              in_ms: Math.round((o.in_ms ?? 0) + delta),
              duration_ms: Math.round(o.duration_ms - delta),
            },
            { undoable: false }
          );
        } else {
          const srcMax = assets.get(o.asset_id)?.duration_ms ?? Infinity;
          const maxDur = srcMax - (o.in_ms ?? 0);
          const nextDur = Math.max(200, Math.min(o.duration_ms + dMs, maxDur));
          store.patchClip(
            drag.clipId,
            { duration_ms: Math.round(nextDur), out_ms: Math.round((o.in_ms ?? 0) + nextDur) },
            { undoable: false }
          );
        }
      }
    },
    [drag, pxPerMs, store, clips, assets]
  );

  const endDrag = useCallback(() => {
    store.endGesture();
    setDrag(null);
    setSnapLine(null);
  }, [store]);

  const laneClips = useMemo(() => {
    const m = new Map<string, Clip[]>();
    for (const t of tracks) m.set(t.id, []);
    for (const c of clips) m.get(c.track_id)?.push(c);
    return m;
  }, [tracks, clips]);

  return (
    <div className="tl-body" ref={bodyRef} onPointerMove={onPointerMove} onPointerUp={endDrag}>
      <div className="tl-inner" style={{ width: widthPx + LABEL_W }}>
        <Ruler widthPx={widthPx} pxPerMs={pxPerMs} />
        {tracks.map((t) => (
          <div key={t.id} className={`tl-lane ${t.kind}`}>
            <div className="tl-lane-label">{t.name ?? t.kind.toUpperCase()}</div>
            <div
              style={{ position: "absolute", inset: 0, left: LABEL_W }}
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                seek((e.clientX - r.left) / pxPerMs);
                store.select(null);
              }}
            >
              {(laneClips.get(t.id) ?? []).map((c) => {
                const asset = assets.get(c.asset_id);
                const peaks = (asset?.meta?.peaks as number[] | undefined) ?? [];
                const w = c.duration_ms * pxPerMs;
                return (
                  <div
                    key={c.id}
                    className={
                      "tl-clip" +
                      (t.kind === "audio" ? " audio-clip" : "") +
                      (selectedClipId === c.id ? " selected" : "")
                    }
                    style={{ left: c.t_start_ms * pxPerMs, width: Math.max(14, w) }}
                    onPointerDown={(e) => onClipPointerDown(e, c, "body")}
                    onDoubleClick={(e) => c.block_id && setTakesFor({ clip: c, x: e.clientX, y: e.clientY })}
                    onPointerEnter={(e) =>
                      t.kind === "video" && !drag && setHover({ clip: c, x: e.clientX, y: e.clientY, frac: 0.5 })
                    }
                    onPointerMove={(e) => {
                      if (drag || t.kind !== "video") return;
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setHover({ clip: c, x: e.clientX, y: r.top, frac: (e.clientX - r.left) / r.width });
                    }}
                    onPointerLeave={() => setHover(null)}
                    onContextMenu={(e) => {
                      if (t.kind !== "video") return;
                      e.preventDefault();
                      e.stopPropagation();
                      store.select(c.id);
                      const trackClips = (laneClips.get(t.id) ?? []).sort((a, b) => a.t_start_ms - b.t_start_ms);
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
                    {c.transition_in && <div className="transition-badge" />}
                    {t.kind === "audio" && peaks.length > 0 && <WaveCanvas peaks={peaks} width={Math.max(14, w)} />}
                    <span className="clip-label">{c.label ?? asset?.b2_key.split("/").pop()}</span>
                    <span className="clip-sub">{(c.duration_ms / 1000).toFixed(1)}s</span>
                    {(c.ops?.length ?? 0) > 0 && (
                      <div className="clip-ops">
                        {(c.ops ?? []).slice(0, 3).map((o, i) => (
                          <span key={i}>{o.op}</span>
                        ))}
                      </div>
                    )}
                    <div className="trim-handle l" onPointerDown={(e) => onClipPointerDown(e, c, "l")} />
                    <div className="trim-handle r" onPointerDown={(e) => onClipPointerDown(e, c, "r")} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="tl-playhead" ref={playheadRef} style={{ left: LABEL_W }} />
        {snapLine != null && <div className="tl-snapline" style={{ left: LABEL_W + snapLine * pxPerMs }} />}
      </div>

      {hover && !playing && !drag && (
        <div className="tl-hoverprev" style={{ left: hover.x + 14, top: Math.max(60, hover.y - 190) }}>
          <video
            ref={(el) => {
              if (!el) return;
              const asset = assets.get(hover.clip.asset_id);
              const url = asset ? mediaUrl(asset.b2_key) : null;
              if (url && el.src !== url) el.src = url;
              const local = ((hover.clip.in_ms ?? 0) + hover.frac * hover.clip.duration_ms) / 1000;
              if (Math.abs(el.currentTime - local) > 0.2) el.currentTime = local;
            }}
            muted
            playsInline
            preload="auto"
          />
          <div className="hp-meta">
            {hover.clip.label} · {(((hover.clip.in_ms ?? 0) + hover.frac * hover.clip.duration_ms) / 1000).toFixed(2)}s
            {hover.clip.block_id ? " · double-click for takes" : ""}
          </div>
        </div>
      )}
      {takesFor && (
        <TakesPopover
          clip={takesFor.clip}
          x={takesFor.x}
          y={takesFor.y}
          onClose={() => setTakesFor(null)}
        />
      )}
      {contextMenu && (
        <BlockContextMenu
          clip={contextMenu.clip}
          x={contextMenu.x}
          y={contextMenu.y}
          hasNextClip={contextMenu.hasNext}
          onClose={() => setContextMenu(null)}
          onAssemble={() => {
            if (contextMenu.clip.block_id) {
              useWorkspaceStore.getState().openModal({ kind: "takes", blockId: contextMenu.clip.block_id });
            }
          }}
          onRetake={() => {
            if (contextMenu.clip.block_id) {
              useWorkspaceStore.getState().openModal({ kind: "prompt", blockId: contextMenu.clip.block_id });
            }
          }}
          onCompareTakes={() => {
            if (contextMenu.clip.block_id) {
              setTakesFor({ clip: contextMenu.clip, x: contextMenu.x, y: contextMenu.y });
            }
          }}
          onSaveLastFrame={async () => {
            try {
              const a = assets.get(contextMenu.clip.asset_id);
              await extractAndSaveClipFrame(contextMenu.clip, a, "last");
            } catch (err) {
              console.error("Save last frame failed", err);
            }
          }}
          onAddBlockAfter={() => setBlockModal({ mode: "add_after", clip: contextMenu.clip })}
          onDuplicate={() => void useTimelineStore.getState().duplicateClip(contextMenu.clip.id)}
          onExtendBlock={() => setBlockModal({ mode: "extend", clip: contextMenu.clip })}
          onChainWithNext={() =>
            setBlockModal({ mode: "chain", clip: contextMenu.clip, nextClip: contextMenu.nextClip })
          }
        />
      )}

      {blockModal && (
        <BlockActionModal
          mode={blockModal.mode}
          clip={blockModal.clip}
          nextClip={blockModal.nextClip}
          onClose={() => setBlockModal(null)}
        />
      )}
    </div>
  );
}

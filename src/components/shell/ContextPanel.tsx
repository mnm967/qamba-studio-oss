// The left-hand context panel: one body for every rail button, functional —
// no empty placeholders. Panels: Shots (block tree, drag to lanes), Cast &
// references (draggable face/asset palette that feeds the generate dock),
// Audio & voice studio (TTS voiceover jobs into A1/A2/A3-ready assets),
// Render queue (live jobs + retry), Project settings
// (style presets, model defaults and the post-processing chain every clip
// inherits), Quick media bin (recent assets, drag to lanes).
//
// Mounted on every project view (Workspace.tsx), not just the timeline —
// the panels that need an episode show an empty state when there isn't one.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Check, ChevronDown, FolderOpen, Loader2, Mic, Music2,
  PanelLeft, Play, Plus, RefreshCw, RotateCcw, Square, Users, Wand2, X,
} from "lucide-react";
import Dropdown from "../ui/Dropdown";
import { LoraStack, styleLoras, validLoras } from "../ui/ImageModelPicker";
import TieredModelMenu, { type Quality } from "../ui/TieredModelMenu";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import { useMarkedCatalog } from "../../hooks/useSheetModels";
import PostChainToggles from "../ui/PostChainToggles";
import PostRefPicker from "../ui/PostRefPicker";
import PostOptionsPanel from "../ui/PostOptionsPanel";
import { activeOps, normalizePostOptions, POST_OP } from "../../lib/postChain";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { useJobCancel } from "../../hooks/useJobCancel";
import { useJobRetry, isRetryable } from "../../hooks/useJobRetry";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { supabase } from "../../lib/supabase";
import { assetUrl, loadAssets } from "../../lib/db/assets";
import { loadCatalog } from "../../lib/catalog";
import {
  enqueueJob, loadRecentJobs, queueBlockRender,
} from "../../lib/db/jobs";
import { createManualBlock } from "../../lib/db/director";
import {
  resolveDefaults, saveProjectSettings, STYLE_PRESETS, styleTextFor,
  type ProjectSettings, type StylePreset,
} from "../../lib/projectSettings";
import { useVideoLoras } from "../../hooks/useVideoLoras";
import { jobLabel, ST } from "../../lib/jobMeta";
import { displayBlockStatus } from "../../lib/staleBlocks";
import JobPromptModal, { JobPromptButton } from "./JobPromptModal";
import type {
  Asset, BibleEntry, BlockTake, Episode, GenerationBlock, Job, ModelCatalogRow,
} from "../../lib/db/types";
import { AudioVoiceStudio } from "./AudioVoiceStudio";
import JobPreview from "./JobPreview";
import { blockRef } from "../../../director/refs.js";
import { blockKind, blockLabel } from "../../lib/blockKind";

export { ST };


const TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const EMOTIONS = ["", "calm", "warm", "excited", "sad", "angry", "whisper", "urgent"];
const ASPECTS = ["16:9", "9:16", "1:1", "4:3"];

/** One clickable + draggable media row: thumb, name, meta, actions. */
function MediaRow({
  asset, label, sub, actions,
  onClick, onDragStart, playing, onPlay,
}: {
  asset: Asset;
  label: string;
  sub?: string;
  actions?: React.ReactNode;
  onClick?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  playing?: boolean;
  onPlay?: (a: Asset) => void;
}) {
  const url = assetUrl(asset);
  return (
    <div className="ws-shot" style={{ cursor: onClick ? "pointer" : "grab" }}
         draggable={!!onDragStart}
         onDragStart={onDragStart}
         onClick={onClick}
         title={onDragStart ? "Drag onto a timeline lane (A1–A3 for audio), or drop into the generate dock" : undefined}>
      <span className="th">
        {asset.kind === "audio"
          ? <i style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#5e6678" }}>
              {playing ? <Square size={10} /> : <Play size={10} />}
            </i>
          : asset.kind === "video"
            ? <video src={url ?? undefined} muted preload="metadata" playsInline
                     onLoadedMetadata={(e) => {
                       const v = e.currentTarget;
                       if (v.duration) v.currentTime = v.duration * 0.35;
                     }} />
            : <img src={url ?? undefined} alt="" loading="lazy" />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="nm">{label}</span>
        <span className="mt">{sub ?? asset.kind}</span>
      </span>
      {asset.kind === "audio" && (
        <button className="act" title="Preview"
                onClick={(e) => { e.stopPropagation(); onPlay?.(asset); }}>
          {playing ? <Square size={10} /> : <Play size={10} />}
        </button>
      )}
      {actions}
    </div>
  );
}

/** Tiny inline audio player: one preview at a time, across the panel. */
function useAudioPreview() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const toggle = (a: Asset) => {
    if (playingId === a.id) { audioRef.current?.pause(); audioRef.current = null; setPlayingId(null); return; }
    audioRef.current?.pause();
    const el = new Audio(assetUrl(a) ?? undefined);
    el.onended = () => { setPlayingId(null); audioRef.current = null; };
    audioRef.current = el;
    void el.play().catch(() => setPlayingId(null));
    setPlayingId(a.id);
  };
  useEffect(() => () => { audioRef.current?.pause(); }, []);
  return { playingId, toggle };
}

const dragData = (e: React.DragEvent, asset: Asset) => {
  e.dataTransfer.setData("application/x-qamba-asset", asset.id);
  e.dataTransfer.effectAllowed = "copy";
};

interface ShotHover {
  blockId: string;
  rect: DOMRect;
  asset: Asset;
  label: string;
  sub?: string;
}

export default function ContextPanel({ episode, projectId }: { episode: Episode | null; projectId: string }) {
  const ws = useWorkspaceStore();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [note, setNote] = useState<{ msg: string; bad: boolean } | null>(null);
  const select = useTimelineStore((s) => s.select);
  const clips = useTimelineStore((s) => s.clips);
  const tlAssets = useTimelineStore((s) => s.assets);
  const { playingId, toggle } = useAudioPreview();

  const [shotHover, setShotHover] = useState<ShotHover | null>(null);
  const shotHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openShotHover = (h: Omit<ShotHover, "rect">, el: HTMLElement) => {
    if (shotHoverTimer.current) clearTimeout(shotHoverTimer.current);
    const rect = el.getBoundingClientRect();
    shotHoverTimer.current = setTimeout(() => setShotHover({ ...h, rect }), 120);
  };
  const closeShotHover = () => {
    if (shotHoverTimer.current) clearTimeout(shotHoverTimer.current);
    shotHoverTimer.current = setTimeout(() => setShotHover(null), 140);
  };
  const holdShotHover = () => {
    if (shotHoverTimer.current) clearTimeout(shotHoverTimer.current);
  };

  const { data, reload } = useLiveQuery(
    async () => {
      // The bible and the storyboard chain are independent of the first round
      // and of each other — both ride it rather than adding sequential hops.
      const [catalog, jobs, settingsRow, recent, { data: bibleRows }, sbsRes] = await Promise.all([
        loadCatalog(),
        loadRecentJobs(60),
        supabase.from("projects").select("settings,style,title").eq("id", projectId).maybeSingle(),
        loadAssets({ projectId, limit: 24 }),
        supabase.from("bible_entries").select("*").eq("project_id", projectId).order("kind").order("name"),
        episode
          ? supabase.from("storyboards").select("id").eq("episode_id", episode.id)
              .order("created_at", { ascending: false }).limit(1)
          : Promise.resolve({ data: null }),
      ]);
      let blocks: GenerationBlock[] = [];
      let takes: BlockTake[] = [];
      if (episode) {
        const sbs = sbsRes.data;
        blocks = sbs?.length
          ? ((await supabase.from("generation_blocks").select("*")
              .eq("storyboard_id", sbs[0].id).order("idx")).data ?? []) as GenerationBlock[]
          : [];
        const blockIds = blocks.map((b) => b.id);
        const takeIds = blocks.map((b) => b.active_take_id).filter(Boolean) as string[];
        if (blockIds.length > 0) {
          const { data: bTakes } = await supabase.from("block_takes").select("*").in("block_id", blockIds);
          takes = (bTakes ?? []) as BlockTake[];
          const foundIds = new Set(takes.map((t) => t.id));
          const missingActiveIds = takeIds.filter((id) => !foundIds.has(id));
          if (missingActiveIds.length > 0) {
            const { data: moreTakes } = await supabase.from("block_takes").select("*").in("id", missingActiveIds);
            if (moreTakes?.length) takes = [...takes, ...(moreTakes as BlockTake[])];
          }
        }
      }
      const entries = (bibleRows ?? []) as BibleEntry[];
      const { data: links } = entries.length
        ? await supabase.from("bible_assets").select("*").in("entry_id", entries.map((e) => e.id)).order("slot")
        : { data: [] };
      const jobsAll = (jobs ?? []) as Job[];
      const want = new Set<string>([
        ...takes.map((t) => t.asset_id),
        ...clips.map((c) => c.asset_id).filter(Boolean),
        ...(links ?? []).map((l) => l.asset_id),
        // Every kind the audio studio renders — its result rows resolve the
        // job's output through this map, so a kind missing here shows as a
        // permanently-"queued" row long after the render finished.
        ...jobsAll.filter((j) => j.kind === "tts" || j.kind === "sfx_gen"
          || j.kind === "music_gen")
          .map((j) => j.output_asset_id).filter(Boolean) as string[],
      ]);
      const wantList = [...want];
      let wantRows: Asset[] = [];
      if (wantList.length > 0) {
        const chunkSize = 80;
        const chunks: string[][] = [];
        for (let i = 0; i < wantList.length; i += chunkSize) {
          chunks.push(wantList.slice(i, i + chunkSize));
        }
        const resList = await Promise.all(
          chunks.map((chunk) => supabase.from("assets").select("*").in("id", chunk))
        );
        wantRows = resList.flatMap((r) => (r.data ?? []) as Asset[]);
      }
      return {
        blocks,
        takeById: new Map(takes.map((t) => [t.id, t])),
        takeByBlockId: new Map(takes.map((t) => [t.block_id, t])),
        assetById: new Map((wantRows as Asset[] | null ?? []).map((a) => [a.id, a])),
        entries, links: (links ?? []) as { entry_id: string; asset_id: string; role: string }[],
        jobs: jobsAll,
        // `.data`, not the builder: awaiting a PostgREST query yields the
        // {data, error} envelope, so indexing it as if it were the rows gives
        // undefined every time. This panel therefore never read the project's
        // saved settings at all — it rendered resolveDefaults({}), i.e. the
        // built-in defaults, and no style preset ever showed as Active on a
        // project that had one. Silent, because "the app's default" and "your
        // saved choice" look identical until you save something and watch it
        // not stick.
        settings: ((settingsRow.data as { settings?: ProjectSettings } | null)?.settings ?? {}) as ProjectSettings,
        projectStyle: (settingsRow.data as { style?: string } | null)?.style ?? null,
        projectTitle: (settingsRow.data as { title?: string } | null)?.title ?? null,
        catalog: (catalog ?? []) as ModelCatalogRow[],
        recent: (recent ?? []) as Asset[],
      };
    },
    ["generation_blocks", "block_takes", "storyboards", "jobs", "bible_entries",
     "bible_assets", "assets", "projects"],
    [episode?.id, projectId]
  );

  if (!ws.panelOpen) return null;

  const blocks = data?.blocks ?? [];
  const kept = blocks.filter((b) => b.status === "generated").length;
  const totalMs = blocks.length ? blocks[blocks.length - 1].t_end_ms : 0;
  const jobFor = (id: string) =>
    (data?.jobs ?? []).find((j) => (j.payload as { block_id?: string })?.block_id === id);
  const clipForBlock = (id: string) => clips.find((c) => c.block_id === id);
  const assetsOf = (entryId: string): Asset[] =>
    (data?.links ?? []).filter((l) => l.entry_id === entryId)
      .map((l) => data?.assetById.get(l.asset_id)).filter((a): a is Asset => !!a);
  const faceOf = (entry: BibleEntry): Asset | null => {
    const list = assetsOf(entry.id);
    if (!list.length) return null;
    const role = (id: string) => data?.links.find((l) => l.asset_id === id)?.role;
    if (entry.kind === "character") {
      return list.find((a) => role(a.id) === "face") ?? list.find((a) => role(a.id) === "master") ?? list[0];
    }
    return list.find((a) => role(a.id) === "master") ?? list[0];
  };
  const ttsJobs = (data?.jobs ?? []).filter((j) => j.kind === "tts").slice(0, 8);
  const cast = (data?.entries ?? []).filter((e) => e.kind === "character");
  const locations = (data?.entries ?? []).filter((e) => e.kind === "environment");
  const otherEntries = (data?.entries ?? []).filter((e) => e.kind !== "character" && e.kind !== "environment");
  const libraryHref = episode
    ? `/project/${projectId}/ep/${episode.id}/library` : "/library";

  const panelTitle: Record<string, string> = {
    shots: `Shots${episode ? ` · ${episode.code}` : ""}`,
    refs: "Cast & references", audio: "Audio & voice studio",
    queue: "Render queue & GPU", models: "Project settings", library: "Quick media bin",
  };
  const say = (msg: string, bad = true) => setNote({ msg, bad });

  return (
    <aside className="ws-panel ns-scroll">
      <div className="ws-panel-head">
        <span className="ws-mlabel">{panelTitle[ws.panel] ?? "Panel"}</span>
        {ws.panel === "refs" && !!ws.refShelf.length && (
          <span className="ws-pill" title="References queued for the generate composer (opens on the library view)">
            <Plus size={10} /> {ws.refShelf.length}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button title="Collapse" onClick={() => ws.toggle("panelOpen")}><PanelLeft size={13} /></button>
      </div>

      {note && (
        <div className={"ws-panelnote " + (note.bad ? "bad" : "ok")} onClick={() => setNote(null)}>
          {note.msg}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════ SHOTS ═══════════ */}
      {ws.panel === "shots" && (
        episode ? (
          <>
            <div style={{ padding: "11px 12px 6px", display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 12.5, color: "#9aa4b6" }}>
                  {blocks.length} blocks · {(totalMs / 1000).toFixed(1)}s
                </span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "#6fd08c" }}>{kept} kept</span>
              </div>
              <div className="ws-shotbar">
                {blocks.map((b) => <span key={b.id} style={{ background: ST[jobFor(b.id)?.status === "running" ? "generating"
                                          : jobFor(b.id)?.status === "queued" ? "queued"
                                          : displayBlockStatus(b.status, !!b.active_take_id)] ?? "#5b6478" }} />)}
              </div>
            </div>

            <div style={{ padding: "6px 8px 14px", display: "flex", flexDirection: "column", gap: 3 }}>
              {blocks.map((b) => {
                const clip = clipForBlock(b.id);
                const take = (b.active_take_id ? data?.takeById.get(b.active_take_id) : null)
                  ?? (clip?.take_id ? data?.takeById.get(clip.take_id) : null)
                  ?? data?.takeByBlockId?.get(b.id)
                  ?? null;
                const asset = (take ? data?.assetById.get(take.asset_id) ?? tlAssets.get(take.asset_id) : null)
                  ?? (clip?.asset_id ? tlAssets.get(clip.asset_id) ?? data?.assetById.get(clip.asset_id) : null)
                  ?? null;
                const job = jobFor(b.id);
                const dur = ((b.t_end_ms - b.t_start_ms) / 1000).toFixed(1);
                const mode = b.mode ?? "r2v";
                const isVid = !asset || asset.kind === "video" || asset.kind === "render"
                  || (asset.content_type && asset.content_type.startsWith("video/"));
                // The job row is ahead of the block row: the worker only writes
                // `generating` when it claims. Read the job first so a block that
                // is genuinely waiting doesn't sit there saying "planned".
                //
                // `displayBlockStatus` is what keeps `stale` off this rail: the
                // take on the row IS the take that rendered, and colouring it
                // purple while you edit says something is wrong with a shot
                // that is fine. Stale lives on the storyboard and on the
                // director's banner — see lib/staleBlocks.
                const st = job?.status === "running" ? "generating"
                  : job?.status === "queued" && b.status !== "generating" ? "queued"
                  : displayBlockStatus(b.status, !!b.active_take_id);
                return (
                  <button key={b.id} className={"ws-shot" + (clip && clip.id === useTimelineStore.getState().selectedClipId ? " on" : "")}
                          draggable={!!b.active_take_id}
                          onDragStart={(e) => {
                            e.dataTransfer.setData("application/x-qamba-block", b.id);
                            e.dataTransfer.effectAllowed = "copy";
                          }}
                          onPointerEnter={(e) => {
                            if (asset) {
                              openShotHover({
                                blockId: b.id,
                                asset,
                                label: blockLabel(blockKind(b), b.idx),
                                sub: `${blockRef(b.idx)} · ${dur}s · ${st === "generated" ? mode : st}`,
                              }, e.currentTarget);
                            }
                          }}
                          onPointerLeave={closeShotHover}
                          title={b.active_take_id
                            ? (clip ? "Click to select its clip · drag onto a lane to place another copy"
                                    : "Click to open takes · drag onto a timeline lane")
                            : "Click to open prompt & references"}
                          onClick={() => {
                            if (clip) {
                              select(clip.id);
                              if (!ws.inspOpen) ws.set("inspOpen", true);
                              return;
                            }
                            ws.openModal(b.active_take_id
                              ? { kind: "takes", blockId: b.id }
                              : { kind: "prompt", blockId: b.id });
                          }}>
                    <span className="th" style={st === "planned" ? { borderStyle: "dashed" } : undefined}>
                      {asset && (
                        isVid ? (
                          <video
                            src={assetUrl(asset) ?? undefined}
                            muted
                            preload="metadata"
                            playsInline
                            onLoadedMetadata={(e) => {
                              const v = e.currentTarget;
                              if (v.duration) v.currentTime = v.duration * 0.35;
                            }}
                          />
                        ) : (
                          <img src={assetUrl(asset) ?? undefined} alt="" loading="lazy" />
                        )
                      )}
                      {st !== "planned" && <i style={{ background: ST[st] ?? "#5b6478" }} />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {/* "Extension 19", "Chain 17", "Block 20": the same noun
                          the lane and the director use. Every row read "Block"
                          here, so an extension the timeline made sat between
                          two shots indistinguishable from them — and the one
                          fact that explains its length and its i2v mode was
                          missing from the only list that names every block. */}
                      <span className="nm" style={st === "planned" ? { color: "#9aa4b6" } : undefined}>
                        {blockLabel(blockKind(b), b.idx)}
                      </span>
                      <span className="mt" style={st === "generating" ? { color: "#5aa2ff" } : st === "failed" ? { color: "#ff8080" } : undefined}>
                        {blockRef(b.idx)} · {dur}s · {st === "generated" ? mode : st}
                      </span>
                    </span>
                    {job?.status === "running" && <Loader2 size={12} className="ns-spin" style={{ color: "#e8c268" }} />}
                    <span className="act" title="Choose take from library"
                          onClick={(e) => { e.stopPropagation(); ws.openModal({ kind: "pickTake", blockId: b.id, clipId: clip?.id }); }}>
                      <FolderOpen size={11} />
                    </span>
                    <span className="act" title="Prompt & references"
                          onClick={(e) => { e.stopPropagation(); ws.openModal({ kind: "prompt", blockId: b.id }); }}>
                      <Wand2 size={11} />
                    </span>
                    {/* Retry, for a job that ERRORED. A stale block deliberately
                        gets none: its take rendered fine, and re-rendering it is
                        a plan decision made on the storyboard or through the
                        director's review popup, where the other blocks it
                        chains with are on screen too. */}
                    {b.status === "failed" && (
                      <span className="act" style={{ color: "#ff8080" }}
                            title="Retry render"
                            onClick={(e) => {
                              e.stopPropagation();
                              queueBlockRender(b.id, {
                                project_id: projectId, episode_id: episode.id, model_id: "h3-local",
                                payload: { auto_activate: true },
                              }).catch(console.error);
                            }}>
                        <RefreshCw size={11} />
                      </span>
                    )}
                  </button>
                );
              })}
              {!blocks.length && (
                <div className="ws-empty" style={{ margin: 4 }}>
                  No blocks yet — plan a storyboard, or add one by hand below.
                </div>
              )}
              <div style={{ display: "flex", gap: 6, margin: "8px 4px 4px" }}>
                <button className="ws-dashbtn" style={{ flex: 1 }}
                        disabled={adding}
                        title="Creates a chained 8s block and opens its prompt & references"
                        onClick={async () => {
                          setAdding(true);
                          try {
                            const { blockId } = await createManualBlock({ episodeId: episode.id });
                            ws.openModal({ kind: "prompt", blockId });
                          } catch (e) {
                            setAddErr(String((e as Error).message || e).slice(0, 140));
                          } finally { setAdding(false); }
                        }}>
                  {adding ? <Loader2 size={12} className="ns-spin" /> : <Plus size={12} />}
                  {adding ? "Adding…" : "New block"}
                </button>
                <button className="ws-dashbtn" style={{ flex: 1 }}
                        disabled={adding}
                        title="Creates a new block and opens library picker to choose a take"
                        onClick={async () => {
                          setAdding(true);
                          try {
                            const { blockId } = await createManualBlock({ episodeId: episode.id });
                            ws.openModal({ kind: "pickTake", blockId });
                          } catch (e) {
                            setAddErr(String((e as Error).message || e).slice(0, 140));
                          } finally { setAdding(false); }
                        }}>
                  <FolderOpen size={12} />
                  From Library
                </button>
              </div>
              {addErr && (
                <div className="mono" style={{ margin: "0 4px", fontSize: 10.5, color: "#ff8080", lineHeight: 1.5 }}>
                  {addErr}
                </div>
              )}
            </div>

            <div className="ws-hdiv" />
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="ws-mlabel">In this episode</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {cast.map((c) => {
                  const face = faceOf(c);
                  return (
                    <span key={c.id} className="ws-pill" title={`${c.name} — open in the bible`}
                          onClick={() => ws.openModal({ kind: "entry", entryId: c.id })}
                          style={{ cursor: "pointer" }}>
                      <i>{face && <img src={assetUrl(face) ?? undefined} alt="" />}</i>
                      {c.name}
                    </span>
                  );
                })}
                {!cast.length && <span style={{ fontSize: 12, color: "#5e6678" }}>No cast yet.</span>}
              </div>
            </div>

          </>
        ) : (
          <div style={{ padding: 12 }}><div className="ws-empty">Open an episode to see its blocks.</div></div>
        )
      )}

      {/* ═══════════════════════════ CAST & REFERENCE PALETTE ═══════════════ */}
      {ws.panel === "refs" && (
        <div style={{ padding: "8px 12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="ws-refs-intro">
            Drag a face or sheet onto a timeline lane, or drop it into the generate
            composer as a reference. The "+" queues one for the composer.
          </div>

          {ws.refShelf.length > 0 && (
            <div className="ws-shelfbar">
              <span className="mono">
                {ws.refShelf.length} reference{ws.refShelf.length === 1 ? "" : "s"} queued for the composer
              </span>
              <span style={{ flex: 1 }} />
              <button className="ws-microbtn sq" title="Clear the queue"
                      onClick={() => ws.clearShelf()}><X size={11} /></button>
            </div>
          )}

          <CastGroup title="Characters" entries={cast}
                     faceOf={faceOf} assetsOf={assetsOf} onDrag={dragData}
                     onOpen={(id) => ws.openModal({ kind: "entry", entryId: id })} />
          <CastGroup title="Environments" entries={locations}
                     faceOf={faceOf} assetsOf={assetsOf} onDrag={dragData}
                     onOpen={(id) => ws.openModal({ kind: "entry", entryId: id })} />
          <CastGroup title="Props & more" entries={otherEntries}
                     faceOf={faceOf} assetsOf={assetsOf} onDrag={dragData}
                     onOpen={(id) => ws.openModal({ kind: "entry", entryId: id })} />

          <button className="ws-refs-cta" onClick={() => ws.openModal({ kind: "newEntry", entryKind: "character" })}>
            <Plus size={13} /> New cast or world entry
          </button>
          <button className="ws-refs-link" onClick={() => nav(libraryHref)}>
            open the generate composer <span style={{ fontSize: 13 }}>→</span>
          </button>
        </div>
      )}

      {/* ═══════════════════════════ AUDIO & VOICE STUDIO ═══════════════════ */}
      {ws.panel === "audio" && (
        <AudioVoiceStudio
          projectId={projectId}
          say={say}
          jobs={data?.jobs ?? []}
          assetById={data?.assetById}
          cast={cast}
          catalog={data?.catalog ?? []}
          recentAssets={data?.recent ?? []}
          playingId={playingId}
          toggle={toggle}
          onDrag={dragData}
          onOpen={(id) => ws.openModal({ kind: "asset", assetId: id })}
          llmBackend={data?.settings.director_backend || "auto"}
        />
      )}

      {/* ═══════════════════════════ RENDER QUEUE & GPU ═══════════════════════ */}
      {ws.panel === "queue" && (
        <div style={{ padding: "8px 12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Admin-only, the same rule as TopBar's chip: this is the second
              start/stop surface in the app and it is the studio's own machine
              on the studio's own card. A member's queue below is unchanged. */}
          <QueueList jobs={data?.jobs ?? []} say={say} />
        </div>
      )}

      {/* ═══════════════════════════ PROJECT SETTINGS ═════════════════════════ */}
      {ws.panel === "models" && (
        <div style={{ padding: "8px 12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <ModelsPanel projectId={projectId} settings={data?.settings}
                       projectTitle={data?.projectTitle ?? null}
                       projectStyle={data?.projectStyle ?? null}
                       catalog={data?.catalog ?? []} say={say}
                       reload={reload} />
        </div>
      )}

      {/* ═══════════════════════════ QUICK MEDIA BIN ═══════════════════════════ */}
      {ws.panel === "library" && (
        <MediaBin assets={data?.recent ?? []} libraryHref={libraryHref}
                  playingId={playingId} toggle={toggle}
                  onDrag={dragData} onOpen={(id) => ws.openModal({ kind: "asset", assetId: id })} />
      )}

      {shotHover && createPortal(
        (() => {
          const W = 300;
          const H = 224;
          const a = shotHover.asset;
          const isVid = a && (a.kind === "video" || a.kind === "render"
            || (a.content_type && a.content_type.startsWith("video/")));

          let left = shotHover.rect.right + 10;
          if (left + W > window.innerWidth - 10) {
            left = Math.max(10, shotHover.rect.left - W - 10);
          }
          let top = shotHover.rect.top + shotHover.rect.height / 2 - H / 2;
          top = Math.max(10, Math.min(window.innerHeight - H - 10, top));

          return (
            <div className="ws-hover ns-l2 ns-pop"
                 onPointerEnter={holdShotHover}
                 onPointerLeave={closeShotHover}
                 style={{
                   position: "fixed",
                   left,
                   top,
                   width: W,
                   zIndex: 100,
                 }}>
              <div style={{ position: "relative", aspectRatio: "16/9", background: "#000", overflow: "hidden" }}
                   onPointerMove={(e) => {
                     if (!isVid) return;
                     const v = e.currentTarget.querySelector("video");
                     const bar = e.currentTarget.querySelector<HTMLElement>("[data-bar]");
                     if (!v?.duration) return;
                     const r = e.currentTarget.getBoundingClientRect();
                     const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
                     v.currentTime = f * v.duration;
                     if (bar) bar.style.width = `${f * 100}%`;
                   }}>
                {isVid ? (
                  <video src={assetUrl(a) ?? undefined} muted preload="metadata" playsInline
                         onLoadedMetadata={(e) => {
                           const v = e.currentTarget;
                           if (v.duration) v.currentTime = v.duration * 0.35;
                         }}
                         style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                ) : (
                  <img src={assetUrl(a) ?? undefined} alt=""
                       style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                )}
                {isVid && (
                  <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: "rgba(255,255,255,.16)" }}>
                    <span data-bar style={{ display: "block", height: "100%", width: "35%", background: "#eaeef6" }} />
                  </div>
                )}
                <span className="mono" style={{ position: "absolute", left: 9, top: 9, padding: "4px 8px", borderRadius: 10,
                                                background: "rgba(7,9,14,.72)", backdropFilter: "blur(12px)",
                                                fontSize: 10.5, fontWeight: 600, color: "#eaeef6" }}>
                  {shotHover.label}{isVid ? " · scrub to preview" : ""}
                </span>
              </div>
              <div style={{ padding: 11, display: "flex", gap: 7 }}>
                <button style={{ flex: 1, height: 34, borderRadius: 14, border: "1px solid rgba(90,162,255,.45)",
                                 background: "rgba(90,162,255,.11)", color: "#5aa2ff",
                                 fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                        onClick={() => {
                          closeShotHover();
                          ws.openModal({ kind: "takes", blockId: shotHover.blockId });
                        }}>
                  Open takes
                </button>
                <button title="Prompt & references"
                        style={{ width: 34, height: 34, borderRadius: 14, border: "1px solid rgba(255,255,255,.08)",
                                 background: "rgba(255,255,255,.04)", color: "#9aa4b6",
                                 display: "grid", placeItems: "center", cursor: "pointer" }}
                        onClick={() => {
                          closeShotHover();
                          ws.openModal({ kind: "prompt", blockId: shotHover.blockId });
                        }}>
                  <Wand2 size={14} />
                </button>
                <button title="Choose take from library"
                        style={{ width: 34, height: 34, borderRadius: 14, border: "1px solid rgba(255,255,255,.08)",
                                 background: "rgba(255,255,255,.04)", color: "#9aa4b6",
                                 display: "grid", placeItems: "center", cursor: "pointer" }}
                        onClick={() => {
                          closeShotHover();
                          ws.openModal({ kind: "pickTake", blockId: shotHover.blockId });
                        }}>
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>
          );
        })(),
        document.body
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ refs --- */

function CastGroup({ title, entries, faceOf, assetsOf, onDrag, onOpen }: {
  title: string;
  entries: BibleEntry[];
  faceOf: (e: BibleEntry) => Asset | null;
  assetsOf: (id: string) => Asset[];
  onDrag: (e: React.DragEvent, a: Asset) => void;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!entries.length) return null;

  const statusClass = (s?: string) =>
    s === "draft" ? "draft" : s === "wip" || s === "in progress" ? "wip" : "";

  return (
    <div className="ws-refs-group">
      <div className="ws-refs-group-head" onClick={() => setOpen(!open)}>
        <ChevronDown size={13} className={`ws-refs-chevron ${open ? "open" : "closed"}`} />
        <span className="ws-mlabel">{title}</span>
        <span className="ws-refs-count">{entries.length}</span>
      </div>
      {open && entries.map((e) => {
        const face = faceOf(e);
        const sheets = assetsOf(e.id);
        return (
          <div key={e.id} className="ws-refcard" onClick={() => onOpen(e.id)}>
            {/* Hero image */}
            <div className="ws-refcard-hero"
                 draggable={!!face}
                 onDragStart={face ? (ev) => { ev.stopPropagation(); onDrag(ev, face); } : undefined}
                 title={face ? "Drag the face as a reference" : "No sheet image yet"}>
              {face && <img src={assetUrl(face) ?? undefined} alt="" loading="lazy" />}
              <div className="ws-refcard-hero-overlay" />
            </div>
            {/* Info bar */}
            <div className="ws-refcard-info">
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="nm">{e.name}</span>
                <span className="mt">{sheets.length} sheet{sheets.length === 1 ? "" : "s"}</span>
              </span>
              {e.status && (
                <span className={`ws-refcard-status ${statusClass(e.status)}`}>
                  {e.status}
                </span>
              )}
              <button className="ws-refcard-open" title="Open in the bible"
                      onClick={(ev) => { ev.stopPropagation(); onOpen(e.id); }}>
                <Users size={12} />
              </button>
            </div>
            {/* Sheet thumbnails */}
            {sheets.length > 0 && (
              <div className="ws-refstrip">
                {sheets.map((a) => (
                  <span key={a.id} className="ws-refth" draggable
                        onDragStart={(ev) => { ev.stopPropagation(); onDrag(ev, a); }}
                        onClick={(ev) => ev.stopPropagation()}
                        title="Drag as a reference, or + to queue it for the composer">
                    <img src={assetUrl(a) ?? undefined} alt="" loading="lazy" />
                    <i className="add" title="Queue into the generate composer"
                       onClick={(ev) => { ev.stopPropagation(); useWorkspaceStore.getState().shelfRef(a.id); }}>
                      <Plus size={9} />
                    </i>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- audio --- */

function VoiceStudio({ projectId, say, ttsJobs, assetsOfTts, playingId, toggle, onDrag, onOpen }: {
  projectId: string;
  say: (msg: string, bad?: boolean) => void;
  ttsJobs: Job[];
  assetsOfTts: (j: Job) => Asset | undefined;
  playingId: string | null;
  toggle: (a: Asset) => void;
  onDrag: (e: React.DragEvent, a: Asset) => void;
  onOpen: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("alloy");
  const [emotion, setEmotion] = useState("");
  const [busy, setBusy] = useState(false);

  const go = async () => {
    const line = text.trim();
    if (!line || busy) return;
    setBusy(true);
    try {
      await enqueueJob({
        kind: "tts", lane: "cpu", priority: 30, project_id: projectId,
        payload: { text: line, voice, ...(emotion ? { emotion } : {}) },
      });
      setText("");
      say("Voiceover queued — it lands in Recent voiceovers below and in the library.", false);
    } catch (e) {
      say(`Could not queue: ${String((e as Error).message).slice(0, 120)}`);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="ws-mlabel">Voiceover</span>
      <textarea className="ws-input ns-scroll" rows={3} value={text}
                placeholder="Line to speak — dialogue or narration. One generation per line."
                onChange={(e) => setText(e.target.value)}
                style={{ fontSize: 12, lineHeight: 1.5, resize: "none" }} />
      <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
        <select className="ws-input mono" value={voice}
                onChange={(e) => setVoice(e.target.value)}
                style={{ flex: 1, height: 30, fontSize: 11.5 }}>
          {TTS_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="ws-input mono" value={emotion}
                onChange={(e) => setEmotion(e.target.value)}
                style={{ flex: 1, height: 30, fontSize: 11.5 }}>
          <option value="">emotion — none</option>
          {EMOTIONS.filter(Boolean).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <button className="ws-dashbtn" style={{ justifyContent: "center" }} disabled={!text.trim() || busy}
              onClick={() => void go()}>
        {busy ? <Loader2 size={12} className="ns-spin" /> : <Mic size={12} />}
        {busy ? "Queueing…" : "Generate voiceover"}
      </button>
      <div className="ws-inline-note">
        TTS runs on the worker (Fish Audio preferred, OpenAI fallback). The MP3
        lands as an audio asset — drag it onto A3 on the timeline.
      </div>

      {ttsJobs.length > 0 && (
        <>
          <span className="ws-mlabel" style={{ marginTop: 6 }}>Recent voiceovers</span>
          {ttsJobs.map((j) => {
            const a = assetsOfTts(j);
            const done = j.status === "done" && !!a;
            return (
              <div key={j.id} className="ws-shot" style={{ cursor: done ? "pointer" : "default" }}
                   title={done ? "Drag onto a lane, or click to open" : undefined}>
                <span className="th" draggable={done}
                      onDragStart={done ? (e) => onDrag(e, a) : undefined}
                      onClick={() => { if (done) onOpen(a.id); }}>
                  <i style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#5e6678" }}>
                    {j.status === "running" ? <Loader2 size={10} className="ns-spin" />
                      : j.status === "done" ? <Mic size={11} style={{ color: "#6fd08c" }} />
                      : j.status === "error" ? <X size={11} style={{ color: "#ff8080" }} /> : <Music2 size={11} />}
                  </i>
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="nm" style={{ whiteSpace: "normal", lineHeight: 1.35 }}>
                    {(j.payload as { text?: string })?.text?.slice(0, 42) ?? "voiceover"}
                  </span>
                  <span className="mt">
                    {j.status === "done" && a
                      ? `${a.duration_ms ? ((a.duration_ms / 1000).toFixed(1) + "s · ") : ""}${(a.meta as { provider?: string })?.provider ?? "tts"}`
                      : j.status === "running" ? (j.progress_note ?? "synth…")
                      : j.status === "error" ? (j.error_msg ?? "failed").slice(0, 40) : j.status}
                  </span>
                </span>
                {done && (
                  <>
                    <button className="act" title="Preview" onClick={() => toggle(a)}>
                      {playingId === a.id ? <Square size={10} /> : <Play size={10} />}
                    </button>
                    <button className="act" title="Open asset" onClick={() => onOpen(a.id)}>
                      <FolderOpen size={10} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      <div className="ws-hdiv" />
      <span className="ws-mlabel">Sound effects</span>
      <div className="ws-inline-note">
        The studio cloud renders image and video only — there is no SFX synthesis model
        installed, so nothing here would generate real sound. Use the H3 video
        composer for effects inside a clip (H3 carries native audio), or upload
        a royalty-free file in the library and drag it onto A2.
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- queue --- */

function QueueList({ jobs, say }: { jobs: Job[]; say: (msg: string, bad?: boolean) => void }) {
  const { cancel, cancelling } = useJobCancel();
  // The ID rather than the row, so the panel keeps tracking a job that is
  // claimed while it is open — see QueuePopover, same reasoning.
  const [inspectId, setInspectId] = React.useState<string | null>(null);
  const inspect = inspectId ? jobs.find((j) => j.id === inspectId) ?? null : null;
  const { retry, retrying, retriedCount } = useJobRetry(say);
  const ordered = [
    ...jobs.filter((j) => j.status === "running"),
    ...jobs.filter((j) => j.status === "queued"),
    ...jobs.filter((j) => j.status !== "queued" && j.status !== "running").slice(0, 10),
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="ws-mlabel">Jobs</span>
      {ordered.map((j) => {
        const live = j.status === "queued" || j.status === "running";
        const stopping = cancelling(j);
        const pctv = Math.round((j.status === "done" ? 1 : j.progress || 0) * 100);
        return (
          <div key={j.id} className={"ws-jobrow" + (j.status === "running" ? " run" : "")}>
            <div className="ws-jobhead">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="k" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                {j.status === "running" && <Loader2 size={12} className="ns-spin" style={{ color: "#e8c268" }} />}
                {jobLabel(j)}
                <span className="m">{j.model_id ?? ""}</span>
              </div>
              <div className="m" style={{ marginTop: 2, color: j.status === "error" ? "#ff8080" : undefined }}>
                {stopping ? "cancelling…"
                  : j.status === "error" ? (j.error_msg ?? "failed").slice(0, 70)
                  : j.status === "running" ? (j.progress_note ?? `${pctv}%`)
                  : j.status}
                {j.depends_on?.length && j.status === "queued" && !stopping
                  ? ` · waits on ${j.depends_on.length}` : ""}
              </div>
            </div>
            {j.eta_seconds != null && live && !stopping && (
              <span className="m">~{Math.round(j.eta_seconds / 60)}m</span>
            )}

            {isRetryable(j) && (
              <button className="ws-icobtn" style={{ width: 24, height: 24 }}
                      disabled={retrying(j.id) || retriedCount(j.id) > 0}
                      title={retriedCount(j.id)
                        ? `Requeued as ${retriedCount(j.id)} new job${retriedCount(j.id) > 1 ? "s" : ""}`
                        : "Retry — requeues this job and anything that failed with it"}
                      onClick={() => void retry(j)}>
                {retrying(j.id) ? <Loader2 size={11} className="ns-spin" />
                  : retriedCount(j.id) ? <Check size={11} style={{ color: "#6fd08c" }} />
                  : <RotateCcw size={11} />}
              </button>
            )}
            <JobPromptButton job={j} size={24} onOpen={() => setInspectId(j.id)} />
            {live && (
              <button className="ws-icobtn" style={{ width: 24, height: 24 }} disabled={stopping}
                      title={stopping ? "Cancelling — the worker stops at its next checkpoint" : "Cancel"}
                      onClick={() => cancel(j.id)}>
                {stopping ? <Loader2 size={12} className="ns-spin" /> : <X size={12} />}
              </button>
            )}
            </div>
            {j.status === "running" && <JobPreview job={j} />}
          </div>
        );
      })}
      {!jobs.length && <div className="ws-empty">No jobs yet.</div>}
      {inspect && (
        <JobPromptModal job={inspect} onClose={() => setInspectId(null)} onDone={say} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- models --- */

function ModelPickerDropdown({
  label, models, value, disabled, lorasCount = 0, onPick, quality, onQuality,
}: {
  label: string;
  models: ModelCatalogRow[];
  value: string;
  disabled?: boolean;
  lorasCount?: number;
  onPick: (id: string) => void;
  quality?: Quality | null;
  onQuality?: (q: Quality) => void;
}) {
  const current = models.find((m) => m.id === value);
  const enabledModels = models.filter((m) => m.enabled);
  const disabledModels = models.filter((m) => !m.enabled);

  return (
    <Dropdown width={264} align="left"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={`ws-model-select-btn ${open ? "open" : ""}`}
          onClick={toggle}
          disabled={disabled}
          title={current?.display_name ?? value}
        >
          <span className="ws-model-select-title mono">
            {current?.display_name ?? value}
            {lorasCount > 0 && (
              <span style={{ color: "#c97aff", marginLeft: 6, fontSize: 10.5 }}>
                · {lorasCount} LoRA{lorasCount === 1 ? "" : "s"}
              </span>
            )}
          </span>
          <ChevronDown
            size={13}
            style={{
              flex: "none",
              color: "#5e6678",
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.15s ease",
            }}
          />
        </button>
      )}>
      {(close) => (
        // The shared grouped menu — this was a flat enabled/disabled split
        // that named the provider but never said whether a row runs on the
        // pod, this machine, or someone else's API.
        <TieredModelMenu models={models} value={value} close={close} onPick={onPick}
                         quality={quality} onQuality={onQuality} />
      )}
    </Dropdown>
  );
}

function ModelsPanel({ projectId, settings: initialSettings, projectStyle: initialProjectStyle,
                      projectTitle, catalog, say, reload }: {
  projectId: string;
  settings: ProjectSettings | undefined;
  projectStyle: string | null;
  projectTitle: string | null;
  catalog: ModelCatalogRow[];
  say: (msg: string, bad?: boolean) => void;
  reload?: () => void;
}) {
  const engine = useLocalEngine();
  // ABOVE every early return, like the hooks around it. See `all` below.
  const marked = useMarkedCatalog(catalog);
  const [busy, setBusy] = useState(false);
  const [optimisticSettings, setOptimisticSettings] = useState<Partial<ProjectSettings> | null>(null);
  const [optimisticStyle, setOptimisticStyle] = useState<string | null>(null);

  // Clear the optimistic override once the server VALUE catches up — never on
  // mere prop identity. `initialSettings` is rebuilt fresh by every refetch of
  // this panel's nine-table query (a jobs tick, a pod heartbeat…), so keying
  // the reset on the object made any refetch — including one whose read
  // predated the save — throw the overlay away and snap the control back to
  // the old value for a beat. Same rule as useDragReorder: the optimistic
  // value stands until the server agrees with it.
  useEffect(() => {
    setOptimisticSettings((prev) => {
      if (!prev) return prev;
      const base = (initialSettings ?? {}) as Record<string, unknown>;
      const settled = Object.keys(prev).every(
        (k) => JSON.stringify(base[k] ?? null)
          === JSON.stringify((prev as Record<string, unknown>)[k] ?? null)
      );
      return settled ? null : prev;
    });
    setOptimisticStyle((prev) =>
      prev !== null && (initialProjectStyle ?? "") === prev ? null : prev);
  }, [initialSettings, initialProjectStyle]);

  const settings = useMemo(() => ({
    ...(initialSettings ?? {}),
    ...(optimisticSettings ?? {}),
  }), [initialSettings, optimisticSettings]);

  const currentProjectStyle = optimisticStyle !== null ? optimisticStyle : initialProjectStyle;

  const eff = useMemo(() => resolveDefaults(settings), [settings]);
  const styleText = styleTextFor(settings, currentProjectStyle);
  // The catalog PLUS whatever this machine has downloaded PLUS the rows a key
  // of YOURS re-enables, same as project settings, the new-project form and
  // the library's generate dock. Every one of these writes the same two
  // fields, so a plane one of them can set and another cannot name is a picker
  // showing a raw `local:…` id — or, which is what the missing byok half
  // actually did here, a model you hold the key for filed under STUDIO CLOUD,
  // where a member reads it as "coming soon" and cannot pick it at all.
  const all = [...marked, ...engine.rows];
  const imageModels = all.filter((m) => m.kind === "image");
  const videoModels = all.filter((m) => m.kind === "video");
  const selectedImageModel = imageModels.find((m) => m.id === eff.image_model);
  const availableLoras = styleLoras(selectedImageModel);
  // Wrapped so this machine's own downloaded adapters are offered on the row
  // an EPISODE renders from — see `useVideoLoras`.
  const selectedVideoModel = useVideoLoras(videoModels.find((m) => m.id === eff.video_model));
  const availableVideoLoras = styleLoras(selectedVideoModel);

  const isPresetActive = (p: StylePreset) => {
    if (styleText.text && styleText.text.trim() === p.guide.trim()) {
      return true;
    }
    if (styleText.source === "legacy" || !settings?.style_guide) {
      if (currentProjectStyle) {
        const s = currentProjectStyle.trim().toLowerCase();
        if (s === p.id.toLowerCase() || s === p.label.toLowerCase()) {
          return true;
        }
      }
    }
    return false;
  };

  const save = async (patch: Partial<ProjectSettings>, styleLabel?: string) => {
    setBusy(true);
    setOptimisticSettings((prev) => ({ ...(prev ?? {}), ...patch }));
    if (styleLabel !== undefined) {
      setOptimisticStyle(styleLabel);
    }
    try {
      await saveProjectSettings(projectId, patch);
      say("Saved as this project's default.", false);
      reload?.();
    } catch (e) {
      setOptimisticSettings(null);
      setOptimisticStyle(null);
      say(`Could not save: ${String((e as Error).message).slice(0, 110)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="ws-mlabel">Style presets</span>
        <div className="ws-preset-grid">
          {STYLE_PRESETS.map((p) => {
            const isActive = isPresetActive(p);
            return (
              <button key={p.id}
                      className={"ws-preset-card" + (isActive ? " on" : "")}
                      disabled={busy}
                      title={`${p.label}\n${p.guide}`}
                      onClick={() => void save({ style_guide: p.guide }, p.label)}>
                <img src={p.image} alt={p.label} className="ws-preset-card-img" />
                <div className="ws-preset-card-overlay" />
                <div className="ws-preset-card-content">
                  <span className="ws-preset-card-title">{p.label}</span>
                  {isActive && <span className="ws-preset-card-badge">Active</span>}
                </div>
              </button>
            );
          })}
        </div>
        {styleText.source === "guide" && !STYLE_PRESETS.some((p) => p.guide.trim() === styleText.text.trim()) && (
          <button className="ws-microbtn ghost" style={{ alignSelf: "flex-start" }}
                  title="The project has a hand-written guide — clear it to fall back to a preset"
                  onClick={() => void save({ style_guide: "" }, "")}>
            clear custom guide
          </button>
        )}
      </div>

      <div className="ws-hdiv" />

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <span className="ws-mlabel">Aspect default</span>
        <div className="ws-seg">
          {ASPECTS.map((a) => (
            <button key={a} className={eff.aspect === a ? "on" : ""} disabled={busy}
                    onClick={() => void save({ aspect: a })}>{a}</button>
          ))}
        </div>
        <div className="ws-inline-note">
          The generate dock opens on this aspect for this project.
        </div>
      </div>

      <div className="ws-hdiv" />

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <span className="ws-mlabel">Image model</span>
        <ModelPickerDropdown
          label="Image model"
          models={imageModels}
          value={eff.image_model}
          disabled={busy}
          lorasCount={validLoras(selectedImageModel, eff.image_loras).length}
          onPick={(id) => void save({ image_model: id })}
          quality={eff.image_quality}
          onQuality={(q) => void save({ image_quality: q })}
        />

        {availableLoras.length > 0 && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 6,
            padding: "8px 10px", borderRadius: 12,
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.06)",
            marginTop: 2, marginBottom: 2,
          }}>
            <LoraStack
              model={selectedImageModel}
              value={validLoras(selectedImageModel, eff.image_loras)}
              onChange={(v) => void save({ image_loras: v })}
              compact
            />
          </div>
        )}

        <span className="ws-mlabel" style={{ marginTop: 2 }}>Video model</span>
        <ModelPickerDropdown
          label="Video model"
          models={videoModels}
          value={eff.video_model}
          disabled={busy}
          lorasCount={validLoras(selectedVideoModel, eff.video_loras).length}
          onPick={(id) => void save({ video_model: id })}
        />

        {availableVideoLoras.length > 0 && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 6,
            padding: "8px 10px", borderRadius: 12,
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.06)",
            marginTop: 2, marginBottom: 2,
          }}>
            <LoraStack
              model={selectedVideoModel}
              value={validLoras(selectedVideoModel, eff.video_loras)}
              onChange={(v) => void save({ video_loras: v })}
              compact
            />
          </div>
        )}
      </div>

      <div className="ws-hdiv" />

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <span className="ws-mlabel">Post process</span>
        <PostChainToggles chain={eff.post} disabled={busy}
                          onChange={(next) => void save({ post: next })} />
        <PostOptionsPanel chain={eff.post} disabled={busy}
                          value={normalizePostOptions(settings)}
                          onChange={(patch) => void save(patch)} />
        {eff.post.color_match && (
          // Only when the pass is on. It is REQUIRED rather than optional —
          // without it the render fails rather than passing the clip through
          // ungraded — so it appears with the switch that needs it instead of
          // sitting in the settings as a slot with no consequence.
          <>
            <span className="ws-mlabel" style={{ marginTop: 2 }}>Grade reference</span>
            <PostRefPicker projectId={projectId} disabled={busy}
                           strength={Math.max(0, Math.min(1, Number(settings?.post_ref_strength ?? 1) || 0))}
                           onStrength={(v) => void save({ post_ref_strength: v })}
                           value={(settings?.post_ref_asset_id as string | null) ?? null}
                           onChange={(id) => void save({ post_ref_asset_id: id })}
                           mode={settings?.post_ref_mode === "asset" ? "asset" : "source"}
                           onMode={(m) => void save({ post_ref_mode: m })} />
          </>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------- library --- */

function MediaBin({ assets, libraryHref, playingId, toggle, onDrag, onOpen }: {
  assets: Asset[];
  libraryHref: string;
  playingId: string | null;
  toggle: (a: Asset) => void;
  onDrag: (e: React.DragEvent, a: Asset) => void;
  onOpen: (id: string) => void;
}) {
  const nav = useNavigate();
  const [kind, setKind] = useState<"all" | Asset["kind"]>("all");
  const shown = kind === "all" ? assets : assets.filter((a) => a.kind === kind);
  return (
    <div style={{ padding: "8px 12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="ws-mlabel">Project assets</span>
        <span style={{ flex: 1 }} />
        <button className="ws-microbtn ghost" style={{ height: 24 }} onClick={() => nav(libraryHref)}>
          open library
        </button>
      </div>
      <div className="ws-seg">
        {(["all", "image", "video", "audio"] as const).map((k) => (
          <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{k}</button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {shown.slice(0, 14).map((a) => (
          <MediaRow key={a.id} asset={a}
                    label={(a.meta as { original_name?: string })?.original_name
                      ?? `${a.kind} · ${a.duration_ms ? (a.duration_ms / 1000).toFixed(1) + "s" : (a.width ? `${a.width}×${a.height}` : "")}`}
                    sub={a.origin === "uploaded" ? "uploaded" : a.origin ?? a.kind}
                    playing={playingId === a.id}
                    onPlay={toggle}
                    onClick={() => onOpen(a.id)}
                    onDragStart={(e) => onDrag(e, a)} />
        ))}
        {!assets.length && <div className="ws-empty">Nothing here yet — generate or upload something.</div>}
      </div>
      <div className="ws-inline-note">
        Drag any item onto the timeline — video to V lanes, audio to A1–A3.
        Everything here also lives in the full library.
      </div>
    </div>
  );
}

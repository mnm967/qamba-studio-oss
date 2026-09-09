// The workspace shell, recreated from the Qamba Studio v2 design file. Every
// view lives in one desktop chrome; all data access reuses the existing db
// helpers, stores and job contracts — this is a presentation layer only.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Camera, Check, Clapperboard, ClipboardPaste, CopyPlus, Eye, EyeOff, FileText, FileUp,
  FolderOpen, Image as ImageIcon, Loader2, Maximize2, Music,
  Pause, Play, Plus, RotateCcw, PictureInPicture2, SkipBack, SkipForward,
  SlidersHorizontal, Sparkles, Trash2, Tv, Upload, X,
} from "lucide-react";
import TopBar, { WsView } from "../components/shell/TopBar";
import IconRail from "../components/shell/IconRail";
import GenComposer from "../components/shell/GenComposer";
import ContextPanel, { ST } from "../components/shell/ContextPanel";
import DirectorDock from "../components/shell/DirectorDock";
import QueuePopover from "../components/shell/QueuePopover";
import WsTimeline from "../components/shell/WsTimeline";
import TakesStrip from "../components/shell/TakesStrip";
import { PreviewFrame } from "../components/shell/JobPreview";
import InspectorRail from "../components/shell/InspectorRail";
import PlayerDock from "../components/shell/PlayerDock";
import StoryboardView from "../components/shell/StoryboardView";
import { setStageAnchor } from "../lib/stageAnchor";
import AssetDetailModal from "../components/modals/AssetDetailModal";
import AssetPickerModal from "../components/modals/AssetPickerModal";
// Routed, not mounted directly: a CLIP-BORN block (extend/chain — it has a
// stored render recipe and no beats) gets ClipRetakeModal, everything else
// the beats-path PromptRefsModal. The router decides so no opener has to.
import BlockRetakeRouter from "../components/modals/ClipRetakeModal";
import TakeAssemblyModal from "../components/modals/TakeAssemblyModal";
import BlockAudioModal from "../components/modals/BlockAudioModal";
import SceneEditorModal from "../components/modals/SceneEditorModal";
import NewEntryModal from "../components/modals/NewEntryModal";
import BibleEntryModal from "../components/modals/BibleEntryModal";
import LoreImportModal from "../components/modals/LoreImportModal";
import LoreDocModal from "../components/modals/LoreDocModal";
import ProjectSettingsModal from "../components/modals/ProjectSettingsModal";
import ModalShell from "../components/modals/ModalShell";
import DeleteProjectModal from "../components/modals/DeleteProjectModal";
import DeleteBibleEntryModal from "../components/modals/DeleteBibleEntryModal";
import NewProjectModal from "../components/modals/NewProjectModal";
import { useProjectRole } from "../hooks/useProjectRole";
// Lazy for the same reason as CivitaiImportModal below: at ~3,700 lines it is
// a real slice of the main chunk's parse time, and it is only ever needed when
// someone opens the one-shot wizard.
const WizardModal = React.lazy(() => import("../components/modals/WizardModal"));
import VideoPreviewThumb from "../components/ui/VideoPreviewThumb";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { emitTimelineNote, pasteClaimed } from "../lib/timelineSignals";
import { useTimelineStore } from "../stores/useTimelineStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { subscribeTables, useLiveQuery } from "../hooks/useLiveQuery";
import { useTimelineKeys } from "../hooks/useTimelineKeys";
import {
  createProject, loadEpisodes, loadProject, loadProjectCovers, loadProjects, mainEpisode,
} from "../lib/db/projects";
import type { ProjectCover } from "../lib/db/projects";
import {
  addTakeToBlock, deleteBibleEntry, loadBible, loadBibleAssets, storyboardsForEpisode,
} from "../lib/db/director";
import {
  loadExtractJobs, loadLoreDocs, loadProposalCounts,
} from "../lib/db/lore";
import {
  assetUrl, deleteAssets, loadAssetCounts, loadAssets, registerAsset, restoreAssets, trashAssets,
} from "../lib/db/assets";
import { probedUploadMeta } from "../lib/mediaProbe";
import {
  addToCollection, createCollection, deleteCollection, loadCollectionAssets,
  loadCollectionCounts, loadCollections, removeFromCollection, renameCollection,
  setCollectionHidden,
} from "../lib/db/collections";
import { clipboardMediaFiles, isEditableTarget, pasteChord, readClipboardMedia } from "../lib/clipboardMedia";
import { recipeFor } from "../lib/genRecipe";
import { frameAtPlayhead } from "../lib/playheadFrame";
import { extractAndSavePlayheadFrame } from "../lib/frameExtractor";
import { enqueueJob, loadPendingGenerations, queueTimelineRender, videoClips } from "../lib/db/jobs";
import { resolveDefaults, saveProjectSettings, type ProjectSettings } from "../lib/projectSettings";
import RenderSettingsModal from "../components/modals/RenderSettingsModal";
import { normalizeOutput, type RenderOutput } from "../lib/renderOutput";
import { normalizeChain, normalizePostOptions, type PostChain, type PostOptions }
  from "../lib/postChain";
import { ensureLanes, ensureTimeline, syncBlocksToTimeline, timelinesForEpisode } from "../lib/db/timeline";
import { rememberedCut } from "../lib/timelineCuts";
import { supabase, mediaUrl } from "../lib/supabase";
import { deleteMedia, uploadMedia } from "../lib/upload";
import type { Asset, Clip, ClipOp, Episode, Medium } from "../lib/db/types";
import "../styles/workspace.css";
import "../styles/timeline.css";

// Lazy where its siblings are not: this one inlines every ComfyUI template
// (~240KB of JSON) so it can analyse them without the pod, and that has no
// business in the main bundle for an admin-only tab.
const WorkflowsView = React.lazy(() => import("../components/shell/WorkflowsView"));
const CivitaiImportModal = React.lazy(() => import("../components/modals/CivitaiImportModal"));
const FirstRunSetupModal = React.lazy(() => import("../components/modals/FirstRunSetupModal"));
import { needsFirstRun } from "../components/modals/FirstRunSetupModal";
import { startLocalWorker } from "../lib/localWorker";
const EngineModal = React.lazy(() => import("../components/modals/EngineModal"));

function fmtTc(ms: number) {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

/* ═══════════════════════════════════════════════════════ timeline view ══ */
function TimelineView({ episode, projectId }: { episode: Episode; projectId: string }) {
  const ws = useWorkspaceStore();
  const store = useTimelineStore();
  const playing = usePlaybackStore((s) => s.playing);
  const toggle = usePlaybackStore((s) => s.toggle);
  const seek = usePlaybackStore((s) => s.seek);
  const onTick = usePlaybackStore((s) => s.onTick);
  const [sbId, setSbId] = useState<string | null>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const syncSig = React.useRef<string>("");
  // React hands the ref callback null on unmount, which is exactly the
  // "stage is gone -> go pip" signal. Doing it in an effect cleanup instead
  // races StrictMode's double-invoke and can null the anchor after the real
  // element attached, leaving the stage empty.
  const stageRef = React.useCallback((el: HTMLDivElement | null) => setStageAnchor(el), []);

  // Timecode via ref, PlayerDock-style. `setTc(ms)` here re-rendered this
  // whole view — WsTimeline's lanes, the takes strip, the inspector — at
  // 60fps for the length of every playback, which starved the decoders the
  // player was trying to feed (the "playback is choppy" main-thread half).
  useEffect(() => onTick((ms) => {
    const el = tcRef.current;
    if (!el) return;
    const s = fmtTc(ms);
    if (el.textContent !== s) el.textContent = s;
  }), [onTick]);
  useEffect(() => {
    // THE STORYBOARD ID IS DROPPED THE MOMENT THE EPISODE CHANGES, and it is
    // dropped HERE rather than at the bottom of this function, because the
    // pair (cut, storyboard) is what the auto-sync effect below hands to
    // `syncBlocksToTimeline` — and that lays whichever storyboard it is given
    // onto whichever cut it is given. This view is NOT remounted across a
    // project or episode switch (same route element, new params — the same
    // reason DirectorDock is keyed on the project id), so `sbId` is ordinary
    // component state that survives the switch, and it used to survive it in
    // two ways that both wrote the previous episode's blocks onto the new
    // episode's cut:
    //   - an episode with NO storyboard never reached `setSbId` at all (the
    //     old `if (sbs[0])`), so the previous one's id stood indefinitely
    //     while `tlId` had already moved to the new cut;
    //   - two loads in flight at once (switch, switch back, or just a slow
    //     first one) resolved in either order, and there was no cancellation,
    //     so one run's `store.load` could land between the other's `load` and
    //     its `setSbId`.
    // Measured on the live rows before this: 173 clips sitting on a cut whose
    // episode is not their block's, across 8 cuts in 6 projects. `null` is
    // safe to sit at — the sync effect early-returns without a storyboard.
    setSbId(null);
    let alive = true;
    (async () => {
      // The storyboard list depends on nothing in the timeline chain, so it
      // rides the first round trip instead of being a fifth sequential one.
      const [existing, sbs] = await Promise.all([
        timelinesForEpisode(episode.id),
        storyboardsForEpisode(episode.id),
      ]);
      if (!alive) return;
      // An episode can hold several cuts now, so "which one" is a question
      // with an answer: the one you were last looking at ON THIS MACHINE.
      // Checked against the list rather than loaded straight off — a cut
      // deleted in another tab is still remembered here, and `loadTimeline`
      // would throw on its `.single()`.
      const want = rememberedCut(episode.id);
      const tl = (want ? existing.find((t) => t.id === want) : null)
        ?? existing.find((t) => t.name === "Main") ?? existing[0]
        ?? (await ensureTimeline(episode.id));
      if (!alive) return;
      await ensureLanes(tl.id); // older timelines predate V2/A2/A3
      if (!alive) return;
      await store.load(tl.id);
      if (!alive) return;
      // Always written, never conditionally: `null` is the honest answer for
      // an episode that has no storyboard, and leaving the field at whatever
      // it held is what made that case the deterministic half of the bug.
      setSbId(sbs[0]?.id ?? null);
      const beats = sbs[0]?.audio_meta?.beats_ms;
      if (beats) store.setBeats(beats);
    })().catch(console.error);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode.id]);

  // The timeline's own rows are live now. `clips`/`tracks`/`timelines` were
  // never in the realtime publication, so this editor could only ever be
  // load-once plus local mutation: a take chosen in the assembly modal, a
  // spliced take published by the pod, or an edit made in another tab reached
  // the timeline and the player only on reload. reconcile() merges without
  // stepping on an edit in progress.
  const tlId = store.timeline?.id;
  useEffect(() => {
    if (!tlId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeTables(["clips", "tracks", "timelines"], () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void useTimelineStore.getState().reconcile(); }, 250);
    });
    return () => { if (timer) clearTimeout(timer); off(); };
  }, [tlId]);

  // Auto-sync: whenever a block lands a new active take (realtime), pull it
  // onto the timeline — no manual sync needed while a one-shot run generates.
  // `block_takes` is watched too: a retake that supersedes the active one
  // repoints the take row rather than the block, so watching blocks alone left
  // the clip playing the take it replaced.
  const { data: blockSig } = useLiveQuery(
    async () => {
      if (!sbId) return null;
      const { data } = await supabase.from("generation_blocks")
        .select("id,active_take_id,t_start_ms,t_end_ms").eq("storyboard_id", sbId).order("idx");
      const ids = (data ?? []).map((b) => b.active_take_id).filter(Boolean) as string[];
      const { data: takes } = ids.length
        ? await supabase.from("block_takes").select("id,asset_id").in("id", ids)
        : { data: [] };
      const asset = new Map((takes ?? []).map((t) => [t.id, t.asset_id]));
      return (data ?? []).map((b) =>
        `${b.id}:${b.active_take_id ?? ""}:${asset.get(b.active_take_id ?? "") ?? ""}:${b.t_start_ms}-${b.t_end_ms}`
      ).join("|");
    },
    ["generation_blocks", "block_takes"], [sbId]);
  useEffect(() => {
    if (blockSig == null || !tlId || !sbId) return;
    // KEYED ON THE CUT AS WELL AS THE BLOCKS. The guard is a ref that survives
    // switching cuts, so on the blocks alone a newly opened cut was never
    // synced — a duplicate would miss every take that landed while another cut
    // was on screen. A blank cut is protected from this by its own
    // `excluded_block_ids` stamp, not by never being asked.
    const sig = `${tlId}|${blockSig}`;
    if (syncSig.current === sig) return;
    syncSig.current = sig;
    (async () => {
      // Blocks the editor deleted are left off (`excluded_block_ids`) and the
      // `skipped` half of the result is NOT reported: this fires on its own,
      // so a note nobody asked for would arrive minutes after the delete with
      // no gesture to attach it to. There is no longer a manual sync button to
      // say it on either — this effect is the only sync, so an exclusion is
      // told by the block simply not being on the cut, and the way to put one
      // back is the same deliberate gesture as adding it: drag it from Shots.
      const { changed } = await syncBlocksToTimeline(tlId, sbId);
      // The write lands on `clips`, which the subscription above already
      // watches — but going straight to reconcile means the stage updates on
      // this tick rather than after the socket round trip.
      if (changed > 0) await useTimelineStore.getState().reconcile();
    })().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockSig, sbId, tlId]);

  const selected = store.clips.find((c) => c.id === store.selectedClipId) ?? null;
  // The lane whose rack is open, if any. The store keeps this and the clip
  // selection mutually exclusive, so the rail only ever shows one of them.
  const selectedTrack = store.tracks.find((t) => t.id === store.selectedTrackId) ?? null;
  const tl = store.timeline;
  // The Render button OPENS the settings rather than firing. It used to queue
  // immediately with a payload of nothing but a timeline id, so the delivery
  // format was whatever render.py hardcoded and the post chain could only be
  // seen by opening a different screen. `null` = closed.
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);

  // Loaded on OPEN, not on mount: it is one row, it is only needed when the
  // modal is up, and reading it fresh each time is what makes a change made in
  // Project Settings show here without a reload. The modal OPENS first, though
  // — gating the open on the fetch made Render a button that did nothing on
  // screen for a round trip.
  const openRender = React.useCallback(() => {
    if (!tl) return;
    setSettings(null);
    setRenderOpen(true);
    void (async () => {
      const { data } = await supabase.from("projects").select("settings").eq("id", projectId).single();
      setSettings((data?.settings ?? {}) as ProjectSettings);
    })();
  }, [tl, projectId]);

  const startRender = React.useCallback((output: RenderOutput, chain: PostChain,
                                        postRef: string | null,
                                        postRefMode: "source" | "asset",
                                        postOptions: PostOptions,
                                        postRefStrength: number) => {
    if (!tl) return;
    setRendering(true);
    void (async () => {
      try {
        // Persist BEFORE queueing. The worker reads the chain off the project
        // row itself (that is how a clip inherits one), so a render queued
        // against a chain that was never written would apply the old default —
        // the settings would look applied and the file would disagree.
        await saveProjectSettings(projectId, {
          render_output: output, post: chain, post_ref_asset_id: postRef,
          post_ref_mode: postRefMode, post_ref_strength: postRefStrength,
          ...postOptions,
        });
        await queueTimelineRender({
          timelineId: tl.id, clips: videoClips(store.tracks, store.clips),
          projectId, episodeId: episode.id, output, projectChain: chain,
        });
        setRenderOpen(false);
      } finally {
        setRendering(false);
      }
    })();
  }, [tl, store.tracks, store.clips, projectId, episode.id]);

  // GRAB THE FRAME ON SCREEN, into the library.
  //
  // The pixels are NOT read off the player's own <video>: those elements
  // deliberately carry no `crossOrigin` (the B2 CDN serves media with no ACAO
  // and a CORS-mode media fetch that gets none fails outright as a black
  // frame), so the canvas they would be drawn into is tainted and `toBlob`
  // throws. The frame is re-extracted through the proxy instead, with the
  // clip's own ops applied — see lib/frameExtractor.ts.
  const [grabbing, setGrabbing] = useState(false);
  const grabFrame = React.useCallback(() => {
    // READ AT CLICK TIME. The playhead deliberately does not re-render this
    // component — the readouts are refs on a 10Hz tick — so anything about
    // the current instant computed in the body is a seek or two out of date,
    // and the button would grab a frame from wherever the last render left it.
    const ms = usePlaybackStore.getState().nowMs();
    const st = useTimelineStore.getState();
    const hit = frameAtPlayhead(st.tracks, st.clips, ms);
    if (!hit) {
      emitTimelineNote(`Nothing on the video lanes at ${fmtTc(ms)} — no frame to grab.`);
      return;
    }
    setGrabbing(true);
    void (async () => {
      try {
        const saved = await extractAndSavePlayheadFrame(
          hit.clip, st.assets.get(hit.clip.asset_id), hit.srcMs, ms);
        emitTimelineNote(
          `Frame at ${fmtTc(ms)} saved to the library (${saved.b2_key.split("/").pop()}).`
          // Two honest caveats rather than a picture that quietly differs from
          // the stage: a still has one frame whatever the playhead says, and a
          // cross-fade is a blend of two layers that this grabs the top of.
          + (hit.midTransition
              ? " That instant is mid-transition — the incoming clip was grabbed, not the blend."
              : ""));
      } catch (err) {
        console.error("Grab frame failed", err);
        emitTimelineNote(`Couldn't grab that frame: ${(err as Error)?.message ?? err}`);
      } finally {
        setGrabbing(false);
      }
    })();
  }, []);

  useTimelineKeys(useMemo(() => ({ onRender: openRender }), [openRender]));
  const fps = tl?.fps ?? 24;

  return (
    <>
      {/* stage + takes strip on the left, persistent inspector on the right */}
      <div className="ws-viewer">
        <div className="ws-stagecol">
          <div className="ws-stagewrap">
            {/* An empty box: the shell-level PlayerDock positions itself over
                this rect, so navigating away never unmounts the <video>. */}
              <div className="ws-stage" ref={stageRef} />
            </div>

            {/* Attached below the player — no floating controls over the
                frame. Transport on the left, stage tools bottom-right. */}
            <div className="ws-ctlbar ns-hud">
              <div className="ws-ctl-transport">
                <button className="ws-round lg" onClick={() => seek(0)}><SkipBack size={16} /></button>
                <button className="ws-play" onClick={toggle}>
                  {playing ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <button className="ws-round lg" onClick={() => seek(usePlaybackStore.getState().durationMs)}>
                  <SkipForward size={16} />
                </button>
                <span className="ws-tc">
                  <span ref={tcRef}>{fmtTc(usePlaybackStore.getState().nowMs())}</span>
                  {selected && (
                    <span style={{ color: "#5e6678", fontWeight: 400 }}>
                      {" / "}{(selected.duration_ms / 1000).toFixed(1)}s
                    </span>
                  )}
                </span>
              </div>
              <span style={{ flex: 1 }} />
              <div className="ws-stage-tools">
                {/* PAUSED ONLY, and disabled rather than hidden: while playing
                    "the frame you are looking at" is a moving target and the
                    grab would land wherever the round trip happened to
                    finish — which is not what the button says it does. */}
                <button className="ws-round" disabled={playing || grabbing}
                        title={playing
                          ? "Pause to grab the frame you're looking at"
                          : "Save this frame to the library"}
                        onClick={grabFrame}>
                  {grabbing ? <Loader2 size={15} className="ns-spin" /> : <Camera size={15} />}
                </button>
                {/* Offered only with a clip selected, because that is the only
                    state the strip has anything to show — and it is the way
                    back from the strip's own X. */}
                {selected && (
                  <button className={"ws-round" + (ws.takesOpen ? " on" : "")}
                          title={ws.takesOpen ? "Hide takes" : "Show takes for the selected clip"}
                          onClick={() => ws.toggle("takesOpen")}><Clapperboard size={15} /></button>
                )}
                <button className={"ws-round" + (ws.pipOn ? " on" : "")}
                        title={ws.pipOn
                          ? "Keeps playing in a corner when you leave the timeline"
                          : "Playback stops when you leave the timeline"}
                        onClick={() => ws.toggle("pipOn")}>
                  <PictureInPicture2 size={15} />
                </button>
                <button className="ws-round" title="Fullscreen"
                        onClick={() =>
                          /* the stage is an empty anchor now — the media lives
                             in the shell-level dock positioned over it */
                          document.querySelector(".ws-playerdock")?.requestFullscreen?.()}>
                  <Maximize2 size={15} />
                </button>
              </div>
            </div>

            {selected && ws.takesOpen && <TakesStrip clip={selected} />}
        </div>

        {/* Both right-hand affordances are gated on a SELECTION, not just on
            their open flags: with nothing selected the inspector renders
            "Nothing selected" and the reopen chevron offers to show it, which
            on project open is 300px of column plus a button that promises
            nothing. Selecting a clip brings back whatever state you left. */}
        {(selected || selectedTrack) && (ws.inspOpen
          ? <InspectorRail clip={selected} track={selectedTrack} projectId={projectId} />
          : (
            <button className="ws-insp-reopen" title="Show inspector"
                    onClick={() => ws.set("inspOpen", true)}>
              <SlidersHorizontal size={15} />
            </button>
          ))}
      </div>

      <WsTimeline onRender={openRender} />
      {renderOpen && tl && settings === null && (
        // The settings row is still in flight. RenderSettingsModal seeds its
        // state from props with lazy initializers, so it must not mount until
        // the real values exist — this frame keeps the click visible meanwhile.
        <ModalShell width={620} z={94} onClose={() => setRenderOpen(false)}
                    icon={<Clapperboard size={16} />} title="Render"
                    loading loadingLabel="Loading render settings…" />
      )}
      {renderOpen && tl && settings !== null && (
        <RenderSettingsModal
          timeline={{ width: tl.width, height: tl.height, fps: tl.fps }}
          clips={videoClips(store.tracks, store.clips)}
          output={normalizeOutput(resolveDefaults(settings).render_output)}
          projectChain={normalizeChain(settings?.post) ?? {}}
          postRefAssetId={settings?.post_ref_asset_id ?? null}
          postRefMode={settings?.post_ref_mode === "asset" ? "asset" : "source"}
          postOptions={normalizePostOptions(settings)}
          projectId={projectId}
          busy={rendering}
          onRender={startRender}
          onClose={() => setRenderOpen(false)}
        />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════ projects view ══ */
function ProjectsView() {
  const nav = useNavigate();
  const ws = useWorkspaceStore();
  const { data, loading } = useLiveQuery(
    async () => {
      // Covers, blocks, storyboards and episodes are mutually independent —
      // this was five sequential rounds on the screen you land on.
      const [projects, { data: blocks }, { data: sbs }, { data: eps }] = await Promise.all([
        loadProjects(),
        supabase.from("generation_blocks").select("id,status,storyboard_id"),
        supabase.from("storyboards").select("id,episode_id"),
        supabase.from("episodes").select("id,project_id,code,title,status"),
      ]);
      const cover = await loadProjectCovers(projects.map((p) => p.id));
      const sbEp = new Map((sbs ?? []).map((s) => [s.id, s.episode_id]));
      const epProj = new Map((eps ?? []).map((e) => [e.id, e.project_id]));
      const stats = new Map<string, { kept: number; total: number }>();
      for (const b of blocks ?? []) {
        const pid = epProj.get(sbEp.get(b.storyboard_id) ?? "") as string | undefined;
        if (!pid) continue;
        const s = stats.get(pid) ?? { kept: 0, total: 0 };
        s.total++; if (b.status === "generated") s.kept++;
        stats.set(pid, s);
      }
      const epCount = new Map<string, number>();
      for (const e of eps ?? []) epCount.set(e.project_id!, (epCount.get(e.project_id!) ?? 0) + 1);
      return { projects, cover, stats, epCount };
    },
    ["projects", "assets", "generation_blocks"], []
  );
  const projects = data?.projects ?? [];

  return (
    <>
      <div className="ws-viewhead">
        <span className="ws-h1">Projects</span>
        <span className="ws-mlabel">{projects.length} total</span>
        <span style={{ flex: 1 }} />
        <button className="ws-primary" onClick={() => ws.openModal({ kind: "newProject" })}>
          <Plus size={14} /> New project
        </button>
      </div>
      {loading && !projects.length && (
        <div className="ws-empty" style={{ display: "flex", alignItems: "center",
                                           justifyContent: "center", gap: 9 }}>
          <Loader2 size={15} className="ns-spin" /> Loading projects…
        </div>
      )}
      <div className="ws-projgrid">
        {projects.map((p) => {
          const cover = data?.cover.get(p.id);
          const st = data?.stats.get(p.id);
          const openProj = async () => {
            const ep = await mainEpisode(p.id);
            nav(ep ? `/project/${p.id}/ep/${ep.id}/timeline` : `/project/${p.id}`);
          };
          return (
            <div
              key={p.id}
              className="ws-projcard"
              role="button"
              tabIndex={0}
              onClick={openProj}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void openProj();
                }
              }}
            >
              <span className="ws-projcover">
                <span className="ws-badge">
                  <i className="ns-dot" style={{
                    width: 5, height: 5, borderRadius: "50%",
                    background: st?.kept ? "#6fd08c" : "#5b6478",
                  }} />
                  {p.medium.replace("_", " ")}
                </span>
                <span className="ws-projactions">
                  <button
                    type="button"
                    className="ws-projaction-btn delete"
                    title="Delete project"
                    aria-label={`Delete ${p.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      ws.openModal({ kind: "deleteProject", projectId: p.id, title: p.title });
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
                {cover
                  ? <ProjectCoverArt cover={cover} />
                  : p.medium === "music_video" ? <Music size={22} />
                  : p.medium === "series" ? <Tv size={22} /> : <Clapperboard size={22} />}
              </span>
              <span className="ws-projbody">
                <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.015em" }}>{p.title}</span>
                <span className="mono" style={{ fontSize: 11, color: "#5e6678" }}>
                  {data?.epCount.get(p.id) ?? 0} episode{(data?.epCount.get(p.id) ?? 0) === 1 ? "" : "s"}
                  {p.style ? ` · ${p.style}` : ""}
                </span>
                {p.logline && (
                  <span style={{ fontSize: 12.5, color: "#9aa4b6", lineHeight: 1.55,
                                 display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {p.logline}
                  </span>
                )}
                {st && st.total > 0 && (
                  <>
                    <span className="ws-bar"><i style={{ width: `${(st.kept / st.total) * 100}%` }} /></span>
                    <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                      {st.kept}/{st.total} blocks generated
                    </span>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * The picture on a project card.
 *
 * A `<video>` THAT HAS NEVER PLAYED AND NEVER BEEN SEEKED PAINTS NOTHING, and
 * it does not have the courtesy to fail — this was a bare
 * `<video src muted preload="metadata">`, and the grid rendered a black box for
 * every project that HAD a cover while the projects that had none at least drew
 * their medium icon. That is exactly what the home grid showed.
 *
 * Measured rather than assumed, because the obvious reading is wrong twice
 * over. It is not a load failure and it is not thrift: mounting the four covers
 * this studio's data resolves, cold, reports `readyState 4 · buffered 1 · no
 * error` on all four — Chrome fetched every one of those files IN FULL (~20MB
 * for four cards) and then declined to decode a frame for any of them. One such
 * element on its own does paint, which is presumably how this shipped.
 *
 * So the still is what paints. It is the take's own last frame, extracted and
 * registered by the worker at render time (`loadProjectCovers` says where), and
 * as a `poster` it lands at `readyState 0 · buffered 0` — the picture arrives
 * and not one byte of video is fetched. Same four covers, same cold cache: four
 * blank boxes and 20MB before, four frames and 3MB of png after.
 *
 * The take is still mounted, at `preload="none"`, so hovering plays the shot
 * and nothing loads until then. Without a still there is nothing to paint until
 * a frame is decoded, so that one element has to ask for one — `#t=0.1` is a
 * media fragment, i.e. a seek, which is the thing a never-seeked element is
 * missing. (One take of 491 here has no still, so this is the rare path.)
 */
function ProjectCoverArt({ cover }: { cover: ProjectCover }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  if (!cover.video) {
    return cover.still ? <img src={cover.still} alt="" /> : null;
  }
  return (
    <video
      ref={ref}
      src={cover.still ? cover.video : `${cover.video}#t=0.1`}
      poster={cover.still ?? undefined}
      preload={cover.still ? "none" : "metadata"}
      muted
      loop
      playsInline
      aria-hidden="true"
      onPointerEnter={() => { void ref.current?.play().catch(() => {}); }}
      onPointerLeave={() => {
        const v = ref.current;
        if (!v) return;
        v.pause();
        // Back to the top rather than back to the poster: once playback has
        // begun the poster is gone for good, and frame 0 is the nearest thing
        // to it that does not cost a re-fetch.
        try { v.currentTime = 0; } catch { /* not seekable yet */ }
      }}
    />
  );
}

/* ═══════════════════════════════════════════════════ lore documents ══ */
/** The retrieval half of the Bible, under the entry grid on the Lore tab.
 *
 *  Entries and documents are shown together because they are two answers to
 *  one question — what does the director know about this world — and separating
 *  them into two screens is how you end up with a project whose world bible was
 *  imported and never referenced by anything.
 *
 *  What each row has to say, and the reason it is the headline rather than a
 *  detail: whether the passages are INDEXED. An unindexed document is stored
 *  and unreachable, `rag_search` swallows the miss by design (retrieval is an
 *  enhancement, never a dependency), and there is no other surface in the app
 *  where its absence would show. */
function LoreShelf({ projectId }: { projectId: string }) {
  const ws = useWorkspaceStore();
  // `rag_documents` is not in the realtime publication and MUST NOT be
  // subscribed — binding an unpublished table silently kills the whole shared
  // channel (hooks/realtimeTables.ts). `jobs` is published and is what
  // changes while indexing runs, so it is the right thing to watch here.
  const { data } = useLiveQuery(
    async () => {
      const [docs, jobs, proposals] = await Promise.all([
        loadLoreDocs(projectId), loadExtractJobs(projectId), loadProposalCounts(projectId),
      ]);
      return { docs, jobs, proposals };
    },
    // bible_entries too: a proposal count that only refreshes on a job change
    // would still say "3 proposed" after you confirmed all three.
    ["jobs", "bible_entries"], [projectId]
  );
  const docs = data?.docs ?? [];

  // Sweep once per visit: anything queued but unembedded gets drained by the
  // edge function without waking the GPU box. This covers the case the import
  // path cannot — documents created by the WORKER (planner lore, extract_lore's
  // output) were queued by a process that never calls the browser, so without
  // a sweep they wait for the pod exactly as before.
  //
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Documents</span>
        <span className="mono" style={{ fontSize: 11, color: "#5e6678" }}>
          {docs.length ? `${docs.length} · retrieved a passage at a time` : "retrieved a passage at a time"}
        </span>
        <span style={{ flex: 1 }} />
        <button className="ws-microbtn" onClick={() => ws.openModal({ kind: "loreImport", projectId })}>
          <FileUp size={11} /> import
        </button>
      </div>

      {!docs.length ? (
        <div className="ws-empty" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          No documents. Import a world bible, a treatment or a script and the director can
          quote it while it writes — without any of it having to fit in a prompt.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {docs.map((d) => {
            const pending = d.chunks - d.embedded;
            const live = (data?.jobs ?? []).some(
              (j) => j.document_id === d.id && (j.status === "queued" || j.status === "running"));
            return (
              <button key={d.id} className="ws-card ws-lorerow"
                      title="Open the document"
                      onClick={() => ws.openModal({ kind: "loreDoc", docId: d.id, projectId })}>
                <FileText size={15} style={{ color: "#8fc2ff", flex: "0 0 auto" }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3,
                               textAlign: "left" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.title}
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                    {d.kind} · {d.chunks} passage{d.chunks === 1 ? "" : "s"}
                    {d.source ? ` · ${d.source}` : ""}
                  </span>
                </span>
                {/* A proposal nobody has ruled on is the thing most worth
                    surfacing here — it is a decision waiting on the user, not a
                    status. It outranks the index state for that reason. */}
                {(data?.proposals.get(d.id) ?? 0) > 0 && (
                  <span className="mono" style={{ fontSize: 10.5, color: "#e8c268", flex: "0 0 auto" }}>
                    {data!.proposals.get(d.id)} proposed
                  </span>
                )}
                {live ? (
                  <span className="mono" style={{ fontSize: 10.5, color: "#8fc2ff", flex: "0 0 auto" }}>
                    indexing {d.embedded}/{d.chunks}
                  </span>
                ) : pending > 0 ? (
                  <span className="mono" style={{ fontSize: 10.5, color: "#e8c268", flex: "0 0 auto" }}>
                    {d.embedded ? `${pending} not indexed` : "not indexed yet"}
                  </span>
                ) : (
                  <span className="mono" style={{ fontSize: 10.5, color: "#6fd08c", flex: "0 0 auto" }}>
                    indexed
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════ bible view ══ */
function BibleView({ projectId }: { projectId: string }) {
  const ws = useWorkspaceStore();
  const [kind, setKind] = useState<"character" | "environment" | "prop" | "lore">("character");
  const [selId, setSelId] = useState<string | null>(null);

  const { data, loading: bibleLoading, reload } = useLiveQuery(
    async () => {
      const entries = await loadBible(projectId);
      const links = await loadBibleAssets(entries.map((e) => e.id));
      const ids = links.map((l) => l.asset_id);
      const { data: assets } = ids.length
        ? await supabase.from("assets").select("*").in("id", ids) : { data: [] };
      return { entries, links, assets: new Map(((assets ?? []) as Asset[]).map((a) => [a.id, a])) };
    },
    ["bible_entries", "bible_assets"], [projectId]
  );
  const entries = (data?.entries ?? []).filter((e) => e.kind === kind);
  const isLore = kind === "lore";
  const sel = data?.entries.find((e) => e.id === selId) ?? null;
  const selRefs = (data?.links ?? []).filter((l) => l.entry_id === selId);

  return (
    <>
      <div className="ws-viewhead">
        <span className="ws-h2">Bible</span>
        <div className="ws-nav" style={{ margin: 0 }}>
          {(["character", "environment", "prop", "lore"] as const).map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setSelId(null); }}>
              {k[0].toUpperCase() + k.slice(1)}s
              <span className="mono" style={{ opacity: 0.6, fontSize: 11 }}>
                {(data?.entries ?? []).filter((e) => e.kind === k).length}
              </span>
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button className="ws-ghost" title="Style guide and default models"
                onClick={() => ws.openModal({ kind: "projectSettings", projectId })}>
          <SlidersHorizontal size={13} /> Style &amp; models
        </button>
        {isLore && (
          <button className="ws-ghost" title="Import a world bible, treatment, script or notes"
                  onClick={() => ws.openModal({ kind: "loreImport", projectId })}>
            <FileUp size={13} /> Import document
          </button>
        )}
        <button className="ws-primary" onClick={() => ws.openModal({ kind: "newEntry", entryKind: kind })}>
          <Plus size={14} /> New entry
        </button>
      </div>
      <div className="ws-biblewrap">
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {/* A grid of the actual reference art, not a list of 40px thumbnails:
              a character IS its references, and one click opens the sheet.
              Lore has no art and never will, so it gets text cards instead —
              a row of "no refs — identity will drift" under every piece of
              history was advice about a problem lore cannot have. */}
          <div className="ws-entrygrid">
            {entries.map((e) => {
              const mine = (data?.links ?? []).filter((l) => l.entry_id === e.id);
              const shown = mine.map((l) => data?.assets.get(l.asset_id)).filter(Boolean).slice(0, 3) as Asset[];
              if (isLore) {
                const body = ((e.doc ?? {}) as { body?: unknown }).body;
                const words = typeof body === "string"
                  ? body.trim().split(/\s+/).filter(Boolean).length : 0;
                return (
                  <div key={e.id} className="ws-entrycard lore" role="button" tabIndex={0}
                       title="Open this lore entry"
                       onClick={() => ws.openModal({ kind: "entry", entryId: e.id })}
                       onKeyDown={(ev) => {
                         if (ev.key === "Enter" || ev.key === " ") {
                           ev.preventDefault();
                           ws.openModal({ kind: "entry", entryId: e.id });
                         }
                       }}>
                    <button
                      type="button"
                      className="ws-entrycard-del"
                      title={`Delete ${e.name}`}
                      aria-label={`Delete ${e.name}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        ws.openModal({ kind: "deleteEntry", entryId: e.id, name: e.name, kindName: e.kind });
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                    <span className="meta">
                      <span className="nm">
                        {e.name}
                        <span className="mono tag" style={{ color: e.status === "confirmed" ? "#6fd08c" : "#e8c268" }}>
                          v{e.version} · {e.status}
                        </span>
                      </span>
                      <span className="ln">{e.summary ?? "no summary — the planner sees this line"}</span>
                      <span className="mono cnt" style={{ color: "#5e6678" }}>
                        {words ? `${words.toLocaleString()} words` : "summary only"}
                      </span>
                    </span>
                  </div>
                );
              }
              return (
                <div key={e.id} className="ws-entrycard" role="button" tabIndex={0}
                     title="Open the full sheet"
                     onClick={() => ws.openModal({ kind: "entry", entryId: e.id })}
                     onKeyDown={(ev) => {
                       if (ev.key === "Enter" || ev.key === " ") {
                         ev.preventDefault();
                         ws.openModal({ kind: "entry", entryId: e.id });
                       }
                     }}>
                  <button
                    type="button"
                    className="ws-entrycard-del"
                    title={`Delete ${e.name}`}
                    aria-label={`Delete ${e.name}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      ws.openModal({ kind: "deleteEntry", entryId: e.id, name: e.name, kindName: e.kind });
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                  <span className="strip">
                    {shown.length
                      ? shown.map((a, i) => (
                          <span key={a.id} className="sh" style={{ flex: i === 0 ? 1.4 : 1 }}>
                            <img src={assetUrl(a) ?? undefined} alt="" />
                          </span>
                        ))
                      : <span className="sh empty"><ImageIcon size={20} /></span>}
                    {mine.length > 3 && <span className="more mono">+{mine.length - 3}</span>}
                  </span>
                  <span className="meta">
                    <span className="nm">
                      {e.name}
                      <span className="mono tag" style={{ color: e.status === "confirmed" ? "#6fd08c" : "#e8c268" }}>
                        v{e.version} · {e.status}
                      </span>
                    </span>
                    <span className="ln">{e.identity_line ?? e.summary ?? "no identity line yet"}</span>
                    <span className="mono cnt" style={{ color: mine.length ? "#5e6678" : "#e8c268" }}>
                      {mine.length ? `${mine.length} ref${mine.length === 1 ? "" : "s"}`
                                   : "no refs — identity will drift"}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          {!entries.length && (
            // Loading is not emptiness: "No characters yet." over a bible that
            // is still fetching reads as data loss.
            bibleLoading ? (
              <div className="ws-empty" style={{ display: "flex", alignItems: "center",
                                                 justifyContent: "center", gap: 9 }}>
                <Loader2 size={15} className="ns-spin" /> Loading bible…
              </div>
            ) : (
              <div className="ws-empty">
                {isLore
                  ? "No lore entries yet — an entry is one named thing the planner sees in every scene."
                  : `No ${kind}s yet.`}
              </div>
            )
          )}
          {isLore && <LoreShelf projectId={projectId} />}
        </div>
        {sel && (
          // key: the fields below are uncontrolled, so without a remount they
          // keep the previously selected entry's text and the next blur writes
          // it onto this one.
          <aside className="ws-rail-detail ns-l2" key={sel.id}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{sel.name}</div>
            <div className="ws-mlabel" style={{ margin: "12px 0 6px" }}>Identity line</div>
            <textarea className="ws-input" rows={4} defaultValue={sel.identity_line ?? ""}
                      style={{ fontSize: 12.5, color: "#dfe4ec" }}
                      onBlur={async (e) => {
                        if (e.target.value !== (sel.identity_line ?? "")) {
                          await supabase.from("bible_entries").update({ identity_line: e.target.value }).eq("id", sel.id);
                          reload();
                        }
                      }} />
            <div className="ws-mlabel" style={{ margin: "12px 0 6px" }}>Reference sheet</div>
            <div className="ws-refslots">
              {[0, 1, 2, 3].map((i) => {
                const link = selRefs[i];
                const a = link ? data?.assets.get(link.asset_id) : null;
                return (
                  <button key={i} className="ws-refslot" title="Open the full sheet"
                          onClick={() => ws.openModal({ kind: "entry", entryId: sel.id })}>
                    {a ? <img src={assetUrl(a) ?? undefined} alt="" /> : <Plus size={13} />}
                  </button>
                );
              })}
            </div>
            <button className="ws-primary" style={{ marginTop: 12, width: "100%", justifyContent: "center" }}
                    onClick={() => enqueueJob({
                      kind: "image_gen", lane: "gpu", priority: 20, project_id: projectId,
                      payload: {
                        prompt: `${sel.kind === "character" ? "character reference sheet" : "environment reference"}, anime style: ${sel.identity_line ?? sel.name}`,
                        width: 1024, height: 1024,
                        target: { bible_entry_id: sel.id, role: "master", slot: selRefs.length },
                        ref_asset_ids: selRefs.slice(0, 2).map((l) => l.asset_id),
                      },
                    })}>
              <Sparkles size={13} /> Generate reference
            </button>
          </aside>
        )}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════ library view ══ */
/** What the grid is showing: current project, a kind facet, one collection, or the bin. */
type LibSel =
  | { mode: "project" }
  | { mode: "kind"; kind: string | null }
  | { mode: "collection"; id: string }
  | { mode: "trash" };

/** Rows fetched per page — grown as the sentinel at the foot of the grid
 *  comes into view. See the IntersectionObserver effect in LibraryView. */
const LIB_PAGE = 160;

function LibraryView({ projectId }: { projectId: string | null }) {
  const ws = useWorkspaceStore();
  const role = useProjectRole(projectId);
  const [sel, setSel] = useState<LibSel>(projectId ? { mode: "project" } : { mode: "kind", kind: null });
  useEffect(() => {
    if (projectId) setSel({ mode: "project" });
    else setSel({ mode: "kind", kind: null });
  }, [projectId]);
  const [uploading, setUploading] = useState<number | null>(null);
  /** which card's recipe is being read back off its job row, and why one failed */
  const [reusing, setReusing] = useState<string | null>(null);
  const [reuseErr, setReuseErr] = useState<string | null>(null);
  /** what the last paste did — an empty clipboard and a blocked one both look
   *  like the button doing nothing, so both say so */
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const chord = useMemo(pasteChord, []);
  /** drop target under the pointer, so the sidebar shows where a card will land */
  const [over, setOver] = useState<string | null>(null);
  const [newColl, setNewColl] = useState<string | null>(null);          // draft name; null = closed
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** Second click confirms. Binning is reversible and unarmed; leaving the bin
   *  is the only thing here that destroys bytes, so both purge paths arm. */
  const [armedEmpty, setArmedEmpty] = useState(false);
  const [armedPurge, setArmedPurge] = useState<string | null>(null);
  /** Dropping a collection destroys no media, but it does destroy the sorting
   *  work that filled it — which is the whole point of the feature. */
  const [armedColl, setArmedColl] = useState<string | null>(null);
  // What is being generated right now. Two jobs at once: this drives the
  // placeholder cards, and its emptiness is what decides whether the grid
  // polls — an idle library costs nothing, a busy one refreshes on its own.
  const { data: pending } = useLiveQuery(
    () => loadPendingGenerations(projectId), ["jobs"], [projectId], 400, 2500);
  const busy = (pending?.length ?? 0) > 0;
  const { data: collections, reload: reloadColls } = useLiveQuery(
    () => loadCollections(), ["collections"]);
  const openColl = sel.mode === "collection"
    ? (collections ?? []).find((c) => c.id === sel.id) ?? null : null;
  const inHidden = !!openColl?.hidden;
  const selKey = sel.mode === "collection" ? `c:${sel.id}:${inHidden}`
    : sel.mode === "trash" ? "trash"
    : sel.mode === "project" ? `p:${projectId}`
    : `k:${sel.kind ?? ""}`;
  // A project SHARED with you scopes the library to that project; your own
  // library stays your own. Without this the two merge, and "my library"
  // quietly becomes everyone's — the files are legitimately readable (they are
  // what was shared), they simply do not belong in a personal library.
  // An owner's view of their own project is untouched: they keep the
  // cross-project library they have always had.
  const libScope = role.isShared && projectId
    ? { projectId }
    : { ownedOnly: true };
  const scopeKey = role.isShared && projectId ? `p:${projectId}` : "mine";
  // Paging grows the LIMIT on the same query rather than offsetting: every
  // branch below is already deterministically ordered (created_at / added_at
  // / deleted_at, desc), so a bigger limit just replaces `assets` with a
  // longer prefix of the same order — no row-shift risk from concurrent
  // inserts, and it stays inside useLiveQuery's existing
  // replace-whole-dataset contract instead of needing append semantics.
  const [visibleCount, setVisibleCount] = useState(LIB_PAGE);
  useEffect(() => setVisibleCount(LIB_PAGE), [selKey, scopeKey]);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const libcolRef = useRef<HTMLDivElement | null>(null);
  // Scrolling the grid folds the composer's prompt box, so a long prompt stops
  // eating the list you are scrolling THROUGH; clicking the box opens it back
  // up. The state is here rather than in the dock because this is the half
  // that knows the list moved — see GenComposer's `collapsed`. React 17+ does
  // not bubble `onScroll`, so this fires for the column and nothing inside it.
  const [dockFolded, setDockFolded] = useState(false);
  useEffect(() => setDockFolded(false), [selKey, scopeKey]);
  const { data: assets, reload } = useLiveQuery(
    () => sel.mode === "trash" ? loadAssets({ ...libScope, deleted: true, limit: visibleCount })
        : sel.mode === "collection" ? loadCollectionAssets(sel.id, { hidden: inHidden, limit: visibleCount })
        : sel.mode === "project" ? loadAssets({ projectId, limit: visibleCount })
        : loadAssets({ ...libScope, kind: (sel.kind as Asset["kind"]) ?? undefined, limit: visibleCount }),
    ["assets", "collection_assets"], [selKey, scopeKey, visibleCount], 400, busy ? 2500 : 0);
  // Fewer rows back than were asked for means the list is exhausted — cheaper
  // than a second count query per facet, and self-correcting: landing exactly
  // on a page boundary just costs one extra, empty-handed page.
  const hasMore = (assets?.length ?? 0) >= visibleCount;
  useEffect(() => { loadingMoreRef.current = false; }, [assets]);
  // The sentinel below only exists in the DOM while there's more to fetch, so
  // this re-subscribes whenever `hasMore` flips or a page lands — deliberately
  // via a fresh `observe()` each time rather than one long-lived observer,
  // because a target that STAYS continuously visible across a re-render never
  // fires again on its own (no intersection-ratio change to report), which
  // would silently stop paging on a short list that never fills the scrollport.
  useEffect(() => {
    const root = libcolRef.current, sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasMore) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loadingMoreRef.current) {
        loadingMoreRef.current = true;
        setVisibleCount((n) => n + LIB_PAGE);
      }
    }, { root, rootMargin: "600px 0px" });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, assets]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The sidebar's tallies come from their own queries, never from the grid:
  // derived from the filtered list, picking "Video" zeroed every other row.
  const { data: counts, reload: reloadCounts } = useLiveQuery(
    () => loadAssetCounts(libScope), ["assets"], [scopeKey]);
  const { data: projectCounts, reload: reloadProjectCounts } = useLiveQuery(
    () => (projectId ? loadAssetCounts({ projectId }) : Promise.resolve(null)),
    ["assets"], [projectId]);
  const { data: memberships, reload: reloadCollCounts } = useLiveQuery(
    () => loadCollectionCounts(), ["collection_assets", "assets"], []);
  // A hidden collection counts what it shows — hidden members, binned ones
  // included. A visible one counts neither. The rows are now (hidden, trashed)
  // buckets with a count rather than one row per membership, so the same rule
  // adds `r.n` where it used to add 1.
  const collCounts = useMemo(() => {
    const m = new Map<string, number>();
    const hiddenColl = new Set((collections ?? []).filter((c) => c.hidden).map((c) => c.id));
    for (const r of memberships ?? []) {
      const isHiddenColl = hiddenColl.has(r.collection_id);
      if (r.hidden !== isHiddenColl) continue;
      if (r.trashed && !isHiddenColl) continue;
      m.set(r.collection_id, (m.get(r.collection_id) ?? 0) + r.n);
    }
    return m;
  }, [memberships, collections]);
  const refresh = () => { reload(); reloadCounts(); reloadProjectCounts(); reloadCollCounts(); };
  // A job leaving the queue means its output has just landed — refetch once
  // more on the edge, so the last placeholder is replaced by the real card
  // without waiting for another poll tick.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) reload();
    wasBusy.current = busy;
  }, [busy]);   // eslint-disable-line react-hooks/exhaustive-deps
  const bytes = (assets ?? []).reduce((s, a) => s + (a.bytes ?? 0), 0);
  const collName = sel.mode === "collection" ? openColl?.name ?? "Collection" : null;
  const facetKind = sel.mode === "kind" ? sel.kind : null;

  /* ── filing, binning, purging ─────────────────────────────────────────── */
  // Cards already carry their id in `application/x-qamba-asset` (the payload the
  // timeline accepts), so filing one is a drop rather than a menu. dragover
  // can't read the payload — only its types — which is what the highlight and
  // the preventDefault key off.
  const carriesAsset = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("application/x-qamba-asset");
  const dropTarget = (key: string, onAsset: (assetId: string) => Promise<void>) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!carriesAsset(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(key);
    },
    // dragleave bubbles, so crossing into the row's own button would otherwise
    // unhighlight the target you are aiming at.
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setOver((o) => (o === key ? null : o));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(null);
      const id = e.dataTransfer.getData("application/x-qamba-asset");
      if (id) void onAsset(id).then(refresh);
    },
  });

  const fileInto = async (collectionId: string, assetId: string) => {
    await addToCollection(collectionId, [assetId]);
  };
  const sendToBin = async (assetId: string) => { await trashAssets([assetId]); };
  const unfile = async (assetId: string) => {
    if (sel.mode === "collection") await removeFromCollection(sel.id, [assetId]);
  };
  const restore = async (assetId: string) => { await restoreAssets([assetId]); };
  /** The only irreversible path: row first, then the B2 object (invariant #2). */
  const purge = async (ids: string[]) => {
    const keys = await deleteAssets(ids);
    if (keys.length) await deleteMedia(keys).catch((e) => console.warn("B2 purge:", e));
  };

  const addCollection = async () => {
    const name = (newColl ?? "").trim();
    setNewColl(null);
    if (!name) return;
    const c = await createCollection(name);
    reloadColls();
    setSel({ mode: "collection", id: c.id });
  };
  const commitRename = async () => {
    const r = renaming;
    setRenaming(null);
    if (r && r.name.trim()) { await renameCollection(r.id, r.name); reloadColls(); }
  };
  const toggleHidden = async () => {
    if (!openColl) return;
    await setCollectionHidden(openColl.id, !openColl.hidden);
    reloadColls();
    refresh();
  };
  /** Drops the grouping, not the media — the membership rows cascade away. */
  const dropCollection = async (id: string) => {
    await deleteCollection(id);
    if (sel.mode === "collection" && sel.id === id) setSel({ mode: "kind", kind: null });
    reloadColls();
    reloadCollCounts();
  };

  /** Load a card's whole recipe back into the composer below. The read can
   *  fail honestly (the job row was deleted, an upload has no recipe), so it
   *  says which card and why rather than doing nothing. */
  const reuse = async (a: Asset) => {
    setReusing(a.id); setReuseErr(null);
    try {
      ws.reuseGeneration(await recipeFor(a));
    } catch (e) {
      setReuseErr(`${a.b2_key.split("/").pop()}: ${String((e as Error).message).slice(0, 120)}`);
    } finally { setReusing(null); }
  };

  const onFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      setUploading(0);
      try {
        const key = `library/${Date.now()}_${file.name.replace(/[^\w.-]+/g, "_")}`;
        await uploadMedia(file, key, (p: number) => setUploading(p));
        const k = file.type.startsWith("video") ? "video" : file.type.startsWith("audio") ? "audio" : "image";
        const asset = await registerAsset({
          b2_key: key, kind: k as Asset["kind"], project_id: projectId,
          content_type: file.type, bytes: file.size, tags: ["library"],
          ...(await probedUploadMeta(file)),   // don't wait on the pod for a length
        });
        // Uploading while a collection is open files into it — otherwise the
        // upload lands somewhere you aren't looking and has to be dragged back.
        if (sel.mode === "collection") await addToCollection(sel.id, [asset.id]);
        await enqueueJob({ kind: "asset_ingest", lane: "cpu", priority: 60, payload: { asset_id: asset.id } });
      } finally { setUploading(null); }
    }
    refresh();
  };

  /* ── pasting ──────────────────────────────────────────────────────────── */
  // A paste is a drop with no drag: the files take the same path, filed into
  // the open collection and queued for ingest. Two entry points because the
  // browser only offers two, and neither covers the other (lib/clipboardMedia).
  const takePaste = async (files: File[]) => {
    // Only the button can land here empty — a ⌘V with nothing usable on the
    // clipboard is left for whoever else wants it, and says nothing.
    if (!files.length) {
      setPasteNote("Nothing to paste — the clipboard holds no image, video or audio.");
      return;
    }
    setPasteNote(`Pasting ${files.length} file${files.length === 1 ? "" : "s"} from the clipboard…`);
    // An upload that dies leaves nothing on screen but a card that never
    // appears — the drop path has always failed that way (the promise is
    // floating), and there is no reason to reproduce it on a new one.
    try {
      await onFiles(files);
      setPasteNote(null);
    } catch (e) {
      setPasteNote(`Paste failed — ${(e as Error).message}`);
    }
  };
  const pasteFromButton = async () => {
    setPasting(true);
    try {
      await takePaste(await readClipboardMedia());
    } catch (e) {
      setPasteNote((e as Error).message);
    } finally { setPasting(false); }
  };
  // The window is the only thing that reliably sees a paste — the drop zone is
  // a <label> and never holds focus. So the listeners are global and filter: a
  // paste aimed at a text field belongs to that field (the composer sits right
  // below this grid), a modal over the library owns its own, and the bin takes
  // no uploads. A clipboard with no media is left alone entirely — a stray
  // paste must not start announcing itself.
  const latestPaste = useRef(takePaste);
  useEffect(() => { latestPaste.current = takePaste; });
  useEffect(() => {
    if (sel.mode === "trash") return;
    // `pasteClaimed` is the arbitration with the TIMELINE's own ⌘V, which
    // pastes a copied clip. Both listen on `window`, so without it one press
    // could upload a screenshot AND drop a clip on a lane. A stamp rather than
    // `defaultPrevented`, because that would depend on which listener was
    // registered first — true today, and silently false the day these two
    // effects are reordered. See lib/timelineSignals.ts.
    const blocked = (t: EventTarget | null) =>
      isEditableTarget(t) || !!useWorkspaceStore.getState().modal || pasteClaimed();
    /** when the browser last handed us a real paste event */
    let delivered = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onPaste = (e: ClipboardEvent) => {
      delivered = Date.now();
      if (blocked(e.target)) return;
      const files = clipboardMediaFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void latestPaste.current(files);
    };
    // ctrl+V on a Mac fires NO paste event — the OS chord there is ⌘V, so the
    // clipboard never reaches the handler above and the key press appears to
    // do nothing at all. When that happens the key press has to go and fetch
    // the clipboard itself. Everywhere else ctrl+V *is* paste and the event
    // already did the work, which is what `delivered` guards: the fallback
    // runs only when nothing arrived, so no platform pastes twice.
    const onKey = (e: KeyboardEvent) => {
      if (e.key?.toLowerCase() !== "v" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (blocked(e.target)) return;
      const at = Date.now();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (delivered >= at) return;                       // the browser delivered it
        if (pasteClaimed()) return;                        // the timeline took it
        // The key press is the user activation this read needs. A denial is
        // worth saying — silence here is the bug being fixed.
        void readClipboardMedia()
          .then((files) => { if (files.length) void latestPaste.current(files); })
          .catch((err) => setPasteNote((err as Error).message));
      }, 180);
    };

    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [sel.mode]);
  // Notes answer "did that do anything?" and then get out of the way.
  useEffect(() => {
    if (!pasteNote) return;
    const t = setTimeout(() => setPasteNote(null), 6000);
    return () => clearTimeout(t);
  }, [pasteNote]);

  return (
    <>
      <div className="ws-viewhead">
        <span className="ws-h2">
          {sel.mode === "trash" ? "Recycle bin"
           : sel.mode === "project" ? "This project"
           : collName ?? "Library"}
        </span>
        {inHidden && <span className="ws-hidechip"><EyeOff size={11} />incognito</span>}
        <span className="ws-mlabel">
          {assets?.length ?? 0} shown · {(bytes / 1e9).toFixed(2)} GB
          {sel.mode === "project"
            ? (projectCounts ? ` · ${projectCounts.total} in project` : "")
            : (counts ? ` · ${counts.total} in library` : "")}
          {counts?.trashed ? ` · ${counts.trashed} binned` : ""}
        </span>
        <span style={{ flex: 1 }} />
        {openColl && (
          <button className="ws-ghost" onClick={() => void toggleHidden()}
                  title={openColl.hidden
                    ? "Un-hide: these come back into the library, the pickers and the director's search"
                    : "Hide this collection: everything in it leaves the library, the pickers and the director's search, and is visible only here"}>
            {openColl.hidden ? <><Eye size={13} />Un-hide</> : <><EyeOff size={13} />Hide</>}
          </button>
        )}
        {sel.mode === "trash" && (assets?.length ?? 0) > 0 && (
          armedEmpty ? (
            <span className="ws-confirm">
              <span>purge {assets!.length} object{assets!.length === 1 ? "" : "s"} from B2 — no undo?</span>
              <button className="yes" onClick={() => {
                setArmedEmpty(false);
                void purge((assets ?? []).map((a) => a.id)).then(refresh);
              }}>empty</button>
              <button onClick={() => setArmedEmpty(false)}>keep</button>
            </span>
          ) : (
            <button className="ws-ghost" onClick={() => setArmedEmpty(true)}>
              <Trash2 size={13} />Empty bin
            </button>
          )
        )}
      </div>
      <div className="ws-libwrap">
        <aside className="ws-libside ns-l1">
          <div className="ws-mlabel" style={{ padding: "2px 8px 8px" }}>By kind</div>
          {projectId && (
            <button className={sel.mode === "project" ? "on" : ""}
                    onClick={() => setSel({ mode: "project" })}>
              <span>This project</span><span className="mono">{projectCounts?.total ?? 0}</span>
            </button>
          )}
          <button className={sel.mode === "kind" && sel.kind === null ? "on" : ""}
                  onClick={() => setSel({ mode: "kind", kind: null })}>
            <span>All media</span><span className="mono">{counts?.total ?? 0}</span>
          </button>
          {["video", "image", "audio", "frame", "render"].map((k) => (
            <button key={k} className={sel.mode === "kind" && sel.kind === k ? "on" : ""}
                    onClick={() => setSel({ mode: "kind", kind: k })}>
              <span>{k[0].toUpperCase() + k.slice(1)}s</span>
              <span className="mono">{counts?.kinds.get(k) ?? 0}</span>
            </button>
          ))}

          {/* Collections: drop targets first, filters second. */}
          <div className="ws-libsechead">
            <span className="ws-mlabel">Collections</span>
            <button className="ws-collnew" title="New collection" onClick={() => setNewColl("")}>
              <Plus size={12} />
            </button>
          </div>
          {newColl !== null && (
            <input className="ws-collinput" autoFocus value={newColl} placeholder="Collection name…"
                   onChange={(e) => setNewColl(e.target.value)}
                   onBlur={() => void addCollection()}
                   onKeyDown={(e) => {
                     if (e.key === "Enter") void addCollection();
                     if (e.key === "Escape") setNewColl(null);
                   }} />
          )}
          {(collections ?? []).map((c) => renaming?.id === c.id ? (
            <input key={c.id} className="ws-collinput" autoFocus value={renaming.name}
                   onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                   onBlur={() => void commitRename()}
                   onKeyDown={(e) => {
                     if (e.key === "Enter") void commitRename();
                     if (e.key === "Escape") setRenaming(null);
                   }} />
          ) : (
            <div key={c.id} className={"ws-collrow" + (over === `c:${c.id}` ? " over" : "")}
                 {...dropTarget(`c:${c.id}`, (id) => fileInto(c.id, id))}>
              <button className={(sel.mode === "collection" && sel.id === c.id ? "on" : "")
                                 + (c.hidden ? " hidden" : "")}
                      onClick={() => setSel({ mode: "collection", id: c.id })}
                      onDoubleClick={() => setRenaming({ id: c.id, name: c.name })}
                      title={c.hidden
                        ? `${c.name} is incognito — its media is out of the library, the pickers and the director's search`
                        : "Drag media onto this collection to file it — double-click to rename"}>
                <span className="ws-collname">
                  {c.hidden ? <EyeOff size={12} /> : <FolderOpen size={12} />}{c.name}
                </span>
                <span className="mono">{collCounts.get(c.id) ?? 0}</span>
              </button>
              <button className={"ws-colldrop" + (armedColl === c.id ? " armed" : "")}
                      title={armedColl === c.id
                        ? "Click again to delete this collection — the media stays in the library"
                        : "Delete this collection — the media stays in the library"}
                      onClick={() => {
                        if (armedColl !== c.id) { setArmedColl(c.id); return; }
                        setArmedColl(null);
                        void dropCollection(c.id);
                      }}
                      onBlur={() => setArmedColl((a) => (a === c.id ? null : a))}>
                {armedColl === c.id ? <Check size={11} /> : <X size={11} />}
              </button>
            </div>
          ))}
          {!(collections ?? []).length && newColl === null && (
            <div className="ws-collhint">None yet — make one, then drag cards onto it.</div>
          )}

          <div className="ws-libsechead"><span className="ws-mlabel">Bin</span></div>
          <div className={"ws-collrow" + (over === "trash" ? " over" : "")}
               {...dropTarget("trash", sendToBin)}>
            <button className={"ws-collbin" + (sel.mode === "trash" ? " on" : "")}
                    onClick={() => setSel({ mode: "trash" })}
                    title="Drag media here to bin it — nothing leaves B2 until you empty the bin">
              <span className="ws-collname"><Trash2 size={12} />Recycle bin</span>
              <span className="mono">{counts?.trashed ?? 0}</span>
            </button>
          </div>
        </aside>
        <div className="ws-libcol ns-scroll" ref={libcolRef}
             /* `scrollTop > 0` so that the browser CLAMPING a scrolled column
                back to the top — which it does whenever a facet change makes
                the list shorter — is not read as the user scrolling. */
             onScroll={(e) => { if (e.currentTarget.scrollTop > 0) setDockFolded(true); }}>
          {sel.mode !== "trash" && (
            <div className="ws-droprow">
              <label className="ws-drop">
                <Upload size={15} />
                {uploading != null
                  ? `Uploading ${Math.round(uploading * 100)}%…`
                  : sel.mode === "collection"
                    ? `Drop or paste files to upload — they're registered on B2 and filed into ${collName}`
                    : "Drop or paste files to upload to B2 — they're registered and ingested automatically"}
                <input type="file" hidden multiple onChange={(e) => onFiles(e.target.files)} />
              </label>
              {/* The button is the discoverable half; the chord anywhere over
                  the library is the half that always works. */}
              <button className="ws-pastebtn" disabled={pasting}
                      title={"Paste an image, video or audio file from the clipboard"
                             + ` — or just press ${chord} over the library (ctrl+V works too)`}
                      onClick={() => void pasteFromButton()}>
                {pasting ? <Loader2 size={14} className="ns-spin" /> : <ClipboardPaste size={14} />}
                Paste<span className="mono">{chord}</span>
              </button>
            </div>
          )}
          {pasteNote && <div className="ws-pastenote">{pasteNote}</div>}
          {reuseErr && (
            <div className="mono" style={{ fontSize: 11.5, color: "#e8c268", padding: "0 2px" }}>
              Couldn't reuse {reuseErr}
            </div>
          )}
          <div className="ws-libgrid">
            {/* In-flight generations, ahead of everything that has landed —
                the grid is ordered newest-first and these are the newest. A
                collection or the bin holds only what already exists, so the
                placeholders belong to the kind facets alone. */}
            {(sel.mode !== "kind" && sel.mode !== "project" ? [] : (pending ?? [])).filter((p) => facetKind == null
                || (facetKind === "image" && p.kind === "image_gen")
                || ((facetKind === "video" || facetKind === "render") && p.kind !== "image_gen"))
              .map((p) => (
              <div key={p.id} className="ws-libcard pending" title={p.payload?.prompt ?? p.kind}>
                <span className="ws-libthumb">
                  {/* The live sampler frame, behind the progress readout: this
                      card is a picture-shaped hole where a picture is going to
                      be, so showing the picture forming is strictly better than
                      a percentage. `?p=` busts the browser cache — the worker
                      overwrites one key for the life of the job, so the URL
                      never changes on its own. Absent (no ComfyUI previewer, or
                      a job that has not sampled yet) it simply never renders
                      and the spinner box is what it always was. */}
                  {p.preview_key && p.status === "running" && (
                    <PreviewFrame className="ws-pendprev"
                         url={`${mediaUrl(p.preview_key)}?p=${Math.round((p.progress ?? 0) * 100)}`} />
                  )}
                  <span className={"ws-pendbox" + (p.preview_key && p.status === "running" ? " over" : "")}>
                    <Loader2 size={18} className="ns-spin" />
                    <span className="mono">
                      {p.status === "queued" ? "queued"
                        : p.progress ? `${Math.round(p.progress * 100)}%` : "rendering"}
                    </span>
                    {p.progress != null && p.status === "running" && (
                      <span className="ws-pendbar"><i style={{ width: `${Math.round(p.progress * 100)}%` }} /></span>
                    )}
                  </span>
                  <span className="ws-badge" style={{ left: "auto", right: 8, top: "auto", bottom: 8 }}>
                    {p.kind === "image_gen" ? "image" : "video"}
                  </span>
                </span>
                <span style={{ display: "block", padding: "9px 11px 11px" }}>
                  <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#8fc2ff" }}>
                    {p.payload?.prompt?.slice(0, 60) || "generating…"}
                  </span>
                  <span className="mono" style={{ display: "block", fontSize: 10.5, color: "#5e6678" }}>
                    {p.progress_note || p.model_id || p.kind}
                  </span>
                </span>
              </div>
            ))}
            {(assets ?? []).map((a) => (
              // The card is a button, so "reuse" cannot live inside it — it
              // sits over the thumb as a sibling in the grid cell.
              <div key={a.id} className="ws-libcell">
                <button className="ws-libcard" draggable
                        onClick={() => ws.openModal({ kind: "asset", assetId: a.id })}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/x-qamba-asset", a.id);
                          e.dataTransfer.effectAllowed = "copy";
                        }}>
                  <span className="ws-libthumb">
                    {a.kind === "video" || a.kind === "render"
                      ? <VideoPreviewThumb src={assetUrl(a) ?? undefined} />
                      : a.kind === "audio" ? <Music size={20} />
                      : <img src={assetUrl(a) ?? undefined} alt="" loading="lazy" />}
                    <span className="ws-badge" style={{ left: "auto", right: 8, top: "auto", bottom: 8, zIndex: 4 }}>
                      {/* A hidden collection shows its binned members (they
                          can't appear in the bin itself), so they say so. */}
                      {a.deleted_at && sel.mode !== "trash" ? "in bin" : a.tags?.[0] ?? a.kind}
                    </span>
                  </span>
                  <span style={{ display: "block", padding: "9px 11px 11px" }}>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.b2_key.split("/").pop()}
                    </span>
                    <span className="mono" style={{ display: "block", fontSize: 10.5, color: "#5e6678", marginTop: 3 }}>
                      {a.kind}{a.duration_ms ? ` · ${(a.duration_ms / 1000).toFixed(1)}s` : ""}
                      {a.width ? ` · ${a.width}×${a.height}` : ""}
                    </span>
                  </span>
                </button>
                {/* Only a generation has a recipe: an upload has no job behind
                    it, and a derived asset (a grabbed frame, a transcode) has
                    one that isn't a generation. */}
                {a.origin === "generated" && a.source_job_id && !a.deleted_at && (
                  <button className="ws-libreuse" disabled={reusing === a.id}
                          title="Reuse this recipe — prompt, model, input type, references, LoRAs, size and seed, loaded into the composer below"
                          onClick={() => void reuse(a)}>
                    {reusing === a.id
                      ? <Loader2 size={12} className="ns-spin" />
                      : <CopyPlus size={12} />}
                    <span>reuse</span>
                  </button>
                )}
                {/* Same three verbs the sidebar offers by drag, for the cards
                    that are quicker to click than to drag. Keyed off the card's
                    own state, not the view: a hidden collection shows binned
                    members, and those need the bin's verbs wherever they show. */}
                <span className="ws-libacts">
                  {a.deleted_at ? (
                    <>
                      <button className="ws-libact" title="Restore to the library"
                              onClick={() => void restore(a.id).then(refresh)}>
                        <RotateCcw size={12} />
                      </button>
                      <button className={"ws-libact danger" + (armedPurge === a.id ? " armed" : "")}
                              title="Delete forever — the row, then the B2 object"
                              onClick={() => {
                                if (armedPurge !== a.id) { setArmedPurge(a.id); return; }
                                setArmedPurge(null);
                                void purge([a.id]).then(refresh);
                              }}>
                        {armedPurge === a.id ? <Check size={12} /> : <Trash2 size={12} />}
                      </button>
                    </>
                  ) : (
                    <>
                      {sel.mode === "collection" && (
                        <button className="ws-libact" title="Remove from this collection — the media stays in the library"
                                onClick={() => void unfile(a.id).then(refresh)}>
                          <X size={12} />
                        </button>
                      )}
                      <button className="ws-libact danger" title="Move to the recycle bin"
                              onClick={() => void sendToBin(a.id).then(refresh)}>
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
          {hasMore && (
            <div ref={sentinelRef} style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}>
              <span className="mono" style={{ fontSize: 10.5, color: "#5e6678",
                                               display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Loader2 size={12} className="ns-spin" />Loading more…
              </span>
            </div>
          )}
          {assets === null && (
            // First page still in flight — "No media here yet." over a loading
            // library reads as everything being gone.
            <div className="ws-empty" style={{ display: "flex", alignItems: "center",
                                               justifyContent: "center", gap: 9 }}>
              <Loader2 size={15} className="ns-spin" /> Loading media…
            </div>
          )}
          {assets !== null && !assets.length && !busy && (
            <div className="ws-empty">
              {sel.mode === "trash" ? "The bin is empty."
                : sel.mode === "collection"
                  ? `Nothing filed in ${collName} yet — open All media and drag cards onto it in the sidebar.`
                    + (inHidden ? " Anything you file here leaves the library until you un-hide it." : "")
                  : sel.mode === "project"
                    ? "No media in this project yet — drop files here or generate below."
                    : "No media here yet."}
            </div>
          )}
        </div>
      </div>
      {sel.mode !== "trash" && (
        <GenComposer projectId={projectId} collapsed={dockFolded}
                     onExpand={() => setDockFolded(false)} />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════ the shell ══ */
export default function Workspace({ view }: { view: WsView }) {
  const { pid, eid } = useParams<{ pid?: string; eid?: string }>();
  const ws = useWorkspaceStore();

  // First launch of the DESKTOP build opens setup by itself. It has to: the app
  // is useless on a fresh machine until an engine exists, and a wizard the user
  // has to go looking for is a wizard nobody runs. Once completed it never
  // appears again (`needsFirstRun` reads the stored flag), and the local-engine
  // chip in the top bar is the way back to any of it.
  //
  // Deliberately NOT gated on `pid` — this is about the machine, not a project,
  // and the projects list is exactly where a first-time user lands.
  useEffect(() => {
    if (!needsFirstRun()) return;
    // One tick, so the shell paints first: a modal that is simply THERE before
    // anything else reads as a broken page rather than as a welcome.
    const t = setTimeout(() => {
      if (!useWorkspaceStore.getState().modal) ws.openModal({ kind: "firstRun" });
    }, 400);
    return () => clearTimeout(t);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // This machine's own worker. Mounted at the SHELL, not in the composer: a
  // local render outlives whatever screen queued it, and a job left `running`
  // by a quit is reattached from here on the next launch. Idempotent, and a
  // no-op in the browser — the web build has no engine to claim for.
  useEffect(() => { startLocalWorker(); }, []);

  const { data: project } = useLiveQuery(
    () => (pid ? loadProject(pid) : Promise.resolve(null)), ["projects"], [pid]);
  const { data: episode } = useLiveQuery(
    async () => {
      if (!pid) return null;
      if (eid) return (await loadEpisodes(pid)).find((e) => e.id === eid) ?? null;
      return mainEpisode(pid);
    },
    ["episodes"], [pid, eid]);

  // Which view is on screen is a router prop, and everything else in the app
  // had to infer it. Mirror it into the shell store so the director's
  // situational context can name it (see lib/directorContext).
  useEffect(() => { ws.set("view", view); }, [view]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The library owns its own scrolling: the grid scrolls inside the view so
  // the generate dock stays pinned to the bottom instead of scrolling away.
  const scrolls = view !== "timeline" && view !== "library";
  const hasProject = Boolean(pid || project);
  return (
    <div className="ws">
      <TopBar project={project ?? null} episode={episode ?? null} view={view} hasProject={hasProject} />
      <div className="ws-body">
        {hasProject && <IconRail />}
        {/* The panel body is mounted on every project view now — the queue,
            models, library and refs panels are view-independent, and shots
            shows an empty state outside an episode. */}
        {pid && <ContextPanel episode={episode} projectId={pid} />}
        <main className={"ws-main" + (scrolls ? " scroll ns-scroll" : "")}>
          {view === "projects" && <ProjectsView />}
          {view === "timeline" && episode && pid && <TimelineView episode={episode} projectId={pid} />}
          {view === "storyboard" && episode && pid && <StoryboardView episode={episode} projectId={pid} />}
          {view === "bible" && pid && <BibleView projectId={pid} />}
          {view === "library" && <LibraryView projectId={pid ?? null} />}
          {view === "workflows" && (
            <React.Suspense fallback={
              <div className="ws-empty" style={{ display: "flex", alignItems: "center",
                                                 justifyContent: "center", gap: 9 }}>
                <Loader2 size={15} className="ns-spin" /> Loading…
              </div>
            }>
              <WorkflowsView />
            </React.Suspense>
          )}
          {/* the studio-wide views need no episode — without them here, the
              "Loading…" placeholder renders underneath the page forever */}
          {view !== "projects" && view !== "workflows"
            && view !== "library" && !episode && (
            <div className="ws-empty" style={{ display: "flex", alignItems: "center",
                                               justifyContent: "center", gap: 9 }}>
              <Loader2 size={15} className="ns-spin" /> Loading…
            </div>
          )}
        </main>
        {/* keyed on project: the dock never unmounts across a project switch
            (same route element, just new params), so its thread id, staged
            attachments and in-flight reply all have to be reset at once —
            forcing a remount is simpler and more complete than hand-tracking
            every field in an effect. */}
        <DirectorDock key={project?.id ?? "none"} project={project ?? null} episode={episode ?? null} />
      </div>
      {/* mounted once, outside the view switch: the preview keeps playing
          while you browse the storyboard, bible or library */}
      <PlayerDock
        onTimeline={view === "timeline"}
        timelineHref={pid && (eid || episode) ? `/project/${pid}/ep/${eid ?? episode!.id}/timeline` : null}
      />
      {ws.queueOpen && <QueuePopover />}
      <NewProjectModal />
      {ws.modal?.kind === "asset" && <AssetDetailModal assetId={ws.modal.assetId} />}
      {ws.modal?.kind === "prompt" && <BlockRetakeRouter blockId={ws.modal.blockId} />}
      {ws.modal?.kind === "takes" && <TakeAssemblyModal blockId={ws.modal.blockId} />}
      {ws.modal?.kind === "blockAudio" && (
        <BlockAudioModal blockId={ws.modal.blockId} clipId={ws.modal.clipId} />
      )}
      {ws.modal?.kind === "pickTake" && (
        <AssetPickerModal
          projectId={pid ?? null}
          title="Choose a take from library"
          kindFilter="all"
          defaultRole="take"
          onPick={async (picks) => {
            if (picks[0] && ws.modal?.kind === "pickTake") {
              const { blockId, clipId } = ws.modal;
              await addTakeToBlock({
                blockId,
                assetId: picks[0].asset.id,
                activate: true,
                clipId,
              });
            }
          }}
          onClose={ws.closeModal}
        />
      )}
      {ws.modal?.kind === "scene" && <SceneEditorModal sceneId={ws.modal.sceneId} />}
      {ws.modal?.kind === "entry" && <BibleEntryModal entryId={ws.modal.entryId} />}
      {ws.modal?.kind === "projectSettings" && <ProjectSettingsModal projectId={ws.modal.projectId} />}
      {ws.modal?.kind === "deleteProject" && (
        <DeleteProjectModal projectId={ws.modal.projectId} title={ws.modal.title} />
      )}
      {ws.modal?.kind === "deleteEntry" && (
        <DeleteBibleEntryModal
          entryId={ws.modal.entryId}
          name={ws.modal.name}
          kindName={ws.modal.kindName}
        />
      )}
      {ws.modal?.kind === "newEntry" && pid && (
        <NewEntryModal projectId={pid} initialKind={ws.modal.entryKind} />
      )}
      {ws.modal?.kind === "loreImport" && (
        <LoreImportModal projectId={ws.modal.projectId} />
      )}
      {ws.modal?.kind === "loreDoc" && (
        <LoreDocModal docId={ws.modal.docId} projectId={ws.modal.projectId} />
      )}
      {/* Both are lazy for the same reason WorkflowsView is: the Civitai hub
          pulls in the graph adapter and the local-engine client, and the setup
          wizard only ever opens in the desktop build. Neither belongs in the
          bundle a browser downloads to look at a timeline. */}
      {ws.modal?.kind === "civitai" && (
        <React.Suspense fallback={null}>
          <CivitaiImportModal projectId={ws.modal.projectId ?? pid ?? null} />
        </React.Suspense>
      )}
      {ws.modal?.kind === "firstRun" && (
        <React.Suspense fallback={null}><FirstRunSetupModal /></React.Suspense>
      )}
      {ws.modal?.kind === "engine" && (
        <React.Suspense fallback={null}><EngineModal tab={ws.modal.tab} /></React.Suspense>
      )}
      {ws.modal?.kind === "wizard" && (() => {
        const targetPid = ("projectId" in ws.modal && ws.modal.projectId) || pid;
        const isTargetReady = project && (!targetPid || project.id === targetPid);
        return isTargetReady ? (
          // same reasoning as DirectorDock above: the modal's side-chat thread
          // id has no project-change reset of its own, so a project switch
          // while it's open must remount it rather than carry the old thread.
          // The fallback keeps the click visible while the chunk downloads.
          <React.Suspense fallback={
            <ModalShell width={1100} tall z={95} icon={<Sparkles size={16} />}
                        title="One-shot wizard" loading loadingLabel="Opening the wizard…" />
          }>
            <WizardModal
              key={project.id}
              project={project}
              episode={episode && episode.project_id === project.id ? episode : null}
            />
          </React.Suspense>
        ) : (
          <ModalShell width={1100} tall z={95} icon={<Sparkles size={16} />}
                      title="One-shot wizard" loading loadingLabel="Opening the wizard…" />
        );
      })()}
    </div>
  );
}

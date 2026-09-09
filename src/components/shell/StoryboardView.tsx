// The shot list. It answers three questions in the order they get asked:
// where am I in the episode (the ruler), what does this scene look like (the
// key-still column) and what will actually render — beats grouped inside the
// BLOCK bracket they compile into, with H3's 15s cap drawn rather than
// described. Only the scene being worked on is expanded; the rest collapse to
// a row that still reads.
//
// Lifted out of Workspace.tsx (same shape as CostsView) once it outgrew an
// inline view function.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Camera, ChevronDown, Clapperboard, Film, GripVertical,
  Loader2, MoreHorizontal, RefreshCw, Sparkles, Trash2, Volume2, Wand2, X,
} from "lucide-react";
import Dropdown from "../ui/Dropdown";
import Lightbox, { stepIndex } from "../ui/Lightbox";
import ScenePanelGrid from "./ScenePanelGrid";
import DeleteSceneDialog from "../modals/DeleteSceneDialog";
import PanelRegenModal from "../modals/PanelRegenModal";
import { ST } from "./ContextPanel";
import { planBlockStatus } from "../../lib/staleBlocks";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { byIds, useDragReorder } from "../../hooks/useDragReorder";
import {
  loadBible, loadBibleAssets, loadStoryboardFull, markSceneBlocksStale,
  reorderScenes, saveBeat, saveScene, storyboardsForEpisode,
} from "../../lib/db/director";
import { blocksWithLiveRender, enqueueJob, queueBlockRender } from "../../lib/db/jobs";
import { beatImageId, panelDefaults, queueScenePanels, queueSceneStill } from "../../lib/panels";
import { catalogIdOf, modelKeyOf, resolveDefaults, type ProjectSettings } from "../../lib/projectSettings";
import { modelNameByKey, sceneModelState, type ModelBlock } from "../../lib/blockModel";
import { loadCatalog } from "../../lib/catalog";
import { blockRef } from "../../../director/refs.js";
import { assetUrl, loadGenerationSource } from "../../lib/db/assets";
import { supabase } from "../../lib/supabase";
import { asArray, asStringList } from "../../lib/jsonb";
import type { Asset, Beat, Episode, GenerationBlock, Scene } from "../../lib/db/types";

/** H3 renders 15s at most (invariant #5) — the bracket draws it as a bar. */
const CAP_MS = 15000;
/** Adjacent brackets alternate so they read as separate renders. Two colours,
 *  because a third would look like it meant something. */
const ACCENTS = ["#5aa2ff", "#c97aff"];

const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const fmtAt = (ms: number) => (ms / 1000).toFixed(1);
const fmtClock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

interface MusicJob {
  id: string;
  status: string;
  progress: number | null;
  progress_note: string | null;
  error_msg: string | null;
  payload: { target?: { storyboard_id?: string }; label?: string;
             model_key?: string; instrumental?: boolean } | null;
}

/** The episode's soundtrack, wherever it came from.
 *
 *  A generated track is queued at plan time and arrives minutes later, so this
 *  has three states and all three matter: rendering (with the model named,
 *  because that is the choice someone made), ready (playable, and on a music
 *  video also the thing every block was cut against), and failed — which is
 *  the one worth showing loudest, since a music video whose track never
 *  arrived renders against silence and looks fine until you play it.
 */
function ScoreStrip({ job, asset, beats, locked }: {
  job: MusicJob | null; asset: Asset | null;
  beats: number | null; locked: boolean;
}) {
  if (!job && !asset) return null;
  const failed = job?.status === "error";
  const rendering = !!job && (job.status === "queued" || job.status === "running");
  const tone = failed ? "#e46e6e" : asset ? "#6fd08c" : "#ffb454";
  const url = asset ? assetUrl(asset) : null;
  return (
    <div className="sb-score" style={{ borderColor: `${tone}44`, background: `${tone}0d` }}>
      <Volume2 size={13} style={{ color: tone, flexShrink: 0 }} />
      <span className="sb-scorelabel">
        {failed ? "Score failed"
          : rendering ? (job!.status === "running" ? "Writing the score" : "Score queued")
          : locked ? "Master track" : "Score"}
      </span>
      {url && (
        // A plain <audio>: the track is one file on a public bucket and this
        // is a "is it there, what does it sound like" control, not the
        // timeline's scrubber.
        <audio controls preload="none" src={url} style={{ height: 30, flex: 1, minWidth: 160 }} />
      )}
      {rendering && (
        <>
          <Loader2 size={12} className="ns-spin" style={{ color: tone, flexShrink: 0 }} />
          <span className="mono sb-scorenote">
            {job!.payload?.model_key ?? "music"}
            {job!.progress ? ` · ${Math.round(job!.progress * 100)}%` : ""}
            {job!.progress_note ? ` · ${job!.progress_note}` : ""}
          </span>
        </>
      )}
      {failed && (
        <span className="mono sb-scorenote" style={{ color: "#e46e6e" }}>
          {(job!.error_msg ?? "failed").slice(0, 90)}
        </span>
      )}
      {!rendering && !failed && asset && (
        <span className="mono sb-scorenote">
          {asset.duration_ms ? fmtClock(asset.duration_ms) : ""}
          {/* Only on a music video, because only there does the beat grid do
              anything: `plan_blocks` snaps every block boundary to it. */}
          {locked && beats ? ` · ${beats} beats · blocks cut to it` : ""}
        </span>
      )}
    </div>
  );
}

function StatusChip({ tone, label, pulse, title }: {
  tone: string; label: string; pulse?: boolean; title?: string;
}) {
  return (
    <span className={"sb-status" + (pulse ? " pulse" : "")} title={title}
          style={{ background: `${tone}1f`, borderColor: `${tone}55`, color: tone }}>
      <i />{label}
    </span>
  );
}

/** Click-to-edit prose. The storyboard is a document you read far more often
 *  than you rewrite, so a field only becomes an input once you aim at it —
 *  a column of textareas is what made the old list a wall. */
function EditField({ value, placeholder, cls, rows = 2, open, onOpen, onClose, onSave, disabled }: {
  value: string; placeholder: string; cls: string; rows?: number;
  open: boolean; onOpen: () => void; onClose: () => void;
  onSave: (v: string) => void; disabled?: boolean;
}) {
  if (!open) {
    return (
      <button type="button" className={cls + (value ? "" : " ph")} disabled={disabled}
              title={disabled ? "This scene is generating" : "Click to edit"}
              onClick={onOpen}>
        {value || placeholder}
      </button>
    );
  }
  return (
    <textarea className="ws-input ns-scroll" autoFocus rows={rows} defaultValue={value}
              style={{ fontSize: 13.5, lineHeight: 1.55 }}
              onBlur={(e) => { onClose(); if (e.target.value !== value) onSave(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.currentTarget.value = value; e.currentTarget.blur(); }
              }} />
  );
}

/** A beat whose action repeats an earlier one in the same scene.
 *
 * The planner pads a short scene by holding a shot, and `splitBeat` writes the
 * same sentence with "— held a moment longer" on the end. Both cost a whole
 * extra render and read as a mistake in the cut, so they're flagged where
 * they'd otherwise pass for a new shot. */
/** The shot size out of a prose camera line, longest match first so "medium
 *  wide" doesn't read as "wide". The cinematographer stage writes sentences,
 *  not fields, so this is a display aid — the prose stays next to it. */
const SIZES = [
  "extreme close-up", "extreme close", "medium close", "medium wide", "over-the-shoulder",
  "establishing", "close-up", "two-shot", "insert", "close", "medium", "wide", "full",
];
const sizeOf = (camera: string | null) => {
  const s = (camera ?? "").toLowerCase();
  return SIZES.find((k) => s.includes(k)) ?? null;
};

const HELD = /\s*[—-]\s*held a moment longer\.?\s*$/i;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");

function repeatOf(beat: Beat, earlier: Beat[]): { of: Beat; note: string } | null {
  const raw = beat.action ?? "";
  if (!raw.trim()) return null;
  const a = norm(raw);
  const held = norm(raw.replace(HELD, ""));
  for (const p of earlier) {
    const pa = norm(p.action ?? "");
    if (!pa) continue;
    if (pa === a) return { of: p, note: "identical action" };
    if (HELD.test(raw) && pa === held) return { of: p, note: "held a moment longer" };
  }
  return null;
}

export default function StoryboardView({ episode, projectId }: {
  episode: Episode; projectId: string;
}) {
  const ws = useWorkspaceStore();
  const [sbId, setSbId] = useState<string | null>(null);
  // null = "nothing chosen yet", which resolves to the first scene. Keeping it
  // out of an effect means opening a scene never fights a re-fetch.
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  // The scene whose delete dialog is open, held BY VALUE: the row leaves
  // `scenes` the moment the delete lands, and a dialog looked up out of the
  // list would unmount itself before it could report a partial failure.
  const [delScene, setDelScene] = useState<Scene | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The launch's own two states, apart from `note` because they are the two
  // halves of one gesture: `launching` disables the button while the writes
  // are in flight and `launchErr` is what the button could not do. Both are
  // cleared by the next press, so a receipt never outlives its own action.
  const [launching, setLaunching] = useState(false);
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const [stillsInFlight, setStillsInFlight] = useState(false);
  const [queuingSceneId, setQueuingSceneId] = useState<string | null>(null);
  const [scoreInFlight, setScoreInFlight] = useState(false);
  // The zoomed slideshow: which scene, and which of its drawn panels. Local
  // state, not a ws.openModal kind — every panel it pages through is already
  // loaded on this page, so routing it through the global modal slot would
  // just be a slower way to hold two numbers.
  const [lightbox, setLightbox] = useState<{ sceneId: string; index: number } | null>(null);
  // The panel's prompt & references editor, once its source has been loaded —
  // same shape and same reasoning as the scene editor's copy.
  const [regen, setRegen] =
    useState<{ asset: Asset; prompt: string; refs: Asset[]; label: string | null; beatId: string } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const { data, loading, reload } = useLiveQuery(
    async () => {
      // The whole list, always — not just when nothing is selected. It is one
      // small query and it is what the version picker renders; fetching it only
      // on the cold path is how "the newest plan" stayed the only reachable one.
      const boards = await storyboardsForEpisode(episode.id);
      let id = sbId;
      if (!id || !boards.some((b) => b.id === id)) {
        id = boards[0]?.id ?? null;
        if (id) setSbId(id);
      }
      if (!id) return null;
      const [full, { bible, links }, proj, stillJobsRes, musicJobsRes, catalog] = await Promise.all([
        loadStoryboardFull(id),
        // The link rows only need the bible, so they ride this round instead
        // of adding a sequential one after it.
        loadBible(projectId).then(async (bible) => ({
          bible,
          links: bible.length ? await loadBibleAssets(bible.map((b) => b.id)) : [],
        })),
        supabase.from("projects").select("style,settings,medium").eq("id", projectId).maybeSingle(),
        // Which still is being made right now, so a tile can say so instead of
        // sitting empty while the GPU works.
        // Claim order, not insertion order: unordered, this 60-row window was
        // an arbitrary slice of a panel batch and could miss the one being
        // drawn — see loadRecentJobs in lib/db/jobs.ts.
        supabase.from("jobs").select("id,status,payload")
          .eq("kind", "image_gen").in("status", ["queued", "running"])
          .order("priority", { ascending: true })
          .order("created_at", { ascending: true }).limit(60),
        // The score, while it renders. A generated track is queued at plan
        // time and lands minutes later, so without this the storyboard says
        // nothing at all about the thing the whole episode may be cut to.
        supabase.from("jobs").select("id,status,progress,progress_note,error_msg,payload")
          .eq("kind", "music_gen").order("created_at", { ascending: false }).limit(12),
        // For the retake's `model_id` and for naming the checkpoint a scene
        // will actually render on. Cached module-side, so this is a round trip
        // once per session — and it is NEVER allowed to fail the page: the
        // storyboard read fine without a catalog for its whole life, and the
        // two things that need it degrade to a raw model_map key and to the
        // old `h3-local` constant rather than to a load error.
        loadCatalog().catch(() => []),
      ]);
      const beatStills = [...full.beats.values()].flat()
        .flatMap((b) => [b.meta?.still_asset_id as string | undefined,
                         b.meta?.panel_asset_id as string | undefined]);
      const ids = [...new Set([
        ...links.map((l) => l.asset_id),
        ...full.scenes.map((s) => s.still_asset_id),
        ...beatStills,
        full.storyboard.audio_asset_id,
      ].filter(Boolean) as string[])];
      const { data: assets } = ids.length
        ? await supabase.from("assets").select("*").in("id", ids) : { data: [] };
      const jobs = (stillJobsRes.data ?? []) as { status: string; payload: { target?: { scene_id?: string; beat_id?: string } } }[];
      const pending = new Map<string, { status: string }>();
      for (const j of jobs) {
        const t = j.payload?.target ?? {};
        if (t.scene_id) pending.set(`s:${t.scene_id}`, { status: j.status });
        if (t.beat_id) {
          const prev = pending.get(`b:${t.beat_id}`);
          if (!prev || (prev.status === "queued" && j.status === "running")) {
            pending.set(`b:${t.beat_id}`, { status: j.status });
          }
        }
      }
      setStillsInFlight(pending.size > 0);
      // The one that is FOR this storyboard — `target.storyboard_id` is what
      // the worker writes the track back through, so it is also the only
      // honest way to tell "a track is coming" from "someone is making a
      // track for something else".
      const musicJobs = (musicJobsRes.data ?? []) as MusicJob[];
      const scoreJob = musicJobs.find(
        (j) => j.payload?.target?.storyboard_id === id
          && ["queued", "running", "error"].includes(j.status)) ?? null;
      setScoreInFlight(!!scoreJob && scoreJob.status !== "error");
      return {
        ...full, boards, bible, links, pending, scoreJob,
        style: (proj.data as { style?: string } | null)?.style ?? null,
        // What decides whether the track is a BED or the thing the render is
        // locked to — `handle_launch_render` reads the same field.
        medium: (proj.data as { medium?: string } | null)?.medium ?? null,
        // Style guide + image model exactly as every other generator resolves
        // them — see panelDefaults for what each surface used to do instead.
        panelDefaults: panelDefaults(
          (proj.data as { settings?: ProjectSettings } | null)?.settings,
          (proj.data as { style?: string } | null)?.style ?? null),
        catalog,
        // The project's Video model, as both spellings: the catalog id goes on
        // the re-stamp, the model_map key is what a block's own `model_key` is
        // compared against.
        projModelId: resolveDefaults(
          (proj.data as { settings?: ProjectSettings } | null)?.settings).video_model,
        videoNames: modelNameByKey(catalog, modelKeyOf),
        assets: new Map(((assets ?? []) as Asset[]).map((a) => [a.id, a])),
      };
    },
    ["storyboards", "scenes", "beats", "generation_blocks"],
    [episode.id, projectId, sbId], 400,
    // Realtime carries the still landing (it lands as a `scenes` update), but
    // not the queued→running hop in between. Costs nothing when idle. The
    // score is the same shape of gap — it arrives as a `storyboards` update,
    // and everything before that is job progress this query has to ask for.
    stillsInFlight || scoreInFlight ? 5000 : 0);

  const sceneIds = useMemo(() => (data?.scenes ?? []).map((s) => s.id), [data?.scenes]);
  const sbRowId = data?.storyboard.id;
  const drag = useDragReorder(sceneIds, useCallback(async (ids: string[]) => {
    if (!sbRowId) return;
    await reorderScenes(sbRowId, ids);
    reload();
  }, [sbRowId, reload]));

  /* Where the user is on THIS screen, mirrored into the shell store.
     `open`/`editing` were component-local, so the director could be asked
     about "this beat" while having no way to know which one that was. The
     scene is only reported when exactly one is expanded — "open" means
     nothing when you have hit Expand all. Cleared on unmount, because a
     context still naming a scene you left three views ago is worse than one
     naming nothing. */
  const openKey = open ? [...open].sort().join(",") : "";
  const firstSceneId = data?.scenes[0]?.id ?? null;
  useEffect(() => {
    const ids = open ? [...open] : (firstSceneId ? [firstSceneId] : []);
    const single = ids.length === 1 ? ids[0] : null;
    ws.set("openSceneId", single ?? (editing?.startsWith("s:") ? editing.slice(2) : null));
    ws.set("editingBeatId", editing?.startsWith("b:") ? editing.slice(2) : null);
  }, [openKey, editing, firstSceneId]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    const s = useWorkspaceStore.getState();
    s.set("openSceneId", null);
    s.set("editingBeatId", null);
  }, []);

  if (!data) {
    // Loading and "there is no storyboard" are different answers, and showing
    // the second while the first is true told everyone their plan was gone
    // for the length of every load.
    if (loading) {
      return (
        <div className="ws-empty" style={{ display: "flex", alignItems: "center",
                                           justifyContent: "center", gap: 9 }}>
          <Loader2 size={15} className="ns-spin" /> Loading storyboard…
        </div>
      );
    }
    return <div className="ws-empty">No storyboard yet — run the one-shot wizard or ask the director.</div>;
  }

  const { storyboard, scenes, beats, blocks, bible, links, assets, pending,
          projModelId, videoNames } = data;
  // The project's Video model as a model_map key — undefined for a desktop
  // `local:` pick, which is what `sceneModelState` reads as "could not tell"
  // rather than as drift.
  const projModelKey = modelKeyOf(projModelId);
  const bibleById = new Map(bible.map((b) => [b.id, b]));
  const total = scenes.reduce((n, s) => n + s.duration_ms, 0);
  const openSet = open ?? new Set(scenes.length ? [scenes[0].id] : []);
  const assetOf = (id?: string | null) => (id ? assets.get(id) ?? null : null);
  const firstRefOf = (entryId: string) =>
    links.filter((l) => l.entry_id === entryId).sort((a, b) => a.slot - b.slot)[0]?.asset_id;
  const blocksFor = (sceneId: string) => blocks.filter((b) => b.scene_ids.includes(sceneId));
  /** A scene's drawn panels, in shot order — what the zoomed slideshow pages
   *  through. Only beats that resolved to a picture (beatImageId's
   *  precedence: a deliberate still, else the generated panel) can appear. */
  const panelAssets = (sceneId: string) =>
    (beats.get(sceneId) ?? [])
      .map((b) => ({ beat: b, asset: assetOf(beatImageId(b).id) }))
      .filter((x): x is { beat: Beat; asset: Asset } => !!x.asset);
  const toggle = (id: string) =>
    setOpen(() => {
      const next = new Set(openSet);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const focusScene = (id: string) => {
    if (!openSet.has(id)) toggle(id);
    rowRefs.current.get(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  /** The key still, drawn through the same generator as the panels — see
   *  lib/panels.ts `sceneStillSpec` for why it stopped hand-rolling its own
   *  references and prose. */
  const generateStill = async (scene: Scene) => {
    const n = await queueSceneStill(scene, {
      projectId, episodeId: episode.id, bible, ...data.panelDefaults,
    });
    setNote(`Key still queued for ${scene.slug ?? "the scene"}`
      + (n ? ` · ${n} anchor${n === 1 ? "" : "s"}` : " · no anchors, faces will drift"));
  };

  /** One panel per shot — the scene's storyboard. The job it queues lives in
   *  lib/panels.ts, shared with the scene editor and mirroring what tier 1
   *  queues in worker/llm.py: one mechanism, so a panel drawn here is the
   *  same picture as a panel drawn anywhere else. */
  const generatePanels = async (scene: Scene) => {
    const mine = (data.beats.get(scene.id) ?? []) as Beat[];
    if (!mine.length) { setNote("This scene has no shots yet."); return; }
    setQueuingSceneId(scene.id);
    try {
      const n = await queueScenePanels(scene, mine, {
        projectId, episodeId: episode.id, bible, ...data.panelDefaults,
      });
      setNote(`${n} panel${n === 1 ? "" : "s"} queued for ${scene.slug ?? "the scene"}`);
      reload();
    } finally {
      setQueuingSceneId(null);
    }
  };

  /** Redraw an existing panel, prompt first — see the scene editor's twin for
   *  why a panel is the one picture you argue with rather than re-roll. */
  const openPanelEditor = async (assetId: string, beatId: string) => {
    const src = await loadGenerationSource(assetId);
    if (!src?.prompt) {
      setNote("That picture has no stored prompt — draw a panel first, then it can be edited.");
      return;
    }
    setRegen({ asset: src.asset, prompt: src.prompt, refs: src.refs, label: src.label, beatId });
  };

  /** Roll this scene's blocks again.
   *
   *  `recompute_refs` is what makes the button mean what the page implies.
   *  `handle_master_pass` stages the plan STORED on the block, computed when
   *  the episode was planned — so redrawing a panel here (or recasting a
   *  voice, or casting an outfit variant, or redrawing a location plate)
   *  moved every text surface on this page and reached the render nowhere:
   *  `ref_plan` still named the archived asset ids and the retake came back
   *  staging the pictures that had just been replaced. Nothing errors, which
   *  is why it reads as the redraw not having worked.
   *
   *  It is the same flag `queueStaleRerenders` and the director's
   *  `rerender_block` already send by default — this surface was the outlier —
   *  and it needs no pod deploy: the worker has always read it.
   *
   *  The cost, stated because it is silent: a recompute REPLACES the plan and
   *  writes it back, so a reference hand-picked in the prompt & references
   *  modal does not survive one (a designated closing frame does — the worker
   *  carries it across, since nothing derives one from the beats). That modal
   *  deliberately does not send this flag, so its own regenerate still renders
   *  exactly what it shows.
   */
  const retakeBlocks = async (scene: Scene) => {
    setArmed(null);
    // WHICH BLOCKS ARE ACTUALLY BUSY — asked of the JOBS table, not of the
    // block's status. `queued`/`generating` is a status the worker writes on
    // claim and a cancelled job never clears, so a block can sit `queued` with
    // nothing coming and be skipped by every retake forever. Measured on this
    // studio's own data: a cancelled render left b17 stranded, the next retake
    // of its scene silently rendered one of two blocks, and the receipt said
    // it had queued them. A stranded block is re-queued; a genuinely live one
    // is left alone AND NAMED, because a skip nobody is told about is what
    // made the first failure invisible.
    const all = blocksFor(scene.id);
    const claimed = all.filter((b) => b.status === "queued" || b.status === "generating");
    const live = await blocksWithLiveRender(claimed.map((b) => b.id));
    const busy = claimed.filter((b) => live.has(b.id));
    const mine = all.filter((b) => !live.has(b.id));
    // The catalog, for `catalogIdOf` — loaded with the page, and never
    // allowed to fail the retake: `model_id` is bookkeeping, so an unreadable
    // catalog degrades to the old constant instead of leaving the scene
    // unrendered.
    const catalog = data?.catalog ?? [];
    for (const b of mine) {
      await queueBlockRender(b.id, {
        project_id: projectId, episode_id: episode.id,
        // …so the queue row reads "b12 retake (yours)" rather than "b? retake".
        blockIdx: b.idx,
        // NOT "h3-local". This column does not pick the checkpoint —
        // `_block_model` does, off the block's own `params.model_key` — but it
        // is what `job_timings` and `cost_ledger` file the render under, so
        // hardcoding it booked every PDD and turbo block's wall time against
        // plain h3 and skewed the per-model ETA that corrects itself from
        // those samples. Deliberately NOT accompanied by a `model_key` on the
        // payload: that would be a per-run OVERRIDE of a value the block
        // already holds authoritatively, and computing it here is a second
        // chance to get it wrong.
        model_id: catalogIdOf(b.params as Record<string, unknown> | null, catalog),
        payload: {
          auto_activate: false, take_of: true, recompute_refs: true,
          seed: Math.floor(Math.random() * 1e9),
        },
      });
    }
    setNote(
      (mine.length
        ? `Queued ${mine.length} retake${mine.length === 1 ? "" : "s"} for `
          + `${scene.slug ?? "the scene"} — references restaged, so redrawn `
          + "panels and sheets are what render."
        : `Nothing to retake in ${scene.slug ?? "this scene"}.`)
      // Name them. "Queued 1 retake" on a two-block scene is the same lie as
      // reporting a partial failure as a success.
      + (busy.length
        ? ` ${busy.map((b) => blockRef(b.idx)).join(", ")} `
          + `${busy.length === 1 ? "is" : "are"} already rendering — left alone.`
        : ""));
    reload();
  };

  /** Approve the storyboard and hand it to the pod.
   *
   *  The press is two writes and then a wait of minutes, so it has to leave a
   *  receipt: without one, a launch and a launch that was REFUSED look
   *  identical — and the refusal is the likely case, since `enqueueJob` throws
   *  its own sentence for a local project (the pod cannot see one) and the
   *  `storyboards` update is RLS-refusable for a viewer on a shared project.
   *  That update is therefore checked rather than fired and forgotten: queued
   *  behind a status that never moved to `approved`, the render is a job the
   *  page has no way to explain.
   *
   *  The generating check is the worker's own — `handle_launch_render` raises
   *  "a block is currently generating" — asked here so the answer arrives on
   *  the click instead of on the pod, minutes later, under a receipt that had
   *  already said the launch worked.
   */
  const launchRender = async () => {
    setNote(null);
    setLaunchErr(null);
    if (blocks.some((b) => b.status === "generating")) {
      setLaunchErr("A block is still generating — cancel it before re-launching, "
        + "or the plan will be refused.");
      return;
    }
    setLaunching(true);
    try {
      const { error } = await supabase.from("storyboards")
        .update({ status: "approved" }).eq("id", storyboard.id);
      // A PostgrestError is a plain object, not an Error — throwing it raw
      // would reach the catch below and stringify as "[object Object]".
      if (error) throw new Error(error.message);
      await enqueueJob({
        kind: "launch_render", lane: "cpu", priority: 30,
        project_id: projectId, episode_id: episode.id,
        payload: { storyboard_id: storyboard.id },
      });
      // What it will DO, not just that it went: a re-launch throws away the
      // planner's blocks and the takes hanging off them, which is worth
      // reading after the fact and not only in the button's own verb.
      setNote(blocks.length
        ? "Render re-launched — queued for the studio cloud. It replaces the current "
          + `${blocks.length} block${blocks.length === 1 ? "" : "s"} and their takes; `
          + "blocks you made on the timeline are kept."
        : "Render launched — queued for the studio cloud. It plans the blocks, then "
          + "renders them one at a time.");
    } catch (e) {
      setLaunchErr((e as { message?: string })?.message || String(e));
    } finally {
      setLaunching(false);
      reload();
    }
  };

  /** What follows a delete on THIS screen. The delete itself, and every
   *  consequence of it, belongs to DeleteSceneDialog — see db/director.ts
   *  `deleteScene` for the three writes and why only the first one throws.
   *  The pictures already drawn are NOT deleted: they are ordinary library
   *  assets, and destroying them because a scene was cut is more damage than
   *  the action implies (the same line the bin draws). */
  const sceneDeleted = (scene: Scene) => {
    const shots = (beats.get(scene.id) ?? []).length;
    setDelScene(null);
    // The row is gone, so anything on this screen still pointing at it would
    // be holding an id that resolves to nothing.
    setOpen((cur) => {
      if (!cur?.has(scene.id)) return cur;
      const next = new Set(cur); next.delete(scene.id); return next;
    });
    setEditing((cur) => (cur === `s:${scene.id}` ? null : cur));
    if (armed === scene.id) setArmed(null);
    setNote(`Deleted ${scene.slug ?? `SCENE ${scene.idx + 1}`}`
      + (shots ? ` and its ${shots} shot${shots === 1 ? "" : "s"}` : "")
      + " · re-launch the render to rebuild the block plan.");
    reload();
  };

  /** Fold a repeat back into the beat it repeats: its time goes to that beat,
   *  the row goes away, and the block re-compiles one shot shorter. */
  const mergeRepeat = async (scene: Scene, beat: Beat, into: Beat) => {
    await saveBeat(into.id, { duration_ms: into.duration_ms + beat.duration_ms });
    await supabase.from("beats").delete().eq("id", beat.id);
    const later = (beats.get(scene.id) ?? []).filter((x) => x.idx > beat.idx)
      .sort((a, c) => a.idx - c.idx);
    for (const x of later) await saveBeat(x.id, { idx: x.idx - 1 });
    await markSceneBlocksStale(scene.id);
    reload();
  };

  const editBeat = async (scene: Scene, beat: Beat, patch: Partial<Beat>) => {
    await saveBeat(beat.id, patch);
    await markSceneBlocksStale(scene.id);
    reload();
  };

  const running = storyboard.status === "rendering"
    || blocks.some((b) => b.status === "queued" || b.status === "generating");

  let acc = 0;
  const windows = new Map<string, { t0: number; t1: number }>();
  for (const s of scenes) { windows.set(s.id, { t0: acc, t1: acc + s.duration_ms }); acc += s.duration_ms; }

  return (
    <>
      <div className="ws-viewhead">
        <span className="ws-h2">Storyboard</span>
        {/* Re-planning inserts a board rather than replacing one, and every read
            takes the newest — so before this the previous plan kept its scenes,
            beats and blocks and became unreachable. The picker is the whole fix:
            the rows were always there. Only shown when there IS a choice, since
            "v1" alone on a page with one plan is a control that does nothing. */}
        {(data.boards?.length ?? 0) > 1 && (
          <Dropdown width={260}
            trigger={({ toggle }) => (
              <button className="ws-ghost" onClick={toggle}
                      title={storyboard.id === data.boards[0].id
                        ? "The current plan. Earlier ones are still here — each keeps its own scenes, beats and blocks."
                        : `You are reading an earlier plan. v${data.boards[0].version} is the current one.`}
                      style={{ height: 26, padding: "0 9px", gap: 6,
                               // Amber when this is NOT the newest: a re-plan
                               // does not move you off the version you were
                               // reading, so the page has to say which one it is
                               // rather than let you edit a superseded plan.
                               ...(storyboard.id === data.boards[0].id ? {} : {
                                 borderColor: "rgba(255,180,84,.45)",
                                 background: "rgba(255,180,84,.1)", color: "#ffb454" }) }}>
                <span className="mono" style={{ fontSize: 11 }}>
                  v{storyboard.version}{storyboard.id === data.boards[0].id
                    ? "" : ` of ${data.boards[0].version}`}
                </span>
                <ChevronDown size={12} />
              </button>
            )}>
            {(close) => (
              <>
                {data.boards.map((b) => (
                  <button key={b.id} className="ws-menu-row"
                          onClick={() => { setSbId(b.id); setOpen(new Set()); close(); }}>
                    <span className="mono" style={{ width: 26, flexShrink: 0,
                                                    color: b.id === storyboard.id ? "#c97aff" : "#5e6678" }}>
                      v{b.version}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {String((b.brief as { title?: string })?.title ?? "").trim() || b.status}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: "#5e6678", flexShrink: 0 }}>
                      {new Date(b.created_at).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </>
            )}
          </Dropdown>
        )}
        <StatusChip tone={running ? "#ffb454" : storyboard.status === "complete" ? "#6fd08c" : "#8b93a7"}
                    label={storyboard.status} pulse={running} />
        <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", color: "#5e6678" }}>
          {scenes.length} SCENES · {blocks.length} BLOCKS · {fmtClock(total)}
        </span>
        <span style={{ flex: 1 }} />
        <button className="ws-ghost" onClick={() => setOpen(new Set(openSet.size ? [] : sceneIds))}>
          {openSet.size ? "Collapse all" : "Expand all"}
        </button>
        {/* Disabled while the two writes are in flight, because a second press
            queues a second `launch_render` — and each one replaces the whole
            block plan, taking its takes with it. */}
        <button className="ws-render" onClick={launchRender} disabled={launching}>
          {launching
            ? <Loader2 size={14} className="ns-spin" />
            : <Clapperboard size={14} />}
          {launching ? "Launching…" : blocks.length ? "Re-launch render" : "Launch render"}
        </button>
      </div>

      {/* Where the episode is, in one line: width is time, colour is render
          state, hatch is "no key still". */}
      {scenes.length > 1 && (
        <div className="sb-ruler">
          {scenes.map((s) => {
            const mine = blocksFor(s.id);
            // Through `planBlockStatus` before the fold, not after: it is what
            // decides whether `stale` is a status this screen may say at all,
            // and a scene is coloured by the worst thing IN it.
            const mineSt = mine.map((b) => planBlockStatus(b.status, !!b.active_take_id));
            const st = mineSt.length
              ? (["generating", "queued", "failed", "stale", "planned"] as const)
                  .find((k) => mineSt.includes(k)) ?? "generated"
              : "planned";
            const tone = ST[st] ?? "#5b6478";
            return (
              <button key={s.id} type="button"
                      className={"sb-rulerseg" + (openSet.has(s.id) ? " on" : "") + (s.still_asset_id ? "" : " nostill")}
                      style={{ flex: Math.max(s.duration_ms, 1), color: tone }}
                      title={`${s.slug ?? `S${s.idx + 1}`} · ${fmtS(s.duration_ms)} · ${st}${s.still_asset_id ? "" : " · no key still"}`}
                      onClick={() => focusScene(s.id)}>
                <i style={{ background: tone }} />
                <span>{s.slug ?? `S${s.idx + 1}`}</span>
              </button>
            );
          })}
          <span className="sb-rulerlegend">▨ no key still</span>
        </div>
      )}

      {/* The soundtrack sits under the ruler because it is the same kind of
          fact: one line about the whole episode, not about any scene. */}
      <ScoreStrip
        job={data.scoreJob}
        asset={storyboard.audio_asset_id
          ? data.assets.get(storyboard.audio_asset_id) ?? null : null}
        beats={(storyboard.audio_meta?.beats_ms ?? []).length || null}
        locked={!!storyboard.audio_asset_id && data.medium === "music_video"} />

      {note && (
        <div className="ws-inlinewarn" style={{ marginBottom: 10, color: "#6fd08c",
                                                borderColor: "rgba(111,208,140,.3)",
                                                background: "rgba(111,208,140,.07)" }}>
          {note}
          <button onClick={() => setNote(null)}><X size={11} /></button>
        </div>
      )}
      {launchErr && (
        <div className="ws-inlinewarn" style={{ marginBottom: 10 }}>
          couldn't launch the render: {launchErr}
          <button onClick={() => setLaunchErr(null)}><X size={11} /></button>
        </div>
      )}
      {drag.error && (
        <div className="ws-inlinewarn" style={{ marginBottom: 10 }}>
          couldn't re-order: {drag.error}
          <button onClick={drag.clearError}><X size={11} /></button>
        </div>
      )}

      {/* The query container for the rows below. It has to be THIS and not a
          media query: the context panel is a 350px rail that opens and closes
          under a fixed window width, so the window says nothing about how
          much room a row actually has. */}
      <div className="sb-scenes" {...drag.listProps}>
        {byIds(scenes, drag.ids).map((s, i) => {
          const win = windows.get(s.id) ?? { t0: 0, t1: s.duration_ms };
          const mine = beats.get(s.id) ?? [];
          const sceneBlocks = blocksFor(s.id);
          const locked = sceneBlocks.some((b) => b.status === "generating");
          // WHAT THE RETAKE WILL ACTUALLY RENDER ON. `_block_model` reads the
          // BLOCK's own `params.model_key`, stamped once at plan time, so the
          // project's Video model does not reach a board that was already
          // planned — and the retake said nothing about the difference. Named
          // on the button and in the confirm so the surprise cannot recur;
          // the scene editor is where it can be changed.
          const vmodel = sceneModelState(
            s, sceneBlocks as unknown as ModelBlock[], projModelKey);
          const vmodelLabel = vmodel.byKey.length === 1
            ? (videoNames.get(vmodel.byKey[0].key) ?? vmodel.byKey[0].key)
            : `${vmodel.byKey.length} models`;
          const still = assetOf(s.still_asset_id);
          const withStills = mine.filter((b) => b.meta?.still_asset_id || b.meta?.panel_asset_id).length;
          const scenePanels = panelAssets(s.id);
          const last = i === drag.ids.length - 1;
          // The drag hook and the ruler both want the row element, so the ref
          // is merged rather than one silently winning.
          const rp = drag.rowProps(s.id);
          const setRow = (el: HTMLDivElement | null) => {
            rp.ref(el);
            if (el) rowRefs.current.set(s.id, el); else rowRefs.current.delete(s.id);
          };
          const dragCls = "ws-dragrow"
            + (drag.dragId === s.id ? " dragging" : "")
            + (drag.dragId && drag.gap === i ? " dropbefore" : "")
            + (drag.dragId && last && drag.gap === drag.ids.length ? " dropafter" : "");

          if (!openSet.has(s.id)) {
            const rowSt = sceneBlocks.map((b) => planBlockStatus(b.status, !!b.active_take_id));
            const tone = ST[rowSt.length
              ? (["generating", "queued", "failed", "stale", "planned"] as const)
                  .find((k) => rowSt.includes(k)) ?? "generated"
              : "planned"] ?? "#5b6478";
            return (
              // Clicking a scene opens the scene EDITOR — the row is the
              // scene, and expanding it in place only ever showed a read-only
              // strip of what the editor holds properly. Space still expands,
              // for anyone using the row as a disclosure.
              <div key={s.id} {...rp} ref={setRow} className={"sb-collapsed " + dragCls}
                   role="button" tabIndex={0} title="Open the scene editor — space to expand in place"
                   onClick={(e) => {
                     if ((e.target as HTMLElement).closest("button.ws-grip")) return;
                     ws.openModal({ kind: "scene", sceneId: s.id });
                   }}
                   onKeyDown={(e) => {
                     if (e.key === "Enter") { e.preventDefault(); ws.openModal({ kind: "scene", sceneId: s.id }); }
                     if (e.key === " ") { e.preventDefault(); toggle(s.id); }
                   }}>
                <button className="ws-grip" {...drag.handleProps(s.id)}
                        title="Drag to re-order — or focus and press ↑ / ↓">
                  <GripVertical size={13} />
                </button>
                <span className="th">
                  {still ? <img src={assetUrl(still) ?? undefined} alt="" /> : null}
                </span>
                <span className="sb-sceneno">S{s.idx + 1}</span>
                <span className="sb-scenename" style={{ fontSize: 14 }}
                      title={s.slug ?? `SCENE ${s.idx + 1}`}>{s.slug ?? `SCENE ${s.idx + 1}`}</span>
                <StatusChip tone={tone} label={s.status} />
                <span className="cast">
                  {asStringList(s.cast_ids).map((c) => bibleById.get(c)?.name ?? "?").join(" · ") || "no cast"}
                </span>
                <span style={{ flex: 1 }} />
                <span className="blocks">
                  {sceneBlocks.map((b) => (
                    <i key={b.id} style={{ background: ST[planBlockStatus(b.status, !!b.active_take_id)] ?? "#5b6478" }} />
                  ))}
                </span>
                {/* The time range is what places the scene in the episode and
                    never goes; the counts are dropped first when the row runs
                    out of room, since the dots beside them already say how
                    many blocks there are. `title` keeps the whole string one
                    hover away either way. */}
                <span className="sb-meta"
                      title={`${fmtAt(win.t0)}–${fmtAt(win.t1)}s · ${mine.length} beat`
                        + `${mine.length === 1 ? "" : "s"} · ${sceneBlocks.length} block`
                        + `${sceneBlocks.length === 1 ? "" : "s"}`}>
                  <span className="t">{fmtAt(win.t0)}–{fmtAt(win.t1)}s</span>
                  <span className="n">
                    {" · "}{mine.length} beat{mine.length === 1 ? "" : "s"}
                    {" · "}{sceneBlocks.length} block{sceneBlocks.length === 1 ? "" : "s"}
                  </span>
                </span>
                {/* The row opens the editor, so the chevron is what still
                    expands in place — otherwise a mouse-only user lost the
                    disclosure entirely. */}
                <button className="ws-grip" title="Expand in place"
                        onClick={(e) => { e.stopPropagation(); toggle(s.id); }}>
                  <ChevronDown size={14} />
                </button>
              </div>
            );
          }

          // Beats grouped by the block they compile into — the bracket is the
          // unit that renders, so it's the unit the list is built from.
          const groups: { block: GenerationBlock | null; items: Beat[] }[] = [];
          for (const b of mine) {
            const blk = sceneBlocks.find((x) => x.beat_ids.includes(b.id)) ?? null;
            const tail = groups[groups.length - 1];
            if (tail && tail.block?.id === blk?.id) tail.items.push(b);
            else groups.push({ block: blk, items: [b] });
          }
          let bt = win.t0;

          return (
            <div key={s.id} {...rp} ref={setRow}
                 className={"sb-scene " + dragCls + (locked ? " locked" : "")}>
              {/* The scene's STORYBOARD — one panel per shot, in reading
                  order. This column used to show a single "key still", which
                  was one arbitrary frame of a scene standing in for the whole
                  thing: it told you nothing about coverage, and the actual
                  per-shot panels were relegated to a strip of 6 thumbnails
                  the size of a fingernail. A storyboard IS the panels. */}
              <div className="sb-stillcol">
                {/* Shared with the wizard's review step, which drew a single
                    key still in this slot long after this page had stopped —
                    one component so the two cannot disagree about what a
                    scene's storyboard looks like. */}
                <ScenePanelGrid beats={mine} sceneNo={s.idx + 1} assetOf={assetOf}
                                busy={(b) => pending.get(`b:${b.id}`) ?? (queuingSceneId === s.id ? { status: "queued" } : null)}
                                onOpen={(b) => setLightbox({
                                  sceneId: s.id,
                                  index: scenePanels.findIndex((x) => x.beat.id === b.id),
                                })} />
                {/* .accent carries `flex: 1`, which in this column means "grow
                    to the bottom of the card" — hence the explicit basis. */}
                <button className="ws-microbtn accent" style={{ height: 30, flex: "0 0 auto" }}
                        disabled={pending.has(`s:${s.id}`) || queuingSceneId === s.id}
                        title="One panel per shot, anchored on this scene's cast and location sheets"
                        onClick={() => void generatePanels(s)}>
                  {pending.has(`s:${s.id}`) || queuingSceneId === s.id
                    ? <Loader2 size={13} className="ns-spin" />
                    : <Sparkles size={13} />}
                  {withStills ? "Re-draw panels" : "Draw storyboard panels"}
                </button>
                {mine.length > 0 && (
                  <div className="sb-stillnote">
                    {withStills} of {mine.length} shots drawn
                    {still ? " · key still kept" : ""}
                  </div>
                )}
              </div>

              <div className="sb-scenebody">
                <div className="sb-scenehead">
                  <button className="ws-grip" {...drag.handleProps(s.id)}
                          style={{ alignSelf: "center", height: 22 }}
                          title="Drag to re-order — or focus and press ↑ / ↓">
                    <GripVertical size={13} />
                  </button>
                  {/* An EXPANDED scene had no way in: the collapsed row opens
                      the editor on click, and once open the same scene became
                      two inert spans with the action hidden behind a chevron
                      and a menu. Clicking the scene means the scene, in both
                      states. */}
                  <button type="button" title="Open the scene editor"
                          onClick={() => ws.openModal({ kind: "scene", sceneId: s.id })}
                          style={{ display: "flex", alignItems: "center", gap: 9,
                                   background: "none", border: "none", padding: 0,
                                   cursor: "pointer", color: "inherit", minWidth: 0 }}>
                    <span className="sb-sceneno">S{s.idx + 1}</span>
                    {/* `.sb-scenename` ellipsises, so the whole slug has to
                        stay one hover away here too — the button's own title
                        is about opening the editor, not about the name. */}
                    <span className="sb-scenename"
                          title={s.slug ?? `SCENE ${s.idx + 1}`}>{s.slug ?? `SCENE ${s.idx + 1}`}</span>
                  </button>
                  <StatusChip tone={ST[s.status] ?? "#8b93a7"} label={s.status} />
                  <span className="sb-avatars">
                    {asStringList(s.cast_ids).slice(0, 4).map((c) => {
                      const e = bibleById.get(c);
                      const a = assetOf(firstRefOf(c));
                      return (
                        <i key={c} title={e?.name ?? "unknown"}>
                          {a ? <img src={assetUrl(a) ?? undefined} alt="" /> : (e?.name ?? "?")[0].toUpperCase()}
                        </i>
                      );
                    })}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: 11, color: "#75798c" }}>
                    {fmtAt(win.t0)}–{fmtAt(win.t1)}s · {fmtS(s.duration_ms)}
                  </span>
                  <div className="sb-headacts">
                    {armed === s.id ? (
                      <span className="ws-confirm">
                        <span>
                          retake {sceneBlocks.length} block{sceneBlocks.length === 1 ? "" : "s"}
                          {vmodel.total > 0 && <> on <b>{vmodelLabel}</b></>}?
                        </span>
                        <button className="yes" onClick={() => void retakeBlocks(s)}>retake</button>
                        <button onClick={() => setArmed(null)}>no</button>
                      </span>
                    ) : (
                      <button className="sb-iconbtn"
                              title={"Retake this scene's blocks"
                                + (vmodel.total ? ` on ${vmodelLabel}` : "")
                                + (vmodel.drifted && projModelKey
                                  ? ` — the project's default is `
                                    + `${videoNames.get(projModelKey) ?? projModelKey}, but a block `
                                    + "keeps the checkpoint it was planned with. Change it in the "
                                    + "scene editor."
                                  : "")}
                              disabled={!sceneBlocks.length}
                              onClick={() => setArmed(s.id)}>
                        <RefreshCw size={13} />
                      </button>
                    )}
                    <button className="sb-iconbtn" title="Open the scene editor"
                            onClick={() => ws.openModal({ kind: "scene", sceneId: s.id })}>
                      <Film size={13} />
                    </button>
                    <Dropdown width={250} align="right"
                      trigger={({ toggle: t }) => (
                        <button className="sb-iconbtn" title="More" onClick={t}>
                          <MoreHorizontal size={13} />
                        </button>
                      )}>
                      {(close) => (
                        <>
                          <button className="ws-menu-row" onClick={() => { close(); ws.openModal({ kind: "scene", sceneId: s.id }); }}>
                            Open scene editor
                          </button>
                          <button className="ws-menu-row" onClick={() => { close(); void generateStill(s); }}>
                            {still ? "Regenerate key still" : "Generate key still"}
                          </button>
                          <button className="ws-menu-row" onClick={() => { close(); toggle(s.id); }}>
                            Collapse scene
                          </button>
                          <div className="ws-menu-sep" />
                          {/* Last, under a rule, and it opens a dialog
                              rather than deleting on the click. Refused
                              outright while a block of this scene is on the
                              GPU: the beats cascade away with the scene, and
                              the render mid-flight compiles from them. */}
                          <button className="ws-menu-row danger" disabled={locked}
                                  style={{ opacity: locked ? 0.4 : undefined }}
                                  title={locked
                                    ? "A block of this scene is rendering — wait for it, or cancel the run first"
                                    : "Remove this scene and its shots from the episode. Panels already drawn stay in the library."}
                                  onClick={() => { close(); setArmed(null); setDelScene(s); }}>
                            <Trash2 size={13} style={{ flex: "none" }} />
                            <span style={{ flex: 1 }}>Delete scene</span>
                          </button>
                          {sceneBlocks.length > 0 && <div className="ws-menu-sep" />}
                          {sceneBlocks.map((b) => (
                            <button key={b.id} className="ws-menu-row"
                                    onClick={() => {
                                      close();
                                      ws.openModal(b.active_take_id
                                        ? { kind: "takes", blockId: b.id }
                                        : { kind: "prompt", blockId: b.id });
                                    }}>
                              <span style={{ flex: 1, minWidth: 0 }}>
                                {blockRef(b.idx)} · {b.active_take_id ? "takes & assembly" : "prompt & references"}
                              </span>
                              <span className="mono chip"
                                    style={{ flex: "none", color: ST[planBlockStatus(b.status, !!b.active_take_id)] }}>
                                {planBlockStatus(b.status, !!b.active_take_id)}
                              </span>
                            </button>
                          ))}
                        </>
                      )}
                    </Dropdown>
                  </div>
                </div>

                <EditField value={s.scene_prompt ?? ""} placeholder="Scene intent, mood, light…"
                           cls="sb-prompt" rows={2} disabled={locked}
                           open={editing === `s:${s.id}`}
                           onOpen={() => setEditing(`s:${s.id}`)} onClose={() => setEditing(null)}
                           onSave={(v) => void saveScene(s.id, { scene_prompt: v })
                             .then(() => markSceneBlocksStale(s.id)).then(reload)} />

                {groups.map((g, gi) => {
                  const acc2 = ACCENTS[gi % ACCENTS.length];
                  const dur = g.items.reduce((n, b) => n + b.duration_ms, 0);
                  return (
                    <div key={g.block?.id ?? `g${gi}`} className="sb-block"
                         style={{ ["--acc" as string]: acc2, borderLeftColor: `${acc2}59` }}>
                      <div className="sb-blockhead">
                        {g.block ? (
                          <button className="sb-blockid" style={{ color: acc2 }}
                                  title={g.block.active_take_id ? "Open takes & assembly" : "Open prompt & references"}
                                  onClick={() => ws.openModal(g.block!.active_take_id
                                    ? { kind: "takes", blockId: g.block!.id }
                                    : { kind: "prompt", blockId: g.block!.id })}>
                            BLOCK {blockRef(g.block.idx)}
                          </button>
                        ) : (
                          <span className="sb-blockid" style={{ color: "#5e6678" }}>NOT YET PLANNED</span>
                        )}
                        <span className={"sb-cap" + (dur > CAP_MS ? " over" : "")}>
                          <i style={{ width: `${Math.min(100, (dur / CAP_MS) * 100)}%`, background: acc2 }} />
                        </span>
                        <span className="sb-blockmeta">
                          {fmtS(dur)} of {fmtS(CAP_MS)} cap · {g.items.length} beat{g.items.length === 1 ? "" : "s"}
                        </span>
                        {dur > CAP_MS && (
                          <span className="sb-blockmeta" style={{ color: "#ff8080" }}>
                            over cap — the render is trimmed
                          </span>
                        )}
                        {g.block && (() => {
                          const bst = planBlockStatus(g.block.status, !!g.block.active_take_id);
                          return <StatusChip tone={ST[bst] ?? "#5b6478"} label={bst}
                                             pulse={bst === "generating"} />;
                        })()}
                      </div>

                      {g.items.map((b) => {
                        const s0 = bt; bt += b.duration_ms;
                        const earlier = mine.filter((x) => x.idx < b.idx);
                        const rep = repeatOf(b, earlier);
                        const share = dur ? (b.duration_ms / Math.max(dur, CAP_MS)) * 100 : 0;
                        return (
                          <div key={b.id} className="sb-beat">
                            <div className="sb-beattime">
                              <b className={rep ? "dim" : ""}>{fmtS(b.duration_ms)}</b>
                              <i className={rep ? "dim" : ""}
                                 style={{ width: `${Math.max(8, share)}%`, background: rep ? undefined : acc2 }} />
                              <span>@ {fmtAt(s0)}</span>
                            </div>
                            {rep && editing !== `b:${b.id}` ? (
                              <div className="sb-repeat">
                                <span>REPEAT OF SHOT {rep.of.idx + 1} — {rep.note}</span>
                                <div style={{ flex: 1 }} />
                                <button className="amber" disabled={locked}
                                        title={`Give its ${fmtS(b.duration_ms)} to shot ${rep.of.idx + 1} and drop this row`}
                                        onClick={() => void mergeRepeat(s, b, rep.of)}>
                                  Merge into shot {rep.of.idx + 1}
                                </button>
                                <button disabled={locked} onClick={() => setEditing(`b:${b.id}`)}>
                                  Make distinct
                                </button>
                              </div>
                            ) : (
                              <div className="sb-beatbody">
                                <div className="sb-chips">
                                  {sizeOf(b.camera) && (
                                    <span className="sb-chip" title="Shot size">
                                      <Camera size={11} style={{ color: "#75798c" }} />
                                      {sizeOf(b.camera)!.toUpperCase()}
                                    </span>
                                  )}
                                  <button className={"sb-chip dim" + (b.camera ? "" : " ph")}
                                          style={{ maxWidth: "100%", overflow: "hidden",
                                                   textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}
                                          title={`${b.camera || "no camera yet"} — click to choose one in the scene editor`}
                                          onClick={() => ws.openModal({ kind: "scene", sceneId: s.id })}>
                                    {b.camera || "no camera"}
                                  </button>
                                  {b.meta?.start_frame_asset_id ? (
                                    <span className="sb-chip dim" title="This block opens on that exact frame">
                                      start frame
                                    </span>
                                  ) : null}
                                </div>
                                <EditField value={b.action} placeholder="What happens…" cls="sb-action"
                                           rows={2} disabled={locked}
                                           open={editing === `b:${b.id}`}
                                           onOpen={() => setEditing(`b:${b.id}`)}
                                           onClose={() => setEditing(null)}
                                           onSave={(v) => void editBeat(s, b, { action: v })} />
                                {asArray<NonNullable<Beat["dialogue"]>[number]>(b.dialogue).map((d, di) => (
                                  <div key={di} className="sb-line">
                                    <b>{bibleById.get(d.speaker_id)?.name ?? d.speaker ?? "?"}</b>
                                    “{d.line}”
                                    {d.delivery && (
                                      <span className="mono" style={{ color: "#5e6678", fontSize: 11 }}> · {d.delivery}</span>
                                    )}
                                  </div>
                                ))}
                                {b.sfx && (
                                  <div className="sb-sfx"><Volume2 size={11} /><span>{b.sfx}</span></div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {!mine.length && (
                  <div className="sb-blockmeta" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <AlertTriangle size={12} style={{ color: "#e8c268" }} />
                    No beats yet — open the scene editor to write them.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {lightbox && (() => {
        const imgs = panelAssets(lightbox.sceneId);
        if (!imgs.length) return null;
        const idx = Math.min(lightbox.index, imgs.length - 1);
        return (
          <Lightbox assets={imgs.map((x) => x.asset)} index={idx}
                    onClose={() => setLightbox(null)}
                    onStep={(d) => setLightbox((cur) => cur && {
                      ...cur, index: stepIndex(cur.index, d, imgs.length) ?? 0,
                    })}
                    actions={(asset, i) => {
                      // Same rule as the scene editor: only a picture with a
                      // stored prompt can be edited, and the label says which
                      // surface you are about to get.
                      const beat = imgs[i]?.beat;
                      const sceneId = lightbox.sceneId;
                      const editable = !!beat && !!asset.meta?.prompt;
                      return (
                        <button className="ws-lb-action"
                                title={editable
                                  ? "Edit this panel's prompt and references, then redraw it"
                                  : "Open this picture's details"}
                                onClick={() => {
                                  setLightbox(null);
                                  if (editable) void openPanelEditor(asset.id, beat!.id);
                                  else ws.openModal({
                                    kind: "asset", assetId: asset.id,
                                    fromScene: sceneId, ...(beat ? { fromBeat: beat.id } : {}),
                                  });
                                }}>
                          <Wand2 size={12} /> {editable ? "Redraw…" : "Details…"}
                        </button>
                      );
                    }} />
        );
      })()}

      {delScene && (
        <DeleteSceneDialog
          scene={delScene}
          shots={(beats.get(delScene.id) ?? []).length}
          blocks={blocksFor(delScene.id).length}
          onCancel={() => setDelScene(null)}
          onDeleted={() => sceneDeleted(delScene)} />
      )}

      {regen && (
        <PanelRegenModal
          asset={regen.asset}
          prompt={regen.prompt}
          refs={regen.refs}
          beatId={regen.beatId}
          projectId={projectId}
          label={regen.label}
          onClose={() => { setRegen(null); reload(); }}
        />
      )}
    </>
  );
}

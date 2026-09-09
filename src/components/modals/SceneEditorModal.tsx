// Scene & beat editor (design: 1180px, full height). Left — the beats: drag
// gutter with the block id it compiles into, a 132px still column (draw a
// panel, choose one, use it as the start frame), time + camera +
// split/rewrite/delete, action, dialogue and sfx. Right — the scene's
// storyboard, key still, environment, cast, look, blocks & chain. Edits
// write through saveScene/saveBeat; "Save & recompile" marks the scene's
// blocks stale (the compiler re-runs at the next generation — money
// is never spent silently).
import React, { useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Camera, Check, ChevronLeft, ChevronRight, GripVertical, Image as ImageIcon,
  Images, Layers, LayoutGrid, LayoutList, Lock, Loader2, Plus, RefreshCw, Scissors, Sparkles,
  Trash2, Wand2, X, Swords, Cpu,
} from "lucide-react";
import ModalShell from "./ModalShell";
import Dropdown from "../ui/Dropdown";
import CameraPicker, { cameraChips, parseCamera } from "./CameraPicker";
import DeleteSceneDialog from "./DeleteSceneDialog";
import PanelRegenModal from "./PanelRegenModal";
import AssetPickerModal from "./AssetPickerModal";
import ScenePanelGrid from "../shell/ScenePanelGrid";
import Lightbox, { stepIndex } from "../ui/Lightbox";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import ImageModelPicker, { validLoras } from "../ui/ImageModelPicker";
import { loadCatalog } from "../../lib/catalog";
import {
  combatByModelKey, fightPatch, sceneFightState, type FightBlock,
} from "../../lib/sceneFight";
import {
  modelNameByKey, modelPatch, sceneModelState, type ModelBlock,
} from "../../lib/blockModel";
import {
  modelKeyOf, resolveDefaults, styleTextFor, withStyle, type LoraPick, type ProjectSettings,
} from "../../lib/projectSettings";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { assetUrl, loadGenerationSource } from "../../lib/db/assets";
import { enqueueJob } from "../../lib/db/jobs";
import { loadBible, loadBibleAssets, loadStoryboardFull, markSceneBlocksStale, saveBeat, saveScene, setBlocksParams, uploadAndAddTake } from "../../lib/db/director";
import {
  PANEL_ALTS, beatImageId, beatStillMeta, panelChoiceMeta, panelDefaults, queueBeatPanel,
  queueBeatPanelAlternates, queueScenePanels,
} from "../../lib/panels";
import { queueBlockSheet, sheetBlocker } from "../../lib/blockSheet";
import { ST } from "../shell/ContextPanel";
import { planBlockStatus, STALE_UI } from "../../lib/staleBlocks";
import { asArray, asStringList } from "../../lib/jsonb";
import type { Asset, Beat, BibleEntry, BlockTake, GenerationBlock, Scene } from "../../lib/db/types";
import { blockRef } from "../../../director/refs.js";

const fmtT = (ms: number) => (ms / 1000).toFixed(1);

/** H3 renders 15s at most (invariant #5) — the ruler draws it as a width. */
const BLOCK_CAP_MS = 15000;
/** Adjacent blocks alternate so the ruler and the beat gutter agree on which
 *  render a beat belongs to. Two colours; a third would look like a meaning. */
const BLOCK_ACCENTS = ["#5aa2ff", "#c97aff"];

/** A bible entry's first reference image — falls back to a marked-empty box
 * so "no refs yet" is legible instead of an anonymous grey square. */
function EntityThumb({ asset, size, radius }: { asset?: Asset; size: number; radius: number }) {
  return (
    <span className="ws-entthumb" style={{ width: size, height: size, borderRadius: radius }}>
      {asset
        ? <img src={assetUrl(asset) ?? undefined} alt="" />
        : <ImageIcon size={Math.round(size * 0.42)} />}
    </span>
  );
}

const refLabel = (n: number) => (n === 1 ? "1 ref" : `${n} refs`);

/** The beat card's camera control: chips for whatever the compiled string's
 *  picker-recognizable parts are (a quick scan of size/angle/move/lens/feel),
 *  plus the full string underneath so free-hand director prose the parser
 *  can't match is never hidden behind the summary. Replaces the single line
 *  that used to carry the whole description and ellipsis-truncate it. */
function CameraTrigger({ beat, onOpen }: { beat: Beat; onOpen: () => void }) {
  const chips = cameraChips(beat.camera);
  return (
    <button className="ws-cambtn multi" onClick={onOpen}>
      <Camera size={14} style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5, textAlign: "left" }}>
        {chips.length > 0 && (
          <span style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {chips.map((c, i) => <span key={i} className="ws-campart">{c}</span>)}
          </span>
        )}
        <span style={{ fontSize: chips.length ? 11.5 : 12.5, fontWeight: chips.length ? 500 : 600,
                       color: chips.length ? "#5e6678" : "#8fc2ff", lineHeight: 1.5 }}>
          {beat.camera || "pick a camera"}
        </span>
      </span>
      <ChevronRight size={13} style={{ flexShrink: 0, opacity: 0.6, marginTop: 2 }} />
    </button>
  );
}

/** The takes that came back for a beat. Takes belong to the *block* a beat
 * compiles into, and a block can hold two beats — when it does, both beats
 * show the same takes and say so, rather than implying one take per beat.
 *
 * One row, not two: the thumbnails are the content and the actions are three
 * words each, so a header line above them was a row of chrome per beat. */
function BeatTakes({ block, beatCount, takes, assets, sceneId, onChanged, trailing }: {
  block: GenerationBlock;
  beatCount: number;
  takes: BlockTake[];
  assets: Map<string, Asset>;
  sceneId: string;
  onChanged: () => void;
  /** Rendered at the end of the same row (the beat's "+ dialogue"). */
  trailing?: React.ReactNode;
}) {
  const ws = useWorkspaceStore();
  const tl = useTimelineStore();

  const activate = async (t: BlockTake) => {
    await supabase.from("block_takes").update({ state: "kept" }).eq("id", t.id);
    await supabase.from("generation_blocks")
      .update({ active_take_id: t.id, status: "generated" }).eq("id", block.id);
    // Keep the timeline in step when it happens to be loaded — EVERY copy of
    // the block that is following it, not the first one found. A block can be
    // on a cut more than once, and a clip playing its OWN take (`take_id`) is
    // deliberately left alone: this is a block-wide activate, and overriding a
    // pin from a screen that cannot see the lane is the silent overwrite the
    // pin exists to stop. The sync repoints the rest either way; this is just
    // so the lane moves now rather than on the next one.
    for (const c of tl.clips.filter((c) => c.block_id === block.id && !c.take_id)) {
      tl.patchClip(c.id, { asset_id: t.asset_id });
    }
    onChanged();
  };

  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);

  /** Dropping a file on the takes row adds it as a take — the same thing the
   *  library picker does, minus the round trip through it. */
  const handleUpload = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("video/") || f.type.startsWith("image/"));
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list) {
        await uploadAndAddTake({
          blockId: block.id,
          file,
          activate: true,
        });
      }
      onChanged();
    } catch (err) {
      console.error("Beat upload take failed", err);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={"ws-beattakes row-inline" + (dropping ? " dropping" : "")}
         onDragOver={(e) => {
           if (!e.dataTransfer.types.includes("Files")) return;
           e.preventDefault(); setDropping(true);
         }}
         onDragLeave={() => setDropping(false)}
         onDrop={(e) => {
           if (!e.dataTransfer.files.length) return;
           e.preventDefault(); setDropping(false);
           void handleUpload(e.dataTransfer.files);
         }}>
      <span className="ws-mlabel" style={{ fontSize: 10, flexShrink: 0 }}
            title={`block ${blockRef(block.idx)}${beatCount > 1 ? ` · covers ${beatCount} beats` : ""} — drop a file here to add a take`}>
        takes
      </span>
      <div className="row ns-scroll">
        {takes.map((t, i) => {
          const a = assets.get(t.asset_id);
          const active = t.id === block.active_take_id;
          return (
            <button key={t.id}
                    className={"ws-beattake" + (active ? " on" : "") + (t.state === "rejected" ? " rej" : "")}
                    title={active ? `Take ${i + 1} · active` : `Use take ${i + 1}`}
                    onClick={() => !active && activate(t)}>
              {a && (
                <video src={assetUrl(a) ?? undefined} muted preload="metadata" playsInline
                       onLoadedMetadata={(e) => {
                         const v = e.currentTarget;
                         if (v.duration) v.currentTime = v.duration * 0.35;
                       }}
                       onPointerEnter={(e) => void e.currentTarget.play().catch(() => {})}
                       onPointerLeave={(e) => {
                         const v = e.currentTarget;
                         v.pause();
                         if (v.duration) v.currentTime = v.duration * 0.35;
                       }} />
              )}
              <span className="n mono">{i + 1}</span>
              {active && <span className="tick"><Check size={9} /></span>}
            </button>
          );
        })}

        {!takes.length && (
          <span className="ws-beattake empty">
            {block.status === "generating"
              ? <><Loader2 size={12} className="ns-spin" />rendering</>
              : block.status === "failed" ? "failed" : "not rendered"}
          </span>
        )}

        {/* The empty slot IS the add button — a dashed tile the same size as a
            take reads as "another one goes here". */}
        <button className="ws-beattake add" title="Choose or upload a take from your library"
                onClick={() => ws.openModal({ kind: "pickTake", blockId: block.id, fromScene: sceneId })}>
          {uploading ? <Loader2 size={13} className="ns-spin" /> : <Plus size={14} />}
        </button>
      </div>
      <span style={{ flex: 1 }} />
      {takes.length > 1 && (
        <button className="ws-microbtn" style={{ padding: "0 10px", flexShrink: 0 }}
                title="Compare and assemble the takes of this block"
                onClick={() => ws.openModal({ kind: "takes", blockId: block.id, fromScene: sceneId })}>
          compare
        </button>
      )}
      <button className="ws-microbtn" style={{ padding: "0 11px", flexShrink: 0 }}
              title="Queue another take with notes"
              onClick={() => ws.openModal({ kind: "prompt", blockId: block.id, fromScene: sceneId })}>
        Retake
      </button>
      {trailing}
    </div>
  );
}

/**
 * `onClose` exists so this can be opened from INSIDE another modal — the
 * wizard's step-3 storyboard opens it on a scene. The store holds ONE modal and
 * that slot is the wizard, so routing through `ws.openModal` swapped the wizard
 * OUT to show a scene, and closing the scene left you nowhere near where you
 * were. Same treatment as BibleEntryModal.
 */
export default function SceneEditorModal({ sceneId, onClose }: {
  sceneId: string; onClose?: () => void;
}) {
  const ws = useWorkspaceStore();
  const close = onClose ?? ws.closeModal;
  const [camFor, setCamFor] = useState<Beat | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lookDraft, setLookDraft] = useState<string | null>(null);
  const [fightBusy, setFightBusy] = useState(false);
  const [fightNote, setFightNote] = useState<string | null>(null);
  const [vmBusy, setVmBusy] = useState(false);
  const [vmNote, setVmNote] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  // The SCENE delete's dialog, captured by value — see below for why this
  // cannot be `data.scene`.
  const [delScene, setDelScene] =
    useState<{ scene: Scene; shots: number; blocks: number } | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  // undefined = "follow the project default"; null = explicitly off.
  const [loras, setLoras] = useState<LoraPick[] | null>(null);
  // The zoomed slideshow: an index into scenePanels, not a ws.openModal kind
  // — every panel it pages through is already loaded here.
  const [lightbox, setLightbox] = useState<number | null>(null);
  // The panel's prompt & references editor, once its source has been loaded.
  // Held here rather than routed through ws.openModal because the store's one
  // modal slot is this scene editor — swapping it out is what `onClose` exists
  // to avoid (see the note on this component).
  const [regen, setRegen] =
    useState<{ asset: Asset; prompt: string; refs: Asset[]; label: string | null; beatId: string } | null>(null);
  const [loadingRegen, setLoadingRegen] = useState<string | null>(null);
  // Which shot is having its picture chosen. Nested here for the same reason
  // `regen` is: the store holds ONE modal and it is this editor, so routing
  // the picker through `ws.openModal` would close the thing it was opened
  // from. `AssetPickerModal` portals to <body> at z=150, above this shell's
  // 94, so it lands over the editor rather than inside it.
  const [pickFor, setPickFor] = useState<Beat | null>(null);
  const [queuingBeatIds, setQueuingBeatIds] = useState<Set<string>>(new Set());
  const dragIdx = useRef<number | null>(null);

  const { data, error: loadError, reload } = useLiveQuery(
    async () => {
      const { data: scene } = await supabase.from("scenes").select("*").eq("id", sceneId).single();
      if (!scene) return null;
      const s = scene as Scene;
      const full = await loadStoryboardFull(s.storyboard_id);
      // Everything below that only needs `full` runs in ONE round — this
      // loader was eleven sequential round trips, which is what made the
      // modal take seconds to show anything.
      const blocks = full.blocks.filter((b) => b.scene_ids.includes(s.id));
      // Both slots: a beat shows its user still if it has one and its drawn
      // panel otherwise, the same precedence the render's ref plan applies.
      // `panel_alts` rides along because the strip that offers them renders
      // from this map — an unloaded alternate is an invisible one.
      const stillIds = [s.still_asset_id,
        ...(full.beats.get(s.id) ?? []).flatMap((b) => [
          b.meta?.still_asset_id as string | undefined,
          b.meta?.panel_asset_id as string | undefined,
          ...((b.meta?.panel_alts as string[] | undefined) ?? [])])]
        .filter(Boolean) as string[];
      const [{ data: ep }, { data: stills }, { data: takes }, catalog, { data: stillJobs }] =
        await Promise.all([
          supabase.from("episodes")
            .select("id,code,project_id").eq("id", full.storyboard.episode_id).single(),
          stillIds.length
            ? supabase.from("assets").select("*").in("id", stillIds)
            : Promise.resolve({ data: [] as Asset[] }),
          blocks.length
            ? supabase.from("block_takes").select("*")
                .in("block_id", blocks.map((b) => b.id)).order("created_at")
            : Promise.resolve({ data: [] as BlockTake[] }),
          // The WHOLE catalog: the image rows feed the panel picker below, and
          // the video rows answer whether a block's checkpoint declares the
          // combat adapter (`_block_loras` skips it where it does not, so the
          // fight switch would be a control that cannot reach the render).
          loadCatalog(),
          // Claim order — newest-first showed the TAIL of a panel batch and
          // never the panel being drawn. See loadRecentJobs in lib/db/jobs.ts.
          supabase.from("jobs").select("id,status,progress,progress_note,payload")
            .eq("kind", "image_gen").in("status", ["queued", "running"])
            .order("priority", { ascending: true })
            .order("created_at", { ascending: true }).limit(30),
        ]);
      const [bible, { data: projRow }] = await Promise.all([
        ep ? loadBible(ep.project_id) : Promise.resolve([]),
        ep ? supabase.from("projects").select("settings,style").eq("id", ep.project_id).maybeSingle()
           : Promise.resolve({ data: null }),
      ]);
      const proj = {
        settings: ((projRow as { settings?: ProjectSettings } | null)?.settings ?? {}) as ProjectSettings,
        style: (projRow as { style?: string } | null)?.style ?? null,
        catalog,
        // Which beat / scene still is being made right now, so the tile can say
        // so instead of sitting empty while the GPU works.
        pending: new Map<string, { status: string; progress: number | null }>(
          ((stillJobs ?? []) as { status: string; progress: number | null;
                                  payload: { target?: { beat_id?: string; scene_id?: string } } }[])
            .flatMap((j) => {
              const t = j.payload?.target ?? {};
              const key = t.beat_id ? `b:${t.beat_id}` : t.scene_id ? `s:${t.scene_id}` : null;
              return key ? [[key, { status: j.status, progress: j.progress }] as const] : [];
            })),
      };
      // first ref image per bible entry, so the rail shows the actual
      // character/environment instead of a grey gradient
      const takeIds = ((takes ?? []) as BlockTake[]).map((t) => t.asset_id);
      const [links, { data: takeAssets }] = await Promise.all([
        bible.length ? loadBibleAssets(bible.map((b) => b.id)) : Promise.resolve([]),
        takeIds.length
          ? supabase.from("assets").select("*").in("id", takeIds)
          : Promise.resolve({ data: [] as Asset[] }),
      ]);
      const refIds = [...new Set(links.map((l) => l.asset_id))];
      const { data: refAssets } = refIds.length
        ? await supabase.from("assets").select("*").in("id", refIds) : { data: [] };
      const refByEntry = new Map<string, Asset>();
      const faceByEntry = new Map<string, string>();   // identity anchor per cast member
      const refCount = new Map<string, number>();
      const byId = new Map(((refAssets ?? []) as Asset[]).map((a) => [a.id, a]));
      for (const l of [...links].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))) {
        refCount.set(l.entry_id, (refCount.get(l.entry_id) ?? 0) + 1);
        if (l.role === "face" && !faceByEntry.has(l.entry_id)) faceByEntry.set(l.entry_id, l.asset_id);
        const a = byId.get(l.asset_id);
        if (a && !refByEntry.has(l.entry_id)) refByEntry.set(l.entry_id, a);
      }
      const takesByBlock = new Map<string, BlockTake[]>();
      for (const t of (takes ?? []) as BlockTake[]) {
        takesByBlock.set(t.block_id, [...(takesByBlock.get(t.block_id) ?? []), t]);
      }
      return {
        scene: full.scenes.find((x) => x.id === s.id) ?? s,
        scenes: full.scenes,
        beats: full.beats.get(s.id) ?? [],
        // EVERY beat of the storyboard, not just this scene's. A block may
        // span two scenes of one location, so a segment storyboard drawn from
        // this scene's beats alone would carry fewer panels than the block has
        // shots — and the panel NUMBERS are what bind to `[Shot N]`, so a
        // short sheet is silently off by one for every shot after the join.
        // Free: `loadStoryboardFull` already fetched them.
        allBeats: [...full.beats.values()].flat(),
        blocks,
        ep, bible, refByEntry, refCount, faceByEntry,
        settings: proj.settings, projectStyle: proj.style, pending: proj.pending,
        catalog: proj.catalog.filter((m) => m.kind === "image"),
        combat: combatByModelKey(proj.catalog, modelKeyOf),
        // Display names for the VIDEO rows, so the model card can say
        // "MiniMax H3 · Turbo" rather than printing a model_map key at
        // somebody. `catalog` above is filtered to the image rows for the
        // panel picker, so this cannot be derived from it.
        videoNames: modelNameByKey(proj.catalog, modelKeyOf),
        stills: new Map((stills ?? []).map((a) => [a.id, a])),
        takesByBlock,
        takeAssets: new Map(((takeAssets ?? []) as Asset[]).map((a) => [a.id, a])),
      };
    },
    ["scenes", "beats", "generation_blocks", "bible_entries", "bible_assets", "block_takes", "jobs"], [sceneId]
  );

  const t0 = useMemo(() => {
    if (!data) return 0;
    let acc = 0;
    for (const s of data.scenes) { if (s.id === sceneId) break; acc += s.duration_ms; }
    return acc;
  }, [data, sceneId]);

  /* THE DELETE DIALOG OUTLIVES THIS MODAL'S OWN DATA, which is why it is
     built here and returned from BOTH paths below. The scene query is a
     `.single()`, so the moment the row goes the query fails, `data` is null
     and everything under the guard stops rendering — including, if it lived
     there, the notice saying which half of the cleanup did not land. It reads
     its scene out of `delScene` for the same reason. */
  const delDialog = delScene && (
    <DeleteSceneDialog
      scene={delScene.scene} shots={delScene.shots} blocks={delScene.blocks}
      onCancel={() => setDelScene(null)}
      onDeleted={() => { setDelScene(null); close(); }} />
  );

  // The frame opens on the CLICK, not on the data: this loader is many round
  // trips deep, and returning null here meant pressing "edit scene" did
  // nothing on screen for its whole duration.
  if (!data) {
    return delDialog ?? (
      <ModalShell width={1200} tall z={94} onClose={close}
                  icon={<LayoutList size={16} />} title="Scene editor"
                  loading loadingLabel="Loading scene…" loadError={loadError} />
    );
  }
  const { scene, beats, blocks, allBeats, scenes, ep, bible,
          refByEntry, refCount, faceByEntry,
          settings, projectStyle, catalog, combat, videoNames, pending } = data;
  const env = bible.find((b) => b.id === scene.environment_id) ?? null;
  const cast = (scene.cast_ids ?? []).map((id) => bible.find((b) => b.id === id)).filter(Boolean) as BibleEntry[];
  const blockFor = (beat: Beat): GenerationBlock | undefined => blocks.find((b) => b.beat_ids.includes(beat.id));
  const est = (blocks.length * 0.31).toFixed(2);
  /** How much more scene the current blocks can hold before one more is
   *  needed — the pacing question the old "blocks cap at 15s" sentence made
   *  you do in your head. */
  const room = blocks.length * BLOCK_CAP_MS - scene.duration_ms;
  const still = scene.still_asset_id ? data.stills.get(scene.still_asset_id) : null;
  const drawn = beats.filter((b) => beatImageId(b).id).length;
  /** Do the blocks this scene touches already carry a segment storyboard?
   *  Read off `params` because that is where the worker writes it and where
   *  `ref_plan_for` reads it — the sheet is a render setting on the block, not
   *  a picture on the scene. */
  const sheeted = blocks.some((b) => (b.params as { sheet_asset_id?: string } | null)?.sheet_asset_id);
  /** This scene's drawn panels, in shot order — what the zoomed slideshow
   *  pages through. Shared by both places a beat's picture is shown (the
   *  beat card and the rail's storyboard grid), so either click lands on the
   *  same slide. */
  const scenePanels = beats
    .map((b) => {
      const p = beatImageId(b);
      return { beat: b, asset: p.id ? data.stills.get(p.id) ?? null : null };
    })
    .filter((x): x is { beat: Beat; asset: Asset } => !!x.asset);
  const look = asStringList(scene.meta?.look);
  // a scene can override the environment's palette; until it does, it shows
  // the environment's so the swatches aren't just empty holes
  const scenePalette = asStringList(scene.meta?.palette);
  const sceneHasPalette = scenePalette.length > 0;
  const palette = sceneHasPalette
    ? scenePalette
    : asStringList((env?.doc as { palette?: unknown })?.palette);

  const commitLook = (keepOpen = false) => {
    const v = (lookDraft ?? "").trim();
    setLookDraft(keepOpen && v ? "" : null);
    if (!v || look.includes(v)) return;
    void saveScene(scene.id, { meta: { ...(scene.meta ?? {}), look: [...look, v] } }).then(reload);
  };
  /** Does this scene's blocks render with the combat adapter — and what does
   *  one click have to write. See `src/lib/sceneFight.ts` for why the answer
   *  is on the BLOCK rather than on `scenes.meta.type`. */
  const fight = sceneFightState(
    scene, blocks as unknown as FightBlock[],
    (k) => (k && combat.has(k) ? combat.get(k)! : null));

  const toggleFight = async () => {
    if (fightBusy) return;
    setFightBusy(true);
    setFightNote(null);
    try {
      const on = !fight.checked;
      const patches = fightPatch(scene, blocks as unknown as FightBlock[], on);
      const n = await setBlocksParams(patches);
      // Report what was WRITTEN, not what was asked for: a block already in
      // the wanted state is skipped, so "4 blocks" when two were skipped is
      // the same lie the stale re-render's partial-failure count avoids.
      setFightNote(n === 0
        ? "Already set — nothing to change."
        : `${on ? "On" : "Off"} for ${n} block${n === 1 ? "" : "s"}. `
          + "Retake the scene to apply it.");
      reload();
    } catch (e) {
      setFightNote(`Couldn't save: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
    } finally {
      setFightBusy(false);
    }
  };

  /** WHAT THIS SCENE'S BLOCKS ACTUALLY RENDER ON, which is not necessarily
   *  what the project's Video model says. `_block_model` reads the BLOCK's
   *  own `params.model_key`, stamped once at plan time so an episode cannot
   *  switch checkpoints shot to shot — so changing the project setting later
   *  reaches nothing already planned, and a scene retake goes on rendering
   *  the old checkpoint without saying so. See `src/lib/blockModel.ts`. */
  const projModelId = resolveDefaults(settings).video_model;
  const projModelKey = modelKeyOf(projModelId);
  const vmodel = sceneModelState(scene, blocks as unknown as ModelBlock[], projModelKey);
  const nameOfKey = (k: string) => videoNames.get(k) ?? k;

  const useProjectModel = async () => {
    if (vmBusy || !projModelKey) return;
    setVmBusy(true);
    setVmNote(null);
    try {
      const patches = modelPatch(
        scene, blocks as unknown as ModelBlock[], projModelKey, projModelId);
      const n = await setBlocksParams(patches);
      setVmNote(n === 0
        ? "Already on it — nothing to change."
        : `${n} block${n === 1 ? "" : "s"} moved to ${nameOfKey(projModelKey)}. `
          + "Retake the scene to render on it.");
      reload();
    } catch (e) {
      setVmNote(`Couldn't save: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
    } finally {
      setVmBusy(false);
    }
  };

  const savePalette = (next: string[]) =>
    void saveScene(scene.id, { meta: { ...(scene.meta ?? {}), palette: next } }).then(reload);

  // The cast's face refs anchor the still, or the beat shows somebody else
  // entirely — the same reason a body sheet needs the face.
  const castAnchors = () => [
    ...(scene.cast_ids ?? []).map((id) => faceByEntry.get(id) ?? refByEntry.get(id)?.id),
    scene.environment_id ? refByEntry.get(scene.environment_id)?.id : undefined,
  ].filter(Boolean).slice(0, 4) as string[];

  const effLoras = loras ?? resolveDefaults(settings).image_loras;
  /** Only send LoRAs the chosen model declares — a stale pick would ask the
   *  worker for a file that model doesn't have. */
  const loraFor = (chosen: string) => {
    const ok = validLoras(catalog.find((m) => m.id === chosen), effLoras);
    return ok.length ? { loras: ok } : {};
  };

  /** Panels are the ONE mechanism now (lib/panels.ts), shared with the
   *  storyboard page and mirroring what the planner queues. This button used
   *  to run a second, worse generator: a prose still from the scene prompt
   *  plus the whole scene's cast as anchors, with no [FRAMING] directive and
   *  no shot-subject ordering — so the same beat drawn here and drawn on the
   *  storyboard page came back as two different pictures. */
  const panelCtx = () => {
    const d = panelDefaults(settings, projectStyle);
    // The rail's picker overrides the project default for this scene only.
    return { projectId: ep?.project_id, episodeId: ep?.id, bible,
             ...d, imageModel: modelId ?? d.imageModel };
  };

  const genBeatPanel = async (b: Beat) => {
    setQueuingBeatIds((prev) => new Set(prev).add(b.id));
    try {
      await queueBeatPanel(scene, b, panelCtx(), beats);
      setNote(`Panel for shot ${b.idx + 1} queued`);
      reload();
    } finally {
      setQueuingBeatIds((prev) => {
        const next = new Set(prev);
        next.delete(b.id);
        return next;
      });
    }
  };

  const genScenePanels = async () => {
    setQueuingBeatIds(new Set(beats.map((b) => b.id)));
    try {
      const n = await queueScenePanels(scene, beats, panelCtx());
      setNote(`${n} panel${n === 1 ? "" : "s"} queued`);
      reload();
    } finally {
      setQueuingBeatIds(new Set());
    }
  };

  /** ONE numbered contact sheet per BLOCK this scene touches, staged whole
   *  into that block's render in place of its two per-beat panels.
   *
   *  Per BLOCK and not per scene, because the sheet's panel numbers bind to
   *  `[Shot N]` of one render — a scene that packs into two blocks needs two
   *  sheets, and a block that spans two scenes needs one covering both. That
   *  is why this reads `allBeats`/`scenes` rather than the scene's own.
   *
   *  Draws every block the scene touches, including ones it only half owns:
   *  a sheet is the block's composition, so drawing "the part in this scene"
   *  is not a smaller version of the feature, it is a broken one. */
  const genBlockSheets = async () => {
    let queued = 0;
    const skipped: string[] = [];
    for (const bl of blocks) {
      const shots = bl.beat_ids
        .map((id) => allBeats.find((b) => b.id === id))
        .filter(Boolean) as Beat[];
      const why = sheetBlocker(shots, panelCtx().imageModel);
      if (why) { skipped.push(`b${bl.idx + 1}: ${why}`); continue; }
      await queueBlockSheet(bl, allBeats, scenes, panelCtx());
      queued += 1;
    }
    setNote(queued
      ? `${queued} segment storyboard${queued === 1 ? "" : "s"} queued`
        + (skipped.length ? ` · skipped ${skipped.join("; ")}` : "")
      : `nothing queued — ${skipped.join("; ") || "this scene has no blocks yet"}`);
    reload();
  };

  /** Five takes of one shot, to choose between.
   *
   *  The redraw button argues with a panel (open its prompt, change it, render
   *  again); this one accepts the prompt and disagrees with the ROLL. They are
   *  different problems and only one of them was addressable before: a panel
   *  you simply didn't like could only be re-rolled one at a time, and because
   *  every panel job renders at seed 0 (`handle_image_gen`), re-queueing it
   *  unchanged returned the identical picture. */
  const genBeatAlts = async (b: Beat) => {
    setQueuingBeatIds((prev) => new Set(prev).add(b.id));
    try {
      const n = await queueBeatPanelAlternates(scene, b, panelCtx(), beats);
      setNote(`${n} alternates for shot ${b.idx + 1} queued`);
      reload();
    } finally {
      setQueuingBeatIds((prev) => {
        const next = new Set(prev);
        next.delete(b.id);
        return next;
      });
    }
  };

  /** Take one of the offered alternates. Writes the AUTO slot, so a still the
   *  user designated still outranks it — which is invisible unless said, hence
   *  the second note. */
  const pickAlt = (b: Beat, assetId: string) =>
    saveBeat(b.id, { meta: panelChoiceMeta(b, assetId) }).then(() => {
      setNote(b.meta?.still_asset_id
        ? "Set as this shot's panel — your own picture still outranks it on screen."
        : "Set as this shot's panel.");
      void markSceneBlocksStale(scene.id);
      reload();
    });

  /** Redrawing an EXISTING panel opens its prompt and references first.
   *
   *  A panel stages into the render as a `scene_ref` whose framing is
   *  INTENDED, so a wrong panel becomes a wrong shot — which makes it the one
   *  picture you routinely need to argue with rather than re-roll. Requeueing
   *  the same `prompt_spec` blind just spends another render asking the identical
   *  question again; the thing that changes the answer is the prompt, and it
   *  is already on the asset (`meta.prompt` — the COMPOSED string the worker
   *  sent, not the spec). Drawing a panel for the FIRST time still queues
   *  directly: there is no composed prompt yet to show, because composition
   *  happens worker-side by design. */
  const openPanelEditor = async (assetId: string, beatId: string) => {
    setLoadingRegen(assetId);
    try {
      const src = await loadGenerationSource(assetId);
      if (!src?.prompt) {
        setNote("That picture has no stored prompt — draw a panel first, then it can be edited.");
        return;
      }
      setRegen({ asset: src.asset, prompt: src.prompt, refs: src.refs, label: src.label, beatId });
    } catch (e) {
      setNote(`Could not load the prompt: ${String(e).slice(0, 120)}`);
    } finally {
      setLoadingRegen(null);
    }
  };

  /** Drop a deliberate pick and fall back to the drawn panel. Without this the
   *  user slot is a one-way door: it outranks the panel everywhere, so an
   *  upload you changed your mind about can't be undone from any surface. */
  const clearBeatStill = (b: Beat, stillId: string) =>
    saveBeat(b.id, {
      meta: {
        ...(b.meta ?? {}),
        still_asset_id: null,
        ...(b.meta?.start_frame_asset_id === stillId ? { start_frame_asset_id: null } : {}),
      },
    }).then(() => {
      setNote(b.meta?.panel_asset_id ? "Back to the drawn panel." : "Removed.");
      void markSceneBlocksStale(scene.id);
      reload();
    });

  /** Put a picture of the user's own on this shot — uploaded, or chosen out
   *  of the library. `beatStillMeta` is the rule (which slot, and the start
   *  frame it has to drop); this adds the two things a component owes.
   *
   *  IT MARKS THE SCENE'S BLOCKS STALE, which the upload path never did. The
   *  picture rides into the render through `ref_plan_for`, so putting one on
   *  a shot changes what that block will look like — and an edit that changes
   *  the render with nothing saying to re-render is the failure the director's
   *  own tools note calls the main way this goes wrong. `clearBeatStill` has
   *  always done it; setting and clearing disagreeing was the bug. */
  const setBeatStill = (b: Beat, assetId: string, what: string) => {
    const meta = beatStillMeta(b, assetId);
    // Whether the rule above dropped a start frame — which is worth SAYING,
    // since the role segment is about to move back to "look" on its own.
    const dropStart = meta.start_frame_asset_id === null
      && b.meta?.start_frame_asset_id != null;
    return saveBeat(b.id, { meta })
      .then(() => {
        setNote(dropStart
          ? `${what} It is a look reference — mark it "start frame" to open the block on it.`
          : b.meta?.panel_asset_id
          ? `${what} It outranks the drawn panel, which is kept underneath.`
          : what);
        void markSceneBlocksStale(scene.id);
        reload();
      });
  };

  const splitBeat = async (b: Beat) => {
    const later = beats.filter((x) => x.idx > b.idx).sort((a, c) => c.idx - a.idx);
    for (const x of later) await saveBeat(x.id, { idx: x.idx + 1 } as Partial<Beat>);
    const half = Math.max(1000, Math.round(b.duration_ms / 2));
    await saveBeat(b.id, { duration_ms: half } as Partial<Beat>);
    await supabase.from("beats").insert({
      scene_id: scene.id, idx: b.idx + 1, duration_ms: b.duration_ms - half,
      camera: b.camera, action: `${b.action} — held a moment longer.`, sfx: b.sfx, meta: {},
    });
    await markSceneBlocksStale(scene.id);
    reload();
  };

  const deleteBeat = async (b: Beat) => {
    setArmedDelete(null);
    await supabase.from("beats").delete().eq("id", b.id);
    const later = beats.filter((x) => x.idx > b.idx).sort((a, c) => a.idx - c.idx);
    for (const x of later) await saveBeat(x.id, { idx: x.idx - 1 } as Partial<Beat>);
    await markSceneBlocksStale(scene.id);
    reload();
  };

  const addBeat = async () => {
    await supabase.from("beats").insert({
      scene_id: scene.id, idx: beats.length, duration_ms: 4000, action: "", meta: {},
    });
    reload();
  };

  /** Sits at the end of the takes row: adding a line is a beat-level action,
   *  and it was the only one on a row of its own. */
  const addDialogue = (b: Beat) => (asArray(b.dialogue).length ? null : (
    <button className="ws-microbtn" style={{ padding: "0 11px", flexShrink: 0 }}
            title="Give this beat a spoken line"
            onClick={() => {
              const first = cast[0];
              void saveBeat(b.id, {
                dialogue: [{ speaker_id: first?.id ?? "", speaker: first?.name, line: "" }],
              }).then(reload);
            }}>
      <Plus size={12} />Dialogue
    </button>
  ));

  const reorder = async (from: number, to: number) => {
    if (from === to) return;
    const a = beats[from], b = beats[to];
    await saveBeat(a.id, { idx: -1 } as Partial<Beat>);
    await saveBeat(b.id, { idx: a.idx } as Partial<Beat>);
    await saveBeat(a.id, { idx: b.idx } as Partial<Beat>);
    await markSceneBlocksStale(scene.id);
    reload();
  };

  // Blocks the recompile will actually touch: markSceneBlocksStale only moves
  // rows that already generated, so promising more than that would be a lie.
  const willRecompile = blocks.filter((b) => b.status === "generated").length;
  // Gated on `STALE_UI` (see lib/staleBlocks): while it is off this scene has
  // no `stale` to report, and the two write receipts below stop naming it too.
  const stale = STALE_UI ? blocks.filter((b) => b.status === "stale").length : 0;
  const sceneAt = data.scenes.findIndex((x) => x.id === scene.id);
  const goScene = (d: -1 | 1) => {
    const next = data.scenes[sceneAt + d];
    if (next) ws.openModal({ kind: "scene", sceneId: next.id });
  };

  let bt = t0;
  return (
    <>
      {delDialog}
      <ModalShell
        width={1200} tall z={94}
        onClose={close}
        icon={<LayoutList size={16} />}
        title={
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: "#5aa2ff", flexShrink: 0 }}>
              S{scene.idx + 1}
            </span>
            {/* Keyed by scene: the header nav swaps the scene under a mounted
                modal, and an uncontrolled input keeps whatever it was first
                given — S2 rendered with S1's title. */}
            <input key={scene.id} className="ws-titleinput" defaultValue={scene.slug ?? ""}
                   placeholder="Scene title"
                   onBlur={(e) => e.target.value !== (scene.slug ?? "") &&
                     saveScene(scene.id, { slug: e.target.value }).then(reload)} />
            {/* Scene nav: reading the next scene shouldn't cost closing this. */}
            <span className="ws-scenenav">
              <button title="Previous scene" disabled={sceneAt <= 0} onClick={() => goScene(-1)}>
                <ChevronLeft size={14} />
              </button>
              <span>{sceneAt + 1} / {data.scenes.length}</span>
              <button title="Next scene" disabled={sceneAt >= data.scenes.length - 1}
                      onClick={() => goScene(1)}>
                <ChevronRight size={14} />
              </button>
            </span>
          </span>
        }
        context={`${ep?.code ?? ""} · ${fmtT(t0)}–${fmtT(t0 + scene.duration_ms)}s · ${fmtT(scene.duration_ms)}s · ${beats.length} BEATS · ${blocks.length} BLOCKS`.toUpperCase()}
        headActions={<>
          {stale > 0 && (
            <span className="ws-dirty" title="Edited since they last rendered — retake to pick the changes up">
              <i />{stale} block{stale === 1 ? "" : "s"} stale
            </span>
          )}
          <span className="ws-pill mono" style={{ flexShrink: 0, fontSize: 11, padding: "4px 9px",
                                                  background: `${ST[scene.status] ?? "#5b6478"}1f`,
                                                  borderColor: `${ST[scene.status] ?? "#5b6478"}52`,
                                                  color: ST[scene.status] ?? "#8b93a7" }}>
            {scene.status}
          </span>
          <button className="ws-ghost" style={{ height: 30, padding: "0 11px", fontSize: 11 }}
                  onClick={() =>
                    saveScene(scene.id, { status: scene.status === "locked" ? "approved" : "locked" }).then(reload)}>
            <Lock size={13} />{scene.status === "locked" ? "Unlock" : "Lock scene"}
          </button>
        </>}
        footer={<>
          {/* Hard left, with the flexible summary between it and Save — a
              destructive button next to the primary one is a misclick away
              from it. Refused while a block of this scene is on the GPU: the
              beats cascade with the scene and the render compiles from
              them. Same rule as the storyboard page's scene menu. */}
          <button className="ws-ghost danger"
                  disabled={blocks.some((b) => b.status === "generating")}
                  title={blocks.some((b) => b.status === "generating")
                    ? "A block of this scene is rendering — wait for it, or cancel the run first"
                    : "Remove this scene and its shots from the episode. Panels already drawn stay in the library."}
                  onClick={() => setDelScene({
                    scene, shots: beats.length,
                    blocks: blocks.length,
                  })}>
            <Trash2 size={14} />Delete scene
          </button>
          <span className="sum">
            {fmtT(scene.duration_ms)}s · {beats.length} beats · est. <b style={{ color: "#ffb454", fontWeight: 600 }}>${est}</b>
            {willRecompile > 0 && (
              <span style={{ color: "#ffb454" }}>
                {" "}· recompiles {willRecompile} block{willRecompile === 1 ? "" : "s"}
              </span>
            )}
            {note && <span style={{ color: "#6fd08c", marginLeft: 10 }}>{note}</span>}
          </span>
          <button className="ws-ghost" onClick={close}>Cancel</button>
          <button className="ws-primary glow" onClick={async () => {
            await markSceneBlocksStale(scene.id);
            close();
          }}>
            <Check size={15} />Save & recompile
          </button>
        </>}
      >
        {/* The block plan as a ruler: the 15s cap is a width, and the room left
            before another block is a gap you can see. Beats are written above
            it; this is what they compile into. */}
        <div className="ws-blockruler">
          <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "#5e6678" }}>BLOCKS</span>
          <div className="segs">
            {blocks.map((b, i) => {
              const acc = BLOCK_ACCENTS[i % BLOCK_ACCENTS.length];
              const n = beats.filter((x) => b.beat_ids.includes(x.id)).length;
              const dur = b.t_end_ms - b.t_start_ms;
              return (
                <button key={b.id} className="seg"
                        style={{ flex: Math.max(dur, 1), background: `${acc}24`, borderColor: `${acc}59` }}
                        title={`${blockRef(b.idx)} · ${planBlockStatus(b.status, !!b.active_take_id)} · ${fmtT(dur)}s — ${b.active_take_id ? "open takes & assembly" : "open prompt & references"}`}
                        onClick={() => ws.openModal(b.active_take_id
                          ? { kind: "takes", blockId: b.id, fromScene: scene.id }
                          : { kind: "prompt", blockId: b.id, fromScene: scene.id })}>
                  <b style={{ color: acc }}>{blockRef(b.idx)}</b>
                  <span>{fmtT(dur)}s · {n} beat{n === 1 ? "" : "s"}</span>
                </button>
              );
            })}
            {blocks.length === 0 ? (
              <div className="room" style={{ flex: 1 }}>
                no blocks planned yet — launch a render to plan them
              </div>
            ) : room > 0 ? (
              <div className="room" style={{ flex: Math.max(room, 1) }}>
                room for {fmtT(room)}s before a {blocks.length + 1}
                {blocks.length + 1 === 2 ? "nd" : blocks.length + 1 === 3 ? "rd" : "th"} block
              </div>
            ) : null}
          </div>
          <span className="cap">cap {fmtT(BLOCK_CAP_MS)}s / block</span>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 18, padding: "14px 22px 4px" }}>
          {/* ── left: beats ── */}
          <div className="ns-scroll" style={{ flex: 1, minWidth: 0, overflowY: "auto",
                                              display: "flex", flexDirection: "column", gap: 12, paddingBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="ws-mlabel">Beats</span>
              <span style={{ height: 1, flex: 1, background: "linear-gradient(90deg, rgba(255,255,255,.12), transparent)" }} />
              <span className="mono" style={{ fontSize: 11.5, color: "#5e6678" }}>
                drag to reorder · 2–12s each
              </span>
            </div>

            {beats.map((b, bi) => {
              const s0 = bt; bt += b.duration_ms;
              const blk = blockFor(b);
              // The picture this shot shows and which slot it came from — a
              // deliberate still outranks the drawn panel, exactly as the ref
              // plan ranks them.
              const pick = beatImageId(b);
              const bstill = pick.id ? data.stills.get(pick.id) ?? null : null;
              const isPanel = pick.kind === "panel";
              const hasPanelToo = pick.kind === "still" && !!b.meta?.panel_asset_id;
              const prevMove = bi > 0 ? parseCamera(beats[bi - 1].camera).move : null;
              const bPending = pending.get(`b:${b.id}`)
                || (queuingBeatIds.has(b.id) ? { status: "queued", progress: null } : null);
              const isDrawing = bPending?.status === "running";
              const isQueued = !!bPending && !isDrawing;
              return (
                <div key={b.id} className="ws-beatcard"
                     draggable
                     onDragStart={() => { dragIdx.current = bi; }}
                     onDragOver={(e) => e.preventDefault()}
                     onDrop={() => { if (dragIdx.current != null) void reorder(dragIdx.current, bi); dragIdx.current = null; }}>
                  <div style={{ width: 34, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 7, paddingTop: 2 }}>
                    <span className="ws-griphandle"><GripVertical size={12} /></span>
                    {blk && (
                      // Same accent the ruler gave this block, so "which render
                      // am I editing" is answered by colour in both places.
                      <span className="mono"
                            title={`block ${blockRef(blk.idx)} · ${planBlockStatus(blk.status, !!blk.active_take_id)}`}
                            style={{ fontSize: 10, fontWeight: 700,
                                     color: BLOCK_ACCENTS[blocks.indexOf(blk) % BLOCK_ACCENTS.length] }}>
                        {blockRef(blk.idx)}
                      </span>
                    )}
                  </div>
                  <div style={{ width: 132, flexShrink: 0, display: "flex", flexDirection: "column", gap: 7 }}>
                    <div style={{ position: "relative", aspectRatio: "16/9", borderRadius: 13, overflow: "hidden",
                                  background: "#0b0e14",
                                  border: `1px solid ${isDrawing ? "rgba(143,194,255,.45)" : isQueued ? "rgba(255,180,84,.4)" : "rgba(255,255,255,.08)"}` }}>
                      {bstill && (
                        <img src={assetUrl(bstill) ?? undefined} alt=""
                             title="Open the storyboard slideshow"
                             onClick={() => setLightbox(scenePanels.findIndex((x) => x.beat.id === b.id))}
                             style={{
                               width: "100%", height: "100%", objectFit: "cover",
                               cursor: bPending ? "default" : "zoom-in",
                               filter: bPending ? "brightness(0.35) blur(1px)" : undefined,
                             }} />
                      )}
                      {bPending ? (
                        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column",
                                      alignItems: "center", justifyContent: "center", gap: 4,
                                      background: bstill ? "rgba(11,14,20,0.72)" : "rgba(11,14,20,0.45)", zIndex: 2 }}>
                          <Loader2 size={16} className="ns-spin" style={{ color: isDrawing ? "#8fc2ff" : "#ffb454" }} />
                          <span className="mono" style={{ fontSize: 9.5, fontWeight: 600,
                                                          color: isDrawing ? "#8fc2ff" : "#ffb454",
                                                          background: isDrawing ? "rgba(14,28,54,0.9)" : "rgba(44,28,12,0.9)",
                                                          padding: "1px 5px", borderRadius: 4,
                                                          border: `1px solid ${isDrawing ? "rgba(143,194,255,.35)" : "rgba(255,180,84,.35)"}` }}>
                            {isDrawing ? "drawing…" : "in queue"}
                          </span>
                        </div>
                      ) : !bstill ? (
                        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#3d4658" }}>
                          <ImageIcon size={16} />
                        </span>
                      ) : null}
                      <span className="mono ws-microbadge"
                            style={{
                              color: bPending ? (isDrawing ? "#8fc2ff" : "#ffb454")
                                : bstill ? (isPanel ? "#8fc2ff" : "#6fd08c") : "#5e6678",
                              zIndex: 3,
                            }}
                            title={bPending ? (isDrawing ? "Actively rendering this panel on the GPU" : "Waiting in queue to render this panel")
                              : isPanel ? "drawn from this shot's plan, anchored on the cast's sheets"
                              : hasPanelToo ? "your own pick — a drawn panel is on file underneath it"
                              : bstill ? "your own pick" : undefined}>
                        {bPending ? (isDrawing ? "drawing…" : "in queue")
                          : bstill ? (isPanel ? "panel" : hasPanelToo ? "yours · panel kept" : "yours")
                          : "no panel"}
                      </span>
                      {/* Only offered when there is something to fall back to
                          or undo — a bare × on a generated panel would read as
                          "delete", and redrawing is what that wants. */}
                      {pick.kind === "still" && !bPending && (
                        <button className="ws-tileclose"
                                style={{ zIndex: 3 }}
                                title={hasPanelToo ? "Use the drawn panel instead" : "Remove this picture"}
                                onClick={() => void clearBeatStill(b, bstill!.id)}>
                          <X size={11} />
                        </button>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 5 }}>
                      <button className="ws-microbtn accent mono"
                              disabled={(!!bstill && loadingRegen === bstill.id) || !!bPending}
                              title={isPanel
                                ? "Edit this panel's prompt and references, then redraw it"
                                : "Draw this shot as a storyboard panel, anchored on its cast and location sheets"}
                              onClick={() => {
                                if (isPanel && bstill) void openPanelEditor(bstill.id, b.id);
                                else void genBeatPanel(b);
                              }}>
                        {(bstill && loadingRegen === bstill.id) || bPending
                          ? <Loader2 size={11} className="ns-spin" />
                          : <Sparkles size={11} />}
                        {isPanel ? "redraw" : "panel"}
                      </button>
                      {/* Re-roll, as distinct from redraw: same prompt, five
                          different seeds. Only offered once a panel exists —
                          before that "panel" is the thing to press, and
                          spending 5x on a shot nobody has seen once is the
                          wrong default. */}
                      {isPanel && (
                        <button className="ws-microbtn sq mono"
                                disabled={!!bPending}
                                title={"Five more takes of this shot at the same prompt, to choose between"}
                                onClick={() => void genBeatAlts(b)}>
                          <Layers size={11} />
                        </button>
                      )}
                      {/* A picture of your own for this shot — chosen from the
                          library, or dropped into it on the way past. This was
                          a bare file input whose tooltip already read "Upload
                          or pick from library", so half of what it promised
                          did not exist: a panel drawn anywhere else, a frame
                          saved off the timeline, a reference already in the
                          library could not be put on a shot at all. The picker
                          uploads too (its own Upload pill), so this is one
                          control doing both rather than a fourth button in a
                          132px row — and an uploaded panel lands in the
                          library, where it can be used on a second shot. */}
                      <button className="ws-microbtn sq"
                              title="Choose this shot's picture from the library — or drop a new one in"
                              onClick={() => setPickFor(b)}>
                        <Images size={11} />
                      </button>
                    </div>
                    {/* The alternates on offer. A strip rather than a modal:
                        the decision is "which of these is the shot", and it is
                        made by looking at them next to the one in the slot
                        above — moving that comparison into an overlay would
                        hide the thing being compared against. */}
                    {(() => {
                      const alts = (b.meta?.panel_alts as string[] | undefined) ?? [];
                      if (!alts.length) return null;
                      const chosen = b.meta?.panel_asset_id as string | undefined;
                      return (
                        <div className="ws-altstrip" aria-label="alternate takes">
                          {alts.map((id) => {
                            const a = data.stills.get(id);
                            if (!a) return null;
                            const on = id === chosen;
                            return (
                              <button key={id} className={on ? "on" : ""}
                                      title={on ? "This is the shot" : "Use this take"}
                                      onClick={() => !on && void pickAlt(b, id)}>
                                <img src={assetUrl(a) ?? undefined} alt="" />
                                {on && <span className="tick"><Check size={9} /></span>}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}
                    {/* What this image IS, not just what it's attached to. H3
                        treats the two completely differently, so the choice is
                        explicit rather than inferred from where it was set. */}
                    {/* A panel and a user still stage into the render with
                        OPPOSITE instructions — a panel is a `scene_ref` whose
                        framing is INTENDED, a user still is a `look` whose
                        framing is explicitly disclaimed — so the left segment
                        names the one this picture actually gets rather than
                        calling both "look". */}
                    <div className="ws-roleseg" aria-label="how this image is used">
                      {([
                        isPanel
                          ? ["look", "storyboard", "Stages as the composed shot — the render follows its framing."] as const
                          : ["look", "look", "Match its rendering — colour, light, materials. Its framing is ignored."] as const,
                        ["start", "start frame", "The block opens on this exact image, composition and all."] as const,
                      ]).map(([id, label, title]) => {
                        const on = id === "start"
                          ? !!bstill && b.meta?.start_frame_asset_id === bstill.id
                          : !bstill || b.meta?.start_frame_asset_id !== bstill.id;
                        return (
                          <button key={id} className={on ? "on" : ""} title={title} disabled={!bstill}
                                  onClick={() => bstill && saveBeat(b.id, {
                                    meta: {
                                      ...(b.meta ?? {}),
                                      start_frame_asset_id: id === "start" ? bstill.id : null,
                                    },
                                  }).then(() => {
                                    setNote(id === "start"
                                      ? "Opens the block on this frame — replaces the chain anchor."
                                      : "Used as a look reference — its framing won't be copied.");
                                    void markSceneBlocksStale(scene.id);
                                    reload();
                                  })}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                      <span className="mono ws-durchip">{fmtT(b.duration_ms)}s</span>
                      <span className="mono" style={{ fontSize: 11.5, fontWeight: 500, color: "#5e6678" }}>
                        {fmtT(s0)} → {fmtT(bt)}
                      </span>
                      {/* A beat outside 2–12s isn't wrong, it's a warning: under
                          two seconds barely registers as a shot, and over twelve
                          leaves no room for anything else in its block. */}
                      {(b.duration_ms < 2000 || b.duration_ms > 12000) && (
                        <span className="ws-pill mono" style={{ fontSize: 9.5, padding: "3px 8px",
                                background: "rgba(255,180,84,.1)", borderColor: "rgba(255,180,84,.28)",
                                color: "#ffb454" }}>
                          {b.duration_ms < 2000 ? "under 2s minimum" : "over 12s"}
                        </span>
                      )}
                      <span style={{ flex: 1 }} />
                      <button className="ws-microbtn sq" title="Split beat" onClick={() => void splitBeat(b)}>
                        <Scissors size={13} />
                      </button>
                      <button className="ws-microbtn sq" title="Ask the director to rewrite"
                              onClick={() => ws.askDirector(
                                `Rewrite beat ${b.idx + 1} of scene S${scene.idx + 1} ("${scene.slug}"). Current action: "${b.action}". Keep it the same length; make it land harder.`)}>
                        <RefreshCw size={13} />
                      </button>
                      {armedDelete === b.id ? (
                        <span className="ws-confirm">
                          <span>delete beat?</span>
                          <button className="yes" onClick={() => void deleteBeat(b)}>yes</button>
                          <button onClick={() => setArmedDelete(null)}>no</button>
                        </span>
                      ) : (
                        <button className="ws-microbtn sq danger" title="Delete beat"
                                onClick={() => setArmedDelete(b.id)}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    {/* The camera line gets the whole row — split into the
                        recognized picks as chips plus the compiled string in
                        full, wrapping rather than truncating. One long line
                        here used to clip at "wide · static → …", the half
                        that says nothing. */}
                    <CameraTrigger beat={b} onOpen={() => setCamFor(b)} />
                    <textarea rows={4} className="ws-input ns-scroll" defaultValue={b.action}
                              style={{ fontSize: 13.5, lineHeight: 1.6, borderRadius: 15 }}
                              onBlur={(e) => e.target.value !== b.action &&
                                saveBeat(b.id, { action: e.target.value }).then(reload)} />
                    {asArray<NonNullable<Beat["dialogue"]>[number]>(b.dialogue).map((d, di) => {
                      const speaker = bible.find((x) => x.id === d.speaker_id);
                      return (
                        <div key={di} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                          <button className="ws-speakerpill mono" title="Cycle speaker"
                                  onClick={() => {
                                    if (!cast.length) return;
                                    const cur = cast.findIndex((c) => c.id === d.speaker_id);
                                    const nx = cast[(cur + 1) % cast.length];
                                    const dl = [...(b.dialogue ?? [])];
                                    dl[di] = { ...d, speaker_id: nx.id, speaker: nx.name };
                                    void saveBeat(b.id, { dialogue: dl }).then(reload);
                                  }}>
                            {(speaker?.name ?? d.speaker ?? "?").toUpperCase()}<ChevronRight size={11} />
                          </button>
                          <input className="ws-input" defaultValue={d.line} style={{ flex: 1, minWidth: 0, height: 34, fontStyle: "italic", fontSize: 13.5 }}
                                 onBlur={(e) => {
                                   const dl = [...asArray<NonNullable<Beat["dialogue"]>[number]>(b.dialogue)];
                                   dl[di] = { ...d, line: e.target.value };
                                   void saveBeat(b.id, { dialogue: dl }).then(reload);
                                 }} />
                          <input className="ws-input" defaultValue={d.delivery ?? ""} placeholder="delivery"
                                 style={{ width: 118, flexShrink: 0, height: 34, fontSize: 12, color: "#9aa4b6" }}
                                 onBlur={(e) => {
                                   const dl = [...asArray<NonNullable<Beat["dialogue"]>[number]>(b.dialogue)];
                                   dl[di] = { ...d, delivery: e.target.value || undefined };
                                   void saveBeat(b.id, { dialogue: dl }).then(reload);
                                 }} />
                          <button className="ws-microbtn sq danger" style={{ height: 34, width: 30 }}
                                  onClick={() => {
                                    const dl = asArray<NonNullable<Beat["dialogue"]>[number]>(b.dialogue).filter((_, i) => i !== di);
                                    void saveBeat(b.id, { dialogue: dl.length ? dl : null }).then(reload);
                                  }}>
                            <X size={12} />
                          </button>
                        </div>
                      );
                    })}
                    <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                      <span className="ws-mlabel" style={{ fontSize: 10.5 }}>sfx</span>
                      <input className="ws-input" defaultValue={b.sfx ?? ""} placeholder="none"
                             style={{ flex: 1, minWidth: 0, height: 30, fontSize: 12, color: "#9aa4b6" }}
                             onBlur={(e) => e.target.value !== (b.sfx ?? "") &&
                               saveBeat(b.id, { sfx: e.target.value || null }).then(reload)} />
                    </div>
                    {blk ? (
                      <BeatTakes
                        block={blk}
                        beatCount={beats.filter((x) => blk.beat_ids.includes(x.id)).length}
                        takes={data.takesByBlock.get(blk.id) ?? []}
                        assets={data.takeAssets}
                        sceneId={scene.id}
                        onChanged={reload}
                        trailing={addDialogue(b)}
                      />
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span className="mono" style={{ fontSize: 11, color: "#5e6678" }}>
                          no block yet — planned at launch
                        </span>
                        <span style={{ flex: 1 }} />
                        {addDialogue(b)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <button className="ws-dashbtn big" onClick={() => void addBeat()}>
              <Plus size={15} />Add a beat
            </button>

            <div style={{ display: "flex", gap: 11, padding: 14, borderRadius: 18,
                          background: "rgba(201,122,255,.055)", border: "1px solid rgba(201,122,255,.24)" }}>
              <Sparkles size={15} style={{ color: "#c97aff", flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 9 }}>
                <span style={{ fontSize: 12.5, lineHeight: 1.65, color: "#c4a8dd" }}>
                  Want a second pair of eyes? The directing expert can propose an insert or re-pace
                  these beats against the {blocks.length}-block plan.
                </span>
                <div style={{ display: "flex", gap: 7 }}>
                  <button style={{ height: 30, padding: "0 12px", borderRadius: 14, border: "1px solid rgba(201,122,255,.45)",
                                   background: "rgba(201,122,255,.12)", color: "#c97aff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                          onClick={() => ws.askDirector(
                            `Look at scene S${scene.idx + 1} ("${scene.slug}") and suggest one insert beat or pacing change that would make it land harder. Be specific.`)}>
                    Ask for a suggestion
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── right rail ── */}
          <div className="ns-scroll" style={{ flex: "0 0 auto", width: 314, overflowY: "auto",
                                              display: "flex", flexDirection: "column", gap: 12, paddingBottom: 14 }}>
            {/* The scene's STORYBOARD, in reading order — the same panels the
                storyboard page shows and the same ones that stage into the
                render. This slot used to be the scene's single "key still": a
                picture composed from the scene's prose that answered no
                question the beats below don't answer better, while the actual
                per-shot panels weren't shown here at all. */}
            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9, flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span className="ws-mlabel">Storyboard</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 10, color: drawn === beats.length && beats.length ? "#6fd08c" : "#5e6678" }}>
                  {beats.length ? `${drawn} / ${beats.length} shots` : "no shots yet"}
                </span>
              </div>
              <ScenePanelGrid
                beats={beats}
                sceneNo={scenes.findIndex((x) => x.id === scene.id) + 1 || 1}
                assetOf={(id) => (id ? data.stills.get(id) : null)}
                busy={(b) => pending.get(`b:${b.id}`) ?? (queuingBeatIds.has(b.id) ? { status: "queued" } : null)}
                onOpen={(b) => setLightbox(scenePanels.findIndex((x) => x.beat.id === b.id))}
                onFill={(b) => setPickFor(b)}
              />
              <button className="ws-microbtn accent" style={{ height: 30 }}
                      disabled={!beats.length || queuingBeatIds.size > 0}
                      title="One panel per shot, anchored on this scene's cast and location sheets"
                      onClick={() => void genScenePanels()}>
                {queuingBeatIds.size > 0
                  ? <Loader2 size={12} className="ns-spin" />
                  : <Sparkles size={12} />}
                {drawn ? "Re-draw panels" : "Draw storyboard panels"}
              </button>
              {/* The panels above are N separate renders and drift apart —
                  different grade, different place, sometimes a different time
                  of day — and only TWO of them fit a block's slot budget. This
                  draws each block's shots as ONE numbered sheet instead: one
                  picture, one grade, every shot, one slot. It replaces the
                  panels in the render rather than joining them (two pictures
                  claiming one shot's composition is a contradiction), which is
                  why it sits under them and says so. */}
              <button className="ws-microbtn" style={{ height: 30 }}
                      disabled={!beats.length || !blocks.length}
                      title={blocks.length
                        ? `One numbered contact sheet per block (${blocks.length} here), `
                          + "staged whole into the render in place of the per-shot panels — "
                          + "one grade and one location across every shot"
                        : "this scene has no generation blocks yet"}
                      onClick={() => void genBlockSheets()}>
                <LayoutGrid size={12} />
                {sheeted ? "Re-draw segment storyboards" : "Draw segment storyboards"}
                {blocks.length > 1 && ` (${blocks.length})`}
              </button>
            </div>

            {/* The key still is display-only material (a scene card thumbnail,
                the collapsed storyboard row) — it hasn't ridden into a render
                since prose-composed stills were demoted for inventing faces.
                So it keeps its controls and loses the hero slot. */}
            <div className="ws-card" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <span className="ws-entthumb" style={{ width: 54, height: 32, borderRadius: 9, flexShrink: 0 }}>
                {still ? <img src={assetUrl(still) ?? undefined} alt=""
                              title="open in the library viewer" style={{ cursor: "zoom-in" }}
                              onClick={() => ws.openModal({ kind: "asset", assetId: still.id, fromScene: scene.id })} />
                  : pending.get(`s:${scene.id}`)
                  ? <Loader2 size={13} className="ns-spin" style={{ color: "#8fc2ff" }} />
                  : <ImageIcon size={13} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ws-mlabel">Key still</div>
                <div className="mono" style={{ fontSize: 10, color: "#5e6678", marginTop: 3 }}>
                  card thumbnail · not a render reference
                </div>
              </div>
              <button className="ws-microbtn" style={{ padding: "0 10px", flexShrink: 0 }}
                      disabled={!!pending.get(`s:${scene.id}`)}
                      onClick={() => enqueueJob({
                        kind: "image_gen", lane: "gpu", priority: 20, project_id: ep?.project_id,
                        model_id: modelId ?? resolveDefaults(settings).image_model,
                        payload: {
                          prompt: withStyle(styleTextFor(settings, projectStyle).text || undefined,
                                            scene.scene_prompt ?? scene.slug ?? "scene still"),
                          model_key: modelKeyOf(modelId ?? resolveDefaults(settings).image_model),
                          width: 1280, height: 720,
                          ...loraFor(modelId ?? resolveDefaults(settings).image_model),
                          target: { scene_id: scene.id }, auto_accept: true,
                          ref_asset_ids: castAnchors(),
                        },
                      }).then(() => { setNote("New key still queued"); reload(); })}>
                <RefreshCw size={11} />New
              </button>
            </div>

            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span className="ws-mlabel">Image model</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 10, color: "#5e6678" }}>
                  {castAnchors().length
                    ? `${castAnchors().length} anchor${castAnchors().length === 1 ? "" : "s"}`
                    : "no anchors"}
                </span>
              </div>
              <ImageModelPicker models={catalog} value={modelId ?? resolveDefaults(settings).image_model}
                                onPick={setModelId} withRefs={castAnchors().length > 0} compact
                                loras={effLoras} onLoras={setLoras} />
              {/* With anchors the header already says how many; the note is
                  only worth a row when it's telling you to go fix something. */}
              {!castAnchors().length && (
                <div className="ws-warnline">
                  <AlertTriangle size={13} />
                  <p>No cast refs — stills will invent whoever appears in them. Add a face reference in the bible first.</p>
                </div>
              )}
            </div>

            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span className="ws-mlabel">Environment</span>
                <span style={{ flex: 1 }} />
                <Dropdown width={252} align="right"
                  trigger={({ toggle }) => (
                    <button className="ws-microbtn" style={{ padding: "0 10px" }} onClick={toggle}>
                      {env ? "change" : "link"}
                    </button>
                  )}>
                  {(close) => (
                    <>
                      <div className="ws-menu-label">Environments</div>
                      {bible.filter((b) => b.kind === "environment").map((b) => (
                        <button key={b.id} className={"ws-menu-row" + (b.id === env?.id ? " on" : "")}
                                onClick={() => {
                                  close();
                                  void saveScene(scene.id, { environment_id: b.id })
                                    .then(() => { void markSceneBlocksStale(scene.id); reload(); });
                                }}>
                          <EntityThumb asset={refByEntry.get(b.id)} size={22} radius={7} />
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden",
                                         textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                          {b.id === env?.id && <Check size={13} style={{ color: "#5aa2ff" }} />}
                        </button>
                      ))}
                      {!bible.some((b) => b.kind === "environment") && (
                        <div className="ws-menu-empty">No environments in the bible yet.</div>
                      )}
                      {env && (
                        <>
                          <div className="ws-menu-sep" />
                          <button className="ws-menu-row" style={{ color: "#ff8080" }}
                                  onClick={() => {
                                    close();
                                    void saveScene(scene.id, { environment_id: null })
                                      .then(() => { void markSceneBlocksStale(scene.id); reload(); });
                                  }}>
                            <X size={13} />Unlink
                          </button>
                        </>
                      )}
                    </>
                  )}
                </Dropdown>
              </div>
              {env ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <EntityThumb asset={refByEntry.get(env.id)} size={46} radius={13} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>{env.name}</div>
                    <div className="mono" style={{ fontSize: 11, marginTop: 4,
                                                   color: env.status === "confirmed" ? "#6fd08c" : "#e8c268" }}>
                      bible v{env.version} · {env.status} · {refLabel(refCount.get(env.id) ?? 0)}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: "#5e6678" }}>
                  No environment linked — the model invents the place on every block.
                </div>
              )}
            </div>

            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span className="ws-mlabel">Cast</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 11, color: "#5e6678" }}>identity lines locked</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {cast.map((c) => (
                  <div key={c.id} className="ws-castrow">
                    <EntityThumb asset={refByEntry.get(c.id)} size={34} radius={11} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{c.name}</span>
                      <span className="mono" style={{ display: "block", fontSize: 10.5, marginTop: 2,
                                                      color: (refCount.get(c.id) ?? 0) ? "#6fd08c" : "#e8c268" }}>
                        {(refCount.get(c.id) ?? 0)
                          ? refLabel(refCount.get(c.id) ?? 0)
                          : "no refs — identity will drift"}
                      </span>
                    </span>
                    <button className="ws-microbtn sq danger rm" title="Remove from scene"
                            onClick={() => saveScene(scene.id, {
                              cast_ids: (scene.cast_ids ?? []).filter((id) => id !== c.id),
                            }).then(() => { void markSceneBlocksStale(scene.id); reload(); })}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {!cast.length && (
                  <div style={{ fontSize: 12.5, color: "#5e6678" }}>Nobody in this scene yet.</div>
                )}
              </div>
              <Dropdown width={252}
                trigger={({ toggle }) => (
                  <button className="ws-dashbtn" style={{ height: 32, fontSize: 12 }} onClick={toggle}>
                    <Plus size={12} />Add from bible
                  </button>
                )}>
                {(close) => {
                  const avail = bible.filter((b) => b.kind === "character"
                    && !(scene.cast_ids ?? []).includes(b.id));
                  return (
                    <>
                      <div className="ws-menu-label">Characters</div>
                      {avail.map((b) => (
                        <button key={b.id} className="ws-menu-row"
                                onClick={() => {
                                  close();
                                  void saveScene(scene.id, { cast_ids: [...(scene.cast_ids ?? []), b.id] })
                                    .then(() => { void markSceneBlocksStale(scene.id); reload(); });
                                }}>
                          <EntityThumb asset={refByEntry.get(b.id)} size={22} radius={7} />
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden",
                                         textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                          <span className="mono chip" style={{ flex: "none",
                                  color: (refCount.get(b.id) ?? 0) ? undefined : "#e8c268" }}>
                            {refLabel(refCount.get(b.id) ?? 0)}
                          </span>
                        </button>
                      ))}
                      {!avail.length && (
                        <div className="ws-menu-empty">
                          {bible.some((b) => b.kind === "character")
                            ? "Everyone in the bible is already in this scene."
                            : "No characters in the bible yet."}
                        </div>
                      )}
                    </>
                  );
                }}
              </Dropdown>
            </div>

            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {/* Label inline with the tags: this card is two short rows of
                  content and was spending a third on its own name. */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="ws-mlabel" style={{ flexShrink: 0 }}>Look</span>
                {look.map((l) => (
                  <button key={l} className="ws-pill" title="Remove"
                          style={{ borderColor: "rgba(90,162,255,.4)", background: "rgba(90,162,255,.1)", color: "#8fc2ff" }}
                          onClick={() => saveScene(scene.id, {
                            meta: { ...(scene.meta ?? {}), look: look.filter((x) => x !== l) },
                          }).then(reload)}>
                    {l}<X size={10} />
                  </button>
                ))}
                {lookDraft == null ? (
                  <button className="ws-pill" onClick={() => setLookDraft("")}>
                    <Plus size={11} />add
                  </button>
                ) : (
                  <input className="ws-input ws-lookinput" autoFocus value={lookDraft}
                         placeholder="e.g. sodium green"
                         onChange={(e) => setLookDraft(e.target.value)}
                         onBlur={() => commitLook()}
                         onKeyDown={(e) => {
                           if (e.key === "Enter") { e.preventDefault(); commitLook(true); }
                           if (e.key === "Escape") { e.preventDefault(); setLookDraft(null); }
                         }} />
                )}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2, flexWrap: "wrap" }}>
                {palette.slice(0, 6).map((c, i) => (
                  <button key={`${c}-${i}`} className="ws-swatch" style={{ background: c }}
                          title={`${c} — click to remove`}
                          onClick={() => savePalette(palette.filter((_, j) => j !== i))} />
                ))}
                <label className="ws-swatch add" title="Add a colour">
                  <Plus size={12} />
                  <input type="color" defaultValue="#5aa2ff"
                         onChange={(e) => savePalette([...palette, e.target.value])} />
                </label>
                <span className="mono" style={{ fontSize: 10.5, color: "#5e6678", marginLeft: 2 }}>
                  {sceneHasPalette ? "scene palette" : env ? "from environment" : "scene palette"}
                </span>
              </div>
            </div>

            {/* FIGHT. `params.fight` is what `_block_loras` reads to append
                the combat adapter, and `handle_launch_render` stamps it ONCE
                from the scene's `meta.type` at plan time — deliberately, so
                two takes of one block cannot disagree. The consequence is that
                a board planned before 2026-08-22, or a scene retyped
                afterwards, renders its fight scenes without the adapter for
                good and nothing anywhere says so. This is where you can see
                that and change it. It writes the BLOCKS, not `meta.type`:
                the type also arms the choreographer and the compiler's
                equipment discipline, which is a much larger claim than "use
                the combat adapter". */}
            {fight.total > 0 && (
              <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Swords size={13} style={{ color: fight.checked ? "#8fc2ff" : "#5e6678", flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12.5, color: fight.checked ? "#eaeef6" : "#9aa4b6" }}>
                      Combat adapter
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: "#5e6678" }}>
                      {(fight.sceneType ?? "untyped") + " scene · "}
                      {fight.mixed ? `${fight.on} of ${fight.total} blocks`
                        : fight.checked ? `all ${fight.total} block${fight.total === 1 ? "" : "s"}`
                        : "off"}
                    </span>
                  </span>
                  <button className={"ws-switch-t" + (fight.checked ? " on" : "")}
                          disabled={fightBusy}
                          title={fight.checked
                            ? "Render this scene's blocks without the combat adapter"
                            : "Render this scene's blocks with the combat adapter at 1.0 — "
                              + "noticeably more in-shot motion and impact on fight scenes"}
                          onClick={() => void toggleFight()}>
                    <i />
                  </button>
                </div>

                {/* Why it is off on a scene the writer called `action`: the
                    flag was never stamped, which is a different thing from
                    having been turned off, and it is the only one worth
                    offering to fix. */}
                {fight.drifted && (
                  <span className="mono" style={{ fontSize: 10, color: "#e0a23c" }}>
                    {fight.undecided === fight.total && fight.planned
                      ? "This is an action scene and its blocks were never marked — "
                        + "planned before the flag existed, or retyped since."
                      : fight.planned
                        ? "The writer typed this scene `action`, and its blocks disagree."
                        : `The writer typed this scene \`${fight.sceneType ?? "untyped"}\`, `
                          + "and its blocks carry the adapter anyway."}
                  </span>
                )}

                {/* A block spans one location and may span two scenes, and the
                    rule is whole-block — so there is no way to change half of
                    one, only to say which other scene this reaches. */}
                {fight.shared.length > 0 && (
                  <span className="mono" style={{ fontSize: 10, color: "#9aa4b6" }}>
                    {fight.shared.map((x) => blockRef(x.idx)).join(", ")}
                    {fight.shared.length === 1 ? " also covers " : " also cover "}
                    {[...new Set(fight.shared.flatMap((x) => x.otherSceneIds))]
                      .map((id) => scenes.find((sc) => sc.id === id)?.slug ?? "another scene")
                      .join(", ")}
                    {" — this changes what renders there too."}
                  </span>
                )}

                {/* And where it cannot reach the render at all. */}
                {fight.inert.length > 0 && (
                  <span className="mono" style={{ fontSize: 10, color: "#e0a23c" }}>
                    {fight.inert.map((x) => `${blockRef(x.idx)} renders on ${x.model}`).join(", ")}
                    {`, which does not declare \`combat\` — the switch changes nothing there.`}
                  </span>
                )}

                {fightNote && (
                  <span className="mono" style={{ fontSize: 10, color: "#8fc2ff" }}>{fightNote}</span>
                )}
              </div>
            )}

            {/* VIDEO MODEL. The checkpoint is the BLOCK's, not the
                project's: `handle_launch_render` copies the wizard's pick onto
                every block once, at plan time, so an episode cannot switch
                checkpoints shot to shot — and `_block_model` reads it back off
                the block on every render, retakes included. The consequence
                surprised the studio's own owner: the project was set to PDD,
                every block still carried turbo from the day the board was
                planned, and the storyboard's retake rendered turbo while the
                settings panel said PDD. Nothing was wrong; nothing said so
                either. This card is the saying, and the button is the
                deliberate re-stamp. */}
            {vmodel.total > 0 && (
              <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Cpu size={13} style={{ color: vmodel.drifted ? "#e0a23c" : "#5e6678", flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12.5, color: "#9aa4b6" }}>
                      Video model
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: "#5e6678" }}>
                      {vmodel.byKey.map((g) =>
                        `${nameOfKey(g.key)} (${g.idxs.map((i) => blockRef(i)).join(", ")})`
                      ).join(" · ")}
                    </span>
                  </span>
                  {/* `.ws-microbtn.accent` is `flex: 1`, which in this row
                      would stretch the button and squash the model list. */}
                  {vmodel.drifted && projModelKey && (
                    <button className="ws-microbtn accent" disabled={vmBusy}
                            style={{ flex: "0 0 auto" }}
                            title={`Re-stamp this scene's blocks onto ${nameOfKey(projModelKey)}, `
                              + "the project's default. They render on it at the next retake."}
                            onClick={() => void useProjectModel()}>
                      {vmBusy ? "…" : `Use ${nameOfKey(projModelKey)}`}
                    </button>
                  )}
                </div>

                {/* The whole point of the card: the project setting and what
                    renders are two different facts, and only one of them is on
                    the settings panel. */}
                {vmodel.drifted && projModelKey && (
                  <span className="mono" style={{ fontSize: 10, color: "#e0a23c" }}>
                    {`The project's default is ${nameOfKey(projModelKey)}. A block keeps the `}
                    {"checkpoint it was planned with, so retakes render what is listed above "}
                    {"until this is changed."}
                  </span>
                )}

                {/* A key with no catalog row — a desktop `local:` pick, or a
                    catalog that has not loaded. Say that rather than claiming
                    the scene has drifted from something unreadable. */}
                {!projModelKey && (
                  <span className="mono" style={{ fontSize: 10, color: "#5e6678" }}>
                    {"The project's default does not resolve to a known checkpoint, so there "}
                    {"is nothing to compare against."}
                  </span>
                )}

                {/* Same rule as the fight toggle one card up: a block spans one
                    location and may span two scenes, and it renders on one
                    checkpoint for the whole of itself. */}
                {vmodel.drifted && vmodel.shared.length > 0 && (
                  <span className="mono" style={{ fontSize: 10, color: "#9aa4b6" }}>
                    {vmodel.shared.map((x) => blockRef(x.idx)).join(", ")}
                    {vmodel.shared.length === 1 ? " also covers " : " also cover "}
                    {[...new Set(vmodel.shared.flatMap((x) => x.otherSceneIds))]
                      .map((id) => scenes.find((sc) => sc.id === id)?.slug ?? "another scene")
                      .join(", ")}
                    {" — this changes what renders there too."}
                  </span>
                )}

                {vmNote && (
                  <span className="mono" style={{ fontSize: 10, color: "#8fc2ff" }}>{vmNote}</span>
                )}
              </div>
            )}

            {/* "Blocks & chain" lived here as a row of chips plus a paragraph
                explaining the 15s cap. The ruler under the header now draws
                both — the plan, and the room left in it — so the card would
                only be saying it again in words. */}
          </div>
        </div>
      </ModalShell>

      {camFor && (
        <CameraPicker
          current={camFor.camera}
          context={`S${scene.idx + 1} · beat ${camFor.idx + 1}`}
          prevMove={camFor.idx > 0 ? parseCamera(beats[camFor.idx - 1]?.camera).move : null}
          onClose={() => setCamFor(null)}
          onApply={(camera) => {
            void saveBeat(camFor.id, { camera }).then(() => {
              void markSceneBlocksStale(scene.id);
              setCamFor(null);
              reload();
            });
          }}
        />
      )}

      {lightbox != null && scenePanels.length > 0 && (
        <Lightbox assets={scenePanels.map((x) => x.asset)}
                  index={Math.min(lightbox, scenePanels.length - 1)}
                  onClose={() => setLightbox(null)}
                  onStep={(d) => setLightbox((i) => stepIndex(i, d, scenePanels.length))}
                  actions={(asset, i) => {
                    // Only a picture with a stored prompt can be argued with;
                    // an upload has nothing to edit, so it goes to the general
                    // asset surface instead — and the label says which of the
                    // two you are about to get rather than opening a dead end.
                    const beat = scenePanels[i]?.beat;
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
                                  fromScene: scene.id, ...(beat ? { fromBeat: beat.id } : {}),
                                });
                              }}>
                        <Wand2 size={12} /> {editable ? "Redraw…" : "Details…"}
                      </button>
                    );
                  }} />
      )}

      {/* Portalled and z=97, so it stacks over this modal's own z=94 rather
          than replacing it — closing it returns you to the scene, mid-edit. */}
      {regen && (
        <PanelRegenModal
          asset={regen.asset}
          prompt={regen.prompt}
          refs={regen.refs}
          beatId={regen.beatId}
          projectId={ep?.project_id}
          label={regen.label}
          onClose={() => {
            const bid = regen.beatId;
            setRegen(null);
            setQueuingBeatIds((prev) => new Set(prev).add(bid));
            reload();
          }}
        />
      )}

      {/* Choosing this shot's picture. ONE image (`multi` off, so a click
          commits and there is no "add 2 references" to read past), IMAGES only,
          and the context line says what the picture will do rather than
          leaving it to be discovered at render time: a picture you choose is
          a `look` reference — its rendering is followed and its framing is
          explicitly disclaimed — unless you then mark it "start frame", which
          is the segment right under the tile. That is the studio's own rule
          ("a scene image's role is never inferred"), said where the choice is
          made. */}
      {pickFor && (
        <AssetPickerModal
          projectId={ep?.project_id ?? null}
          title={`Picture for shot ${pickFor.idx + 1}`}
          context={`${scene.slug ?? "scene"} · b${pickFor.idx + 1} — used as a look reference; `
                 + `mark it "start frame" after to open the block on it`}
          kindFilter="image"
          defaultRole="look"
          onPick={(picks) => {
            const a = picks[0];
            setPickFor(null);
            if (a) void setBeatStill(pickFor, a.asset.id, `Using ${a.label} on shot ${pickFor.idx + 1}.`);
          }}
          onClose={() => setPickFor(null)}
        />
      )}
    </>
  );
}

// The right rail: a persistent inspector with Inspector / Takes / History
// tabs. The Inspector tab leads with an effects toolbar — Cut, Trim,
// Transform, Crop, Retime, Slice — that writes real ClipOps the worker
// renders (mirror src/lib/db/types.ts ClipOp). Below it, Block info is a
// collapsed one-liner (expand for the full readout: mode, frames, trim,
// audio lock, refs), then the regenerate actions, the post chain, and clip
// settings. Every number is read from the row the worker wrote — nothing here
// is decorative.
//
// The post chain is stored INTENT, not a button. Its toggles used to enqueue a
// GPU job the instant you flipped one — see lib/postChain.ts for why that was
// wrong and what replaced it. Here it is a two-option picker (inherit the
// project's chain, or override it for this clip) whose writes land on
// `clips.post` and are cashed in by tl_render.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check, ChevronDown, ChevronRight, Clock, Crop, FlipHorizontal2,
  FlipVertical2, FolderOpen, Frame, Gauge, RefreshCw, Rewind, Ruler,
  Scissors, Slice, Snowflake, Upload, Wand2, X,
} from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { displayBlockStatus } from "../../lib/staleBlocks";
import { sourceBox } from "../../lib/clipCrop";
import {
  clipRate, freezeSourceMs, maxClipMs, retimeGeometry, MIN_CLIP_MS, SPLIT_EDGE_MS,
} from "../../lib/clipFrames";
import { assetUrl } from "../../lib/db/assets";
import { uploadAndAddTake } from "../../lib/db/director";
import { enqueueJob } from "../../lib/db/jobs";
import AudioFxPanel from "../timeline/AudioFxPanel";
import Dropdown from "../ui/Dropdown";
import PostChainToggles from "../ui/PostChainToggles";
import { activeOps, describeChain, resolvePost, type PostChain } from "../../lib/postChain";
import { resolveDefaults, type ProjectSettings } from "../../lib/projectSettings";
import { ST } from "./ContextPanel";
import type {
  Asset, BlockTake, Clip, ClipOp, GenerationBlock, Job, RefSlot, Track,
} from "../../lib/db/types";
import { asArray } from "../../lib/jsonb";
import { blockKind, blockLabel } from "../../lib/blockKind";

const fmtClock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="ws-inforow">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

/* ── effects toolbar ─────────────────────────────────────────────────────── */
type EffectTool = "cut" | "trim" | "transform" | "crop" | "retime" | "slice";

const TOOLS: { id: EffectTool; icon: React.ReactNode; label: string; title: string }[] = [
  { id: "cut", icon: <Scissors size={15} />, label: "Cut", title: "Split the clip at the playhead" },
  { id: "trim", icon: <Ruler size={15} />, label: "Trim", title: "Adjust the in/out source range" },
  { id: "transform", icon: <Frame size={15} />, label: "Transform", title: "Scale, rotate and flip" },
  { id: "crop", icon: <Crop size={15} />, label: "Crop", title: "Re-frame the shot" },
  { id: "retime", icon: <Gauge size={15} />, label: "Retime", title: "Speed, reverse and freeze" },
  { id: "slice", icon: <Slice size={15} />, label: "Slice", title: "Split the clip into equal segments" },
];

/** What an AUDIO clip is offered. The three that are missing are not hidden
 *  for tidiness: transform and crop are picture-only, and `retime` writes a
 *  speed op that the audio mixing path in worker/handlers/render.py does not
 *  read — a control that cannot reach the render is worse than no control. */
const AUDIO_TOOLS = new Set<EffectTool>(["cut", "trim", "slice"]);

type TransformOp = Extract<ClipOp, { op: "transform" }>;
type CropOp = Extract<ClipOp, { op: "crop" }>;
type SpeedOp = Extract<ClipOp, { op: "speed" }>;
type FlipOp = Extract<ClipOp, { op: "flip" }>;

const isTf = (o: ClipOp): o is TransformOp => o.op === "transform";
const isCrop = (o: ClipOp): o is CropOp => o.op === "crop";
const isFlip = (o: ClipOp): o is FlipOp => o.op === "flip";

const fitAspect = (sw: number, sh: number, aspect: number) => {
  let w = sw, h = sh;
  if (sw / sh > aspect) w = Math.round(sh * aspect);
  else h = Math.round(sw / aspect);
  return { x: Math.round((sw - w) / 2), y: Math.round((sh - h) / 2), w, h };
};

const CROP_PRESETS: { label: string; rect: (w: number, h: number) => { x: number; y: number; w: number; h: number } | null }[] = [
  { label: "None", rect: () => null },
  { label: "16:9", rect: (w, h) => fitAspect(w, h, 16 / 9) },
  { label: "4:3", rect: (w, h) => fitAspect(w, h, 4 / 3) },
  { label: "1:1", rect: (w, h) => fitAspect(w, h, 1) },
  { label: "9:16", rect: (w, h) => fitAspect(w, h, 9 / 16) },
  { label: "80%", rect: (w, h) => ({ x: Math.round(w * 0.1), y: Math.round(h * 0.1), w: Math.round(w * 0.8), h: Math.round(h * 0.8) }) },
];

const RETIME_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

/** Small numeric field committed on blur / Enter. */
function NumField({ label, value, step, min, max, suffix, onCommit }: {
  label: string; value: number; step: number; min: number; max: number;
  suffix?: string; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    setDraft(null);
  }, [value]);
  return (
    <label className="ws-fxnum">
      <span>{label}</span>
      <input
        type="number" step={step} min={min} max={max}
        value={draft ?? Number(value.toFixed(2))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) { onCommit(parseFloat(draft) || 0); setDraft(null); }
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span className="u">{suffix}</span>}
    </label>
  );
}

/* ── post process ────────────────────────────────────────────────────────── */

/** Which finishing passes this clip gets when the timeline is rendered.
 *
 *  Two options, because a clip has exactly two things it can say: follow the
 *  project (the default, and `clips.post === null`) or decide for itself. The
 *  rows render in BOTH modes — read-only while inheriting — since "inherit" is
 *  not an answer to "what happens to this shot", and the whole reason this is a
 *  picker rather than five loose switches is that the answer now comes from two
 *  possible places.
 *
 *  Switching mode is deliberately non-destructive: going to Custom seeds the
 *  clip's chain from whatever was resolving a moment ago, so the picker changes
 *  where the decision lives and never what will render. */
function PostSection({ clip, projectChain, onChange }: {
  clip: Clip;
  projectChain: PostChain;
  onChange: (post: PostChain | null) => void;
}) {
  const { mode, chain } = resolvePost(clip.post, projectChain);
  const inherit = mode === "inherit";
  const ops = activeOps(chain);

  return (
    <div>
      <div className="ws-insp-sec"><span>Post process</span></div>

      <Dropdown width={248} align="left"
        trigger={({ open, toggle }) => (
          <button type="button" className={`ws-model-select-btn ${open ? "open" : ""}`}
                  onClick={toggle}
                  title={inherit
                    ? "Following this project's post-processing defaults"
                    : "This clip overrides the project's defaults"}>
            <span className="ws-model-select-title">
              {inherit ? "Inherit project settings" : "Custom"}
              <span className="mono" style={{ color: ops.length ? "#8fc2ff" : "#5e6678", marginLeft: 6, fontSize: 10.5 }}>
                · {describeChain(chain)}
              </span>
            </span>
            <ChevronDown size={13} style={{
              flex: "none", color: "#5e6678",
              transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease",
            }} />
          </button>
        )}>
        {(close) => (
          <>
            <div className="ws-menu-label">Post process</div>
            <button type="button" className={`ws-menu-row ${inherit ? "on" : ""}`}
                    onClick={() => { close(); onChange(null); }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: inherit ? 600 : 400 }}>
                  Inherit project settings
                </span>
                <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678", marginTop: 1 }}>
                  {describeChain(projectChain)}
                </span>
              </span>
              {inherit && <Check size={12} style={{ color: "#5aa2ff", flex: "none", marginLeft: 6 }} />}
            </button>
            <button type="button" className={`ws-menu-row ${!inherit ? "on" : ""}`}
                    onClick={() => { close(); onChange({ ...chain }); }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: !inherit ? 600 : 400 }}>
                  Custom
                </span>
                <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678", marginTop: 1 }}>
                  pick the passes for this clip
                </span>
              </span>
              {!inherit && <Check size={12} style={{ color: "#5aa2ff", flex: "none", marginLeft: 6 }} />}
            </button>
          </>
        )}
      </Dropdown>

      <div style={{ marginTop: 10 }}>
        <PostChainToggles chain={chain} readOnly={inherit}
                          onChange={(next) => onChange(next)} />
      </div>

      <div className="ws-inline-note" style={{ marginTop: 9 }}>
        {inherit
          ? "Set on the project — Project settings in the left rail. Change it there and every inheriting clip follows."
          : "This clip only. Nothing runs now: the chain is applied when you render the timeline."}
      </div>
    </div>
  );
}

/** A live playhead readout, isolated so the 10Hz tick re-renders only this
 *  leaf. Subscribing at the rail level — even 100ms-quantised — re-rendered
 *  the whole ~900-line rail (toolbar, takes <video> thumbs, the FX rack) ten
 *  times a second for the length of every playback, for the benefit of a
 *  couple of mono spans that are usually not even on screen. The 100ms
 *  quantisation keeps the leaf's own set bailing out between steps; ACTIONS
 *  still read the exact clock at click time (nowMs()), never this. */
function PlayheadReadout({ render }: { render: (playheadMs: number) => React.ReactNode }) {
  const [ms, setMs] = useState(() => Math.round(usePlaybackStore.getState().nowMs()));
  useEffect(() => usePlaybackStore.getState().onTick((t) => {
    const q = Math.round(t / 100) * 100;
    setMs((p) => (p === q ? p : q));
  }), []);
  return <>{render(ms)}</>;
}

export default function InspectorRail({ clip, track, projectId }: {
  clip: Clip | null;
  /** A LANE's rack, when a lane is what is selected. Mutually exclusive with
   *  `clip` — the store keeps the two selections apart. */
  track?: Track | null;
  projectId?: string;
}) {
  const ws = useWorkspaceStore();
  const tlStore = useTimelineStore();
  const [tab, setTab] = useState<"inspector" | "takes" | "history">("inspector");
  const [railUploading, setRailUploading] = useState(false);
  const railUploadRef = useRef<HTMLInputElement>(null);
  const [effect, setEffect] = useState<EffectTool | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [customRetime, setCustomRetime] = useState<boolean | null>(null);

  useEffect(() => {
    setCustomRetime(null);
  }, [clip?.id]);
  // The live playhead readouts live in <PlayheadReadout> leaves now: state at
  // this level — even quantised to 100ms — re-rendered this entire rail (the
  // effects toolbar, the takes tab's <video> thumbs, AudioFxPanel) ten times a
  // second for the whole of every playback, to keep two mono spans current.

  const handleRailUpload = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("video/") || f.type.startsWith("image/"));
    if (!list.length || !clip?.block_id) return;
    setRailUploading(true);
    try {
      for (const file of list) {
        await uploadAndAddTake({
          blockId: clip.block_id,
          file,
          clipId: clip.id,
          activate: true,
        });
      }
      reload();
    } catch (err) {
      console.error("Upload take failed", err);
    } finally {
      setRailUploading(false);
      if (railUploadRef.current) railUploadRef.current.value = "";
    }
  };

  const { data, reload } = useLiveQuery(
    async () => {
      if (!clip?.block_id) return null;
      const [{ data: block }, { data: takes }] = await Promise.all([
        supabase.from("generation_blocks").select("*").eq("id", clip.block_id).single(),
        supabase.from("block_takes").select("*").eq("block_id", clip.block_id).order("created_at"),
      ]);
      if (!block) return null;
      const b = block as GenerationBlock;
      // No downstream-stale count any more: the bar it fed handed the whole
      // fan-out to the director as a typed sentence, and the review popup on
      // the dock now shows those blocks with their shots and a checkbox each.
      // Dropping it also drops a query from every clip selection.
      const [{ data: jobs }, { data: assets }] = await Promise.all([
        supabase.from("jobs").select("*")
          .or(`payload->>block_id.eq.${b.id},payload->>clip_id.eq.${clip.id},payload->>asset_id.eq.${clip.asset_id}`)
          .order("created_at", { ascending: false }).limit(30),
        (takes ?? []).length
          ? supabase.from("assets").select("*").in("id", (takes ?? []).map((t) => t.asset_id))
          : Promise.resolve({ data: [] as Asset[] }),
      ]);
      return {
        block: b,
        takes: (takes ?? []) as BlockTake[],
        jobs: (jobs ?? []) as Job[],
        assets: new Map(((assets ?? []) as Asset[]).map((a) => [a.id, a])),
      };
    },
    ["generation_blocks", "block_takes", "jobs"], [clip?.block_id, clip?.id]
  );

  // Separate from the block query above, which returns null for a clip with no
  // block: the post chain applies to every clip on the timeline, block-backed
  // or dragged in from the library.
  const { data: projectPost } = useLiveQuery(
    async () => {
      if (!projectId) return {} as PostChain;
      const { data: row } = await supabase.from("projects").select("settings").eq("id", projectId).single();
      return resolveDefaults((row?.settings ?? null) as ProjectSettings | null).post;
    },
    ["projects"], [projectId]
  );

  const ops = useMemo(() => clip?.ops ?? [], [clip?.ops]);

  if (!clip && track) {
    // The lane rack, and deliberately nothing else. Everything else this rail
    // shows is about one piece of media — takes, ops, block info, the post
    // chain — and a lane is not one. Its level, mute and solo already live in
    // the lane header, where they are next to the waveform they act on.
    return (
      <aside className="ws-insp ns-l2 ns-scroll">
        <div className="ws-insp-tabs">
          <button className="on">{track.name || "Lane"}</button>
          <span style={{ flex: 1 }} />
          <button className="ws-icobtn" style={{ width: 26, height: 26 }} title="Close"
                  onClick={() => tlStore.selectTrack(null)}>
            <X size={14} />
          </button>
        </div>
        <div style={{ padding: "12px 15px 18px", display: "flex", flexDirection: "column", gap: 18 }}>
          <AudioFxPanel target={{ kind: "track", track }} />
        </div>
      </aside>
    );
  }

  if (!clip) {
    return (
      <aside className="ws-insp ns-l2 ns-scroll">
        <div className="ws-insp-tabs">
          <button className="on">Inspector</button>
        </div>
        <div className="ws-empty" style={{ margin: 12 }}>
          Nothing selected. Click a clip on the timeline — or drag across empty
          lane to rubber-band several at once.
        </div>
      </aside>
    );
  }

  const block = data?.block;
  const asset = tlStore.assets.get(clip.asset_id);
  const isAudio = tlStore.tracks.find((t) => t.id === clip.track_id)?.kind === "audio";
  const tools = isAudio ? TOOLS.filter((t) => AUDIO_TOOLS.has(t.id)) : TOOLS;
  const refs = asArray<RefSlot>(block?.ref_plan);
  const refImgs = refs.filter((r) => (r.purpose ?? "").includes("audio") === false && (r.purpose ?? "") !== "video").length;
  const refAud = block?.audio_mode === "locked" ? 1 : 0;

  /* ── effect helpers: each writes a real ClipOp (or edits clip geometry) ── */
  const applyOp = (kind: ClipOp["op"], op: ClipOp | null, opts: { drag?: boolean } = {}) => {
    const rest = (clip.ops ?? []).filter((o) => o.op !== kind);
    // `drag` marks a slider: those fire per step of the gesture and have no
    // release to hang a bracket off, so one sweep coalesces into one undo.
    tlStore.patchClip(clip.id, { ops: op ? [...rest, op] : rest },
                      opts.drag ? { coalesceKey: `op:${kind}:${clip.id}` } : {});
  };

  const tf = ops.find(isTf);
  const crop = ops.find(isCrop);
  const speed = ops.find((o): o is SpeedOp => o.op === "speed");
  const rate = clipRate(clip);
  const isPresetRate = (RETIME_PRESETS as readonly number[]).includes(speed?.rate ?? 1);
  const showCustomRetime = customRetime ?? !isPresetRate;
  const isCustomRetimeActive = showCustomRetime || !isPresetRate;
  /** What the media can still fill at the CURRENT rate — the ceiling the trim
   *  fields clamp to and the number the retime hint reports against. */
  const capMs = maxClipMs(clip, asset, rate);
  const reversed = ops.some((o) => o.op === "reverse");
  const frozen = ops.some((o) => o.op === "freeze");

  /** The playhead inside this clip at THIS instant — for the actions, which
   *  must not inherit the readout leaf's 100ms quantisation. */
  const relNow = () => {
    const at = usePlaybackStore.getState().nowMs() - clip.t_start_ms;
    return Math.max(0, Math.min(at, clip.duration_ms));
  };
  // The picker and the preview must agree about the media a rect is measured
  // against, or the stage draws a window the render does not cut — so the
  // fallback for an asset with no recorded dimensions is imported, not
  // repeated here.
  const { w: srcW, h: srcH } = sourceBox(asset);
  const cropActive = CROP_PRESETS.findIndex((p) => {
    if (!crop) return p.rect(srcW, srcH) === null;
    const r = p.rect(srcW, srcH);
    return !!r && Math.abs(r.x - crop.x) <= 2 && Math.abs(r.y - crop.y) <= 2
      && Math.abs(r.w - crop.w) <= 2 && Math.abs(r.h - crop.h) <= 2;
  });

  const cut = async () => {
    const at = usePlaybackStore.getState().nowMs();
    // The store's own guard, so the button cannot look live at a position
    // `splitAt` will refuse. WHERE the blade lands in the source is
    // splitGeometry's — it carries the rate, which is what a retimed clip's
    // right half used to open without.
    if (at <= clip.t_start_ms + SPLIT_EDGE_MS
        || at >= clip.t_start_ms + clip.duration_ms - SPLIT_EDGE_MS) return;
    await tlStore.splitAt(clip.id, at);
  };

  const sliceInto = async (n: number) => {
    const seg = clip.duration_ms / n;
    let left = clip.id;
    for (let k = 1; k < n; k++) {
      const at = clip.t_start_ms + seg * k;
      await useTimelineStore.getState().splitAt(left, at);
      const next = useTimelineStore.getState().clips.find(
        (c) => c.track_id === clip.track_id && c.id !== left && Math.abs(c.t_start_ms - at) < 2
      );
      if (!next) return;
      left = next.id;
    }
  };

  /* Both trim fields are in SOURCE ms — that is what an in/out point is — and
     the lane is in TIMELINE ms, so every conversion between them carries the
     rate. At 2x, moving the out-point a second later widens the clip by half
     a second; writing the source delta straight onto `duration_ms` is how a
     retimed clip drifts off its own media again the first time it is trimmed. */
  const trimIn = (ms: number) => {
    const inMs = Math.max(0, Math.min(Math.round(ms),
                                      clip.in_ms + (clip.duration_ms - MIN_CLIP_MS) * rate));
    const shift = (inMs - clip.in_ms) / rate;
    tlStore.patchClip(clip.id, {
      in_ms: inMs,
      t_start_ms: Math.round(clip.t_start_ms + shift),
      duration_ms: Math.round(clip.duration_ms - shift),
    });
  };
  const trimOut = (ms: number) => {
    const srcMax = asset?.duration_ms ?? Infinity;
    const outMs = Math.min(srcMax, Math.max(ms, clip.in_ms + MIN_CLIP_MS * rate));
    tlStore.patchClip(clip.id, {
      out_ms: Math.round(outMs),
      duration_ms: Math.round((outMs - clip.in_ms) / rate),
    });
  };

  /** Speed — and the op alone is only half of it. A clip consumes
   *  `duration_ms * rate` of source, so a 2x that leaves the width where it
   *  was asks for twice the media and plays the back half off the end of the
   *  file. `retimeGeometry` contracts to what is left and never grows; see
   *  there for why the growth half is deliberately refused.
   *
   *  `linked: false` deliberately: a detached audio half renders through the
   *  audio mixing path, which reads no speed op at all (AUDIO_TOOLS says so
   *  from the other side), so its length really is unchanged. Shrinking it
   *  with the picture would draw a lane the render will not produce. */
  const retime = (r: number) => {
    const rest = ops.filter((o) => o.op !== "speed");
    tlStore.patchClip(clip.id, {
      ops: r === 1 ? rest : [...rest, { op: "speed", rate: r }],
      ...retimeGeometry(clip, r, asset),
    }, { linked: false });
  };
  const toggleReverse = () => {
    const rest = ops.filter((o) => o.op !== "reverse");
    tlStore.patchClip(clip.id, { ops: reversed ? rest : [...rest, { op: "reverse" }] });
  };
  const freeze = () => {
    // SOURCE ms, not the playhead's own offset: the renderer cuts the three
    // pieces out of the un-sped source, so on a retimed clip the two differ by
    // the rate. See freezeSourceMs.
    applyOp("freeze", { op: "freeze", at_ms: freezeSourceMs(clip, relNow()), dur_ms: 1000 });
  };

  const toggleFlip = (dir: "h" | "v") => {
    const has = ops.some((o) => isFlip(o) && o.dir === dir);
    const rest = ops.filter((o) => !(isFlip(o) && o.dir === dir));
    tlStore.patchClip(clip.id, { ops: has ? rest : [...rest, { op: "flip", dir }] });
  };

  return (
    <aside className="ws-insp ns-l2 ns-scroll">
      <div className="ws-insp-tabs">
        {(["inspector", "takes", "history"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="ws-icobtn" style={{ width: 26, height: 26 }} title="Hide inspector"
                onClick={() => ws.toggle("inspOpen")}>
          <X size={14} />
        </button>
      </div>

      {/* WHICH of the selected clips this panel is about.
          Everything below is one clip's — its ops, its takes, its gain, its
          post chain — so with five lit on the timeline and nothing said, every
          control here reads as though it applied to all five. The lane marks
          the primary with a brighter ring (`.pri`); this says the number. */}
      {tlStore.selectedClipIds.length > 1 && (
        <div className="ws-selbanner">
          <b>{tlStore.selectedClipIds.length} clips selected</b>
          <span>
            This panel edits “{clip.label ?? "clip"}”. Move, nudge and delete take all of them.
          </span>
        </div>
      )}

      {tab === "inspector" && (
        <div style={{ padding: "12px 15px 18px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* ── effects toolbar ── */}
          <div className="ws-fx">
            <div className="ws-fx-tools">
              {tools.map((t) => (
                <button key={t.id} className={"ws-fx-btn" + (effect === t.id ? " on" : "")}
                        title={t.title} onClick={() => setEffect(effect === t.id ? null : t.id)}>
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>

            {effect && (
              <div className="ws-fx-panel ns-pop" key={effect}>
                {effect === "cut" && (
                  <div className="ws-fx-col">
                    <button className="ws-fx-primary" onClick={() => void cut()}>
                      <Scissors size={13} /> Cut at playhead
                    </button>
                    <span className="mono ws-fx-hint">
                      clip {clip.t_start_ms / 1000 < 10 ? "0" : ""}{(clip.t_start_ms / 1000).toFixed(1)}–{((clip.t_start_ms + clip.duration_ms) / 1000).toFixed(1)}s
                      {" · "}playhead <PlayheadReadout render={(ph) => {
                        const rr = ph - clip.t_start_ms;
                        return rr >= 0 && rr <= clip.duration_ms
                          ? `${(rr / 1000).toFixed(1)}s in` : "outside";
                      }} />
                    </span>
                  </div>
                )}

                {effect === "trim" && (
                  <div className="ws-fx-col">
                    <div style={{ display: "flex", gap: 7 }}>
                      <NumField label="In" value={(clip.in_ms ?? 0) / 1000} step={0.1}
                                min={0}
                                max={(clip.in_ms + (clip.duration_ms - MIN_CLIP_MS) * rate) / 1000} suffix="s"
                                onCommit={(v) => trimIn(v * 1000)} />
                      <NumField label="Out" value={(clip.in_ms + clip.duration_ms * rate) / 1000} step={0.1}
                                min={(clip.in_ms + MIN_CLIP_MS * rate) / 1000}
                                max={(asset?.duration_ms ?? clip.in_ms + clip.duration_ms * rate) / 1000} suffix="s"
                                onCommit={(v) => trimOut(v * 1000)} />
                    </div>
                    {reversed && (
                      /* These two fields set the SOURCE window's ends, which is
                         what they have always meant and what the render reads.
                         On a reversed clip that window plays backwards, so Out
                         is the frame the viewer sees first — said here rather
                         than by relabelling them, because the numbers are
                         source times and renaming them would make the panel
                         disagree with every other surface that quotes one.
                         The lane's own handles are in PLAYBACK order
                         (clipFrames.trimPatch). */
                      <span className="mono ws-fx-hint">
                        reversed — Out is the frame this clip opens on, In the
                        one it ends on
                      </span>
                    )}
                    <button className="ws-fx-rowbtn" onClick={() => trimIn(clip.in_ms + relNow())}>
                      <Ruler size={12} /> Trim in to playhead
                      <span className="mono"><PlayheadReadout render={(ph) =>
                        `${(Math.max(0, Math.min(ph - clip.t_start_ms, clip.duration_ms)) / 1000).toFixed(1)}s`
                      } /></span>
                    </button>
                    <button className="ws-fx-rowbtn" onClick={() => trimOut(clip.in_ms + relNow())}>
                      <Ruler size={12} /> Trim out to playhead
                      <span className="mono"><PlayheadReadout render={(ph) =>
                        `${(Math.max(0, Math.min(ph - clip.t_start_ms, clip.duration_ms)) / 1000).toFixed(1)}s`
                      } /></span>
                    </button>
                  </div>
                )}

                {effect === "transform" && (
                  <div className="ws-fx-col">
                    <label className="ws-fx-slider">
                      <span>Scale</span>
                      <input type="range" min={0.25} max={2} step={0.05}
                             value={tf?.scale ?? 1}
                             onChange={(e) => applyOp("transform", {
                               op: "transform", scale: +e.target.value,
                               rotate: tf?.rotate ?? 0, tx: tf?.tx, ty: tf?.ty,
                             }, { drag: true })} />
                      <b>{((tf?.scale ?? 1) * 100).toFixed(0)}%</b>
                    </label>
                    <label className="ws-fx-slider">
                      <span>Rotate</span>
                      <input type="range" min={-180} max={180} step={1}
                             value={tf?.rotate ?? 0}
                             onChange={(e) => applyOp("transform", {
                               op: "transform", rotate: +e.target.value,
                               scale: tf?.scale ?? 1, tx: tf?.tx, ty: tf?.ty,
                             }, { drag: true })} />
                      <b>{Math.round(tf?.rotate ?? 0)}°</b>
                    </label>
                    <div className="ws-fx-chips">
                      <button className={(ops.some((o) => isFlip(o) && o.dir === "h") ? "on" : "")}
                              onClick={() => toggleFlip("h")}>
                        <FlipHorizontal2 size={12} /> Flip H
                      </button>
                      <button className={(ops.some((o) => isFlip(o) && o.dir === "v") ? "on" : "")}
                              onClick={() => toggleFlip("v")}>
                        <FlipVertical2 size={12} /> Flip V
                      </button>
                    </div>
                    {(tf?.scale && tf.scale !== 1) || tf?.rotate ? (
                      <button className="ws-fx-rowbtn" onClick={() => applyOp("transform", null)}>
                        <RefreshCw size={12} /> Reset transform
                      </button>
                    ) : null}
                  </div>
                )}

                {effect === "crop" && (
                  <div className="ws-fx-col">
                    <div className="ws-fx-chips">
                      {CROP_PRESETS.map((p, i) => (
                        <button key={p.label} className={cropActive === i ? "on" : ""}
                                onClick={() => {
                                  const r = p.rect(srcW, srcH);
                                  applyOp("crop", r ? { op: "crop", ...r } : null);
                                }}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <span className="mono ws-fx-hint">
                      {crop
                        ? `${crop.w}×${crop.h} @ ${crop.x},${crop.y} of ${srcW}×${srcH}`
                        : "Full frame"}
                    </span>
                  </div>
                )}

                {effect === "retime" && (
                  <div className="ws-fx-col">
                    <div className="ws-seg" style={{ flex: 1 }}>
                      {RETIME_PRESETS.map((r) => (
                        <button
                          key={r}
                          className={!isCustomRetimeActive && (speed?.rate ?? 1) === r ? "on" : ""}
                          onClick={() => {
                            setCustomRetime(false);
                            retime(r);
                          }}
                        >
                          {r === 0.25 ? "¼" : r === 0.5 ? "½" : r === 1 ? "1×" : `${r}×`}
                        </button>
                      ))}
                      <button
                        className={isCustomRetimeActive ? "on" : ""}
                        style={{ flex: "1.2 1 0", fontSize: 11 }}
                        onClick={() => setCustomRetime((prev) => !(prev ?? !isPresetRate))}
                        title="Custom retime multiplier"
                      >
                        Custom
                      </button>
                    </div>
                    {showCustomRetime && (
                      <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                        <NumField
                          label="Custom"
                          value={rate}
                          step={0.05}
                          min={0.05}
                          max={16}
                          suffix="×"
                          onCommit={(v) => {
                            if (!Number.isFinite(v) || v <= 0) return;
                            const clamped = Math.max(0.05, Math.min(16, Math.round(v * 100) / 100));
                            retime(clamped);
                          }}
                        />
                      </div>
                    )}
                    <div className="ws-fx-chips">
                      <button className={reversed ? "on" : ""} onClick={toggleReverse}>
                        <Rewind size={12} /> Reverse
                      </button>
                      <button className={frozen ? "on" : ""} onClick={freeze}>
                        <Snowflake size={12} /> Freeze 1s
                      </button>
                    </div>
                    {/* The old readout quoted `duration_ms / rate` as "s
                        timeline" — a length nothing wrote, so it described a
                        clip the lane never showed. These two numbers are the
                        row as it stands: how long it runs, and how much source
                        that eats. */}
                    <span className="mono ws-fx-hint">
                      {`${rate.toFixed(2)}× · ${(clip.duration_ms / 1000).toFixed(1)}s timeline`}
                      {` · ${((clip.duration_ms * rate) / 1000).toFixed(1)}s source`}
                      {reversed ? " · reversed" : ""}{frozen ? " · frozen" : ""}
                    </span>
                    {reversed && (
                      /* The stage SCRUBS a reversed clip rather than playing
                         it — no browser implements a negative playbackRate —
                         so it is silent and only as smooth as the codec
                         allows. Said here because the alternative is a
                         preview that looks like it is failing. */
                      <span className="mono ws-fx-hint">
                        reversed clips are scrubbed in the preview — silent, and
                        smooth only in the render
                      </span>
                    )}
                    {Number.isFinite(capMs) && clip.duration_ms >= capMs - 1 && (
                      <span className="mono ws-fx-hint">
                        at the end of the media — a faster rate shortens the clip
                      </span>
                    )}
                  </div>
                )}

                {effect === "slice" && (
                  <div className="ws-fx-col">
                    <div className="ws-fx-chips" style={{ justifyContent: "stretch" }}>
                      {[2, 3, 4].map((n) => (
                        <button key={n} style={{ flex: 1 }} onClick={() => void sliceInto(n)}>
                          {n} <span className="mono">parts</span>
                        </button>
                      ))}
                    </div>
                    <span className="mono ws-fx-hint">
                      {(clip.duration_ms / 1000).toFixed(1)}s clip → equal, back-to-back segments
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── audio effects (audio lanes only) ──
              A clip on a video lane gets nothing here: its sound is baked into
              the picture, and the way to shape it is "detach audio", which
              gives it a lane — and this panel — of its own. */}
          {isAudio && <AudioFxPanel target={{ kind: "clip", clip }} />}

          {/* ── block info (minimized: a one-liner until expanded) ── */}
          <div className="ws-info">
            <button className="ws-info-head" onClick={() => setInfoOpen((o) => !o)}>
              <span className="ws-insp-sec" style={{ marginBottom: 0 }}>
                <span>Block info</span>
                {block && (() => {
                  // `displayBlockStatus`, so a block whose PLAN moved on still
                  // reads as the kept take it is — the inspector describes the
                  // clip in front of you. Stale is the storyboard's and the
                  // director banner's to report (lib/staleBlocks).
                  const st = displayBlockStatus(block.status, !!block.active_take_id);
                  return (
                    <span className="mono chip" style={{ color: ST[st] ?? "#8b93a7",
                                                         borderColor: `${ST[st] ?? "#5b6478"}55`,
                                                         background: `${ST[st] ?? "#5b6478"}1f` }}>
                      {st === "generated" ? "kept" : st}
                    </span>
                  );
                })()}
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono ws-info-sum">
                {block
                  ? `${block.idx + 1} · ${block.mode}${block.chain_from_block_id ? "·chained" : ""} · ${(clip.duration_ms / 1000).toFixed(1)}s`
                  : `${(clip.duration_ms / 1000).toFixed(1)}s clip`}
              </span>
              {infoOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>

            {infoOpen && (
              <div className="ws-info-body">
                <Row k={block ? blockLabel(blockKind(block), block.idx) : "Clip"}>
                  <span style={{ color: "#eaeef6" }}>{clip.label ?? asset?.b2_key.split("/").pop()}</span>
                </Row>
                <Row k="Time">
                  {fmtClock(clip.t_start_ms)} – {fmtClock(clip.t_start_ms + clip.duration_ms)}
                  {" "}({(clip.duration_ms / 1000).toFixed(1)}s)
                </Row>
                {block && (
                  <>
                    <Row k="Mode">
                      {block.mode}{block.chain_from_block_id ? " (chained)" : ""}
                    </Row>
                    {!!block.frames && <Row k="Frames">{block.frames} rendered (17n+5)</Row>}
                    {block.trim && (
                      <Row k="Trim">{block.trim.warmup_f}f warmup · {block.trim.cooldown_f}f cooldown</Row>
                    )}
                    <Row k="Audio">
                      {block.audio_mode === "locked" && block.audio_slice
                        ? `Locked (slice ${(block.audio_slice.offset_ms / 1000).toFixed(1)}s – ${((block.audio_slice.offset_ms + block.audio_slice.duration_ms) / 1000).toFixed(1)}s)`
                        : "Native (H3)"}
                    </Row>
                    <Row k="Refs">{refImgs} images · {refAud} audio</Row>
                    {block.seed != null && <Row k="Seed">{block.seed}</Row>}
                  </>
                )}
                {asset && <Row k="Source">{asset.width}×{asset.height}{asset.fps ? ` · ${asset.fps}fps` : ""}</Row>}
              </div>
            )}
          </div>

          {block && (
            <div>
              <div className="ws-insp-sec"><span>Actions</span></div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="ws-actbtn" onClick={() => ws.openModal({ kind: "prompt", blockId: block.id })}>
                  <RefreshCw size={12} />Retake
                </button>
                <button className="ws-actbtn" title="Bracket a range and regenerate just that span"
                        onClick={() => enqueueJob({
                          kind: "patch_flf", lane: "gpu", priority: 10,
                          payload: { block_id: block.id, take_id: block.active_take_id,
                                     in_ms: 0, out_ms: Math.min(4000, clip.duration_ms) },
                        }).then(() => reload())}
                        disabled={!block.active_take_id}>
                  <Scissors size={12} />FLF Patch
                </button>
                <button className="ws-actbtn" onClick={() => ws.openModal({ kind: "prompt", blockId: block.id })}>
                  <Wand2 size={12} />Edit with Prompt
                </button>
              </div>
            </div>
          )}

          {/* Video only: every pass in the chain is a picture pass, and
              tl_render applies it to the video track. Offered on an audio clip
              it would be a control that writes a value nothing ever reads. */}
          {!isAudio && (
            <PostSection clip={clip} projectChain={projectPost ?? {}}
                         onChange={(post) => tlStore.patchClip(clip.id, { post })} />
          )}

          <div>
            <div className="ws-insp-sec"><span>Clip settings</span></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div className="ws-inforow">
                <span className="k">Label</span>
                <input className="ws-input" defaultValue={clip.label ?? ""} key={clip.id}
                       style={{ height: 30, fontSize: 12.5, flex: 1, minWidth: 0 }}
                       onBlur={(e) => e.target.value !== (clip.label ?? "") &&
                         tlStore.patchClip(clip.id, { label: e.target.value })} />
              </div>
              <div style={{ display: "flex", gap: 9 }}>
                <div className="ws-inforow" style={{ flex: 1 }}>
                  <span className="k">In</span><span className="v">{(clip.in_ms / 1000).toFixed(1)}s</span>
                </div>
                <div className="ws-inforow" style={{ flex: 1 }}>
                  <span className="k">Out</span>
                  <span className="v">{((clip.out_ms ?? clip.duration_ms) / 1000).toFixed(1)}s</span>
                </div>
              </div>
              <div className="ws-inforow">
                <span className="k">Gain</span>
                <input type="range" min={-24} max={12} step={0.5} value={clip.gain_db ?? 0}
                       style={{ flex: 1 }}
                       onChange={(e) => tlStore.patchClip(clip.id, { gain_db: +e.target.value },
                                                          { coalesceKey: `gain:${clip.id}` })} />
                <span className="v" style={{ width: 54, textAlign: "right" }}>
                  {(clip.gain_db ?? 0).toFixed(1)} dB
                </span>
              </div>
              {!!ops.length && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {ops.map((o, i) => (
                    <button key={i} className="ws-pill" title="Remove"
                            onClick={() => tlStore.removeOp(clip.id, i)}>
                      {o.op}<X size={10} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "takes" && (
        <div style={{ padding: "12px 15px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
          {(data?.takes ?? []).map((t, i) => {
            const a = data?.assets.get(t.asset_id);
            const active = t.id === block?.active_take_id;
            return (
              <div key={t.id} className={"ws-takerow" + (active ? " on" : "")}>
                <span className="th">
                  {a && <video src={assetUrl(a) ?? undefined} muted preload="metadata"
                               onLoadedMetadata={(e) => {
                                 const v = e.currentTarget;
                                 if (v.duration) v.currentTime = v.duration * 0.35;
                               }} />}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>Take {i + 1}</span>
                  <span className="mono" style={{ display: "block", fontSize: 10.5, color: "#5e6678" }}>
                    {t.kind} · {t.state}{a?.duration_ms ? ` · ${(a.duration_ms / 1000).toFixed(1)}s` : ""}
                  </span>
                </span>
                {!active && (
                  <button className="ws-microbtn" style={{ padding: "0 9px" }}
                          onClick={async () => {
                            await supabase.from("block_takes").update({ state: "kept" }).eq("id", t.id);
                            await supabase.from("generation_blocks")
                              .update({ active_take_id: t.id, status: "generated" }).eq("id", block!.id);
                            tlStore.patchClip(clip.id, { asset_id: t.asset_id });
                            reload();
                          }}>use</button>
                )}
                {active && <Check size={14} style={{ color: "#6fd08c" }} />}
              </div>
            );
          })}
          {!data?.takes.length && <div className="ws-empty">No takes yet.</div>}
          {!!block && (
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button className="ws-primary" style={{ flex: 1, justifyContent: "center", height: 28, fontSize: 12 }}
                      onClick={() => ws.openModal({ kind: "takes", blockId: block.id })}>
                Compare
              </button>
              <button className="ws-ghost" style={{ flex: 1, justifyContent: "center", height: 28, fontSize: 12 }}
                      onClick={() => ws.openModal({ kind: "pickTake", blockId: block.id, clipId: clip?.id })}>
                <FolderOpen size={12} /> Library
              </button>
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div style={{ padding: "12px 15px 18px", display: "flex", flexDirection: "column", gap: 7 }}>
          {(data?.jobs ?? []).map((j) => (
            <div key={j.id} className="ws-histrow">
              <span style={{ color: j.status === "error" ? "#ff8080" : j.status === "done" ? "#6fd08c" : "#e8c268" }}>
                {j.status === "done" ? <Check size={12} />
                  : j.status === "error" ? <X size={12} />
                  : <Clock size={12} />}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>{j.kind}</span>
                <span className="mono" style={{ display: "block", fontSize: 10.5, color: "#5e6678" }}>
                  {new Date(j.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {j.model_id ? ` · ${j.model_id}` : ""}
                </span>
              </span>

            </div>
          ))}
          {!data?.jobs.length && <div className="ws-empty">No jobs touched this clip yet.</div>}
        </div>
      )}
    </aside>
  );
}

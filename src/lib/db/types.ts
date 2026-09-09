// v2 row types — mirror supabase/migrations/*. Durations are milliseconds.

import type { PostChain } from "../postChain";

export type Medium = "film" | "series" | "music_video";
/** `local` is the desktop app's own lane: the pod claims by lane and its
 *  WORKER_LANES never includes it, so a render meant for the user's machine
 *  cannot be picked up by the $3.36/hr box. See the 20260817120000 migration. */
export type JobLane = "gpu" | "cpu" | "api" | "llm" | "local";
export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";
export type BlockStatus = "planned" | "queued" | "generating" | "generated" | "failed" | "stale";
export type TakeState = "pending" | "kept" | "rejected";

export interface Project {
  id: string;
  owner_id: string | null;
  medium: Medium;
  title: string;
  logline: string | null;
  genre: string[];
  style: string | null;
  aspect: string;
  size_id: string;
  fps: number;
  status: string;
  director_persona: Record<string, unknown> | null;
  settings: Record<string, unknown>;
  cover_asset_id: string | null;
  v1_series_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Episode {
  id: string;
  project_id: string | null;
  series_id?: string | null; // v1 leftover
  idx: number;
  code: string;
  title: string | null;
  synopsis: string | null;
  status: string;
  created_at: string;
}

export type AssetKind = "image" | "video" | "audio" | "frame" | "render" | "file";

/** A cloned voice: one reference recording, a provider, and whatever that
 *  provider calls the voice it made from it.
 *
 *  `reference_id` is null on the zero-shot provider and that is correct, not
 *  pending — s2-pro has nothing to register, the clip IS the voice. `status`
 *  is what says whether a HOSTED registration has come back. */
export interface VoiceClone {
  id: string;
  owner_id: string | null;
  project_id: string | null;
  name: string;
  /** Every value `voice_clones_provider_check` allows, which this had drifted
   *  from twice: it never learned about `elevenlabs` (added 2026-08-16) and a
   *  Breeze clone could not be written at all. `AudioVoiceStudio` casts
   *  through this type, so a value missing here is a clone the UI cannot
   *  create even once the database allows it. */
  provider: "fish" | "fish-local" | "elevenlabs" | "breeze";
  reference_id: string | null;
  sample_asset_id: string | null;
  sample_text: string | null;
  status: "pending" | "ready" | "error";
  error_msg: string | null;
  meta: Record<string, unknown> & { duration_ms?: number; warning?: string };
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  project_id: string | null;
  kind: AssetKind;
  b2_key: string;
  content_type: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  fps: number | null;
  origin: "generated" | "uploaded" | "derived";
  source_job_id: string | null;
  meta: Record<string, unknown> & { peaks?: number[]; prompt?: string };
  tags: string[];
  created_at: string;
  /** In the recycle bin since. The row (and the B2 object) still exist — see
   *  the collections/bin migration for why the bin can't be a row delete. */
  deleted_at?: string | null;
  /** Filed in at least one hidden collection. Denormalised and trigger-kept:
   *  it is what every browse filters on. Concealment, not access control. */
  hidden?: boolean;
}

/** A user-made grouping of library assets. Membership only — the asset itself
 *  lives once, in `assets`. */
export interface Collection {
  id: string;
  project_id: string | null;
  name: string;
  color: string | null;
  /** Incognito: everything filed here leaves the library, the pickers and the
   *  director's asset search, and is visible only inside this collection. */
  hidden: boolean;
  idx: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionAsset {
  collection_id: string;
  asset_id: string;
  idx: number;
  added_at: string;
}

export type BibleKind = "character" | "environment" | "prop" | "style" | "lore";

export interface BibleEntry {
  id: string;
  project_id: string;
  kind: BibleKind;
  name: string;
  summary: string | null;
  doc: Record<string, unknown>;
  identity_line: string | null;
  voice_ref_asset_id: string | null;
  status: "draft" | "confirmed";
  version: number;
  created_at: string;
  updated_at: string;
}

export interface BibleAsset {
  entry_id: string;
  asset_id: string;
  // Mirrors bible_assets_role_check (migration 20260811150000). The type had
  // stopped at the v2-core vocabulary, so the four location roles and the
  // character turnaround — all of them written by the worker and rendered by
  // the sheet — were not assignable in TypeScript.
  role: "ref" | "face" | "full_body" | "side" | "outfit" | "turnaround"
      | "master" | "alt_angle" | "detail" | "atmosphere"
      // The location's contact sheet (migration 20260906120000) — the
      // `turnaround`'s twin one kind over, and like it produced only by an
      // `orbit_sheet` take rather than by any single render.
      | "coverage";
  slot: number;
}

export interface Storyboard {
  id: string;
  episode_id: string;
  /** Monotonic per episode. A re-plan inserts max+1 and nothing is deleted, so
   *  every earlier plan keeps its own scenes, beats and blocks. */
  version: number;
  status: "draft" | "review" | "approved" | "rendering" | "complete";
  audio_asset_id: string | null;
  audio_meta: {
    bpm?: number;
    beats_ms?: number[];
    lyrics?: { t0: number; t1: number; text: string; singer?: string }[];
    sections?: { t0: number; t1: number; label: string }[];
  };
  brief: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Scene {
  id: string;
  storyboard_id: string;
  idx: number;
  slug: string | null;
  duration_ms: number;
  environment_id: string | null;
  cast_ids: string[];
  scene_prompt: string | null;
  still_asset_id: string | null;
  status: "draft" | "approved" | "locked" | "generating" | "generated";
  meta: Record<string, unknown>;
}

export interface Beat {
  id: string;
  scene_id: string;
  idx: number;
  duration_ms: number;
  camera: string | null;
  action: string;
  dialogue: { speaker_id: string; speaker?: string; line: string; delivery?: string;
              /** the DP's V.O. cutaway: the line plays while the camera is
               *  elsewhere, and its speaker is deliberately out of the shot */
              offscreen?: boolean }[] | null;
  sfx: string | null;
  meta: Record<string, unknown>;
}

export interface AudioRefSlot {
  slot: number;
  kind: "line" | "exchange" | "voice";
  asset_id?: string;
  /** line: the speaker; voice: whose timbre */
  name?: string;
  text?: string;
  shot_idx?: number;
  order?: number;
  at_ms?: number;
  /** exchange only */
  lines?: { speaker: string; line: string; shot_idx: number; order: number; at_ms?: number }[];
  start?: { shot_idx: number; at_ms: number };
}

export interface RefSlot {
  slot: number;
  label: string;
  purpose: string;
  asset_id: string | "prev_last_frame";
}

export interface GenerationBlock {
  id: string;
  storyboard_id: string;
  idx: number;
  scene_ids: string[];
  beat_ids: string[];
  t_start_ms: number;
  t_end_ms: number;
  frames: number;
  trim: { warmup_f: number; cooldown_f: number; out_ms: number };
  mode: "r2v" | "flf" | "i2v" | "t2v";
  compiled_prompt: { description: string; soundscape: string; music: string; fmt_version: number } | null;
  ref_plan: RefSlot[];
  /** Staged dialogue truth, written by the worker at master-pass time:
   *  which clips were placed, whose lines, measured offsets. */
  audio_refs: AudioRefSlot[] | null;
  audio_mode: "native" | "locked";
  audio_slice: { asset_id: string; offset_ms: number; duration_ms: number } | null;
  chain_from_block_id: string | null;
  status: BlockStatus;
  active_take_id: string | null;
  seed: number | null;
  params: Record<string, unknown>;
  updated_at: string;
}

export interface BlockTake {
  id: string;
  block_id: string;
  job_id: string | null;
  asset_id: string;
  /** How the take was made. "audio" is the one whose PICTURE is unchanged:
   *  `v2a_gen` re-scores an existing take and muxes the new sound on with
   *  `-c:v copy`, so the frames are bit-identical to the take it came from —
   *  which is also why it marks nothing downstream stale. */
  kind: "master" | "patch" | "spliced" | "edit" | "audio";
  patch_range: { in_ms: number; out_ms: number } | null;
  state: TakeState;
  created_at: string;
}

export interface Timeline {
  id: string;
  episode_id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  render_asset_id: string | null;
  render_stale: boolean;
  /** Blocks this cut deliberately leaves out — the editor removed their last
   *  clip. `syncBlocksToTimeline` re-adds any block that has a kept take and
   *  no clip, so without this record a deleted block came back on the next
   *  take, re-render or page load. Cleared again the moment a clip for the
   *  block is back on the timeline. */
  excluded_block_ids?: string[];
  /** Which of the storyboard's own audio assets `syncMasterTrack` has already
   *  placed on this cut — see the doc comment on that function. Present so a
   *  blank cut or a duplicate can be told the track is accounted for without
   *  a clip existing yet, the same way `excluded_block_ids` covers a block. */
  placed_audio_asset_ids?: string[];
}

export interface Track {
  id: string;
  timeline_id: string;
  kind: "video" | "audio";
  idx: number;
  name: string | null;
  muted: boolean;
  /** Solo reads across the whole timeline: any solo silences every lane that
   *  isn't soloed, video lanes' baked audio included. See src/lib/mix.ts. */
  solo: boolean;
  locked: boolean;
  gain_db: number;
  /** Volume automation in timeline time. Replaces `gain_db` when non-empty. */
  automation: { t_ms: number; gain_db: number }[];
  /** The LANE's effect chain — an insert every clip on it passes through, in
   *  the same shape and from the same catalog as `Clip.audio_fx`. Composes
   *  with the clip's own chain rather than replacing it: clip inserts first,
   *  then these, then the fader. Read it through `normalizeFx`. */
  audio_fx: Clip["audio_fx"];
  duck_under_track_id: string | null;
}

export type ClipOp =
  | { op: "flip"; dir: "h" | "v" }
  | { op: "transform"; rotate?: number; scale?: number; tx?: number; ty?: number }
  | { op: "crop"; x: number; y: number; w: number; h: number }
  | { op: "speed"; rate: number }
  | { op: "reverse" }
  | { op: "freeze"; at_ms: number; dur_ms: number };

export interface Clip {
  id: string;
  track_id: string;
  asset_id: string;
  block_id: string | null;
  /** The block take this clip DELIBERATELY plays, when that is not the
   *  block's own. Null — every clip until somebody pins one — means follow
   *  `generation_blocks.active_take_id`, which is what `syncBlocksToTimeline`
   *  repoints and how "activate this take" reaches a cut nobody had open.
   *  A record rather than something inferred from `asset_id`: "pinned to take
   *  2" and "has not caught up to take 3 yet" look identical from outside. */
  take_id: string | null;
  t_start_ms: number;
  duration_ms: number;
  in_ms: number;
  out_ms: number | null;
  ops: ClipOp[];
  transition_in: { type: "xfade" | "generated"; dur_ms: number; style?: string; asset_id?: string } | null;
  gain_db: number;
  label: string | null;
  /** The other half of an A/V pair: they move, trim and split together until
   *  unlinked. Written on BOTH rows, so either half finds the other. */
  linked_clip_id: string | null;
  /** This (video) clip's own baked audio is off — it plays from an audio lane
   *  instead. Independent of the link on purpose: unlinking must not bring the
   *  doubled audio back. */
  audio_detached: boolean;
  /** Ordered effect chain, `[{id, params}]` from the catalog in
   *  src/lib/audioFx.ts. Played by Tuna in the preview, by ffmpeg in the
   *  render. Read it through `normalizeFx` — it is jsonb, so it can hold an
   *  older shape. */
  audio_fx: {
    id: string;
    /** Scalars for most effects; the EQ's `bands` is a list of objects. */
    params: Record<string, number | string | unknown[]>;
    enabled?: boolean;
  }[];
  /** Finishing passes for the final render. `null` inherits the project's
   *  chain; an object overrides it, `{}` included. Applied by tl_render — the
   *  toggles never queue anything on their own. See lib/postChain.ts. */
  post: PostChain | null;
  updated_at: string;
}

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  project_id: string | null;
  episode_id: string | null;
  payload: Record<string, unknown>;
  depends_on: string[];
  priority: number;
  lane: JobLane;
  cancel_requested: boolean;
  progress: number;
  progress_note: string | null;
  /** B2 key of the newest in-progress sampler frame, while this job runs.
   *  Overwritten in place, unregistered in `assets` (it is a progress
   *  indicator, not media), and collected by gc_sweep after the fact. */
  preview_key: string | null;
  eta_seconds: number | null;
  model_id: string | null;
  worker_id: string | null;
  attempt: number;
  error_msg: string | null;
  output_asset_id: string | null;
  output_key: string | null; // v1 leftover, still written by v1 handlers
  /** The ComfyUI prompt this row is waiting on. A v1 column, and exactly the
   *  right one for the desktop worker: it is what lets a local render survive
   *  a reload — the app reattaches to the engine instead of losing the sample.
   *  Null for everything the pod runs (the pod holds its own id in memory). */
  comfy_prompt_id: string | null;
  cost_usd: number | null;
  timing: { started_at?: string; finished_at?: string; gpu_s?: number; load_s?: number };
  created_at: string;
  updated_at: string;
}

export interface ModelCatalogRow {
  id: string;
  family: string;
  display_name: string;
  kind: "video" | "image" | "audio" | "llm" | "embed" | "post";
  provider: string;
  modes: string[];
  sizes: { id: string; label: string; maxFrames?: number; dims: Record<string, [number, number]> }[] | null;
  max_seconds: number | null;
  fps: number | null;
  frame_base: number | null;
  frame_rem: number | null;
  dim_step: number | null;
  /** What one unit costs, where anybody is billed for it at all.
   *
   *  OPEN-ENDED because it is a VENDOR'S table, not ours: a per-image row
   *  carries `usd`, a Gemini row carries the per-MTok rates its own arithmetic
   *  is derived from (`text_in`, `image_out`), and a model that runs on this
   *  machine carries a note saying so. Closing it would make the generated
   *  catalogue fail to typecheck every time a provider prices something a new
   *  way, which is not a thing this build gets to have an opinion about. */
  pricing: {
    unit?: string; usd?: number; note?: string; estimate?: boolean;
    [k: string]: unknown;
  };
  capabilities: Record<string, unknown>;
  /** The `model_map` fragment `worker/resolve.py` consumes — checkpoint
   *  filenames, the workflow templates per mode, the adapter table. Present on
   *  a LOCAL row and absent on a hosted one.
   *
   *  The cloud build withheld this column from non-admins (it names every
   *  weight file on the studio's pod), so the browser's type said it did not
   *  exist. Here the catalogue is bundled and the files are the user's own. */
  local_files?: Record<string, unknown> | null;
  enabled: boolean;
  sort: number;
}

export interface ChatThread {
  id: string;
  project_id: string | null;
  episode_id: string | null;
  kind: "director" | "wizard" | "task";
  title: string | null;
  persona: Record<string, unknown> | null;
  backend: string | null;
  /** what the one-shot interview has established (wizard threads) */
  brief?: Record<string, unknown> | null;
  /** where the one-shot session got to: step, plan job, model choices */
  wizard?: Record<string, unknown> | null;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: unknown; // Anthropic-style content blocks
  streaming: boolean;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  job_id: string | null;
  created_at: string;
}

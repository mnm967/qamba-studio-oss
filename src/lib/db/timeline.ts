// Timeline data access: load a full editor state, debounced write-through
// mutations, replace-asset-everywhere ripple.
import { supabase } from "../supabase";
import { pinnedTakeAsset, placeNewBlockClip, placeholderClipFor, takeSwapPatch,
  type LaneClip } from "../blockSync";
import { blockKind, blockLabel, clipLabelFor, RENDERING_SUFFIX } from "../blockKind";
import { ensureAssetDuration } from "./assets";
import {
  CLIP_VALUE_COLS, TRACK_VALUE_COLS, duplicatePlan, nextCutName,
} from "../timelineCuts";
import type { Asset, Clip, ClipOp, GenerationBlock, Timeline, Track } from "./types";

export interface TimelineData {
  timeline: Timeline;
  tracks: Track[];
  clips: Clip[];
  assets: Map<string, Asset>;
}

export async function loadTimeline(timelineId: string): Promise<TimelineData> {
  const { data: timeline, error: e1 } = await supabase
    .from("timelines").select("*").eq("id", timelineId).single();
  if (e1) throw e1;
  const { data: tracks, error: e2 } = await supabase
    .from("tracks").select("*").eq("timeline_id", timelineId).order("idx");
  if (e2) throw e2;
  const trackIds = (tracks ?? []).map((t) => t.id);
  const { data: clips, error: e3 } = trackIds.length
    ? await supabase.from("clips").select("*").in("track_id", trackIds).order("t_start_ms")
    : { data: [], error: null };
  if (e3) throw e3;
  const assetIds = [...new Set((clips ?? []).map((c) => c.asset_id))];
  const { data: assets } = assetIds.length
    ? await supabase.from("assets").select("*").in("id", assetIds)
    : { data: [] };
  return {
    timeline: timeline as Timeline,
    tracks: (tracks ?? []) as Track[],
    clips: (clips ?? []) as Clip[],
    assets: new Map(((assets ?? []) as Asset[]).map((a) => [a.id, a])),
  };
}

export async function timelinesForEpisode(episodeId: string): Promise<Timeline[]> {
  const { data, error } = await supabase
    .from("timelines").select("*").eq("episode_id", episodeId).order("created_at");
  if (error) throw error;
  return (data ?? []) as Timeline[];
}

/** The standard lane set: blocks on V1, inserts/overlays on V2, then the
 * three audio lanes the mix expects (music, sfx, vox). */
export const STD_LANES: { kind: "video" | "audio"; idx: number; name: string }[] = [
  { kind: "video", idx: 0, name: "V1" },
  { kind: "video", idx: 1, name: "V2" },
  { kind: "audio", idx: 0, name: "A1" },
  { kind: "audio", idx: 1, name: "A2" },
  { kind: "audio", idx: 2, name: "A3" },
];

/** Additive: create any missing standard lane. Safe to call on every load —
 * existing lanes and their clips are untouched. */
export async function ensureLanes(timelineId: string): Promise<boolean> {
  const { data: tracks } = await supabase
    .from("tracks").select("kind,idx").eq("timeline_id", timelineId);
  const have = new Set((tracks ?? []).map((t) => `${t.kind}:${t.idx}`));
  const missing = STD_LANES.filter((l) => !have.has(`${l.kind}:${l.idx}`));
  if (!missing.length) return false;
  await supabase.from("tracks").insert(missing.map((l) => ({ timeline_id: timelineId, ...l })));
  return true;
}

export async function ensureTimeline(episodeId: string): Promise<Timeline> {
  const existing = await timelinesForEpisode(episodeId);
  const main = existing.find((t) => t.name === "Main") ?? existing[0];
  if (main) return main;
  const { data, error } = await supabase
    .from("timelines")
    .insert({ episode_id: episodeId, name: "Main", fps: 24, width: 1280, height: 720 })
    .select().single();
  if (error) throw error;
  const tl = data as Timeline;
  await ensureLanes(tl.id);
  return tl;
}

/* ── more than one cut of one episode ───────────────────────────────────── */

/** Insert a timeline row. Lanes are the CALLER's: a blank cut wants the
 *  standard set, a duplicate wants the source's own — and creating the
 *  standard five here first would collide with the copy on
 *  `(timeline_id, kind, idx)`. */
async function newTimelineRow(
  episodeId: string, name: string, from?: Partial<Timeline>,
): Promise<Timeline> {
  const { data, error } = await supabase
    .from("timelines")
    .insert({
      episode_id: episodeId,
      name,
      fps: from?.fps ?? 24,
      width: from?.width ?? 1280,
      height: from?.height ?? 720,
      excluded_block_ids: from?.excluded_block_ids ?? [],
      placed_audio_asset_ids: from?.placed_audio_asset_ids ?? [],
      // Deliberately NOT copied from the source: `render_asset_id` names a
      // file the OTHER cut produced. It is byte-identical at the instant of a
      // duplicate and wrong the moment either side is touched — and a cut that
      // claims a render it did not make is exactly the silent wrongness
      // `render_stale` exists to prevent. A new cut has not been rendered.
    })
    .select().single();
  if (error) throw error;
  return data as Timeline;
}

/**
 * A BLANK CUT, WHICH HAS TO BE TOLD TO STAY BLANK.
 *
 * `syncBlocksToTimeline` lays every block with a kept take onto the base video
 * lane of whichever timeline is open, and it runs on every mount of the editor
 * as well as on every landing take. So a genuinely empty timeline is empty
 * until the next reload and then silently identical to Main — i.e. the option
 * would not do the thing its own label says.
 *
 * The record that stops it is the one a deleted block already uses:
 * `excluded_block_ids` means "blocks this cut deliberately leaves out", which
 * is precisely what every existing block is to a cut you asked to start empty.
 * It is SELF-HEALING in the other direction, so dragging a block in from the
 * Shots rail clears its exclusion and takes over from there, with no separate
 * bookkeeping.
 *
 * Blocks rendered AFTER this point are not covered and will be laid down by
 * the next sync — they cannot be named here, and that matches how Main behaves
 * for a shot added later.
 */
export async function createBlankTimeline(episodeId: string): Promise<Timeline> {
  const existing = await timelinesForEpisode(episodeId);
  const tl = await newTimelineRow(episodeId, nextCutName(existing.map((t) => t.name), "New cut"));
  await ensureLanes(tl.id);
  const { blockIds, audioAssetId } = await newestStoryboardContent(episodeId);
  if (blockIds.length) await setBlockExclusions(tl.id, { exclude: blockIds });
  // THE MASTER TRACK IS THE SAME KIND OF THING A BLOCK IS HERE: something
  // `syncBlocksToTimeline` will otherwise lay down on the very first sync,
  // which for a cut that asked to start empty is the same "labelled blank,
  // silently not blank" bug the block exclusion exists to prevent — one
  // sync earlier, since `syncMasterTrack` runs before the block loop does.
  // No read-modify-write needed: this row is brand new, so the placed list
  // is simply the whole answer rather than a patch to one.
  if (audioAssetId) {
    const { error } = await supabase.from("timelines")
      .update({ placed_audio_asset_ids: [audioAssetId] }).eq("id", tl.id);
    if (error) throw error;
  }
  return tl;
}

/** Every block of this episode's newest storyboard that has a kept take, and
 *  that storyboard's own master audio asset if it declares one — the two
 *  things a blank cut has to leave out, and the two things a duplicate has to
 *  carry (the audio asset via `newTimelineRow`'s `from`, once `duplicateTimeline`
 *  copies the clip that PROVES it is already placed; the blocks are proved by
 *  the copied clips themselves and need no separate carry). Best effort: an
 *  episode with no storyboard has nothing to leave out either way. */
async function newestStoryboardContent(
  episodeId: string,
): Promise<{ blockIds: string[]; audioAssetId: string | null }> {
  const { data: sbs } = await supabase
    .from("storyboards").select("id,audio_asset_id").eq("episode_id", episodeId)
    .order("version", { ascending: false }).order("created_at", { ascending: false }).limit(1);
  const sb = (sbs ?? [])[0] as { id: string; audio_asset_id: string | null } | undefined;
  if (!sb) return { blockIds: [], audioAssetId: null };
  const { data } = await supabase
    .from("generation_blocks").select("id,active_take_id").eq("storyboard_id", sb.id);
  const blockIds = ((data ?? []) as { id: string; active_take_id: string | null }[])
    .filter((b) => b.active_take_id).map((b) => b.id);
  return { blockIds, audioAssetId: sb.audio_asset_id };
}

/**
 * Branch a cut: same lanes, same clips, same trims and effects, new rows.
 *
 * The ids are all fresh, and the two SELF-references (`clips.linked_clip_id`,
 * `tracks.duck_under_track_id`) are held back to a second pass — see
 * `duplicatePlan`, which owns that remapping and is where its cases are
 * tested. Carrying either across verbatim raises nothing and wires the copy
 * into the original.
 *
 * The link passes are best effort in the sense that they run AFTER the rows
 * exist: a failure there costs an A/V link or a duck, not the duplicate.
 *
 * `newTimelineRow`'s `from: src.timeline` is what carries `placed_audio_
 * asset_ids` into the copy — needed for exactly one case: a source whose
 * master track was DELETED before duplicating. `duplicatePlan` copies every
 * clip that is actually on the source's lanes, so an intact master track
 * comes across as an ordinary clip and needs no help; a removed one leaves
 * nothing for `duplicatePlan` to copy, and without the record too the new
 * cut would read "never placed" and `syncMasterTrack` would put it straight
 * back — a duplicate resurrecting exactly the edit it was meant to preserve.
 */
export async function duplicateTimeline(timelineId: string): Promise<Timeline> {
  const src = await loadTimeline(timelineId);
  const existing = await timelinesForEpisode(src.timeline.episode_id);
  const name = nextCutName(existing.map((t) => t.name), `${src.timeline.name} copy`);
  const tl = await newTimelineRow(src.timeline.episode_id, name, src.timeline);
  const plan = duplicatePlan(src.tracks, src.clips, tl.id, () => crypto.randomUUID());
  if (plan.tracks.length) {
    const { error } = await supabase.from("tracks").insert(plan.tracks);
    if (error) throw error;
  }
  if (plan.clips.length) {
    const { error } = await supabase.from("clips").insert(plan.clips);
    if (error) throw error;
  }
  for (const l of plan.trackLinks) {
    await supabase.from("tracks")
      .update({ duck_under_track_id: l.duck_under_track_id }).eq("id", l.id);
  }
  await relinkClips(plan.clipLinks);
  await ensureLanes(tl.id);   // a source missing V2/A3 still gets the full set
  return tl;
}

export async function renameTimeline(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const { error } = await supabase.from("timelines").update({ name: trimmed }).eq("id", id);
  if (error) throw error;
}

/** Delete a cut. Its lanes and their clips cascade; the MEDIA is untouched —
 *  a clip is a placement, and `assets` is the registry every other surface
 *  reads (invariant #2). Refusing to delete the last cut is the caller's job,
 *  where there is somewhere to say so. */
export async function deleteTimeline(id: string): Promise<void> {
  const { error } = await supabase.from("timelines").delete().eq("id", id);
  if (error) throw error;
}

/** Append a lane of `kind`, taking the next free idx. */
export async function addTrack(timelineId: string, kind: "video" | "audio"): Promise<Track> {
  const { data: existing } = await supabase
    .from("tracks").select("idx").eq("timeline_id", timelineId).eq("kind", kind).order("idx");
  const idx = ((existing ?? []).at(-1)?.idx ?? -1) + 1;
  const name = `${kind === "video" ? "V" : "A"}${idx + 1}`;
  const { data, error } = await supabase
    .from("tracks").insert({ timeline_id: timelineId, kind, idx, name }).select().single();
  if (error) throw error;
  return data as Track;
}

/** Delete a lane. Clips on it cascade (FK on tracks). */
export async function deleteTrack(id: string): Promise<void> {
  const { error } = await supabase.from("tracks").delete().eq("id", id);
  if (error) throw error;
}

export async function updateTrack(id: string, patch: Partial<Track>): Promise<void> {
  const { error } = await supabase.from("tracks").update(patch).eq("id", id);
  if (error) throw error;
}

export async function updateClip(id: string, patch: Partial<Clip>): Promise<void> {
  const { error } = await supabase.from("clips").update(patch).eq("id", id);
  if (error) throw error;
}

export async function insertClip(c: {
  /** Only ever set by a restore (undo of a delete). A clip's id is named by
   *  its partner's `linked_clip_id`, by a queued render's
   *  `payload.target.clip_id` and by every later step in the undo stack, so
   *  putting a deleted clip back under a NEW id is not putting it back. */
  id?: string;
  track_id: string;
  asset_id: string;
  t_start_ms: number;
  duration_ms: number;
  in_ms?: number;
  out_ms?: number | null;
  block_id?: string | null;
  /** The block take this clip deliberately plays — see `clips.take_id`. Only
   *  a copy of an already-pinned clip and a restore pass one; everything that
   *  creates a clip leaves it null, which means "follow the block". */
  take_id?: string | null;
  label?: string;
  ops?: ClipOp[];
  /** The A/V pair's other half. Written at insert where it can be — the
   *  partner's own side is a second write either way (see linkPair). */
  linked_clip_id?: string | null;
  audio_detached?: boolean;
  gain_db?: number;
}): Promise<Clip> {
  const { data, error } = await supabase.from("clips").insert(c).select().single();
  if (error) throw error;
  return data as Clip;
}

export async function deleteClip(id: string): Promise<void> {
  const { error } = await supabase.from("clips").delete().eq("id", id);
  if (error) throw error;
}

/** The columns a restore writes back. Deliberately not "every key of Clip":
 *  `created_at`/`updated_at` are the server's, and `owner_id`/`project_id` are
 *  filled by the `set_row_owner` trigger from the row's own parents — passing
 *  ours would be a second opinion the trigger overwrites anyway. */
const RESTORE_CLIP_COLS = ["id", "track_id", ...CLIP_VALUE_COLS] as const;

/** Put deleted clips back, ids and all.
 *
 *  `linked_clip_id` is held back to a second pass on purpose: it is a self-FK,
 *  so restoring an A/V pair in one insert would have whichever row lands first
 *  point at a row that does not exist yet. Deleting one half also makes
 *  Postgres null the survivor's column (`on delete set null`), so the link has
 *  to be re-asserted from BOTH sides rather than assumed intact. */
export async function restoreClips(clips: Clip[]): Promise<void> {
  if (!clips.length) return;
  const rows = clips.map((c) => {
    const row: Record<string, unknown> = {};
    for (const k of RESTORE_CLIP_COLS) row[k] = (c as unknown as Record<string, unknown>)[k];
    return row;
  });
  const { error } = await supabase.from("clips").upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

/** Re-assert `linked_clip_id` on both halves of every pair named here. Safe to
 *  call with links that are already correct — it is one write per row. */
export async function relinkClips(links: { id: string; linked_clip_id: string | null }[]): Promise<void> {
  for (const l of links) {
    const { error } = await supabase
      .from("clips").update({ linked_clip_id: l.linked_clip_id }).eq("id", l.id);
    if (error) throw error;
  }
}

/** Put deleted lanes back, ids and all — a lane's id is what every clip on it
 *  names as `track_id`, so a restore that renumbers it strands the clips. The
 *  `(timeline_id, kind, idx)` unique constraint is why `idx` travels too:
 *  `addTrack` would append at the end and the lane would come back in the
 *  wrong place. */
export async function restoreTracks(tracks: Track[]): Promise<void> {
  if (!tracks.length) return;
  const cols = ["id", "timeline_id", ...TRACK_VALUE_COLS, "duck_under_track_id"] as const;
  const rows = tracks.map((t) => {
    const row: Record<string, unknown> = {};
    for (const k of cols) row[k] = (t as unknown as Record<string, unknown>)[k];
    return row;
  });
  const { error } = await supabase.from("tracks").upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

export async function markStale(timelineId: string): Promise<void> {
  await supabase.from("timelines").update({ render_stale: true }).eq("id", timelineId);
}

/** Replace-everywhere ripple: repoint every clip using oldAsset to newAsset.
 * Returns affected clip ids. */
export async function replaceAssetEverywhere(oldAssetId: string, newAssetId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("clips").update({ asset_id: newAssetId }).eq("asset_id", oldAssetId).select("id");
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => r.id);
}

/** Which blocks this cut deliberately leaves out.
 *
 *  `exclude` is written when the editor removes a block's LAST picture clip;
 *  `include` when one comes back — an undo, or the block dragged onto a lane
 *  again. Read-modify-write rather than a Postgres array operator, because
 *  the local storage plane's query shim implements columns, not
 *  `array_append`, and a filter it cannot express is silent rather than an
 *  error. */
export async function setBlockExclusions(
  timelineId: string,
  patch: { exclude?: string[]; include?: string[] },
): Promise<void> {
  if (!patch.exclude?.length && !patch.include?.length) return;
  // SERIALISED PER TIMELINE, because this is a read-modify-write on one array
  // and two deletes a few hundred milliseconds apart are an ordinary thing to
  // do. Run concurrently they both read the list as it was, and the second
  // write drops the first one's block — which is this bug back again, for one
  // of the two clips, with no way to tell from the outside.
  const prev = exclusionWrites.get(timelineId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => writeBlockExclusions(timelineId, patch));
  exclusionWrites.set(timelineId, next);
  try {
    await next;
  } finally {
    if (exclusionWrites.get(timelineId) === next) exclusionWrites.delete(timelineId);
  }
}

const exclusionWrites = new Map<string, Promise<unknown>>();

async function writeBlockExclusions(
  timelineId: string,
  { exclude = [], include = [] }: { exclude?: string[]; include?: string[] },
): Promise<void> {
  const { data } = await supabase
    .from("timelines").select("excluded_block_ids").eq("id", timelineId).maybeSingle();
  const cur = ((data as { excluded_block_ids?: string[] } | null)?.excluded_block_ids ?? []);
  const drop = new Set(include);
  const next = [...new Set([...cur.filter((id) => !drop.has(id)), ...exclude])];
  if (next.length === cur.length && next.every((id, i) => id === cur[i])) return;
  const { error } = await supabase
    .from("timelines").update({ excluded_block_ids: next }).eq("id", timelineId);
  if (error) throw error;
}

export interface BlockSyncResult {
  /** Clips this sync created or repointed. */
  changed: number;
  /** Blocks it left off, because the editor removed them (newest cut wins).
   *  Reported rather than skipped in silence: a sync that quietly does less
   *  than its button says reads as the button being broken. */
  skipped: { id: string; idx: number }[];
  /** "Score" / "Master track" when the storyboard's own audio was left off
   *  for the same reason, else null. Reported for the same reason. */
  skippedAudio: string | null;
}

/** Blocks -> timeline sync: lay every generated block's active take onto the
 * base video track in storyboard order (idempotent: replaces existing block
 * clips' assets, appends missing ones). Music videos also get the storyboard's
 * master track laid on A1 once — the locked block audio already matches it,
 * but the full-quality source is what the final mix should use.
 *
 * **A BLOCK THE EDITOR DELETED IS NOT A BLOCK THAT IS MISSING.** "Has a kept
 * take and no clip" is true of a block that has just rendered AND of one the
 * user removed on purpose, and until `timelines.excluded_block_ids` existed
 * nothing could tell them apart — so a deleted block was re-inserted by the
 * next sync, which fires on every landing take and on every mount of the
 * editor (the auto-sync guard is a ref, so a reload re-runs it from scratch).
 * The block simply came back a few minutes later with nothing to explain it.
 *
 * The list is SELF-HEALING in the other direction: any block that does have a
 * picture clip is dropped from it here, so undoing the delete (⌘Z) or dragging
 * the block back onto a lane restores it with no separate bookkeeping. There
 * is deliberately no "restore them all" flag on this function: putting a block
 * back is a deliberate gesture, and a sync that can resurrect one on request
 * is one press away from the behaviour this exists to stop.
 *
 * **THE CUT AND THE STORYBOARD MUST BELONG TO ONE EPISODE, and this is the
 * only layer that can know.** The two ids arrive from a caller that holds them
 * in separate pieces of state, and switching project or episode moves them at
 * different moments — so a mismatched pair is not a corner case, it is what a
 * project switch looks like for a few hundred milliseconds. Handed one, every
 * line below does exactly what it says: it lays the OTHER episode's blocks
 * onto this cut's V1, at their own planned positions, and `syncMasterTrack`
 * puts that episode's score on A1 beside them. Nothing errors, the clips carry
 * the right-looking `Block N` labels, and the next sync leaves them alone
 * forever because their `block_id` is not in this storyboard. Measured on the
 * live rows before this guard existed: **173 foreign clips across 8 cuts in 6
 * projects**, plus two foreign master tracks and two exclusion entries.
 *
 * It REFUSES rather than skipping quietly. A silent no-op would hide the
 * caller's stale id, which is the bug — and the caller (TimelineView's
 * `[episode.id]` load) now drops its storyboard id the moment the episode
 * changes, so after that fix this can only fire on a genuine mistake. */
/** A block clip as the sync reads it off the lanes. */
type Placed = { id: string; block_id: string | null; take_id: string | null;
                asset_id: string; label: string | null;
                duration_ms: number; in_ms: number | null; out_ms: number | null;
                track_id: string; t_start_ms: number; linked_clip_id: string | null };

/**
 * Move the clips a new block displaces, on the lane and in the sync's own
 * picture of it. A detached audio half moves with its picture — the geometry
 * mirror the store applies on every drag, done by hand here because the sync
 * runs outside the store. Kept OUT of `syncBlocksToTimeline` on purpose: that
 * function's contract, pinned by blockSync.test.ts, is that nothing in it
 * writes a clip's position except the insert of a block that has none.
 */
async function shiftLaneClips(
  lane: LaneClip[], shift: { id: string; t_start_ms: number }[], byMs: number,
): Promise<void> {
  if (!shift.length) return;
  const partners = shift
    .map((sh) => lane.find((c) => c.id === sh.id)?.linked_clip_id)
    .filter(Boolean) as string[];
  const { data: linked } = partners.length
    ? await supabase.from("clips").select("id,t_start_ms").in("id", partners)
    : { data: [] as { id: string; t_start_ms: number }[] };
  const linkedStart = new Map(((linked ?? []) as { id: string; t_start_ms: number }[])
    .map((c) => [c.id, c.t_start_ms]));
  for (const sh of shift) {
    await supabase.from("clips").update({ t_start_ms: sh.t_start_ms }).eq("id", sh.id);
    const c = lane.find((x) => x.id === sh.id);
    if (c) c.t_start_ms = sh.t_start_ms;
    const partner = c?.linked_clip_id;
    if (partner && linkedStart.has(partner)) {
      await supabase.from("clips")
        .update({ t_start_ms: linkedStart.get(partner)! + Math.round(byMs) }).eq("id", partner);
    }
  }
}

export async function syncBlocksToTimeline(
  timelineId: string, storyboardId: string,
): Promise<BlockSyncResult> {
  // Before ANY read or write, `syncMasterTrack` included — it runs below the
  // block fetch but above the early return, so a guard placed later would
  // still have laid another episode's score on A1.
  const [{ data: tlRowEp }, { data: sbRowEp }] = await Promise.all([
    supabase.from("timelines").select("episode_id").eq("id", timelineId).maybeSingle(),
    supabase.from("storyboards").select("episode_id").eq("id", storyboardId).maybeSingle(),
  ]);
  const tlEpisode = (tlRowEp as { episode_id?: string } | null)?.episode_id ?? null;
  const sbEpisode = (sbRowEp as { episode_id?: string } | null)?.episode_id ?? null;
  if (!tlEpisode || !sbEpisode || tlEpisode !== sbEpisode) {
    throw new Error(
      `syncBlocksToTimeline: cut ${timelineId} belongs to episode ${tlEpisode ?? "?"} `
      + `and storyboard ${storyboardId} to episode ${sbEpisode ?? "?"} — refusing to `
      + `lay one episode's blocks onto another's cut`);
  }
  const { data: blocks, error } = await supabase
    .from("generation_blocks")
    // `params` carries `clip_kind` — a block placed or relabelled here has
    // to be named for what it IS (a chain, an extension), and without this
    // column `blockKind` reads every one of them as a planner block.
    .select("id,idx,t_start_ms,t_end_ms,active_take_id,status,params")
    .eq("storyboard_id", storyboardId)
    .order("idx");
  if (error) throw error;
  const skippedAudio = await syncMasterTrack(timelineId, storyboardId)
    .catch((err) => { console.error(err); return null; });
  const withTakes = (blocks ?? []).filter((b) => b.active_take_id);
  if (!withTakes.length) return { changed: 0, skipped: [], skippedAudio };
  const { data: tlRow } = await supabase
    .from("timelines").select("excluded_block_ids").eq("id", timelineId).maybeSingle();
  const excluded = new Set(
    (tlRow as { excluded_block_ids?: string[] } | null)?.excluded_block_ids ?? []);
  // THE LANES AND THEIR CLIPS ARE READ BEFORE THE TAKES, and that order is
  // the pin: a clip may name a take that is not its block's ACTIVE one
  // (`clips.take_id`), and the take fetch has to ask for those too or a
  // pinned clip resolves to nothing and falls back to the block's — silently
  // undoing the choice on the next sync, which is the whole failure the pin
  // exists to end.
  const { data: tracks } = await supabase
    .from("tracks").select("id,kind,idx").eq("timeline_id", timelineId)
    .eq("kind", "video").order("idx");
  const vt = tracks?.[0];
  if (!vt) throw new Error("timeline has no video track");
  // EVERY video lane, not just the one a new block lands on. A block clip
  // dragged up to V2 is still on this timeline, and looking only at V1 made
  // that a second copy on the next sync — the same resurrection as a delete,
  // wearing a different costume. Audio lanes are deliberately out: a detached
  // audio half carries `block_id` too (see `detachedClipFrom`), and a block
  // whose picture is gone is not on the cut because its sound survived it.
  const videoIds = (tracks ?? []).map((t) => t.id);
  const { data: existing } = await supabase
    .from("clips")
    .select("id,block_id,take_id,asset_id,duration_ms,in_ms,out_ms,label,track_id,t_start_ms,linked_clip_id")
    .in("track_id", videoIds);

  const pinnedIds = (existing ?? [])
    .map((c) => (c as Placed).take_id).filter(Boolean) as string[];
  // `block_id` comes back so a pin can be CHECKED against the clip's own
  // block — see `pinnedTakeAsset`, which is where that guard lives.
  const { data: takes } = await supabase
    .from("block_takes").select("id,asset_id,block_id")
    .in("id", [...new Set([...withTakes.map((b) => b.active_take_id as string), ...pinnedIds])]);
  const takeRows = (takes ?? []) as { id: string; asset_id: string; block_id: string }[];
  const takeAsset = new Map(takeRows.map((t) => [t.id, t.asset_id]));
  const takeOf = new Map(takeRows.map((t) => [t.id, t]));
  // How long each incoming take actually is. Needed to clamp a preserved trim:
  // a clip longer than its own media plays black past the end and parks the
  // preview on "buffering…" — the same failure `_attach_to_clip` exists to
  // stop, reached from the other side.
  const takeIds = [...new Set([...takeAsset.values()])];
  const { data: takeMedia } = takeIds.length
    ? await supabase.from("assets").select("id,duration_ms").in("id", takeIds)
    : { data: [] };
  const mediaMs = new Map(((takeMedia ?? []) as { id: string; duration_ms: number | null }[])
    .map((a) => [a.id, a.duration_ms]));
  // `t_start_ms` is read for ONE purpose: placing a block that is not on the
  // cut yet after its predecessor's clip. The repoint below never writes it —
  // where a block clip sits is the cut's business and not this function's.
  // The lane as this sync sees it, kept current as it inserts: two new blocks
  // landing in one pass have to follow each other, not both follow the same
  // predecessor.
  const lane: LaneClip[] = [...((existing ?? []) as Placed[])];
  // EVERY clip of a block, not one of them. `splitAt` copies `block_id` onto
  // both halves, and live cuts also carry exact duplicate block clips from
  // before the V2 lookup was fixed — so a Map keyed by block silently kept
  // whichever row the read happened to return last, and the others went on
  // playing the take they were repointed off. Measured: 51 blocks with more
  // than one picture clip, 9 of them already playing two different takes.
  const byBlock = new Map<string, Placed[]>();
  for (const c of (existing ?? []).filter((c) => c.block_id)) {
    const list = byBlock.get(c.block_id as string);
    if (list) list.push(c as Placed);
    else byBlock.set(c.block_id as string, [c as Placed]);
  }
  const skipped: BlockSyncResult["skipped"] = [];
  const heal: string[] = [];
  // Placeholders adopted in THIS pass, so two blocks cannot claim one clip.
  const claimed = new Set<string>();
  let n = 0;
  for (const b of withTakes) {
    const assetId = takeAsset.get(b.active_take_id as string);
    if (!assetId) continue;
    const placed = byBlock.get(b.id);
    if (placed?.length) {
      if (excluded.has(b.id)) heal.push(b.id);  // it is back — stop excluding it
      // THE LABEL IS A SNAPSHOT OF SOMETHING DERIVABLE, so it goes stale the
      // moment a block's `idx` moves. `add_block` shifts every follower back
      // by one, and nothing re-labelled their clips — so after a few inserts
      // the lane read "Block 1, Block 2, Block 3" against a sidebar reading
      // "Block 2, Block 5, Block 6", off by however many shots had been
      // added ahead of each. Measured on RIVALS. Refreshed here because this
      // runs on every mount of the editor, so an already-drifted cut heals
      // itself; the honest fix is not to store a ref at all (director/refs.js
      // says so in as many words), which needs the blocks in the timeline
      // store and is a bigger change than this one.
      // KIND-AWARE, and only over the studio's OWN labels. This used to
      // write `Block ${idx+1}` over anything starting with "Block " — which
      // ate the detached half's "· audio" suffix on every pass, and would
      // now rename a chain. `clipLabelFor` keeps a written name ("Chain: How
      // the reference pi") and rewrites the auto forms.
      const kind = blockKind(b as unknown as GenerationBlock);
      for (const c of placed) {
        const want = clipLabelFor(kind, b.idx, c.label,
          { audio: !!c.label?.trim().endsWith("· audio") });
        if (want === c.label) continue;
        await supabase.from("clips").update({ label: want }).eq("id", c.id);
        n++;
      }
      // WHICH TAKE EACH COPY SHOULD BE PLAYING, one clip at a time. It used
      // to be one answer for the whole block — the active take — which is
      // right for a block that is on the cut once and is exactly what made
      // two copies of a block unable to show two takes: the pick survived
      // until the next sync and then silently became the block's again.
      // `pinnedTakeAsset` is the rule (and the guard on a pin naming another
      // block's take); a clip with no pin resolves to the active take, which
      // is every clip that exists today.
      const wantOf = (c: Placed) =>
        pinnedTakeAsset(c.take_id, b.id, (id) => takeOf.get(id)) ?? assetId;
      const stale = placed.filter((c) => c.asset_id !== wantOf(c));
      if (!stale.length) continue;             // already in sync — no write
      // A NEW TAKE REPOINTS THE MEDIA AND NEVER MOVES THE CLIP.
      //
      // The plan places a block clip once, when it first lands (the insert
      // below). After that its position on the lane is the cut, and the cut
      // is the editor's: auto-align packs a lane, a ripple delete pulls
      // everything after it left, a drag puts a shot somewhere else — and
      // every one of those writes `t_start_ms` and NOTHING else.
      //
      // This used to rewrite `t_start_ms` from the block whenever the clip
      // read as untrimmed, and the untrimmed test was `in_ms === 0 &&
      // duration_ms === blockMs` — the two fields it then wrote back
      // unchanged, with the one field it actually changed left out of the
      // test. So a clip that had been MOVED but not cut was yanked back to
      // the position the planner chose, over or apart from its neighbours,
      // the next time a take landed on it. Measured on the live data: 91 of
      // 399 block clips are sitting somewhere the plan did not put them with
      // `in_ms` 0 and the plan's own length, i.e. armed for exactly that
      // jump — one run of them by 182.5 seconds.
      //
      // What survives is the clamp, which now covers every clip rather than
      // only the cut ones — `takeSwapPatch` owns it, and is where its cases
      // are tested.
      for (const clip of stale) {
        const want = wantOf(clip);
        await supabase.from("clips")
          .update(takeSwapPatch(clip, want, mediaMs.get(want))).eq("id", clip.id);
      }
      n += stale.length;
      continue;
    }
    // ITS PLACEHOLDER MAY ALREADY BE HERE, UNCLAIMED — adopt it rather than
    // arriving beside it. `_publish_clip_block` inserts a clip-born block and
    // activates its take BEFORE `_attach_to_clip` writes `block_id` onto the
    // still the extend/chain modal parked on the lane, and in between the
    // block is exactly what the insert below looks for: a kept take and no
    // clip. The gap is `_relabel_block_clips` — one sequential round trip per
    // renumbered block, seconds on a long storyboard, each of them a realtime
    // event waking this very sync. `placeholderClipFor` matches the clip by
    // the frame the recipe opens on and is where the measurement lives.
    const adopt = placeholderClipFor(b.params, (existing ?? []) as Placed[], claimed);
    if (adopt) {
      claimed.add(adopt.id);
      if (excluded.has(b.id)) heal.push(b.id);
      const kind = blockKind(b as unknown as GenerationBlock);
      await supabase.from("clips").update({
        block_id: b.id,
        // KEEP A WRITTEN NAME. The modal labels a chain "Chain: <the prompt>"
        // and only the studio's own forms are rewritten — the same rule
        // `_clip_label` follows on the worker side.
        label: clipLabelFor(kind, b.idx, adopt.label,
          { audio: !!adopt.label?.trim().endsWith("· audio") }),
        ...takeSwapPatch(adopt, assetId, mediaMs.get(assetId)),
      }).eq("id", adopt.id);
      // The lane's own copy, so a later block in this pass places itself
      // after the adopted clip rather than through it.
      const seat = lane.find((c) => c.id === adopt.id);
      if (seat) seat.block_id = b.id;
      n++;
      continue;
    }
    if (excluded.has(b.id)) {
      skipped.push({ id: b.id, idx: b.idx });
    } else {
      // A BLOCK THAT IS NOT ON THE CUT YET IS INSERTED AFTER ITS PREDECESSOR,
      // and the clips from there on move over to make room — the same insert
      // the chain modal performs. It used to land at its PLAN window, which
      // is only the right place on an empty cut being laid down in story
      // order: a shot added mid-episode gets a plan window that pushes the
      // followers on the plan's clock while the clips on the lane stay put,
      // so it was dropped on top of the next block's clip, or on a re-cut
      // somewhere unrelated. `placeNewBlockClip` is the rule and is tested;
      // this is the write.
      const dur = b.t_end_ms - b.t_start_ms;
      const place = placeNewBlockClip(b, blocks ?? [], lane, dur, vt.id);
      await shiftLaneClips(lane, place.shift, dur);
      const inserted = await insertClip({
        track_id: place.trackId, asset_id: assetId, block_id: b.id,
        t_start_ms: place.atMs, duration_ms: dur,
        label: blockLabel(blockKind(b as unknown as GenerationBlock), b.idx),
      });
      lane.push({ id: inserted.id, block_id: b.id, track_id: place.trackId,
                  t_start_ms: place.atMs, duration_ms: dur, linked_clip_id: null });
      n++;
    }
  }
  // A PLACEHOLDER WHOSE RENDER DIED says so on the lane. The dock holds a
  // block's place with a still labelled "… · rendering" (lib/blockPlaceholder)
  // and the repoint above renames it when the take lands; a block that
  // FAILED never reaches that loop, so its still would sit there reading
  // "rendering" for good.
  const failed = (blocks ?? []).filter((b) => b.status === "failed" && byBlock.has(b.id));
  for (const b of failed) {
    for (const c of byBlock.get(b.id) ?? []) {
      if (!c.label?.endsWith(RENDERING_SUFFIX)) continue;
      const want = `${blockLabel(blockKind(b as unknown as GenerationBlock), b.idx)} · failed`;
      await supabase.from("clips").update({ label: want }).eq("id", c.id);
      n++;
    }
  }
  if (heal.length) await setBlockExclusions(timelineId, { include: heal }).catch(console.error);
  if (n > 0) await markStale(timelineId);
  return { changed: n, skipped, skippedAudio };
}

/** Where a film's score sits on first listen.
 *
 *  NOT the same number as `worker/score_mix.BED_BELOW_LU`, and deliberately
 *  not shared with it: that one is a RELATIVE placement the delivered cut
 *  measures with ebur128, and nothing in the browser can measure a take's
 *  loudness. This is a starting fader position that puts the score under
 *  dialogue on the first play rather than over it — the editor moves it, and
 *  `assemble_cut` re-measures for the file that ships. */
const SCORE_BED_DB = -12;

/** Lay the storyboard's master audio asset on the first audio track (once).
 *
 *  **Muting the picture is for a LOCKED track only.** On a music video the
 *  takes carry that exact master baked in — that is what `audio_mode:
 *  "locked"` means — so the copy on A1 must be the only one in the mix. On a
 *  FILM the same column holds a generated SCORE while the takes carry H3's
 *  native dialogue, and muting V1 there silences the entire film to make room
 *  for the music. That was live for as long as a film could have a score:
 *  this function read `audio_asset_id` and nothing else, while `locked` is
 *  gated on `medium === "music_video"` two modules away.
 *
 *  The blocks are asked rather than the project, for the reason
 *  `_mix_score` asks them: the block is what actually rendered. */
async function syncMasterTrack(
  timelineId: string, storyboardId: string,
): Promise<string | null> {
  const { data: sb } = await supabase
    .from("storyboards").select("audio_asset_id").eq("id", storyboardId).single();
  const audioId = sb?.audio_asset_id;
  if (!audioId) return null;
  const { data: locked } = await supabase
    .from("generation_blocks").select("id")
    .eq("storyboard_id", storyboardId).eq("audio_mode", "locked").limit(1);
  const isLocked = Boolean(locked?.length);
  const label = isLocked ? "Master track" : "Score";

  const { data: at } = await supabase
    .from("tracks").select("id,kind,idx").eq("timeline_id", timelineId).order("idx");
  const lanes = (at ?? []) as { id: string; kind: string; idx: number }[];
  const a1 = lanes.filter((t) => t.kind === "audio")[0];
  if (!a1) return null;
  // EVERY lane, not just A1: the clip moved down to A2 is still this cut's
  // master track, and asking only about A1 made it a second copy — the twin
  // of the block sync's own V1-only lookup.
  const { data: existing } = await supabase
    .from("clips").select("id").eq("asset_id", audioId)
    .in("track_id", lanes.map((t) => t.id)).limit(1);
  const present = Boolean(existing?.length);

  // PLACED ONCE, AND AFTER THAT THE EDITOR DECIDES. The old test was "is
  // there a clip with this asset" — which a delete answers "no", so the next
  // sync put the track straight back, on every landing take and on every
  // mount of the editor. A record of the PLACEMENT is the honest question,
  // and it is the right shape here (unlike a block clip, which sync keeps
  // repointing at new takes) precisely because nothing ever touches this clip
  // again once it exists.
  const { data: tlRow } = await supabase
    .from("timelines").select("placed_audio_asset_ids").eq("id", timelineId).maybeSingle();
  const placed = new Set(
    (tlRow as { placed_audio_asset_ids?: string[] } | null)?.placed_audio_asset_ids ?? []);

  const record = async () => {
    if (placed.has(audioId)) return;
    await supabase.from("timelines")
      .update({ placed_audio_asset_ids: [...placed, audioId] }).eq("id", timelineId);
  };

  // MUTING V1 IS PART OF PLACING THE TRACK, not a standing rule about the
  // storyboard. On a locked music video the takes carry the same master baked
  // in, so a second copy on A1 would double it — but re-asserting that mute
  // for a master track the editor has REMOVED leaves the cut silent, which is
  // the score-mutes-the-film failure arriving from the other side. An already
  // muted V1 is left alone either way: the lane has its own control and
  // un-muting behind the user's back is the opposite mistake.
  if (isLocked && (present || !placed.has(audioId))) {
    await supabase.from("tracks").update({ muted: true })
      .eq("timeline_id", timelineId).eq("kind", "video").eq("idx", 0);
  }

  if (present) { await record(); return null; }
  // Removed on purpose. Put it back by dragging the track out of the library
  // — the same deliberate gesture as adding any other audio.
  if (placed.has(audioId)) return label;

  // THE MASTER CLIP IS THE WHOLE TRACK, so its length is measured rather than
  // assumed. `duration_ms` is written by the pod's ingest job, so a track
  // uploaded in the wizard while the pod is stopped carries null — and the
  // fallback below then laid a 60s clip over a song of any length, which on a
  // MUSIC VIDEO is the worst place for it: the blocks are planned against
  // `beats_ms` for the real duration while the lane says a flat minute. Runs
  // at most once per timeline — the checks above return first.
  const { data: row } = await supabase
    .from("assets").select("*").eq("id", audioId).single();
  const asset = row ? await ensureAssetDuration(row as Asset) : null;
  await insertClip({
    track_id: a1.id, asset_id: audioId, t_start_ms: 0,
    duration_ms: asset?.duration_ms ?? 60000, in_ms: 0,
    out_ms: asset?.duration_ms ?? null,
    label,
    gain_db: isLocked ? 0 : SCORE_BED_DB,
  });
  await record();
  return null;
}

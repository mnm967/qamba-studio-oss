// MORE THAN ONE CUT OF ONE EPISODE.
//
// `timelines` has always been a list per episode — `timelinesForEpisode`
// returns every row and `ensureTimeline` merely picks "Main" out of it — so
// nothing in the schema had to change here. What was missing was any way to
// make a second one, and any way to say which one you are looking at.
//
// This module is the half that has no database in it, because both halves of
// a duplicate fail SILENTLY when they are wrong:
//
//  - A NAME COLLISION is merely confusing (two rows called "Main copy", and
//    the switcher is a list of names).
//  - THE ID REMAPPING IS NOT. `clips.linked_clip_id` and
//    `tracks.duck_under_track_id` are SELF-references, so a copy that carries
//    them across verbatim points the new cut's rows at the OLD cut's rows.
//    Nothing errors — the foreign key is satisfied, because the target really
//    does exist — and the two timelines are then wired into each other:
//    trimming a clip in the copy drags its "partner" around in the original,
//    a lane in the copy ducks under a lane in a cut nobody has open. That is
//    the same self-FK trap `cloudSync.writeOrder` documents, and it is why
//    both are held back to a second pass (see `duplicateTimeline`) rather
//    than ridden along with the insert.
import type { Clip, Track } from "./db/types";

/* ── which columns a copy carries ───────────────────────────────────────── */

/** A lane's own values: no `id`, no `timeline_id` (the copy's), and no
 *  `duck_under_track_id` (a self-FK, remapped in a second pass).
 *
 *  Shared with `restoreTracks` in db/timeline.ts deliberately — the two lists
 *  answer the same question ("what IS a lane, apart from where it lives"),
 *  and a column added to one and not the other is a lane property that
 *  survives an undo and is lost by a duplicate, or the reverse. */
export const TRACK_VALUE_COLS = [
  "kind", "idx", "name", "muted", "solo", "locked", "gain_db", "automation",
  "audio_fx",
] as const;

/** A clip's own values: no `id`, no `track_id` (remapped), and no
 *  `linked_clip_id` (a self-FK, second pass). Shared with `restoreClips` for
 *  the reason above. */
export const CLIP_VALUE_COLS = [
  "asset_id", "block_id", "take_id", "t_start_ms", "duration_ms", "in_ms",
  "out_ms", "ops", "transition_in", "gain_db", "label", "audio_detached",
  "audio_fx", "post",
] as const;

const pick = (row: unknown, cols: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of cols) out[k] = (row as Record<string, unknown>)[k];
  return out;
};

/* ── naming ─────────────────────────────────────────────────────────────── */

/** The first free name in the `base`, `base 2`, `base 3`… series.
 *
 *  Numbering starts at 2 because the unnumbered name IS the first one — a
 *  list reading "New cut, New cut 2" is right and "New cut 1, New cut 2"
 *  invites the question of where cut 0 went. Comparison is trimmed and
 *  case-insensitive: nothing stops two rows sharing a name, so this is about
 *  telling them apart on screen, and "Main Copy" beside "Main copy" fails
 *  that as surely as an exact repeat. */
export function nextCutName(existing: readonly string[], base: string): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const stem = base.trim() || "Cut";
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return stem;
}

/* ── the copy ───────────────────────────────────────────────────────────── */

export interface DuplicatePlan {
  /** Lane rows to insert. Self-FK held back — see `trackLinks`. */
  tracks: Record<string, unknown>[];
  /** Clip rows to insert, already pointing at the COPY's lanes. Self-FK held
   *  back — see `clipLinks`. */
  clips: Record<string, unknown>[];
  /** Second pass: `duck_under_track_id`, remapped into the copy. Only rows
   *  that actually have one. */
  trackLinks: { id: string; duck_under_track_id: string }[];
  /** Second pass: `linked_clip_id`, remapped into the copy. Written from BOTH
   *  halves of a pair, for the same reason `relinkClips` does. */
  clipLinks: { id: string; linked_clip_id: string }[];
}

/**
 * Everything a duplicate has to write, with fresh ids throughout.
 *
 * `newId` is injected rather than called for, so the remapping can be tested
 * against ids you can read. A self-reference pointing OUTSIDE the copied set
 * is dropped rather than carried: it can only be a row this timeline does not
 * own, and the whole point of this function is that the copy never reaches
 * back into the original.
 */
export function duplicatePlan(
  tracks: readonly Track[],
  clips: readonly Clip[],
  timelineId: string,
  newId: () => string,
): DuplicatePlan {
  const trackId = new Map<string, string>();
  for (const t of tracks) trackId.set(t.id, newId());
  const clipId = new Map<string, string>();
  for (const c of clips) clipId.set(c.id, newId());

  const plan: DuplicatePlan = { tracks: [], clips: [], trackLinks: [], clipLinks: [] };

  for (const t of tracks) {
    const id = trackId.get(t.id) as string;
    plan.tracks.push({ id, timeline_id: timelineId, ...pick(t, TRACK_VALUE_COLS) });
    const duck = t.duck_under_track_id ? trackId.get(t.duck_under_track_id) : null;
    if (duck) plan.trackLinks.push({ id, duck_under_track_id: duck });
  }

  for (const c of clips) {
    const id = clipId.get(c.id) as string;
    const track = trackId.get(c.track_id);
    // A clip on a lane that is not in this timeline cannot be placed anywhere
    // in the copy. It should be impossible (clips are read through the lanes),
    // so this is a guard rather than a case: dropping it loses one clip, where
    // inserting it with the ORIGINAL track_id would silently hang a row of the
    // copy off the original's lane.
    if (!track) continue;
    plan.clips.push({ id, track_id: track, ...pick(c, CLIP_VALUE_COLS) });
    const link = c.linked_clip_id ? clipId.get(c.linked_clip_id) : null;
    if (link) plan.clipLinks.push({ id, linked_clip_id: link });
  }
  return plan;
}

/* ── which cut you were last looking at ─────────────────────────────────── */

const LAST_KEY = "qamba.timeline.last";

/**
 * The open cut, per episode, per MACHINE.
 *
 * localStorage rather than a column, for `autoSync`'s reason one table over:
 * it describes what this browser is looking at, two people editing one
 * episode can reasonably differ, and writing it to the row would mark the
 * timeline changed — which on the local plane is an edit the sync would then
 * carry to the cloud.
 *
 * A lost preference costs one switch, so every path here swallows its errors:
 * private-mode storage throwing must not stop the editor opening.
 */
export function rememberCut(episodeId: string, timelineId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<string, string>;
    all[episodeId] = timelineId;
    localStorage.setItem(LAST_KEY, JSON.stringify(all));
  } catch { /* opens on Main next time */ }
}

/** The remembered cut, or null. The caller must still check that the id is in
 *  the episode's list — a cut deleted in another tab is remembered here long
 *  after its row is gone, and loading it would throw on a `.single()`. */
export function rememberedCut(episodeId: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<string, string>;
    return all[episodeId] ?? null;
  } catch { return null; }
}

/** Drop the pointer when the cut it names is deleted, so the next open falls
 *  back to Main rather than to a row that no longer exists. */
export function forgetCut(episodeId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<string, string>;
    delete all[episodeId];
    localStorage.setItem(LAST_KEY, JSON.stringify(all));
  } catch { /* nothing to clean up */ }
}

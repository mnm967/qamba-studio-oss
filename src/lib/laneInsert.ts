// WHERE A NEW CLIP LANDS IN A LANE'S ORDER — the pure half.
//
// Split out for the reason `rippleDelete.ts` is: the store does the writing,
// and this is the arithmetic. It is also the part that cannot be checked by
// looking — every outcome is a lane full of clips in SOME order, and only one
// of them is the order that was asked for.
//
// THE TIE IS THE WHOLE POINT, and it is what "extending block 15 put it after
// block 16" was. `insertAsset` placed the clip at `atMs`, appended it to the
// array and sorted — and `Array.prototype.sort` is STABLE, so a clip inserted
// at exactly another clip's start stayed BEHIND it. Every "put this
// immediately after that clip" in the app computes `atMs` as
// `clip.t_start_ms + clip.duration_ms`, which IS the next clip's start, so the
// tie is the normal case rather than a corner: an extend, an add-after and a
// library pick all landed one seat too late and the lane then packed that
// wrong order into place. Nothing errors — the render is right, its anchor
// frame is right, and it plays in the wrong seat.
//
// The chain path carried a workaround for exactly this (it shifted every later
// clip right by the bridge's own length before inserting, purely to break the
// tie), which is why a chain landed correctly while an extend did not.
import type { Clip, Track } from "./db/types";

type Placed = Pick<Clip, "id" | "track_id" | "t_start_ms" | "linked_clip_id">;

/**
 * The index a clip inserted at `atMs` takes among its lane's clips.
 *
 * STRICTLY before: a clip that starts exactly where this one is being inserted
 * is not in front of it. That single `<` is the fix.
 *
 * Counted rather than searched, so an unsorted list — or one with overlaps or
 * gaps, both of which a lane may legitimately have — gives the same answer.
 * `excludeId` is the clip being placed: `insertAsset` adds it to state before
 * asking, so without it the new clip would count itself.
 */
export function insertIndexAt(
  clips: readonly Placed[],
  trackId: string,
  atMs: number,
  excludeId?: string | null,
): number {
  let i = 0;
  for (const c of clips) {
    if (c.track_id !== trackId || (excludeId && c.id === excludeId)) continue;
    if (c.t_start_ms < atMs) i += 1;
  }
  return i;
}

/**
 * May this lane be packed end to end?
 *
 * An audio lane holding a LINKED clip may not: that clip's position belongs to
 * the picture it was detached from, and sliding it to close a gap would put
 * the dialogue over the wrong shot. Video lanes pack as before — their audio
 * halves come along through the geometry mirror.
 *
 * Stated once and shared, because two lane operations need it and only one of
 * them used to have it: `autoAlignImpl` refused such a lane and
 * `reorderClipOnTrack` did not, so swapping one for the other without this
 * would have started packing exactly the lanes the rule exists to protect.
 */
export function lanePacks(
  track: Pick<Track, "kind"> | null | undefined,
  laneClips: readonly Pick<Clip, "linked_clip_id">[],
): boolean {
  return !(track?.kind === "audio" && laneClips.some((c) => c.linked_clip_id));
}

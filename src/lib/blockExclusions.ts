// WHICH BLOCKS A CUT DELIBERATELY LEAVES OUT.
//
// `syncBlocksToTimeline` lays every block that has a kept take onto the base
// video lane and re-inserts any block that has no clip. That is right for a
// block which has just rendered and wrong for one somebody deleted — and the
// two are the same observation, so until the delete left a record the deleted
// block simply came back: on the next take to land, on the next re-render, or
// on the next page load (the auto-sync guard is a React ref, so a reload
// re-runs the sync from scratch). Nothing errored. The block reappeared
// minutes later with nothing on screen to explain it.
//
// Pure and unit-tested; the store owns the write, because that reaches
// Supabase. Kept out of the undo diff on purpose: an exclusion is not a row
// the editor holds, and a ⌘Z that rewound it would need a fourth snapshot to
// diff. It does not need one — the answer is re-derived from the clips after
// every step, so undo and redo maintain it for free.
import type { Clip, Track } from "./db/types";
import type { UndoOp } from "./undo";

/** What the exclusion list should be told after one undo step, given the
 *  editor as it stands AFTER that step.
 *
 *  Only blocks the step actually touched are named, so a sync's own write and
 *  another tab's edits are left alone — this returns an instruction about a
 *  handful of blocks, never a replacement list.
 *
 *  DIRECTION-BLIND on purpose: it asks one question per touched block — is a
 *  picture clip for it still here? — so a delete excludes, undoing that delete
 *  includes, and redoing it excludes again, with no branch to get backwards.
 *
 *  PICTURE clip, i.e. a clip on a VIDEO lane: `detachedClipFrom` copies
 *  `block_id` onto the detached audio half, and a block whose picture is gone
 *  is not part of the cut merely because its sound outlived it. */
export function exclusionsAfterStep(
  ops: readonly UndoOp[],
  clips: readonly Clip[],
  tracks: readonly Track[],
): { exclude: string[]; include: string[] } {
  const touched = new Set<string>();
  for (const op of ops) {
    if ((op.t === "clip.add" || op.t === "clip.del") && op.clip.block_id) {
      touched.add(op.clip.block_id);
    }
  }
  if (!touched.size) return { exclude: [], include: [] };
  const video = new Set(tracks.filter((t) => t.kind === "video").map((t) => t.id));
  const live = new Set(clips
    .filter((c) => c.block_id && video.has(c.track_id))
    .map((c) => c.block_id as string));
  const ids = [...touched];
  return {
    exclude: ids.filter((id) => !live.has(id)),
    include: ids.filter((id) => live.has(id)),
  };
}

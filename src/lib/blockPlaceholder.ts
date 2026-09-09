// HOLD A NEW BLOCK'S PLACE ON THE OPEN CUT while its first render runs.
//
// The timeline's own extend and chain do this the moment the button is
// pressed: a still of the anchor's last frame goes on the lane, the clips
// after it move over, and the render lands on that clip when it arrives. A
// block the DIRECTOR adds had nothing of the kind — the sidebar said
// "generating" and the cut said nothing, for as long as the render took —
// which was reported as "it queued a block but it wasn't added to the
// timeline". This is that pre-insert, for the director's path.
//
// It runs in the BROWSER, from the dock, because that is the only place that
// can extract a frame (a canvas) and the only place that holds the open cut.
// The sync (`syncBlocksToTimeline`) then treats the placeholder exactly as it
// treats an extension's: a clip carrying `block_id` is repointed at the take
// when it lands, and its "· rendering" label is rewritten. Best effort
// throughout — a render that has already been queued must not be failed by
// a picture that could not be drawn; without one, the sync's own insert
// places the clip after its predecessor when the take arrives.
import { useTimelineStore } from "../stores/useTimelineStore";
import { supabase } from "./supabase";
import { extractAndSaveClipFrame } from "./frameExtractor";
import { blockKind, blockLabel, RENDERING_SUFFIX } from "./blockKind";
import type { GenerationBlock } from "./db/types";

/**
 * Put a placeholder for `blockId` on the cut currently open in the timeline
 * store, if that cut belongs to the block's episode and the block is not on
 * it already. Returns what it did, for the dock's own notice.
 */
export async function placeBlockPlaceholder(
  blockId: string,
): Promise<"placed" | "already" | "no-cut" | "no-anchor" | "failed"> {
  const store = useTimelineStore.getState();
  const tl = store.timeline;
  if (!tl) return "no-cut";
  if (store.clips.some((c) => c.block_id === blockId)) return "already";

  const { data: block } = await supabase.from("generation_blocks")
    .select("id,idx,storyboard_id,t_start_ms,t_end_ms,params,status")
    .eq("id", blockId).maybeSingle();
  if (!block) return "failed";
  const b = block as Pick<GenerationBlock, "id" | "idx" | "storyboard_id" | "t_start_ms"
    | "t_end_ms" | "params" | "status">;
  // The open cut must be THIS block's episode's — the store holds whichever
  // cut was opened last, and a placeholder on another episode's lane would
  // be a clip pointing at a block that cut can never lay down.
  const { data: sb } = await supabase.from("storyboards").select("episode_id")
    .eq("id", b.storyboard_id).maybeSingle();
  if (!sb || (sb as { episode_id: string }).episode_id !== tl.episode_id) return "no-cut";

  // The predecessor: the nearest EARLIER block with a clip on a video lane.
  const { data: peers } = await supabase.from("generation_blocks").select("id,idx")
    .eq("storyboard_id", b.storyboard_id).lt("idx", b.idx).order("idx", { ascending: false });
  const videoLanes = new Set(store.tracks.filter((t) => t.kind === "video").map((t) => t.id));
  let anchor = null as (typeof store.clips)[number] | null;
  for (const p of (peers ?? []) as { id: string; idx: number }[]) {
    const own = store.clips.filter((c) => c.block_id === p.id && videoLanes.has(c.track_id));
    if (!own.length) continue;
    anchor = own.reduce((m, c) => (c.t_start_ms + c.duration_ms > m.t_start_ms + m.duration_ms ? c : m));
    break;
  }
  if (!anchor) return "no-anchor";

  const durMs = Math.max(200, b.t_end_ms - b.t_start_ms);
  const label = blockLabel(blockKind(b), b.idx) + RENDERING_SUFFIX;
  try {
    const asset = store.assets.get(anchor.asset_id);
    const frame = await extractAndSaveClipFrame(anchor, asset, "last");
    const atMs = anchor.t_start_ms + anchor.duration_ms;
    // Make room first, the way the chain modal does; `insertAsset` re-packs
    // the lane afterwards, so the order of the two does not matter for the
    // result, only for the undo entry being one step.
    for (const c of store.clips.filter((x) => x.track_id === anchor!.track_id && x.t_start_ms >= atMs)) {
      store.patchClip(c.id, { t_start_ms: c.t_start_ms + durMs }, { undoable: false });
    }
    await store.insertAsset(frame, anchor.track_id, atMs, { label, durationMs: durMs, blockId: b.id });
    return "placed";
  } catch (e) {
    console.warn("block placeholder not placed", e);
    return "failed";
  }
}

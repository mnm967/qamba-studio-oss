// WHAT A NEW TAKE DOES TO THE CLIP THAT IS ALREADY ON THE LANE — the pure half
// of `syncBlocksToTimeline`'s repoint.
//
// Split out for the reason `clipAttach.ts` is: the DB half is untestable
// without a database, and the RULE is where the damage is. Both failures it
// guards are invisible until you look at the picture.
//
// THE RULE: a new take repoints the media and NEVER moves the clip.
//
// The plan places a block clip once, when it first lands. After that its
// position on the lane is the cut, and the cut is the editor's — auto-align
// packs a lane, a ripple delete pulls everything after it left, a drag puts a
// shot somewhere else, and every one of those writes `t_start_ms` and nothing
// else. The sync used to rewrite `t_start_ms` from the block whenever the clip
// read as untrimmed, and "untrimmed" was `in_ms === 0 && duration_ms ===
// blockMs`: the two fields it then wrote back UNCHANGED, with the one field it
// actually changed left out of the test. So a clip that had been MOVED but not
// cut was yanked back to the position the planner chose, over or apart from
// its neighbours, the next time a take landed on it.
//
// The clamp is what survives, and it now covers every clip rather than only
// the cut ones.

/** A clip may never be clamped away to nothing when a shorter take is
 *  adopted — a zero-length clip is unselectable, so there would be no way to
 *  fix it by hand. */
export const MIN_SYNC_MS = 200;

export interface PlacedClip {
  asset_id: string;
  duration_ms: number;
  in_ms: number | null;
}

export interface TakeSwapPatch {
  asset_id: string;
  duration_ms?: number;
  out_ms?: number;
}

/**
 * What to write onto a block clip that is adopting `assetId`.
 *
 * `mediaMs` is the incoming take's length, or null when nothing has probed it
 * yet — an uploaded take registers before `asset_ingest` runs, and clamping
 * against a length nobody has measured would cut a clip down to the floor for
 * no reason. Unknown means leave the window alone.
 *
 * `duration_ms` only ever SHRINKS, and only past the end of the take being
 * adopted: a retake can come back shorter than the one it replaces, and a clip
 * longer than its own media plays black past the end and parks the preview on
 * "buffering…". Growing it instead would silently overlap whatever is next on
 * the lane — the same rule, and the same reason, as
 * `worker/handlers/blocks.py::_attach_to_clip`.
 */
export function takeSwapPatch(
  clip: PlacedClip,
  assetId: string,
  mediaMs: number | null | undefined,
): TakeSwapPatch {
  const patch: TakeSwapPatch = { asset_id: assetId };
  if (mediaMs == null || mediaMs <= 0) return patch;
  const inMs = clip.in_ms ?? 0;
  const room = Math.max(MIN_SYNC_MS, Math.round(mediaMs) - inMs);
  if (clip.duration_ms > room) {
    patch.duration_ms = room;
    patch.out_ms = inMs + room;
  }
  return patch;
}

/* ── where a NEW block clip lands ─────────────────────────────────────── */

/**
 * The take a block clip is PINNED to, or null meaning "follow the block".
 *
 * A block can be on a cut more than once, and the reason to put a shot down
 * twice is to show two takes of it — which nothing could express, because the
 * sync repoints every clip of a block at its `active_take_id` and HAS to: that
 * repoint is how "activate this take" reaches a lane nobody had open. So a
 * hand-picked take survived until the next take landed, the next re-render or
 * the next reload, and then quietly became the block's again. `clips.take_id`
 * is the record that stops it — a record rather than something read off
 * `asset_id`, because "deliberately playing take 2" and "has not caught up to
 * take 3" look identical from outside.
 *
 * Two guards, and the second is the one that matters:
 *
 *  * no pin is the DEFAULT and always will be — every clip anything else
 *    creates has none, so this whole mechanism is inert until somebody picks;
 *  * A PIN NAMING ANOTHER BLOCK'S TAKE IS IGNORED. `take_id` is an ordinary
 *    uuid column and a clip's `block_id` moves under it — `block_from_clip`
 *    promotes a clip to a block of its own, and a copied clip carries both
 *    fields — so honouring it blindly would repoint a shot at a DIFFERENT
 *    shot's footage, which renders perfectly and is simply the wrong film.
 *    Falling back to the block's own take is the recoverable answer.
 */
export function pinnedTakeAsset(
  takeId: string | null | undefined,
  blockId: string,
  takeOf: (id: string) => { asset_id: string; block_id: string } | undefined,
): string | null {
  if (!takeId) return null;
  const take = takeOf(takeId);
  if (!take || take.block_id !== blockId) return null;
  return take.asset_id;
}

export interface LaneClip {
  id: string;
  block_id: string | null;
  track_id: string;
  t_start_ms: number;
  duration_ms: number;
  linked_clip_id?: string | null;
}

export interface PlanRow {
  id: string;
  idx: number;
  t_start_ms: number;
}

export interface Placement {
  /** where the new clip starts, on the CUT's clock */
  atMs: number;
  /** the lane it joins — its predecessor's, or the given default */
  trackId: string;
  /** clips that move right by the new clip's length to make room */
  shift: { id: string; t_start_ms: number }[];
  /** the block whose clip it was placed after, if any */
  afterBlockId: string | null;
}

/**
 * Where a block that is not on the cut yet should land, and what has to move.
 *
 * It used to land at its PLAN window. That is right for an empty cut being
 * laid down in story order and wrong for every block added afterwards: a
 * shot the director inserts between b19 and b20 gets a plan window that
 * pushes b20 onward on the PLAN's clock, while the clips already on the lane
 * stay exactly where they were — so the new clip was dropped on top of b20's
 * (or, on a re-cut, somewhere unrelated). Reported as "the block wasn't added"
 * and "it was added in the wrong place", which are the same failure seen
 * from two cuts.
 *
 * The rule now is an INSERT, the one the timeline's own chain modal performs:
 * the new clip goes right after the clip of the nearest EARLIER block that is
 * on the cut, and every clip from that point on moves right by its length. No
 * earlier block on the cut means it goes in front of the nearest later one;
 * an empty cut keeps the plan window, which is what laying a fresh episode
 * down needs.
 *
 * Pure: the sync applies the shifts (and mirrors them onto linked audio
 * halves) and inserts.
 */
export function placeNewBlockClip(
  block: PlanRow,
  blocks: readonly PlanRow[],
  laneClips: readonly LaneClip[],
  durationMs: number,
  defaultTrackId: string,
): Placement {
  const byIdx = [...blocks].sort((a, b) => a.idx - b.idx);
  const clipsOf = (id: string) => laneClips.filter((c) => c.block_id === id);
  let anchor: LaneClip | null = null;
  let afterBlockId: string | null = null;
  for (const b of byIdx.filter((x) => x.idx < block.idx).reverse()) {
    const own = clipsOf(b.id);
    if (!own.length) continue;
    // A block may be on the lane in several pieces (a split); the new shot
    // follows the LAST of them.
    anchor = own.reduce((m, c) => (c.t_start_ms + c.duration_ms > m.t_start_ms + m.duration_ms ? c : m));
    afterBlockId = b.id;
    break;
  }
  let atMs: number;
  let trackId = defaultTrackId;
  if (anchor) {
    atMs = anchor.t_start_ms + anchor.duration_ms;
    trackId = anchor.track_id;
  } else {
    let next: LaneClip | null = null;
    for (const b of byIdx.filter((x) => x.idx > block.idx)) {
      const own = clipsOf(b.id);
      if (!own.length) continue;
      next = own.reduce((m, c) => (c.t_start_ms < m.t_start_ms ? c : m));
      break;
    }
    if (next) { atMs = next.t_start_ms; trackId = next.track_id; }
    else atMs = Math.max(0, block.t_start_ms);
  }
  const shift = laneClips
    .filter((c) => c.track_id === trackId && c.t_start_ms >= atMs)
    .map((c) => ({ id: c.id, t_start_ms: c.t_start_ms + Math.max(0, Math.round(durationMs)) }));
  return { atMs, trackId, shift, afterBlockId };
}

/* ── the placeholder a clip-born block is already sitting on ───────────── */

/** A clip as the sync reads it, for the placeholder lookup below. */
export interface UnclaimedClip {
  id: string;
  block_id: string | null;
  take_id?: string | null;
  asset_id: string | null;
}

/**
 * The still a clip-born block's placeholder is holding, or null.
 *
 * The timeline's generate actions (extend, chain) park an extracted FRAME on
 * the lane the moment you press the button and name that clip in
 * `payload.target.clip_id`; the same frame is the recipe's `start_asset_id`,
 * which `_publish_clip_block` stores on the block as `params.clip_gen`. So the
 * block carries, in a column the sync already fetches, the identity of the
 * clip that is holding its place.
 *
 * `add_after` renders text-to-video and its placeholder points at the source
 * clip's own media, so there is nothing to match on — that mode is covered by
 * the worker claiming the clip instead (see `_claim_clip_for_block`).
 */
export function placeholderStillId(params: unknown): string | null {
  const p = params as { clip_gen?: { start_asset_id?: unknown } } | null | undefined;
  const id = p?.clip_gen?.start_asset_id;
  return typeof id === "string" && id ? id : null;
}

/**
 * THE PLACEHOLDER, so a landing render REPLACES it instead of arriving beside it.
 *
 * `_publish_clip_block` inserts the block and activates its take BEFORE
 * `_attach_to_clip` writes `block_id` onto the placeholder — and between those
 * two the block is exactly what the sync's insert branch is looking for: a
 * block with a kept take and no clip. The gap is not a millisecond. Sitting in
 * it is `_relabel_block_clips`, which reads and rewrites the lane label of
 * every block the insert renumbered, one sequential round trip each — seconds
 * on a long storyboard, while every one of those writes is itself a realtime
 * event waking the very query that triggers this sync. Measured on the live
 * data: all four duplicated chain/extension blocks were inserted with 33+
 * blocks after them, against an average of 30 for the ones that came out
 * clean.
 *
 * The result is two clips of one block on one cut, both playing the take —
 * "instead of just replacing the placeholder it creates duplicates".
 *
 * Adopting rather than skipping is deliberate: whoever gets there first wins
 * and the write is the same either way, so this fixes the race against a pod
 * that has not picked up the worker half yet, and cannot leave a block off the
 * cut if `_attach_to_clip` never runs.
 *
 * Only an UNCLAIMED clip is a candidate — one that already names a block is
 * that block's, and a pinned one (`take_id`) is a deliberate choice this must
 * not overwrite.
 */
export function placeholderClipFor<T extends UnclaimedClip>(
  params: unknown,
  clips: readonly T[],
  taken?: ReadonlySet<string>,
): T | null {
  const still = placeholderStillId(params);
  if (!still) return null;
  return clips.find((c) => !c.block_id && !c.take_id && c.asset_id === still
    && !(taken?.has(c.id))) ?? null;
}

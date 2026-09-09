// WHERE `stale` IS ALLOWED TO SHOW, and the arithmetic the review popup needs.
//
// `generation_blocks.status = 'stale'` is written by every director tool that
// edits a scene, a beat or the bible, and by `markSceneBlocksStale` /
// `markEntryBlocksStale` — only ever over `generated`, so a stale block HAS a
// rendered take and the picture on screen is the picture that rendered. What
// changed is the PLAN behind it.
//
// It used to be shouted from four surfaces at once: a purple subtitle on every
// shot in the sidebar, a purple clip on the timeline, a red "Stale Downstream"
// bar in the inspector, and an amber "Continuity watch" card under the shot
// list — none of which the user was doing anything about while editing, and all
// of which coloured a block whose take is perfectly good. It now lives in
// exactly two places: the STORYBOARD, which is the screen about the plan, and a
// one-line banner on the director dock that opens the review popup.
//
// `displayBlockStatus` is that rule in one function rather than a condition
// repeated per surface — the point of hiding it is that no surface remembers to
// hide it on its own, so a new one inherits the rule by asking here.
//
// SINCE 2026-09-06 IT SHOWS NOWHERE AT ALL. `STALE_UI` is off, which takes the
// last two surfaces — the storyboard and the director dock's notice bar — down
// to the same rule every working surface already followed. Nothing about the
// DATA changed: every director tool still writes `status = 'stale'`, the
// storyboard's own retake button still re-renders a scene, and the director's
// `rerender_stale` still works when it is asked for. What is suppressed is the
// user-facing CONCEPT, which was colouring blocks whose take is perfectly good
// and asking for a decision nobody was making.
//
// Flip `STALE_UI` back to true to restore both surfaces; that is the whole
// switch, which is why the storyboard and the scene editor ask
// `planBlockStatus` rather than testing the flag themselves.

/** Is `stale` allowed on screen anywhere? Off — see the header. */
export const STALE_UI = false;

/** What a working surface (shot sidebar, timeline clip, inspector) should call
 *  a block. Stale reads as what it actually is on screen: a rendered block
 *  whose take is still there. */
export function displayBlockStatus(status: string | null | undefined, hasTake: boolean): string {
  const st = status ?? "generated";
  if (st !== "stale") return st;
  // A stale block only ever came from `generated`, so `hasTake` is the normal
  // case — but a take deleted out from under it would otherwise read as
  // "generated" over an empty thumbnail, which is the one thing worse than
  // saying "stale".
  return hasTake ? "generated" : "planned";
}

/** What a PLAN surface (the storyboard, the scene editor) should call a block.
 *
 *  These two used to be the exception — the screens ABOUT the plan, where a
 *  block whose plan has moved on is the actual subject. While `STALE_UI` is off
 *  they are not an exception, and they ask here rather than testing the flag so
 *  that turning it back on restores them both in one place. */
export function planBlockStatus(status: string | null | undefined, hasTake: boolean): string {
  return STALE_UI ? (status ?? "generated") : displayBlockStatus(status, hasTake);
}

export interface ChainRow {
  id: string;
  idx: number;
  chain_from_block_id: string | null;
}

/** Stale blocks a selection chains FROM but has left out.
 *
 *  A chained block opens on its predecessor's final frame, and the envelope
 *  declares that frame `fully_preserved` — so re-rendering b8 while b7 is still
 *  stale continues from the take b7 is about to replace, and whatever b7
 *  invented stays canon in b8. That is the same mechanism as CLAUDE.md's
 *  "dressing the plate does not reach a chained block", one layer up, and it is
 *  invisible in the output: b8 renders fine, from the wrong opening frame.
 *
 *  Reported rather than force-included: a partial re-render is a legitimate
 *  thing to want (the GPU bills by the hour), so the popup names the gap and
 *  offers to close it. Walks the whole chain, so selecting b9 alone reports b7
 *  and b8 when both are stale. */
export function missingChainParents(
  selectedIds: readonly string[], stale: readonly ChainRow[],
): ChainRow[] {
  const byId = new Map(stale.map((b) => [b.id, b]));
  const chosen = new Set(selectedIds);
  const gap = new Map<string, ChainRow>();
  for (const id of selectedIds) {
    let at = byId.get(id);
    // `seen` per walk, because a `chain_from_block_id` cycle is expressible in
    // the column and an unbounded walk hangs the popup rather than mis-reporting
    // it. Filling `gap` is not a guard: a cycle whose members are all gaps
    // re-enters them forever.
    const seen = new Set<string>(at ? [at.id] : []);
    // Follow the chain up while every step is itself stale: a parent that has
    // already re-rendered is a fine anchor and ends the walk.
    while (at?.chain_from_block_id) {
      const parent = byId.get(at.chain_from_block_id);
      if (!parent || chosen.has(parent.id) || seen.has(parent.id)) break;
      seen.add(parent.id);
      gap.set(parent.id, parent);
      at = parent;
    }
  }
  return [...gap.values()].sort((a, b) => a.idx - b.idx);
}

/** Seconds of footage a selection re-renders — what the queue button prices. */
export function selectedSeconds(
  selectedIds: readonly string[],
  blocks: readonly { id: string; t_start_ms: number; t_end_ms: number }[],
): number {
  const chosen = new Set(selectedIds);
  return blocks
    .filter((b) => chosen.has(b.id))
    .reduce((t, b) => t + Math.max(0, b.t_end_ms - b.t_start_ms) / 1000, 0);
}

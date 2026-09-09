// Which takes the wall is showing.
//
// The multiview has a fixed number of cells and a block can have more takes
// than that, so "the first four" is a default rather than an answer — the take
// worth watching beside the one in the cut is routinely the seventh. This is
// the little bit of bookkeeping that lets a slot be pointed at any take:
// normalise a stored selection against the takes that actually exist, and
// change one slot without ever showing the same take twice.
//
// Pure and dependency-free so it can be unit-tested. Both failures here are
// silent rather than loud — a stale id renders an empty square that reads as a
// broken video, and a duplicate renders the same take twice on a wall whose
// whole job is to show you different ones.

/** The takes the cells should show: `picked` first (dropping anything that no
 *  longer exists and any repeat), then the rest in bench order, up to `n`.
 *
 *  So an empty selection is "the first n", a partial one keeps what was chosen
 *  and fills the gaps, and a take deleted out from under the wall is replaced
 *  rather than leaving a hole. */
export function pickCells(ids: readonly string[], picked: readonly string[], n: number): string[] {
  const have = new Set(ids);
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (id: string) => {
    if (out.length >= n || seen.has(id) || !have.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of picked) take(id);
  for (const id of ids) take(id);
  return out;
}

/** Point one cell at `takeId`.
 *
 *  A take already on the wall TRADES PLACES with the one being replaced rather
 *  than appearing twice — which is both what a video wall does and the only
 *  answer that keeps the invariant `pickCells` guarantees. Anything else would
 *  have to drop a take the user is watching to make room. */
export function swapCell(cells: readonly string[], slot: number, takeId: string): string[] {
  const out = [...cells];
  if (slot < 0 || slot >= out.length || out[slot] === takeId) return out;
  const other = out.indexOf(takeId);
  if (other >= 0) out[other] = out[slot];
  out[slot] = takeId;
  return out;
}

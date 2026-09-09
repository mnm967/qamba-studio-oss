// RIPPLE DELETE across several clips at once — the pure half.
//
// Split out for the reason `avlink.ts`, `marquee.ts` and `clipFrames.ts` are:
// the store does the writing, and this is the part with arithmetic. It is also
// the part that cannot be checked by looking. A ripple that shifts by the
// wrong distance does not throw — the lane simply comes out overlapping
// itself, the player picks one clip per frame, and a shot is missing from the
// cut with nothing anywhere saying so.
import type { Clip } from "./db/types";

type Placed = Pick<Clip, "id" | "track_id" | "t_start_ms" | "duration_ms">;

/**
 * Where each surviving clip lands once `doomed` is gone, in ONE pass.
 *
 * Every survivor is pulled left by the total length of everything deleted
 * BEFORE it on its own lane. Doing this clip by clip instead — calling the
 * single-clip ripple once per deletion — measures each gap against a lane an
 * earlier pass has already closed, so the second deletion shifts by a distance
 * that no longer exists and the lane ends up overlapping itself.
 *
 * Only clips that actually move are returned, so a delete confined to one lane
 * writes nothing on the others.
 */
export function rippleShifts(
  survivors: readonly Placed[],
  doomed: readonly Placed[],
): { id: string; t_start_ms: number }[] {
  if (!doomed.length) return [];
  const out: { id: string; t_start_ms: number }[] = [];
  for (const c of survivors) {
    let shift = 0;
    for (const d of doomed) {
      // Strictly BEFORE: a clip that starts where a deleted one did is not
      // behind it, and pulling it left would put it on top of its neighbour.
      if (d.track_id === c.track_id && d.t_start_ms < c.t_start_ms) shift += d.duration_ms;
    }
    if (shift) out.push({ id: c.id, t_start_ms: Math.max(0, c.t_start_ms - shift) });
  }
  return out;
}

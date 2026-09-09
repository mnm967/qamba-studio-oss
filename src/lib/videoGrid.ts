// THE FRAME GRID A MODEL RENDERS ON — the arithmetic behind a duration
// control that cannot ask for a length the model refuses.
//
// Distinct from clipFrames.ts on purpose: that one answers "which frame of the
// source does this CLIP show", this one answers "what lengths can this MODEL
// produce". They meet only at the point where an extend or a chain turns a
// frame into a render.
//
// Invariant #5's generic form. H3 is 17n+5 at 24fps, LTX 2.5 is 8n+1 at 24,
// and every catalog row already declares `fps` / `frame_base` / `frame_rem` —
// the numbers were simply never read outside GenComposer, so every other
// duration control in the app quoted H3's grid at whatever was selected.
import type { ModelCatalogRow } from "./db/types";

/** H3's own ceiling, and the fallback for a row that declares no
 *  `max_seconds`. 365 is the frame count invariant #5 tops out at. */
export const DEFAULT_MAX_FRAMES = 365;

export interface FrameGrid {
  fps: number;
  /** legal counts are `base * n + rem` */
  base: number;
  rem: number;
  /** the shortest and longest legal counts, both ON the grid */
  minFrames: number;
  maxFrames: number;
  /**
   * Whether the row actually DECLARED its grid.
   *
   * Several do not — Wan 2.2 and both LTX 2.3 rows carry `frame_base: null`
   * while their real grids are neither H3's nor each other's (Wan is 4n+1 at
   * 16fps). Defaulting them to 17n+5 and printing a frame count would be
   * stating a number nobody knows: the worker re-derives the count from the
   * duration off `model_map`, which may declare a grid the catalog row does
   * not. So an undeclared grid is FREE — every frame count is offered — and
   * the caller is expected to say the length will be rounded on the pod
   * rather than quoting a grid it cannot see.
   */
  exact: boolean;
}

/** Read a model's grid, defaulting to H3's — which is what every caller
 *  assumed before the columns were read. A corrupt or missing value falls back
 *  rather than producing a NaN length nobody can see is wrong. */
export function frameGrid(model?: ModelCatalogRow | null): FrameGrid {
  const num = (v: unknown, dflt: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
  const fps = num(model?.fps, 24);
  const base = Math.max(1, Math.round(num(model?.frame_base, 17)));
  // `frame_rem` of 0 is legal and NOT missing (a plain multiple-of-base grid),
  // so it cannot go through the >0 guard above.
  const rawRem = model?.frame_rem;
  const rem = typeof rawRem === "number" && Number.isFinite(rawRem) && rawRem >= 0
    ? Math.round(rawRem) : 5;
  const ceiling = model?.max_seconds != null && model.max_seconds > 0
    ? Math.floor(model.max_seconds * fps)
    : DEFAULT_MAX_FRAMES;
  // `fps` is declared by every row; `frame_base` is not, and its absence is
  // what `exact` records. An undeclared grid accepts any count.
  const exact = model?.frame_base != null;
  const g: FrameGrid = exact
    ? { fps, base, rem, minFrames: 0, maxFrames: 0, exact }
    : { fps, base: 1, rem: 1, minFrames: 0, maxFrames: 0, exact };
  // The shortest legal count: `rem` itself, unless that is zero frames — a
  // render of nothing — in which case the first real step.
  g.minFrames = g.rem > 0 ? g.rem : g.base;
  g.maxFrames = Math.max(g.minFrames, snapFrames(g, ceiling, "down"));
  return g;
}

/** Put a count on the grid. `down` never exceeds the input (what a ceiling
 *  wants), `up` never falls short (what a requested length wants). */
export function snapFrames(g: FrameGrid, frames: number, dir: "round" | "up" | "down" = "round"): number {
  const n = (frames - g.rem) / g.base;
  const k = Math.max(0, dir === "up" ? Math.ceil(n) : dir === "down" ? Math.floor(n) : Math.round(n));
  // Never below the shortest legal count — a `down` snap of something tiny
  // would otherwise land on zero frames, i.e. a render of nothing.
  return Math.max(g.rem > 0 ? g.rem : g.base, g.base * k + g.rem);
}

/**
 * Milliseconds for a frame count — FLOORED, and that is load-bearing.
 *
 * The worker re-derives the count from the duration we send
 * (`resolve.frame_count`, which rounds UP and then pads onto the grid). Round
 * to nearest here and a 22-frame request at 24fps goes out as 917ms, comes
 * back as `ceil(22.008) = 23`, pads to the NEXT legal count and renders 39
 * frames — 77% longer than the slider said. Flooring makes the round trip
 * exact: 916ms -> ceil(21.984) = 22 -> 22.
 */
export function framesToMs(g: FrameGrid, frames: number): number {
  return Math.floor((frames * 1000) / g.fps);
}

/** Milliseconds -> the nearest legal count, clamped to the model's range. */
export function msToFrames(g: FrameGrid, ms: number): number {
  const raw = snapFrames(g, Math.round((ms * g.fps) / 1000), "round");
  return Math.min(g.maxFrames, Math.max(g.minFrames, raw));
}

/** How many positions a slider over this grid has. */
export const gridSteps = (g: FrameGrid) => Math.floor((g.maxFrames - g.minFrames) / g.base) + 1;

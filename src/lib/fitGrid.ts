// Fitting pictures into a box without cropping or stretching them.
//
// Every surface on the assembly bench that shows a MOVING picture — the stage
// and the multiview — has to answer the same question: given this much room
// and this many frames of this shape, how big is one frame? Answering it in
// CSS is the trap: a grid track sized `1fr` hands a 16:9 render a cell that is
// taller than it is wide, and whichever of `cover` / `contain` you then pick
// the picture is either cut in half or floating in a field of black. Neither
// reads as the take.
//
// So the layout is computed, and it is computed the way a video wall is: try
// every column count, size the cell to whichever axis runs out first, and keep
// the arrangement that makes the picture BIGGEST. Two takes in a tall column
// stack; four in a short one go 4-across. Nothing is ever cropped, and the
// frame's border hugs the image rather than the track.
//
// Pure and dependency-free so it can be unit-tested — a layout that silently
// returns zero is a blank screen, which is the failure that looks like a
// broken video rather than a broken calculation.

export interface Box { w: number; h: number }

export interface Fit {
  /** columns the cells were laid out in (0 when nothing fits) */
  cols: number;
  rows: number;
  /** one cell, in CSS pixels, already rounded */
  w: number;
  h: number;
}

const EMPTY: Fit = { cols: 0, rows: 0, w: 0, h: 0 };

/** 16:9 — what every video model in this studio renders by default, and the
 *  only honest guess before a file has reported its own dimensions. */
export const DEFAULT_AR = 16 / 9;

/** Aspect ratio from a pair that may be null, unknown or nonsense.
 *
 *  A zero or missing dimension is the common case, not an edge one: `assets`
 *  rows written before `asset_ingest` probed geometry carry nulls, and a
 *  ratio of 0 collapses every cell to nothing. */
export function aspectOf(w?: number | null, h?: number | null, fallback = DEFAULT_AR): number {
  if (!w || !h || w <= 0 || h <= 0) return fallback;
  const ar = w / h;
  // Guard the absurd rather than the merely unusual: a 32:1 banner is a real
  // render, a ratio of 400 is a corrupt probe.
  return ar > 0.02 && ar < 50 ? ar : fallback;
}

/** Largest cell of aspect `ar` such that `n` of them tile `box` with `gap`
 *  between, trying every column count. */
export function fitGrid(box: Box, n: number, ar: number, gap = 0): Fit {
  if (n <= 0 || box.w <= 0 || box.h <= 0) return EMPTY;
  const r = ar > 0 ? ar : DEFAULT_AR;
  let best = EMPTY;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const availW = (box.w - gap * (cols - 1)) / cols;
    const availH = (box.h - gap * (rows - 1)) / rows;
    if (availW <= 0 || availH <= 0) continue;
    // Whichever axis runs out first decides the cell; the other gets slack.
    const w = Math.min(availW, availH * r);
    if (w <= best.w) continue;          // ties keep the earlier (fewer-column) layout
    best = { cols, rows, w, h: w / r };
  }
  if (best.cols === 0) return EMPTY;
  // Down to hundredths, never up: a cell rounded up overflows its row and a
  // grid that overflows by a pixel scrolls. Rounding to WHOLE pixels is what
  // this cannot do — flooring width and height independently distorts a small
  // cell (a 99.5x55.97 tile becomes 99x55, which is 16:8.9, visibly off) and
  // the distortion is exactly what the module exists to prevent.
  const down = (v: number) => Math.floor(v * 100) / 100;
  return { ...best, w: down(best.w), h: down(best.h) };
}

/** The single-picture case: the biggest box of aspect `ar` that fits. */
export function fitBox(box: Box, ar: number): Fit {
  return fitGrid(box, 1, ar, 0);
}

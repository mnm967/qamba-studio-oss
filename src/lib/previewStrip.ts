/**
 * Reading a sampler-preview sheet back into cells.
 *
 * The Python twin is `worker/comfy_nodes/neon_h3_preview/strip.py`, which
 * BUILDS the sheet; `worker/tests/test_h3_preview_strip.py` pins the pair. The
 * two halves are written in different languages and a disagreement is not an
 * error — it is a preview cropped into the wrong quarter of itself.
 *
 * WHY THE ASPECT RATIO IS ENOUGH, and why there is no metadata to read
 * instead: a preview arrives here as a bare JPEG URL. ComfyUI's wire format is
 * `4-byte event | 4-byte image format | image` and carries nothing else,
 * `jobs.preview_key` is written once per job, and the B2 bucket sends no ACAO
 * so the pixels cannot be drawn into a canvas and measured. All that is ever
 * available is `naturalWidth x naturalHeight`.
 *
 * So the worker encodes the layout in exactly that: THE STRIP RUNS ALONG THE
 * FRAME'S LONG AXIS. A horizontal sheet is only ever built from cells with
 * `cellAr >= 1`, so its own aspect is `n * cellAr >= n`; a vertical one only
 * from `cellAr < 1`, so its aspect is `cellAr / n < 1/n`. An un-tiled preview
 * therefore lands strictly inside `[1/n, n]` — at n = 4 that is 0.25..4.0,
 * against a widest real render of 1.77:1 and a narrowest of 0.57:1
 * (`H3_NATIVE_DIMS` and its portrait flip).
 *
 * That has to hold for previews the pod never tiled, which is most of them:
 * this runs for every job in the queue, and a Krea 2 still or a Wan clip comes
 * through core's own previewer as a single frame.
 */

/** Cells per strip. Must match `NEON_H3_PREVIEW_FRAMES` on the pod. */
export const STRIP_FRAMES = 4;

/** Slack on the comparison: core's `ImageOps.contain` rounds to whole pixels
 *  and a square-celled strip sits exactly on the boundary. The gap to a real
 *  render is enormous either way. */
export const DETECT_SLACK = 0.9;

export type StripLayout = {
  cols: number;
  rows: number;
  /** cols * rows — 1 for an ordinary single-frame preview. */
  cells: number;
  /** The shape of ONE cell, i.e. of the render. Drives the preview box. */
  cellAr: number;
};

/** How a published sheet is laid out, from its pixel size alone. */
export function readStrip(w: number, h: number,
                          frames = STRIP_FRAMES, slack = DETECT_SLACK): StripLayout {
  const n = Math.max(1, Math.floor(frames));
  const plain = (ar: number): StripLayout => ({ cols: 1, rows: 1, cells: 1, cellAr: ar });
  if (!(w > 0) || !(h > 0)) return plain(0);
  const ar = w / h;
  if (n < 2) return plain(ar);
  if (ar >= n * slack) return { cols: n, rows: 1, cells: n, cellAr: ar / n };
  if (ar <= 1 / (n * slack)) return { cols: 1, rows: n, cells: n, cellAr: ar * n };
  return plain(ar);
}

/**
 * Where cell `i` sits, as styles for an `<img>` inside an overflow-hidden box.
 *
 * The sheet stays an `<img>` rather than becoming a CSS background: the frames
 * have to stay DECODED and mounted (that is what makes the scrub cost no
 * network on a bucket that refuses `fetch`), and only an element gives us
 * `onLoad` with the natural size this whole module reads. So it is oversized
 * along the strip axis and slid, which crops to one cell with no canvas.
 *
 * A single-frame preview returns the box exactly — 100%/100% at the origin —
 * so there is one code path and no branch at the call site.
 */
export function cellBox(layout: StripLayout, i: number) {
  const idx = Math.max(0, Math.min(i, layout.cells - 1));
  return {
    width: `${layout.cols * 100}%`,
    height: `${layout.rows * 100}%`,
    left: `${-(idx % layout.cols) * 100}%`,
    top: `${-Math.floor(idx / layout.cols) * 100}%`,
  };
}

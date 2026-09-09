"""Storyboard/turnaround grid geometry — pure math, no pod dependencies.

One grid image carries every panel of a scene (or every view of a character),
so grade, faces and staging agree across panels BY CONSTRUCTION — the property
per-panel generation can only approximate. The image side renders the grid
with bold borders and white gutters (models keep panels separated much more
reliably when the separation is drawn), and this module answers the two
questions that must agree on both sides of that render:

  - layout/dims: how many rows x cols, and what pixel size to request so each
    panel keeps the video's aspect ratio inside a sane total budget;
  - slice_boxes: where each panel's pixels are, with an inset margin that
    shaves the drawn borders/gutters off the crop no matter how thickly the
    model drew them.

Slicing crops an inset REGION of the ideal cell rather than detecting edges:
gutter detection fails exactly when the model blends a panel boundary, which
is the case the inset absorbs silently.
"""

MAX_PANELS = 9          # 3x3 — larger grids drop per-panel fidelity too far
INSET_PCT = 0.035       # crop margin per side, as a fraction of the cell
PIXEL_BUDGET = 2_200_000  # ~2.2MP total — where the image families stay sharp
SNAP = 32               # every family's dim step divides 32


def grid_layout(n):
    """(rows, cols) for n panels, read left-to-right, top-to-bottom."""
    n = max(1, min(MAX_PANELS, int(n)))
    if n <= 2:
        return 1, n
    if n <= 4:
        return 2, 2
    if n <= 6:
        return 2, 3
    return 3, 3


def grid_dims(rows, cols, panel_ar=1280 / 704, budget=PIXEL_BUDGET, snap=SNAP):
    """Grid (W, H) whose cells keep panel_ar, total area <= budget, snapped.

    The snap floors (never rounds up): budget is a ceiling, and a cell a few
    pixels short of the ideal ratio is invisible where a budget overrun is a
    soft-degraded render.
    """
    # cell height h: rows*cols cells of (ar*h x h) => area = rows*cols*ar*h^2
    h = (budget / (rows * cols * panel_ar)) ** 0.5
    ph = max(snap, int(h) // snap * snap)
    pw = max(snap, int(ph * panel_ar) // snap * snap)
    return pw * cols, ph * rows, pw, ph


def slice_boxes(width, height, rows, cols, n, inset_pct=INSET_PCT):
    """Crop boxes [(x, y, w, h), …] for panels 1..n of a rows x cols grid.

    Cells are ideal fractions of the actual rendered size (which may differ
    from the requested size — families snap dims), inset on every side so the
    drawn gutters and borders stay out of the panel.
    """
    n = max(1, min(rows * cols, int(n)))
    cw, ch = width / cols, height / rows
    ix, iy = cw * inset_pct, ch * inset_pct
    boxes = []
    for k in range(n):
        r, c = divmod(k, cols)
        x0, y0 = c * cw + ix, r * ch + iy
        x1, y1 = (c + 1) * cw - ix, (r + 1) * ch - iy
        boxes.append((int(round(x0)), int(round(y0)),
                      int(round(x1 - x0)), int(round(y1 - y0))))
    return boxes


SEAM_SEARCH = 0.03      # look this fraction of the span either side of a seam
SEAM_DARK_RATIO = 0.5   # a drawn gutter is at most this fraction of the median


def seam_darkness(pixels, width, height, rows, cols):
    """(row_ratios, col_ratios) for each expected interior boundary.

    `pixels` is a greyscale row-major sequence of length width*height. Each
    ratio is (darkest line found near that boundary) / (image median line),
    so a drawn black gutter scores ~0 and picture content scores ~1 or more.
    Measured on two real grids: a good 2x2 scored 0.00 on both seams, while a
    2x3 the model rendered as ONE row scored 0.00 on its two real column
    seams and 1.30 on the row seam that was never drawn. Pure."""
    step = max(1, height // 256)
    rowmean = [sum(pixels[y * width:(y + 1) * width]) / width
               for y in range(0, height, step)]
    ys = range(0, height, max(1, height // 64))
    colmean = [sum(pixels[y * width + x] for y in ys) / len(ys)
               for x in range(0, width, max(1, width // 256))]

    def ratios(n, series, span):
        med = sorted(series)[len(series) // 2] or 1.0
        out = []
        scale = len(series) / span
        for i in range(1, n):
            centre = int(span * i / n * scale)
            w = max(2, int(span * SEAM_SEARCH * scale))
            seg = series[max(0, centre - w):centre + w] or [med]
            out.append(min(seg) / med)
        return out

    return (ratios(rows, rowmean, height), ratios(cols, colmean, width))


def verify_grid(pixels, width, height, rows, cols):
    """Did the model actually draw the grid we asked for? -> (ok, reason).

    Slicing assumes the requested layout. When the model ignores it — and it
    does: a requested 2x3 came back as ONE row of three character portraits,
    so panel 4 was the bottom half of panel 1 — every sliced panel is
    garbage, and it is garbage that then rides into the render as a
    'storyboard reference'. Nothing downstream can tell. This is the check.

    Deliberately weak: it asks whether a dark seam EXISTS near each expected
    boundary, not exactly where it is. Locating precise edges is the thing
    that fails when a model blends a gutter (which is why slicing uses ideal
    cells plus an inset); noticing that an entire row of seams is missing is
    robust, and it is the failure that actually happens."""
    rs, cs = seam_darkness(pixels, width, height, rows, cols)
    weak_r = [i + 1 for i, v in enumerate(rs) if v > SEAM_DARK_RATIO]
    weak_c = [i + 1 for i, v in enumerate(cs) if v > SEAM_DARK_RATIO]
    if weak_r or weak_c:
        bits = []
        if weak_r:
            bits.append(f"no horizontal seam at row boundary {weak_r}")
        if weak_c:
            bits.append(f"no vertical seam at column boundary {weak_c}")
        return False, (f"expected a {rows}x{cols} grid but {'; '.join(bits)} "
                       f"(row darkness {[round(v, 2) for v in rs]}, "
                       f"col darkness {[round(v, 2) for v in cs]})")
    return True, ""


ANGLE_VIEWS = [
    "front full-body, standing relaxed, arms at sides",
    "back full-body, same stance",
    "left profile full-body",
    "right three-quarter full-body",
    "face close-up, front, neutral expression",
    "face close-up, right three-quarter, slight natural expression",
]


def turnaround_layout():
    """(rows, cols, views) for the character turnaround sheet — fixed 2x3."""
    return 2, 3, list(ANGLE_VIEWS)

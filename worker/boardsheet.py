"""Compose a block's per-shot panels into ONE numbered storyboard board.

The Krea 2 route to a segment storyboard (`block_sheet` in h3_prompt): the
shots are rendered one panel each through the identity-edit path — every
panel restaged from the SAME character sheet with the same seed ladder and
the same style clause — and then laid into a labelled grid the way The AI
Brief's `SceneBoardCompose` does (dark gutters, a small tag in each panel's
top-left corner), numbered 1..N in shot order because that is the grammar the
compiled envelope binds to ("the shot cuts to panel 3 of <Picture 2>").

Two things this module is careful about, both measured:

  * TILED PANELS THAT DISAGREE ARE WORSE THAN NO SHEET. Rei E3 b13's four
    panels (drawn separately, on the old reference path) spanned 95.6deg of
    hue and three times of day; tiled into one sheet and staged as
    `fully_preserved`, they handed H3 four different films. So `grade_spread`
    measures the panels FIRST — circular hue spread of the mean colour per
    panel, plus the range of mean brightness — and `handle_sheet_compose`
    refuses to attach a board past `MAX_HUE_SPREAD`, with the numbers in the
    log. A missing sheet is recoverable; a confidently wrong one is canon for
    every block downstream of it.
  * THE LABEL IS SMALL AND IN A CORNER. The sheet's cells are read by H3 at
    a quarter of their resolution or less; a label bar above each panel (the
    reference pack's default) is ~10% of a cell spent on a number the model
    only has to find, not read. A tag in the corner costs nothing and the
    envelope disclaims "printed panel numbers" terminally anyway.

Pure geometry + PIL. Nothing here reads the database; the handler in
handlers/images.py does the fetching and the attaching.
"""
import colorsys
import math

from gridsheet import grid_layout

GUTTER = 8
BG = (8, 10, 14)            # #080a0e, the pack's own board background
LABEL_FILL = (0, 0, 0)
LABEL_TEXT = (240, 240, 240)
# Widest board the sheet path ever asks for: the gpt-image sheet is 1536x1024
# and H3 scales any reference to the render's own area, so a wider board only
# costs upload bytes. 2048 keeps a 3x3 of 1280x704 panels at ~660px per cell.
MAX_BOARD_W = 2048
# Hue spread (degrees, circular std of the panels' mean hues) past which the
# panels are not one film and the board is refused. b13's disagreeing set
# measured 95.6; a gpt-image sheet of the same beats measured 4.4-14.4; the
# identity-edit panels of one location should land far under this.
MAX_HUE_SPREAD = 45.0


def _font(size):
    from PIL import ImageFont
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/System/Library/Fonts/Menlo.ttc",
                 "/Library/Fonts/Arial.ttf"):
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:  # noqa: BLE001 — try the next one
            continue
    return ImageFont.load_default()


def board_geometry(n, panel_w, panel_h, *, gutter=GUTTER, max_w=MAX_BOARD_W):
    """(rows, cols, cell_w, cell_h, board_w, board_h) for n panels of the
    given aspect. Cells keep the panel aspect and shrink until the board fits
    `max_w`. Pure."""
    rows, cols = grid_layout(n)
    ar = panel_w / float(panel_h)
    cell_w = min(panel_w, int((max_w - (cols + 1) * gutter) / cols))
    cell_w -= cell_w % 2
    cell_h = int(round(cell_w / ar))
    cell_h -= cell_h % 2
    board_w = cols * cell_w + (cols + 1) * gutter
    board_h = rows * cell_h + (rows + 1) * gutter
    return rows, cols, cell_w, cell_h, board_w, board_h


def cell_box(index, rows, cols, cell_w, cell_h, *, gutter=GUTTER):
    """(x, y) of panel `index` (0-based, row-major). Pure."""
    r, c = divmod(index, cols)
    return gutter + c * (cell_w + gutter), gutter + r * (cell_h + gutter)


def compose(panels, out_path, *, labels=None, gutter=GUTTER):
    """panels: [PIL.Image or None] in shot order (None = a held/breath shot,
    drawn as a black cell so the numbering stays 1:1 with the shots). Writes
    a PNG to `out_path` and returns (board_w, board_h)."""
    from PIL import Image, ImageDraw
    n = len(panels)
    if n == 0:
        raise ValueError("no panels to compose")
    first = next((p for p in panels if p is not None), None)
    pw, ph = (first.size if first is not None else (1280, 704))
    rows, cols, cw, ch, bw, bh = board_geometry(n, pw, ph, gutter=gutter)
    board = Image.new("RGB", (bw, bh), BG)
    draw = ImageDraw.Draw(board)
    font = _font(max(14, min(28, ch // 12)))
    for i, p in enumerate(panels):
        x, y = cell_box(i, rows, cols, cw, ch, gutter=gutter)
        if p is not None:
            tile = p.convert("RGB")
            if tile.size != (cw, ch):
                # letterbox rather than stretch: a stretched panel is a wrong
                # composition, and H3 reads the composition
                tile = _fit(tile, cw, ch)
            board.paste(tile, (x, y))
        else:
            draw.rectangle([x, y, x + cw - 1, y + ch - 1], fill=(0, 0, 0))
        label = (labels[i] if labels and i < len(labels) else str(i + 1))
        tw = draw.textlength(label, font=font)
        pad = 6
        draw.rectangle([x + 6, y + 6, x + 6 + tw + pad * 2, y + 6 + font.size + pad],
                       fill=LABEL_FILL)
        draw.text((x + 6 + pad, y + 6 + pad // 2), label, fill=LABEL_TEXT, font=font)
    board.save(out_path, format="PNG")
    return bw, bh


def _fit(img, w, h):
    from PIL import Image
    iw, ih = img.size
    s = min(w / iw, h / ih)
    nw, nh = max(1, int(iw * s)), max(1, int(ih * s))
    resized = img.resize((nw, nh), Image.LANCZOS)
    out = Image.new("RGB", (w, h), (0, 0, 0))
    out.paste(resized, ((w - nw) // 2, (h - nh) // 2))
    return out


def _mean_hsv(img):
    """(mean hue deg, mean sat 0-255, mean val 0-255) of a downscaled copy —
    the same 48x27 reduction the panel-variety measurement measures with."""
    small = img.convert("RGB").resize((48, 27))
    hs, ss, vs = [], [], []
    for r, g, b in small.getdata():
        h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        # weight hue by saturation so a grey panel does not vote a random hue
        hs.append((h * 360.0, s))
        ss.append(s * 255)
        vs.append(v * 255)
    # circular mean of hue, saturation-weighted
    sx = sum(math.cos(math.radians(h)) * w for h, w in hs)
    sy = sum(math.sin(math.radians(h)) * w for h, w in hs)
    hue = math.degrees(math.atan2(sy, sx)) % 360.0
    return hue, sum(ss) / len(ss), sum(vs) / len(vs)


def grade_spread(images):
    """{hue_spread, sat_range, val_range, n} across the panels.

    hue_spread is the circular standard deviation (degrees) of the panels'
    saturation-weighted mean hues; sat/val ranges are max-min of the means.
    Pure over PIL images; returns zeros for fewer than two panels."""
    stats = [_mean_hsv(im) for im in images if im is not None]
    n = len(stats)
    if n < 2:
        return {"hue_spread": 0.0, "sat_range": 0.0, "val_range": 0.0, "n": n}
    cx = sum(math.cos(math.radians(h)) for h, _s, _v in stats) / n
    cy = sum(math.sin(math.radians(h)) for h, _s, _v in stats) / n
    r = min(1.0, math.hypot(cx, cy))
    hue_spread = math.degrees(math.sqrt(-2.0 * math.log(r))) if r > 1e-9 else 180.0
    sats = [s for _h, s, _v in stats]
    vals = [v for _h, _s, v in stats]
    return {"hue_spread": round(hue_spread, 1), "sat_range": round(max(sats) - min(sats), 1),
            "val_range": round(max(vals) - min(vals), 1), "n": n}


def coherent(spread, *, max_hue=MAX_HUE_SPREAD):
    """Whether panels measuring `spread` may be staged as ONE sheet."""
    return spread.get("n", 0) < 2 or spread.get("hue_spread", 0.0) <= max_hue

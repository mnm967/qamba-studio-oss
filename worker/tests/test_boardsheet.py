"""The composed segment storyboard: geometry, labels, and the agreement gate.

The gate is the point. Tiling panels that disagree was measured worse than
staging no sheet (Rei E3 b13: four panels, 95.6deg of hue, three times of
day), so a board is refused before it exists. The synthetic panels here are
flat colours, which is what makes the hue arithmetic checkable by hand.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import boardsheet as BS  # noqa: E402

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402


def _panel(rgb, size=(1280, 704)):
    return Image.new("RGB", size, rgb)


def test_geometry_keeps_the_panel_aspect_and_fits_the_board_width():
    rows, cols, cw, ch, bw, bh = BS.board_geometry(6, 1280, 704)
    assert (rows, cols) == (2, 3)
    assert abs(cw / ch - 1280 / 704) < 0.02
    assert bw <= BS.MAX_BOARD_W
    assert cw % 2 == 0 and ch % 2 == 0
    # a single wide panel is never enlarged past its own size
    assert BS.board_geometry(1, 640, 352)[2] == 640


def test_cells_are_row_major_with_a_gutter():
    rows, cols, cw, ch, _bw, _bh = BS.board_geometry(4, 1280, 704)
    assert BS.cell_box(0, rows, cols, cw, ch) == (BS.GUTTER, BS.GUTTER)
    assert BS.cell_box(1, rows, cols, cw, ch) == (BS.GUTTER * 2 + cw, BS.GUTTER)
    assert BS.cell_box(2, rows, cols, cw, ch) == (BS.GUTTER, BS.GUTTER * 2 + ch)


def test_compose_writes_every_cell_and_blacks_out_a_hold(tmp_path):
    out = tmp_path / "board.png"
    bw, bh = BS.compose([_panel((200, 40, 40)), None, _panel((40, 200, 40))], str(out))
    with Image.open(out) as im:
        assert im.size == (bw, bh)
        rows, cols, cw, ch, _, _ = BS.board_geometry(3, 1280, 704)
        # sample the middle of each cell: red, black, green
        for i, want in enumerate([(200, 40, 40), (0, 0, 0), (40, 200, 40)]):
            x, y = BS.cell_box(i, rows, cols, cw, ch)
            got = im.getpixel((x + cw // 2, y + ch // 2))
            assert max(abs(a - b) for a, b in zip(got, want)) < 6, (i, got, want)
        # the label tag sits in the top-left corner of each cell, dark on light
        x, y = BS.cell_box(0, rows, cols, cw, ch)
        assert im.getpixel((x + 8, y + 8)) == (0, 0, 0)


def test_grade_spread_separates_one_film_from_four():
    one = [_panel((180, 120, 60)), _panel((170, 110, 70)), _panel((190, 130, 50))]
    four = [_panel((200, 30, 30)), _panel((30, 200, 30)), _panel((30, 30, 200)), _panel((200, 200, 30))]
    s1, s4 = BS.grade_spread(one), BS.grade_spread(four)
    assert s1["hue_spread"] < 10 and BS.coherent(s1)
    assert s4["hue_spread"] > BS.MAX_HUE_SPREAD and not BS.coherent(s4)
    assert BS.grade_spread([_panel((1, 2, 3))])["n"] == 1
    assert BS.coherent(BS.grade_spread([None, _panel((1, 2, 3))]))


def test_a_letterboxed_panel_is_not_stretched(tmp_path):
    out = tmp_path / "b.png"
    tall = _panel((255, 255, 255), size=(704, 704))
    BS.compose([tall, _panel((0, 0, 255))], str(out))
    with Image.open(out) as im:
        rows, cols, cw, ch, _, _ = BS.board_geometry(2, 704, 704)
        x, y = BS.cell_box(1, rows, cols, cw, ch)
        # the second cell keeps the FIRST panel's aspect (square here)
        assert abs(cw - ch) <= 2
        assert im.getpixel((x + cw // 2, y + ch // 2)) == (0, 0, 255)

"""The preview strip's layout, and the property the browser depends on.

`neon_h3_preview/__init__.py` imports torch, `comfy` and `latent_preview` at
module scope, so it can only be imported on the pod — which is why the layout
arithmetic lives in `strip.py` with no imports of its own and is tested here.

The one that matters is the ROUND TRIP: a sheet reaches the browser as a bare
JPEG with no metadata channel of any kind, so `read_strip` has to recover the
layout from `naturalWidth x naturalHeight` alone. If that ever stops holding,
nothing raises — previews are cropped into the wrong quarter of themselves.
"""
import os
import sys

import pytest

_PACK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "comfy_nodes", "neon_h3_preview")
sys.path.insert(0, _PACK)

import strip  # noqa: E402

# Every size H3 actually renders (worker/graphs.py H3_NATIVE_DIMS), plus the
# portrait flip of each — the full set of aspect ratios a real preview can have.
NATIVE = [(608, 352), (736, 416), (864, 480), (960, 544), (1056, 608),
          (1152, 640), (1216, 672), (1280, 736), (1344, 768), (1376, 768),
          (1504, 832), (1664, 928), (1920, 1088), (1024, 832)]
REAL_FRAMES = NATIVE + [(h, w) for w, h in NATIVE]


def sheet_size(latent_w, latent_h, plan, upscale=16):
    """The sheet the previewer will hand core, given a plan.

    Mirrors `_decode`: the LATENT is resized, then the decoder multiplies by
    16, then the cells are joined along the long axis.
    """
    cw, ch = (v * upscale for v in strip.cell_latent(latent_w, latent_h,
                                                     plan.cell_px, upscale))
    n = len(plan.indices)
    return (cw * n, ch) if plan.horizontal else (cw, ch * n)


def contain(w, h, cap):
    """PIL's ImageOps.contain, which core applies on the way out."""
    if w <= cap and h <= cap:
        return w, h
    f = min(cap / w, cap / h)
    return max(1, round(w * f)), max(1, round(h * f))


# --------------------------------------------------------------- planning ---

def test_the_strip_spans_the_whole_shot_end_to_end():
    """A sample that stops short of the last frame would show a block's opening
    and never its ending, which is the half a director is usually checking."""
    plan = strip.strip_plan(82, 80, 46)
    assert plan.indices == (0, 27, 54, 81)


def test_it_always_emits_exactly_frames_cells_however_short_the_latent():
    """The browser's cell count is a constant, so a sheet that quietly carried
    three cells would be sliced as though it had four."""
    for t in range(2, 12):
        assert len(strip.strip_plan(t, 80, 46).indices) == strip.FRAMES
        assert max(strip.strip_plan(t, 80, 46).indices) == t - 1


def test_the_image_path_stays_one_frame_at_its_old_size():
    """H3 stills decode T=1 (h3-image keeps frame 0 of a 5-frame clip). Four
    copies of one picture is not a strip, and the browser must not read one."""
    plan = strip.strip_plan(1, 64, 64)
    assert plan.indices == (0,)
    assert plan.cell_px == 512
    assert strip.read_strip(*sheet_size(64, 64, plan)) == (1, 1)


def test_frames_of_one_restores_the_previous_behaviour_exactly():
    """The kill switch has to give back what was there before, not a 1024px
    frame that decodes four times the pixels it used to."""
    plan = strip.strip_plan(82, 80, 46, frames=1)
    assert plan.indices == (0,) and plan.cell_px == 512


def test_a_strip_decodes_no_more_pixels_than_the_single_frame_did():
    """The whole VRAM argument. Four 256px cells against one 512px frame — this
    runs inside the sampler callback and b18 OOM'd over the old one."""
    one = strip.strip_plan(1, 80, 46).cell_px ** 2
    strip_px = strip.strip_plan(82, 80, 46).cell_px ** 2 * strip.FRAMES
    assert strip_px <= one


@pytest.mark.parametrize("w,h,horizontal", [(80, 46, True), (46, 80, False),
                                            (64, 64, True)])
def test_the_strip_runs_along_the_frames_long_axis(w, h, horizontal):
    """Not cosmetic — it is the entire reason the sheet is self-describing."""
    assert strip.strip_plan(82, w, h).horizontal is horizontal


def test_the_latent_resize_rounds_rather_than_truncating():
    """A 1376x768 render is an 86x48 latent; at a 256px cell budget the height
    is 8.93, and `interpolate(scale_factor=)` floors that to 8. The cell then
    previews at 2.00:1 against the shot's real 1.79 — squashed in the picture
    AND in the box, since the browser reads its shape off the cell."""
    assert strip.cell_latent(86, 48, 256, 16) == (16, 9)


def test_a_latent_already_under_budget_is_not_resized_at_all():
    assert strip.cell_latent(16, 9, 256, 16) == (16, 9)


@pytest.mark.parametrize("w,h", REAL_FRAMES)
def test_a_cell_keeps_the_renders_shape(w, h):
    """Not exact: an H3 latent is 1/16 scale, so a 256px cell is ~16x9 latent
    pixels and the rounding is coarse. 3% is what that costs; 12% was the
    truncation bug above."""
    lw, lh = w // 16, h // 16
    cw, ch = sheet_size(lw, lh, strip.strip_plan(1, lw, lh))
    assert abs(cw / ch - w / h) / (w / h) < 0.03


# -------------------------------------------------------------- detection ---

@pytest.mark.parametrize("w,h", REAL_FRAMES)
def test_an_ordinary_preview_is_never_read_as_a_strip(w, h):
    """`JobPreview` renders for EVERY running job, and a Krea 2 still or a Wan
    clip goes through core's own previewer as one frame. Reading one of those
    as a 4-strip shows the viewer the left quarter of the picture."""
    assert strip.read_strip(w, h) == (1, 1)
    assert strip.read_strip(*contain(w, h, 512)) == (1, 1)


@pytest.mark.parametrize("w,h", REAL_FRAMES)
def test_every_real_render_shape_round_trips_through_the_sheet(w, h):
    """plan -> sheet -> read_strip, at the latent shapes those sizes produce
    (H3 compresses space by 16), and again after core's ImageOps.contain."""
    lw, lh = w // 16, h // 16
    plan = strip.strip_plan(82, lw, lh)
    sw, sh = sheet_size(lw, lh, plan)
    want = (strip.FRAMES, 1) if plan.horizontal else (1, strip.FRAMES)
    assert strip.read_strip(sw, sh) == want
    assert strip.read_strip(*contain(sw, sh, 512)) == want, "lost across the downscale"


def test_a_square_render_is_still_read_as_a_strip():
    """The boundary case: a square cell puts the sheet's aspect exactly on N,
    which is what DETECT_SLACK exists for."""
    plan = strip.strip_plan(82, 52, 52)
    assert strip.read_strip(*sheet_size(52, 52, plan)) == (strip.FRAMES, 1)


def test_a_degenerate_size_is_read_as_a_plain_frame():
    """An image that has not loaded reports 0x0. Dividing by it would throw
    inside a render loop's callback."""
    assert strip.read_strip(0, 0) == (1, 1)
    assert strip.read_strip(100, 0) == (1, 1)

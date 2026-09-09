"""A free-standing clip renders the length it was asked for.

`handle_clip_gen` used to clamp every H3 request up to `h3_timing.MIN_FRAMES`
(90f / 3.75s). That constant is `plan_block`'s floor, and it is safe THERE
because a block renders long and trims to its exact content window — the floor
costs sampling time and nothing else. This path has no trim, so the floor was
the delivered length.

Measured on two real chains before the fix: 916ms requested -> 3776ms
delivered, and 2333ms requested -> 3776ms delivered. Every position under
3.75s on the chain modal's slider produced the identical file while the
control quoted the request back to two decimals. Nothing errored; the render
succeeded and was simply four times too long.

Arithmetic that fails silently, so it is pinned as arithmetic AND as source:
the count is passed to `resolve()` as `exact_frames`, which is documented to
trust it.
"""
import ast
import pathlib

import h3_timing

WORKER = pathlib.Path(__file__).resolve().parents[1]
BLOCKS = (WORKER / "handlers" / "blocks.py").read_text()
CLIP_GEN = BLOCKS.split("def handle_clip_gen(")[1].split("\ndef ")[0]
# Everything before the first staging call — the length is decided at the top.
LENGTH = CLIP_GEN.split("def stage(")[0]


def frames_for(ms):
    """The expression `handle_clip_gen` runs for an H3 model."""
    return h3_timing.pad17(min(h3_timing.MAX_FRAMES,
                               h3_timing.ms_to_frames_ceil(ms)))


def test_the_delivered_length_is_the_requested_length():
    # The two lengths that were measured wrong, and the grid step either side.
    for ms, want_f in ((916, 22), (2333, 56), (208, 5), (1625, 39), (3041, 73)):
        assert frames_for(ms) == want_f, ms
        # …and it round-trips: the browser floors ms from the same grid, so a
        # request built by the slider must not pad up a step here.
        assert h3_timing.frames_to_ms(want_f) - ms < h3_timing.frames_to_ms(1)


def test_a_short_request_is_no_longer_clamped_to_the_episode_floor():
    for ms in (208, 916, 1625, 2333, 3041):
        assert frames_for(ms) < h3_timing.MIN_FRAMES, ms
    # The exact failure: 916ms came back as 3776ms, which is MIN_FRAMES.
    assert frames_for(916) != h3_timing.MIN_FRAMES


def _frames_expr():
    """The source of the H3 branch's `frames = ...`, and nothing else.

    Read with `ast` rather than by splitting on text: the guard below it
    legitimately NAMES `MIN_FRAMES` (it is what "out of distribution" means),
    so a substring search over the region cannot tell the report from the
    clamp — it fails on the fix as readily as on the bug.
    """
    tree = ast.parse(BLOCKS)
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, ast.FunctionDef) and n.name == "handle_clip_gen")
    for node in ast.walk(fn):
        if (isinstance(node, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "frames"
                        for t in node.targets)
                and "pad17" in ast.dump(node.value)):
            return ast.get_source_segment(BLOCKS, node.value)
    raise AssertionError("handle_clip_gen no longer computes `frames` with pad17")


def test_handle_clip_gen_does_not_floor_the_frame_count():
    """The source guard. The arithmetic above is a copy of the expression, so
    it cannot notice the clamp coming back — only reading the handler can."""
    expr = _frames_expr()
    assert "MIN_FRAMES" not in expr, expr
    assert "MAX_FRAMES" in expr, "the ceiling is not the thing being removed"


def test_it_still_says_when_a_render_is_out_of_distribution():
    """A quality judgement is not a limit, so it is reported rather than
    applied — a silent substitution is what this replaces."""
    assert "frames < h3_timing.MIN_FRAMES" in LENGTH
    assert "log(" in LENGTH.split("frames < h3_timing.MIN_FRAMES")[1][:400]


def test_nothing_is_still_not_expressible():
    """`pad17` floors at the grid's own minimum, so removing the clamp cannot
    produce a zero-frame render however small the request."""
    for ms in (0, 1, 40, 207):
        assert frames_for(ms) >= h3_timing.FRAME_REM
    assert frames_for(1) == 5


def test_the_ceiling_is_untouched():
    assert frames_for(60_000) >= h3_timing.MAX_FRAMES


def test_the_EPISODE_path_keeps_its_floor():
    """`plan_block` renders long and trims exact, so its floor costs sampling
    time and never a delivered length. Removing the constant outright would
    take that with it."""
    plan = h3_timing.plan_block(500)
    assert plan.render_f >= h3_timing.MIN_FRAMES
    assert plan.trim_ms == 500

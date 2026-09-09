"""Motion context on the EXTEND path (handle_clip_gen).

An extend used to open on a frame and nothing else, so H3 re-decided the
motion from a still — the failure the episode chain already fixed, surviving
on the one path that never got it. Everything below is arithmetic that fails
SILENTLY: the render succeeds either way and the clip is simply the wrong
length, or opens by replaying its predecessor.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import h3_timing

CTX_TAIL_F = 72
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def plan(content_f, ctx_len=h3_timing.DEFAULT_WARMUP_F):
    """The three numbers handle_clip_gen derives, in one place."""
    render_f = h3_timing.pad17(content_f + ctx_len)
    return render_f, render_f - content_f


def test_the_trim_always_covers_the_pinned_window():
    # The whole safety property. The pinned frames are replayed at the HEAD of
    # the render; a cut shorter than the pin leaves that replay in the clip.
    for content_f in range(5, 366, 17):
        render_f, trim_f = plan(content_f)
        assert trim_f >= h3_timing.DEFAULT_WARMUP_F, content_f
        assert render_f - trim_f == content_f


def test_every_rendered_length_is_legal():
    # Off-grid does not fail — it renders, and the pack silently reads the
    # pinned frames as unrelated stills instead of a run of motion.
    for content_f in range(5, 366, 17):
        render_f, _ = plan(content_f)
        assert render_f >= 5 and (render_f - 5) % 17 == 0, content_f


def test_the_delivered_clip_is_the_length_that_was_asked_for():
    for content_f in (5, 90, 141, 260):
        render_f, trim_f = plan(content_f)
        assert render_f - trim_f == content_f


def test_the_context_window_is_the_tail_of_what_the_viewer_SAW():
    # A block take's file IS its content; a timeline clip's file routinely runs
    # past the point it was trimmed to, so reading to the end of the FILE pins
    # motion from frames nobody saw.
    end_f = int(6275 * 24 / 1000)          # a trimmed out-point
    skip_f = max(0, end_f - CTX_TAIL_F)
    load_cap = max(1, end_f - skip_f)
    assert skip_f + load_cap == end_f
    assert load_cap <= CTX_TAIL_F
    # A clip shorter than the tail window reads from its own start.
    assert max(0, 30 - CTX_TAIL_F) == 0


def test_the_handler_gates_on_i2v_and_only_wires_it_for_h3():
    src = open(os.path.join(ROOT, "handlers", "blocks.py")).read()
    body = src[src.index("def handle_clip_gen"):src.index("def handle_transition_gen")]
    gate = re.search(r'if \(mode == "i2v" and ctx_id.*?\):', body, re.S)
    assert gate, "the motion-context gate moved or changed shape"
    assert '"h3" in model_key.lower()' in gate.group(0)
    assert "_motion_ctx_wanted" in gate.group(0)
    # And the trim must be wired, or the replay lands in the clip.
    assert "if trim_f:" in body
    assert "motion_ctx=motion_ctx" in body


def test_load_cap_reaches_the_vhs_node():
    # 0 means "to the end of the file" — the old behaviour, and wrong for a
    # trimmed clip. A dropped key here is silent.
    src = open(os.path.join(ROOT, "resolve.py")).read()
    assert '"frame_load_cap": int(ctx.get("load_cap") or 0)' in src


def test_the_context_video_is_re_rendered_with_the_clips_own_ops():
    """A flipped clip must pin the motion the VIEWER saw.

    `VHS_LoadVideo` has no filter input, so the alternative was a transform
    node in the graph — another dependency for something ffmpeg already does
    to these exact ops. Reusing `build_clip_filter` is also what keeps ONE
    implementation of the geometry.
    """
    src = open(os.path.join(ROOT, "handlers", "blocks.py")).read()
    fn = src[src.index("def _stage_with_ops"):src.index("def _exchange_slots_for_block")]
    assert "build_clip_filter" in fn
    # fit=False: the frame grid belongs to the H3 render, not the timeline, and
    # normalising would letterbox a window the model is about to encode.
    assert "fit=False" in fn
    # A failure must fall back to the plain staged file — a mirrored context is
    # a quality wobble, a failed extend is a dead job.
    assert fn.count("return name") >= 3
    # And the handler has to actually use it.
    body = src[src.index("def handle_clip_gen"):src.index("def handle_transition_gen")]
    assert "_stage_with_ops(ctx_asset" in body
    assert 'payload.get("context_ops")' in body


def test_ops_only_filters_carry_no_normalise():
    from handlers.render import build_clip_filter
    ops = [{"op": "flip", "dir": "h"}, {"op": "crop", "x": 1, "y": 2, "w": 640, "h": 360}]
    vf, _ = build_clip_filter(ops, width=1280, height=720, fps=24, has_audio=False, fit=False)
    assert vf.startswith("hflip")
    assert "crop=" in vf
    for banned in ("force_original_aspect_ratio", "pad=", "setsar", "fps="):
        assert banned not in vf, banned
    # No ops -> nothing to run, so the pre-pass is skipped entirely.
    assert build_clip_filter([], width=1280, height=720, fps=24, has_audio=False, fit=False)[0] == ""
    # And every OTHER caller keeps the normalise.
    assert "fps=24" in build_clip_filter(ops, width=1280, height=720, fps=24, has_audio=False)[0]


def test_the_ops_pre_pass_keeps_the_AUDIO():
    """`-an` failed the render outright, and only a live run found it.

    `_wire_motion_context` wires `context_audio` to the SAME VHS node as the
    frames, so a silent staged file throws "VHS failed to extract audio" —
    and it would also have discarded half the feature, since motion context
    pins the predecessor's waveform as well as its movement.
    """
    src = open(os.path.join(ROOT, "handlers", "blocks.py")).read()
    fn = src[src.index("def _stage_with_ops"):src.index("def _exchange_slots_for_block")]
    assert '"-an"' not in fn, "the op pre-pass must not strip audio"
    assert '"-c:a", "copy"' in fn

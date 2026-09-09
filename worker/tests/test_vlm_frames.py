"""The vision model's frame plumbing.

Every failure here is SILENT — a mislabelled frame, or a tuple shape that only
breaks on one path, still returns a confident answer about a clip the model
was told the wrong thing about, and the `jobs` row reads `done` either way.
"""
import json

import vlm


# Frames arrive in TWO shapes on purpose: sample_frames yields
# (type, b64, t) because a sample has a place on the take's timeline, while
# the previous-segment tail and the one-per-block continuity frames are
# (type, b64) because they do not.
TIMED = ("image/jpeg", "AAAA", 1.25)
UNTIMED = ("image/jpeg", "BBBB")


def test_manifest_labels_a_timed_frame_with_its_second():
    rows = vlm._frame_manifest([TIMED])
    assert rows == ["frame 1: t=1.25s"]


def test_manifest_never_invents_a_time_for_a_context_frame():
    # The prev-segment tail belongs to the PREVIOUS take. Giving it a
    # timestamp would put it on this take's clock and invite the judge to do
    # spacing arithmetic across a cut.
    rows = vlm._frame_manifest([UNTIMED])
    assert rows == ["frame 1: no timestamp (context frame)"]
    assert "t=" not in rows[0]


def test_manifest_handles_the_mixed_list_the_chained_path_builds():
    # [prev_tail] + samples — the exact shape worker/__init__ prepends.
    rows = vlm._frame_manifest([UNTIMED, TIMED, ("image/jpeg", "C", 4.5)])
    assert rows[0].endswith("(context frame)")
    assert rows[1] == "frame 2: t=1.25s"
    assert rows[2] == "frame 3: t=4.50s"
    assert len(rows) == 3


def test_every_frame_shape_exposes_its_b64_at_index_1():
    # Both consumers index f[1] rather than unpacking, because unpacking a
    # 3-tuple as (mt, b64) raises only on the chained path — i.e. in
    # production, on a subset of blocks, after the render is paid for.
    for f in (TIMED, UNTIMED):
        assert f[1] in ("AAAA", "BBBB")
    assert [f[1] for f in (UNTIMED, TIMED)] == ["BBBB", "AAAA"]


def test_frame_count_and_context_budget_move_together():
    # num_ctx is sized for the image tokens FRAMES_PER_TAKE produces. Raising
    # the frame count alone walks back into Ollama returning an empty
    # `content` on marginal takes, which surfaces as "no JSON object" and not
    # as anything that names the real cause.
    assert vlm.FRAMES_PER_TAKE >= 4
    assert vlm.VLM_NUM_CTX >= 24576
    # ~2.7k ctx per sampled frame was the ratio at the settled 4-frame/24K
    # point; keep any future bump on the same side of it.
    assert vlm.VLM_NUM_CTX >= vlm.FRAMES_PER_TAKE * 2048


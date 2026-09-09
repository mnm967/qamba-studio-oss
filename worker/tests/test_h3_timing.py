import pytest

from h3_timing import (FPS, FRAME_BASE, FRAME_REM, MAX_FRAMES, TimingPlan,
                       frames_to_ms, ms_to_frames_ceil, pad17, plan_block)


def legal(n):
    return n % FRAME_BASE == FRAME_REM


def test_pad17_alignment_properties():
    for n in range(1, 700):
        p = pad17(n)
        assert legal(p), f"pad17({n})={p} not ≡5 mod 17"
        assert p >= n
        assert p - n < FRAME_BASE  # minimal round-up


def test_pad17_known_values():
    # From ComfyUI's own in-graph expression and the VRGDG timing module:
    # 5s -> 120 frames -> 124; 124 already legal stays.
    assert pad17(120) == 124
    assert pad17(124) == 124
    assert pad17(360) == 362  # 15s content


def test_plan_exact_15s():
    p = plan_block(15000)
    assert p.content_f == 360
    assert legal(p.render_f)
    assert p.render_f <= MAX_FRAMES
    assert p.trim_ms == 15000
    assert p.trim_start_ms == frames_to_ms(p.warmup_f)
    # warmup was shed only as much as the ceiling demanded
    assert p.warmup_f > 0


def test_plan_small_block():
    p = plan_block(4000)
    assert legal(p.render_f)
    assert p.trim_ms == 4000
    assert p.render_f >= p.content_f + p.warmup_f + p.cooldown_f


def test_plan_trims_never_exceed_render():
    for ms in range(4000, 15001, 137):
        p = plan_block(ms)
        assert legal(p.render_f)
        assert p.trim_start_ms + p.trim_ms <= p.render_ms
        assert p.render_f <= MAX_FRAMES


def test_audio_slice_alignment():
    p = plan_block(12000)
    # The locked slice starts one warmup early (negative offset) and runs the whole
    # render, so trimming [trim_start, trim_start+trim] realigns picture+audio.
    assert p.audio_offset_ms == -frames_to_ms(p.warmup_f)
    assert p.audio_ms == p.render_ms


def test_content_too_long_raises():
    with pytest.raises(ValueError):
        plan_block(16000)


def test_ms_frames_roundtrip():
    assert ms_to_frames_ceil(1000) == FPS
    assert ms_to_frames_ceil(1001) == FPS + 1  # ceiling
    assert frames_to_ms(24) == 1000

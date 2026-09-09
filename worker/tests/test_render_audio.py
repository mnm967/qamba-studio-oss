"""Detached block audio, on the render side.

The picture keeps an audio STREAM and loses its signal — dropping the stream
would break the concat/xfade steps, which map [0:a][1:a] unconditionally — and
the intermediate cache has to tell the two apart without invalidating every
clip rendered before the flag existed.
"""
from handlers import render


CLIP = {"in_ms": 0, "out_ms": 4000, "ops": []}
ASSET = {"b2_key": "renders/ep1/b3.mp4"}


def vf_af(**over):
    kw = {"width": 1280, "height": 704, "fps": 24, "has_audio": True}
    kw.update(over)
    return render.build_clip_filter([], **kw)


def test_a_detached_clip_is_silenced_not_stripped():
    _, af = vf_af(mute_audio=True)
    assert "volume=0" in af.split(",")


def test_an_attached_clip_is_untouched():
    _, af = vf_af(mute_audio=False)
    assert "volume=0" not in af


def test_silencing_a_clip_that_has_no_audio_adds_no_filter():
    _, af = vf_af(has_audio=False, mute_audio=True)
    assert af == ""


def test_the_mute_lands_after_the_ops_it_must_survive():
    # `reverse` adds areverse and `speed` an atempo chain; volume=0 has to come
    # last, or an op appended after it would be shaping silence.
    _, af = render.build_clip_filter(
        [{"op": "speed", "rate": 2}, {"op": "reverse"}],
        width=1280, height=704, fps=24, has_audio=True, mute_audio=True)
    parts = af.split(",")
    assert parts[-1] == "volume=0"
    assert "areverse" in parts


def test_the_flag_changes_the_cache_key_only_for_clips_that_carry_it():
    plain = render.op_hash(ASSET, CLIP, 24, 1280, 704)
    same = render.op_hash(ASSET, dict(CLIP, audio_detached=False), 24, 1280, 704)
    muted = render.op_hash(ASSET, dict(CLIP, audio_detached=True), 24, 1280, 704)
    # Every intermediate rendered before this feature existed stays valid...
    assert plain == same
    # ...and a detached clip cannot be served the version with sound in it.
    assert plain != muted

"""The freeze op, through the real ffmpeg — WHICH frame it holds, and for how
long.

Both claims are about a clip that is also RETIMED, and both are silent when
wrong: the render succeeds, the clip is exactly as long as its slot, and only
the picture inside it is off. Nothing short of decoding the output can tell.

  1. `at_ms` is a SOURCE offset from the clip's in-point. The renderer cuts its
     three pieces out of `base`, which is the trim and nothing else — the speed
     op runs afterwards, on each piece — so a hold placed 1.0s into a 2x clip
     belongs at 2.0s of source. Both browser writers stored the playhead's
     TIMELINE offset instead, which is the same number only at 1x.

  2. The still is the clip's LOOK held still, not more footage to retime. It
     was built with the full op list, so `setpts=PTS/rate` divided the hold:
     a control labelled "Freeze 1s" delivered 0.67s at 1.5x.

And on a REVERSED clip the three pieces used to concat in forward order, which
plays the shot inside out around the hold.

The fixture encodes TIME IN THE PICTURE — luma ramps with t, so a frame's
average brightness says which source second it came from — and every case is
checked against a full MODEL of the correct output rather than against a
tolerance on flatness. That matters: the delivered ramp's own slope IS the
rate, so "the luma stopped moving" reads as a hold at 2x and as the ordinary
picture at 0.25x.

The brightness a source second reads back AS is measured off a PLAIN RENDER of
the same fixture rather than computed from the geq expression — the render
chain tags bt709/tv and converts range on the way through, so `lum=60*T` is not
what comes out the other end. Measuring the reference through the identical
encoder makes every assertion here about WHICH FRAME is on screen and nothing
about levels.

Skipped when ffmpeg is absent, like test_audio_fx_ffmpeg.py.
"""
import json
import os
import shutil
import subprocess

import pytest

from handlers import render

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg not installed")

FPS = 24
SRC_S = 4.0          # source seconds
# The ramp stays well inside 16..235 at BOTH ends: a `lum=60*T` fixture reads
# back as a flat 16 for its first eight frames and saturates in its last three,
# and a ramp with flat ends cannot be inverted there — every dark frame answers
# "source 0.0s" and the test measures the fixture instead of the render.
LUMA_0 = 40          # geq: lum = 40 + 45*t — 40 at the head, 220 at the tail
LUMA_PER_S = 45
FRAME_S = 1.0 / FPS
# Slack in SOURCE frames — the units the claim is in. Two sources of phase, and
# the bound has to cover both: reading a frame's source time back off the
# reference resolves to the nearest reference FRAME whatever the rate (the
# floor), and a delivered frame is `rate` source frames wide, so `setpts` plus
# the `fps` lock puts a fast clip further out (the term). Generous against the
# thing being caught either way — the bug displaced the hold by 40 source
# frames at 1.5x, and the reversed order by half a clip.
SLACK_FLOOR_FRAMES = 2.0
SLACK_FRAMES_PER_RATE = 2.5


@pytest.fixture(scope="module")
def ramp(tmp_path_factory):
    """4s whose luma ramps with time: every frame says when it came from."""
    src = str(tmp_path_factory.mktemp("freeze") / "ramp.mp4")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", f"color=c=black:s=160x96:d={SRC_S}:r={FPS}",
         "-vf", f"geq=lum='clip({LUMA_0}+{LUMA_PER_S}*T,0,255)':cb=128:cr=128",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", src],
        check=True, capture_output=True)
    return src


@pytest.fixture(scope="module")
def src_sec(ramp, tmp_path_factory):
    """WHICH SOURCE SECOND a frame of the output came from, read off its
    brightness.

    The table is measured through the render chain itself — a 1x pass with no
    ops, whose delivered time IS source time — so it carries whatever the
    encoder does to levels, and the ramp is monotonic, so nearest-by-luma
    inverts it."""
    track = luma_track(
        render_clip(ramp, str(tmp_path_factory.mktemp("ref")), [], "ref"))
    # The inverse is only a function where the ramp actually climbs. A fixture
    # that crushes or saturates at either end reads as "source 0.0s" (or as the
    # tail) for a whole run of frames, and every assertion built on it goes
    # quietly slack exactly there.
    assert track[-1][1] - track[0][1] > 150, "the reference ramp is too flat to read"
    # Over a 3-frame window, not frame to frame: YAVG comes back quantised to
    # whole luma and the ramp climbs ~1.9 a frame, so a repeated value here and
    # there is rounding. A repeated RUN is what breaks the inverse.
    flat = [track[i][0] for i in range(len(track) - 3)
            if track[i + 3][1] - track[i][1] < 2]
    assert not flat, f"the reference ramp does not climb at {flat[:5]}"

    def sec_of(luma):
        return min(track, key=lambda f: abs(f[1] - luma))[0]
    return sec_of


def luma_track(path):
    """[(t_seconds, average luma)] for every frame of `path`."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-f", "lavfi",
         f"movie={path},signalstats", "-show_entries",
         "frame=pts_time:frame_tags=lavfi.signalstats.YAVG",
         "-print_format", "json"],
        check=True, capture_output=True, text=True)
    out = [(float(f["pts_time"]), float(f["tags"]["lavfi.signalstats.YAVG"]))
           for f in json.loads(r.stdout).get("frames", [])
           if f.get("pts_time") and f.get("tags", {}).get("lavfi.signalstats.YAVG")]
    assert out, f"no frames read back from {path}"
    return out


def render_clip(ramp, tmp, ops, name):
    dst = os.path.join(tmp, f"{name}.mp4")
    render.render_clip_file(
        ramp, dst, {"in_ms": 0, "out_ms": int(SRC_S * 1000), "ops": ops},
        width=160, height=96, fps=FPS, slot_ms=None)
    assert os.path.exists(dst)
    return dst


def source_at(t, *, rate, at_ms, hold_ms, rev):
    """WHICH SOURCE SECOND the correct render shows at delivered time `t`.

    The whole specification of a frozen clip in four lines: the shot runs at
    `rate`, stops on the frame at `at_ms` of source for `hold_ms`, and carries
    on from there. Reversed, it runs the other way and the hold lands on the
    same frame, which is `(end - at)/rate` into the delivered clip rather than
    `at/rate`.
    """
    a, h, end = at_ms / 1000.0, hold_ms / 1000.0, SRC_S
    start = (end - a) / rate if rev else a / rate
    if t < start:
        return end - t * rate if rev else t * rate
    if t < start + h:
        return a
    t -= h
    return end - t * rate if rev else t * rate


def assert_matches(track, src_sec, *, rate=1.0, at_ms, hold_ms, rev=False):
    """Every frame of the output is the frame the model says it is.

    Frames within a frame and a half of a cut are skipped: which side of a
    boundary a pts lands on is a phase question, not a correctness one, and the
    runs either side are long enough that nothing hides in the gap.
    """
    a, h, end = at_ms / 1000.0, hold_ms / 1000.0, SRC_S
    start = (end - a) / rate if rev else a / rate
    cuts = (start, start + h)
    slack = FRAME_S * max(SLACK_FLOOR_FRAMES, rate * SLACK_FRAMES_PER_RATE)
    checked = 0
    for t, y in track:
        if any(abs(t - c) <= FRAME_S * 1.5 for c in cuts):
            continue
        want = source_at(t, rate=rate, at_ms=at_ms, hold_ms=hold_ms, rev=rev)
        got = src_sec(y)
        assert abs(got - want) <= slack, (
            f"at {t:.3f}s the render is showing source {got:.3f}s; the model "
            f"says {want:.3f}s (slack {slack:.3f}s)")
        checked += 1
    # A model nothing was compared against passes vacuously.
    assert checked > FPS, f"only {checked} frames checked"


def test_a_plain_freeze_is_unchanged(ramp, src_sec, tmp_path):
    # The 1x case is what every frozen clip on every timeline renders as today,
    # and none of this may move it.
    track = luma_track(render_clip(ramp, str(tmp_path),
                        [{"op": "freeze", "at_ms": 1500, "dur_ms": 1000}], "plain"))
    assert_matches(track, src_sec, at_ms=1500, hold_ms=1000)


def test_a_retimed_clip_holds_the_frame_that_was_on_screen(ramp, src_sec, tmp_path):
    # 2s of lane at 2x eats the whole 4s source. The user parks the playhead
    # 1.0s in and presses Freeze: the picture is 2.0s into the source there, so
    # freezeSourceMs stores 2000 — where the old writer stored 1000 and the
    # shot stopped on a frame half as far in as the one on screen.
    track = luma_track(render_clip(ramp, str(tmp_path),
                        [{"op": "speed", "rate": 2},
                         {"op": "freeze", "at_ms": 2000, "dur_ms": 1000}], "fast"))
    assert_matches(track, src_sec, rate=2.0, at_ms=2000, hold_ms=1000)


def test_the_hold_is_as_long_as_it_was_asked_for_at_any_rate(ramp, src_sec, tmp_path):
    # `setpts=PTS/rate` used to run over the still too, so the hold came back
    # divided by the rate — 0.67s at 1.5x, 4s at 0.25x. The model puts the
    # resume at `start + hold`, so a stretched or squashed hold shifts every
    # frame after it and fails on the picture rather than on a duration.
    for rate, at in ((1.5, 3000), (0.5, 1000)):
        track = luma_track(render_clip(
            ramp, str(tmp_path),
            [{"op": "speed", "rate": rate},
             {"op": "freeze", "at_ms": at, "dur_ms": 1000}], f"hold{rate}"))
        assert_matches(track, src_sec, rate=rate, at_ms=at, hold_ms=1000)


def test_a_reversed_clip_runs_backwards_THROUGH_the_hold(ramp, src_sec, tmp_path):
    # Reversed, the shot plays 4s -> 0s. A hold placed 1s in belongs on the
    # frame at source 3s, with the picture darkening either side of it.
    # Concatenated in forward order — which is what the renderer did — the
    # output plays 3s->0s, holds, then 4s->3s: every frame in the wrong place
    # and the model catches it on the first one.
    track = luma_track(render_clip(ramp, str(tmp_path),
                        [{"op": "reverse"},
                         {"op": "freeze", "at_ms": 3000, "dur_ms": 1000}], "rev"))
    assert_matches(track, src_sec, at_ms=3000, hold_ms=1000, rev=True)
    # Belt to those braces, and independent of the model: the whole clip
    # descends, bright to dark. One rising step is the halves in forward order.
    for (_, a), (_, b) in zip(track, track[1:]):
        assert b <= a + 2, f"luma rose {a} -> {b}: the pieces are out of order"


def test_an_at_ms_past_the_media_does_not_kill_the_render(ramp, src_sec, tmp_path):
    # Every freeze stored before freezeSourceMs holds a TIMELINE offset, and on
    # a slowed clip that runs off the end of the source it indexes — at 0.5x a
    # clip is twice its own media. extract_frame answers an out-of-range
    # seek with no file and an exception, at the END of a timeline render,
    # after every other clip has been paid for. Clamped, it holds the last
    # frame instead: a worse picture than the user asked for, not a dead job.
    track = luma_track(render_clip(ramp, str(tmp_path),
                        [{"op": "speed", "rate": 0.5},
                         {"op": "freeze", "at_ms": 7000, "dur_ms": 1000}], "past"))
    assert_matches(track, src_sec, rate=0.5, at_ms=int(SRC_S * 1000 - 1000 / FPS),
                   hold_ms=1000)

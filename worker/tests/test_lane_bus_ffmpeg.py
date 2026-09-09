"""The per-lane effects bus, through the real ffmpeg.

`mix.lane_bus` is the render half of the lane rack; the preview builds the same
stage as Web Audio nodes. Two claims here that only the binary can settle, and
both are silent when wrong — a filtergraph fails as a UNIT, at the end of an
episode, after every block's GPU time is already spent.

  1. The graph parses and runs, for a rack with a compressor, an EQ and a
     reverb on it.
  2. Moving the lane's fader from per-clip to post-bus is the same mix.
     Exactly the same with a plain fader; with AUTOMATION the two differ by up
     to one frame-step of the curve, because `eval=frame` samples it once per
     filter frame and `adelay` gives each clip's branch its own frame clock —
     so the old shape reads the curve at up to N different instants and the new
     one reads it once, on the sum. That is a sampling phase, not a gain error,
     and the flat-tail assertion below is what tells the two apart.

     Note this matters only for reasoning about the NEW path: a lane with no
     rack never reaches it, so no existing timeline is re-mixed.

Skipped when ffmpeg is absent, like test_audio_fx_ffmpeg.py.
"""
import shutil
import struct
import subprocess

import pytest

import audio_fx
import mix
from mix import linear_gain, track_gain_db_at

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

# Two "clips" on one lane: different tones, different offsets, different gains.
# Quiet on purpose: two sines can align, and a fixture whose sum clips is one
# where s16 saturation hides whatever the test was trying to measure.
CLIPS = [
    {"freq": 440, "delay_ms": 0, "gain_db": -12.0},
    {"freq": 660, "delay_ms": 400, "gain_db": -9.0},
]
DUR = 1.2
FRAME_MS = 1024 / 48000 * 1000      # ffmpeg's frame for these sources
AUTOMATION = [{"t_ms": 0, "gain_db": -12}, {"t_ms": 600, "gain_db": 4},
              {"t_ms": 1100, "gain_db": -6}]
# Where the curve is FLAT, both shapes must agree exactly however they sample
# it — one frame of margin past the last point.
FLAT_FROM_MS = AUTOMATION[-1]["t_ms"] + FRAME_MS * 2


def _inputs():
    args = []
    for c in CLIPS:
        args += ["-f", "lavfi", "-i",
                 "sine=frequency=%d:duration=%s:sample_rate=48000" % (c["freq"], DUR)]
    return args


def _clip_branches(track, *, fader_per_clip):
    """The per-clip half, in either shape. `fader_per_clip` is the historical
    one: the lane's level folded into each clip's own `volume`."""
    parts, labels = [], []
    for i, c in enumerate(CLIPS):
        filt = ["asetpts=PTS-STARTPTS", "adelay=%d|%d" % (c["delay_ms"], c["delay_ms"])]
        filt.append(mix.volume_filter(track, c["gain_db"]) if fader_per_clip
                    else "volume=%.4fdB" % c["gain_db"])
        filt.append("aresample=48000")
        parts.append("[%d:a]%s[a%d]" % (i, ",".join(filt), i))
        labels.append("[a%d]" % i)
    return parts, labels


def _pcm(graph, out_label):
    """Render a graph to raw mono-interleaved s16 and hand back the samples."""
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error"] + _inputs()
        + ["-filter_complex", graph, "-map", out_label,
           "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", "-"],
        capture_output=True)
    assert r.returncode == 0, r.stderr.decode()[-2000:]
    return struct.unpack("<%dh" % (len(r.stdout) // 2), r.stdout[: len(r.stdout) // 2 * 2])


def _old_shape(track):
    parts, labels = _clip_branches(track, fader_per_clip=True)
    return ";".join(parts) + ";%samix=inputs=%d:normalize=0:duration=longest[out]" % (
        "".join(labels), len(labels))


def _new_shape(track):
    """What the renderer emits for a lane WITH a rack — here with an empty
    rack, so the only difference from `_old_shape` is where the fader sits."""
    parts, labels = _clip_branches(track, fader_per_clip=False)
    steps = ["amix=inputs=%d:normalize=0:duration=longest" % len(labels),
             mix.volume_filter(track)]
    return ";".join(parts) + ";%s%s[out]" % ("".join(labels), ",".join(steps))


def test_moving_a_plain_fader_post_bus_changes_nothing():
    """Gain is linear and distributes over a sum, so `sum(clip*clipgain)*lane`
    is exactly what the per-clip form computed. If this ever fails, the lane
    rack is silently re-mixing every timeline that has one."""
    track = {"gain_db": -4.5, "automation": []}
    old = _pcm(_old_shape(track), "[out]")
    new = _pcm(_new_shape(track), "[out]")
    assert len(old) == len(new)
    # Two float paths that sum in a different order, quantised to s16: equal to
    # within one LSB, which is -90 dBFS.
    worst = max(abs(a - b) for a, b in zip(old, new))
    assert worst <= 1, "post-bus fader moved the mix by %d LSB" % worst


def _frame_step_lsb(track):
    """The most one frame of curve quantisation can be worth, in s16 LSB — the
    bound the automation difference has to sit inside if it is a sampling phase
    and not a gain error."""
    step = max(abs(linear_gain(track_gain_db_at(track, ms + FRAME_MS))
                   - linear_gain(track_gain_db_at(track, ms)))
               for ms in range(0, int(CLIPS[-1]["delay_ms"] + DUR * 1000)))
    peak = sum(10 ** (c["gain_db"] / 20) for c in CLIPS)     # sines can align
    return step * peak * 32768


def test_automation_post_bus_is_the_same_curve():
    """Two claims, and the first is the one that separates a sampling phase
    from a wrong gain: where the curve is FLAT the two shapes must agree
    exactly, whatever instants they each sampled it at."""
    track = {"gain_db": 0.0, "automation": AUTOMATION}
    old = _pcm(_old_shape(track), "[out]")
    new = _pcm(_new_shape(track), "[out]")
    assert len(old) == len(new)

    flat = int(FLAT_FROM_MS / 1000 * 48000) * 2              # stereo interleaved
    assert flat < len(old), "fixture is too short to have a flat tail"
    tail = max(abs(a - b) for a, b in zip(old[flat:], new[flat:]))
    assert tail <= 1, "the two shapes disagree by %d LSB where the curve is flat" % tail

    worst = max(abs(a - b) for a, b in zip(old, new))
    bound = _frame_step_lsb(track)
    assert worst <= bound, (
        "moving the fader post-bus changed the mix by %d LSB, past the %.0f LSB "
        "one frame of curve quantisation can explain" % (worst, bound))


RACK = [
    {"id": "eq", "params": {"bands": [
        {"type": "highpass", "freq": 90, "q": 0.7},
        {"type": "peaking", "freq": 2400, "gain": -5, "q": 2.0},
    ]}},
    {"id": "compressor", "params": {"threshold": -22, "ratio": 6, "attack": 3,
                                    "release": 180, "makeup": 4}},
    {"id": "reverb", "params": {"size": 0.5, "decay": 1.8, "mix": 0.3}},
]


def test_a_real_rack_is_a_graph_ffmpeg_accepts():
    track = {"gain_db": -3.0, "automation": [], "audio_fx": RACK}
    parts, labels = _clip_branches(track, fader_per_clip=False)
    bus = mix.lane_bus(track, labels, "[out]")
    assert bus is not None
    samples = _pcm(";".join(parts) + ";" + bus, "[out]")
    assert any(samples), "the lane came back silent"


def test_the_tail_is_padded_past_the_last_clip():
    """A reverb goes on after its input stops; an ffmpeg stream ends where its
    last clip does. Without the pad the tail is simply cut."""
    track = {"gain_db": 0.0, "automation": [],
             "audio_fx": [{"id": "reverb", "params": {"size": 0.5, "decay": 2.0, "mix": 0.5}}]}
    tail = audio_fx.tail_ms(track["audio_fx"])
    assert tail > 200, "fixture needs an audible tail"
    parts, labels = _clip_branches(track, fader_per_clip=False)
    bus = mix.lane_bus(track, labels, "[out]")
    assert "apad=" in bus
    samples = _pcm(";".join(parts) + ";" + bus, "[out]")
    # The last clip ends at 400ms + 1.2s; anything after that is tail.
    end = int((CLIPS[-1]["delay_ms"] / 1000.0 + DUR) * 48000) * 2
    assert len(samples) > end, "no samples past the last clip — the pad did nothing"
    assert any(abs(s) > 32 for s in samples[end:]), "padded, but the tail is silent"


def test_a_lane_with_no_rack_is_left_alone():
    """The whole reason nothing existing changes: no rack, no bus, and the
    renderer falls through to the filtergraph it has always emitted."""
    assert mix.lane_bus({"gain_db": -3, "automation": [], "audio_fx": []}, ["[a0]"], "[out]") is None
    assert mix.lane_bus({"gain_db": -3, "automation": []}, ["[a0]"], "[out]") is None
    # A rack whose every effect is switched off or inaudible is not a rack.
    off = [{"id": "reverb", "params": {"size": 0.5, "decay": 2, "mix": 0.4}, "enabled": False}]
    assert mix.lane_bus({"gain_db": 0, "automation": [], "audio_fx": off}, ["[a0]"], "[out]") is None


def test_one_clip_needs_no_amix():
    """`amix=inputs=1` is a pass over the samples to do nothing."""
    track = {"gain_db": 0.0, "automation": [], "audio_fx": RACK[:1]}
    bus = mix.lane_bus(track, ["[a0]"], "[out]")
    assert "amix" not in bus
    assert bus.startswith("[a0]") and bus.endswith("[out]")

"""Every effect the catalog can produce, run through the real ffmpeg.

A filtergraph fails as a UNIT: one unparseable argument, one filter this build
does not have, and the whole `audio-mix` step dies — after the render has
already spent its GPU time. Shapes and arithmetic are pinned in
test_audio_fx.py; this is the part only the binary can answer.

Skipped when ffmpeg is absent, so a laptop without it still runs the suite;
on the pod (and any box with ffmpeg) it is the real check.
"""
import shutil
import subprocess

import pytest

import audio_fx

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

EVERY = [
    {"id": "eq", "params": {"low": 4, "mid": -3.5, "high": 2}},          # legacy row
    {"id": "eq", "params": {"bands": [
        {"type": "highpass", "freq": 80, "q": 0.7},
        {"type": "lowshelf", "freq": 200, "gain": 4},
        {"type": "peaking", "freq": 2500, "gain": -4.5, "q": 3.2},
        {"type": "highshelf", "freq": 6000, "gain": 3},
        {"type": "lowpass", "freq": 14000, "q": 0.9},
        {"type": "notch", "freq": 50, "q": 10},
    ]}},
    {"id": "filter", "params": {"mode": "highpass", "freq": 120, "q": 0.7}},
    {"id": "filter", "params": {"mode": "lowpass", "freq": 3200, "q": 2.5}},
    {"id": "compressor", "params": {"threshold": -22, "ratio": 6, "attack": 3,
                                    "release": 180, "makeup": 4}},
    {"id": "echo", "params": {"time": 320, "feedback": 0.4, "mix": 0.35}},
    {"id": "chorus", "params": {"rate": 1.5, "depth": 0.6}},
    {"id": "tremolo", "params": {"rate": 6, "depth": 0.7}},
    {"id": "overdrive", "params": {"drive": 14, "output": -6}},
    {"id": "reverb", "params": {"size": 0.4, "decay": 1.6, "mix": 0.35}},
    {"id": "phaser", "params": {"rate": 0.5, "depth": 0.6, "feedback": 0.5}},
    {"id": "pan", "params": {"pan": -0.5}},
]


def _run(chain, seconds=1.0):
    """Build one second of tone through `chain` in the shape the renderer uses
    (adelay first, so a time-based effect sees timeline time)."""
    graph = "[0:a]adelay=0|0"
    if chain:
        graph += "," + chain
    graph += ",aresample=48000[a]"
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi",
         "-i", "sine=frequency=440:duration=%s:sample_rate=48000" % seconds,
         "-filter_complex", graph, "-map", "[a]", "-f", "null", "-"],
        capture_output=True, text=True)


@pytest.mark.parametrize("fx", EVERY, ids=lambda f: f["id"] + "/" + str(f["params"].get("mode", "")))
def test_each_effect_is_a_graph_ffmpeg_accepts(fx):
    r = _run(audio_fx.chain([fx]))
    assert r.returncode == 0, r.stderr


def test_the_whole_catalog_chained_at_once_still_parses():
    r = _run(audio_fx.chain(EVERY))          # capped at MAX_FX by `filters`
    assert r.returncode == 0, r.stderr


def test_extreme_but_legal_settings_are_accepted():
    edges = [
        {"id": "eq", "params": {"low": 18, "mid": -18, "high": 18}},
        {"id": "filter", "params": {"mode": "lowpass", "freq": 40, "q": 10}},
        {"id": "compressor", "params": {"threshold": -60, "ratio": 20, "attack": 0.1,
                                        "release": 2000, "makeup": 24}},
        {"id": "echo", "params": {"time": 1000, "feedback": 0.9, "mix": 1}},
        # The longest tail the catalog allows: 128 taps, ~1.7KB of arguments in
        # one `aecho`. If ffmpeg ever caps the list this is where it shows.
        {"id": "reverb", "params": {"size": 1, "decay": 6, "mix": 1}},
        {"id": "overdrive", "params": {"drive": 36, "output": -24}},
        {"id": "phaser", "params": {"rate": 2, "depth": 1, "feedback": 0.9}},
        {"id": "pan", "params": {"pan": -1}},
        {"id": "pan", "params": {"pan": 1}},
    ]
    for fx in edges:
        r = _run(audio_fx.chain([fx]))
        assert r.returncode == 0, "%s: %s" % (fx["id"], r.stderr)


def test_a_hand_mangled_row_cannot_produce_a_graph_that_fails():
    junk = [
        {"id": "filter", "params": {"mode": "'; drop", "freq": "x", "q": None}},
        {"id": "compressor", "params": {"threshold": float("nan"), "ratio": -99}},
        {"id": "echo", "params": {"time": -5, "feedback": 2, "mix": "loud"}},
        {"id": "tremolo", "params": {}},
        {"id": "pan", "params": {"pan": "hard left"}},
        {"id": "reverb", "params": {"decay": None, "mix": 2}},
    ]
    r = _run(audio_fx.chain(junk))
    assert r.returncode == 0, r.stderr


def test_every_eq_band_type_is_a_filter_this_ffmpeg_actually_has():
    """`bandreject` is the one that could plausibly be missing from a build,
    and a filtergraph fails as a unit — so one absent band type would take the
    whole mix down after the GPU had already been paid for."""
    for band in [{"type": "highpass", "freq": 80, "q": 0.7},
                 {"type": "lowshelf", "freq": 200, "gain": 4},
                 {"type": "peaking", "freq": 2500, "gain": -4.5, "q": 3.2},
                 {"type": "highshelf", "freq": 6000, "gain": 3},
                 {"type": "lowpass", "freq": 14000, "q": 0.9},
                 {"type": "notch", "freq": 50, "q": 10}]:
        r = _run(audio_fx.chain([{"id": "eq", "params": {"bands": [band]}}]))
        assert r.returncode == 0, "%s: %s" % (band["type"], r.stderr)


def test_an_eq_band_lands_where_the_plot_says_it_does():
    """The curve the panel draws is computed from RBJ coefficients; this is
    ffmpeg agreeing with it at the one point that is easy to measure."""
    import re

    def loudness(chain, tone):
        graph = "[0:a]adelay=0|0" + ("," + chain if chain else "") + ",volumedetect[a]"
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "lavfi",
             "-i", "sine=frequency=%d:duration=1:sample_rate=48000" % tone,
             "-filter_complex", graph, "-map", "[a]", "-f", "null", "-"],
            capture_output=True, text=True)
        m = re.search(r"mean_volume: (-?[\d.]+) dB", r.stderr)
        assert m, r.stderr
        return float(m.group(1))

    # A +12dB bell AT its own centre delivers its gain.
    eq = audio_fx.chain([{"id": "eq", "params": {
        "bands": [{"type": "peaking", "freq": 2000, "gain": 12, "q": 2}]}}])
    assert loudness(eq, 2000) - loudness("", 2000) > 10

    # ...and a notch at the same place removes it.
    notch = audio_fx.chain([{"id": "eq", "params": {
        "bands": [{"type": "notch", "freq": 2000, "q": 4}]}}])
    assert loudness(notch, 2000) < loudness("", 2000) - 20


def test_the_effect_actually_changes_the_signal():
    """A chain that parses but does nothing would pass every test above."""
    import re

    def loudness(chain, tone=440):
        graph = "[0:a]adelay=0|0" + ("," + chain if chain else "") + ",volumedetect[a]"
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "lavfi",
             "-i", "sine=frequency=%d:duration=1:sample_rate=48000" % tone,
             "-filter_complex", graph, "-map", "[a]", "-f", "null", "-"],
            capture_output=True, text=True)
        m = re.search(r"mean_volume: (-?[\d.]+) dB", r.stderr)
        assert m, r.stderr
        return float(m.group(1))

    # A 440Hz tone through a 3.2kHz HIGH-pass is well below the corner.
    dry = loudness("")
    cut = loudness(audio_fx.chain([{"id": "filter", "params": {"mode": "highpass", "freq": 3200}}]))
    assert cut < dry - 12, "high-pass did not attenuate a tone below its corner (%s -> %s)" % (dry, cut)

    # The EQ's mid band is a peak AT 1.2kHz with Q 1, so it is measured with a
    # tone at that centre — at 440Hz a +12dB peak is only worth ~2dB, which is
    # the physics of the band and not evidence about the filter.
    dry_mid = loudness("", tone=1200)
    boost = loudness(audio_fx.chain([{"id": "eq", "params": {"mid": 12}}]), tone=1200)
    assert boost > dry_mid + 8, "an EQ boost at the band's centre did nothing (%s -> %s)" % (dry_mid, boost)


def test_the_reverb_ffmpeg_plays_is_the_one_the_browser_convolves():
    """The tap list is the whole effect, so read it back off an impulse.

    This is the check that makes the reverb's parity a fact rather than a
    claim: the browser builds its impulse response from `reverb_taps`, and if
    `aecho` did anything other than place those exact taps — recirculated,
    rescaled, resampled the delays — the two engines would drift apart with
    nothing on screen to say so.
    """
    import struct

    taps = audio_fx.reverb_taps(0.4, 0.8, 0.5)
    chain = audio_fx.chain([{"id": "reverb",
                             "params": {"size": 0.4, "decay": 0.8, "mix": 0.5}}])
    # 1kHz so one sample is one millisecond and a tap's index IS its delay.
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi",
         "-i", r"aevalsrc=if(lt(n\,1)\,1\,0):s=1000:d=1.4:c=mono",
         "-af", chain, "-f", "f32le", "-"], capture_output=True)
    assert r.returncode == 0, r.stderr
    got = struct.unpack("<%df" % (len(r.stdout) // 4), r.stdout)

    assert abs(got[0] - 1.0) < 1e-6, "the dry signal must come through untouched"
    # FLOOR, not round: aecho truncates a delay to the sample below it, which
    # is what src/lib/audioGraph.ts's irBuffer does when it lays the same taps
    # into an AudioBuffer. At 1kHz that is what puts 68.8ms on sample 68.
    # Several taps can share a sample at this rate, so compare the sums.
    want = {}
    for ms, gain in taps:
        want[int(ms)] = want.get(int(ms), 0.0) + gain
    for i, g in want.items():
        if i >= len(got):
            continue
        assert abs(got[i] - g) < 2e-3, "tap at %dms: ffmpeg %.4f, taps %.4f" % (i, got[i], g)
    stray = [i for i, v in enumerate(got) if abs(v) > 2e-3 and i and i not in want]
    assert not stray, "ffmpeg produced reflections nothing asked for: %s" % stray[:8]
    assert len([v for v in got if abs(v) > 1e-6]) <= len(want) + 1, \
        "nothing may recirculate — aecho is feed-forward and the IR assumes it"


def test_pan_moves_the_signal_and_a_mono_clip_is_not_hard_left():
    """The `aformat` in front of the pan matrix, measured.

    Without it ffmpeg reads the missing right channel as zero and a mono clip
    comes out hard left at EVERY setting — a silent failure that sounds like a
    broken file rather than a broken filter.
    """
    import struct

    def channels(pan, layout):
        chain = audio_fx.chain([{"id": "pan", "params": {"pan": pan}}])
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi",
             "-i", r"aevalsrc=if(lt(n\,1)\,1\,0)%s:s=1000:d=0.02:c=%s"
             % (r"|if(lt(n\,1)\,1\,0)" if layout == "stereo" else "", layout),
             "-af", chain, "-f", "f32le", "-"], capture_output=True)
        assert r.returncode == 0, r.stderr
        v = struct.unpack("<%df" % (len(r.stdout) // 4), r.stdout)
        return v[0], v[1]

    l, r = channels(-0.5, "stereo")
    assert l > r > 0, "half left should favour the left and keep the right (%s, %s)" % (l, r)
    l, r = channels(0.5, "stereo")
    assert r > l > 0

    ml, mr = channels(-0.5, "mono")
    assert mr > 0.1, "a mono clip panned half left must still reach the right (%s)" % mr
    # Same IMAGE as the stereo case — the ratio is what panning is — while the
    # level differs by up to 3dB because ffmpeg's mono upmix is equal-power.
    sl, sr = channels(-0.5, "stereo")
    assert abs((ml / mr) - (sl / sr)) < 1e-3


def test_overdrive_actually_saturates():
    import re

    def peak(chain):
        graph = "[0:a]adelay=0|0" + ("," + chain if chain else "") + ",volumedetect[a]"
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "lavfi",
             "-i", "sine=frequency=440:duration=1:sample_rate=48000",
             "-filter_complex", graph, "-map", "[a]", "-f", "null", "-"],
            capture_output=True, text=True)
        m = re.search(r"max_volume: (-?[\d.]+) dB", r.stderr)
        assert m, r.stderr
        return float(m.group(1))

    # +24dB of drive into a shaper that saturates at 1.0: the peak must NOT
    # come out 24dB louder, which is the whole point of a soft clipper.
    hot = peak(audio_fx.chain([{"id": "overdrive", "params": {"drive": 24, "output": 0}}]))
    assert hot < 1.0, "a soft clip must not exceed full scale (%s dBFS)" % hot
    assert hot > -1.0, "and 24dB of drive should be pinned right up against it"

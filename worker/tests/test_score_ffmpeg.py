"""The score mix, through the real ffmpeg.

Shapes and arithmetic are pinned in test_score.py; this is the part only the
binary can answer — and the part that matters most, because this filtergraph
runs at the END of an episode, after every block's GPU time has been spent. A
filtergraph fails as a UNIT: one filter this build does not have and the whole
assemble step dies with the cut already paid for.

Skipped when ffmpeg is absent, so a laptop without it still runs the suite.
"""
import os
import re
import shutil
import subprocess
import tempfile

import pytest

import score_mix as SM

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None,
                                reason="ffmpeg not installed")

CUT_MS = 12000
SCORE_MS = 8000


def _ff(args, **kw):
    return subprocess.run(["ffmpeg", "-hide_banner", *args],
                          capture_output=True, text=True, **kw)


def _stderr(args):
    return _ff([*args, "-f", "null", "-"]).stderr


def _lufs(path, ss=None, t=None):
    pre = (["-ss", str(ss)] if ss is not None else []) + (["-t", str(t)] if t else [])
    m = re.findall(r"I:\s*(-?[\d.]+)\s*LUFS",
                   _stderr([*pre, "-i", path, "-af", "ebur128=peak=true"]))
    return float(m[-1]) if m else None


@pytest.fixture(scope="module")
def fixtures():
    d = tempfile.mkdtemp(prefix="scoremix_")
    cut, score = os.path.join(d, "cut.mp4"), os.path.join(d, "score.mp3")
    assert _ff(["-y", "-loglevel", "error",
                "-f", "lavfi", "-i", f"testsrc=size=320x180:rate=24:duration={CUT_MS / 1000}",
                "-f", "lavfi", "-i", f"sine=frequency=300:duration={CUT_MS / 1000}",
                "-filter:a", "volume=-14dB", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", cut]).returncode == 0
    assert _ff(["-y", "-loglevel", "error", "-f", "lavfi",
                "-i", f"sine=frequency=800:duration={SCORE_MS / 1000}",
                "-filter:a", "volume=-3dB", score]).returncode == 0
    yield cut, score
    shutil.rmtree(d, ignore_errors=True)


# Two scenes: the first scored at 4, the second at 0 — "silence" is a cue, and
# proving it is really silence is the whole point of the envelope.
BLOCKS = [{"scene_ids": ["a"], "t_start_ms": 0, "t_end_ms": 4000},
          {"scene_ids": ["b"], "t_start_ms": 4000, "t_end_ms": 8000},
          {"scene_ids": ["a"], "t_start_ms": 8000, "t_end_ms": CUT_MS}]
SLUGS = {"a": "OPENING", "b": "THE_SILENCE"}
CUES = [{"scene": "OPENING", "intensity": 4}, {"scene": "THE_SILENCE", "intensity": 0}]


@pytest.fixture(scope="module")
def scored(fixtures):
    cut, score = fixtures
    gain = SM.bed_gain_db(SM.measure_lufs(score, _stderr),
                          SM.measure_lufs(cut, _stderr))
    assert gain is not None
    pts = SM.envelope_points(SM.cue_spans(BLOCKS, SLUGS, CUES))
    fc = SM.filter_complex(pts, gain, cut_ms=CUT_MS, score_ms=SCORE_MS,
                           has_programme=True)
    out = os.path.join(os.path.dirname(cut), "scored.mp4")
    r = _ff(["-y", "-loglevel", "error", "-i", cut, "-i", score,
             "-filter_complex", fc, "-map", "0:v", "-map", "[aout]",
             "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out])
    assert r.returncode == 0, r.stderr[-2000:]
    return cut, out, gain


def test_the_filtergraph_this_build_actually_runs(scored):
    _cut, out, _ = scored
    assert os.path.getsize(out) > 0


def test_the_cut_keeps_its_own_length(scored):
    cut, out, _ = scored
    def dur(p):
        return float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip())
    assert dur(out) == pytest.approx(dur(cut), abs=0.15)


def test_the_video_is_copied_not_re_encoded(scored):
    _cut, out, _ = scored
    codecs = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
         "-of", "csv=p=0", out], capture_output=True, text=True).stdout
    assert "video,h264" in codecs.replace("h264,video", "video,h264")


def test_a_silence_cue_leaves_the_films_own_audio_untouched(scored):
    """The measurement that makes `intensity: 0` mean something. Inside the
    silent cue the mixed file must read as the cut did — if it does not, the
    bed is playing under a scene the composer marked unscored."""
    cut, out, _ = scored
    assert _lufs(out, ss=4.6, t=1.8) == pytest.approx(_lufs(cut, ss=4.6, t=1.8),
                                                     abs=0.3)


def test_a_scored_cue_adds_the_bed_and_does_not_duck_the_programme(scored):
    """A bed placed `BED_BELOW_LU` down and lifted by the cue's own dB sums to
    a small, PREDICTABLE rise over the programme. A big rise means the bed is
    on top of the dialogue; a fall means amix normalized and the film just
    lost 6dB."""
    cut, out, _ = scored
    before, after = _lufs(cut, ss=0, t=4), _lufs(out, ss=0, t=4)
    rise = after - before
    expected = 10 * __import__("math").log10(
        1 + 10 ** ((SM.INTENSITY_DB[4] - SM.BED_BELOW_LU) / 10.0))
    assert rise == pytest.approx(expected, abs=0.4), (before, after, expected)

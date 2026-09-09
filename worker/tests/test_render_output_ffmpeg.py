"""Every output format, through the REAL ffmpeg.

A filtergraph or an encoder argument fails as a UNIT, and this one runs at the
very END of a timeline render — after every clip has been encoded and every
post pass has spent its GPU time. Discovering there that prores_ks will not
take yuv420p is the most expensive possible way to learn it. Same reasoning as
test_audio_fx_ffmpeg.py and test_score_ffmpeg.py; skipped when ffmpeg is absent.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import render_output as RO  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

W, H = 320, 176


def _encoders():
    out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                         capture_output=True, text=True).stdout
    return out


ENC = _encoders() if shutil.which("ffmpeg") else ""


def _source(path, seconds=1):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "lavfi", "-i", f"testsrc=size={W}x{H}:rate=24",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
         "-t", str(seconds), "-c:v", "libx264", "-crf", "18",
         "-pix_fmt", "yuv420p", "-c:a", "aac", path],
        check=True, capture_output=True)


def _probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format",
         "-of", "json", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


@pytest.mark.parametrize("fmt", sorted(RO.VIDEO_FORMATS))
def test_every_format_encodes_and_is_readable(fmt):
    spec = RO.normalize({"format": fmt})
    if RO.VIDEO_FORMATS[fmt]["encoder"] not in ENC:
        pytest.skip(f"{RO.VIDEO_FORMATS[fmt]['encoder']} not in this ffmpeg")
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "src.mp4")
        _source(src)
        dst = os.path.join(d, f"out.{RO.ext(spec)}")
        args = (["ffmpeg", "-y", "-v", "error", "-i", src]
                + RO.video_args(spec, W, H) + RO.audio_args(spec) + [dst])
        r = subprocess.run(args, capture_output=True, text=True)
        assert r.returncode == 0, f"{fmt}: {r.stderr[-800:]}\n{' '.join(args)}"
        info = _probe(dst)
        v = [s for s in info["streams"] if s["codec_type"] == "video"]
        assert v, f"{fmt} produced no video stream"
        # The picture must survive at the size it went in at.
        assert (v[0]["width"], v[0]["height"]) == (W, H)


def test_no_audio_really_strips_the_stream():
    spec = RO.normalize({"format": "h264", "audio": "none"})
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "src.mp4")
        _source(src)
        dst = os.path.join(d, "out.mp4")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src]
                       + RO.video_args(spec, W, H) + RO.audio_args(spec) + [dst],
                       check=True, capture_output=True)
        assert not [s for s in _probe(dst)["streams"] if s["codec_type"] == "audio"]


def test_resolution_and_fps_reach_the_file():
    """Both are silent when wrong: a dropped -vf gives a correct-looking file at
    the wrong size, and a dropped -r gives one at the wrong length."""
    spec = RO.normalize({"format": "h264", "resolution": 540, "fps": 12})
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "src.mp4")
        _source(src, seconds=2)
        dst = os.path.join(d, "out.mp4")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src]
                       + RO.video_args(spec, W, H) + RO.audio_args(spec) + [dst],
                       check=True, capture_output=True)
        v = [s for s in _probe(dst)["streams"] if s["codec_type"] == "video"][0]
        # 320x176 short edge 176 -> 540 is an upscale; the point is that the
        # computed size is what lands, whichever direction it goes.
        assert (v["width"], v["height"]) == RO.out_size(spec, W, H) == (982, 540)
        num, den = v["avg_frame_rate"].split("/")
        assert abs(int(num) / int(den) - 12) < 0.6


def test_prores_gets_a_10_bit_422_pixel_format():
    """prores_ks handed yuv420p writes a file that opens and is not conformant
    ProRes, which is exactly the kind of wrong nobody notices until an NLE
    refuses it."""
    if "prores_ks" not in ENC:
        pytest.skip("prores_ks not in this ffmpeg")
    spec = RO.normalize({"format": "prores", "quality": 3})
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "src.mp4")
        _source(src)
        dst = os.path.join(d, "out.mov")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src]
                       + RO.video_args(spec, W, H) + RO.audio_args(spec) + [dst],
                       check=True, capture_output=True)
        v = [s for s in _probe(dst)["streams"] if s["codec_type"] == "video"][0]
        assert v["pix_fmt"] == "yuv422p10le"
        a = [s for s in _probe(dst)["streams"] if s["codec_type"] == "audio"][0]
        assert a["codec_name"] == "pcm_s24le"


def test_vp9_carries_opus_and_not_aac():
    """The legality table is not cosmetic: normalize() must correct the pair,
    because webm genuinely will not mux AAC and ffmpeg fails the whole render
    to say so."""
    if "libvpx-vp9" not in ENC:
        pytest.skip("libvpx-vp9 not in this ffmpeg")
    spec = RO.normalize({"format": "vp9", "audio": "aac"})
    assert spec["audio"] == "opus"
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "src.mp4")
        _source(src)
        dst = os.path.join(d, "out.webm")
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src]
                           + RO.video_args(spec, W, H) + RO.audio_args(spec) + [dst],
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr[-800:]
        a = [s for s in _probe(dst)["streams"] if s["codec_type"] == "audio"][0]
        assert a["codec_name"] == "opus"


def test_faststart_is_only_asked_of_containers_that_have_it():
    """-movflags on webm is not fatal but it is a lie about the container."""
    assert "-movflags" in RO.video_args(RO.normalize({"format": "h264"}), W, H)
    assert "-movflags" not in RO.video_args(RO.normalize({"format": "vp9"}), W, H)


def test_nvenc_is_given_cq_and_never_crf():
    """NVENC IGNORES -crf rather than refusing it — the render comes back at
    the encoder's own default bitrate and nothing says the quality control did
    nothing."""
    spec = RO.normalize({"format": "h264", "hardware": True, "quality": 20})
    args = RO.video_args(spec, W, H)
    assert "-crf" not in args
    assert args[args.index("-cq") + 1] == "20"
    assert RO.encoder(spec) == "h264_nvenc"


@pytest.mark.skipif("h264_nvenc" not in ENC, reason="no nvenc in this ffmpeg")
def test_nvenc_actually_encodes():
    spec = RO.normalize({"format": "h264", "hardware": True})
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "src.mp4")
        _source(src)
        dst = os.path.join(d, "out.mp4")
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src]
                           + RO.video_args(spec, W, H) + RO.audio_args(spec) + [dst],
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr[-800:]

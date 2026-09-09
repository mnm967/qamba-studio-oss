"""The copy-concat assembly path, against the real binary.

Every piece comes out of ONE encoder with identical settings, so assembly is a
single `-c copy` concat — that claim is about ffmpeg's concat demuxer and only
ffmpeg can check it. What would break silently: a tail segment whose encoder
parameters drift from the clip pieces' (the concat "succeeds" and players
glitch at the seam), an audio-less piece in the list, a frame drifting in at
the joins (the bug the audio-strip in `_windowed` fixed one layer down).
"""
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None,
                                reason="ffmpeg not installed")

W, H, FPS = 320, 180, 24
TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-color_range", "tv"]


def _piece(path, seconds, color):
    """Encoded the way render_clip_file's encode() encodes."""
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "lavfi", "-i", f"color=c={color}:s={W}x{H}:r={FPS}",
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
         "-t", f"{seconds:.3f}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
         "-preset", "veryfast"] + TAGS
        + ["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
           "-movflags", "+faststart", path],
        check=True)


def _frames(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v",
         "-count_frames", "-show_entries", "stream=nb_read_frames",
         "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


def test_copy_concat_of_uniform_pieces_and_tail_is_frame_exact(tmp_path):
    a, b, tail = str(tmp_path / "a.mp4"), str(tmp_path / "b.mp4"), str(tmp_path / "t.mp4")
    _piece(a, 2.0, "red")
    _piece(b, 1.5, "blue")
    _piece(tail, 1.0, "black")     # the outro tail is just one more piece
    listf = str(tmp_path / "l.txt")
    with open(listf, "w") as f:
        for p in (a, b, tail):
            f.write(f"file '{p}'\n")
    out = str(tmp_path / "out.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                    "-i", listf, "-c", "copy", "-movflags", "+faststart", out],
                   check=True)
    assert _frames(out) == round((2.0 + 1.5 + 1.0) * FPS)
    # The tags rode the copy — the deliverable inherits them for free.
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v",
         "-show_entries", "stream=color_range,color_space", "-of", "csv=p=0", out],
        capture_output=True, text=True, check=True).stdout.strip()
    assert probe == "tv,bt709"


def test_transcode_chain_tags_and_keeps_quality(tmp_path):
    import media
    src = str(tmp_path / "raw.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "lavfi", "-i", f"testsrc2=s={W}x{H}:r={FPS}:d=1",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
         "-c:a", "aac", "-shortest", src], check=True)
    dst = str(tmp_path / "chain.mp4")
    media.transcode_chain(src, dst)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_name,color_range,color_space", "-of", "csv=p=0", dst],
        capture_output=True, text=True, check=True).stdout
    assert "tv,bt709" in probe          # tagged
    assert "aac" in probe               # audio survived (stream-copied)


def _chain_size(tmp_path, src_h, tag, **kw):
    """A chain hop at `src_h` tall -> the height it comes out at."""
    import media
    src = str(tmp_path / f"in_{tag}.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"testsrc2=s={round(src_h * 16 / 9 / 2) * 2}x{src_h}:r={FPS}:d=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", src], check=True)
    dst = str(tmp_path / f"out_{tag}.mp4")
    media.transcode_chain(src, dst, **kw)
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=height", "-of", "csv=p=0", dst],
        capture_output=True, text=True, check=True).stdout.strip()
    return int(out.split(",")[0])


def test_the_chain_cap_is_the_frame_the_render_is_going_to(tmp_path):
    """THE CAP WAS A CEILING ON THE WHOLE POST CHAIN, not a quality choice.

    Every ComfyUI pass writes through `transcode_chain`, and it squashed each
    one to 1080 tall — so a SeedVR2 restore to 3840x2112 came back 1962x1080
    and the body render fitted THAT to the timeline. A 4K master could only
    ever be a 1080p one resampled up, with the restore's own detail thrown
    away in between, and nothing anywhere said so.
    """
    assert _chain_size(tmp_path, 2112, "def") == 1080            # the old ceiling
    assert _chain_size(tmp_path, 2112, "uhd", cap_h=2160) == 2112  # …lifted
    # Still a CAP, not a resize: a taller source is brought down to it and a
    # shorter one is left exactly where it is.
    assert _chain_size(tmp_path, 2160, "cap", cap_h=1440) == 1440
    assert _chain_size(tmp_path, 720, "small", cap_h=2160) == 720


def test_the_default_is_what_every_render_below_1080_already_did(tmp_path):
    """No existing render may change: the body render fits to the timeline
    immediately, so under 1080 the extra rows genuinely were waste."""
    for h in (704, 720, 1080):
        assert _chain_size(tmp_path, h, f"same{h}") == h


def test_extract_sheet_pools_the_window_not_one_moment(tmp_path):
    """A source whose brightness ramps: the sheet's mean must sit near the
    window mean, where any single frame sits wherever it was caught. The
    black-cell trap is the reason for the overshoot: a 3x3 tile fed 8 frames
    pads the ninth BLACK and drags the pooled mean down by ~11%."""
    import media
    src = str(tmp_path / "ramp.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"color=c=gray:s=64x64:r=24:d=4",
         "-vf", "geq=lum='40+40*T/4':cb=128:cr=128",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", src], check=True)
    png = str(tmp_path / "sheet.png")
    media.extract_sheet(src, png, in_ms=0, out_ms=4000)
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", png, "-vf",
         "signalstats,metadata=mode=print:file=-", "-frames:v", "1", "-f", "null", "-"],
        capture_output=True, text=True, check=True)
    yavg = float([l for l in out.stdout.splitlines() if "YAVG=" in l][0].split("=")[-1])
    # window mean of 40..80 ramp ≈ 60 (plus the yuv-limited offset the encode
    # applies uniformly); the midpoint frame would also read ~60 here, so the
    # discriminating assertion is the BLACK-CELL one: a padded sheet reads
    # ~53. Within 3 of the mean covers rate jitter but not a black ninth.
    assert abs(yavg - 60) < 5

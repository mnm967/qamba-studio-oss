"""Media I/O + ffmpeg primitives shared by every handler.

All durations at this layer are seconds-as-float at the ffmpeg boundary;
callers convert from the DB's milliseconds.

ONE STORE: THE PROJECT'S OWN FOLDER. `QAMBA_MEDIA_ROOT` names the directory
the app keeps this project's media in, and every `b2_*` call below is a file
operation under it. No bucket, no credential, no network — a render reads and
writes the same disk the rows live on.

The `b2_` names are kept on purpose. Every handler in this package calls them,
they are the object-store verbs rather than anyone's product name, and
renaming them to `media_get`/`media_put` would touch ~60 call sites to say
nothing new. What they no longer imply is a bucket: the cloud build had two
more stores behind these functions (an S3 client with an app key, and a
presigned PUT through a hosted route) and neither is part of this one. Both
are gone rather than dormant — a code path that reaches for a write credential
for somebody else's storage is not something to leave lying in a local app.

A KEY IS ATTACKER-ADJACENT DATA, which is what `safe_key` is for: it arrives
on a row, and it is used to build a path.
"""
import json
import os
import shutil
import subprocess

#: This project's media directory. Read at CALL time rather than captured at
#: import, because one interpreter is started per job and a test may set it
#: either way round.
MEDIA_ROOT_ENV = "QAMBA_MEDIA_ROOT"


def media_root():
    """The project folder this process serves, or None."""
    return os.environ.get(MEDIA_ROOT_ENV) or None


def store_mode():
    """Whether this process has anywhere to put a render.

    Named rather than left to fail on the first write: finding out after the
    sampling is the whole cost this avoids.
    """
    return "folder" if media_root() else "none"


def safe_key(key):
    """A relative path under the media root, or a refusal.

    An object key is ATTACKER-ADJACENT DATA in the same narrow sense
    `localstore::safe_key` names on the Rust side: it can arrive from a row a
    pull copied down, and it is used to build a path. The twin of that
    function, and deliberately as strict — no absolute paths, no `..`, no
    backslashes, no drive letters.
    """
    k = str(key or "").strip().replace("\\", "/")
    if not k or k.startswith("/") or ":" in k.split("/")[0]:
        raise ValueError(f"unsafe media key: {key!r}")
    parts = [p for p in k.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError(f"unsafe media key: {key!r}")
    if not parts:
        raise ValueError(f"unsafe media key: {key!r}")
    return "/".join(parts)


def local_path(key, root=None):
    """Where a key lives on this machine. Only meaningful in FOLDER mode."""
    base = root or media_root()
    if not base:
        raise RuntimeError(f"{MEDIA_ROOT_ENV} is not set")
    return os.path.join(base, *safe_key(key).split("/"))


class FfmpegError(RuntimeError):
    pass


# ---------------------------------------------------------------- media ----
def _root():
    root = media_root()
    if not root:
        raise RuntimeError(
            f"{MEDIA_ROOT_ENV} is not set, so this process has no media folder "
            "to read or write — the app sets it when it spawns the pipeline")
    return root


def b2_get(key, dest):
    """Copy one stored object to `dest`.

    A MISSING FILE IS NAMED, and that matters more here than it looks: a row
    is not a file. A project can reference media it does not hold — a job that
    was cancelled between registering an asset and writing it, a project
    folder somebody moved things out of — and the browser copes by rendering
    nothing (`localMediaUrl` returns null and the player says so). The
    pipeline cannot, so it says which key and where it looked rather than
    failing somewhere further in on a file that is not there.
    """
    src = local_path(key, _root())
    if not os.path.exists(src):
        raise RuntimeError(f"{key} is not in this project's media folder ({src})")
    os.makedirs(os.path.dirname(os.path.abspath(dest)) or ".", exist_ok=True)
    shutil.copyfile(src, dest)
    return dest


def b2_put(local, key, content_type="video/mp4"):
    """Store one file under `key`.

    `content_type` is a bucket concept and a no-op on a folder — the extension
    carries it here, exactly as it does for every file the app itself writes.
    Kept in the signature because ~30 call sites pass it and dropping it would
    be a rename with nothing behind it.
    """
    dest = local_path(key, _root())
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    shutil.copyfile(local, dest)
    return key


def b2_delete(key):
    try:
        os.remove(local_path(key, _root()))
        return True
    except OSError:
        return False


def b2_list(prefix=""):
    """Iterate every key under a prefix (the GC sweep)."""
    root = _root()
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(dirpath, name)
            key = os.path.relpath(full, root).replace(os.sep, "/")
            if prefix and not key.startswith(prefix):
                continue
            st = os.stat(full)
            yield key, st.st_size, st.st_mtime


# ----------------------------------------------------------------- ffmpeg ----
def run_ff(args, label="", cancel_check=None, timeout=3600):
    """Run ffmpeg with optional cooperative cancellation (poll cancel_check
    every second; kill the process when it returns True)."""
    proc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error"] + args,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    waited = 0.0
    while True:
        try:
            _, err = proc.communicate(timeout=1)
            break
        except subprocess.TimeoutExpired:
            waited += 1
            if cancel_check and cancel_check():
                proc.kill()
                proc.communicate()
                raise InterruptedError(f"ffmpeg {label} canceled")
            if waited > timeout:
                proc.kill()
                proc.communicate()
                raise FfmpegError(f"ffmpeg {label} timed out")
    if proc.returncode != 0:
        raise FfmpegError(f"ffmpeg {label} failed: {(err or '')[-400:]}")


def probe(path):
    """{width, height, duration_ms, fps, has_audio, bytes} for a media file."""
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json",
                        "-show_format", "-show_streams", path],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise FfmpegError(f"ffprobe failed: {r.stderr[-300:]}")
    info = json.loads(r.stdout)
    out = {"width": None, "height": None, "duration_ms": None, "fps": None,
           "has_audio": False, "bytes": None}
    fmt = info.get("format", {})
    if fmt.get("duration"):
        out["duration_ms"] = int(float(fmt["duration"]) * 1000)
    if fmt.get("size"):
        out["bytes"] = int(fmt["size"])
    for st in info.get("streams", []):
        if st.get("codec_type") == "video" and out["width"] is None:
            out["width"], out["height"] = st.get("width"), st.get("height")
            fr = st.get("avg_frame_rate") or st.get("r_frame_rate") or "0/1"
            try:
                num, den = fr.split("/")
                if float(den):
                    out["fps"] = round(float(num) / float(den), 3)
            except ValueError:
                pass
        if st.get("codec_type") == "audio":
            out["has_audio"] = True
    return out


def has_audio(path):
    try:
        return probe(path)["has_audio"]
    except Exception:
        return False


def transcode_web(src, dst, cancel_check=None):
    """Faststart web mp4, h264 yuv420p crf20, ≤1080p tall, audio preserved
    (H3 takes carry native audio)."""
    args = ["-i", src, "-movflags", "+faststart", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "veryfast",
            "-vf", "scale=-2:'min(1080,ih)'"]
    args += (["-c:a", "aac", "-b:a", "192k", "-ac", "2"] if has_audio(src) else ["-an"])
    run_ff(args + [dst], "transcode", cancel_check)
    if not os.path.exists(dst):
        raise FfmpegError("transcode produced no file")


def transcode_chain(src, dst, cancel_check=None, cap_h=1080):
    """Normalise a ComfyUI output for the NEXT post-chain hop.

    `cap_h` IS THE FRAME THE RENDER IS GOING TO, and it was a constant 1080 —
    which made the post chain unable to deliver above 1080p AT ALL. Every pass
    writes through here, so a SeedVR2 restore to 3840x2112 was squashed to
    1962x1080 one hop later and the body render then fitted THAT to the
    timeline: a 4K master was a 1080p master resampled up twice, with the
    restore's whole point discarded in between and nothing saying so. Measured
    — a 2x refine of a 1280x704 take came back from this function 1964x1080.
    The caller passes the timeline's own height (`render_clip_with_post`),
    because the body render fits to that immediately and anything above it
    really is waste; the 1080 default keeps every standalone `post_*` job and
    every render below it byte-identical.

    Not `transcode_web`: that one is the delivery/preview transcode and its
    crf 20 veryfast is a WEB quality. A chain intermediate is re-encoded once
    per pass — a four-pass chain put every clip through four crf-20
    generations before the clip render ever saw it, which is a measurable
    share of "the final render is softer than the timeline". crf 12 here is
    visually lossless; the files are temps on /data and are deleted per hop.

    Audio is STREAM-COPIED when it can be. The chain passes either preserve
    the source soundtrack (ltx_refine, color_match wire it through) or have it
    re-muxed whole (`_windowed`), so re-encoding it per hop was pure
    generation loss. ComfyUI writes aac, so the copy is the normal case; the
    fallback re-encode covers anything else.

    The picture is TAGGED bt709/tv. ComfyUI's SaveVideo writes correct
    limited-range yuv and tags nothing (measured with a ramp through the live
    engine), so the pixels are already right — the tags make every player and
    every later ffmpeg read them the same way.
    """
    base = ["-i", src, "-movflags", "+faststart", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-crf", "12", "-preset", "veryfast",
            "-vf", f"scale=-2:'min({max(2, int(cap_h))},ih)'",
            "-colorspace", "bt709", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-color_range", "tv"]
    if not has_audio(src):
        run_ff(base + ["-an", dst], "transcode-chain", cancel_check)
    else:
        try:
            run_ff(base + ["-c:a", "copy", dst], "transcode-chain", cancel_check)
        except FfmpegError:
            run_ff(base + ["-c:a", "aac", "-b:a", "192k", "-ac", "2", dst],
                   "transcode-chain", cancel_check)
    if not os.path.exists(dst):
        raise FfmpegError("chain transcode produced no file")


def extract_sheet(video_path, out_png, *, in_ms=0, out_ms=None, tiles=3):
    """A 3x3 contact sheet of frames spread evenly across [in_ms, out_ms] —
    the SHOT'S colour distribution as one image.

    For a colour-match reference, one frame is too small a sample: a global
    transfer matches the whole clip to whatever instant the frame happened to
    catch, and a real shot swings — measured 57..71 YAVG inside one 3.6s
    window, with the middle frame the single brightest moment, so the matched
    clip came back +5 luma over its own average. Nine frames pooled ARE the
    window's distribution, and the matcher lands on the shot instead of on a
    moment of it. The sample rate overshoots (tiles^2 + ~1) because `tile`
    pads a short final sheet with BLACK cells, and one black ninth skews the
    pooled histogram by more than the problem being fixed.

    Falls back to the single middle frame when the window is too short to
    fill a sheet.
    """
    info = probe(video_path) or {}
    dur = int(info.get("duration_ms") or 0)
    a = max(0, int(in_ms or 0))
    b = int(out_ms) if out_ms else dur
    if dur and b > dur:
        b = dur
    span = (b - a) / 1000.0
    n = tiles * tiles
    fps_v = float(info.get("fps") or 24)
    if span <= 0 or span * fps_v < n:
        return extract_frame(video_path, out_png, at_ms=(a + b) // 2)
    rate = (n + 0.8) / span
    run_ff(["-ss", f"{a / 1000:.3f}", "-to", f"{b / 1000:.3f}", "-i", video_path,
            "-vf", f"fps={rate:.6f},scale=640:-2,tile={tiles}x{tiles}",
            "-frames:v", "1", out_png], "extract-sheet")
    if not os.path.exists(out_png):
        raise FfmpegError("sheet extraction produced no file")
    return out_png


def extract_frame(video_path, out_png, *, at_ms=None, from_end=False):
    """Grab one exact frame. from_end=True takes the last displayed frame."""
    if from_end:
        args = ["-sseof", "-0.3", "-i", video_path, "-update", "1", "-frames:v", "1", out_png]
    else:
        args = ["-ss", f"{(at_ms or 0) / 1000:.3f}", "-i", video_path,
                "-frames:v", "1", out_png]
    run_ff(args, "extract-frame")
    if not os.path.exists(out_png):
        raise FfmpegError("frame extraction produced no file")
    return out_png


def replace_audio(src_video, audio, dest, *, cancel_check=None):
    """Swap a video's soundtrack for `audio`. The PICTURE is copied, not
    re-encoded — `-c:v copy` — which is the whole reason this is a mux and not
    a render.

    Two consequences worth stating, because both are invisible in the file:

    * The frames are bit-identical to the source, so a take published this way
      has the SAME last frame as the take it came from. Nothing downstream of
      it in a chain needs re-rendering, which is why the caller passes
      `mark_stale=False` — a staleness sweep for a change that provably cannot
      move a chain anchor is the warning nobody reads.
    * Generated audio almost never lands on the video's exact length (MMAudio
      quantises to its own latent grid). `apad` makes the new track infinite
      and `-shortest` then ends the output at the PICTURE — so a short track is
      padded with silence and a long one is trimmed, and the clip's duration is
      untouched either way. Letting `-shortest` see the raw audio instead would
      truncate the VIDEO whenever the sound came up short, which is a silent
      edit to the cut.

    MEASURED 2026-08-24 on an 8.000s take: the video stream comes back with the
    IDENTICAL md5 (so the bit-identical claim above is proven, not assumed) and
    the muxed audio runs 7.914s against the picture's 8.000s. That 86ms is
    packet granularity, not a bug — `-shortest` stops on whole packets and an
    AAC frame is 1024 samples (21.3ms at 48kHz), so the pad lands up to one
    frame short. Said out loud because "padded with silence" reads as exact,
    and a claim that is 86ms wrong is the kind that gets diagnosed twice.
    """
    run_ff(["-i", src_video, "-i", audio,
            "-filter_complex", "[1:a]apad[aout]",
            "-map", "0:v:0", "-map", "[aout]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-ac", "2", "-shortest", "-movflags", "+faststart", dest],
           label="replace_audio", cancel_check=cancel_check)


def slice_audio(src, dst, *, start_ms, duration_ms, sample_rate=32000, pad_start_ms=0):
    """Cut [start, start+duration) to stereo WAV at the model's sample rate.
    Negative start (warmup before t=0) is silence-padded so alignment holds."""
    delay = max(0, pad_start_ms)
    ss = max(0, start_ms) / 1000.0
    args = ["-ss", f"{ss:.3f}", "-i", src, "-t", f"{duration_ms / 1000.0:.3f}"]
    filters = [f"aresample={sample_rate}", "aformat=channel_layouts=stereo"]
    if delay:
        filters.insert(0, f"adelay={delay}|{delay}")
    args += ["-af", ",".join(filters), "-c:a", "pcm_s16le", dst]
    run_ff(args, "slice-audio")
    return dst


def waveform_peaks(path, buckets=1600):
    """Peak per bucket (0..1) for timeline waveforms — computed server-side so
    phones never decode a two-minute track."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1",
                        "-ar", "8000", "-f", "s16le", "-"],
                       capture_output=True, timeout=300)
    if r.returncode != 0 or not r.stdout:
        return []
    import array
    samples = array.array("h")
    samples.frombytes(r.stdout[: (len(r.stdout) // 2) * 2])
    n = len(samples)
    if not n:
        return []
    per = max(1, n // buckets)
    peaks = []
    for i in range(0, n, per):
        chunk = samples[i:i + per]
        peaks.append(round(max(abs(min(chunk)), abs(max(chunk))) / 32768, 3))
        if len(peaks) >= buckets:
            break
    return peaks


def download(url, dest, timeout=600):
    """Stream an arbitrary HTTPS URL to disk (hosted-provider results)."""
    import requests as _rq
    with _rq.get(url, stream=True, timeout=(10, timeout)) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    return dest

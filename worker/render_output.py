"""What the final render is ENCODED as — the ffmpeg side of the output spec.

Python twin of src/lib/renderOutput.ts. Same format table, same normalisation
rules, same defaults; this side additionally BUILDS the arguments, because the
worker is the only thing that encodes. `src/lib/renderOutput.test.ts` parses
this file and fails if the two tables disagree — a format the browser offers
and this cannot build is a render that dies after every clip has been encoded.

Pure: no imports, no I/O, so it is testable off the pod.

Every codec here was checked against the pod's own ffmpeg (4.4.2) rather than
assumed available. AV1 is deliberately absent — that build has neither
libsvtav1 nor av1_nvenc.
"""

#: id -> (ext, content_type, encoder, hw_encoder|None, quality kind,
#:        qmin, qmax, qdefault, allowed audio)
VIDEO_FORMATS = {
    "h264": {
        "ext": "mp4", "content_type": "video/mp4",
        "encoder": "libx264", "hw_encoder": "h264_nvenc",
        "quality": "crf", "q_min": 14, "q_max": 32, "q_default": 18,
        "audio": ["aac", "none"],
    },
    "h265": {
        "ext": "mp4", "content_type": "video/mp4",
        "encoder": "libx265", "hw_encoder": "hevc_nvenc",
        "quality": "crf", "q_min": 18, "q_max": 36, "q_default": 22,
        "audio": ["aac", "none"],
    },
    "prores": {
        "ext": "mov", "content_type": "video/quicktime",
        "encoder": "prores_ks", "hw_encoder": None,
        "quality": "profile", "q_min": 0, "q_max": 5, "q_default": 3,
        "audio": ["pcm_s24le", "aac", "none"],
    },
    "vp9": {
        "ext": "webm", "content_type": "video/webm",
        "encoder": "libvpx-vp9", "hw_encoder": None,
        "quality": "crf", "q_min": 24, "q_max": 45, "q_default": 31,
        "audio": ["opus", "none"],
    },
}

AUDIO_CODECS = {
    "aac": {"bitrates": [128, 192, 256, 320], "bitrate_default": 192},
    "opus": {"bitrates": [96, 128, 192, 256], "bitrate_default": 128},
    "pcm_s24le": {"bitrates": None, "bitrate_default": None},
    "none": {"bitrates": None, "bitrate_default": None},
}

SAMPLE_RATES = [44100, 48000]

#: Delivery resolutions as the SHORT EDGE in pixels. The short edge and not the
#: height, because that is the one reading that works both ways up: 1080p is
#: ?x1080 on a landscape cut and 1080x? on a vertical one. The timeline's
#: aspect is preserved either way — this resizes the frame, it never re-frames
#: it, so a 1280x704 cut at 1080p delivers 1964x1080 and not a letterboxed
#: 1920x1080.
RESOLUTIONS = [540, 720, 1080, 1440, 2160]

DEFAULT = {
    "format": "h264",
    "quality": 18,
    "hardware": False,
    "audio": "aac",
    "audio_bitrate": 192,
    "sample_rate": 48000,
    "resolution": None,
    "fps": None,
}

#: What the intermediates are encoded at, and what every render produced before
#: this module existed. The final step can `-c:v copy` when the requested
#: output matches it exactly — see `can_copy_video`.
INTERMEDIATE = {"encoder": "libx264", "crf": 18, "pix_fmt": "yuv420p"}


def _clamp(n, lo, hi):
    return max(lo, min(hi, n))


def normalize(v):
    """Row value -> a spec that is safe to build arguments from.

    Forgiving on RANGE (clamp) and corrective on LEGALITY: an audio codec the
    container cannot mux falls back to that container's first. Passing an
    illegal pair through would fail in ffmpeg at the very end of the render,
    after all the GPU time is spent, to say that webm will not carry AAC.
    """
    v = v if isinstance(v, dict) else {}
    fmt = v.get("format") if v.get("format") in VIDEO_FORMATS else DEFAULT["format"]
    f = VIDEO_FORMATS[fmt]

    q = v.get("quality")
    q = int(round(q)) if isinstance(q, (int, float)) and not isinstance(q, bool) else f["q_default"]
    q = _clamp(q, f["q_min"], f["q_max"])

    audio = v.get("audio") if v.get("audio") in f["audio"] else f["audio"][0]
    ac = AUDIO_CODECS[audio]
    if ac["bitrates"]:
        br = v.get("audio_bitrate")
        br = int(br) if isinstance(br, (int, float)) and int(br) in ac["bitrates"] \
            else ac["bitrate_default"]
    else:
        br = 0

    sr = v.get("sample_rate")
    sr = int(sr) if sr in SAMPLE_RATES else DEFAULT["sample_rate"]

    res = v.get("resolution")
    res = int(res) if res in RESOLUTIONS else None

    fps = v.get("fps")
    fps = _clamp(int(round(fps)), 1, 120) \
        if isinstance(fps, (int, float)) and not isinstance(fps, bool) and fps > 0 else None

    return {
        "format": fmt, "quality": q,
        "hardware": bool(v.get("hardware")) and f["hw_encoder"] is not None,
        "audio": audio, "audio_bitrate": br, "sample_rate": sr,
        "resolution": res, "fps": fps,
    }


def encoder(spec):
    f = VIDEO_FORMATS[spec["format"]]
    return f["hw_encoder"] if spec["hardware"] and f["hw_encoder"] else f["encoder"]


def ext(spec):
    return VIDEO_FORMATS[spec["format"]]["ext"]


def content_type(spec):
    return VIDEO_FORMATS[spec["format"]]["content_type"]


def out_size(spec, width, height):
    """Even dimensions — yuv420p cannot represent an odd one, and ffmpeg FAILS
    the encode rather than rounding for you, on the last step of a long
    render."""
    def even(n):
        return max(2, int(round(n / 2)) * 2)
    if not spec["resolution"]:
        return even(width), even(height)
    f = spec["resolution"] / min(width, height)
    return even(width * f), even(height * f)


def can_copy_video(spec, width, height):
    """True when the requested output IS what the intermediates already are, so
    the final mux can `-c:v copy` and skip a whole re-encode of the cut.

    This is the common case — H.264 at the default CRF is the default output —
    and it is worth the check: on a 90s master the copy is seconds and the
    re-encode is minutes. Any deviation (codec, quality, hardware, resize,
    frame rate) means the pixels have to be built again.
    """
    return (spec["format"] == "h264"
            and not spec["hardware"]
            and spec["quality"] == INTERMEDIATE["crf"]
            # The SIZE, not the setting: a 1080p cut asked for 1080p needs no
            # resize either, and paying for a full re-encode to arrive at the
            # frame you already have is the kind of waste nobody would notice.
            and out_size(spec, width, height) == (width, height)
            and spec["fps"] is None)


def video_args(spec, width=None, height=None):
    """ffmpeg output args for the picture.

    NVENC does NOT take -crf: it is a different rate-control entirely, and
    passing crf to it is silently ignored rather than refused — the render
    comes back at the encoder's own default bitrate and nothing says the
    quality setting did nothing. `-cq` with `-rc vbr` is the equivalent knob.
    """
    f = VIDEO_FORMATS[spec["format"]]
    enc = encoder(spec)
    args = ["-c:v", enc]

    if spec["hardware"]:
        # -preset p5 is NVENC's balanced tier (p1 fastest .. p7 slowest); the
        # x264 preset names it also accepts are deprecated aliases.
        args += ["-rc", "vbr", "-cq", str(spec["quality"]), "-preset", "p5",
                 "-pix_fmt", "yuv420p"]
    elif f["quality"] == "profile":
        # prores_ks wants the profile as an INT and its own pixel format:
        # 422 variants are yuv422p10le, 4444 is yuva444p10le. Handing it
        # yuv420p produces a file that opens and is not ProRes-conformant.
        prof = spec["quality"]
        args += ["-profile:v", str(prof),
                 "-pix_fmt", "yuva444p10le" if prof >= 4 else "yuv422p10le"]
    elif spec["format"] == "vp9":
        # Constant-quality VP9 is -crf WITH -b:v 0; without the zero bitrate
        # libvpx treats crf as a ceiling on a bitrate-targeted encode, which is
        # a different (and much worse) mode. -row-mt is free parallelism.
        args += ["-crf", str(spec["quality"]), "-b:v", "0", "-row-mt", "1",
                 "-pix_fmt", "yuv420p"]
    else:
        args += ["-crf", str(spec["quality"]), "-preset", "veryfast",
                 "-pix_fmt", "yuv420p"]

    if spec["format"] in ("h264", "h265", "vp9") and not spec["hardware"]:
        # The intermediates are tagged bt709/tv (handlers/render.COLOR_TAGS)
        # and the copy path carries the tags for free; a re-encoding delivery
        # has to restate them or the deliverable arrives untagged and every
        # player guesses.
        args += ["-colorspace", "bt709", "-color_primaries", "bt709",
                 "-color_trc", "bt709", "-color_range", "tv"]

    if spec["fps"]:
        args += ["-r", str(spec["fps"])]
    if spec["resolution"] and width and height:
        w, h = out_size(spec, width, height)
        if (w, h) != (width, height):
            args += ["-vf", f"scale={w}:{h}:flags=lanczos"]
    # faststart is an mp4/mov concept; webm has no moov atom to move.
    if f["ext"] in ("mp4", "mov"):
        args += ["-movflags", "+faststart"]
    return args


def audio_args(spec):
    """ffmpeg output args for the sound. `none` strips the stream."""
    a = spec["audio"]
    if a == "none":
        return ["-an"]
    if a == "pcm_s24le":
        return ["-c:a", "pcm_s24le", "-ar", str(spec["sample_rate"])]
    if a == "opus":
        return ["-c:a", "libopus", "-b:a", f"{spec['audio_bitrate']}k",
                "-ar", "48000"]  # libopus only does 48k; anything else resamples anyway
    return ["-c:a", "aac", "-b:a", f"{spec['audio_bitrate']}k",
            "-ar", str(spec["sample_rate"]), "-ac", "2"]


def describe(spec):
    f = VIDEO_FORMATS[spec["format"]]
    q = (f"profile {spec['quality']}" if f["quality"] == "profile"
         else f"crf {spec['quality']}")
    bits = [spec["format"], q, encoder(spec), spec["audio"]]
    if spec["resolution"]:
        bits.append(f"{spec['resolution']}p")
    if spec["fps"]:
        bits.append(f"{spec['fps']}fps")
    return " · ".join(str(b) for b in bits)

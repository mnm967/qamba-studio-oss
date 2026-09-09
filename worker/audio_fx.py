"""Per-clip audio effects, as ffmpeg filters.

The render half of `src/lib/audioFx.ts`: the browser plays the chain through
Tuna, this plays it through ffmpeg, and both read the same ten entries with the
same engine-neutral parameters (dB, Hz, ms, 0..1). Conversions live at this
edge — ffmpeg's `acompressor` wants a LINEAR threshold and a linear makeup
where we store dB, `aecho` wants its own gain pair — because a row that
carried one engine's units would be wrong for the other.

Every filter used here has been in ffmpeg for years (`bass`, `treble`,
`equalizer`, `lowpass`, `highpass`, `acompressor`, `aecho`, `chorus`,
`tremolo`, `asoftclip`, `aphaser`, `pan`). That is a deliberate constraint on
the catalog rather than a coincidence: an effect the pod's ffmpeg cannot apply
is a preview that lies.

Three mappings were measured against the real binary rather than read off the
docs, because getting any of them wrong is silent:

  - `asoftclip=type=tanh:param=P` is exactly `tanh(P*x)` (to 3.5e-8).
  - `aecho` is pure FEED-FORWARD. An impulse in gives `in_gain*out_gain` at 0
    and `decay_j*out_gain` at `delay_j`; nothing recirculates. That is what
    makes the reverb below exact rather than approximate — the browser
    convolves with an impulse response built from the same tap list.
  - ffmpeg's `pan` reads a channel the input does not have as ZERO, so a MONO
    clip through a pan matrix comes out hard left whatever the setting. Hence
    the `aformat` in front of it.
"""

import math

MAX_FX = 4

# key -> (min, max, default). Mirrors the catalog in src/lib/audioFx.ts; the
# worker clamps again because a jsonb column can hold anything and a filter
# argument out of range fails the whole graph, i.e. the whole render.
_SPEC = {
    # The EQ's parameter is a LIST of bands, not scalars — see _bands. The
    # legacy keys stay so a row written before it was parametric still clamps.
    "eq": {"low": (-18.0, 18.0, 0.0), "mid": (-18.0, 18.0, 0.0), "high": (-18.0, 18.0, 0.0)},
    "filter": {"freq": (40.0, 18000.0, 120.0), "q": (0.1, 10.0, 0.7)},
    "compressor": {"threshold": (-60.0, 0.0, -24.0), "ratio": (1.0, 20.0, 4.0),
                   "attack": (0.1, 200.0, 5.0), "release": (10.0, 2000.0, 250.0),
                   "makeup": (0.0, 24.0, 0.0)},
    "echo": {"time": (20.0, 1000.0, 250.0), "feedback": (0.0, 0.9, 0.35),
             "mix": (0.0, 1.0, 0.3)},
    "chorus": {"rate": (0.1, 8.0, 1.5), "depth": (0.0, 1.0, 0.5)},
    "tremolo": {"rate": (0.1, 20.0, 5.0), "depth": (0.0, 1.0, 0.5)},
    "overdrive": {"drive": (0.0, 36.0, 12.0), "output": (-24.0, 6.0, -6.0)},
    "reverb": {"size": (0.0, 1.0, 0.4), "decay": (0.2, 6.0, 1.6), "mix": (0.0, 1.0, 0.3)},
    "phaser": {"rate": (0.1, 2.0, 0.5), "depth": (0.0, 1.0, 0.6),
               "feedback": (0.0, 0.9, 0.5)},
    "pan": {"pan": (-1.0, 1.0, 0.0)},
}

# The overdrive's shaper, shared with the browser and with the panel's display.
OD_CURVE = 2.0
# How many reflections a reverb tail is built from. A budget: every tap is a
# term in an `aecho` argument list (~1.7KB of filtergraph at 128).
REVERB_TAPS = 128
_REVERB_FLOOR = 5e-4
# How many times an echo may repeat before the tail is called done. Tuna's
# Delay recirculates until it is inaudible; this is the same thing with a
# ceiling on the filtergraph.
ECHO_REPEATS = 32
_ECHO_FLOOR = 5e-4

# ------------------------------------------------------------- the EQ's bands

MAX_EQ_BANDS = 8
EQ_FREQ_MIN, EQ_FREQ_MAX = 20.0, 20000.0
EQ_GAIN_MAX = 18.0

# **Shelf Q is not a control**, and pinning it here is a parity fix rather than
# a simplification: Web Audio's lowshelf/highshelf IGNORE Q (the spec fixes
# their slope at S = 1), while `bass`/`treble` take a width and default it to
# 0.5. RBJ's shelf alpha at S = 1 is `sin(w0)/2 * sqrt(2)`, which is the Q form
# at exactly 1/sqrt(2) — so leaving ffmpeg's default in place, as this file did
# while the EQ had three fixed bands, was itself a mismatch with the preview.
SHELF_Q = 0.7071067811865476

# type -> (ffmpeg filter, takes gain, takes q)
_BAND_TYPES = {
    "highpass":  ("highpass", False, True),
    "lowshelf":  ("bass", True, False),
    "peaking":   ("equalizer", True, True),
    "highshelf": ("treble", True, False),
    "lowpass":   ("lowpass", False, True),
    "notch":     ("bandreject", False, True),
}


def _band(raw):
    """One stored band, made safe, or None.

    The twin of `normalizeBand` in src/lib/audioFx.ts. A jsonb column can hold
    anything and this string goes straight into a filtergraph that fails as a
    unit, so an out-of-range width would take down the whole render.
    """
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind not in _BAND_TYPES:
        kind = "peaking"
    _, has_gain, has_q = _BAND_TYPES[kind]

    def num(v, default):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return default
        return default if f != f else f

    return {
        "type": kind,
        "freq": max(EQ_FREQ_MIN, min(EQ_FREQ_MAX, num(raw.get("freq"), 1000.0))),
        "gain": max(-EQ_GAIN_MAX, min(EQ_GAIN_MAX, num(raw.get("gain"), 0.0))) if has_gain else 0.0,
        "q": max(0.1, min(18.0, num(raw.get("q"), 1.0))) if has_q else SHELF_Q,
        "on": raw.get("on") is not False,
    }


def _legacy_bands(fx):
    """The three fixed bands the EQ used to be, at the frequencies it used.

    A row written before the EQ was parametric carries low/mid/high and no
    bands; it must keep sounding exactly as it did, so it becomes these.
    """
    return [
        {"type": "lowshelf", "freq": 200.0, "gain": _p(fx, "low"), "q": SHELF_Q, "on": True},
        {"type": "peaking", "freq": 1200.0, "gain": _p(fx, "mid"), "q": 1.0, "on": True},
        {"type": "highshelf", "freq": 5000.0, "gain": _p(fx, "high"), "q": SHELF_Q, "on": True},
    ]


def eq_bands(fx):
    raw = (fx.get("params") or {}).get("bands")
    if not isinstance(raw, list):
        return _legacy_bands(fx)
    out = []
    for item in raw[:MAX_EQ_BANDS]:
        b = _band(item)
        if b:
            out.append(b)
    return out


def band_audible(b):
    """A bell or shelf at unity gain is a filter that costs a pass over the
    samples to produce its input. A cut or a notch always does something."""
    if not b.get("on", True):
        return False
    return abs(b["gain"]) >= 0.25 if _BAND_TYPES[b["type"]][1] else True


def band_filter(b):
    """-> the ffmpeg filter for one band."""
    name, has_gain, has_q = _BAND_TYPES[b["type"]]
    width = b["q"] if has_q else SHELF_Q
    if name == "equalizer":
        return "equalizer=f=%.1f:t=q:w=%.3f:g=%.2f" % (b["freq"], width, b["gain"])
    if has_gain:                       # bass / treble
        return "%s=g=%.2f:f=%.1f:width_type=q:width=%.3f" % (name, b["gain"], b["freq"], width)
    return "%s=f=%.1f:width_type=q:width=%.3f" % (name, b["freq"], width)
# How fast the gap between reflections closes. 0.985**128 = 0.15, i.e. the
# tail ends about seven times denser than it starts.
_REVERB_R = 0.985
_PHI = 0.6180339887498949


def _p(fx, key):
    lo, hi, default = _SPEC[fx.get("id")][key]
    try:
        v = float((fx.get("params") or {}).get(key, default))
    except (TypeError, ValueError):
        return default
    if v != v:                       # NaN
        return default
    return max(lo, min(hi, v))


def _lin(db):
    return 10.0 ** (db / 20.0)


#: DynamicsCompressorNode's knee, as the preview actually runs it: Tuna's
#: Compressor default. `tunaNodes` passes no knee, so this is the value in the
#: node the user mixed against.
WEBAUDIO_KNEE_DB = 5.0


def _webaudio_auto_makeup_db(threshold_db, ratio, knee_db=WEBAUDIO_KNEE_DB):
    """The makeup gain DynamicsCompressorNode applies WITHOUT being asked.

    The Web Audio spec (and the Blink/WebKit implementation both browsers
    still ship) normalises the compressor's output: it evaluates the
    compression curve at 0 dBFS and applies (1/fullScaleGain)^0.6 as a fixed
    internal gain. In dB that is 0.6 x the full-scale reduction. The soft-knee
    curve, evaluated at x = 0 dBFS with threshold T (<= 0), ratio R, knee W:

        x >= T + W :  reduction = (1 - 1/R) * (-T - W/2)
        T < x < T+W:  reduction = (1 - 1/R) * (x - T)^2 / (2W)   (x = 0)
        x <= T     :  0

    The render has to add this by hand or every compressed lane comes back
    quieter than the preview by 10-17 dB at ordinary settings.
    """
    t = min(0.0, float(threshold_db))
    r = max(1.0, float(ratio))
    w = max(0.0, float(knee_db))
    if t == 0.0 or r == 1.0:
        return 0.0
    if 0.0 >= t + w:
        reduction = (1.0 - 1.0 / r) * (-t - w / 2.0)
    elif 0.0 > t:
        reduction = (1.0 - 1.0 / r) * (0.0 - t) ** 2 / (2.0 * w)
    else:
        reduction = 0.0
    return 0.6 * max(0.0, reduction)


def _round_js(x):
    """Python's round() is round-half-to-EVEN and JavaScript's Math.round is
    round-half-UP. The reverb's tap list has to come out of both languages
    identically, so it goes through this rather than the builtin — a tap that
    lands on an exact .5 would otherwise put the render one tenth of a
    millisecond off the preview, in one tap out of a hundred, silently."""
    return math.floor(x + 0.5)


def echo_taps(time_ms, feedback, mix):
    """-> [(delay_ms, gain)], the repeats a recirculating delay produces.

    The twin of `echoTaps` in src/lib/fxCurves.ts, which is what the panel
    draws. Tuna plays this natively (a delay line with a feedback loop); ffmpeg
    has no recirculating echo, so the render writes the loop out as taps.
    """
    fb = max(0.0, min(0.95, feedback))
    wet = max(0.0, min(1.0, mix))
    out, level = [], wet
    for n in range(1, ECHO_REPEATS + 1):
        level *= fb
        if level < _ECHO_FLOOR:
            break
        out.append((round(time_ms * n, 1), _round_js(level * 1e4) / 1e4))
    return out


def reverb_taps(size, decay_sec, mix):
    """-> [(delay_ms, gain)], the reflections BOTH engines play.

    The twin of `reverbTaps` in src/lib/audioFx.ts, arithmetic for arithmetic —
    `aecho` is a feed-forward tap set and the browser convolves with an impulse
    response built from these same numbers, so the two are not similar filters,
    they are one filter. Both round HERE, once, for that reason, and both go
    through IEEE754 `pow` rather than a cube-root helper that only one language
    has.

      - `size` is how far away the first reflection is (13ms to 90ms).
      - The gap between reflections shrinks geometrically, so density grows
        through the tail. Jittered by the golden ratio so the comb has no
        period to ring on.
      - Gains sit on `10**(-3t/decay)`: exactly -60dB at the decay time.
      - `mix` scales the reflections only. The dry is `in_gain=1` at delay 0,
        which neither engine touches.
    """
    sz = max(0.0, min(1.0, size))
    decay_ms = max(200.0, min(6000.0, decay_sec * 1000.0))
    wet = max(0.0, min(1.0, mix))
    if wet <= 0:
        return []
    base = 13.0 + 77.0 * sz
    span = max(base + 40.0, decay_ms)
    # Gaps SHRINK geometrically, so echo density grows through the tail the way
    # a real room's does. g0 is solved from the sum so the last tap lands on
    # span whatever the decay, which makes the pre-delay scale with the space
    # for free: 20ms into a short room, ~200ms into a hall.
    total = (_REVERB_R * (1.0 - _REVERB_R ** REVERB_TAPS)) / (1.0 - _REVERB_R)
    g0 = (span - base) / total
    out = []
    t = base
    for i in range(1, REVERB_TAPS + 1):
        jitter = 1.0 + 0.7 * (((i * _PHI) % 1.0) - 0.5)
        t += g0 * (_REVERB_R ** i) * jitter
        ms = _round_js(t * 10.0) / 10.0
        gain = _round_js(wet * (10.0 ** ((-3.0 * ms) / decay_ms)) * 1e4) / 1e4
        if gain < _REVERB_FLOOR:
            continue
        out.append((ms, gain))
    return out


def pan_matrix(pan):
    """-> ((l_own, l_cross), (r_own, r_cross)) for a STEREO input.

    Straight out of the Web Audio spec's StereoPannerNode algorithm, which is
    what Tuna's Panner is, so the image the render places is the image the
    preview played rather than a similar one.
    """
    p = max(-1.0, min(1.0, pan))
    x = p + 1.0 if p <= 0 else p
    gl = math.cos(x * math.pi / 2.0)
    gr = math.sin(x * math.pi / 2.0)
    if p <= 0:
        return (1.0, gl), (gr, 0.0)
    return (gl, 0.0), (1.0, gr)


def _audible(fx):
    """The same test the browser makes: a flat EQ or a dry echo is a filter
    that costs a pass over the samples to change nothing."""
    # The panel's power button. Stored rather than panel state precisely so it
    # reaches here — an effect switched off in the editor and applied by the
    # renderer anyway is the divergence the whole two-engine design is built
    # to avoid. Absent means ON: rows written before the flag existed play.
    if fx.get("enabled") is False:
        return False
    fid = fx.get("id")
    if fid == "eq":
        return any(band_audible(b) for b in eq_bands(fx))
    if fid == "echo":
        # Feedback as well as mix — Tuna's Delay sends the wet signal through
        # its feedback gain on the way out, so at zero there is no echo at all.
        return _p(fx, "mix") > 0.01 and _p(fx, "feedback") > 0.01
    if fid in ("chorus", "tremolo", "phaser"):
        return _p(fx, "depth") > 0.01
    if fid == "reverb":
        return _p(fx, "mix") > 0.01
    if fid == "pan":
        return abs(_p(fx, "pan")) > 0.01
    return fid in _SPEC


def _one(fx):
    """-> list of ffmpeg filter strings for one effect (EQ is three)."""
    fid = fx.get("id")
    if fid == "eq":
        # One filter per AUDIBLE band, in order — the same set, in the same
        # order, that `tunaNodes` turns into BiquadFilterNodes.
        return [band_filter(b) for b in eq_bands(fx) if band_audible(b)]
    if fid == "filter":
        mode = (fx.get("params") or {}).get("mode")
        name = "lowpass" if mode == "lowpass" else "highpass"
        return ["%s=f=%.1f:width_type=q:width=%.3f" % (name, _p(fx, "freq"), _p(fx, "q"))]
    if fid == "compressor":
        # acompressor takes a LINEAR threshold (and makeup as a multiplier),
        # where the catalog — and every compressor a person has used — is dB.
        #
        # THE MAKEUP IS explicit + WEBAUDIO'S OWN, and the second term is the
        # one that was missing for this effect's whole life. The preview plays
        # this through Tuna's Compressor, which wraps DynamicsCompressorNode —
        # and that node applies an IMPLICIT makeup gain the spec fixes at
        # (1/fullScaleGain)^0.6, where fullScaleGain is the compression curve
        # evaluated at 0 dBFS. It cannot be turned off; it is inside the node.
        # `acompressor` applies nothing it is not told. So a mix tuned by ear
        # in the editor rendered quieter by exactly that hidden gain — measured
        # on a real cut whose three lanes all carried compressors: the
        # delivered master came back at -42.7 LUFS integrated, ~15-17 dB under
        # the preview on every lane, which is precisely 0.6 x the full-scale
        # reduction of each lane's threshold/ratio pair. Knee is 5 because
        # that is Tuna's default and tunaNodes passes none.
        t, r = _p(fx, "threshold"), _p(fx, "ratio")
        makeup_db = _webaudio_auto_makeup_db(t, r) + _p(fx, "makeup")
        return ["acompressor=threshold=%.6f:ratio=%.2f:attack=%.2f:release=%.2f:makeup=%.3f"
                % (max(0.000977, _lin(t)), r,
                   _p(fx, "attack"), _p(fx, "release"),
                   min(64.0, max(1.0, _lin(makeup_db))))]
    if fid == "echo":
        # The repeats, spelled out. `aecho` is feed-forward and does NOT
        # recirculate (measured), so `feedback` cannot be handed to it as a
        # decay and left to ring — the browser's Delay recirculates and this
        # produced exactly one repeat, i.e. the two engines played different
        # effects. And in_gain/out_gain BOTH scale the dry tap, so the old
        # `aecho=0.9:mix:...` was attenuating the dry signal by 11dB at the
        # default mix, for nothing. 1:1 with the levels in the taps is the
        # arithmetic Tuna's graph actually performs:
        #   dry = dryLevel = 1;  tap n at n*time = wetLevel * feedback**n
        # (its feedback gain sits in the direct wet path as well as the loop,
        # which is why the FIRST repeat is already scaled by it).
        taps = echo_taps(_p(fx, "time"), _p(fx, "feedback"), _p(fx, "mix"))
        if not taps:
            return []
        return ["aecho=1:1:%s:%s" % ("|".join("%.1f" % t[0] for t in taps),
                                     "|".join("%.4f" % t[1] for t in taps))]
    if fid == "chorus":
        # chorus=in_gain:out_gain:delays:decays:speeds:depths. The delay is
        # fixed at 1.6ms — the middle of the range Tuna's own `delay` knob can
        # reach — so the two engines are describing the same effect.
        return ["chorus=0.7:0.9:1.6:0.4:%.3f:%.3f" % (_p(fx, "rate"), _p(fx, "depth"))]
    if fid == "tremolo":
        return ["tremolo=f=%.3f:d=%.3f" % (_p(fx, "rate"), _p(fx, "depth"))]
    if fid == "overdrive":
        # Gain into the shaper, shaper, gain out. `asoftclip` has no input
        # gain of its own and its `threshold` is not one — lowering that
        # squashes the curve rather than driving into it.
        return ["volume=%.2fdB" % _p(fx, "drive"),
                "asoftclip=type=tanh:param=%.2f" % OD_CURVE,
                "volume=%.2fdB" % _p(fx, "output")]
    if fid == "reverb":
        taps = reverb_taps(_p(fx, "size"), _p(fx, "decay"), _p(fx, "mix"))
        if not taps:
            return []
        # in_gain=1, out_gain=1: both scale the DRY tap as well, so anything
        # else here would quietly attenuate the signal the reverb is added to.
        # The wet level is already in the tap gains.
        return ["aecho=1:1:%s:%s" % ("|".join("%.1f" % t[0] for t in taps),
                                     "|".join("%.4f" % t[1] for t in taps))]
    if fid == "phaser":
        # depth 0..1 -> the sweep width `aphaser` expresses as delay 0..5ms;
        # feedback maps 1:1 onto `decay` (our 0..0.9 sits inside its 0..0.99).
        return ["aphaser=in_gain=0.6:out_gain=0.8:delay=%.3f:decay=%.3f:speed=%.3f:type=t"
                % (0.5 + 4.5 * _p(fx, "depth"), _p(fx, "feedback"), _p(fx, "rate"))]
    if fid == "pan":
        (l_own, l_cross), (r_own, r_cross) = pan_matrix(_p(fx, "pan"))
        # `aformat` FIRST, and it is not tidiness: ffmpeg reads a channel the
        # input does not have as zero, so a mono clip through this matrix comes
        # out hard left at every setting. Its mono upmix is equal-power, which
        # is what StereoPannerNode does for a mono source too — same image,
        # up to +3dB of level at the extremes. Measured, and the only place the
        # two engines disagree on this effect.
        return ["aformat=channel_layouts=stereo",
                "pan=stereo|c0=%.6f*c0+%.6f*c1|c1=%.6f*c1+%.6f*c0"
                % (l_own, l_cross, r_own, r_cross)]
    return []


def filters(audio_fx):
    """-> the ordered ffmpeg filter list for a clip's whole chain.

    Array order is the signal path, same as the preview. Unknown ids and
    inaudible settings are dropped rather than raising: this runs inside a
    render that has already cost GPU time, and one malformed effect must not
    take the episode down with it.
    """
    out = []
    for fx in (audio_fx or [])[:MAX_FX]:
        if not isinstance(fx, dict) or fx.get("id") not in _SPEC:
            continue
        if not _audible(fx):
            continue
        out.extend(_one(fx))
    return out


def chain(audio_fx):
    """The same thing as one comma-joined fragment, or "" for no effects."""
    return ",".join(filters(audio_fx))


def tail_ms(audio_fx):
    """-> how long this chain keeps making sound after its input stops.

    There is no browser twin, and that asymmetry is the point: Web Audio runs
    on a clock with no end, so a reverb tail simply rings out of the graph. An
    ffmpeg stream ENDS, and a filter fed nothing produces nothing — so a lane
    bus whose last clip stops at 40s is cut at 40s, tail and all. The renderer
    pads by this much before the lane's inserts (`worker/handlers/render.py`)
    and lets the final mix trim back to the video's length.

    Only the two effects that carry sound past their input have one; a filter,
    a compressor or a modulation stops when its input does. Both are read off
    the same tap lists the render hands to `aecho`, so the pad cannot disagree
    with the thing it is padding for.
    """
    out = 0.0
    for fx in (audio_fx or [])[:MAX_FX]:
        if not isinstance(fx, dict) or fx.get("id") not in _SPEC:
            continue
        if not _audible(fx):
            continue
        fid = fx.get("id")
        if fid == "echo":
            taps = echo_taps(_p(fx, "time"), _p(fx, "feedback"), _p(fx, "mix"))
        elif fid == "reverb":
            taps = reverb_taps(_p(fx, "size"), _p(fx, "decay"), _p(fx, "mix"))
        else:
            continue
        if taps:
            out = max(out, taps[-1][0])
    return out

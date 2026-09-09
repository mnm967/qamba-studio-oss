"""The mix: which timeline tracks are audible, and how loud, over time.

The Python twin of `src/lib/mix.ts`. The preview player answers these
questions in the browser and this answers them for the render; if the two
disagree the preview is a lie about the finished file, and nothing on screen
says so. Pure functions, tested by worker/tests/test_mix.py against the same
cases as src/lib/mix.test.ts.

Automation is a list of ``{"t_ms": int, "gain_db": float}`` in TIMELINE time,
piecewise-linear between points and flat outside them, and it REPLACES the
lane fader when it has any points.
"""

import audio_fx

AUTO_MIN_DB = -30.0
AUTO_MAX_DB = 6.0


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f and abs(f) != float("inf") else default   # NaN/inf out


def clamp_db(db):
    return max(AUTO_MIN_DB, min(AUTO_MAX_DB, _num(db)))


def linear_gain(db):
    """dB -> linear multiplier. The bottom of the range IS silence: -inf has
    no slider position, so the browser and ffmpeg both treat it as 0."""
    d = _num(db)
    if d <= AUTO_MIN_DB:
        return 0.0
    return 10.0 ** (d / 20.0)


def sort_points(points):
    pts = []
    for p in (points or []):
        if not isinstance(p, dict):
            continue
        if "t_ms" not in p or "gain_db" not in p:
            continue
        pts.append({"t_ms": _num(p.get("t_ms")), "gain_db": _num(p.get("gain_db"))})
    return sorted(pts, key=lambda p: p["t_ms"])


def gain_at_ms(points, ms, fallback_db=0.0):
    pts = sort_points(points)
    if not pts:
        return _num(fallback_db)
    if ms <= pts[0]["t_ms"]:
        return pts[0]["gain_db"]
    if ms >= pts[-1]["t_ms"]:
        return pts[-1]["gain_db"]
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        if ms <= b["t_ms"]:
            span = b["t_ms"] - a["t_ms"]
            if span <= 0:
                return b["gain_db"]
            return a["gain_db"] + (b["gain_db"] - a["gain_db"]) * (ms - a["t_ms"]) / span
    return pts[-1]["gain_db"]


def solo_active(tracks):
    """Solo is global: it answers "let me hear just this", so it has to reach
    the video lanes' baked audio as well as the other audio lanes."""
    return any(t.get("solo") for t in (tracks or []))


def is_audible(track, tracks):
    """Mute wins over the lane's own solo — the only reading that lets you
    solo a group and still drop one member."""
    if not track:
        return False
    if track.get("muted"):
        return False
    return (not solo_active(tracks)) or bool(track.get("solo"))


def audible_tracks(tracks, kind=None):
    return [t for t in (tracks or [])
            if (kind is None or t.get("kind") == kind) and is_audible(t, tracks)]


def track_points(track):
    return sort_points((track or {}).get("automation") or [])


def track_gain_db_at(track, ms):
    pts = track_points(track)
    base = _num((track or {}).get("gain_db"))
    return gain_at_ms(pts, ms, base) if pts else base


def volume_filter(track, clip_gain_db=0.0, *, offset_ms=0):
    """The ffmpeg `volume` filter for one audio clip on `track`.

    Applied AFTER `adelay`, so the filter's `t` is timeline seconds and the
    automation's own timebase needs no shifting. Without automation this is
    the constant the renderer always used; with it, one nested expression
    evaluated per frame.

    `offset_ms` shifts the curve for a piece of media that is NOT at timeline
    zero after delay (unused today — adelay puts every clip on the timeline
    clock — but the parameter is what makes that assumption explicit).
    """
    pts = track_points(track)
    gain = _num(clip_gain_db)
    if not pts:
        return "volume=%.4fdB" % (_num((track or {}).get("gain_db")) + gain)
    expr = _volume_expr(pts, gain, offset_ms=offset_ms)
    return "volume=volume='%s':eval=frame" % expr


def lane_bus(track, labels, out_label):
    """-> the filtergraph fragment that sums one lane through its own rack, or
    None when the lane has no rack and its clips go straight to the mix.

    Render-only, like `volume_filter` above — the preview builds the same stage
    as Web Audio nodes (`src/lib/audioGraph.ts`), where a bus is a GainNode and
    needs no string. What both halves must agree on is the ORDER, which is the
    reason this is one function rather than four lines inside the renderer:

        clips (each already carrying its own inserts and its own gain)
          -> sum -> pad -> the LANE's inserts -> the lane fader/automation

    Two of those are easy to get backwards and silent when wrong:

      - The fader is LAST. Console order, and the only order in which a lane
        compressor hears the lane instead of the fader. It is free to move:
        gain is linear and distributes over a sum, so this computes exactly
        what the per-clip form computed, which is why a lane with no rack can
        keep that form untouched.
      - The PAD comes before the inserts. A reverb or an echo goes on making
        sound after its input stops and an ffmpeg stream ends where its last
        clip does, so without it the tail is cut at the last clip. The final
        mix takes its length from the video and trims the pad back off.
    """
    fx = audio_fx.filters((track or {}).get("audio_fx"))
    if not fx or not labels:
        return None
    steps = []
    if len(labels) > 1:
        # `longest`, not `first`: a lane's later clips must not be truncated by
        # whichever one happens to end soonest.
        steps.append("amix=inputs=%d:normalize=0:duration=longest" % len(labels))
    tail = audio_fx.tail_ms((track or {}).get("audio_fx"))
    if tail > 0:
        steps.append("apad=pad_dur=%.3f" % (tail / 1000.0))
    steps.extend(fx)
    steps.append(volume_filter(track))
    return "%s%s%s" % ("".join(labels), ",".join(steps), out_label)


def _lin(db):
    return linear_gain(db)


def _volume_expr(points, clip_gain_db=0.0, *, offset_ms=0):
    """Piecewise-linear automation as one ffmpeg expression in LINEAR gain.

    Interpolating in dB and converting per segment endpoint would be more
    correct to the ear, but ffmpeg's expression language has no log10 on the
    literal we need it for; interpolating the linear values between converted
    endpoints matches what the browser's <audio>.volume does frame to frame,
    which is the parity that actually matters here.
    """
    pts = sort_points(points)
    lin = [(max(0.0, (p["t_ms"] - offset_ms) / 1000.0), _lin(p["gain_db"] + clip_gain_db))
           for p in pts]
    if len(lin) == 1:
        return "%.6f" % lin[0][1]
    expr = "%.6f" % lin[-1][1]          # after the last point: hold
    for i in range(len(lin) - 1, 0, -1):
        t0, g0 = lin[i - 1]
        t1, g1 = lin[i]
        span = t1 - t0
        if span <= 0:
            seg = "%.6f" % g1
        elif abs(g1 - g0) < 1e-9:
            seg = "%.6f" % g0
        else:
            seg = "(%.6f+(%.6f)*(t-%.6f))" % (g0, (g1 - g0) / span, t0)
        expr = "if(lt(t,%.6f),%s,%s)" % (t1, seg, expr)
    # before the first point: hold the first value
    return "if(lt(t,%.6f),%.6f,%s)" % (lin[0][0], lin[0][1], expr)


def eval_volume_expr(expr, t):
    """Evaluate what `_volume_expr` produced, for tests. Not used at render
    time — ffmpeg is the evaluator there — but a filter string nobody can read
    back is a filter string nobody can check."""
    expr = expr.strip()
    if not expr.startswith("if("):
        return float(expr)
    # if(lt(t,T),A,B) — split on the top-level commas of the outer call
    inner = expr[3:-1]
    parts, depth, cur = [], 0, ""
    for ch in inner:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    cond, a, b = parts
    thresh = float(cond[cond.index(",") + 1:-1])
    if t < thresh:
        return _eval_seg(a, t)
    return eval_volume_expr(b, t)


def _eval_seg(seg, t):
    seg = seg.strip()
    if seg.startswith("if("):
        return eval_volume_expr(seg, t)
    if not seg.startswith("("):
        return float(seg)
    body = seg[1:-1]                       # g0+(slope)*(t-t0)
    g0, rest = body.split("+(", 1)
    slope, rest = rest.split(")*(t-", 1)
    t0 = rest[:-1]
    return float(g0) + float(slope) * (t - float(t0))

"""Rendering a take assembly: validation + the ffmpeg filtergraph.

An assembly is an ORDERED LIST OF SLICES: each entry names a take and a window
INSIDE it (`in_ms`/`out_ms` are SOURCE timestamps), and the slices are laid end
to end in the order given. See src/lib/assembly.ts — the browser builds it,
this renders it.

The filtergraph never changed when the browser stopped requiring those windows
to tile [0, duration_ms): a span was always a plain `trim` of its own take at
its own timestamps, and concat always laid them out in list order. What changed
is what `validate` may assume — a slice can now sit anywhere, so contiguity is
gone and `duration_ms` is the SUM of the slices rather than the block's planned
window. Keeping that sum as a check is the point: the browser computes the
length and stores it, and disagreeing with it here means one of the two did the
arithmetic wrong, which is exactly the class of bug that is silent in an mp4.

Pure functions over dicts and integers — no B2, no ffmpeg invocation — so the
graph can be unit-tested off-pod (worker/tests/test_assembly.py).
"""

# A hard audio splice clicks. Two frames of fade at each INTERNAL join kills
# it without being audible as a dip; the assembly's own head and tail are
# never faded (that would duck the block's first and last words).
AUDIO_FADE_MS = 20

# Same floor as the UI's MIN_SEGMENT_MS: shorter than this is a flicker, not a
# shot. The renderer refuses rather than producing one, because by the time
# the file exists nobody can tell it from a decode glitch.
MIN_SEGMENT_MS = 250


class AssemblyError(ValueError):
    pass


def validate(segments, duration_ms):
    """Raise unless `segments` is a renderable list of slices summing to
    `duration_ms`.

    Each slice must name a take and run forwards for at least a shot's worth of
    time; where it sits in the cut is its position in the list and is not
    checked, because there is nothing to check — the layout is derived.

    The sum IS checked. `duration_ms` is written by whoever built the assembly
    and is what the block's clip on the timeline will be measured against, so a
    disagreement means the two halves computed different lengths for one cut —
    which nothing downstream would notice, since the mp4 comes out however long
    ffmpeg makes it.
    """
    if not segments:
        raise AssemblyError("assembly has no segments")
    duration_ms = int(duration_ms)
    t = 0
    for i, s in enumerate(segments):
        if not s.get("take_id"):
            raise AssemblyError(f"segment {i} names no take")
        a, b = int(s["in_ms"]), int(s["out_ms"])
        if a < 0:
            raise AssemblyError(f"segment {i} starts before its take does ({a}ms)")
        if b <= a:
            raise AssemblyError(f"segment {i} is empty ({a}..{b}ms)")
        if b - a < MIN_SEGMENT_MS:
            raise AssemblyError(f"segment {i} is {b - a}ms — below the {MIN_SEGMENT_MS}ms floor")
        t += b - a
    if t != duration_ms:
        raise AssemblyError(f"assembly runs {t}ms, but says it is {duration_ms}ms")
    return True


def cut_times(segments):
    """-> [(t0_ms, t1_ms)] — where each slice lands, packed end to end. The
    layout is derived here and nowhere else, exactly as it is in the browser."""
    out, t = [], 0
    for s in segments:
        d = int(s["out_ms"]) - int(s["in_ms"])
        out.append((t, t + d))
        t += d
    return out


def plan_inputs(segments):
    """Distinct take ids in first-appearance order — one ffmpeg input each,
    however many spans reference it."""
    order = []
    for s in segments:
        if s["take_id"] not in order:
            order.append(s["take_id"])
    return order


def build_filtergraph(segments, input_of, *, audio_of=None, fade_ms=AUDIO_FADE_MS,
                      silent_index=None, width=None, height=None, fps=None,
                      sample_rate=48000):
    """-> (filter_complex, maps, want_audio).

    input_of:     take_id -> ffmpeg input index (from plan_inputs' order)
    audio_of:     take_id -> bool; a take with no audio stream draws silence
                  from `silent_index` (an anullsrc input) so concat still sees
                  one audio stream per segment. Mixing an audio segment with a
                  silent one is exactly what an uploaded take does, and concat
                  refuses a ragged input list.
    silent_index: index of the anullsrc input, required when some — but not
                  all — of the used takes carry audio.
    width/height/fps: normalise every span to these before concat. The filter
                  refuses inputs whose size, SAR or frame rate disagree, and a
                  take can arrive from anywhere — `uploadAndAddTake` will
                  happily attach a phone clip beside a 1280x720 H3 render. The
                  scale/pad is a no-op when they already match (the normal
                  case: same block, same plan, same dims), so it costs nothing
                  to always emit and removes the whole failure class.
    """
    audio_of = audio_of or {}
    used = plan_inputs(segments)
    want_audio = any(audio_of.get(t, True) for t in used)
    if want_audio and not all(audio_of.get(t, True) for t in used) and silent_index is None:
        raise AssemblyError("silent_index required: some takes carry audio and some do not")

    fit = []
    if width and height:
        fit += [f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2", "setsar=1"]
    if fps:
        fit.append(f"fps={fps}")

    parts = []
    n = len(segments)
    for i, s in enumerate(segments):
        k = input_of[s["take_id"]]
        a, b = int(s["in_ms"]) / 1000.0, int(s["out_ms"]) / 1000.0
        vchain = [f"[{k}:v]trim=start={a:.3f}:end={b:.3f}", "setpts=PTS-STARTPTS"] + fit
        parts.append(",".join(vchain) + f"[v{i}]")
        if not want_audio:
            continue
        dur = b - a
        f = min(fade_ms / 1000.0, dur / 3)
        if audio_of.get(s["take_id"], True):
            chain = [f"[{k}:a]atrim=start={a:.3f}:end={b:.3f}", "asetpts=PTS-STARTPTS"]
        else:
            # anullsrc is infinite: take this span's worth of it.
            chain = [f"[{silent_index}:a]atrim=start=0:end={dur:.3f}", "asetpts=PTS-STARTPTS"]
        chain.append(f"aformat=sample_rates={sample_rate}:channel_layouts=stereo")
        if i > 0 and f > 0:
            chain.append(f"afade=t=in:st=0:d={f:.3f}")
        if i < n - 1 and f > 0:
            chain.append(f"afade=t=out:st={dur - f:.3f}:d={f:.3f}")
        parts.append(",".join(chain) + f"[a{i}]")

    # concat wants the streams interleaved per segment: v0 a0 v1 a1 …
    if want_audio:
        order = "".join(f"[v{i}][a{i}]" for i in range(n))
        parts.append(f"{order}concat=n={n}:v=1:a=1[v][a]")
        return ";".join(parts), ["-map", "[v]", "-map", "[a]"], True
    order = "".join(f"[v{i}]" for i in range(n))
    parts.append(f"{order}concat=n={n}:v=1:a=0[v]")
    return ";".join(parts), ["-map", "[v]"], False


def describe(segments, label_of=None):
    """One log line: `t1 0.0-5.2 | t2 5.2-8.7 | t1 8.7-14.0`.

    The times are the SOURCE windows, which is what a person diagnosing a cut
    wants — where in each take it came from. Where it plays is the reading
    order, and `@` marks it whenever the two disagree (i.e. whenever the cut is
    something the old tiling model could not have expressed).
    """
    label_of = label_of or {}
    parts = []
    for s, (t0, _t1) in zip(segments, cut_times(segments)):
        a = int(s["in_ms"])
        at = "" if a == t0 else f" @{t0 / 1000:.1f}"
        parts.append(f"{label_of.get(s['take_id'], s['take_id'][:8])} "
                     f"{a / 1000:.1f}-{int(s['out_ms']) / 1000:.1f}{at}")
    return " | ".join(parts)

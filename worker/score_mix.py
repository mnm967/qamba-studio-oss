"""The score, under the cut.

A film's score used to be generated, attached to `storyboards.audio_asset_id`,
and then never heard: `handle_assemble_cut` concatenated the takes with
`-c copy`, and the only consumer of that column was the MUSIC-VIDEO path,
where `locked` is gated on `medium == "music_video"`. So on a film the track
was a paid render that reached nothing. This is the half that plays it.

Three things it has to get right, and each is silent when wrong.

**It must not double a locked track.** On a music video the takes already have
the master baked in — that is what `audio_mode: "locked"` means — so mixing it
again is the same music twice, a few milliseconds apart. The blocks are asked,
not the project: the block is what actually rendered.

**The level is MEASURED, not chosen.** A generated track arrives at streaming
master level (-11 to -14 LUFS, measured across four renders) and H3's native
dialogue does not, so a fixed gain is right for one pairing and wrong for
every other. Both are measured with ebur128 and the bed is placed a stated
number of LU below the cut. The honest caveat: the cut's integrated loudness
includes room tone and silence as well as speech, so this lands the bed
under the PROGRAMME rather than under the dialogue specifically — good enough
to stop the score fighting the film, and not the same thing as ducking.

**The cues are what make it a score rather than a bed.** The composer writes
one cue per scene with an intensity, including 0 for "no music here" — a film
that plays wall-to-wall music at one level is the thing this exists to avoid
— and those become a gain envelope over the cut's own clock. That is also the
only reader of `score.cues`, which is what keeps the composer's cue list from
being writing nobody reads.
"""

import os

import mix
from status import log

# How far under the programme the bed sits. Film practice puts music roughly
# 6-12 LU below dialogue; the middle of that, stated once.
BED_BELOW_LU = 9.0

# The composer's 0-5 intensity as dB against the bed level. 3 IS the bed —
# `normalize_score` invents 3 for any scene the composer skipped, so an
# unscored scene plays at the level the mix was designed for rather than at
# an accidental extreme. 0 is out, not quiet: "silence" is a cue.
INTENSITY_DB = {0: -60.0, 1: -8.0, 2: -4.0, 3: 0.0, 4: 2.0, 5: 4.0}

# A cue change is a ramp, not a step. Music that jumps level on a cut sounds
# like an edit in the music rather than an edit in the film.
CUE_RAMP_MS = 1200

# The score's own tail, when it is shorter than the cut. It is NOT looped:
# a seam in the middle of a film is worse than an unscored final stretch, and
# the shortfall is logged and recorded so the fix (render a longer score) is
# obvious rather than mysterious.
TAIL_FADE_MS = 2000

SILENT_DB = INTENSITY_DB[0]


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def cue_spans(blocks, scene_slug_by_id, cues):
    """(start_ms, end_ms, intensity) over the cut, one span per block.

    A block may span two scenes of one location (only an environment cut
    splits one), so the span takes the FIRST scene's cue: that is the scene
    the block opens on, and a cue change inside a block would ramp under a
    continuous shot.
    """
    by_slug = {}
    for c in cues or []:
        slug = str((c or {}).get("scene") or "").strip().upper()
        if slug:
            by_slug[slug] = c
    spans = []
    for b in blocks:
        sids = b.get("scene_ids") or []
        slug = scene_slug_by_id.get(sids[0]) if sids else None
        cue = by_slug.get(str(slug or "").upper())
        inten = 3 if cue is None else int(cue.get("intensity", 3))
        spans.append((int(b["t_start_ms"]), int(b["t_end_ms"]),
                      _clamp(inten, 0, max(INTENSITY_DB))))
    return spans


def envelope_points(spans, *, ramp_ms=CUE_RAMP_MS):
    """`[{t_ms, gain_db}]` for `mix.volume_filter`, ramped at each cue change.

    Consecutive spans at one intensity are merged first, so a five-block scene
    is one level rather than five identical points, and the ramp only ever
    lands where the music was actually asked to change.
    """
    if not spans:
        return []
    merged = []
    for s, e, i in spans:
        if merged and merged[-1][2] == i:
            merged[-1][1] = e
        else:
            merged.append([s, e, i])

    pts = [{"t_ms": 0, "gain_db": INTENSITY_DB[merged[0][2]]}]
    for prev, cur in zip(merged, merged[1:]):
        at = int(cur[0])
        lead = max(int(prev[0]) + 1, at - ramp_ms)
        pts.append({"t_ms": lead, "gain_db": INTENSITY_DB[prev[2]]})
        pts.append({"t_ms": at, "gain_db": INTENSITY_DB[cur[2]]})
    pts.append({"t_ms": int(merged[-1][1]), "gain_db": INTENSITY_DB[merged[-1][2]]})
    return pts


def all_silent(points):
    """Every cue is 0 — the composer scored the film as unscored.

    Worth its own answer: mixing a -60dB bed under the whole cut is a pointless
    re-encode of the audio, and re-encoding when nothing changes is how a
    `-c copy` concat quietly becomes a generation loss.
    """
    return bool(points) and all(p["gain_db"] <= SILENT_DB for p in points)


def bed_gain_db(score_lufs, programme_lufs, *, below=BED_BELOW_LU):
    """How much to move the score so it sits `below` LU under the programme.

    Either measurement missing returns None — the caller then declines to mix
    rather than guessing a gain, because a score placed by guess is either
    inaudible or on top of the dialogue, and both look like the feature not
    working.
    """
    if score_lufs is None or programme_lufs is None:
        return None
    return _clamp((programme_lufs - below) - score_lufs, -40.0, 10.0)


def measure_lufs(path, run):
    """Integrated loudness via ebur128, reusing the reviewer's own parser.

    `run` is injected so this stays testable without ffmpeg: the reviewer's
    `audioqa._run` returns the stderr ebur128 writes its summary to.
    """
    try:
        from audioqa import parse_ebur128
        return parse_ebur128(run(["-i", path, "-af", "ebur128=peak=true"])
                             ).get("integrated_lufs")
    except Exception as e:  # noqa: BLE001 — an unmeasurable file is not a crash
        log(f"score mix: loudness of {os.path.basename(path)} unmeasurable ({e})")
        return None


def filter_complex(points, gain_db, *, cut_ms, score_ms, has_programme):
    """The one filtergraph: trim/pad the score, place it, sum with the cut.

    `duration=first` on amix would take the SHORTER input when the score is
    shorter, cutting the film's own audio off with it — `apad` to the cut's
    length is what makes "first" mean the cut. `normalize=0` because amix
    otherwise divides by the input count, which would drop the dialogue 6dB
    for the crime of having music under it.
    """
    fade = ""
    if score_ms and score_ms < cut_ms:
        start = max(0.0, (score_ms - TAIL_FADE_MS) / 1000.0)
        fade = f"afade=t=out:st={start:.3f}:d={TAIL_FADE_MS / 1000.0:.3f},"
    bed = (f"[1:a]{fade}"
           f"volume={gain_db:.2f}dB,"
           f"{mix.volume_filter({'automation': points, 'gain_db': 0.0})},"
           f"apad=whole_dur={cut_ms / 1000.0:.3f},"
           f"atrim=0:{cut_ms / 1000.0:.3f},"
           f"aresample=48000[bed]")
    if not has_programme:
        return bed.replace("[bed]", "[aout]")
    return bed + ";[0:a][bed]amix=inputs=2:duration=first:normalize=0[aout]"

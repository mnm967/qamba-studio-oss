"""music_gen — text-to-music on the pod (MiniMax Music 3, ACE-Step 1.5).

The third generation kind, beside `image_gen` and `clip_gen`, and shaped like
them on purpose: the browser writes a jobs row (invariant #1), the worker
builds a ComfyUI graph from a `music_models` entry, and the result is an
ordinary registered `audio` asset (invariant #2) that the library, the timeline
and every picker already understand. Nothing downstream needed teaching.

Why this is NOT `tts`: that path synthesizes a LINE through a hosted provider
on the cpu lane. This is a GPU render — a 10-19GB checkpoint, a sampler, a
progress stream — so it claims the gpu lane and behaves like the other two
renderers, including preview ticks and cooperative cancellation.

Two families, one handler. `graphs.music3_graph` / `graphs.acestep_graph`
differ in their inputs (a caption vs tags-plus-musical-metadata) and in where
the track's LENGTH comes from; everything after the sampler is identical, so
the split is at graph construction and nowhere else.
"""
import os

import comfy
import graphs
import media
import resolve as R
import sb
from handlers import images
from handlers.common import make_tick
from status import log

DEFAULT_MODEL = "minimax-music3"
DEFAULT_MS = 60_000
# The node ceilings, not ours: EmptyMiniMaxMusic3LatentAudio maxes at 360s and
# EmptyAceStep1.5LatentAudio at 1000s, but ACE's own encoder caps `duration` at
# 2000s and the model was trained for songs. A per-entry `max_seconds` is what
# actually binds; this is the floor-of-last-resort when an entry omits one.
FALLBACK_MAX_S = 300.0
MIN_S = 5.0

# ACE-Step's typed musical metadata. These are real inputs on the encoder, so a
# junk value is a validation failure rather than a stylistic miss — clamp to the
# node's own enums instead of passing a caller's string through.
TIME_SIGNATURES = ("2", "3", "4", "6")
KEY_SCALES = tuple(
    f"{root} {mode}"
    for mode in ("major", "minor")
    for root in ("C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G",
                 "G#", "Ab", "A", "A#", "Bb", "B"))
LANGUAGES = (
    "ar", "az", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "es", "fa",
    "fi", "fr", "he", "hi", "hr", "ht", "hu", "id", "is", "it", "ja", "ko",
    "la", "lt", "ms", "ne", "nl", "no", "pa", "pl", "pt", "ro", "ru", "sa",
    "sk", "sr", "sv", "sw", "ta", "te", "th", "tl", "tr", "uk", "ur", "vi",
    "yue", "zh", "unknown")

# What an empty lyric field means to each family. Both models sing whatever is
# in `lyrics`, so "instrumental" is the ABSENCE of lyrics plus a positive
# statement in the prose — leaving the field blank and saying nothing else
# gives you vocals more often than not, because the caption still describes a
# song. ACE-Step's own templates use a bracketed section tag for this, which is
# the same grammar its lyrics field already speaks.
ACE_INSTRUMENTAL = "[instrumental]"
INSTRUMENTAL_HINT = "instrumental, no vocals, no lyrics"


def resolve_kind(kind):
    return {"music_gen": handle_music_gen}[kind]


def _clamp_seconds(ms, entry):
    """Payload milliseconds (invariant #3) -> the seconds the nodes want."""
    cap = float(entry.get("max_seconds") or FALLBACK_MAX_S)
    return max(MIN_S, min(cap, float(ms) / 1000.0))


def _pick(value, allowed, default):
    """Snap a caller's string onto a node enum, case-insensitively."""
    if not value:
        return default
    v = str(value).strip()
    for opt in allowed:
        if v.lower() == opt.lower():
            return opt
    return default


def _node_spec(*names):
    """The installed nodes' declared inputs, for `_fit_node_inputs`.

    Same defence as the Krea 2 reference path: these two encoders are young
    (both landed in core within the last release), and a widget added or
    renamed upstream would otherwise fail validation on every music job. An
    unreachable ComfyUI returns nothing and the graph keeps our own shape,
    which is the shape the official template has today.

    Through `images._object_info` rather than `comfy.object_info` directly:
    that response is large, it is already cached there, and the cache's two
    TTLs are load-bearing — 15s when ComfyUI did not answer at all (the normal
    state for the first minutes of every boot) against 300s for a real "absent".
    A second, dumber cache beside it would be the third place to fix when that
    distinction next matters.
    """
    info = images._object_info() or {}
    return {n: info.get(n) for n in names if info.get(n)}


def beats_grid(bpm, duration_ms, offset_ms=0):
    """A beat every 60/bpm seconds — the Python twin of `beatsGrid` in
    src/routes/WizardPage.tsx, which is where an UPLOADED master track's grid
    comes from.

    This is the whole reason a generated track can drive the music-video
    pipeline at all. `planner.plan_blocks` snaps every block boundary to
    `audio_meta.beats_ms`, and for an uploaded file that list only exists
    because a human typed the BPM in. A generated track needs no one to: on
    ACE-Step the BPM is a typed encoder input, so the number is what the model
    was told, not what somebody estimated by ear.
    """
    bpm = float(bpm or 0)
    if not 30 <= bpm <= 300 or duration_ms <= 0:
        return []
    step = 60000.0 / bpm
    out, t = [], float(offset_ms)
    while t <= duration_ms:
        out.append(int(round(t)))
        t += step
    return out


def _attach(target, asset, info, *, bpm=None, lyrics="", instrumental=False):
    """Make this track the storyboard's master audio, if the job said to.

    `target: {"storyboard_id": …}` is the same late-bound shape `image_gen`
    uses to land a sheet on a bible entry: the job cannot know the asset id it
    is about to create, so it names the ROW it should end up on.

    Everything downstream is already built for this — `handle_launch_render`
    reads `storyboards.audio_asset_id` fresh and locks the blocks to it, and
    `audio_slice` cuts the master per block — so attaching is the entire
    integration. The one thing that must not happen quietly is REPLACING a
    track that blocks were already cut against: those blocks carry
    `audio_slice.asset_id` pointing at the old file, so they are marked stale
    rather than left looking current.
    """
    sid = target.get("storyboard_id")
    if not sid:
        return
    rows = sb.get(f"storyboards?id=eq.{sid}&select=id,audio_asset_id,audio_meta")
    if not rows:
        log(f"music_gen: storyboard {sid} is gone — track stays in the library")
        return
    story = rows[0]
    prev = story.get("audio_asset_id")
    dur = int(info.get("duration_ms") or 0)
    meta = dict(story.get("audio_meta") or {})
    if bpm:
        meta["bpm"] = int(bpm)
        grid = beats_grid(bpm, dur)
        if grid:
            meta["beats_ms"] = grid
    # NOT `lyrics`: that key is a list of TIMED lines ({t0,t1,text,singer}) and
    # every consumer indexes into it — `_lyrics_in_window` shifts them into a
    # block's window, `plan_storyboard` prints them as "12.4-15.1s: …". We know
    # the words and not when they are sung, so they go somewhere honest instead
    # of into a timed field with zeros in it.
    if lyrics and not instrumental:
        meta["lyrics_text"] = lyrics
    meta["source"] = "generated"
    patch = {"audio_asset_id": asset["id"], "audio_meta": meta}
    sb.patch(f"storyboards?id=eq.{sid}", patch)

    note = f"music_gen: attached to storyboard {sid}"
    if meta.get("beats_ms"):
        note += f" ({meta['bpm']} BPM, {len(meta['beats_ms'])} beats over {dur / 1000:.0f}s)"
    if prev and prev != asset["id"]:
        stale = sb.get(f"generation_blocks?storyboard_id=eq.{sid}"
                       f"&status=not.in.(generating)&select=id")
        if stale:
            sb.patch(f"generation_blocks?storyboard_id=eq.{sid}"
                     f"&status=not.in.(generating)", {"status": "stale"})
            note += (f" — REPLACED track {prev}, {len(stale)} block(s) marked stale "
                     f"(they were cut against the old one)")
        else:
            note += f" — replaced track {prev}"
    log(note)


def handle_music_gen(job):
    """Render one track and register it as an `audio` asset."""
    jid = job["id"]
    payload = job.get("payload") or {}

    model_key = payload.get("model_key") or DEFAULT_MODEL
    # Loads the map, checks every file, and fetches what is missing before the
    # graph is built — a 10GB entry that was never pulled onto this box is the
    # likeliest way a music job fails, and it should say so in those words.
    entry = R.music_model(model_key)
    fam = entry.get("family") or "music3"

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("music_gen needs a prompt — the caption/tags describing the track")
    lyrics = str(payload.get("lyrics") or "").strip()
    instrumental = bool(payload.get("instrumental")) or not lyrics
    if instrumental:
        # Say it in BOTH channels. The caption is what the planner reads to
        # decide whether there is a singer at all, and an empty lyric field on
        # its own is not an instruction — it is an absence, which these models
        # happily fill with vocals.
        lyrics = ACE_INSTRUMENTAL if fam == "acestep" else ""
        if INSTRUMENTAL_HINT.split(",")[0] not in prompt.lower():
            prompt = f"{prompt}, {INSTRUMENTAL_HINT}"

    seconds = _clamp_seconds(payload.get("duration_ms") or DEFAULT_MS, entry)
    seed = int(payload.get("seed") or 0)
    common = dict(seconds=seconds, seed=seed,
                  steps=payload.get("steps"), cfg=payload.get("cfg"),
                  tiled=bool(payload.get("tiled")),
                  quality=payload.get("quality") or "V0")

    # The RECIPE — everything that decided how this track sounds, snapped to
    # the same enums the graph was built with rather than copied raw off the
    # payload. It rides onto the asset below so a finished track can say what
    # it was asked for and be handed back to the composer as a starting point:
    # a generated song whose words and style are only in a job row that will
    # scroll away is a track nobody can iterate on.
    recipe = {}

    if fam == "acestep":
        spec = _node_spec("TextEncodeAceStepAudio1.5")
        recipe = {
            "bpm": int(payload.get("bpm") or 120),
            "key_scale": _pick(payload.get("key_scale"), KEY_SCALES, "C major"),
            "time_signature": _pick(payload.get("time_signature"),
                                    TIME_SIGNATURES, "4"),
            "language": _pick(payload.get("language"), LANGUAGES, "en"),
            "generate_audio_codes":
                payload.get("generate_audio_codes", True) is not False,
        }
        built = graphs.acestep_graph(
            entry, tags=prompt, lyrics=lyrics,
            bpm=recipe["bpm"], key_scale=recipe["key_scale"],
            time_signature=recipe["time_signature"], language=recipe["language"],
            # The LM half. Default on: it is what plans song structure, and
            # structure is the whole difference between a song and a loop.
            generate_audio_codes=recipe["generate_audio_codes"],
            shift=payload.get("shift"), node_spec=spec, **common)
    elif fam == "music3":
        spec = _node_spec("MiniMaxMusic3TextEncode")
        built = graphs.music3_graph(
            entry, caption=prompt, lyrics=lyrics,
            top_k=payload.get("top_k"), node_spec=spec, **common)
    else:
        raise ValueError(f"unknown music family {fam!r} on model '{model_key}'")

    log(f"music_gen [{fam}] model={model_key} {seconds:.0f}s seed={seed} "
        f"{'instrumental' if instrumental else str(len(lyrics.split())) + 'w lyrics'}: "
        f"'{prompt[:70]}'")

    pid = comfy.submit(built["graph"])
    sb.job_patch(jid, {"comfy_prompt_id": pid})
    # A 5-minute track at 50 steps is the slow end of this; the H3 hour is the
    # right ceiling to inherit rather than inventing a tighter one that fails a
    # legitimate render.
    outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=3600)

    sb.job_progress(jid, 0.9, note="upload")
    mp3 = f"/tmp/{jid}.mp3"
    comfy.fetch_output(outputs, built["outputs"], mp3)
    key = f"library/music/{jid}.mp3"
    try:
        media.b2_put(mp3, key, content_type="audio/mpeg")
        info = media.probe(mp3)
        asset = sb.register_asset(
            key, "audio", project_id=payload.get("project_id"),
            content_type="audio/mpeg", bytes_=info.get("bytes"),
            duration_ms=info.get("duration_ms"),
            source_job_id=jid, origin="generated",
            # `prompt` is the style brief, `lyrics` are the words, and
            # everything in `recipe` is a typed control the encoder actually
            # conditioned on. Together they are enough to re-render this track
            # or vary one thing about it.
            meta={"prompt": prompt, "lyrics": lyrics, "model": model_key,
                  "family": fam, "seed": seed, "instrumental": instrumental,
                  "requested_ms": int(seconds * 1000),
                  "kind_hint": "music", **recipe},
            tags=["library", "generated", "music"])
        # Waveform peaks + an exact probe, through the same path tts uses — the
        # timeline draws a real waveform instead of a flat bar.
        try:
            sb.insert("jobs", {
                "kind": "asset_ingest", "lane": "cpu", "status": "queued",
                "priority": 60, "payload": {"asset_id": asset["id"]},
                "project_id": payload.get("project_id"),
            })
        except Exception as e:
            log(f"music_gen: asset_ingest enqueue failed: {e}")
        _attach(payload.get("target") or {}, asset, info, bpm=payload.get("bpm"),
                lyrics=lyrics, instrumental=instrumental)
        sb.job_done(jid, output_key=key, output_asset_id=asset["id"])
        log(f"JOB DONE music_gen -> {key} ({(info.get('duration_ms') or 0) / 1000:.1f}s)")
    finally:
        try:
            os.remove(mp3)
        except OSError:
            pass

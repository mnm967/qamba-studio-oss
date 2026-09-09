"""sfx_gen — text-to-audio for sound design on the pod (Stable Audio 3).

The fourth generation kind, beside `image_gen`, `clip_gen` and `music_gen`,
and shaped like them: the browser writes a jobs row (invariant #1), the worker
builds a ComfyUI graph from an `sfx_models` entry, and the result is an
ordinary registered `audio` asset (invariant #2) that the library, the timeline
lanes and every picker already understand.

Why it is NOT `music_gen` with a third family. They differ in every dimension
that a caller has to reason about — the length contract (an SFX is asked for at
an exact number of seconds because it has to land in a cut; Music 3's planner
picks its own and ACE-Step needs the same number twice), the prompt shape (one
sentence of sound design against a caption plus a lyric sheet), the ceiling
(seconds against minutes), and the destination (an SFX never becomes a
storyboard's master track, so it has no `target` at all). Sharing the kind
would mean a handler whose every branch asked which of two things it was.

Why it is NOT `tts`. That path synthesizes a LINE through a hosted provider on
the cpu lane. This is a GPU render — a checkpoint, a sampler, a progress
stream — so it claims the gpu lane and behaves like the other renderers,
including preview ticks and cooperative cancellation.
"""
import os

import comfy
import graphs
import media
import resolve as R
import sb
from handlers.common import make_tick
from status import log

DEFAULT_MODEL = "stable-audio-3-medium"
DEFAULT_MS = 5_000
# `EmptyLatentAudio` accepts 1-1000s, but what actually binds is the entry's
# own `max_seconds` — Medium is trained to ~6:20 and Small to ~2:00, and asking
# either for more returns filler on the end rather than an error.
FALLBACK_MAX_S = 120.0
MIN_S = 1.0

# The template's reprompt presets. They select a system prompt for the Qwen
# expansion, which we do NOT run in the graph (see `graphs.stable_audio_graph`)
# — here the category is what the enhance guide is told to write toward, and
# what the asset is tagged with so the library can group by it.
CATEGORIES = ("sfx", "one-shot", "instrument", "music")


def resolve_kind(kind):
    return {"sfx_gen": handle_sfx_gen}[kind]


def _clamp_seconds(ms, entry):
    """Payload milliseconds (invariant #3) -> the seconds the node wants."""
    cap = float(entry.get("max_seconds") or FALLBACK_MAX_S)
    return max(MIN_S, min(cap, float(ms) / 1000.0))


def handle_sfx_gen(job):
    """Render one sound and register it as an `audio` asset."""
    jid = job["id"]
    payload = job.get("payload") or {}

    model_key = payload.get("model_key") or DEFAULT_MODEL
    # Loads the map, checks both files, and fetches what is missing before the
    # graph is built — a 9GB checkpoint that was never pulled onto this box is
    # the likeliest way an SFX job fails, and it should say so in those words.
    entry = R.sfx_model(model_key)
    fam = entry.get("family") or "stable_audio"
    if fam != "stable_audio":
        raise ValueError(f"unknown sfx family {fam!r} on model '{model_key}'")

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("sfx_gen needs a prompt — the description of the sound")

    # A negative only exists where cfg makes one exist. The distilled rows
    # sample at cfg 1.0, where the negative branch cannot contribute at all —
    # accepting one there and rendering as if it mattered is the silent
    # downgrade this codebase keeps getting bitten by, so say it in the log.
    negative = str(payload.get("negative") or "").strip()
    cfg = float(payload.get("cfg") if payload.get("cfg") is not None
                else entry.get("cfg", 7.0))
    if negative and cfg <= 1.0:
        log(f"sfx_gen: '{model_key}' samples at cfg {cfg} — the negative prompt "
            f"is inert on this row and is being dropped")
        negative = ""

    seconds = _clamp_seconds(payload.get("duration_ms") or DEFAULT_MS, entry)
    seed = int(payload.get("seed") or 0)
    category = str(payload.get("category") or "sfx").strip().lower()
    if category not in CATEGORIES:
        category = "sfx"

    built = graphs.stable_audio_graph(
        entry, prompt=prompt, negative=negative, seconds=seconds, seed=seed,
        steps=payload.get("steps"), cfg=cfg,
        tiled=bool(payload.get("tiled")),
        quality=payload.get("quality") or "V0")

    log(f"sfx_gen [{category}] model={model_key} {seconds:.1f}s seed={seed} "
        f"cfg={cfg}: '{prompt[:70]}'")

    pid = comfy.submit(built["graph"])
    sb.job_patch(jid, {"comfy_prompt_id": pid})
    # Short clips at 8 steps are seconds of work; the cold checkpoint load is
    # the long pole. 20 minutes covers a 6-minute bed at 50 steps from cold.
    outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=1200)

    sb.job_progress(jid, 0.9, note="upload")
    mp3 = f"/tmp/{jid}.mp3"
    comfy.fetch_output(outputs, built["outputs"], mp3)
    key = f"library/sfx/{jid}.mp3"
    try:
        media.b2_put(mp3, key, content_type="audio/mpeg")
        info = media.probe(mp3)
        asset = sb.register_asset(
            key, "audio", project_id=payload.get("project_id"),
            content_type="audio/mpeg", bytes_=info.get("bytes"),
            duration_ms=info.get("duration_ms"),
            source_job_id=jid, origin="generated",
            # The whole recipe, so the library can show what a sound was asked
            # for and hand it back to the composer as a starting point.
            meta={"prompt": prompt, "negative": negative, "model": model_key,
                  "family": fam, "seed": seed, "category": category,
                  "cfg": cfg, "requested_ms": int(seconds * 1000),
                  "kind_hint": "sfx"},
            # dict.fromkeys, not a set: the order is what the library shows,
            # and `category` is "sfx" for most rows — a plain list produced
            # ["library","generated","sfx","sfx"].
            tags=list(dict.fromkeys(["library", "generated", "sfx", category])))
        # Waveform peaks + an exact probe, through the same path tts and
        # music_gen use — the timeline draws a real waveform, not a flat bar.
        try:
            sb.insert("jobs", {
                "kind": "asset_ingest", "lane": "cpu", "status": "queued",
                "priority": 60, "payload": {"asset_id": asset["id"]},
                "project_id": payload.get("project_id"),
            })
        except Exception as e:
            log(f"sfx_gen: asset_ingest enqueue failed: {e}")
        sb.job_done(jid, output_key=key, output_asset_id=asset["id"])
        log(f"JOB DONE sfx_gen -> {key} ({(info.get('duration_ms') or 0) / 1000:.1f}s)")
    finally:
        try:
            os.remove(mp3)
        except OSError:
            pass

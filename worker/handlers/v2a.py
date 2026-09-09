"""v2a_gen — video-to-audio on the pod (MMAudio large 44k v2).

The FIFTH generation kind, beside `image_gen`, `clip_gen`, `music_gen` and
`sfx_gen`, and shaped like them: the browser writes a jobs row (invariant #1),
the worker builds a ComfyUI graph, and the result is a registered `audio`
asset (invariant #2) that the library, the timeline lanes and every picker
already understand.

WHY IT IS NOT `sfx_gen` WITH A SECOND FAMILY. Stable Audio writes a sound from
a caption and has never seen the shot; this one conditions on the FRAMES, and
every dimension a caller reasons about follows from that. The length is the
clip's rather than a number someone picks. The prompt supplements what is on
screen instead of describing the whole event, so its guide is the opposite
advice ("one sound per generation, end with the length" would be wrong here).
The input is a video asset, which no other audio kind takes. And the useful
destination is not the library at all — it is a NEW TAKE of the block the
video came from, which no other audio kind can produce. Sharing the kind would
mean a handler whose every branch asked which of two things it was.

Two destinations, one render:

* No `block_id` — the audio asset is the deliverable (the Audio & Voice
  studio's Video → Audio tab). Drag it onto a lane, or keep it in the library.
* `block_id` — the audio is muxed onto the source video with `-c:v copy` and
  published as an ordinary take of that block, so everything already written
  about takes applies: it is reviewable, it can be superseded, and activating
  it repoints the timeline clip. The bare audio is registered too, because it
  is the thing that was actually generated and is worth reusing on its own.
"""
import os

import comfy
import graphs
import media
import mmaudio_spec as MS
import resolve as R
import sb
from handlers.common import make_tick
from handlers.images import _has_node, _node_spec
from status import log

DEFAULT_MODEL = "mmaudio-large-44k-v2"
COMFY_ROOT = os.environ.get("COMFY_ROOT", "/home/ubuntu/ComfyUI")

# The pack's four nodes. Only the two that carry weights and the sampler are
# required — MMAudioVoCoderLoader exists for the 16k branch alone, which we
# have no weights for and never build.
REQUIRED_NODES = ("MMAudioModelLoader", "MMAudioFeatureUtilsLoader",
                  "MMAudioSampler",
                  # The FIRST node of the graph, and from a different pack
                  # (VideoHelperSuite). MMAudio conditions on FRAMES, so
                  # without this the three above are installed and unusable —
                  # and the failure lands in ComfyUI's validator naming a class
                  # rather than here naming a pack.
                  "VHS_LoadVideo")


def resolve_kind(kind):
    return {"v2a_gen": handle_v2a_gen}[kind]


def _require_nodes():
    """Refuse before the GPU is spent, and say what to install.

    `ensure_model` fetches WEIGHTS; a custom node pack is a different kind of
    absence and fails deep inside ComfyUI's validator on a class name, which
    reads as a code bug rather than as "that pack was never cloned onto this
    box". The check goes through `_has_node`, so a miss is re-asked rather
    than cached for the life of the process — the boot window where ComfyUI
    is not listening yet is exactly when this would otherwise lie.
    """
    missing = [n for n in REQUIRED_NODES if not _has_node(n)]
    if not missing:
        return
    # NAME A FIX THE READER CAN PERFORM — a screen, not a command. The packs
    # are added by the engine window's own install, so that is the remedy for
    # an engine this app made; for a ComfyUI of the user's own it is the one
    # place the pack NAMES are written down, which is what they need.
    raise RuntimeError(
        f"the MMAudio nodes are not in this engine ({', '.join(missing)}). "
        f"Reinstall the engine from the engine window — it adds "
        f"kijai/ComfyUI-MMAudio and ComfyUI-VideoHelperSuite at install time — "
        f"then start it again. On a ComfyUI of your own, install those two "
        f"packs there.")


def handle_v2a_gen(job):
    """Score one video and register the result."""
    jid = job["id"]
    payload = job.get("payload") or {}

    src = sb.asset_by_id(payload.get("source_asset_id"))
    if not src:
        raise ValueError("v2a_gen needs `source_asset_id` — the video to score")
    if (src.get("kind") or "") not in ("video", "file"):
        raise ValueError(f"v2a_gen source must be a video, not {src.get('kind')!r}")

    _require_nodes()
    model_key = payload.get("model_key") or DEFAULT_MODEL
    # Loads the map, checks all four files, and fetches what is missing before
    # the graph is built — ~5.1GB that was never pulled onto this box is the
    # likeliest way this job fails, and it should say so in those words.
    entry = R.v2a_model(model_key)
    fam = entry.get("family") or "mmaudio"
    if fam != "mmaudio":
        raise ValueError(f"unknown video-to-audio family {fam!r} on '{model_key}'")

    prompt = str(payload.get("prompt") or "").strip()
    negative = str(payload.get("negative") or "").strip()
    # A negative genuinely contributes here, unlike every distilled audio row
    # in this studio: MMAudio samples at a real cfg (4.5 by default), so the
    # uncond branch is evaluated. Say so only when it ISN'T, so the log never
    # implies a control did nothing when it did.
    cfg = float(payload.get("cfg") if payload.get("cfg") is not None
                else entry.get("cfg", 4.5))
    if negative and cfg <= 1.0:
        log(f"v2a_gen: cfg {cfg} leaves the negative branch inert — dropping "
            f"the negative prompt rather than rendering as if it mattered")
        negative = ""

    # The length is the SOURCE's unless the caller says otherwise. That is the
    # difference between this and every other audio kind: a soundtrack's job
    # is to cover the shot, so the shot is the default.
    want_ms = int(payload.get("duration_ms") or src.get("duration_ms") or 8000)
    seconds = MS.clamp_seconds(want_ms, entry.get("max_seconds"))
    note = MS.duration_note(seconds, entry.get("trained_seconds", MS.TRAINED_SECONDS))
    if note:
        log(f"v2a_gen: {note}")

    seed = int(payload.get("seed") or 0)
    steps = int(payload.get("steps") or entry.get("steps", 25))
    fps = int(entry.get("sync_fps") or MS.SYNC_FPS)

    vname = _stage(src, jid)
    built = graphs.mmaudio_graph(
        entry, video=vname, prompt=prompt, negative=negative,
        seconds=seconds, seed=seed, steps=steps, cfg=cfg,
        mask_away_clip=bool(payload.get("mask_away_clip")),
        # The caller can say where the source's VISIBLE content ends — a block
        # take's file already is its content, a timeline clip's routinely runs
        # past the trim. Left unsaid, the builder reads exactly the frames the
        # sampler will consume.
        load_cap=int(payload.get("frame_load_cap") or 0),
        skip_frames=int(payload.get("skip_frames") or 0),
        node_spec=_node_spec("MMAudioModelLoader"),
        feature_spec=_node_spec("MMAudioFeatureUtilsLoader"),
        sampler_spec=_node_spec("MMAudioSampler"))

    log(f"v2a_gen model={model_key} {seconds:.2f}s @{fps}fps "
        f"({MS.frames_needed(seconds, fps)}f staged) steps={steps} cfg={cfg} "
        f"seed={seed} src={src['b2_key']}: '{prompt[:60]}'")

    pid = comfy.submit(built["graph"])
    sb.job_patch(jid, {"comfy_prompt_id": pid})
    # The cold load is the long pole: 2GB transformer + 2GB CLIP tower + the
    # VAE and Synchformer, plus a first-run BigVGAN snapshot download.
    outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=2400)

    sb.job_progress(jid, 0.9, note="upload")
    mp3 = f"/tmp/{jid}.mp3"
    made = [mp3]
    try:
        comfy.fetch_output(outputs, built["outputs"], mp3)
        akey = f"library/v2a/{jid}.mp3"
        media.b2_put(mp3, akey, content_type="audio/mpeg")
        ainfo = media.probe(mp3)
        recipe = {"prompt": prompt, "negative": negative, "model": model_key,
                  "family": fam, "seed": seed, "steps": steps, "cfg": cfg,
                  "source_asset_id": src["id"], "requested_ms": int(seconds * 1000),
                  "kind_hint": "v2a"}
        if payload.get("take_id"):
            recipe["source_take_id"] = payload["take_id"]
        audio = sb.register_asset(
            akey, "audio", project_id=payload.get("project_id") or src.get("project_id"),
            content_type="audio/mpeg", bytes_=ainfo.get("bytes"),
            duration_ms=ainfo.get("duration_ms"), source_job_id=jid,
            origin="generated", meta=recipe,
            tags=["library", "generated", "v2a"])
        _queue_ingest(audio["id"], payload, src)

        if not payload.get("block_id"):
            sb.job_done(jid, output_key=akey, output_asset_id=audio["id"])
            log(f"JOB DONE v2a_gen -> {akey} "
                f"({(ainfo.get('duration_ms') or 0) / 1000:.1f}s)")
            return

        made += _publish_take(job, payload, src, audio, mp3, recipe)
    finally:
        for p in made:
            try:
                os.remove(p)
            except OSError:
                pass


def _stage(asset, jid):
    """Download the source video into ComfyUI's input dir."""
    ext = os.path.splitext(asset["b2_key"])[1] or ".mp4"
    name = f"qamba_v2a_{jid}{ext}"
    media.b2_get(asset["b2_key"], os.path.join(COMFY_ROOT, "input", name))
    return name


def _queue_ingest(asset_id, payload, src):
    """Waveform peaks + an exact probe, through the same path `sfx_gen` and
    `music_gen` use — the timeline draws a real waveform, not a flat bar."""
    try:
        sb.insert("jobs", {
            "kind": "asset_ingest", "lane": "cpu", "status": "queued",
            "priority": 60, "payload": {"asset_id": asset_id},
            "project_id": payload.get("project_id") or src.get("project_id"),
        })
    except Exception as e:  # noqa: BLE001 — a waveform is not worth the render
        log(f"v2a_gen: asset_ingest enqueue failed: {e}")


def _publish_take(job, payload, src, audio, mp3, recipe):
    """Mux the new sound onto the source video and publish it as a take.

    -> the temp files to clean up.

    `mark_stale=False` is the decision worth reading twice. `_publish_derived_
    take` normally marks every chained block downstream, because a new active
    take moves the frame the next block opens on. Here the picture is COPIED
    (`-c:v copy`), so the last frame is bit-identical to the take this came
    from and no anchor has moved — a staleness sweep would invite a re-render
    of half an episode to record that a soundtrack changed. The frame asset is
    still republished, because the take is a legitimate chain anchor for
    anything the editor points at it later.
    """
    from handlers.blocks import _load_block, _publish_derived_take

    jid = job["id"]
    block = _load_block(payload["block_id"])
    story = sb.get(f"storyboards?id=eq.{block['storyboard_id']}&select=episode_id")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,code,project_id")[0]

    sb.job_progress(jid, 0.94, note="muxing onto the picture")
    vin = f"/tmp/{jid}_src.mp4"
    out = f"/tmp/{jid}_take.mp4"
    media.b2_get(src["b2_key"], vin)
    media.replace_audio(vin, mp3, out)

    # "Content edits default to replace — the user asked for the shot to be
    # different, so the different one should play; history keeps the old takes
    # either way." Changing a block's audio is exactly that, so unlike
    # `video_edit` (whose default is review, because an EDIT is a proposal)
    # the fallback here is replace. The modal sends this explicitly anyway.
    activate = (payload.get("activate") or "replace") == "replace"
    asset, take = _publish_derived_take(
        jid, block, ep, out, name="audio", kind="audio",
        activate=activate, mark_stale=False,
        meta={**recipe, "audio_asset_id": audio["id"],
              "picture_from_asset_id": src["id"]})

    # AND THE BLOCK HAS TO COME OUT OF `queued`. Anything enqueued through
    # `queueBlockRender` moves the block there in the same breath, and only
    # master_pass ever wrote a terminal status back — so without this the
    # block spins forever with its take sitting right there. Same gap
    # `handle_video_edit` had.
    sb.patch(f"generation_blocks?id=eq.{block['id']}", {"status": "generated"})
    sb.job_done(jid, output_key=asset["b2_key"], output_asset_id=asset["id"])
    log(f"JOB DONE v2a_gen -> take {take['id'][:8]} on block {block['idx']} "
        f"({'active' if activate else 'pending'})")
    return [vin, out]

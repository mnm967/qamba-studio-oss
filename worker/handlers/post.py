"""Post-processing + storage GC.

gc_sweep: two-phase orphan collection for B2 (invariant #2: the assets table
is the registry — DB-first deletes mean anything in the bucket without a row
is garbage, after a safety window).
  scan  -> diff bucket vs assets.b2_key; unregistered objects older than 48h
           become a manifest at gc/manifest.json (no deletions).
  purge -> delete manifest keys that are STILL unregistered and whose manifest
           is >=7 days old; flags asset rows whose object 404s.

post_* : the finishing passes, per the mastering canon (restore -> refine ->
frame rate -> faces -> grade -> grain). Each is file -> file, so ONE
implementation serves both callers: the standalone `post_*` job and the post
chain a timeline render applies per clip (post_chain.py owns the order).

Every op checks its ComfyUI nodes exist first and fails with an installable
hint rather than a stack trace — but note what those checks are checking for
NOW. SeedVR2 and frame interpolation are CORE ComfyUI (nodes_seedvr.py,
nodes_frame_interpolation.py) and colour match is KJNodes' ColorMatch, all
three of which were on this pod while the gates named third-party packs that
were not; only FaceDetailer needs a pack. So a gate here is a node-id claim
about the live engine and it rots — check /object_info, or the inventory the
worker publishes to B2 (engine_manifest.py), before believing one.

Only `grain` runs without ComfyUI at all.
"""
import json
import os
import time

import comfy
import media
import post_chain
import sb
import staging
from status import log

PROTECTED_PREFIXES = ("modelbackup/", "deploy/", "app-src/", "gc/")
MANIFEST_KEY = "gc/manifest.json"
SCAN_MIN_AGE_S = 48 * 3600
PURGE_MIN_AGE_S = 7 * 24 * 3600


def resolve(kind):
    return {
        "gc_sweep": handle_gc_sweep,
        "image_upscale": handle_image_upscale,
        "post_upscale": handle_post_upscale,
        "post_interpolate": handle_post_interpolate,
        "post_facefix": handle_post_facefix,
        "post_h3_facefix": handle_post_h3_facefix,
        "post_ltx_refine": handle_post_ltx_refine,
        "post_grain_color": handle_post_grain_color,
    }[kind]


# --------------------------------------------------------------------- gc ----
def handle_gc_sweep(job):
    jid = job["id"]
    phase = (job.get("payload") or {}).get("phase", "scan")
    listing = [{"key": k, "size": s, "mtime_ts": dt.timestamp()}
               for k, s, dt in media.b2_list()]
    registered = {r["b2_key"] for r in sb.get("assets?select=b2_key")}
    # v1 tables reference keys directly (shots/takes/references_) — keep those
    # alive too until the v1 retirement migration drops them.
    for tbl, col in (("takes", "output_key"), ("references_", "candidate_key"),
                     ("references_", "kept_key"), ("shots", "candidate_key")):
        try:
            for r in sb.get(f"{tbl}?select={col}"):
                if r.get(col):
                    registered.add(r[col])
        except Exception:
            pass

    now = time.time()
    orphans = [o for o in listing
               if o["key"] not in registered
               and not o["key"].startswith(PROTECTED_PREFIXES)
               and now - o["mtime_ts"] > SCAN_MIN_AGE_S]

    if phase == "scan":
        manifest = {"created_at": now,
                    "keys": [{"key": o["key"], "size": o["size"]} for o in orphans]}
        local = f"/tmp/{jid}_manifest.json"
        with open(local, "w") as f:
            json.dump(manifest, f)
        media.b2_put(local, MANIFEST_KEY, content_type="application/json")
        os.remove(local)
        sb.job_patch(jid, {"payload": {**(job.get("payload") or {}),
                                       "result": {"orphans": len(orphans),
                                                  "bytes": sum(o["size"] for o in orphans)}}})
        sb.job_done(jid)
        log(f"JOB DONE gc scan: {len(orphans)} orphan(s) manifested")
        return

    # purge
    local = f"/tmp/{jid}_manifest.json"
    try:
        media.b2_get(MANIFEST_KEY, local)
    except Exception:
        sb.job_done(jid)
        log("gc purge: no manifest — nothing to do")
        return
    with open(local) as f:
        manifest = json.load(f)
    os.remove(local)
    if now - float(manifest.get("created_at", now)) < PURGE_MIN_AGE_S:
        sb.job_done(jid)
        log("gc purge: manifest younger than 7d — skipped")
        return
    victims = [k["key"] for k in manifest.get("keys", [])
               if k["key"] not in registered and not k["key"].startswith(PROTECTED_PREFIXES)]
    for key in victims:
        try:
            media.b2_delete(key)
        except Exception as e:
            log(f"gc delete failed {key}: {e}")
    live_keys = {o["key"] for o in listing}
    missing = [r for r in sb.get("assets?select=id,b2_key,meta") if r["b2_key"] not in live_keys]
    for r in missing:
        sb.patch(f"assets?id=eq.{r['id']}",
                 {"meta": {**(r.get("meta") or {}), "b2_missing": True}})
    sb.job_patch(jid, {"payload": {**(job.get("payload") or {}),
                                   "result": {"purged": len(victims), "flagged_missing": len(missing)}}})
    sb.job_done(jid)
    log(f"JOB DONE gc purge: {len(victims)} deleted, {len(missing)} rows flagged missing")


# ------------------------------------------------------------------- post ----
def _load_source(job):
    payload = job.get("payload") or {}
    aid = payload.get("asset_id")
    if not aid and payload.get("clip_id"):
        clip = sb.get(f"clips?id=eq.{payload['clip_id']}")[0]
        aid = clip["asset_id"]
    asset = sb.asset_by_id(aid)
    if not asset:
        raise ValueError("post source asset not found")
    local = f"/tmp/{job['id']}_src{os.path.splitext(asset['b2_key'])[1] or '.mp4'}"
    media.b2_get(asset["b2_key"], local)
    return asset, local


def _finish(job, asset, out_path, op, meta_extra=None):
    jid = job["id"]
    key = f"post/{op}/{jid}.mp4"
    media.b2_put(out_path, key)
    info = media.probe(out_path)
    row = sb.register_asset(key, "video", project_id=asset.get("project_id"),
                            content_type="video/mp4", bytes_=info["bytes"],
                            width=info["width"], height=info["height"],
                            duration_ms=info["duration_ms"], fps=info["fps"],
                            source_job_id=jid, origin="derived",
                            meta={"post_op": op, "post_of": asset["id"],
                                  **(meta_extra or {})},
                            tags=["post", op])
    sb.job_done(jid, output_asset_id=row["id"])
    log(f"JOB DONE {op} -> {key}")
    return row


def _require_nodes(*names):
    """Fail early with an installable hint when a workflow's nodes aren't in
    this ComfyUI (post packs are optional installs)."""
    info = comfy.object_info()
    missing = [n for n in names if n not in info]
    if missing:
        raise RuntimeError(
            f"ComfyUI is missing node(s) {missing} — install the pack on the pod "
            f"(see the engine window's node-pack install) and retry")


def _combo_values(node, field):
    """The legal values of an installed node's combo input -> tuple.

    TWO SPELLINGS, and reading only the first is how a V3 node's list comes
    back EMPTY. A classic node publishes the options IN PLACE of the type
    (`[["mkl", ...], {...}]`); a V3 node publishes
    `["COMBO", {"options": [...]}]`. That is the same split
    `engine_manifest.trim()` gets wrong, which is exactly why this asks the
    LIVE engine and not the inventory published to B2 — that document can say
    a V3 node exists and cannot say what it offers.

    Empty means "could not tell" (unknown node, unreachable engine, a schema
    neither spelling covers), so a caller must treat it as "do not know"
    rather than "offers nothing".
    """
    spec = (comfy.object_info() or {}).get(node) or {}
    inp = spec.get("input") or {}
    cfg = (inp.get("required") or {}).get(field) or (inp.get("optional") or {}).get(field)
    if not isinstance(cfg, list) or not cfg:
        return ()
    if isinstance(cfg[0], list):
        return tuple(cfg[0])
    opts = cfg[1] if len(cfg) > 1 and isinstance(cfg[1], dict) else {}
    return tuple(opts.get("options") or ())


def _run_workflow_file(job, wf_name, subs, timeout=3600):
    from handlers.common import make_tick
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "..", "workflows", wf_name)
    path = os.path.normpath(path)
    # Substitute on raw text FIRST: numeric placeholders (__MULT__, __FPS__)
    # sit unquoted, so the file is only valid JSON after substitution.
    with open(path) as f:
        text = f.read()
    for k, v in subs.items():
        text = text.replace(k, str(v))
    graph = json.loads(text)
    graph.pop("_comment", None)
    pid = comfy.submit(graph)
    sb.job_patch(job["id"], {"comfy_prompt_id": pid})
    return comfy.wait(pid, on_tick=make_tick(job), timeout=timeout)


def handle_image_upscale(job):
    """Tile-refine an IMAGE: ESRGAN-family enlarge, then a low-denoise diffusion
    pass over the result in tiles, through Qwen-Edit.

    Distinct from post_upscale below, which is SeedVR2 on VIDEO — different
    input, different pack, different failure mode. Neither substitutes for the
    other, and until now only the video one existed.

    payload: {asset_id, scale?, denoise?, prompt?, steps?, cfg?, loras?}
    `prompt` is optional and usually should be: the tile pass is a refine, and
    a description here steers what the tiles invent. Left empty it sharpens
    what is already there, which is the point.
    """
    jid = job["id"]
    payload = job.get("payload") or {}
    asset, local = _load_source(job)
    if (asset.get("kind") or "") != "image":
        raise ValueError(f"image_upscale needs an image asset, got {asset.get('kind')!r}")
    _require_nodes("UltimateSDUpscale")

    import resolve as R
    import graphs
    mm = R.load_map()
    qe = mm[R.TIER]["image_models"]["qwen-edit"]

    name = _stage_for_comfy(local, "qamba_up", jid)

    from handlers.images import _node_spec
    g = graphs.qwen_upscale_graph(
        qe, name, int(payload.get("seed") or 42),
        prompt=payload.get("prompt") or "",
        negative=payload.get("negative") or "",
        scale=float(payload.get("scale") or 2),
        denoise=float(payload.get("denoise") or 0.2),
        steps=payload.get("steps"), cfg=payload.get("cfg"),
        loras=payload.get("loras"),
        node_spec=_node_spec("TextEncodeQwenImageEditPlus"),
        usdu_spec=_node_spec("UltimateSDUpscale"))

    from handlers.common import make_tick
    log(f"image_upscale {asset.get('width')}x{asset.get('height')} "
        f"x{payload.get('scale') or 2} denoise={payload.get('denoise') or 0.2}")
    out = f"/tmp/{jid}_up.png"
    try:
        pid = comfy.submit(g)
        sb.job_patch(jid, {"comfy_prompt_id": pid})
        outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=3600)
        comfy.fetch_output(outputs, list(outputs.keys()), out)
    finally:
        _unstage(name)

    key = f"post/upscale/{jid}.png"
    media.b2_put(out, key, content_type="image/png")
    width = height = None
    try:
        from PIL import Image
        with Image.open(out) as im:
            width, height = im.size
    except Exception:
        pass
    row = sb.register_asset(key, "image", project_id=asset.get("project_id"),
                            content_type="image/png", bytes_=os.path.getsize(out),
                            width=width, height=height,
                            source_job_id=jid, origin="derived",
                            meta={"post_op": "upscale", "post_of": asset["id"],
                                  "scale": payload.get("scale") or 2,
                                  "denoise": payload.get("denoise") or 0.2},
                            tags=["post", "upscale"])
    sb.job_done(jid, output_asset_id=row["id"])
    log(f"JOB DONE image_upscale -> {key} ({width}x{height})")
    for p in (local, out):
        try:
            os.remove(p)
        except OSError:
            pass
    return row


# ------------------------------------------------------------ post passes ----
# Each pass is file -> file, so the SAME implementation serves both callers: the
# standalone `post_*` job (make me a derived asset of this take) and the post
# chain the timeline render applies per clip (post_chain.py). They used to exist
# only in the second shape — bolted into a handler that loaded an asset and
# registered one — which is why the render could not reach them at all and the
# inspector's toggles had to queue a job apiece to do anything.
#
# `job` is carried only for the progress tick, the cancel check and the
# comfy_prompt_id; nothing here reads its payload.

def _rm(path):
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass


#: What ONE ComfyUI pass may hold at once, as OUTPUT pixel-frames: frames x
#: the width x height the pass produces. A pass reads every frame of its clip
#: as one tensor, so the cost is linear in this number and NOTHING about the
#: edit bounds it — a 12-second shot is a legitimate thing to cut, and it is
#: four times the tensor a 3-second one is.
#:
#: MEASURED on the g7e's 96 GB card (2026-08-24), SeedVR2 at scale 2 over
#: 1280x736, peak read off nvidia-smi through the run:
#:   144 frames ->  542 M px-frames — completed, 353 s
#:   200 frames ->  754 M px-frames — OOM, peak 94055 MiB of 97887
#:   288 frames -> 1085 M px-frames — OOM (the render this bound exists for),
#:                                    84892 MiB live at the throw
#: The 200-frame peak divides out at 124.8 MiB per M px-frames and the model is
#: LINEAR: 754 M x 124.8 is 94055 MiB, which is the observed peak to three
#: figures. So the card's own ceiling is ~750 M and the failure is a wall, not
#: a slope — 144 frames worked with ~30 GB spare and 200 had none.
#:
#: 420 M predicts a 52 GB peak, i.e. ~43 GB of headroom: enough for a model the
#: previous pass has not been asked to give back (LTX 2.5 is 20.5 GB of
#: transformer plus 14.6 GB of text encoder, and this chain runs it between two
#: SeedVR2 passes) and for the coefficient not being identical at every frame
#: size. At 2560x1472 it is 111 frames, i.e. 4.6 s of 24 fps footage.
#:
#: It is a BOUND, not a tuning: the cost of being wrong on the low side is a
#: seam, and the cost of being wrong on the high side is a dead render at the
#: end of an hour of GPU time. `POST_CHUNK_PIXELS` in /etc/neon-worker.env
#: raises or lowers it without a code change.
POST_CHUNK_PIXELS = int(os.environ.get("POST_CHUNK_PIXELS") or 420_000_000)


def plan_windows(frames, out_px_per_frame, *, budget=None):
    """How to split `frames` so no single pass exceeds the budget.

    -> [(start_frame, end_frame)] over the clip, or [] when it all fits in one
    pass — which is the answer for every clip short enough that nothing about
    the render changes.

    The last window's end is None, i.e. "to the end of the file". The frame
    count reaching here is duration x fps (ffprobe gives no exact count on
    these files without decoding them), so it can be a frame out; an open last
    window means that error can never drop the final frame of a clip.

    Windows are EVEN rather than "fill the budget then take the remainder":
    a 300-frame clip at a 127-frame cap becomes 3 x 100 instead of 127 + 127 +
    46, so the seams fall in comparable material and the runt window — which
    is the one whose restore has least temporal context — does not exist.
    """
    budget = int(budget or POST_CHUNK_PIXELS)
    cap = max(1, budget // max(1, int(out_px_per_frame)))
    frames = max(1, int(frames))
    if frames <= cap:
        return []
    n = -(-frames // cap)                       # windows, ceil
    size = -(-frames // n)                      # evened out over them
    starts = [i * size for i in range(n) if i * size < frames]
    # The open end goes on whichever window is LAST after that filter, not on
    # window n-1: an evened size can leave the final slot empty, and a closed
    # last window would then cut the clip at the estimated frame count.
    return [(a, None if j == len(starts) - 1 else starts[j + 1])
            for j, a in enumerate(starts)]


def _windowed(job, src, dst, run, *, out_px_per_frame, label, budget=None,
              cancel_check=None):
    """Run `run(in_path, out_path, tag)` over `src`, in windows that fit in VRAM.

    `tag` is "" for a clip that fits and "w0", "w1"… per window — the runner
    stages files into ComfyUI's input dir by name, and two windows of one clip
    would otherwise stage over each other.

    Transparent when the clip fits: `run` is called once, on the file it was
    given, and no extra encode happens. Only a clip over the budget is split.

    THE PICTURE IS CONCATENATED AND THE SOUND COMES BACK FROM THE SOURCE. Both
    windowed passes leave the soundtrack alone by design — SeedVR2 rides the
    take's audio straight through `CreateVideo`, and `ltx_refine` deliberately
    keeps the source's own rather than the one LTX generates — so re-muxing the
    whole track is not a substitution, it is the same audio arriving in one
    piece instead of N. Joining the windows' audio instead would put an
    encoder-priming gap at every seam, which is audible where a seam in a
    restored PICTURE is not.

    Windows do not overlap. That is deliberate: an exact partition concatenates
    with `-c copy`, so the split costs one encode of the input and no
    generation at all on the way out. If a seam ever shows in practice, the
    escalation is a few frames of lead-in per window plus a frame-exact trim of
    the result — which costs a generation per window, so it should be bought
    with a measurement rather than on principle.
    """
    info = media.probe(src) or {}
    fps = float(info.get("fps") or 0) or 24.0
    frames = max(1, int(round((info.get("duration_ms") or 0) / 1000.0 * fps)))
    plan = plan_windows(frames, out_px_per_frame, budget=budget)
    if not plan:
        return run(src, dst, "")
    # Splitting turns one long pass into several minutes of ffmpeg either side
    # of each one, and a cancel pressed during that should land — same shape as
    # apply_grain's.
    cancel_check = cancel_check or ((lambda: sb.cancel_requested(job["id"]))
                                    if job else None)

    log(f"post {label}: {frames} frames x {int(out_px_per_frame):,} px is over "
        f"the {int(budget or POST_CHUNK_PIXELS):,} px-frame budget — "
        f"{len(plan)} windows")
    has_aud = media.has_audio(src)
    made, joins = [], []
    listf, joined = dst + ".cat.txt", dst + ".cat.mp4"
    try:
        for i, (a, b) in enumerate(plan):
            win = f"{dst}.w{i}.mp4"
            rng = f"start_frame={a}" + ("" if b is None else f":end_frame={b}")
            args = ["-i", src, "-vf", f"trim={rng},setpts=PTS-STARTPTS"]
            if has_aud:
                at = f"start={a / fps:.6f}" + ("" if b is None else f":end={b / fps:.6f}")
                args += ["-af", f"atrim={at},asetpts=PTS-STARTPTS"]
            # crf 16, as everywhere an intermediate is about to be read by a
            # model: this is the input to a restore, and an artefact here is
            # detail the restore will sharpen.
            args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16",
                     "-preset", "veryfast"]
            args += (["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]
                     if has_aud else ["-an"])
            media.run_ff(args + [win], f"{label}-window", cancel_check)
            out, vid = f"{dst}.o{i}.mp4", f"{dst}.o{i}.v.mp4"
            made += [out, vid]    # tracked before the run, so a failure cleans up
            try:
                run(win, out, f"w{i}")
                # THE WINDOW'S OWN AUDIO IS STRIPPED BEFORE THE JOIN, and this
                # is not tidiness. The concat demuxer offsets each segment by
                # the PREVIOUS file's container duration, and an encoder leaves
                # a video+audio mp4 a few ms longer than its picture — so three
                # windows joined with their audio on gave a 12.500s clip a
                # 12.529s container, and the body render's `fps=` filter then
                # duplicated a frame to fill the gap. Measured end to end
                # against real ffmpeg: 300 frames in, 301 out, i.e. the cut
                # walks by a frame per chunked clip. `-c:v copy`, so it costs a
                # remux and no generation, and the track is re-muxed whole
                # below anyway.
                media.run_ff(["-i", out, "-c:v", "copy", "-an", vid],
                             f"{label}-strip", cancel_check)
                joins.append(vid)
            finally:
                _rm(win)   # the window is spent as soon as the pass has read it
        with open(listf, "w") as f:
            for o in joins:
                f.write(f"file '{o}'\n")
        video = joined if has_aud else dst
        media.run_ff(["-f", "concat", "-safe", "0", "-i", listf,
                      "-c:v", "copy", "-an", "-movflags", "+faststart", video],
                     f"{label}-join", cancel_check)
        if has_aud:
            media.replace_audio(joined, src, dst, cancel_check=cancel_check)
        return dst
    finally:
        for p in made + [listf, joined]:
            _rm(p)


def _stage_for_comfy(local, prefix, jid):
    """Copy a source into ComfyUI's input dir; return the name to reference.

    The job id in the name is not decoration — it is what lets
    `staging.sweep_job` collect this file at the end of the job whether or not
    the pass below remembered its own `finally`. Keep it in any new stager.
    """
    import shutil
    name = f"{prefix}_{jid}{os.path.splitext(local)[1] or '.mp4'}"
    shutil.copy(local, os.path.join(staging.input_dir(), name))
    return name


def _unstage(name):
    """Drop a staged input once the graph has read it.

    ComfyUI's `input/` is on the pod's ROOT volume, which is the small one, and
    a staged clip is 3-10 MB. `worker.run_job` sweeps the whole job at the end
    either way, so this is about the PEAK rather than the total: `apply_upscale`
    and `apply_ltx_refine` stage once per WINDOW, so a long clip would otherwise
    hold several copies of itself at once. The graph has finished and its output
    has been fetched by the time this runs, so the file is dead.
    """
    staging.unstage(name)


def _run_graph(job, graph, timeout=3600):
    """Submit a BUILT graph (worker/graphs.py) and wait. The sibling of
    _run_workflow_file for passes whose wiring is conditional — an optional
    reference image, an optional latent upsample — which string substitution
    over a static file cannot express."""
    from handlers.common import make_tick
    pid = comfy.submit(graph)
    sb.job_patch(job["id"], {"comfy_prompt_id": pid})
    return comfy.wait(pid, on_tick=make_tick(job), timeout=timeout)


def _comfy_out(job, outputs, dst, cap_h=None):
    """Fetch the graph's video output and normalise it for the next hop.

    `cap_h` is the frame the render is heading for — see
    `media.transcode_chain`, which capped every intermediate at 1080 tall and
    so made the whole chain unable to deliver above 1080p. It is threaded
    explicitly through every applier rather than stashed on `job`: a
    cross-cutting value hidden in the job dict is one a new pass forgets to
    read, and the symptom is a silently smaller picture."""
    raw = dst + ".raw.mp4"
    comfy.fetch_output(outputs, list(outputs.keys()), raw)
    kw = {} if cap_h is None else {"cap_h": cap_h}
    media.transcode_chain(raw, dst, **kw)
    _rm(raw)
    return dst


def _image_model():
    """The studio's image model entry — what FaceDetailer re-samples through.

    NAMES THE ENTRY WHEN IT IS ABSENT, because on the DESKTOP it is: the
    generated map drops `krea2` ("the engine window cannot download
    Qwen3VL4B/qwen3vl-4b-abliterated_bf16.safetensors"), so this pass genuinely
    cannot run on a local render. A bare KeyError there is a traceback naming a
    dictionary key, arriving after every earlier pass in the chain has already
    spent its GPU time. `resolve.py` states every other missing-model refusal
    this way for the same reason.
    """
    import resolve as R
    mm = R.load_map()
    try:
        return mm[R.TIER]["image_models"]["krea2"]
    except KeyError:
        raise RuntimeError(
            f"the face detailer re-samples through krea2, and tier {R.TIER!r} "
            "has no such image model — on the desktop that pass is not "
            "available, so render this cut on the studio's cloud or turn "
            "Face Detailer off") from None


def seedvr2_model(key):
    """A SeedVR2 model KEY -> the filename on the box.

    Keys, not filenames, for `style_loras`' reason: a settings row holding a
    filename is a render that dies inside ComfyUI on an enum once the box is
    re-fetched. A value that already looks like a weights file is passed
    through, the same escape hatch `resolve.lora_stack` keeps for something
    dropped on the pod by hand.

    An unknown key RAISES rather than falling back to 3B. Every other silent
    substitution in this file is one somebody has had to diagnose from the
    picture — and "the 7B pass looks exactly like the 3B pass" is the worst
    possible symptom, because the render succeeded.
    """
    import graphs
    if not key:
        return graphs.SEEDVR2_MODELS[graphs.SEEDVR2_DEFAULT]
    if str(key).endswith(".safetensors"):
        return str(key)
    try:
        return graphs.SEEDVR2_MODELS[str(key)]
    except KeyError:
        raise RuntimeError(
            f"unknown SeedVR2 model {key!r} — have "
            f"{', '.join(sorted(graphs.SEEDVR2_MODELS))}") from None


#: Whether the tracker splits at hard cuts, and `none` is MEASURED rather than
#: inherited — it is also the pack's own default, and the obvious argument for
#: changing it is wrong on the evidence.
#:
#: The argument: a timeline clip is not reliably one shot (every `spliced` take
#: the assembly screen publishes is several), and with `none` the pack says
#: continuity "runs straight through a real cut onto whichever face is nearest
#: the last position, which may be anyone". So splitting looks free — it even
#: costs no second decode.
#:
#: MEASURED on Rei EP03 b11 (2026-09-05, 288 frames, same seed, cuts the only
#: variable), and it moved BOTH axes the wrong way:
#:   face Δ/frame   0.980x source -> 1.014x   (steadier than the footage -> less)
#:   large faces    0.0110 -> 0.0206          (vs a 0.0062 re-encode floor)
#: i.e. it roughly DOUBLED the disturbance to the close-ups the per-frame
#: denoise ramp exists to leave alone, and the blue hair streak — this
#: character's identity marker — visibly thins on them.
#:
#: The cause is in the tracker's own warning: 10 cuts -> 11 shots, and
#: smoothing runs PER SHOT, so a shot shorter than the 21/51-frame smoothing
#: windows gets less smoothing than the rest and the crop shivers. Smoothed
#: box jitter went 3.31 -> 4.87 px/frame.
#:
#: AND IT IS NOT A THRESHOLD ARTIFACT, which is the tuning the pack points at.
#: Sweeping AdaptiveDetector over the same frames (seconds, no render):
#: 3.0 -> 10 cuts, 4.0 -> 4, 5.0 -> 3, 6.0 and 8.0 -> 2 — and the SHORTEST SHOT
#: is 13 frames at every one of them, because the cuts at frame 67 and 80 are
#: genuinely 13 apart. Raising the threshold stops the over-splitting and
#: cannot stop the shivering. Sweep before rendering an arm; the detector is
#: cheap and the render is ten minutes.
#:
#: Kept as a parameter (`payload.cuts`, or `H3_FACE_CUTS` in
#: /etc/neon-worker.env) rather than a project setting: the case it was written
#: for — a clip of a FEW LONG shots — is real and simply is not this clip, and
#: a UI control for a setting measured harmful with no measured win is rope.
H3_FACE_CUTS_DEFAULT = os.environ.get("H3_FACE_CUTS") or "none"


def h3_face_canvas(key):
    """A canvas KEY -> the pixel size the H3 face pass generates at, or None
    for the pack's own auto sizing (from the largest crop, capped at 768).

    Keys rather than a number, `seedvr2_model`'s rule: cost here scales with
    AREA — 768 is 2.25x the latent tokens of 512 — so this is the setting most
    able to turn a hero-shot pass into an unrenderable one, and an unknown
    value RAISES instead of picking a size nobody asked for.
    """
    import graphs
    if key in (None, ""):
        # NOT `auto`. A caller that names nothing gets the SHIPPED DEFAULT, the
        # same value `POST_OPTS` sends — measured 2026-09-05 as the best of the
        # four. Reading an absent argument as `auto` instead put a direct call
        # (and `handle_post_h3_facefix` with no `canvas` in its payload) on the
        # arm that came back SOFTEST, while the post chain got 768: two callers
        # of one function rendering differently, with nothing saying so. Found
        # by running it, not by review.
        key = graphs.H3_FACE_CANVAS_DEFAULT
    if key == "auto":
        return None
    try:
        return graphs.H3_FACE_CANVASES[str(key)]
    except KeyError:
        raise RuntimeError(
            f"unknown H3 face canvas {key!r} — have "
            f"{', '.join(sorted(graphs.H3_FACE_CANVASES))}") from None


def apply_upscale(job, src, dst, *, scale=2, seed=0, color_correction="lab",
                  model=None, steps=None, cfg=None, denoise=None, cap_h=None):
    """SeedVR2 restore.

    `model` is a key from `graphs.SEEDVR2_MODELS` — 3B by default, 7B where it
    has been fetched. The 7B is the same architecture, the same one-step
    recipe and the same VAE, so it changes nothing here but the file: it is
    ~8.3GB against 3.5 and correspondingly slower, and whether it is BETTER on
    this studio's footage is unmeasured. Pick it per project, A/B one shot.

    CORE NODES — this pass spent its life gated on `_require_nodes("SeedVR2")`,
    the node id of numz's ComfyUI-SeedVR2_VideoUpscaler, a pack this pod has
    never had. SeedVR2 landed in ComfyUI CORE at v0.28.0 (PR #14424) under
    entirely different node ids, so the gate could never pass and the toggle
    was labelled "pack is not installed" while the capability was sitting
    there. What was genuinely missing was the WEIGHTS —
    the engine window's model list seedvr2.
    """
    _require_nodes("SeedVR2Preprocess", "SeedVR2Conditioning", "SeedVR2PostProcessing")
    import graphs
    kw = {k: v for k, v in
          dict(steps=steps, cfg=cfg, denoise=denoise).items()
          if v is not None}
    kw["model"] = seedvr2_model(model)

    def one(inp, outp, tag):
        name = _stage_for_comfy(inp, "qamba_up", job["id"] + tag)
        try:
            outputs = _run_graph(job, graphs.seedvr2_graph(
                name, scale=float(scale), seed=int(seed),
                color_correction=color_correction, **kw))
            return _comfy_out(job, outputs, outp, cap_h)
        finally:
            _unstage(name)

    # The pass renders at scale x the source frame, and that product is what
    # has to fit — the enlarge is a plain lanczos resize done INSIDE the graph,
    # so the tensor SeedVR2 works on is already the big one.
    info = media.probe(src) or {}
    px = int((info.get("width") or 1280) * float(scale)) \
        * int((info.get("height") or 720) * float(scale))
    return _windowed(job, src, dst, one, out_px_per_frame=px, label="upscale")


def apply_interpolate(job, src, dst, *, multiplier=2, src_fps=24, model=None,
                      cap_h=None):
    """Frame interpolation. CORE nodes too — same story as the upscale above:
    the gate named ComfyUI-Frame-Interpolation's `RIFE VFI`, which is not
    installed here and has not been needed since core absorbed the feature as
    comfy_extras/nodes_frame_interpolation.py. This pass advertised itself as
    AVAILABLE (postChain.ts set no `unavailable` on it), so unlike the other
    two it did not warn — it just failed at render time."""
    _require_nodes("FrameInterpolationModelLoader", "FrameInterpolate")
    import graphs
    name = _stage_for_comfy(src, "qamba_interp", job["id"])
    kw = {"model": model} if model else {}
    try:
        outputs = _run_graph(job, graphs.frame_interp_graph(
            name, multiplier=int(multiplier),
            fps=float(src_fps or 24) * int(multiplier), **kw))
        return _comfy_out(job, outputs, dst, cap_h)
    finally:
        _unstage(name)


def apply_facefix(job, src, dst, *, seed=0, denoise=0.4, prompt="",
                  detector="bbox/face_yolov8m.pt", steps=None, cfg=None,
                  cap_h=None):
    """FaceDetailer per-frame. The ONE post pass that genuinely needed a new
    pack (ComfyUI-Impact-Pack + Impact-Subpack for the detector), installed
    with torch/torchvision/numpy pinned to the venv's CUDA builds — see
    the engine window's node-pack install for why that pin is load-bearing.

    Expensive: one diffusion pass per detected face per frame."""
    _require_nodes("FaceDetailer", "UltralyticsDetectorProvider")
    from handlers.images import _node_spec
    import graphs
    name = _stage_for_comfy(src, "qamba_face", job["id"])
    try:
        outputs = _run_graph(job, graphs.facefix_graph(
            _image_model(), name, seed=int(seed), detector=detector,
            denoise=float(denoise), steps=steps, cfg=cfg, prompt=prompt,
            node_spec=_node_spec("FaceDetailer")))
        return _comfy_out(job, outputs, dst, cap_h)
    finally:
        _unstage(name)


def apply_h3_facefix(job, src, dst, *, seed=0, denoise=None, canvas=None,
                     crop_factor=3.0, steps=None, cuts=None,
                     detector="bbox/face_yolov8m.pt", cap_h=None):
    """Face refine through H3 itself — the temporally coherent face pass.

    `apply_facefix` above inpaints every frame INDEPENDENTLY through an image
    model. This tracks the face, crops it so the head fills a canvas, and
    re-samples the whole crop sequence in ONE H3 pass, then composites it
    back. They are alternatives, never a stack: two passes re-deciding the
    same pixels is a face rewritten twice, and `post_chain.chain_conflict`
    refuses the pair before a render starts.

    THE PACK FAILS OPEN WITHOUT INSIGHTFACE, which is the one thing to know
    before trusting a result. Its own README says identity matching "won't
    error if InsightFace is missing but the outputs will be much better with
    it installed" — so a pod that never fetched `buffalo_l` renders this
    perfectly happily and tracks the wrong face whenever two people are in
    shot. `bash the engine window's model list insightface` is the fix; nothing here can
    detect the difference, which is exactly why it is written down.

    WINDOWED ON H3's OWN CEILING rather than the restore's pixel budget. At a
    768 canvas the 420M px-frame budget would allow ~712 frames and H3's
    legal maximum is 365 (`h3_timing.MAX_FRAMES`), so the frame count is what
    binds and a longer clip is split. A split RESTARTS THE TRACK, so the
    smoothed trajectory has a discontinuity at the seam — the one place this
    pass is worse than an unsplit one, and it only reaches clips over ~15s.
    """
    import graphs
    import h3_timing
    import resolve as R
    from handlers.images import _node_spec

    # ARGUMENTS FIRST, before the model map is read or the file is probed: a
    # bad one is the caller's mistake and should cost nothing to find out
    # about. Same order `render_clip_with_post` puts its conflict check in.
    cuts = H3_FACE_CUTS_DEFAULT if cuts is None else cuts
    if cuts not in graphs.H3_FACE_CUT_MODES:
        raise RuntimeError(
            f"unknown cut detection {cuts!r} — have "
            f"{', '.join(sorted(graphs.H3_FACE_CUT_MODES))}")

    h3 = R.load_map()[R.TIER]["models"]["minimax-h3"]
    audio = media.has_audio(src)
    need = ["H3FaceTrackCrop", "H3InjectVideoLatent", "H3PerFrameDenoise",
            "H3FaceStitch", "MiniMaxH3ReferenceToVideo"]
    if audio:
        need.append("VRGDG_MiniMaxH3AudioDrive")
    _require_nodes(*need)

    size = h3_face_canvas(canvas)
    px = int(size or 768) ** 2
    log(f"h3_facefix: canvas {size or 'auto (<=768)'}, cuts {cuts}, denoise "
        f"{float(denoise if denoise is not None else graphs.H3_FACE_DENOISE):g}, "
        f"{'lip-synced to the clip' if audio else 'silent clip — no audio lock'}")

    def one(inp, outp, tag):
        name = _stage_for_comfy(inp, "qamba_h3face", job["id"] + tag)
        try:
            kw = {} if denoise is None else {"denoise": float(denoise)}
            if steps:
                kw["steps"] = int(steps)
            outputs = _run_graph(job, graphs.h3_facefix_graph(
                h3, name, seed=int(seed), canvas=size,
                crop_factor=float(crop_factor), detector=detector,
                cut_detection=cuts,
                has_audio=media.has_audio(inp),
                track_spec=_node_spec("H3FaceTrackCrop"),
                stitch_spec=_node_spec("H3FaceStitch"),
                denoise_spec=_node_spec("H3PerFrameDenoise"),
                ref_spec=_node_spec("MiniMaxH3ReferenceToVideo"), **kw))
            return _comfy_out(job, outputs, outp, cap_h)
        finally:
            _unstage(name)

    return _windowed(job, src, dst, one, out_px_per_frame=px,
                     budget=h3_timing.MAX_FRAMES * px, label="h3_facefix")


#: The one grade that is not a ColorMatch node. Its own constant so the two
#: dispatch points and the tests cannot spell it differently.
VCG_METHOD = "vcg"


def _require_vcg():
    """The learned-LUT grade's pack AND its weights, checked before staging.

    The NODES are one question and the CHECKPOINT is another: with the pack
    installed and the engine window's model list vcg never run, `VCGLoadModel`'s combo
    simply does not contain the file, and ComfyUI rejects the prompt with
    `value_not_in_list` — after the clip and the reference are already staged
    and several seconds into the job. Asking the node's own list here is the
    same discipline `_color_match_node` uses for a method.
    """
    import graphs
    _require_nodes(*graphs.VCG_NODES)
    have = _combo_values("VCGLoadModel", "model_name")
    if have and graphs.VCG_CHECKPOINT not in have:
        raise RuntimeError(
            f"the VCG grade needs {graphs.VCG_CHECKPOINT} in ComfyUI's "
            f"checkpoints/ — run `bash the engine window's model list vcg` on the pod (4.1GB)")


def _color_match_node(method):
    """Which ColorMatch class this grade renders on -> node id.

    NEWEST FIRST. `ColorMatch` carries `DEPRECATED = True` upstream and
    `ColorMatchV2` is the same six algorithms on the V3 schema plus
    `reinhard_lab_gpu`; the input NAMES are identical, so preferring V2 is a
    class-name change and nothing else. v1 remains the fallback because a pod
    that has not pulled KJNodes lately has only that one, and this pass
    predates V2 — the grade must not start failing on a box where it worked.

    A METHOD THE INSTALLED NODE DOES NOT OFFER RAISES. Falling back to mkl
    would be the silent downgrade this file keeps naming: the render succeeds,
    the clip is graded by a different transfer than the one the project asked
    for, and nothing anywhere says so — and it would be worse than the usual
    case, because a whole cut grades consistently by construction, so the
    substitution is invisible in the one place you would look for it.

    The check is against the node's OWN combo list rather than a constant,
    because `reinhard_lab_gpu` arrived in a KJNodes release: a pod can have
    ColorMatchV2 and not have that method, and the alternative is a
    `value_not_in_list` rejection after the clip is already staged.
    """
    import graphs
    if method == VCG_METHOD:
        # Not a ColorMatch method at all — it is its own node set and its own
        # graph. Refused by name here so a caller that routed wrongly gets a
        # sentence rather than "ColorMatchV2-only", which would send the reader
        # looking for a KJNodes update that would not help.
        raise RuntimeError(
            f"{VCG_METHOD!r} is not a ColorMatch method — it is the learned "
            f"LUT grade; apply_color_match dispatches it separately")
    if method not in graphs.COLOR_MATCH_METHODS:
        raise RuntimeError(
            f"color_match method {method!r} is not one this studio builds — "
            f"expected one of {', '.join(graphs.COLOR_MATCH_METHODS)}")
    info = comfy.object_info()
    for node in graphs.COLOR_MATCH_NODES:
        if node not in info:
            continue
        legal = _combo_values(node, "method")
        # Empty is "could not read the schema", not "offers nothing" — every
        # method but the new one has been on this node since before it was
        # published, so refusing on an unreadable list would break the grade
        # over a manifest quirk.
        if legal and method not in legal:
            continue
        return node
    if not any(n in info for n in graphs.COLOR_MATCH_NODES):
        raise RuntimeError(
            f"ComfyUI is missing {' and '.join(graphs.COLOR_MATCH_NODES)} — "
            f"install KJNodes on the pod (see the engine window's node-pack install) "
            f"and retry")
    offered = sorted({m for n in graphs.COLOR_MATCH_NODES if n in info
                      for m in _combo_values(n, "method")})
    raise RuntimeError(
        f"color_match method {method!r} needs a node this pod does not have: "
        f"it is ColorMatchV2-only and the installed nodes offer "
        f"{', '.join(offered) or 'nothing readable'}. Update KJNodes on the "
        f"pod, or pick another method.")


def apply_color_match(job, src, dst, *, match_asset_id=None, reference=None,
                      method="mkl", strength=1.0, ref_at_ms=None, cap_h=None):
    """Match this clip's grade to a reference.

    KJNodes' `ColorMatch`, which has been installed on this pod all along —
    the pass was labelled as waiting for VRGDG's ColorMatchToReference and
    never needed it. `ColorMatchV2` supersedes it where the pod has one; see
    `_color_match_node`, which also decides whether `method` can be served.

    The reference is ONE FRAME, because these are global colour-transfer
    algorithms: they fit this clip's distribution to the reference's, and one
    representative frame IS that distribution. `reference` is a local file
    (the caller already has it — a timeline render hands over its reference
    clip); `match_asset_id` fetches one from the registry.

    It RAISES with no reference rather than copying the file through. A pass
    that silently does nothing is the exact failure the standalone job had —
    it wrote "skipped" into an asset's meta nobody reads and reported success.
    """
    import graphs
    # Both engines check what they need BEFORE anything is fetched or staged:
    # a grade that fails after the reference has been pulled has spent the
    # download and left a staged file for the sweep.
    if method == VCG_METHOD:
        _require_vcg()
        node = None
    else:
        node = _color_match_node(method)
    tmp = None
    name = ref_name = None
    try:
        if reference is None:
            if not match_asset_id:
                raise RuntimeError(
                    "color_match needs a reference — pass params "
                    "{'color_match': {'match_asset_id': '<asset>'}} or give the "
                    "render a reference clip")
            row = sb.get(f"assets?id=eq.{match_asset_id}&select=b2_key,kind")[0]
            tmp = f"/tmp/{job['id']}_cmref{os.path.splitext(row['b2_key'])[1] or '.mp4'}"
            media.b2_get(row["b2_key"], tmp)
            reference = tmp
        # A still is its own reference frame; a video is sampled at its middle
        # (or `ref_at_ms`), because frame 0 of a shot is routinely a fade.
        if os.path.splitext(reference)[1].lower() in (".png", ".jpg", ".jpeg", ".webp"):
            ref_png = reference
        else:
            ref_png = f"/tmp/{job['id']}_cmref.png"
            at = ref_at_ms
            if at is None:
                dur = (media.probe(reference) or {}).get("duration_ms") or 0
                at = int(dur // 2)
            media.extract_frame(reference, ref_png, at_ms=at)
            tmp = tmp or ref_png
        # Both through the one stager, so both are on the one cleanup below.
        ref_name = _stage_for_comfy(ref_png, "qamba_cmref", job["id"])
        name = _stage_for_comfy(src, "qamba_cm", job["id"])
        if method == VCG_METHOD:
            log(f"color_match: VCG learned LUT @ {float(strength):.2f}")
            graph = graphs.vcg_grade_graph(name, ref_name,
                                           strength=float(strength))
        else:
            log(f"color_match: {node} · {method} @ {float(strength):.2f}")
            graph = graphs.color_match_graph(name, ref_name, method=method,
                                             strength=float(strength), node=node)
        outputs = _run_graph(job, graph)
        return _comfy_out(job, outputs, dst, cap_h)
    finally:
        _rm(tmp)
        _unstage(name)
        _unstage(ref_name)


#: A `fit` refine never enlarges past this, for `apply_upscale`'s reason: the
#: pass RESTORES detail at a size, it does not invent a picture four times
#: bigger than the one it was given, and LTX's own learned upsampler tops out
#: at 2x so there is no recipe above it either.
REFINE_MAX_SCALE = 2.0
#: Below this much enlarge there is nothing to gain from a resample, so `fit`
#: falls back to refining at native size and the ImageScale node is not built
#: at all. 1.02 is the 704 -> 720 case, which is every H3 take on a 720p
#: timeline: a 2% stretch through lanczos costs a generation and buys nothing.
REFINE_MIN_SCALE = 1.06


def refine_target(src_w, src_h, frame_w, frame_h, *, step=32, cap_h=1080):
    """The frame a `fit` refine samples at -> (w, h), or None for "native".

    THE POINT OF THE MODE. A refine at 2x lands at 2560x1408 for a 1280x704
    take, `transcode_chain` immediately caps every chain intermediate at 1080
    tall, and the body render then fits to the timeline — so the extra pixels
    were resampled away twice before anything read them. Sampling AT the frame
    the cut delivers is the same generation cost spent where it survives.
    This is the arithmetic twin of the fit-scale `render_clip_with_post`
    already computes for the SeedVR2 restore; they are the same decision.

    Aspect comes from the SOURCE and not from the timeline: the body render
    letterboxes into the timeline's frame, so matching the timeline's shape
    here would distort the picture and then pad the distortion.

    UNIFORM SCALE, AND THEN THE GRID PAIR CLOSEST TO THE SOURCE'S SHAPE —
    never a per-axis fit, which squashes a differently-shaped source
    (`resolve.cap_dims_to_source`'s rule). Flooring EACH axis onto the grid is
    the same mistake one step in and it is not academic: a 640x360 take fitted
    to a 1080-wide frame floors to 1056x576, which is 1.83 against 16:9's 1.78
    — a 3% horizontal stretch, baked in by `ImageScale` (crop disabled scales
    to exactly w x h) and then carried through the body render, whose own fit
    reads the STRETCHED frame's aspect. Caught by a test, not by review.
    So the nine grid pairs within a step of the ideal are scored on aspect and
    the closest wins, ties going to whichever is nearest the ideal AREA. A step
    either side of the box is accepted where it buys shape: those pixels cost
    one resample on the way out, where a stretch cannot be undone at all.
    Measured over ten real take/timeline pairings, worst-case aspect error:
    5.47% flooring each axis, 3.13% over the four pairs above the ideal, 0.74%
    over the nine. Widening further buys nothing and starts drifting past the
    2x cap.
    """
    src_w, src_h = int(src_w or 0), int(src_h or 0)
    if src_w <= 0 or src_h <= 0:
        return None                       # unknown source: never invent a size
    box_w, box_h = int(frame_w or 0), min(int(cap_h), int(frame_h or 0))
    if box_w <= 0 or box_h <= 0:
        return None
    scale = min(box_w / src_w, box_h / src_h, REFINE_MAX_SCALE)
    if scale < REFINE_MIN_SCALE:
        return None
    aspect = src_w / src_h
    ideal_w, ideal_h = src_w * scale, src_h * scale

    def grid(v):
        lo = int(v) // step * step
        return {max(step, lo + i * step) for i in (-1, 0, 1)}

    best = None
    for w in grid(ideal_w):
        for h in grid(ideal_h):
            # Never a DOWNSCALE. The whole mode exists to sample at a bigger
            # frame; a candidate under the source throws detail away before the
            # model sees it, which is worse than not resizing at all.
            if w < src_w or h < src_h:
                continue
            key = (round(abs(w / h - aspect) / aspect, 4),
                   abs(w * h - ideal_w * ideal_h))
            if best is None or key < best[0]:
                best = (key, (w, h))
    return best[1] if best else None


def apply_ltx_refine(job, src, dst, *, seed=0, upscale=False, target=None,
                     fit_frame=None, sigmas=None, video_cfg=None, prompt="",
                     negative="", src_fps=24, cap_h=None):
    """LTX 2.5 as a video-to-video refiner.

    A GENERATIVE pass, unlike `apply_upscale` — it runs the footage back
    through a 22B diffusion model, so it re-decides detail and moves the look.
    It costs no installs at all: every node and every weight, the x2 latent
    upsampler included, is already on this pod because LTX 2.5's ordinary
    render is already a two-pass upsample-and-refine.

    Two things this owns that the graph cannot:

    THE FRAME GRID. LTX is 8n+1 (`frame_base`/`frame_rem` on the entry). What
    is sampled is padded UP to the grid by holding its last frame and the
    padding is cut off the result, so the pass cannot change how long a clip
    is — which would desynchronise it from the timeline that scheduled it.
    That happens per WINDOW rather than per clip, and it has to: the grid is a
    property of what the sampler is handed, so a clip padded whole and then
    split leaves every window but the last off the grid, and the trim back
    would cut each window to the whole clip's length.

    THE AUDIO TRACK MUST EXIST. LTX samples a concatenated audio+video latent,
    so LTXVAudioVAEEncode needs something to encode; a silent window gets a
    silent track added first. The refined audio is then discarded and the
    source's own is what lands (see the graph builder, and `_windowed`).

    WHY THE REAL AUDIO AND NOT AN EMPTY LATENT. iiTzMYUNG's workflow (civitai
    2910804) feeds `LTXVEmptyLatentAudio` here instead — a silent placeholder
    "just to give the joint AV sampler the shape it expects" — which would
    save the pad above. It is not taken: the sampler denoises the PACKED
    latent and a joint AV model attends across both halves, so an empty audio
    half is a conditioning signal that disagrees with the picture, at a sigma
    range chosen on the assumption that everything in the latent is already
    nearly right. Encoding the take's own soundtrack costs one VAE pass and
    tells the truth. Both discard the refined audio; only the conditioning
    differs, and neither has been A/B'd.

    `video_cfg` ABOVE 1.0 ROUGHLY DOUBLES THE COST PER STEP, and the reason is
    worth knowing before reaching for it. `Guider_LTXAVDualCFG` collapses to
    single-CFG while the two scales are equal, and at 1.0 ComfyUI skips the
    uncond pass entirely — which is why the LTX rows declare no negative
    prompt. Raising this one alone makes the scales DISAGREE: a real uncond
    pass runs, the negative prompt starts doing something, and the sampler
    holds harder to what it was given. The workflow's author runs 1.5 for
    exactly that, and warns that past a point more cfg buys contrast and
    artifacts rather than detail. Unmeasured here.
    """
    import resolve as R
    import graphs
    lx = R.load_map()[R.TIER]["models"]["ltx-25"]

    info = media.probe(src) or {}
    fps = float(info.get("fps") or src_fps or 24)
    base = int(lx.get("frame_base", 8))
    rem = int(lx.get("frame_rem", 1))

    # THE OUTPUT FRAME IS DECIDED ONCE, here, because three separate things
    # read it: which nodes have to exist, whether the decode tiles, and the
    # VRAM budget `_windowed` splits against. Deriving it three times is how
    # two of them end up disagreeing on a render that has already started.
    if upscale and target:
        raise RuntimeError("ltx_refine: upscale and target are alternatives, "
                           "not a stack — pick one")
    src_w = int(info.get("width") or 1280)
    src_h = int(info.get("height") or 720)

    # THE `fit` TARGET IS RESOLVED HERE, because this is where the model's own
    # grid is. `refine_target` cannot know it — its caller in the render is a
    # timeline, not a model_map entry — and defaulting it was measured wrong:
    # LTX 2.5's `dim_step` is 64, the default is 32, so a 1280x704 take fitted
    # to 1080p came out 1920x1056, the GRAPH's defensive snap rounded it to
    # 1920x1024, and the delivered frame was a 3.1% vertical squash. Exactly
    # the stretch `refine_target`'s own aspect search exists to prevent,
    # reintroduced one layer down because two functions disagreed about the
    # grid. Found by rendering it, not by review — the log line even printed
    # the pre-snap number, so the journal agreed with the wrong answer.
    step = int(lx.get("dim_step") or 32)
    if fit_frame and target is None and not upscale:
        target = refine_target(src_w, src_h, fit_frame[0], fit_frame[1], step=step)

    out_w, out_h = ((int(target[0]), int(target[1])) if target else
                    (src_w * 2, src_h * 2) if upscale else (src_w, src_h))
    tile = out_w * out_h >= graphs.LTX_REFINE_TILE_PX

    need = ["LTXVConcatAVLatent", "LTXVAudioVAEEncode"]
    need += ["LTXVLatentUpsampler"] if upscale else []
    need += ["ImageScale"] if target else []
    need += ["VAEDecodeTiled"] if tile else []
    _require_nodes(*need)
    if target:
        # The number the graph will use, so the journal and the file agree.
        log(f"ltx_refine: sampling at {out_w}x{out_h} (source {src_w}x{src_h}, "
            f"grid {step})")

    def one(inp, outp, tag):
        got = media.probe(inp) or {}
        frames = int(got.get("frames")
                     or round((got.get("duration_ms") or 0) / 1000.0 * fps))
        # Round UP to the grid, never down: trimming real frames off the pass
        # would lose content, where padding is thrown away afterwards.
        need = frames
        if frames > rem and (frames - rem) % base:
            need = rem + ((frames - rem) // base + 1) * base
        pad = need - frames
        staged, tmps, name = inp, [], None
        try:
            if pad > 0 or not media.has_audio(inp):
                padded = outp + ".ltxin.mp4"
                args = ["-i", inp]
                if not media.has_audio(inp):
                    args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                             "-shortest"]
                if pad > 0:
                    args += ["-vf",
                             f"tpad=stop_mode=clone:stop_duration={pad / fps:.6f}"]
                args += ["-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
                         "-pix_fmt", "yuv420p", "-c:a", "aac"]
                media.run_ff(args + [padded], "ltx_refine pad")
                tmps.append(padded)
                staged = padded

            name = _stage_for_comfy(staged, "qamba_ltxref", job["id"] + tag)
            kw = {} if video_cfg is None else {"video_cfg": float(video_cfg)}
            outputs = _run_graph(job, graphs.ltx_refine_graph(
                lx, name, seed=int(seed), upscale=bool(upscale), target=target,
                sigmas=sigmas, tile=tile,
                prompt=prompt, negative=negative, fps=fps, **kw))
            if pad <= 0:
                return _comfy_out(job, outputs, outp, cap_h)
            body = outp + ".ltxout.mp4"
            _comfy_out(job, outputs, body, cap_h)
            tmps.append(body)
            media.run_ff(["-i", body, "-frames:v", str(frames),
                          "-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
                          "-c:a", "copy", outp], "ltx_refine trim")
            return outp
        finally:
            for t in tmps:
                _rm(t)
            if name:
                _unstage(name)

    # Same budget as the restore, and deliberately not a second number. LTX's
    # profile is nothing like SeedVR2's — a 22B DiT over a compressed latent
    # rather than a 3B one over the pixels — but it is at least as hungry per
    # frame, so a cap measured on the restore is conservative here rather than
    # generous. The budget is against the OUTPUT frame, so a `fit` refine that
    # lands under 2x is legitimately cheaper than the fixed upsample and gets
    # correspondingly longer windows.
    return _windowed(job, src, dst, one, out_px_per_frame=out_w * out_h,
                     label="ltx_refine")


def apply_grain(job, src, dst, *, strength=8):
    """De-AI texture via ffmpeg's temporal noise — no models, works on any pod."""
    vf = f"noise=alls={float(strength):g}:allf=t+u,format=yuv420p"
    args = ["-i", src, "-vf", vf,
            "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
            "-movflags", "+faststart"]
    args += (["-c:a", "copy"] if media.has_audio(src) else ["-an"])
    cancel = (lambda: sb.cancel_requested(job["id"])) if job else None
    media.run_ff(args + [dst], "grain", cancel_check=cancel)
    return dst


#: op id -> applier. post_chain.py owns the order and the staging; this owns
#: what each one actually does.
APPLIERS = {
    "upscale": apply_upscale,
    "ltx_refine": apply_ltx_refine,
    "interpolate": apply_interpolate,
    "facefix": apply_facefix,
    "h3_facefix": apply_h3_facefix,
    "color_match": apply_color_match,
    "grain": apply_grain,
}


def apply_chain(job, src, dst, ops, *, src_fps=24, params=None, tag="post",
                cap_h=None):
    """Run `ops` in order, src -> dst, through one temp file per hop.

    Returns dst when anything ran and src when the op list was empty, so a
    caller can hand the result straight on without branching. A failing pass
    RAISES: the user asked for it, and a master that quietly came back without
    the upscale it was rendered for is worse than an error naming the pack that
    is missing.
    """
    if not ops:
        return src
    params = params or {}
    cur, made = src, []
    try:
        for i, op in enumerate(ops):
            out = dst if i == len(ops) - 1 else f"{dst}.{tag}{i}.mp4"
            kwargs = dict(params.get(op) or {})
            if op == "interpolate":
                kwargs.setdefault("src_fps", src_fps)
            # Only the ComfyUI passes: `grain` is ffmpeg-only, writes no chain
            # intermediate and takes no such argument, so injecting it there is
            # a TypeError at render time. `GPU_OPS` is exactly "drives
            # ComfyUI", which is exactly the set that goes through _comfy_out.
            if cap_h and op in post_chain.GPU_OPS:
                kwargs.setdefault("cap_h", cap_h)
            log(f"post chain: {op}")
            made.append(out)
            APPLIERS[op](job, cur, out, **kwargs)
            if cur is not src:
                _rm(cur)     # the hop before this one is spent
            cur = out
        return dst
    except Exception:
        for p in made:
            _rm(p)           # never leave a half-written hop looking like a result
        raise


# ------------------------------------------------------- standalone jobs ----
def _standalone_cap_h(payload):
    """An explicit delivery height for standalone passes, like a timeline's.

    Preserve the existing 1080 default when omitted. An upscale requested by
    an external caller must not silently lose its extra pixels at the next hop.
    """
    value = payload.get("cap_h")
    if value is None:
        return None
    if type(value) is not int or not 320 <= value <= 4320:
        raise ValueError("cap_h must be an integer between 320 and 4320")
    return value


def handle_post_upscale(job):
    payload = job.get("payload") or {}
    cap_h = _standalone_cap_h(payload)
    asset, local = _load_source(job)
    out = f"/tmp/{job['id']}_up.mp4"
    apply_upscale(job, local, out, scale=payload.get("scale", 2),
                  model=payload.get("model"), cap_h=cap_h)
    _finish(job, asset, out, "upscale")
    for p in (local, out):
        _rm(p)


def handle_post_interpolate(job):
    asset, local = _load_source(job)
    mult = (job.get("payload") or {}).get("multiplier", 2)
    out = f"/tmp/{job['id']}_rife.mp4"
    apply_interpolate(job, local, out, multiplier=mult, src_fps=asset.get("fps") or 24)
    _finish(job, asset, out, "interpolate")
    for p in (local, out):
        _rm(p)


def handle_post_facefix(job):
    asset, local = _load_source(job)
    payload = job.get("payload") or {}
    out = f"/tmp/{job['id']}_face.mp4"
    apply_facefix(job, local, out,
                  seed=int(payload.get("seed") or 0),
                  denoise=float(payload.get("denoise") or 0.4),
                  prompt=payload.get("prompt") or "")
    _finish(job, asset, out, "facefix")
    for p in (local, out):
        _rm(p)


def handle_post_h3_facefix(job):
    """The H3 face refine as a standalone job, on one asset.

    `canvas` is a KEY (graphs.H3_FACE_CANVASES), never a pixel count, for
    `seedvr2_model`'s reason one section up: a stored number is a setting the
    browser had no business knowing, and an unknown key RAISES rather than
    quietly rendering at a size nobody chose.
    """
    asset, local = _load_source(job)
    payload = job.get("payload") or {}
    out = f"/tmp/{job['id']}_h3face.mp4"
    apply_h3_facefix(job, local, out,
                     seed=int(payload.get("seed") or 0),
                     denoise=payload.get("denoise"),
                     canvas=payload.get("canvas"),
                     cuts=payload.get("cuts"))
    _finish(job, asset, out, "h3_facefix")
    for p in (local, out):
        _rm(p)


def handle_post_ltx_refine(job):
    """Standalone LTX 2.5 refine of one take — the free-standing twin of the
    `ltx_refine` chain op, same shape as post_upscale."""
    payload = job.get("payload") or {}
    cap_h = _standalone_cap_h(payload)
    asset, local = _load_source(job)
    out = f"/tmp/{job['id']}_ltxref.mp4"
    # `target` arrives as [w, h] over JSON; the graph and the budget both want
    # a pair, and a bare list of the wrong length is a size nobody chose.
    tgt = payload.get("target")
    tgt = (int(tgt[0]), int(tgt[1])) if isinstance(tgt, (list, tuple)) and len(tgt) == 2 else None
    frm = payload.get("fit_frame")
    frm = (int(frm[0]), int(frm[1])) if isinstance(frm, (list, tuple)) and len(frm) == 2 else None
    apply_ltx_refine(job, local, out,
                     seed=int(payload.get("seed") or 0),
                     upscale=bool(payload.get("upscale")),
                     target=tgt, fit_frame=frm,
                     sigmas=payload.get("sigmas"),
                     video_cfg=payload.get("video_cfg"),
                     prompt=payload.get("prompt") or "",
                     negative=payload.get("negative") or "",
                     src_fps=asset.get("fps") or 24, cap_h=cap_h)
    _finish(job, asset, out, "ltx_refine")
    for p in (local, out):
        _rm(p)


def handle_post_grain_color(job):
    """De-AI texture: film grain (+ optional reference color match)."""
    asset, local = _load_source(job)
    payload = job.get("payload") or {}
    out = f"/tmp/{job['id']}_grain.mp4"
    tmps = [local, out]
    # Colour FIRST, grain LAST — the mastering canon's order, and the reason is
    # the same one post_chain.py gives for grain being a `finish` pass: a grade
    # applied over grain re-maps the noise along with the picture.
    if payload.get("match_asset_id"):
        graded = f"/tmp/{job['id']}_cm.mp4"
        apply_color_match(job, local, graded,
                          match_asset_id=payload["match_asset_id"],
                          method=payload.get("match_method") or "mkl",
                          strength=float(payload.get("match_strength") or 1.0))
        tmps.append(graded)
        local = graded
    apply_grain(job, local, out, strength=payload.get("grain") or 8)
    _finish(job, asset, out, "grain_color")
    for p in tmps:
        _rm(p)

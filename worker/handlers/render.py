"""Timeline render pipeline: clip_render (per-clip ops -> cached
intermediate) and tl_render (tracks -> one MP4 with mixed audio).

Per-clip pipeline: source post passes -> trim [in,out] -> ops in stored order ->
normalize to the timeline's fps/size -> finish post passes -> cache at
/data/cache/clips/{op_hash}.mp4. The cache is pod-local and rebuildable; only
final renders go to B2.

Ops (mirror src/lib/db/types.ts ClipOp):
  flip {dir h|v} · transform {rotate,scale,tx,ty} · crop {x,y,w,h} ·
  speed {rate} · reverse · freeze {at_ms,dur_ms}

The post chain (`clips.post`, else the project's default — post_chain.py) is
applied HERE and nowhere else. It used to be five switches in the inspector that
each queued their own GPU job the moment you flipped one, so a look decision
spent pod time immediately and landed as a derived asset the timeline did not
point at. It is stored intent now, cashed in by the render.
"""
import hashlib
import json
import os

import audio_fx
import media
import mix
import post_chain
import render_output as RO
import sb
from status import log

CACHE_DIR = os.environ.get("CLIP_CACHE_DIR", "/data/cache/clips")

#: Every intermediate this module encodes is tagged bt709/limited. The pixels
#: were always limited-range (ComfyUI's SaveVideo compresses full RGB to
#: 16-235, H3's takes arrive the same way) — untagged, every player and every
#: ffmpeg step ASSUMED it, correctly, but an assumption four generations deep
#: is how a range bug hides. Tags make the interpretation explicit end to end,
#: and the final `-c:v copy` carries them into the deliverable.
COLOR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709",
              "-color_trc", "bt709", "-color_range", "tv"]


def resolve(kind):
    return {"clip_render": handle_clip_render, "tl_render": handle_tl_render,
            "frame_extract": handle_frame_extract}[kind]


def handle_frame_extract(job):
    """Grab one frame of a video asset as a library still (kind=frame)."""
    jid = job["id"]
    payload = job.get("payload") or {}
    src = sb.asset_by_id(payload["asset_id"])
    if not src:
        raise ValueError(f"asset {payload.get('asset_id')} not found")
    local = f"/tmp/{jid}_src.mp4"
    media.b2_get(src["b2_key"], local)
    png = f"/tmp/{jid}_frame.png"
    media.extract_frame(local, png, at_ms=int(payload.get("at_ms") or 0))
    stem = os.path.splitext(os.path.basename(src["b2_key"]))[0]
    key = f"frames/grab/{stem}_{int(payload.get('at_ms') or 0)}_{jid[:8]}.png"
    media.b2_put(png, key, content_type="image/png")
    asset = sb.register_asset(key, "frame", project_id=src.get("project_id"),
                              content_type="image/png", source_job_id=jid,
                              meta={"from_asset_id": src["id"],
                                    "at_ms": int(payload.get("at_ms") or 0)},
                              tags=["grab"])
    sb.job_done(jid, output_asset_id=asset["id"])
    for p in (local, png):
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE frame_extract -> {key}")


def op_hash(asset, clip, fps, width, height, chain=None, grade=None,
            fit_ms=None, opts=None):
    payload = {
        "b2": asset["b2_key"], "in": clip.get("in_ms") or 0, "out": clip.get("out_ms"),
        "ops": clip.get("ops") or [], "fps": fps, "w": width, "h": height,
    }
    # Both flags are added only when set, so every intermediate cached before
    # either feature existed keeps its cache entry — a new key for everyone
    # would invalidate the whole clip cache to record a flag almost no clip
    # carries. Hashing the RESOLVED post op list (not the raw column) is what
    # makes a change to the project's default invalidate the clips that
    # inherit it.
    if clip.get("audio_detached"):
        payload["audio_detached"] = True
    ops = post_chain.active_ops(chain)
    if ops:
        payload["post"] = ops
        # PIPELINE VERSION, post-chained clips only. v2 is the 2026-08-25 color
        # and quality repair: crf-12 tagged chain intermediates instead of
        # crf-20 web transcodes, SeedVR2 color correction on, and source-mode
        # color match. Every post-chained clip cached before it carries the
        # washed grade those bugs produced, so invalidating them is the point;
        # plain clips are byte-identical and keep their entries.
        payload["pipe"] = 2
    # Only when the pass that reads it is on, so no plain-clip cache entry is
    # invalidated — and it MUST be in here when it is: the reference decides
    # what the clip is graded to, so changing it (or the mode, or how hard it
    # is applied) changes the picture, and a cache keyed without it would
    # serve the old grade forever.
    if grade and "color_match" in ops:
        payload["grade"] = [grade.get("mode"), grade.get("asset_id"),
                            grade.get("strength")]
    # HOW a pass is tuned, on the same terms as the grade reference: only when
    # its own op is on, and only when it is not the default. Changing the
    # refine's size or schedule changes the picture, so a cache keyed without
    # it serves the old settings forever — and keying every clip on values
    # nearly all of them leave alone would re-render whole timelines to record
    # a default nobody set.
    for op, keys in (("ltx_refine", ("refine_size", "refine_sigmas", "refine_cfg")),
                     ("upscale", ("upscale_model",)),
                     ("color_match", ("grade_method",)),
                     ("h3_facefix", ("h3face_canvas", "h3face_denoise"))):
        if op not in ops:
            continue
        tuned = {k: (opts or {})[k] for k in keys
                 if (opts or {}).get(k) not in (None, "", POST_OPTS.get(k))}
        if tuned:
            payload[op] = tuned
    # Only when the fit CHANGES the intermediate, which is the same rule the
    # two flags above follow — a clip whose slot already equals its trim is
    # byte-for-byte what it was, and keying every clip on a number they nearly
    # all already satisfy would re-render a whole timeline to record it.
    if fit_ms:
        payload["fit"] = fit_ms
        # REVERSED CLIPS WHOSE TRIM AND SLOT DISAGREE, which is exactly the set
        # _reverse_window_end changed: they mirrored [in_ms, out_ms] and now
        # mirror the window they play, so their cached intermediate is footage
        # from the wrong end of the shot. `fit_ms` is set whenever the two
        # disagree in EITHER direction and only one of those moves the window,
        # so this over-invalidates by a clip or two — re-rendering one that was
        # already right is cheap, serving one that is wrong is not. Keyed under
        # `fit` so no forward clip and no already-agreeing reversed clip loses
        # its entry.
        if any(o.get("op") == "reverse" for o in (clip.get("ops") or [])):
            payload["rev"] = 2
    return hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def project_post_chain(project_id):
    """The default chain clips inherit — projects.settings.post."""
    return project_post_defaults(project_id)[0]


#: What color_match matches TO. "source" (the default) matches each clip back
#: to a frame of ITS OWN pre-post source, so the pass restores the timeline's
#: grade after the generative passes move it; "asset" is the original design —
#: one project-wide still every clip is matched to. The asset mode is kept
#: because unifying a cut's grade on purpose is a real thing to want, but it
#: is no longer the default: measured on a real cut, matching every scene to
#: one still flattened the whole film onto that still's histogram (a bright
#: shot pulled down 24 luma points, a dark forest lifted 13, saturation -29%)
#: — which the user reported as "washed out compared to the timeline".
GRADE_MODES = ("source", "asset")

#: How the two generative passes are tuned, project-wide, with the DEFAULTS
#: that keep every render written before this byte-identical. On the project
#: rather than the clip for `post_ref_*`'s reason: a cut whose shots were
#: refined at different strengths does not agree with itself, and the whole
#: point of a finishing chain is that it is a finish.
#:
#: `refine_size` is the one to understand:
#:   native — sample at the take's own frame. Detail only, cheapest.
#:   fit    — sample at the frame the cut DELIVERS (handlers.post.refine_target).
#:            Same generation cost spent where it survives, because everything
#:            above `transcode_chain`'s 1080 cap is discarded one hop later.
#:   2x     — LTX's own learned latent upsampler. Best per-pixel and the ratio
#:            is fixed, so on a 1280x704 take it renders 2560x1408 and the
#:            chain immediately throws most of it away.
POST_OPTS = {
    "refine_size": "native",
    "refine_sigmas": "",          # "" = the schedule that fits the size
    "refine_cfg": 1.0,
    "upscale_model": "3b",
    # The H3 face pass. `h3face_canvas` is a KEY (graphs.H3_FACE_CANVASES),
    # never a pixel count, and "auto" is the pack's own sizing; the denoise is
    # its author's own base and does NOT mean what the detailer's does — H3 is
    # flow matching with a large sigma shift, so an ordinary detailer's 0.25
    # lands at an effective sigma of 0.800 and rewrites the frame.
    "h3face_canvas": "768",
    "h3face_denoise": 0.4,
    # WHICH colour transfer the grade runs. "mkl" is the shipped behaviour and
    # KJNodes' own default; the alternatives are the same node's other
    # algorithms, and `reinhard_lab_gpu` additionally needs ColorMatchV2 —
    # `post._color_match_node` refuses rather than substituting one.
    "grade_method": "mkl",
}
REFINE_SIZES = ("native", "fit", "2x")


def _post_opts(st):
    """projects.settings -> the tuning dict, every value clamped to something
    the worker can act on. A value nobody can read must never silently become
    a different render: an out-of-range one falls back to the DEFAULT (which is
    the shipped behaviour), never to an adjacent setting."""
    import graphs
    out = dict(POST_OPTS)
    size = st.get("post_refine_size")
    if size in REFINE_SIZES:
        out["refine_size"] = size
    sig = st.get("post_refine_sigmas")
    if sig in graphs.LTX_REFINE_PRESETS:
        out["refine_sigmas"] = sig
    try:
        cfg = float(st.get("post_refine_cfg") or POST_OPTS["refine_cfg"])
        out["refine_cfg"] = max(1.0, min(3.0, cfg))
    except (TypeError, ValueError):
        pass
    model = st.get("post_upscale_model")
    if model in graphs.SEEDVR2_MODELS:
        out["upscale_model"] = model
    grade_method = st.get("post_grade_method")
    if grade_method in graphs.COLOR_MATCH_METHODS:
        out["grade_method"] = grade_method
    canvas = st.get("post_h3face_canvas")
    if canvas in graphs.H3_FACE_CANVASES:
        out["h3face_canvas"] = canvas
    try:
        fd = float(st.get("post_h3face_denoise") or POST_OPTS["h3face_denoise"])
        out["h3face_denoise"] = max(0.1, min(0.9, fd))
    except (TypeError, ValueError):
        pass
    return out


def project_post_defaults(project_id):
    """-> (chain, grade, opts), grade being {"mode", "asset_id", "strength"}
    and opts the per-pass tuning (POST_OPTS).

    All off projects.settings in one read. The reference lives on the PROJECT
    rather than the clip because the point of the pass is that every shot in a
    cut agrees — in "source" mode they agree by each matching its own take
    (the look the editor showed), in "asset" mode by matching one still.
    """
    if not project_id:
        return {}, {"mode": "source", "asset_id": None, "strength": 1.0}, dict(POST_OPTS)
    try:
        rows = sb.get(f"projects?id=eq.{project_id}&select=settings")
        st = rows[0].get("settings") or {}
        mode = st.get("post_ref_mode")
        if mode not in GRADE_MODES:
            mode = "source"
        try:
            strength = float(st.get("post_ref_strength") or 1.0)
        except (TypeError, ValueError):
            strength = 1.0
        grade = {"mode": mode, "asset_id": st.get("post_ref_asset_id"),
                 "strength": max(0.0, min(1.0, strength))}
        return post_chain.normalize(st.get("post")) or {}, grade, _post_opts(st)
    except Exception as e:
        # A default nobody could read must not silently become "no passes":
        # that renders a master without the look it was set up with and says
        # nothing. Callers turn this into a failed job.
        raise RuntimeError(f"could not read project {project_id} post defaults: {e}")


def _post_params(grade, opts=None):
    """Per-op kwargs for apply_chain.

    In "asset" mode it still RAISES without a reference rather than passing
    the clip through ungraded. In "source" mode there is nothing to name here:
    the reference is a frame of the clip's own pre-post source, which only
    `render_clip_with_post` can extract — it plants the `source_ref` marker
    and that function replaces it with the extracted frame (and pops it, so
    `apply_color_match` never sees an argument it does not take).
    """
    grade = grade or {}
    opts = {**POST_OPTS, **(opts or {})}
    strength = grade.get("strength", 1.0)
    # The METHOD rides both grade modes: it is a property of the transfer, not
    # of where the reference came from, and leaving it off one branch would
    # make the same setting reach the render in "asset" mode and not in
    # "source" (the default), which is the worse half to miss.
    if grade.get("mode") == "asset" and grade.get("asset_id"):
        params = {"color_match": {"match_asset_id": grade["asset_id"],
                                  "strength": strength}}
    elif grade.get("mode") == "asset":
        params = {}
    else:
        params = {"color_match": {"source_ref": True, "strength": strength}}
    if "color_match" in params and opts["grade_method"] != POST_OPTS["grade_method"]:
        params["color_match"]["method"] = opts["grade_method"]

    # The refine's SIZE is not settled here — "fit" needs the source's own
    # frame, which only `render_clip_with_post` has (it has probed the file).
    # It plants the mode and that function replaces it, the same seam
    # `source_ref` uses one entry up.
    refine = {"size_mode": opts["refine_size"]}
    if opts["refine_sigmas"]:
        refine["sigmas"] = opts["refine_sigmas"]
    if float(opts["refine_cfg"]) > 1.0:
        refine["video_cfg"] = float(opts["refine_cfg"])
    params["ltx_refine"] = refine
    if opts["upscale_model"] != POST_OPTS["upscale_model"]:
        params["upscale"] = {"model": opts["upscale_model"]}
    face = {k[7:]: opts[k] for k in ("h3face_canvas", "h3face_denoise")
            if opts[k] != POST_OPTS[k]}
    if face:
        params["h3_facefix"] = face
    return params


def _trim_chain(chain, clip, asset, tl_fps):
    """Drop `interpolate` from a clip's chain when the timeline keeps none of
    the frames it makes.

    The pass doubles the frame rate (24 -> 48) and the body render then locks
    the clip to the TIMELINE's fps — so on a 24fps timeline over 24fps takes,
    `fps=24` decimates straight back to the original frames and the pass is a
    model load, a sample and two encode generations that deliver nothing.
    Measured on a real cut: every interp intermediate at 48fps, every cached
    clip back at 24. It survives where it can land: a timeline faster than the
    source, or a slow-motion op (the retime spreads the doubled frames out, so
    they reach the output grid).
    """
    ops = post_chain.active_ops(chain)
    if "interpolate" not in ops:
        return chain
    src_fps = float((asset or {}).get("fps") or 24)
    slow = any(o.get("op") == "speed" and float(o.get("rate") or 1) < 1
               for o in (clip.get("ops") or []))
    if float(tl_fps) > src_fps or slow:
        return chain
    return {**chain, "interpolate": False}


def source_window(src, dst, clip, *, cancel_check=None):
    """Cut the clip's [in, out] out of the take, at the take's own geometry.

    THE SOURCE PASSES USED TO SEE THE WHOLE DOWNLOADED TAKE, and that is what
    made a timeline render OOM (2026-08-24). "Before trim" was written to mean
    "before the picture is touched" — an upscaler wants the original pixels,
    not a fitted, re-encoded frame — and it was read as "before the CUT" as
    well, which nothing needs. So a clip using 3.0s of a 12.0s take paid
    SeedVR2 and LTX 2.5 over all twelve, and a clip using 0.7s of an 11.5s one
    paid sixteen times over. The waste is the smaller half: the take's length
    is unbounded where the clip's is bounded by the edit, so the peak was set
    by how long the SOURCE happened to be and no edit could bring it down.
    Measured on the failing render: 6.0s of source restored fine at 353s, the
    12.0s take behind a 3.1s clip died on `KSampler #9` with 84.9 GB live.

    The window keeps the take's own frame size and rate and carries NO ops —
    the ops still belong to the body render, which is the only place that
    knows the timeline's grid — so the passes still get original pixels.
    `build_clip_filter(fit=False)` does the cut so the window is frame-for-
    frame the one the body would have taken; anything else here would show up
    as a one-frame drift between a chained clip and its neighbour.

    Returns the window's path, or None when the clip already plays the whole
    file and there is nothing to cut. That case is not an optimisation to skip
    lightly: with no window the passes read the take as it was uploaded, so a
    clip that used to run untrimmed renders from exactly the same bytes it
    always did, with no extra encode generation in front of a restore pass.
    """
    in_ms = int(clip.get("in_ms") or 0)
    out_ms = clip.get("out_ms")
    info = media.probe(src) or {}
    dur = int(info.get("duration_ms") or 0)
    fps = float(info.get("fps") or 0) or 24.0
    frame_ms = 1000.0 / fps
    if in_ms <= 0 and (out_ms is None or (dur > 0 and int(out_ms) >= dur - frame_ms)):
        return None
    has_aud = media.has_audio(src)
    # width/height/fps are unused at fit=False — the window is the take's own
    # geometry, and normalising here would hand the restore a letterboxed frame.
    vf, af = build_clip_filter([], width=info.get("width") or 0,
                               height=info.get("height") or 0, fps=fps,
                               has_audio=has_aud, in_ms=in_ms, out_ms=out_ms,
                               fit=False)
    args = ["-i", src, "-vf", vf]
    if af and has_aud:
        args += ["-af", af]
    # crf 16 rather than the body's 18: this is an intermediate that a restore
    # or a refine reads next, and a compression artefact handed to SeedVR2 is
    # detail it will happily sharpen. Same reasoning (and same number) as
    # apply_ltx_refine's own pad step.
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16",
             "-preset", "veryfast", "-movflags", "+faststart"]
    args += (["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]
             if has_aud else ["-an"])
    media.run_ff(args + [dst], "clip-window", cancel_check)
    return dst


def render_clip_with_post(src, dst, clip, *, width, height, fps, chain=None,
                          job=None, src_fps=None, cancel_check=None, params=None,
                          slot_ms=None):
    """One clip, end to end: source passes -> trim/ops/normalize -> finish passes.

    The split is post_chain.POST_STAGE's and the reasons are there. Note what
    the source stage means at this scale: an upscale is followed by the fit to
    the timeline's frame, so it buys restored detail rather than a bigger
    picture — which is what SeedVR2 is for.

    The CUT happens first (see source_window); only the ops and the fit wait
    for the body render.
    """
    from handlers import post  # lazy: pulls comfy, which render.py otherwise doesn't need

    conflict = post_chain.chain_conflict(chain)
    if conflict:
        # BEFORE the source window and before a model loads. Both halves of a
        # refused pair are switched on by a human, so this is a message about
        # a setting rather than a failure — and by the time an applier could
        # notice, the clip's GPU time is already spent.
        raise RuntimeError(f"post chain: {conflict}")
    pre = post_chain.active_ops(chain, "source")
    fin = post_chain.active_ops(chain, "finish")
    params = dict(params or {})
    comfy_ops = [op for op in pre + fin
                 if op in post_chain.GPU_OPS and op != "color_match"]
    cm = dict(params.get("color_match") or {})
    if cm.pop("source_ref", False) and "color_match" in fin:
        # SOURCE-MODE COLOR MATCH: the reference is a frame of THIS clip's own
        # pre-post source, so the pass restores the grade the timeline showed
        # instead of flattening the film onto one still. It also repairs the
        # range wash the ComfyUI hops accumulate — LoadVideo hands limited
        # yuv through to RGB unexpanded while SaveVideo re-compresses on the
        # way out (measured with a ramp through the live engine: every hop
        # lifts blacks ~6%), and this reference enters through the one clean
        # path (an ffmpeg-extracted PNG) while the matched output leaves
        # through the one correct encode. With no ComfyUI pass in the chain
        # there is nothing to match back from, so the pass is dropped rather
        # than run as a no-op.
        if not comfy_ops:
            fin = [op for op in fin if op != "color_match"]
            log("post chain: color_match (source mode) skipped — no pass moved the color")
        else:
            if "facefix" not in fin:
                # Run it as the LAST SOURCE pass: pre-fit, so the matcher never
                # sees the letterbox bars the body render pads in — a black
                # pillar is 2% of the histogram and it belongs to neither the
                # reference nor the shot. With facefix on it stays in the
                # finish stage (facefix re-samples faces AFTER the source
                # passes, and matching before it would leave that resample's
                # drift uncorrected).
                fin = [op for op in fin if op != "color_match"]
                pre = pre + ["color_match"]
            params["color_match"] = cm  # reference is planted below
    tmps = []
    try:
        if pre:
            window = source_window(src, dst + ".win.mp4", clip, cancel_check=cancel_check)
            if window:
                tmps.append(window)
                src = window
                # The cut is spent. Leaving it on would trim the window again,
                # against its own zero, and cut real frames out of the clip.
                clip = {**clip, "in_ms": 0, "out_ms": None}
            if "color_match" in pre + fin and "match_asset_id" not in cm \
                    and "reference" not in cm:
                # The clip's own look before any pass touches it — a CONTACT
                # SHEET across the window, not one frame: a global transfer
                # matches the whole clip to whatever the frame caught, and a
                # single middle frame measured as the brightest instant of a
                # shot that swings 57..71 YAVG. Nine frames pooled are the
                # window's distribution.
                info = media.probe(src) or {}
                dur = int(info.get("duration_ms") or 0)
                a = int(clip.get("in_ms") or 0)
                b = int(clip.get("out_ms") or 0) or dur
                ref_png = dst + ".cmsrc.png"
                media.extract_sheet(src, ref_png, in_ms=a, out_ms=b)
                tmps.append(ref_png)
                cm["reference"] = ref_png
                params["color_match"] = cm
            if "upscale" in pre and "scale" not in (params.get("upscale") or {}):
                # SeedVR2's cost is linear in OUTPUT pixels and everything
                # above the chain transcode's 1080 cap is thrown away one hop
                # later — measured 90.1s at scale 2 against 50.0s at 1.5 for
                # the same delivered frame. So the scale is what the timeline
                # can keep, not a constant 2. POST_UPSCALE_SUPERSAMPLE=1
                # restores the old fixed 2x (a 2x render downscaled is mild
                # antialiasing; A/B'd at ship time and not worth 1.8x the
                # dominant pass).
                if not os.environ.get("POST_UPSCALE_SUPERSAMPLE"):
                    src_h = int((media.probe(src) or {}).get("height") or 0)
                    # `min(1080, height)` until 2026-09-05, and that 1080 was
                    # NOT a judgement about the restore — it was
                    # `transcode_chain`'s own constant, quoted here because
                    # anything above it was discarded one hop later. The chain
                    # follows the timeline now (`chain_cap_h`), so quoting the
                    # old ceiling would hold a 1440p or 4K timeline at a 1080p
                    # restore for a reason that no longer exists. The 2x cap
                    # below is the real one and is unchanged.
                    #
                    # THE TIMELINE'S HEIGHT EXACTLY, not `chain_cap_h`'s — that
                    # one has a 1080 FLOOR so no existing intermediate changes
                    # size, and borrowing it here would restore a 1280x704
                    # timeline at 1.53x for the body render to throw straight
                    # back to 704. Above 1080 the two agree; below it, this is
                    # the number that stops the waste the fit-scale was
                    # measured for (90.1s against 50.0s for the same frame).
                    cap_h = int(height)
                    if src_h > 0:
                        fitted = min(POST_UPSCALE_MAX_SCALE,
                                     max(1.0, round(cap_h / src_h + 0.005, 2)))
                        params["upscale"] = {**(params.get("upscale") or {}),
                                             "scale": fitted}
            if "ltx_refine" in pre:
                # The refine's size mode becomes an actual frame HERE, for the
                # same reason the restore's scale does one block up: it is a
                # function of the source, and this is the first point the
                # source is a file that has been probed. `_post_params` plants
                # the mode; `apply_ltx_refine` takes `upscale`/`target` and has
                # never heard of `size_mode`, so it is popped rather than
                # passed on.
                rf = dict(params.get("ltx_refine") or {})
                mode = rf.pop("size_mode", "native")
                if mode == "2x":
                    rf["upscale"] = True
                elif mode == "fit":
                    # THE FRAME, NOT A TARGET. Resolving it here would need the
                    # LTX entry's own `dim_step`, which this module has no
                    # reason to load — and getting that wrong is a silent 3%
                    # stretch (see apply_ltx_refine). The delivery frame is
                    # what this function knows; the pass owns the grid.
                    rf["fit_frame"] = (int(width), int(height))
                params["ltx_refine"] = rf
            staged = dst + ".src.mp4"
            src = post.apply_chain(job, src, staged, pre,
                                   src_fps=src_fps or fps, params=params, tag="pre",
                                   cap_h=chain_cap_h(height))
            tmps.append(staged)
        body = dst + ".body.mp4" if fin else dst
        render_clip_file(src, body, clip, width=width, height=height, fps=fps,
                         cancel_check=cancel_check, slot_ms=slot_ms)
        if fin:
            tmps.append(body)
            post.apply_chain(job, body, dst, fin, src_fps=fps, params=params,
                             tag="fin", cap_h=chain_cap_h(height))
        return dst
    finally:
        for p in tmps:
            try:
                os.remove(p)
            except OSError:
                pass


#: How far the restore may enlarge in one pass. MEASURED at 4K, 3B, same take
#: and seed, against a plain lanczos to 4K: the capped path (2x to 2560x1408,
#: then the body render carries it the rest of the way) is **121s and +75.1%**
#: edge energy; restoring at the delivered 3930x2160 outright is **300s and
#: +95.2%**, with the same correlation to the source (0.994 vs 0.995).
#:
#: So going the whole way IS better — 1.27x the detail — and it costs 2.5x the
#: time, which is why 2.0 stays the default: it is the same trade the
#: supersample decision already made in the other direction ("a 2x render
#: downscaled is mild antialiasing; not worth 1.8x the dominant pass"). What
#: was wrong before was that the ceiling could not be REACHED at any price on a
#: 4K timeline. `POST_UPSCALE_MAX_SCALE=3.1` in /etc/neon-worker.env buys the
#: 20 points for whoever is delivering a 4K master and can pay for them.
POST_UPSCALE_MAX_SCALE = float(os.environ.get("POST_UPSCALE_MAX_SCALE") or 2.0)


def chain_cap_h(height):
    """How tall a chain intermediate may be, for `media.transcode_chain`.

    THE TIMELINE'S OWN FRAME, never a constant. It was 1080 everywhere, which
    is not a quality choice — it is a ceiling on the whole post chain: a
    SeedVR2 restore to 3840x2112 came back 1962x1080 and the body render then
    fitted THAT to the timeline, so a 4K master could only ever be a 1080p one
    resampled up, with the restore's own detail discarded in between. Measured
    on real passes; nothing said so.

    The floor stays 1080 so nothing below it changes: the body render fits to
    the timeline's frame immediately, so on a 1280x704 or a 1080p timeline the
    extra rows really were waste and this returns exactly what it always did.
    """
    return max(1080, int(height or 0))


def _fit(width, height):
    return (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1")


def _atempo_chain(rate):
    """atempo only accepts 0.5–2.0; compose factors for anything else."""
    filters, r = [], rate
    while r > 2.0:
        filters.append("atempo=2.0")
        r /= 2.0
    while r < 0.5:
        filters.append("atempo=0.5")
        r /= 0.5
    filters.append(f"atempo={r:.6f}")
    return ",".join(filters)


def speed_rate(ops):
    """The playback rate an op list applies, compounded.

    Every `speed` op appends its own `setpts`, so two of them multiply — and
    the UI only ever writes one (`retime` strips the existing ones first), so
    the product is also what "the rate" means for every clip that exists. The
    browser reads the same rule (`src/lib/clipFrames.ts::clipRate`), which is
    what lets the reversed window below be computed identically on both sides.
    """
    rate = 1.0
    for op in ops or []:
        if op.get("op") == "speed":
            rate *= max(0.05, float(op.get("rate") or 1))
    return rate


def _reverse_window_end(ops, in_ms, out_ms, slot_ms):
    """The trim's `end` for a REVERSED clip: the window it PLAYS.

    A reversed clip used to mirror `[in_ms, out_ms]`, and that is not always
    the window the clip shows. The `-t slot_ms` cap is applied to the finished
    chain, so forward it lands correctly — it cuts the tail off an overlong
    trim — and reversed it takes the WRONG END: the reverse happens first, so
    the cap keeps the last `slot` of source instead of the first.

    They agree whenever `out_ms == in_ms + slot_ms * rate`, which is every trim
    gesture and the inspector's Out field. They DISAGREE after
    `_attach_to_clip`, which writes a whole render's length into `out_ms` while
    only ever SHRINKING `duration_ms` — the normal state of a generated take
    that came back longer than its block's slot. There a reversed clip rendered
    footage its own slot never reaches: a good-looking video of the wrong part
    of the shot, with nothing to say so.

    So the window is narrowed to what the clip plays, which is also what the
    preview mirrors (`src/lib/clipFrames.ts::clipSourceAt`) and what the same
    clip shows with reverse OFF. Toggling reverse now changes the ORDER of the
    frames and never which frames they are.

    `min`, not a replacement: an `out_ms` INSIDE the played window is the media
    genuinely running out, and widening to the slot would ask for frames that
    are not there. Without a `slot_ms` there is nothing to narrow against and
    the caller's window stands — the freeze path is the one that does that, and
    it splits the clip into pieces whose slot is only their sum.
    """
    if not slot_ms or not any(op.get("op") == "reverse" for op in ops or []):
        return out_ms
    played_end = (in_ms or 0) + slot_ms * speed_rate(ops)
    return played_end if out_ms is None else min(out_ms, played_end)


def build_clip_filter(ops, *, width, height, fps, has_audio, in_ms=None, out_ms=None,
                      mute_audio=False, fit=True, slot_ms=None):
    """-> (vf_chain, af_chain) for the ordered op list.

    Trimming happens INSIDE the filtergraph (trim/atrim before any op) so a
    later speed op stretches the trimmed content instead of racing an output
    -t cap. freeze is handled by the caller (it needs a three-piece concat).
    A REVERSED clip narrows that trim to the window it plays rather than to
    `out_ms` — see _reverse_window_end, which is the one place the two differ.

    `mute_audio` is a detached clip: its sound now plays from an audio lane, so
    the picture is silenced HERE rather than dropped — the concat and xfade
    steps map [0:a][1:a] and an intermediate with no audio stream at all would
    fail the assembly instead of playing quietly.

    `fit=False` returns the OPS ALONE — no normalise to the timeline grid, no
    fps lock. Wanted by exactly one caller: the motion-context pre-pass, which
    re-renders a few seconds of the predecessor so the pinned motion carries
    the clip's own look (a flipped clip's context was mirrored against its
    picture anchor). There the frame grid belongs to the H3 render, not to the
    timeline, and `_fit` would letterbox a window that is about to be encoded
    by the model. Every other caller keeps the normalise — it is what makes a
    cached clip match the grid.
    """
    vf, af = [], []
    out_ms = _reverse_window_end(ops, in_ms, out_ms, slot_ms)
    if in_ms is not None or out_ms is not None:
        a = (in_ms or 0) / 1000.0
        rng = f"start={a:.3f}" + (f":end={out_ms / 1000.0:.3f}" if out_ms is not None else "")
        vf.append(f"trim={rng},setpts=PTS-STARTPTS")
        af.append(f"atrim={rng},asetpts=PTS-STARTPTS")
    for op in ops:
        k = op.get("op")
        if k == "flip":
            vf.append("hflip" if op.get("dir") != "v" else "vflip")
        elif k == "transform":
            rot = float(op.get("rotate") or 0)
            scale = float(op.get("scale") or 1)
            tx, ty = int(op.get("tx") or 0), int(op.get("ty") or 0)
            if rot:
                vf.append(f"rotate={rot}*PI/180:c=black@0:ow=rotw({rot}*PI/180):oh=roth({rot}*PI/180)")
            if scale != 1:
                vf.append(f"scale=iw*{scale}:-2")
            if tx or ty or rot or scale != 1:
                vf.append(f"crop={width}:{height}:(iw-{width})/2-({tx}):(ih-{height})/2-({ty})")
        elif k == "crop":
            # Clamped in ffmpeg's own expression language rather than against a
            # probe: vf_crop REFUSES a region bigger than its input (it errors
            # with "Invalid too big or non positive size" — it clamps only the
            # OFFSET), and a rect outliving the media it was drawn on is the
            # normal case here, not a corner one. A take swap patches
            # `asset_id` and keeps the ops, so a 704x704 window written on a
            # 1280x704 take meets an 864x480 retake and kills the whole
            # timeline render. `iw`/`ih` are evaluated at graph time, so this
            # costs nothing and needs no ffprobe. Mirrored in
            # src/lib/clipCrop.clampCrop so the preview shows the same window.
            # Each expression is single-quoted because a bare comma inside a
            # filter argument SPLITS THE FILTERGRAPH — `min(704,iw)` unquoted
            # ends the crop and starts a filter called `iw)`. x/y read `ow`/`oh`
            # (the already-computed crop size) rather than repeating the min.
            vf.append(
                f"crop='min({int(op['w'])},iw)':'min({int(op['h'])},ih)'"
                f":'max(0,min({int(op['x'])},iw-ow))':'max(0,min({int(op['y'])},ih-oh))'")
        elif k == "speed":
            rate = max(0.05, float(op.get("rate") or 1))
            if rate != 1:
                vf.append(f"setpts=PTS/{rate:.6f}")
                if has_audio:
                    af.append(_atempo_chain(rate))
        elif k == "reverse":
            vf.append("reverse")
            if has_audio:
                af.append("areverse")
        elif k == "freeze":
            pass  # handled by caller
    if mute_audio and has_audio:
        af.append("volume=0")
    # Normalize last so every cached clip matches the timeline grid.
    if fit:
        vf.append(_fit(width, height))
        vf.append(f"fps={fps}")
    if slot_ms and fit:
        # THE CLIP IS FITTED TO ITS TIMELINE SLOT, and until 2026-08-24 it was
        # not: this rendered `[in_ms, out_ms]` with no cap, the concat played
        # each intermediate whole, and a clip whose slot disagreed with its
        # trim pushed everything after it out of position. The editor lays
        # clips out by `duration_ms` (WsTimeline), so the preview was showing
        # the right cut and the render was not — and the audio lanes are placed
        # at absolute `t_start_ms` via `adelay`, so the picture drifted against
        # the dialogue rather than just ending late. Measured on a real 21-clip
        # cut: 8 clips off, +1928ms net, one of them +2151ms on its own.
        #
        # `tpad` then `-t` fits BOTH directions with no measuring step. Six of
        # those eight rendered LONG (a generated take whose `out_ms` covers the
        # whole render while `duration_ms` was only ever shrunk — see
        # `_attach_to_clip`) and two rendered SHORT, because a `speed` op
        # retimed the content without the slot following it. Padding by holding
        # the last frame is what a player does with a slot it cannot fill.
        # `apad` keeps the audio the same length as the picture; both are cut by
        # the caller's `-t`, so the result is EXACTLY the slot either way.
        vf.append(f"tpad=stop_mode=clone:stop_duration={slot_ms / 1000.0:.3f}")
        if has_audio:
            af.append("apad")
    return ",".join(vf), ",".join(af)


def render_clip_file(src, dst, clip, *, width, height, fps, cancel_check=None,
                     slot_ms=None):
    """Render one clip's trimmed+op'd intermediate to dst.

    `slot_ms` is the clip's timeline duration. Given one, the intermediate is
    EXACTLY that long — see build_clip_filter for why that is not the same as
    the trim, and what it cost when it was not enforced.
    """
    ops = clip.get("ops") or []
    in_ms = int(clip.get("in_ms") or 0)
    out_ms = clip.get("out_ms")
    has_aud = media.has_audio(src)
    mute_aud = bool(clip.get("audio_detached"))
    freeze = next((o for o in ops if o.get("op") == "freeze"), None)
    cap = ["-t", f"{slot_ms / 1000.0:.3f}"] if slot_ms else []

    def encode(inp, outp, vf, af, cap_out=False):
        args = ["-i", inp]
        # A SOURCE WITH NO AUDIO STILL GETS A (silent) TRACK. Every cached
        # intermediate has to look the same to the concat demuxer: the fast
        # assembly path is one `-c copy` concat over all of them, and a list
        # mixing audio and audio-less files does not survive it. `-shortest`
        # ends the silence with the picture.
        if not has_aud:
            args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                     "-map", "0:v", "-map", "1:a", "-shortest"]
        if vf:
            args += ["-vf", vf]
        if af and has_aud:
            args += ["-af", af]
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                 "-preset", "veryfast", "-movflags", "+faststart"] + COLOR_TAGS
        args += ["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]
        media.run_ff(args + (cap if cap_out else []) + [outp], "clip-render", cancel_check)

    if not freeze:
        vf, af = build_clip_filter(ops, width=width, height=height, fps=fps,
                                   has_audio=has_aud, in_ms=in_ms, out_ms=out_ms,
                                   mute_audio=mute_aud, slot_ms=slot_ms)
        encode(src, dst, vf, af, cap_out=True)
        return dst

    # freeze: pre [0,at) + still loop (dur) + post [at,end), each normalized,
    # then concat. Non-freeze ops apply to every piece; `at` is relative to
    # the trimmed clip — SOURCE ms from the in-point, before the speed op,
    # which is what src/lib/clipFrames.freezeSourceMs writes.
    at = int(freeze["at_ms"])
    hold = int(freeze.get("dur_ms") or 1000)
    other = [o for o in ops if o.get("op") != "freeze"]
    rev = any(o.get("op") == "reverse" for o in other)
    # THE STILL IS THE CLIP'S LOOK, HELD — so it takes the ops that decide how
    # a frame is drawn and neither of the two that are about TIME. `speed` ran
    # `setpts=PTS/rate` over the loop and divided the hold by the rate: a
    # control labelled "Freeze 1s" delivered 0.67s at 1.5x and 4s at 0.25x.
    # `reverse` buffers the whole loop to hand back the same repeated frame.
    look = [o for o in other if o.get("op") not in ("speed", "reverse")]
    lvf, _ = build_clip_filter(look, width=width, height=height, fps=fps, has_audio=False)
    base = dst + ".base.mp4"
    # Muting once here is enough for the whole freeze path: pre and post are
    # re-encodes of this base, and the still's audio is anullsrc already.
    tvf, taf = build_clip_filter([], width=width, height=height, fps=fps,
                                 has_audio=has_aud, in_ms=in_ms, out_ms=out_ms,
                                 mute_audio=mute_aud)
    encode(src, base, tvf, taf)  # trimmed + normalized source
    # `at` HAS TO LAND INSIDE THE BASE, and a stored row cannot be trusted to:
    # every freeze written before freezeSourceMs holds a timeline offset, which
    # on a slowed clip runs past the end of the media it indexes (4x the length
    # at 0.25x). Out of range, extract_frame produces no file and raises — and
    # it raises at the END of a timeline render, after every other clip has
    # been paid for. A frame short of the end leaves `post` a frame to hold.
    try:
        base_ms = media.probe(base).get("duration_ms") or 0
    except Exception:
        base_ms = 0  # unprobeable: clamp nothing, behave exactly as before
    fr_ms = 1000.0 / max(1, fps)
    if base_ms > fr_ms:
        at = max(0, min(at, int(base_ms - fr_ms)))
    pre, still, post = dst + ".pre.mp4", dst + ".still.mp4", dst + ".post.mp4"
    pieces = []
    if at > 0:
        pvf, paf = build_clip_filter(other, width=width, height=height, fps=fps,
                                     has_audio=has_aud, in_ms=0, out_ms=at)
        encode(base, pre, pvf, paf)
        pieces.append(pre)
    frame = dst + ".frame.png"
    media.extract_frame(base, frame, at_ms=at)
    still_args = ["-loop", "1", "-t", f"{hold / 1000:.3f}", "-i", frame,
                  "-f", "lavfi", "-t", f"{hold / 1000:.3f}",
                  "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
                  "-vf", (lvf or _fit(width, height) + f",fps={fps}"),
                  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                  "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest",
                  "-movflags", "+faststart", still]
    media.run_ff(still_args, "freeze-still", cancel_check)
    pieces.append(still)
    if not base_ms or at < base_ms - fr_ms / 2:
        svf, saf = build_clip_filter(other, width=width, height=height, fps=fps,
                                     has_audio=has_aud, in_ms=at, out_ms=None)
        encode(base, post, svf, saf)
        pieces.append(post)
    if rev:
        # A REVERSED CLIP PLAYS `end - t*rate`, so the piece that comes first on
        # screen is the one cut from the END of the base. Each piece is already
        # reversed by its own filter chain; only their ORDER was still forward,
        # which put the shot back together inside out around the hold — the
        # second half first, then the first half, each running backwards.
        pieces.reverse()
    listf = dst + ".list.txt"
    with open(listf, "w") as f:
        for p in pieces:
            f.write(f"file '{p}'\n")
    # The fit goes on the JOIN, not on the three pieces: `at_ms` splits the clip
    # and only their sum is the slot, so capping a piece would cut real content.
    fvf = (f"tpad=stop_mode=clone:stop_duration={slot_ms / 1000.0:.3f}"
           if slot_ms else None)
    # Same encoder settings as encode() above — a freeze clip's cached
    # intermediate has to be indistinguishable from every other piece, or it
    # is the one file that knocks the whole assembly off the copy-concat path.
    media.run_ff(["-f", "concat", "-safe", "0", "-i", listf]
                 + (["-vf", fvf, "-af", "apad"] if fvf else [])
                 + ["-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast"]
                 + COLOR_TAGS
                 + ["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
                    "-movflags", "+faststart"] + cap + [dst], "freeze-concat", cancel_check)
    for p in pieces + [base, frame, listf]:
        try:
            os.remove(p)
        except OSError:
            pass
    return dst


#: The lanes on which a ComfyUI-driving render may be claimed.
#:
#: `gpu` is the pod's serial slot. `local` is the DESKTOP's own queue, and it
#: qualifies for the same reason rather than by exception: `localWorker` runs
#: one job at a time by construction ("a laptop GPU is serial; two renders at
#: once is two renders that both swap"), so there is no concurrent pool for a
#: second model to land beside. Without it every local render with a finishing
#: pass on it is refused — which is most of them, since the picker's whole
#: point is rendering the cut you just tuned.
_SERIAL_LANES = ("gpu", "local")


def _require_gpu_lane(job, chains, what):
    """A render that drives ComfyUI must be claimed on a SERIAL lane.

    worker.py fills the cpu/api/llm pool CONCURRENTLY with the serial gpu slot,
    so a cpu-lane render running SeedVR2 or RIFE loads a second model beside
    whatever the pod is generating. The browser picks the lane
    (lib/db/jobs.ts queueTimelineRender); this refuses rather than trusting it,
    because the failure mode is an OOM nowhere near its cause. It can't fire on
    a job queued before the post chain existed — those carry no chain at all.
    """
    if job.get("lane") in _SERIAL_LANES:
        return
    hot = sorted({op for c in chains for op in post_chain.active_ops(c)
                  if op in post_chain.GPU_OPS})
    if hot:
        raise RuntimeError(
            f"{what} needs a serial lane: its post chain runs {', '.join(hot)} "
            f"through ComfyUI. Requeue with lane='gpu' (the pod) or "
            f"lane='local' (this machine).")


def handle_clip_render(job):
    payload = job.get("payload") or {}
    clip = sb.get(f"clips?id=eq.{payload['clip_id']}")[0]
    track = sb.get(f"tracks?id=eq.{clip['track_id']}")[0]
    tl = sb.get(f"timelines?id=eq.{track['timeline_id']}")[0]
    ep = sb.get(f"episodes?id=eq.{tl['episode_id']}&select=id,project_id")[0]
    asset = sb.asset_by_id(clip["asset_id"])
    proj_chain, grade, popts = project_post_defaults(ep.get("project_id"))
    chain = _trim_chain(post_chain.resolve(clip.get("post"), proj_chain)[1],
                        clip, asset, tl["fps"])
    _require_gpu_lane(job, [chain], "clip_render")
    slot_ms, fit_ms = clip_fit_ms(clip, asset)
    h = op_hash(asset, clip, tl["fps"], tl["width"], tl["height"], chain, grade,
                opts=popts,
                fit_ms=fit_ms)
    os.makedirs(CACHE_DIR, exist_ok=True)
    dst = os.path.join(CACHE_DIR, f"{h}.mp4")
    if os.path.exists(dst):
        sb.job_done(job["id"])
        log(f"clip_render cache hit {h[:12]}")
        return
    src = f"/tmp/{job['id']}_src{os.path.splitext(asset['b2_key'])[1] or '.mp4'}"
    media.b2_get(asset["b2_key"], src)
    try:
        render_clip_with_post(src, dst, clip, width=tl["width"], height=tl["height"],
                              fps=tl["fps"], chain=chain, job=job,
                              src_fps=asset.get("fps"),
                              params=_post_params(grade, popts),
                              slot_ms=slot_ms,
                              cancel_check=lambda: sb.cancel_requested(job["id"]))
    finally:
        try:
            os.remove(src)
        except OSError:
            pass
    sb.job_done(job["id"])
    log(f"clip_render {h[:12]} done (post: {post_chain.describe(chain)})")


# --------------------------------------------------------------- timeline ----
def _clip_effective_ms(clip, asset):
    """Timeline duration of a clip after trim + speed ops."""
    dur = clip.get("duration_ms")
    if dur:
        return int(dur)
    src = (clip.get("out_ms") or asset.get("duration_ms") or 0) - (clip.get("in_ms") or 0)
    for op in (clip.get("ops") or []):
        if op.get("op") == "speed" and op.get("rate"):
            src = src / float(op["rate"])
        if op.get("op") == "freeze":
            src += int(op.get("dur_ms") or 0)
    return int(src)


def clip_fit_ms(clip, asset):
    """-> (slot_ms, fit_ms): the clip's timeline duration, and that same number
    again ONLY when rendering to it differs from what the trim would produce.

    `_clip_effective_ms` already answers both questions — with `duration_ms`
    present it returns the slot, and with it removed it computes what the
    [in, out] window and the ops actually yield. When they disagree the render
    has been wrong (see build_clip_filter); `fit_ms` is what tells the cache
    which clips that was true of, so a fix re-renders those and reuses the rest.
    """
    slot = _clip_effective_ms(clip, asset)
    natural = _clip_effective_ms({**clip, "duration_ms": None}, asset)
    return slot, (slot if abs(slot - natural) > 2 else None)


def handle_tl_render(job):
    """Flatten the timeline: base video track concat (with xfade transitions
    and per-clip cached intermediates) + N audio tracks mixed over it."""
    payload = job.get("payload") or {}
    tl = sb.get(f"timelines?id=eq.{payload['timeline_id']}")[0]
    ep = sb.get(f"episodes?id=eq.{tl['episode_id']}&select=id,code,project_id")[0]
    tracks = sb.get(f"tracks?timeline_id=eq.{tl['id']}&order=idx")
    vtracks = [t for t in tracks if t["kind"] == "video"]
    # Mute AND solo, through the same rule the preview player uses
    # (worker/mix.py <-> src/lib/mix.ts). Soloing a lane in the editor and
    # hearing everything in the render is the kind of divergence nobody
    # notices until the deliverable is out.
    atracks = mix.audible_tracks(tracks, kind="audio")
    if not vtracks:
        raise ValueError("timeline has no video track")
    base = vtracks[0]  # v1 renderer: single base video track (overlays are M7+)
    clips = sb.get(f"clips?track_id=eq.{base['id']}&order=t_start_ms")
    if not clips:
        raise ValueError("timeline has no clips")

    # Resolve every clip's post chain up front: the lane check has to see the
    # whole render before any of it runs, and a chain that can't be resolved is
    # a render that would silently come back ungraded.
    proj_chain, grade, popts = project_post_defaults(ep.get("project_id"))
    chains = [_trim_chain(post_chain.resolve(c.get("post"), proj_chain)[1],
                          c, sb.asset_by_id(c["asset_id"]), tl["fps"])
              for c in clips]
    _require_gpu_lane(job, chains, "tl_render")
    posted = sum(1 for c in chains if post_chain.active_ops(c))
    if posted:
        log(f"tl_render: post chain on {posted}/{len(clips)} clip(s); "
            f"project default {post_chain.describe(proj_chain)}")

    os.makedirs(CACHE_DIR, exist_ok=True)
    jid = job["id"]
    n = len(clips)
    pieces = []
    for i, c in enumerate(clips):
        asset = sb.asset_by_id(c["asset_id"])
        chain = chains[i]
        slot_ms, fit_ms = clip_fit_ms(c, asset)
        h = op_hash(asset, c, tl["fps"], tl["width"], tl["height"], chain, grade,
                    opts=popts,
                    fit_ms=fit_ms)
        cached = os.path.join(CACHE_DIR, f"{h}.mp4")
        if not os.path.exists(cached):
            src = f"/tmp/{jid}_c{i}{os.path.splitext(asset['b2_key'])[1] or '.mp4'}"
            media.b2_get(asset["b2_key"], src)
            try:
                render_clip_with_post(src, cached, c, width=tl["width"], height=tl["height"],
                                      fps=tl["fps"], chain=chain, job=job,
                                      src_fps=asset.get("fps"),
                                      params=_post_params(grade, popts),
                                      slot_ms=slot_ms,
                                      cancel_check=lambda: sb.cancel_requested(jid))
            finally:
                try:
                    os.remove(src)
                except OSError:
                    pass
        pieces.append({"clip": c, "file": cached})
        sb.job_progress(jid, 0.6 * (i + 1) / n,
                        note=f"clip {i + 1}/{n}"
                             + (f" · {post_chain.describe(chain)}" if post_chain.active_ops(chain) else ""))

    # THE CUT IS AS LONG AS ITS LONGEST AUDIBLE LANE, not as long as the
    # picture — an outro over black is an ordinary thing to cut. Computed
    # BEFORE assembly so the black tail can be a concat PIECE like any other:
    # encoded once, a few frames long, stream-copied on. The first version
    # extended the picture with `tpad` in the final mux instead, and that
    # forced a re-encode of the WHOLE cut at the last step — the
    # `can_copy_video` fast path could never fire on a timeline with an outro.
    video_ms = sum(_clip_effective_ms(p["clip"], sb.asset_by_id(p["clip"]["asset_id"]))
                   for p in pieces)
    lane_clips = [(t, sb.get(f"clips?track_id=eq.{t['id']}&order=t_start_ms"))
                  for t in atracks]
    timeline_ms = video_ms
    for t, aclips in lane_clips:
        for c in aclips:
            timeline_ms = max(timeline_ms, int(c["t_start_ms"])
                              + _clip_effective_ms(c, sb.asset_by_id(c["asset_id"])))
    tail_ms = max(0, timeline_ms - video_ms)
    if tail_ms:
        log(f"tl_render: {tail_ms}ms of audio past the last shot — "
            f"picture extended with black to {timeline_ms}ms")
        tailf = f"/tmp/{jid}_tail.mp4"
        media.run_ff(["-f", "lavfi", "-i",
                      f"color=c=black:s={tl['width']}x{tl['height']}:r={tl['fps']}",
                      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                      "-t", f"{tail_ms / 1000.0:.3f}",
                      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                      "-preset", "veryfast"] + COLOR_TAGS
                     + ["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
                        "-movflags", "+faststart", tailf], "tail",
                     cancel_check=lambda: sb.cancel_requested(jid))
        pieces.append({"clip": None, "file": tailf})

    # Video assembly. Every piece comes out of ONE encoder with identical
    # settings, so with no xfade in the cut the whole assembly is a single
    # `-c copy` concat — seconds, and zero generations. The pairwise loop
    # below re-encodes the ACCUMULATED left side at every join, which on a
    # 21-clip cut put clip 1 through ~20 successive crf-18 generations; it
    # survives only for the xfade case, whose blend genuinely needs pixels
    # rebuilt, and for a cache entry old enough to have no audio stream.
    video_out = f"/tmp/{jid}_video.mp4"
    xfades = sum(1 for p in pieces[1:] if p["clip"] is not None
                 and (p["clip"].get("transition_in") or {}).get("type") == "xfade")
    uniform = all(media.has_audio(p["file"]) for p in pieces)
    if not xfades and uniform:
        log(f"tl_render: assembling {len(pieces)} piece(s) — stream copy, no re-encode")
        listf = f"/tmp/{jid}_concat.txt"
        with open(listf, "w") as f:
            for pc in pieces:
                f.write(f"file '{pc['file']}'\n")
        media.run_ff(["-f", "concat", "-safe", "0", "-i", listf, "-c", "copy",
                      "-movflags", "+faststart", video_out], "concat-copy",
                     cancel_check=lambda: sb.cancel_requested(jid))
        os.remove(listf)
    else:
        log(f"tl_render: assembling {len(pieces)} piece(s) — {xfades} xfade(s)"
            + ("" if uniform else ", non-uniform audio") + ", pairwise")
        _assemble_pairwise(jid, pieces, tail_ms, video_out,
                           cancel_check=lambda: sb.cancel_requested(jid))
    sb.job_progress(jid, 0.75, note="mixing audio")
    _tl_finish(job, tl, ep, payload, tracks, base, atracks, lane_clips,
               clips, chains, proj_chain, video_out, video_ms, timeline_ms)


def _assemble_pairwise(jid, pieces, tail_ms, video_out, *, cancel_check=None):
    """The re-encoding assembly, kept for the xfade case (a blend genuinely
    needs pixels rebuilt) and for a cache entry old enough to lack an audio
    stream. Every join re-encodes the ACCUMULATED left side, so on a long cut
    this is minutes and generations — the copy-concat path above is the one
    every plain cut takes now."""
    cur = pieces[0]["file"]
    cur_dur = _clip_effective_ms(pieces[0]["clip"], sb.asset_by_id(pieces[0]["clip"]["asset_id"])) \
        if pieces[0]["clip"] is not None else tail_ms
    for i in range(1, len(pieces)):
        nxt = pieces[i]
        tin = (nxt["clip"] or {}).get("transition_in") or {}
        step_out = f"/tmp/{jid}_v{i}.mp4"
        nxt_dur = _clip_effective_ms(nxt["clip"], sb.asset_by_id(nxt["clip"]["asset_id"])) \
            if nxt["clip"] is not None else tail_ms
        log(f"tl_render: join {i}/{len(pieces) - 1}"
            + (" (xfade)" if tin.get("type") == "xfade" else ""))
        if tin.get("type") == "xfade":
            d = min(int(tin.get("dur_ms") or 500), cur_dur - 1, nxt_dur - 1) / 1000.0
            off = cur_dur / 1000.0 - d
            style = tin.get("style") or "fade"
            fc = (f"[0:v][1:v]xfade=transition={style}:duration={d:.3f}:offset={off:.3f}[v];"
                  f"[0:a][1:a]acrossfade=d={d:.3f}[a]")
            media.run_ff(["-i", cur, "-i", nxt["file"], "-filter_complex", fc,
                          "-map", "[v]", "-map", "[a]", "-c:v", "libx264",
                          "-pix_fmt", "yuv420p", "-crf", "18"] + COLOR_TAGS
                         + ["-c:a", "aac", "-ar", "48000",
                            "-movflags", "+faststart", step_out],
                         "xfade", cancel_check=cancel_check)
            cur_dur = cur_dur + nxt_dur - int(d * 1000)
        else:
            listf = f"/tmp/{jid}_l{i}.txt"
            with open(listf, "w") as f:
                f.write(f"file '{cur}'\nfile '{nxt['file']}'\n")
            media.run_ff(["-f", "concat", "-safe", "0", "-i", listf, "-c", "copy",
                          "-movflags", "+faststart", step_out], "concat",
                         cancel_check=cancel_check)
            os.remove(listf)
            cur_dur = cur_dur + nxt_dur
        if i > 1:
            try:
                os.remove(cur)
            except OSError:
                pass
        cur = step_out
    if cur != video_out:
        os.replace(cur, video_out)


def _tl_finish(job, tl, ep, payload, tracks, base, atracks, lane_clips,
               clips, chains, proj_chain, video_out, video_ms, timeline_ms):
    """The audio mix + delivery encode + upload, shared by both assembly
    paths. The tail is already IN `video_out`, so the picture never needs a
    filter here and `can_copy_video`'s stream copy actually fires."""
    jid = job["id"]
    inputs = ["-i", video_out]
    fparts, amaps, idx = [], [], 1
    for lane_n, (t, aclips) in enumerate(lane_clips):
        # The LANE's own rack (src/lib/audioGraph.ts plays the same chain
        # through a bus in the preview). A lane with one is summed into a bus
        # first, so its inserts hear every clip on it at once — which is the
        # thing a per-clip chain structurally cannot do, and the whole reason
        # the column exists.
        lane_fx = audio_fx.filters(t.get("audio_fx"))
        labels = []
        for c in aclips:
            a = sb.asset_by_id(c["asset_id"])
            local = f"/tmp/{jid}_a{idx}{os.path.splitext(a['b2_key'])[1] or '.mp3'}"
            media.b2_get(a["b2_key"], local)
            inputs += ["-i", local]
            filt = [f"atrim=start={(c.get('in_ms') or 0) / 1000:.3f}"]
            if c.get("out_ms"):
                filt[0] += f":end={c['out_ms'] / 1000:.3f}"
            filt.append("asetpts=PTS-STARTPTS")
            filt.append(f"adelay={c['t_start_ms']}|{c['t_start_ms']}")
            # The clip's own effects come BEFORE the lane's level: an effect is
            # part of what this clip sounds like, the fader and its automation
            # are the mix. It matters — a compressor reacts to what it is fed,
            # so ducking the lane first would change how hard it works.
            filt.extend(audio_fx.filters(c.get("audio_fx")))
            if lane_fx:
                # The lane's level moves POST-BUS, after its inserts — console
                # order, and the only order in which a lane compressor hears
                # the lane rather than the fader. Splitting it is free: gain is
                # linear and distributes over the sum, so `sum(clip * clipgain)
                # * lane(t)` is what the one-filter form already computed. A
                # lane with no rack keeps that form exactly, byte for byte.
                filt.append("volume=%.4fdB" % (float(c.get("gain_db") or 0)))
            else:
                # AFTER adelay, so the filter's `t` is timeline time and the
                # lane's automation curve needs no rebasing. Without automation
                # this is the constant gain the mix always applied.
                filt.append(mix.volume_filter(t, c.get("gain_db") or 0))
            filt.append("aresample=48000")
            fparts.append(f"[{idx}:a]{','.join(filt)}[a{idx}]")
            labels.append(f"[a{idx}]")
            idx += 1

        out = f"[lane{lane_n}]"
        bus = mix.lane_bus(t, labels, out)
        if bus:
            fparts.append(bus)
            amaps.append(out)
            log(f"tl_render: lane {t.get('name') or lane_n} — {len(lane_fx)} insert filter(s) "
                f"over {len(labels)} clip(s)"
                + (f", {audio_fx.tail_ms(t.get('audio_fx')):.0f}ms tail" if "apad" in bus else ""))
        else:
            amaps.extend(labels)

    # The OUTPUT SPEC decides the last encode. Everything up to here — the
    # per-clip renders, the concat, the xfades — is an INTERMEDIATE at
    # libx264/crf 18, and that stays fixed: it is a working format, and making
    # it follow the delivery codec would run ProRes through N iterative
    # concat passes. This step is where the cut becomes the file, so it is the
    # one that carries codec, quality, scale, frame rate and audio.
    out = RO.normalize(payload.get("output"))
    ext = RO.ext(out)
    vargs = (["-c:v", "copy"] if RO.can_copy_video(out, tl["width"], tl["height"])
             else RO.video_args(out, tl["width"], tl["height"]))
    log(f"tl_render output: {RO.describe(out)}"
        + ("  (video copied — matches the intermediate)" if vargs[1] == "copy" else ""))
    final = f"/tmp/{jid}_final.{ext}"
    # `-t` on the output makes the deliverable EXACTLY the timeline's length
    # whichever stream would otherwise decide it.
    length = ["-t", f"{timeline_ms / 1000.0:.3f}"]
    if amaps:
        # The base video track's own audio (e.g. H3 native/locked take audio)
        # respects the track's mute + gain — a locked-audio MV mutes it so the
        # master track on A1 is the only music in the mix (no comb doubling).
        # Solo reaches it too: soloing an audio lane has to silence the
        # picture's baked audio or "just this lane" is a lie.
        base_gain = float(base.get("gain_db") or 0)
        base_mix = (f"[0:a]volume={base_gain}dB[a0]"
                    if media.has_audio(video_out) and mix.is_audible(base, tracks) else "")
        srcs = ("[a0]" if base_mix else "") + "".join(amaps)
        n_in = len(amaps) + (1 if base_mix else 0)
        # NOT `chains` — that name already holds this render's per-clip post
        # chains, and shadowing it here fed the asset's `meta.post` a list of
        # filtergraph STRINGS. It failed at the very END of a 50-minute render
        # with `'str' object has no attribute 'get'`, after every clip and the
        # whole assembly were already paid for.
        graph, vmap = [], "0:v"
        if base_mix:
            graph.append(base_mix)
        graph.extend(fparts)
        # `longest`, not `first`: `first` is the picture's own audio and it is
        # what truncated the outro.
        graph.append(f"{srcs}amix=inputs={n_in}:normalize=0:duration=longest[aout]")
        fc = ";".join(graph)
        amix_args = RO.audio_args(out)
        maps = ["-map", vmap] + ([] if out["audio"] == "none" else ["-map", "[aout]"])
        media.run_ff(inputs + ["-filter_complex", fc] + maps + vargs + amix_args
                     + length + [final], "audio-mix",
                     cancel_check=lambda: sb.cancel_requested(jid))
    elif not mix.is_audible(base, tracks) and media.has_audio(video_out):
        # Nothing to mix AND the picture's own audio is out of the mix — muted,
        # or another lane is soloed. Copying the file through would deliver the
        # audio the editor says is silent.
        media.run_ff(["-i", video_out, "-map", "0:v"] + vargs + ["-an", final],
                     "audio-strip", cancel_check=lambda: sb.cancel_requested(jid))
    elif vargs[1] == "copy" and out["audio"] != "none" and ext == "mp4":
        # Nothing to mix, the picture's own audio stands, and the requested
        # output IS the intermediate — the file on disk is already the answer.
        os.replace(video_out, final)
    else:
        # No audio lanes to mix, but the delivery format differs from the
        # intermediate (or the track is being stripped), so it still has to be
        # encoded rather than moved.
        media.run_ff(["-i", video_out, "-map", "0:v"]
                     + ([] if out["audio"] == "none" else ["-map", "0:a?"])
                     + vargs + RO.audio_args(out) + [final], "transcode",
                     cancel_check=lambda: sb.cancel_requested(jid))

    key = f"renders/{ep['code']}/timeline_{jid}.{ext}"
    media.b2_put(final, key, content_type=RO.content_type(out))
    info = media.probe(final)
    asset = sb.register_asset(key, "render", project_id=ep["project_id"],
                              content_type=RO.content_type(out), bytes_=info["bytes"],
                              width=info["width"], height=info["height"],
                              duration_ms=info["duration_ms"], fps=info["fps"],
                              source_job_id=jid, tags=["timeline-render"],
                              # What this master actually got, per clip. A cut
                              # is graded by a chain that lives on rows anyone
                              # can edit afterwards, so the file has to carry
                              # its own recipe — same reason a music asset does.
                              # The delivery recipe, beside the post recipe and
                              # for the same reason: both live on rows anyone
                              # can edit afterwards, so the file carries its own.
                              meta={
                                  "output": out,
                                  "post": {
                                      "project_default": post_chain.active_ops(proj_chain),
                                      "clips": {c["id"]: post_chain.active_ops(ch)
                                                for c, ch in zip(clips, chains)
                                                if post_chain.active_ops(ch)},
                                  },
                              })
    sb.patch(f"timelines?id=eq.{tl['id']}",
             {"render_asset_id": asset["id"], "render_stale": False})
    sb.job_done(jid, output_asset_id=asset["id"])
    for p in (video_out, final):
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE tl_render -> {key} ({info['duration_ms']}ms)")

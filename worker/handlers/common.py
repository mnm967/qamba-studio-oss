"""What every ComfyUI-driving handler shares: where the engine keeps its
files, the progress/cancel tick, and the model map for this tier.

It was `handlers/legacy.py` — the v1 studio's own job handlers, with these
three helpers at the top because they were written there first. The v1 studio
is gone from this build; the helpers are what every v2 handler imports.
"""
import os
import time

import comfy
import media
import sb
from status import log

COMFY_ROOT = os.environ.get("COMFY_ROOT", "/kaggle/working/ComfyUI")
TIER = os.environ.get("MODEL_TIER", "kaggle")

import graphs


def _project_of_episode(episode_id):
    rows = sb.get(f"episodes?id=eq.{episode_id}&select=project_id")
    return rows[0].get("project_id") if rows else None


# Seconds between preview uploads. A render is minutes long, so this is about
# what a watcher can perceive, not about keeping up with the sampler: at 6s a
# 12-minute block costs ~120 small PUTs. 0 disables.
PREVIEW_EVERY_S = float(os.environ.get("NEON_PREVIEW_EVERY_S", "6") or 0)


def _publish_preview(job, state):
    """Put the newest sampler frame at a stable per-job key.

    One key per job, overwritten — the interesting frame is always the latest,
    and a key per frame would leave hundreds of objects behind per render. It is
    deliberately NOT registered in `assets`: a preview is not media (invariant
    #2 is about the media registry), and staying unregistered is what lets
    `gc_sweep` collect it on its own once the job is long finished and the real
    output exists. Best-effort throughout — a failed preview must never touch
    the render.
    """
    frame = comfy.preview_frame()
    if not frame or frame[0] == state["last_seq"]:
        return
    seq, content_type, blob = frame
    ext = "png" if content_type.endswith("png") else "jpg"
    local = f"/tmp/{job['id']}_preview.{ext}"
    try:
        with open(local, "wb") as f:
            f.write(blob)
        key = f"previews/{job['id']}.{ext}"
        media.b2_put(local, key, content_type=content_type)
        state["last_seq"] = seq
        if not state["published"]:
            state["published"] = True
            sb.job_patch(job["id"], {"preview_key": key})
    except Exception as e:
        # Once, so a misconfigured bucket doesn't write a line every 6 seconds
        # for the length of every render.
        if not state["warned"]:
            state["warned"] = True
            log("preview publish failed (previews disabled for this job):", e)
        state["last_seq"] = seq
    finally:
        try:
            os.remove(local)
        except OSError:
            pass


def make_tick(job, *, staged=0.05, span=(0.05, 0.90)):
    """comfy.wait on_tick: publish sampling progress, honor cancellation."""
    state = {"last_check": 0.0, "last_pub": 0.0, "last_prev": 0.0,
             "last_seq": None, "published": False, "warned": False}

    def tick(prog):
        t = time.time()
        if t - state["last_check"] > 6:
            state["last_check"] = t
            if sb.cancel_requested(job["id"]):
                raise comfy.Canceled(f"job {job['id']} canceled")
        if prog and t - state["last_pub"] > 2:
            state["last_pub"] = t
            n, total = prog
            frac = staged + (span[1] - span[0]) * (n / max(1, total))
            sb.job_progress(job["id"], frac, note=f"sampling {n}/{total}")
        if PREVIEW_EVERY_S and t - state["last_prev"] > PREVIEW_EVERY_S:
            state["last_prev"] = t
            _publish_preview(job, state)

    return tick


def unstick_shot(sid):
    try:
        takes = sb.get(f"takes?shot_id=eq.{sid}&output_key=not.is.null&select=id&limit=1")
        sb.patch(f"shots?id=eq.{sid}&status=eq.generating",
                 {"status": "review" if takes else "queued"})
    except Exception as e:
        log("unstick_shot failed:", e)


def _load_map_tier():
    try:
        return R.load_map()[TIER]
    except Exception:
        return {}

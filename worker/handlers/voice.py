"""voice_clone — turn an uploaded recording into a voice the studio can speak in.

A cpu-lane job, not an API route, for the ordinary reason (invariant #1): the
browser writes a `voice_clones` row plus this job, and the provider key never
leaves the pod. It is also why the row has a `status` — a hosted registration
is a network call that can fail, and a picker needs to say "still registering"
rather than offering a voice that is not there yet.

The row is ALWAYS resolved, in both directions: a failure writes
`status='error'` with the provider's own sentence, because the alternative is a
clone that sits on `pending` forever with nothing on screen to explain it.
"""
import os

import media
import sb
import voice_clone as VC
from status import log


def resolve_kind(kind):
    return {"voice_clone": handle_voice_clone}[kind]


def handle_voice_clone(job):
    payload = job.get("payload") or {}
    cid = payload.get("voice_clone_id")
    if not cid:
        raise ValueError("voice_clone job payload missing voice_clone_id")

    rows = sb.get(f"voice_clones?id=eq.{cid}"
                  f"&select=id,name,provider,sample_asset_id,sample_text,status")
    if not rows:
        log(f"voice_clone: {cid} is gone — nothing to register")
        return
    clone = rows[0]

    local = None
    try:
        assets = sb.get(f"assets?id=eq.{clone.get('sample_asset_id')}"
                        f"&select=id,b2_key,duration_ms,kind")
        if not assets:
            raise VC.CloneError("the reference clip is missing from the library")
        asset = assets[0]
        if asset.get("kind") != "audio":
            raise VC.CloneError("the reference has to be an audio file")

        ext = os.path.splitext(asset["b2_key"])[1] or ".mp3"
        local = f"/tmp/clone_{job['id']}{ext}"
        media.b2_get(asset["b2_key"], local)
        # The registered duration is filled by `asset_ingest`, which may not
        # have run yet — a probe here is cheap and makes the length check
        # reliable rather than dependent on job ordering.
        dur = int(media.probe(local).get("duration_ms") or asset.get("duration_ms") or 0)

        sb.job_progress(job["id"], 0.4, note=f"registering with {clone['provider']}")
        rid, warning = VC.register(
            clone["provider"], name=clone.get("name") or "Voice",
            sample_path=local, sample_text=clone.get("sample_text") or "",
            duration_ms=dur)

        sb.patch(f"voice_clones?id=eq.{cid}", {
            "reference_id": rid, "status": "ready", "error_msg": None,
            "meta": {"duration_ms": dur, **({"warning": warning} if warning else {})},
        })
        sb.job_done(job["id"])
        log(f"JOB DONE voice_clone -> '{clone.get('name')}' ready on "
            f"{clone['provider']}" + (f" ({warning})" if warning else ""))
    except Exception as e:
        # The row is the thing the UI watches, so it has to carry the reason —
        # a job that fails while the clone stays `pending` is a spinner that
        # never resolves and never says why.
        sb.patch(f"voice_clones?id=eq.{cid}",
                 {"status": "error", "error_msg": str(e)[:400]})
        raise
    finally:
        if local:
            try:
                os.remove(local)
            except OSError:
                pass

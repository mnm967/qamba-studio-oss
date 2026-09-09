"""asset_ingest — ffprobe dims/duration/bytes + waveform peaks into
assets.meta so the timeline renders waveforms without client-side decoding.
CPU lane; runs for every uploaded/imported media asset.
"""
import json
import os

import media
import sb
from status import log


def handle_asset_ingest(job):
    aid = (job.get("payload") or {}).get("asset_id")
    if not aid:
        raise ValueError("asset_ingest payload missing asset_id")
    asset = sb.asset_by_id(aid)
    if not asset:
        raise ValueError(f"asset {aid} not found")

    local = f"/tmp/ingest_{job['id']}{os.path.splitext(asset['b2_key'])[1] or ''}"
    media.b2_get(asset["b2_key"], local)
    try:
        info = media.probe(local)
        sb.job_progress(job["id"], 0.5, note="probed")
        meta = dict(asset.get("meta") or {})
        if asset["kind"] in ("audio", "video") and info["has_audio"]:
            meta["peaks"] = media.waveform_peaks(local)
        patch = {
            "bytes": info["bytes"],
            "duration_ms": info["duration_ms"],
            "meta": meta,
        }
        if info["width"]:
            patch["width"], patch["height"] = info["width"], info["height"]
        if info["fps"]:
            patch["fps"] = info["fps"]
        sb.patch(f"assets?id=eq.{aid}", patch)
        sb.job_done(job["id"], output_asset_id=aid)
        log(f"JOB DONE ingest {asset['b2_key']} "
            f"({info['duration_ms']}ms, peaks={'peaks' in meta})")
    finally:
        try:
            os.remove(local)
        except OSError:
            pass

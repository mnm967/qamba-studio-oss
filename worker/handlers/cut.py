"""The episode CUT: every block's active take, concatenated in story order.

The editor's first move, and the one thing the old QA package held that was
never QA — it lived beside the take/sequence judge only because that judge was
what consumed the result. The judge is gone from this build; the assembly is
the deliverable.

`_mix_score` places the storyboard's score under the finished concat. Both
halves are here rather than in `handlers/render.py` because that module is the
TIMELINE's renderer (one cut, clip by clip, with the post chain on it) and this
is the STORYBOARD's (one file per block, `-c copy`, no re-encode): they share
ffmpeg and nothing else.
"""
import os

import sb
from status import log

def _mix_score(jid, story, blocks, cut_path):
    """Place the storyboard's score under the assembled cut.

    Returns `(path, note)` — a new file and what to record on the asset, or
    `(None, None)` when there is nothing to do. Every refusal is a LOG LINE
    and not an exception: a cut that assembles without music is a cut, and
    failing the episode's delivery over a bed is the wrong trade.

    See `score_mix` for why the level is measured, why a locked track is
    skipped, and why the score is never looped.
    """
    import media
    import score_mix as SM

    aid = story.get("audio_asset_id")
    if not aid:
        return None, None
    # A locked block already HAS this track baked into its picture — mixing it
    # again is the same music twice, milliseconds apart. Ask the blocks rather
    # than the project: the block is what actually rendered.
    if any(b.get("audio_mode") == "locked" for b in blocks):
        log("score: blocks carry locked audio — the master is already in the picture")
        return None, None
    meta = story.get("audio_meta") or {}
    cues = ((meta.get("score") or {}).get("cues")) or []
    scenes = sb.get(f"scenes?storyboard_id=eq.{story['id']}&select=id,slug")
    slug_by_id = {s["id"]: s.get("slug") for s in scenes}
    spans = SM.cue_spans(blocks, slug_by_id, cues)
    points = SM.envelope_points(spans)
    if SM.all_silent(points):
        log("score: every cue is silence — the cut keeps its own audio untouched")
        return None, None

    asset = sb.asset_by_id(aid)
    if not asset or not asset.get("b2_key"):
        log(f"score: asset {aid} is gone — cut assembled without music")
        return None, None
    score_path = f"/tmp/asm_{jid}_score{os.path.splitext(asset['b2_key'])[1] or '.mp3'}"
    try:
        media.b2_get(asset["b2_key"], score_path)
    except Exception as e:  # noqa: BLE001
        log(f"score: could not fetch the track ({e}) — cut assembled without music")
        return None, None

    cut = media.probe(cut_path)
    cut_ms = int(cut.get("duration_ms") or 0)
    score_ms = int((media.probe(score_path) or {}).get("duration_ms")
                   or asset.get("duration_ms") or 0)
    has_prog = media.has_audio(cut_path)

    from audioqa import _run as _ff_stderr
    gain = SM.bed_gain_db(SM.measure_lufs(score_path, _ff_stderr),
                          SM.measure_lufs(cut_path, _ff_stderr) if has_prog else -16.0)
    if gain is None:
        log("score: loudness unmeasurable on one side — declining to guess a "
            "bed level, cut assembled without music")
        return None, None

    out = f"/tmp/asm_{jid}_scored.mp4"
    fc = SM.filter_complex(points, gain, cut_ms=cut_ms, score_ms=score_ms,
                           has_programme=has_prog)
    try:
        media.run_ff(["-i", cut_path, "-i", score_path,
                      "-filter_complex", fc,
                      "-map", "0:v", "-map", "[aout]",
                      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                      "-shortest", out], "score mix")
    except Exception as e:  # noqa: BLE001 — the unscored cut is still a cut
        log(f"score: mix failed ({str(e)[:160]}) — cut assembled without music")
        return None, None

    short = max(0, cut_ms - score_ms)
    levels = sorted({int(s[2]) for s in spans})
    note = {"asset_id": aid, "bed_gain_db": round(gain, 2),
            "cues": len(cues), "intensities": levels,
            "score_ms": score_ms, "cut_ms": cut_ms}
    msg = (f"score: mixed under the cut at {gain:+.1f}dB "
           f"(cues {levels}, {len(points)} envelope point(s))")
    if short > 250:
        note["unscored_tail_ms"] = short
        msg += (f" — the track is {short / 1000:.1f}s SHORTER than the cut, so "
                f"the last {short / 1000:.1f}s plays unscored (render a longer "
                f"score rather than looping this one)")
    log(msg)
    try:
        os.remove(score_path)
    except OSError:
        pass
    return out, note


def handle_assemble_cut(job):
    """The editor's first move: concat every block's active take in story
    order into the episode cut, register it, and hand the result to the
    sequence reviewer."""
    import subprocess

    import media
    jid = job["id"]
    p = job.get("payload") or {}
    sid = p["storyboard_id"]
    story = sb.get(f"storyboards?id=eq.{sid}")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,code,project_id")[0]
    blocks = sb.get(f"generation_blocks?storyboard_id=eq.{sid}"
                    f"&select=id,idx,active_take_id,params,scene_ids,"
                    f"t_start_ms,t_end_ms,audio_mode&order=idx")
    paths, lines = [], []
    for b in blocks:
        if not b.get("active_take_id"):
            raise ValueError(f"block {b['idx']} has no active take — cannot assemble")
        take = sb.get(f"block_takes?id=eq.{b['active_take_id']}&select=asset_id")[0]
        a = sb.asset_by_id(take["asset_id"])
        local = f"/tmp/asm_{jid}_{b['idx']:03d}.mp4"
        media.b2_get(a["b2_key"], local)
        paths.append(local)
        lines.append(f"file '{local}'")
    lst = f"/tmp/asm_{jid}.txt"
    open(lst, "w").write("\n".join(lines))
    out = f"/tmp/asm_{jid}.mp4"
    media.run_ff(["-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out], "assemble")
    scored, score_note = _mix_score(jid, story, blocks, out)
    if scored:
        paths.append(out)          # the unscored concat is now an intermediate
        out = scored
    sb.job_progress(jid, 0.8, note="upload")
    key = f"renders/{ep['code']}/cut_{jid}.mp4"
    media.b2_put(out, key)
    info = media.probe(out)
    asset = sb.register_asset(key, "render", project_id=ep["project_id"],
                              content_type="video/mp4", bytes_=info["bytes"],
                              width=info["width"], height=info["height"],
                              duration_ms=info["duration_ms"], fps=info["fps"],
                              source_job_id=jid, origin="derived",
                              meta={"storyboard_id": sid, "blocks": len(blocks),
                                    **({"score": score_note} if score_note else {})},
                              tags=["render", "episode-cut"])
    for x in paths + [lst, out]:
        try:
            os.remove(x)
        except OSError:
            pass
    # The chain's motion-context latents (output/h3_context/<block_id>/) have
    # served their purpose once the episode assembles — retakes after this
    # point fall back to the frames path, which is correct, not broken.
    import shutil
    comfy_root = os.environ.get("COMFY_ROOT", "/kaggle/working/ComfyUI")
    for b in blocks:
        shutil.rmtree(os.path.join(comfy_root, "output", "h3_context",
                                   str(b["id"])), ignore_errors=True)
    sb.job_done(jid, output_asset_id=asset["id"])
    log(f"JOB DONE assemble_cut -> {key} ({info['duration_ms']}ms, {len(blocks)} blocks)")

"""H3 block pipeline handlers: master_pass, audio_slice, patch_flf,
patch_splice, video_edit, transition_gen.

A master pass renders one 15s-max generation_block: refs staged per the
block's ref_plan (chain frame in slot 1, pinned identity refs after), prompt
compiled deterministically from scenes/beats, frames pre-planned as 17n+5
(render long → trim exact), locked audio driven through the vendored VRGDG
AudioDrive node. Retakes rerun a pass; FLF patches regenerate a sub-range and
splice back; transitions are short FLF bridges between two clips.
"""
import json
import os
import re

import comfy
import h3_prompt
import h3_timing
import ltx_prompt
import media
import resolve as R
import resolve_custom as RC
import sb
from handlers.common import make_tick
from status import log
# Block REFS count from one — see director_tools.REF_BASE and
# director/refs.js. The queue must name a block the way the chat does.
from director_tools import _block_ref

COMFY_ROOT = os.environ.get("COMFY_ROOT", "/kaggle/working/ComfyUI")
H3_MODEL = os.environ.get("H3_MODEL_KEY", "minimax-h3")  # model_map key
# What a block may be rendered as. Mirrors model_map's minimax-h3 modes;
# resolve() rejects anything the map does not have a template for anyway.
H3_MODES = ("r2v", "i2v", "flf", "t2v")
AUDIOLOCK_WF = "minimax_h3_r2v_audiolock.json"


def _block_model(block, params=None):
    """The model_map key this block renders on.

    An episode must not switch checkpoints shot to shot, so the choice is made
    once — in the wizard — and stored on every block's `params` by
    launch_render, rather than being re-decided per job. That is also why a
    repair pass (patch_flf) reads it: re-rendering one segment of an existing
    block on a different checkpoint changes the look mid-block.

    Falls back to H3_MODEL, so blocks planned before this shipped (and the
    `H3_MODEL_KEY` env override) keep working unchanged.

    `params` overrides the block's own for ONE run — that is how a re-render
    asked for from the director chat ("do b4 on plain h3 instead") picks a
    checkpoint without rewriting the episode's stored choice. The episode-wide
    rule above still holds: the override is per job, and only `persist_params`
    writes it back.
    """
    p = params if params is not None else (block.get("params") or {})
    return p.get("model_key") or H3_MODEL


# The combat adapter, added to a FIGHT block's stack automatically. Keyed here
# rather than by filename because that is the whole `style_loras` convention —
# a key the model does not declare is dropped, so a model without it is simply
# unaffected.
FIGHT_LORA = "combat"
FIGHT_STRENGTH = 1.0
# The camera-motion adapter (Jojocodex's Camera Motion LoRA), added to a block
# whose shots MOVE the camera — push-in, pull-back, tracking, orbit, crane,
# tilt, handheld, aerial. Same shape as the fight adapter: keyed by the
# `style_loras` name so a model that does not declare it is simply unaffected,
# stamped at PLAN time (`params.camera_motion`) so two takes of one block agree
# and the flag is per-block overridable. The author's range is 0.8-1.0 (0.8
# gentle, 1.0 pronounced, >1.2 unstable); 0.9 is model_map's default.
#
# Its trigger, `camera motion`, MUST begin the prompt — model_map's
# `lora_triggers` carries it and `h3_prompt` opens the description with it.
# A pan-only shot does not qualify: pans are the one move the author rates
# weak (sparse data), and a static hold has nothing for it to do.
CAMERA_LORA = "camera"
CAMERA_STRENGTH = 0.9
_CAMERA_MOVE = re.compile(
    r"\b(?:push(?:es|ing)?[- ]?in|dolly|dollies|pull(?:s|ing)?[- ]?(?:back|out)|"
    r"track(?:s|ing)?|orbit(?:s|ing)?|arc(?:s|ing)?|circle(?:s|ing)?|crane(?:s)?|"
    r"boom(?:s)?|tilt(?:s|ing)?|handheld|hand-held|aerial|drone|fly(?:over|s|ing)?|"
    r"zoom(?:s|ing)?|rises?|descend(?:s|ing)?|glide(?:s)?)\b", re.I)


def camera_moves(camera):
    """Whether a shot's camera line names a move the camera adapter is for.
    Pure. "holds a static shot" and a bare "pan" say no."""
    return bool(_CAMERA_MOVE.search(camera or ""))


def _block_loras(block, params=None, *, model=None):
    """The LoRA stack this block renders with — keys, resolved by resolve.py.

    Rides `params` for the same reason `_block_model` does: launch_render copies
    the wizard's `payload.params` onto every generation_blocks row, so the pick
    is made once and holds for the whole episode. A concept LoRA appearing in
    shot 4 and not shot 3 is the same continuity break as switching checkpoints
    mid-block, which is also why patch_flf reads it. `params` overrides for one
    run, same reasoning as `_block_model`.

    A block the planner marked `fight` also gets the COMBAT adapter, unless it
    is already picked or `fight` was turned off. Measured on two unrelated
    scenes at a fixed seed: +40.7% and +71.0% in-shot motion against a ±1%
    nondeterminism floor, and the difference is visible rather than statistical
    — without it H3 throws a punch and then RESETS TO GUARD (the "attack ->
    reset loop" the adapter's author says V2 moves away from) and the written
    choreography simply does not happen.

    STRENGTH 1.0 AND NO TRIGGER, both measured rather than assumed. A third arm
    adding the author's own `prfight2, prfin1` came back 18.5% SOFTER than the
    control where plain combat was 85.6% sharper — the blur failure he warns
    about at high intensity. His own guidance is to start with no trigger, and
    that is the arm that won.
    """
    p = params if params is not None else (block.get("params") or {})
    picks = list(p.get("loras") or [])
    wanted = [(FIGHT_LORA, FIGHT_STRENGTH)] if p.get("fight") else []
    if p.get("camera_motion"):
        wanted.append((CAMERA_LORA, CAMERA_STRENGTH))
    if not wanted:
        return picks or None

    def key_of(x):
        return x.get("key") if isinstance(x, dict) else x

    # Only where the model declares it. `lora_stack` would drop an unknown key
    # with a log line, which is fine, but adding one we know is unresolvable
    # would put a misleading entry in the block's stored stack.
    declared = None
    if model:
        # FAIL OPEN. Only a SUCCESSFUL lookup that says the model does not
        # declare the adapter skips it; a lookup that raises adds it anyway,
        # because `resolve.lora_stack` drops an unresolvable key with a log
        # line and no harm, while dropping it here would silently change what
        # a fight block renders on account of a transient. Same rule the
        # visibility lookup follows in worker.py.
        try:
            declared = (R.ensure_model(model) or {}).get("style_loras") or {}
        except Exception:  # noqa: BLE001 — a blip must not restyle the render
            declared = None
    for key, strength in wanted:
        # Never double-add: a user's own pick keeps THEIR strength, since
        # loading one file twice applies it at compounding strength.
        if any(key_of(x) == key for x in picks):
            continue
        if declared is not None and key not in declared:
            continue
        picks.append({"key": key, "strength": strength})
    return picks or None


def resolve(kind):
    return {
        "launch_render": handle_launch_render,
        "master_pass": handle_master_pass,
        "audio_slice": handle_audio_slice,
        "patch_flf": handle_patch_flf,
        "patch_splice": handle_patch_splice,
        "assemble_take": handle_assemble_take,
        "block_from_clip": handle_block_from_clip,
        "video_edit": handle_video_edit,
        "transition_gen": handle_transition_gen,
        "clip_gen": handle_clip_gen,
    }[kind]


# ------------------------------------------------------------- data loads ----
def _load_block(block_id):
    rows = sb.get(f"generation_blocks?id=eq.{block_id}")
    if not rows:
        raise ValueError(f"block {block_id} not found")
    return rows[0]


def _load_context(block):
    """storyboard + episode + project + scenes + beats + bible for a block."""
    story = sb.get(f"storyboards?id=eq.{block['storyboard_id']}")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,code,project_id")[0]
    project = sb.get(f"projects?id=eq.{ep['project_id']}")[0]
    scenes = sb.get(f"scenes?id=in.({','.join(block['scene_ids'])})&order=idx") \
        if block.get("scene_ids") else []
    beats = sb.get(f"beats?id=in.({','.join(block['beat_ids'])})") \
        if block.get("beat_ids") else []
    # order beats by (scene idx, beat idx)
    scene_order = {s["id"]: s["idx"] for s in scenes}
    beats.sort(key=lambda b: (scene_order.get(b["scene_id"], 0), b["idx"]))
    cast_ids, env_id = [], None
    for s in scenes:
        for cid in (s.get("cast_ids") or []):
            if cid not in cast_ids:
                cast_ids.append(cid)
        env_id = env_id or s.get("environment_id")
    cast = sb.get(f"bible_entries?id=in.({','.join(cast_ids)})") if cast_ids else []
    cast.sort(key=lambda c: cast_ids.index(c["id"]))
    env = sb.get(f"bible_entries?id=eq.{env_id}")[0] if env_id else None
    return story, ep, project, scenes, beats, cast, env


def _beats_for_prompt(block, beats, cast_by_id):
    """DB beats -> compiler dicts with content-relative start times.

    Per-beat cast comes from beats.meta.cast (planner-authored: who is
    visibly in frame); the in-action name scan is only the legacy fallback —
    it's what let bystanders leak into shots they had no business in."""
    import image_prompt
    known = {c["name"] for c in cast_by_id.values()}
    out, t = [], 0
    for b in beats:
        dialogue = []
        for d in (b.get("dialogue") or []):
            speaker = cast_by_id.get(d.get("speaker_id"), {}).get("name") or d.get("speaker") or "The speaker"
            dialogue.append({"speaker": speaker, "line": d.get("line", ""),
                             "delivery": d.get("delivery"), "language": d.get("language", "English"),
                             # This dict is a whitelist, so the DP's V.O.
                             # cutaway flag vanishes here unless it is named —
                             # and with it the whole off-screen grammar.
                             **({"offscreen": True} if d.get("offscreen") else {})})
        tagged = [nm for nm in ((b.get("meta") or {}).get("cast") or []) if nm in known]
        if not tagged:
            tagged = [nm for nm in known if nm in (b.get("action") or "")]
        # …and then to who this SHOT names, the same rule that decides which
        # sheets are staged. Without it the two disagree, which is worse than
        # either being wrong alone: measured on the first LTX block, the prose
        # named Miko, Guide Rei and Knight Rei — none of them staged, none of
        # them in the action — while the sheet that WAS staged went unnamed.
        # A beat that names nobody keeps its roster (the pronoun case).
        # …minus V.O. speakers: a line marked `offscreen` must not pull its
        # speaker into the shot it deliberately cuts away from. Per LINE, not
        # per speaker — one unmarked line in the same shot keeps them featured.
        spoken = " ".join(str(d.get("speaker") or "") for d in dialogue
                          if not d.get("offscreen"))
        featured = image_prompt.featured_cast(
            f"{b.get('camera') or ''} {b.get('action') or ''} {spoken}", tagged)
        tagged = featured or tagged
        # Planner-authored positions ({name: "at the teller cage"}) ride the
        # beat meta into the compile — spatial statements the render can obey,
        # filtered to people actually in this shot.
        positions = {nm: pos for nm, pos in
                     (((b.get("meta") or {}).get("positions") or {}).items())
                     if isinstance(pos, str) and pos.strip() and nm in tagged}
        out.append({
            "start_ms": t, "duration_ms": int(b["duration_ms"]),
            "action": b.get("action") or "", "camera": b.get("camera"),
            "dialogue": dialogue, "sfx": b.get("sfx"),
            "cast_names": tagged, "positions": positions,
            # The compiler's cast-close reads the beat's ROSTER off
            # `meta.cast` — and this dict is a whitelist, so for the close's
            # whole life the roster arrived empty and the sentence never
            # fired on a real render, while test_cast_close.py's fixtures
            # (which carry `meta` directly) kept passing. Verified by
            # compiling through this function: close absent without the
            # passthrough, present with it.
            "meta": (b.get("meta") or {}),
        })
        t += int(b["duration_ms"])
    return out


def _slugkey(s):
    """A scene slug, comparable across the two spellings that exist.

    The writer declares a prop's scenes in PROSE ("THE PRESS") while a scene's
    own slug is written with underscores ("THE_PRESS"), so the obvious set
    intersection is empty and a prop that names its scenes is skipped
    EVERYWHERE — strictly worse than declaring none, which stages globally.
    Measured on TEMPLE DUEL: `Temple staff` and `Altar candles` both declared
    ['THE MEASURE', 'THE PRESS', 'THE LESSON'] and neither was ever staged as
    a look reference on any block of any of those three scenes. Nothing
    errored; the filter did exactly what it says.
    """
    return re.sub(r"[^A-Z0-9]+", "", str(s or "").upper())


def _props_for_scenes(project_id, slugs):
    """Bible props declared for these scenes -> [{name, look}], the single
    source for the compiler's equipment line AND the reviewer's contract (so
    the judge holds a take to the same object list the render was asked for).
    A prop with no declared scenes is global. Empty on any load hiccup."""
    try:
        rows = sb.get(f"bible_entries?project_id=eq.{project_id}&kind=eq.prop"
                      f"&select=name,identity_line,doc")
    except Exception as e:  # noqa: BLE001 — props enrich, never block
        log(f"props unavailable: {e}")
        return []
    want = {_slugkey(s) for s in slugs if s}
    out = []
    for r in rows:
        doc = r.get("doc") or {}
        declared = {_slugkey(x) for x in (doc.get("scenes") or [])}
        if declared and want and not (declared & want):
            continue
        look = r.get("identity_line")
        # A readable prop's exact text rides the look: H3 typesets its own
        # words onto documents, signs and screens unless told what they say.
        if doc.get("reads"):
            look = f"{look or r['name']}; it reads \"{doc['reads']}\""
        out.append({"name": r["name"], "look": look})
    return out[:4]


def _stage_asset(asset, jid, tag, i=0):
    """Download a registered asset into ComfyUI's input dir."""
    ext = os.path.splitext(asset["b2_key"])[1] or ".png"
    name = f"neon_{tag}_{jid}_{i}{ext}"
    media.b2_get(asset["b2_key"], os.path.join(COMFY_ROOT, "input", name))
    return name


def _stage_with_ops(asset, jid, tag, ops):
    """Stage an asset for ComfyUI with a timeline clip's own VISUAL ops baked
    in — a few seconds of ffmpeg instead of a node in the graph.

    Motion context hands `VHS_LoadVideo` the predecessor's own file, so on a
    clip carrying `flip h` the pinned MOTION was mirrored against the picture
    anchor (which `clipRaster` fixes on the browser side). VHS has no filter
    input, so the alternative was a transform node spliced into the graph —
    another dependency, another signature to fit, for something ffmpeg is
    already doing to these exact ops three lines away in `build_clip_filter`.
    Reusing that builder is also what keeps ONE implementation of the geometry:
    the context video is filtered by the same chain the timeline renders with.

    `fit=False` because the frame grid here belongs to the H3 render, not to
    the timeline — normalising would letterbox a window the model is about to
    encode. Falls back to the plain staged file on any failure: a mirrored
    context is a quality wobble, a failed extend is a dead job.
    """
    name = _stage_asset(asset, jid, tag)
    from handlers.render import build_clip_filter
    try:
        vf, _af = build_clip_filter(ops or [], width=0, height=0, fps=24,
                                    has_audio=False, fit=False)
    except Exception as e:
        log(f"{tag}: could not build a filter for {len(ops or [])} op(s): {e}")
        return name
    if not vf:
        return name
    src = os.path.join(COMFY_ROOT, "input", name)
    out_name = f"neon_{tag}ops_{jid}_0.mp4"
    out = os.path.join(COMFY_ROOT, "input", out_name)
    try:
        # THE AUDIO MUST SURVIVE. `-an` here failed the render outright:
        # `_wire_motion_context` wires `context_audio` to the SAME VHS node, so
        # a silent file makes it throw ("VHS failed to extract audio"). It
        # would also have thrown away half the feature — motion context pins
        # the predecessor's waveform as well as its movement. Copied rather
        # than re-encoded: the visual ops do not change the duration, so the
        # stream is still in step.
        media.run_ff(["-i", src, "-vf", vf, "-c:a", "copy",
                      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16",
                      "-preset", "veryfast", out], f"{tag}-ops")
    except Exception as e:
        log(f"{tag}: op pre-pass failed ({e}) — pinning the raw clip instead")
        return name
    log(f"{tag}: applied the clip's own ops before staging ({vf})")
    return out_name


def _exchange_slots_for_block(planned, beats, project_id, force_line=False):
    """The block's >3-line dialogue as placed conversation clip(s).

    Lines group into runs of consecutive dialogue shots; each multi-line run
    becomes ONE recorded conversation (the plan-time run clip named on the
    beats when it matches — shots were CUT to that recording, so it fits by
    construction — else a fresh text-to-dialogue synth), and a lone line
    stays a per-line clip. Placement is solved, never hoped for:
    `place_exchange` finds the one clip offset that puts every line inside
    its planned shot and this returns None when the recorded pacing cannot
    fit the cuts — the caller then falls back to timbre refs rather than
    letting a line straddle a cut.

    `force_line` stages every line as its own clip instead, ignoring runs.
    That is the A/B lever, and the question it settles is real: measured
    across E2's active takes, exchange blocks averaged 1.36 dialogue issues
    each against 0.17 for blocks staged per line. The exchange path was
    adopted on a single-block comparison; this is how the fourteen-block
    result gets tested rather than argued about."""
    import dialogue_synth as DS

    if force_line:
        slots = [{"kind": "line",
                  "asset_id": DS._ensure_line_asset(it, project_id), **it}
                 for it in planned]
        if len(slots) > DS.MAX_AUDIO_SLOTS:
            log(f"force_line: {len(slots)} lines exceed the "
                f"{DS.MAX_AUDIO_SLOTS} audio slots — timbre refs instead")
            return None
        log(f"force_line: {len(slots)} per-line clip(s) staged (A/B)")
        return slots

    windows, t = {}, 0
    has_dlg = {}
    for i, b in enumerate(beats):
        windows[i + 1] = (t, t + int(b["duration_ms"]))
        has_dlg[i + 1] = bool(b.get("dialogue"))
        t += int(b["duration_ms"])
    run_of, r, prev = {}, 0, False
    for idx in range(1, len(beats) + 1):
        if has_dlg[idx]:
            if not prev:
                r += 1
            run_of[idx] = r
        prev = has_dlg[idx]

    groups = {}
    for it in planned:
        groups.setdefault(run_of.get(it["shot_idx"], 0), []).append(it)

    slots = []
    for _rid, run_items in sorted(groups.items()):
        pinned = any(((beats[it["shot_idx"] - 1].get("meta") or {}).get("xchg"))
                     for it in run_items)
        if len(run_items) == 1 and not pinned:
            it = run_items[0]
            slots.append({"kind": "line",
                          "asset_id": DS._ensure_line_asset(it, project_id), **it})
            continue
        # The seam-split fallback (one mini-exchange per shot when whole-run
        # placement failed) is GONE. It looked like a graceful degradation and
        # measured as a total one: E2's b21 staged 3 slots from a split run and
        # the reviewer scored all four lines at 0% spoken. Falling back to
        # timbre refs loses the exact performance but still renders speech;
        # the split lost the speech. A worse fallback than the fallback is not
        # a fallback.
        entry = _exchange_entry(run_items, beats, windows, project_id)
        if entry is None:
            return None
        slots.append(entry)
    if len(slots) > DS.MAX_AUDIO_SLOTS:
        log(f"exchange: {len(slots)} dialogue runs exceed the "
            f"{DS.MAX_AUDIO_SLOTS} audio slots — timbre refs instead")
        return None
    return slots


def _exchange_entry(run_items, beats, windows, project_id):
    """One run's lines -> a placed exchange slot, or None when infeasible."""
    import dialogue_synth as DS

    asset = lines = None
    aids = {(((beats[it["shot_idx"] - 1].get("meta") or {}).get("xchg") or {})
             .get("asset_id")) for it in run_items}
    aids.discard(None)
    if len(aids) == 1:
        a = sb.asset_by_id(next(iter(aids)))
        meta_lines = ((a or {}).get("meta") or {}).get("lines") or []
        if a and meta_lines:
            # Match this block's lines into the run clip by text, in order —
            # a run can span two blocks, so the block may hold only part.
            # Identity (shot_idx/order) always comes from `run_items`: the
            # cached clip's numbering is run-relative, this block's is not.
            picked, picked_idx, j = [], [], 0
            for it in run_items:
                hit = next((k for k in range(j, len(meta_lines))
                            if (meta_lines[k].get("line") or "").strip()
                            == it["line"].strip()), None)
                if hit is None:
                    picked = None
                    break
                ml = meta_lines[hit]
                picked.append({**it, "t0_ms": ml["t0_ms"], "t1_ms": ml["t1_ms"]})
                picked_idx.append(hit)
                j = hit + 1
            if picked:
                asset, lines = a, picked
                if len(meta_lines) != len(picked):
                    # Cut generously: whisper stamps the first word after a
                    # silence LATE, so a tight head margin decapitates the
                    # line ("This was—" gone, measured on block 6's retake).
                    # 700ms each way, clamped inside the neighboring lines'
                    # recorded spans so no foreign words ride along.
                    first, last = picked_idx[0], picked_idx[-1]
                    lo_min = (meta_lines[first - 1]["t1_ms"] + 100
                              if first > 0 else 0)
                    lo = max(lo_min, min(picked[0]["t0_ms"] - 700,
                                         picked[0]["t0_ms"]))
                    hi = picked[-1]["t1_ms"] + 700
                    if last + 1 < len(meta_lines):
                        hi = max(picked[-1]["t1_ms"] + 100,
                                 min(hi, meta_lines[last + 1]["t0_ms"] - 100))
                    pid = DS.exchange_portion(a, lo, hi, project_id)
                    asset = sb.asset_by_id(pid)
                    lines = [{**l, "t0_ms": l["t0_ms"] - lo,
                              "t1_ms": l["t1_ms"] - lo} for l in picked]
    if asset is None:
        x = DS.ensure_exchange_asset(run_items, project_id)
        asset = sb.asset_by_id(x["asset_id"])
        lines = [{**it, "t0_ms": xl["t0_ms"], "t1_ms": xl["t1_ms"]}
                 for it, xl in zip(run_items, x["lines"])]
    # Placement needs the clip's own length against the block's: a clip that
    # overhangs the segment end loses its tail no matter where it starts, and
    # the per-line windows cannot see that (E2 staged three overhanging clips
    # and every one came back DIALOGUE_PARTIAL / DIALOGUE_CUTOFF).
    block_ms = max((s1 for _s0, s1 in windows.values()), default=0)
    p = DS.place_exchange(lines, windows,
                          clip_ms=int(asset.get("duration_ms") or 0),
                          block_ms=block_ms)
    if p is None:
        log(f"exchange: {int(asset.get('duration_ms') or 0)}ms clip does not "
            f"fit the planned cuts in {block_ms}ms — timbre refs instead")
        return None
    slot_lines = [{"speaker": l["speaker"], "line": l["line"],
                   "shot_idx": l["shot_idx"], "order": l["order"],
                   "at_ms": max(0, p + l["t0_ms"] - windows[l["shot_idx"]][0])}
                  for l in lines]
    start_shot = next((i for i, (s0, s1) in sorted(windows.items())
                       if s0 <= p < s1), 1)
    return {"kind": "exchange", "asset_id": asset["id"], "lines": slot_lines,
            "start": {"shot_idx": start_shot,
                      "at_ms": p - windows[start_shot][0]}}


def _chain_frame_asset(block, payload):
    """The concrete last-frame asset for Picture 1: retakes carry it in the
    payload; first generations resolve it from the chained block's active
    take at execution time (their job depends on that pass)."""
    if payload.get("prev_frame_asset_id"):
        return sb.asset_by_id(payload["prev_frame_asset_id"])
    src_id = block.get("chain_from_block_id")
    if not src_id:
        return None
    src = _load_block(src_id)
    take_id = src.get("active_take_id")
    if not take_id:
        # Name the block the way the UI does and say what to do — a bare uuid
        # is not something anyone can act on from the queue view.
        raise ValueError(
            f"this block opens on block {src.get('idx')}'s final frame, but block "
            f"{src.get('idx')} has not rendered yet (status {src.get('status')}). "
            f"Render it first, or clear the chain to start this block fresh.")
    take = sb.get(f"block_takes?id=eq.{take_id}")[0]
    take_asset = sb.asset_by_id(take["asset_id"])
    frame_id = (take_asset.get("meta") or {}).get("last_frame_asset_id")
    if not frame_id:
        raise ValueError(f"take {take_id} carries no last-frame asset")
    return sb.asset_by_id(frame_id)


def _lyrics_in_window(story, block, warmup_ms):
    """Storyboard lyrics inside this block's window, shifted render-relative."""
    lyr = ((story.get("audio_meta") or {}).get("lyrics")) or []
    t0, t1 = block["t_start_ms"], block["t_end_ms"]
    out = []
    for l in lyr:
        a, b = int(l.get("t0", l.get("t0_ms", 0))), int(l.get("t1", l.get("t1_ms", 0)))
        if a < t1 and b > t0:
            out.append({"t0_ms": a - t0 + warmup_ms, "t1_ms": b - t0 + warmup_ms,
                        "text": l.get("text", ""), "singer": l.get("singer")})
    return out


def _prev_closing(block):
    """What the chained-from block ended on — its final shot's action and last
    spoken line — so a continuation continues the moment instead of restarting
    it. beat_ids are stored in chronological order by launch_render."""
    src_id = block.get("chain_from_block_id")
    if not src_id:
        return None
    try:
        src = _load_block(src_id)
        if not src.get("beat_ids"):
            return None
        rows = sb.get(f"beats?id=eq.{src['beat_ids'][-1]}&select=action,dialogue")
        if not rows:
            return None
        b = rows[0]
        out = (b.get("action") or "").strip()[:180]
        last_line = next((d for d in reversed(b.get("dialogue") or []) if d.get("line")), None)
        if last_line:
            # Describe that the line happened; NEVER quote it. A verbatim
            # quote in the compile is a line H3 can perform — live blocks 8/9
            # opened by re-speaking the previous block's closing line (often
            # in the wrong mouth), which squeezed their own dialogue off the
            # end of the shot. The echo was text-driven: the re-spoken line
            # was seconds long while the pinned audio context is under one.
            who = (last_line.get("speaker") or "someone").split(" — ")[0].strip()
            out += f" — with {who}'s final line already spoken there in full"
        return out or None
    except Exception as e:  # noqa: BLE001 — context, not correctness
        log(f"prev_closing unavailable: {e}")
        return None


# How much of the predecessor's TAIL is handed to the motion-context node.
# 72 frames is 3s at 24fps: enough for the node to read a run of motion, short
# enough that VHS is not decoding a whole 15s take to use its last second.
# master_pass has computed the same number inline since it shipped.
CTX_TAIL_F = 72


def _motion_ctx_wanted(block, payload, params=None):
    """Motion-context chaining (ComfyUI-H3-Motion-Context): continues motion
    and audio through the join instead of re-deciding from a still frame.

    Default ON for chained blocks since the live probe validated the wiring —
    the last-frame-only anchor is what made a chained block re-perform its
    predecessor's final action ("she puts the shard down twice"): H3 opened on
    the right pixels but re-decided the motion. Opt out per block
    (params.motion_ctx=false) or per box (H3_MOTION_CTX=0); a missing node
    pack still falls back to the plain anchor, never fails the render.

    `params` is the run's merged params when the caller has them — a re-render
    that passes motion_ctx at the top level then overrides the block's stored
    value rather than losing to it."""
    want = (params if params is not None
            else (block.get("params") or {})).get("motion_ctx")
    if want is None:
        want = payload.get("motion_ctx")
    if want is None:
        want = os.environ.get("H3_MOTION_CTX", "1") != "0"
    if not want:
        return False
    from handlers import images as I
    if not I._has_node("MiniMaxH3MotionContext"):
        log("motion_ctx wanted but MiniMaxH3MotionContext is not installed — "
            "falling back to the last-frame chain anchor")
        return False
    # The pack we ship (MultiRef) emits NATIVE guide records and hard-refuses on
    # a ComfyUI older than PR #15439 — it raises inside the node, i.e. it fails
    # the render rather than degrading. _has_node cannot see that: the node
    # imports perfectly well on an old core and only dies when it executes. The
    # core's own MiniMaxH3AddGuide is the marker that shipped with that PR, so
    # ask for it and take the fallback instead of losing the block.
    if not I._has_node("MiniMaxH3AddGuide"):
        log("motion_ctx wanted but this ComfyUI predates MiniMaxH3AddGuide "
            "(core PR #15439), which the installed pack requires — falling "
            "back to the last-frame chain anchor. Upgrade ComfyUI to enable it.")
        return False
    return True


def _chain_take_video(block, jid):
    """Stage the chained-from block's active take (the trimmed VIDEO, not just
    its last frame) for motion-context. Returns (staged_name, duration_ms)."""
    src_id = block.get("chain_from_block_id")
    if not src_id:
        return None, 0
    src = _load_block(src_id)
    take_id = src.get("active_take_id")
    if not take_id:
        return None, 0
    take = sb.get(f"block_takes?id=eq.{take_id}")[0]
    asset = sb.asset_by_id(take["asset_id"])
    if not asset:
        return None, 0
    return _stage_asset(asset, jid, "ctx"), int(asset.get("duration_ms") or 0)


def _chain_latent(block):
    """Absolute path of the chained-from block's newest saved AV latent, or
    None. Every H3 master saves its sampler latent under
    output/h3_context/<block_id>/ (resolve._wire_context_save); the newest
    file is the latest take of that block — a retake's latent wins, which is
    what a re-render downstream should continue from. The worker shares the
    box with ComfyUI, so a plain existence check here is the guard that keeps
    a missing file degrading to the frames path instead of failing the graph."""
    src_id = block.get("chain_from_block_id")
    if not src_id:
        return None
    folder = os.path.join(COMFY_ROOT, "output", "h3_context", str(src_id))
    try:
        files = sorted((os.path.join(folder, f) for f in os.listdir(folder)
                        if f.endswith(".safetensors")), key=os.path.getmtime)
        return files[-1] if files else None
    except OSError:
        return None


def _next_opening(block):
    """What the following block expects to see first (for the Continuity line)."""
    rows = sb.get(f"generation_blocks?storyboard_id=eq.{block['storyboard_id']}"
                  f"&idx=eq.{block['idx'] + 1}&select=id,beat_ids,chain_from_block_id")
    if not rows or rows[0].get("chain_from_block_id") is None:
        return None
    nxt = rows[0]
    if not nxt.get("beat_ids"):
        return None
    beats = sb.get(f"beats?id=in.({','.join(nxt['beat_ids'])})&order=idx&limit=1")
    return beats[0].get("action") if beats else None


# Flags that shape how a BLOCK renders rather than how the episode is planned.
# `handle_master_pass` reads them off `block.params` (or its own payload), and
# the master's payload carries only block_id/dims — so a caller who puts one at
# the top level of a launch_render payload gets silence: the flag reaches
# nothing and the episode renders as if it were never set. That is exactly what
# happened to `el_dialogue=false` on a live 29-block run, which staged
# ElevenLabs line clips through all of it. Copy them onto the block instead of
# adding a note telling the next caller to nest them by hand.
#
# `loras` belongs here for the same reason `model_key` does — they are one
# pick, and leaving the stack out meant a re-render could change the
# checkpoint and silently keep the previous adapters.
_BLOCK_FLAGS = ("el_dialogue", "force_line_clips",
                "motion_ctx", "model_key", "loras", "steps", "prompt_extra",
                "refine", "split_pass", "fight", "locked_kind",
                # the camera adapter, stamped at plan time — see camera_moves —
                # and the latent-upscale second pass in resolve.py. No
                # parentheses in these comments: jobPrompt.test.ts parses this
                # tuple up to the first closing paren.
                "camera_motion", "latent_upscale",
                # Whether the environment's ONE picture slot carries its
                # coverage contact sheet or its plain master plate — see
                # `ref_plan_for`. Default true; false pins the master back,
                # which is what an A/B of the two arms is run on.
                "env_coverage",
                "dialogue_audio", "sheet_asset_id")


def _block_params(payload):
    """`payload.params`, plus any block-shaping flag passed at the top level."""
    params = dict(payload.get("params") or {})
    for k in _BLOCK_FLAGS:
        if k in payload and k not in params:
            params[k] = payload[k]
    return params


# How many PICTURES one block may stage. Nine is H3's ceiling and slot 1 is
# reserved for the chain anchor, so eight.
PICTURE_CAP = 8
# …and identity never falls below this, whatever else is competing: a face
# nobody staged is a face H3 invents, which is the artifact every reference in
# the plan exists to prevent.
IDENT_FLOOR = 2


def _ref_section(entry):
    """Which claim on the slot budget this plan entry represents."""
    purpose = entry.get("purpose")
    if purpose in ("start_frame", "end_frame", "block_sheet"):
        # A segment storyboard is "deliberate" because it is the one picture
        # that carries EVERY shot of the block. Truncating it is not losing a
        # reference, it is losing the block's composition entirely — and it is
        # what the per-beat panels were traded away for.
        return "deliberate"
    if purpose == "look" and entry.get("role") == "prop":
        return "prop"
    if purpose == "look" and entry.get("beat_id"):
        return "deliberate"          # a still the user designated on a beat
    if purpose == "character":
        return "ident"
    if purpose == "environment":
        return "env"
    if purpose == "scene_ref":
        return "panel"
    return "prop"                    # auto scene stills etc — lowest claim


def budget_refs(plan, cap=PICTURE_CAP):
    """Fit a block's picture plan into the slot budget. Pure.

    This was `plan[:8]`, which truncated whatever came LAST — and identity is
    assembled first, so the tail it cut was the location master, the
    storyboard panels and the props, in that order. An outfit variant costs
    TWO pictures (the parent's face plate for identity, its own full body for
    the wardrobe), so five cast members fill the budget on their own.

    Measured on Rei E4 before this existed: **5 of 17 blocks would have
    rendered with no location plate at all** and 6 with no panel — in an
    episode whose standing complaint was that the location kept drifting. The
    plate is ONE picture that anchors the whole segment; the eighth identity
    picture is a second view of a fifth character. Nothing errored, because
    truncation is not an error.

    Order of claim: user-designated frames never yield (they are the one thing
    a human explicitly asked for), the environment master outranks the tail of
    identity, panels take up to two but only what identity can spare above
    IDENT_FLOOR, and props take what is left. Relative ORDER is preserved for
    whatever survives — `<Picture N>` is positional, and identity holding the
    strong slots is the existing, measured design.
    """
    keep = {"deliberate": [], "env": [], "ident": [], "panel": [], "prop": []}
    for e in plan:
        keep[_ref_section(e)].append(e)
    room = max(0, cap - len(keep["deliberate"]))
    env = keep["env"][:1] if room else []
    room -= len(env)
    # Panels may only take what identity can spare above its floor.
    n_pan = min(2, len(keep["panel"]), max(0, room - IDENT_FLOOR))
    ident = keep["ident"][:max(0, room - n_pan)]
    room -= len(ident) + n_pan
    allowed = {id(e) for e in
               keep["deliberate"] + env + ident + keep["panel"][:n_pan]
               + keep["prop"][:max(0, room)]}
    return [e for e in plan if id(e) in allowed]


class RefPlanCtx:
    """Everything `ref_plan_for` needs that is not the block itself.

    Built once per storyboard by launch_render, which loops it over every
    block, and once per block by master_pass, which recomputes ONE plan so a
    re-render picks up sheets that changed after the episode was planned — a
    new outfit variant, a recast voice, a redrawn location. Before this was
    reachable outside launch_render, a re-rendered block restaged the sheets
    the episode was planned with, so a costume change could never reach the
    picture.
    """
    __slots__ = ("scenes", "beats_by_id", "entries_by_name", "project_id",
                 "locked", "panel_refs", "scene_stills")

    def __init__(self, scenes, beats_by_id, entries_by_name, project_id,
                 locked=False, panel_refs=True, scene_stills=False):
        self.scenes = scenes
        self.beats_by_id = beats_by_id
        self.entries_by_name = entries_by_name
        self.project_id = project_id
        self.locked = locked
        self.panel_refs = panel_refs
        self.scene_stills = scene_stills


def ref_plan_ctx(scenes, beats, project_id, locked=False, payload=None):
    """Load the ctx. `payload` is a render job's — the two opt-outs it carries
    (`panel_refs`, its old name `grid_refs`, and `scene_stills`) mean the same
    thing on a re-render as they do on the launch that planned the block."""
    payload = payload or {}
    # Only characters visibly present in one of the block's BEATS get identity
    # refs (beat meta.cast; scene cast is the fallback) — a character on
    # another street must not ride along into the prompt.
    entries_by_name = {e["name"].lower(): e
                       for e in sb.get(f"bible_entries?project_id=eq.{project_id}"
                                       f"&select=id,name,kind")}
    return RefPlanCtx(
        scenes=scenes,
        beats_by_id={b["id"]: b for b in beats},
        entries_by_name=entries_by_name,
        project_id=project_id,
        locked=locked,
        panel_refs=bool(payload.get("panel_refs", payload.get("grid_refs", True))),
        scene_stills=bool(payload.get("scene_stills")),
    )


def ref_plan_for(block, ctx, params=None):
    """`params` is the EFFECTIVE params for this pass, not the block's stored
    ones. They differ on a re-render carrying a per-job override without
    `persist_params` — which is exactly how the retake modal and the director's
    `rerender_block` work — and `sheet_asset_id` is such an override, so
    reading `block['params']` here would stage the OLD sheet (or none) while
    every other flag on the same job took effect. Defaults to the block's own,
    so `launch_render` is unchanged."""
    env_id = None
    beat_cast_names: list = []
    speakers: set = set()
    scene_cast_ids: list = []
    block_scenes = [s for s in ctx.scenes if s["id"] in block["scene_ids"]]
    for s in block_scenes:
        env_id = env_id or s.get("environment_id")
        for cid in (s.get("cast_ids") or []):
            if cid not in scene_cast_ids:
                scene_cast_ids.append(cid)
    for bid in block["beat_ids"]:
        b = ctx.beats_by_id.get(bid) or {}
        for nm in ((b.get("meta") or {}).get("cast") or []):
            if nm not in beat_cast_names:
                beat_cast_names.append(nm)
        for d in (b.get("dialogue") or []):
            if d.get("speaker"):
                speakers.add(d["speaker"].lower())
    # A beat names the character ("Leon"); the scene may cast an outfit
    # VARIANT of them ("Leon — Trench Coat"). The scene's pick wins, or the
    # block stages the wrong wardrobe for the whole segment.
    scene_cast = (sb.get(f"bible_entries?id=in.({','.join(scene_cast_ids)})"
                         f"&select=id,name") if scene_cast_ids else [])

    def _cast_entry_id(nm):
        n = nm.lower()
        for e in scene_cast:
            en = e["name"].lower()
            if en == n or en.startswith(n + " — "):
                return e["id"]
        return (ctx.entries_by_name.get(n) or {}).get("id")

    # STAGE WHO THE BLOCK'S SHOTS NAME, per beat, unioned — not the roster.
    #
    # `meta.cast` is the cinematographer's list and its own contract says "ONLY
    # the characters visibly in frame", which the model ignores: ASTRONAUT_
    # CAPTURE wrote all six names onto every beat, so a block covering two
    # beats whose actions name two people staged SIX identity sheets, and H3
    # drew all six — measured, the extra four turned up standing in the
    # background of an extreme close-up.
    #
    # The pronoun case CLAUDE.md warns about is handled by the UNION being
    # per-beat with a per-beat fallback: a beat whose own text names nobody
    # ("the two stand in silence") contributes its whole roster, so the party
    # referred to only by a pronoun keeps its sheet. What gets dropped is a
    # name no beat in this block mentions in any way — camera, action or
    # dialogue. Order is first-mention across the block, which is also the
    # slot-1 rule (image1 carries the token budget).
    import image_prompt

    def _beat_text(bid):
        b_ = ctx.beats_by_id.get(bid) or {}
        # A speaker counts as in-frame in the shot carrying their line —
        # EXCEPT a line marked `offscreen`, the DP's V.O. cutaway: counting
        # that voice would stage the speaker's sheet into a block that never
        # frames them, and H3 draws everyone it is handed. Their voice still
        # reaches the render through the recording, the phone-caller path.
        spk = " ".join(str((d or {}).get("speaker") or "")
                       for d in (b_.get("dialogue") or [])
                       if not (d or {}).get("offscreen"))
        return f"{b_.get('camera') or ''} {b_.get('action') or ''} {spk}"

    featured: list = []
    remote: set = set()          # speaks through a device, has no body here
    on_screen: set = set()       # named IN FRAME by at least one beat
    for bid in block["beat_ids"]:
        b_ = ctx.beats_by_id.get(bid) or {}
        roster = [n for n in ((b_.get("meta") or {}).get("cast") or [])]
        shot_text = f"{b_.get('camera') or ''} {b_.get('action') or ''}"
        named = image_prompt.featured_cast(_beat_text(bid), roster)
        on_screen |= set(image_prompt.featured_cast(shot_text, roster))
        # A voice on the far end of a phone has no body in the shot. Computed
        # here rather than read off the beat, so a storyboard planned before
        # this existed is fixed by re-rendering it — which is every storyboard
        # today. See `image_prompt.remote_speakers`.
        remote |= set(image_prompt.remote_speakers(
            shot_text, roster,
            [(d or {}).get("speaker") for d in (b_.get("dialogue") or [])]))
        # a beat that names nobody keeps its roster — see above
        for nm in (named or roster):
            if nm not in featured:
                featured.append(nm)
    # Remote only if NO beat in the block puts them in frame: a character who
    # takes the call and then walks in IS present, and dropping their sheet
    # would un-anchor the half of the block they are in.
    remote -= on_screen
    if remote:
        log(f"ref plan: {', '.join(sorted(remote))} speak(s) through a device "
            f"and appear(s) in no shot — no character sheet staged")
        featured = [n for n in featured if n not in remote]
    # Never let this empty the block: a storyboard whose beats carry no cast at
    # all still needs its people, and the scene's own list is the fallback the
    # rest of this function already relies on.
    beat_cast_names = featured or beat_cast_names
    cast_ids = [i for i in (_cast_entry_id(nm) for nm in beat_cast_names)
                if i] or scene_cast_ids
    plan = []
    voice_plan = []
    # ONE identity picture per PERSON, not per bible row — see the dedup at the
    # append below. base name -> (index in `plan`, is that pick the entry's OWN
    # sheet rather than a parent fallback).
    staged_ident = {}
    for cid in cast_ids:
        entry = sb.get(f"bible_entries?id=eq.{cid}"
                       f"&select=id,name,doc,voice_ref_asset_id")[0]
        # `slot >= 90` is the archive: regen_sheets.py parks a REPLACED
        # sheet there rather than deleting it, so every consumer must
        # exclude it. This query did not, and `{role: r}` over a
        # slot-ASCENDING list is last-wins — so the archived sheet
        # overwrote the live one for every role. Measured on AFTERLIGHT
        # v4: Aki's body reference in a rooftop night scene was her
        # archived PRINT-SHOP UNIFORM plate, which is both the wrong
        # wardrobe and an older, greyer render.
        slots = sb.get(f"bible_assets?entry_id=eq.{cid}&slot=lt.90&order=slot")
        by_role = {}
        for r in slots:
            by_role.setdefault(r["role"], r)      # lowest slot wins
        parent_id = (entry.get("doc") or {}).get("variant_of")
        # ONE identity picture per character, FULL STOP — the same rule the
        # panel path has always applied (`panelSpec.characterAnchor`), and the
        # preference order is the same too.
        #
        # It used to be "one WHEN a turnaround exists", which left outfit
        # variants costing TWO (the parent's face plate for identity plus the
        # variant's own body for the wardrobe) — and an episode that casts a
        # variant for nearly everyone therefore spent EIGHT slots on five
        # people, evicting the location plate and both panels. The sheets
        # already carry what the second picture was for: a turnaround is a
        # face plate (two of its six views are face close-ups) AND the whole
        # costume from six angles, and a variant's own sheet is the only
        # picture of the costume that makes it a variant.
        #
        # The cost, stated honestly: on a variant whose sheet hides the face —
        # Astronaut Rei's suit sheet is rendered helmet-ON — identity now rides
        # on the identity_line and the parent is not staged. Fix that by
        # redrawing the sheet, not by spending a second slot on every
        # character in the cast.
        order = (("full_body", "outfit", "turnaround", "face")
                 if parent_id else
                 ("turnaround", "full_body", "outfit", "face", "master"))
        pick = next((by_role[r] for r in order if r in by_role), None)
        # Whether this is the entry's OWN sheet. A variant's own sheet carries
        # the costume that makes it a variant; a parent fallback does not, so
        # when one person is cast under both spellings the own sheet wins.
        own = pick is not None
        if pick is None and parent_id:
            # A variant with no sheet of its own at all: follow the parent,
            # exactly as `_resolve_anchor` does for panels. The window between
            # creating a variant and rendering its body is honest, and staging
            # nothing would un-anchor the character entirely.
            pslots = sb.get(f"bible_assets?entry_id=eq.{parent_id}&slot=lt.90"
                            f"&order=slot")
            pby = {}
            for r in pslots:
                pby.setdefault(r["role"], r)
            pick = next((pby[r] for r in ("turnaround", "face", "full_body")
                         if r in pby), None)
        picks = [pick or (slots[0] if slots else None)]
        # Reference labels use the character's BASE name (the em-dash
        # suffix is bible organization, not a person): beats, dialogue and
        # the compiler all address "Zara Voss", and a label that says
        # "Zara Voss — courier rig" matches none of them.
        for pick in picks:
            if not pick:
                continue
            base = entry["name"].split(" — ")[0].strip()
            ent = {"purpose": "character", "label": base, "name": base,
                   "role": pick["role"], "asset_id": pick["asset_id"]}
            # ONE PICTURE PER PERSON, and a block routinely casts one person
            # TWICE. `meta.cast` carries whichever spelling the shot used, and
            # the cinematographer mixes them within a scene — so a block whose
            # beats say both "Villian Rei" and "Villian Rei — Glitching capture
            # coat" resolves TWO bible rows for one woman. Both are staged, and
            # since a variant with no sheet of its own follows `variant_of` to
            # the parent's, they are routinely the SAME asset: measured live,
            # `66e0fdf4…` twice in one 8-entry plan, one of eight picture slots
            # spent on a picture already in the set. Where the variant DOES
            # have its own sheet it is worse — two different pictures of one
            # person disagreeing about the wardrobe.
            #
            # Deduped on the BASE name rather than the asset, because that
            # catches both shapes; the asset test only catches the first. The
            # OWN sheet wins whichever order the rows arrive in, and it
            # REPLACES IN PLACE — `<Picture N>` is positional and re-appending
            # would move the person to the back of the ordering that decides
            # who holds image1.
            prior = staged_ident.get(base)
            if prior is None:
                staged_ident[base] = (len(plan), own)
                plan.append(ent)
            elif own and not prior[1]:
                plan[prior[0]] = ent
                staged_ident[base] = (prior[0], True)
        # Voice-timbre reference for anyone who actually speaks in this
        # block (official §2.4). Locked audio owns every audio slot, and
        # Ref2VA takes 3 audios at most — main speakers first, cap 2.
        # An outfit variant is cast under its variant name ("Zara Voss —
        # courier rig") while dialogue speaks as the character ("Zara
        # Voss"), so the match is on the base name before the em-dash.
        voice_id = (entry.get("voice_ref_asset_id")
                    or (sb.get(f"bible_entries?id=eq.{parent_id}"
                               f"&select=voice_ref_asset_id")[0].get("voice_ref_asset_id")
                        if parent_id else None))
        base_name = entry["name"].split(" — ")[0].strip()
        if (not ctx.locked and voice_id and len(voice_plan) < 2
                and base_name.lower() in speakers
                and not any(v["name"] == base_name for v in voice_plan)):
            voice_plan.append({"purpose": "voice", "name": base_name,
                               "label": base_name, "asset_id": voice_id})
    if env_id:
        # ONE PICTURE OF THE PLACE, and which one is a deliberate choice.
        #
        # It used to ask only for the lowest slot, so which of the four plates
        # conditioned the block was arbitrary — measured on AFTERLIGHT v4,
        # COLD-OPEN was handed "The city rooftops · detail", a close-up of one
        # feature, as its only picture of the location. Naming the MASTER fixed
        # that: it is the establishing view every other plate is an angle ON.
        #
        # THE COVERAGE SHEET NOW OUTRANKS IT, and that is the environment's
        # half of a rule the character side has had all along. `ref_plan_for`
        # stages exactly one identity picture per person and prefers the
        # TURNAROUND for it — "six agreeing views at the same slot cost" —
        # while a location, which has the same one-slot budget and a sheet of
        # its own since the coverage take shipped, went on being handed a
        # single frontal frame. `<Picture N>` is positional and the budget is
        # eight, so the grid is free: same slot, eight vantages instead of one.
        #
        # It is also the video side's answer to the complaint `plate_plan`
        # answers for PANELS. That rotation breaks the one-camera lock by
        # handing successive shots different plates; a video block has no
        # rotation at all — it stages the master, every time — so the lock is
        # exactly as installed here as it was there before the ring shipped.
        #
        # HONEST STATUS: unmeasured on a real block. The turnaround's version
        # of this trade is measured and shipped; this one is the same shape on
        # a different subject, and the failure it risks is H3 reproducing the
        # GRID (which `h3_prompt` disclaims twice, in defs and terminally, the
        # way it already does for a segment storyboard). `params.env_coverage
        # = false` pins the master back for the A/B.
        env_roles = ["master"]
        if (params or {}).get("env_coverage", True):
            env_roles.insert(0, "coverage")
        slots = None
        for role in env_roles:
            slots = sb.get(f"bible_assets?entry_id=eq.{env_id}&role=eq.{role}"
                           f"&slot=lt.90&order=slot&limit=1")
            if slots:
                break
        slots = slots or sb.get(f"bible_assets?entry_id=eq.{env_id}"
                                f"&slot=lt.90&order=slot&limit=1")
        if slots:
            ent = {"purpose": "environment", "role": slots[0]["role"],
                   "asset_id": slots[0]["asset_id"]}
            if slots[0]["role"] == "coverage":
                # HOW MANY VIEWS THE SHEET CARRIES, off the asset the take
                # wrote. The compiler has to describe the PICTURE — "the
                # complete eight-view coverage sheet" — and a count derived
                # downstream from the plate rows goes stale the moment a
                # redraw renders a different plan. Same rule, and the same
                # field name, as `block_sheet`'s `panels`. Absent, the
                # compiler says "several" rather than inventing a number.
                a = sb.asset_by_id(slots[0]["asset_id"]) or {}
                meta = a.get("meta") or {}
                if meta.get("views"):
                    ent["views"] = int(meta["views"])
                if meta.get("columns"):
                    ent["columns"] = int(meta["columns"])
            plan.append(ent)
    # An image can enter a block wearing one of two very different hats,
    # and H3 treats them nothing alike:
    #
    #   start_frame — the target video literally opens on this pixel data.
    #                 Fully preserved: composition, lighting, everything.
    #   look        — a design reference (a VFX expert's plate, a colour
    #                 key). We want its rendering, NOT its staging; copying
    #                 its composition would override the shot we planned.
    #
    # The user says which via "use as start frame" on the beat still. Only
    # the block's FIRST beat can contribute a start frame — a frame in the
    # middle of a segment isn't something H3 can open on.
    first_beat = ctx.beats_by_id.get(block["beat_ids"][0]) if block["beat_ids"] else None
    start_id = ((first_beat or {}).get("meta") or {}).get("start_frame_asset_id")
    if start_id:
        plan.insert(0, {"purpose": "start_frame", "role": "first_frame",
                        "beat_id": (first_beat or {}).get("id"), "asset_id": start_id})

    # Every other user-designated beat still in this block is a look
    # reference for that beat's shot — it says what the shot should look
    # like, not where the camera goes. Deliberate picks stage before any
    # auto-generated material, so the slot cap never eats them first.
    for i, bid in enumerate(block["beat_ids"]):
        b = ctx.beats_by_id.get(bid) or {}
        meta = b.get("meta") or {}
        still = meta.get("still_asset_id")
        if not still or still == start_id:
            continue
        plan.append({"purpose": "look", "role": meta.get("ref_role") or "look",
                     "shot_idxs": [i + 1], "beat_id": bid,
                     "label": meta.get("ref_label"),
                     "desc": meta.get("ref_note") or b.get("action"),
                     "asset_id": still})

    # A SEGMENT STORYBOARD REPLACES THE PER-BEAT PANELS, and the two may never
    # both be staged: they are the same claim about composition made twice, and
    # `<Picture N>` is positional, so a shot with a panel AND a sheet is a shot
    # told to open on two different pictures.
    #
    # Why it wins where it exists. Panels are budgeted at TWO per block (there
    # is no room for more beside identity and the plate), so a 4-shot block
    # composes shots 1 and 2 and leaves 3 and 4 with nothing — measured on Rei
    # E3 b13, where the two shots left uncomposed were the gravity gesture and
    # the debris impact, i.e. the whole point of the scene. And panels are
    # separate renders, so they drift: those four came back as four different
    # cities at three times of day, one in daylight with the wrong cast. One
    # sheet is one picture, one grade, one location, every shot — for one slot
    # instead of two. `sheet_asset_id` rides `params` beside the other
    # per-block render flags, so re-rendering a block keeps its own sheet.
    sheet_id = (params if params is not None
                else (block.get("params") or {})).get("sheet_asset_id")
    if sheet_id and ctx.panel_refs:
        n_shots = len(block.get("beat_ids") or []) or 1
        plan.append({"purpose": "block_sheet", "role": "storyboard",
                     "shot_idxs": list(range(1, n_shots + 1)),
                     "panels": n_shots,
                     "label": f"segment storyboard — {n_shots} shots",
                     "asset_id": sheet_id})

    # Storyboard panels ride into the render as scene_ref — the composed
    # shot this segment should stage, framing INTENDED (unlike look, whose
    # framing is explicitly disclaimed). Each is bound to its own shot via
    # shot_idxs, so the compiler says "storyboard reference for [Shot k]".
    # A panel is one render per beat, anchored on the cast's own face
    # sheets and the location master, which is what makes it safe where
    # prose-only scene stills invented faces and were demoted to display.
    # Budget 2 per block; a shot a designated start frame opens outright
    # doesn't also get its panel (two pictures claiming one shot's
    # composition is a contradiction). `panel_refs` is the flag —
    # `grid_refs` is its old name from when panels were sliced out of a
    # per-scene grid, honoured so existing launch payloads keep working.
    if ctx.panel_refs and not sheet_id:
        staged_panels = 0
        for i, bid in enumerate(block["beat_ids"]):
            if staged_panels >= 2:
                break
            b = ctx.beats_by_id.get(bid) or {}
            pid = (b.get("meta") or {}).get("panel_asset_id")
            if not pid or pid == start_id:
                continue
            if i == 0 and start_id:
                continue
            plan.append({"purpose": "scene_ref", "role": "storyboard",
                         "shot_idxs": [i + 1], "beat_id": bid,
                         "label": f"storyboard panel — shot {i + 1}",
                         "desc": (b.get("action") or "")[:160] or None,
                         "asset_id": pid})
            staged_panels += 1

    # Plot-critical props ride as look references so the object on screen
    # is the object designed — readables (documents, photos, signs, maps)
    # above all, since H3 typesets its own text onto anything it invents.
    # Look semantics fit exactly: rendering followed, framing disclaimed
    # (a product-photograph sheet's staging must not become the shot).
    try:
        prows = sb.get(f"bible_entries?project_id=eq.{ctx.project_id}"
                       f"&kind=eq.prop&select=id,name,identity_line,doc")
        slug_set = {_slugkey(s.get("slug")) for s in block_scenes}
        staged_props = 0
        for pr in prows:
            if staged_props >= 2:
                break
            pdoc = pr.get("doc") or {}
            declared = {_slugkey(x) for x in (pdoc.get("scenes") or [])}
            if declared and slug_set and not (declared & slug_set):
                continue
            # A FIXTURE is already IN the environment plate — it was edited
            # into the master (see the dressed-master pass), so staging its
            # sheet too hands H3 the same object twice and it renders it
            # twice. Measured: the scaffold KEEP-OUT sign came back once
            # filling the foreground and again on the scaffold behind, at
            # two different scales, in the same frame. One object, one
            # reference; the plate is the one that knows where it goes.
            if pdoc.get("fixed_to"):
                continue
            pslots = sb.get(f"bible_assets?entry_id=eq.{pr['id']}"
                            f"&slot=lt.90&order=slot&limit=1")
            if not pslots:
                continue
            desc = pr.get("identity_line") or pr["name"]
            if pdoc.get("reads"):
                desc = f"{desc}; its exact visible text: \"{pdoc['reads']}\""
            scene_id = next((s["id"] for s in block_scenes
                             if not declared or _slugkey(s.get("slug"))
                             in declared), None)
            plan.append({"purpose": "look", "role": "prop",
                         "label": pr["name"], "desc": desc,
                         **({"scene_id": scene_id} if scene_id else {}),
                         "asset_id": pslots[0]["asset_id"]})
            staged_props += 1
    except Exception as e:  # noqa: BLE001 — props enrich, never block
        log(f"prop refs unavailable: {e}")

    # Auto-generated scene stills are DISPLAY ONLY now. They used to ride
    # into blocks as scene_ref/look pictures, and a still whose faces and
    # staging came from prose (no cast refs) would hijack the segment
    # mid-shot — the render suddenly matching a panel that had the wrong
    # people in it. A user-designated beat still (meta.still_asset_id /
    # start_frame, set in the scene editor) is deliberate and still
    # staged above; the planner's own vfx panels stay on the scene card.
    if ctx.scene_stills:
        for s in block_scenes:
            vfx = (s.get("meta") or {}).get("vfx") or {}
            sid_asset = s.get("still_asset_id")
            if sid_asset and sid_asset != start_id:
                plan.append({"purpose": "look" if vfx else "scene_ref", "scene_id": s["id"],
                             "label": vfx.get("name") or s.get("slug"),
                             "desc": vfx.get("prompt") or s.get("scene_prompt"),
                             "role": "vfx" if vfx else "storyboard",
                             "asset_id": sid_asset})
    # Image refs capped to leave room for the chain anchor in slot 1;
    # voice entries ride along uncapped by that budget (they are AUDIO
    # slots, a different family with its own ceiling of 3). `budget_refs`
    # rather than `plan[:8]` — see its docstring for what the plain
    # truncation was measured to cut.
    return budget_refs(plan) + voice_plan


# ----------------------------------------------------------- launch render ---
def _beat_label(scene, beat):
    slug = (scene.get("slug") or scene.get("name") or scene["id"][:8])
    return f"{slug} b{int(beat.get('idx') or 0) + 1}"


def _refit_measured_beats(scenes, scene_beats, project_id, jid=None):
    """Grow every dialogue beat to fit its MEASURED lines, in place and in the
    database. Growth only — never a ceiling, because a line squeezed below
    speaking time is the DIALOGUE_CUTOFF this pipeline spent months removing,
    while a shot that is a beat too long is a held picture.

    Mutates the beat dicts in `scene_beats` so the caller's planner sees the
    new numbers, and re-sums each touched scene.

    Returns (grown_ms, n_shots, unmeasured) and RAISES NOTHING: a TTS engine
    that is down must not kill a render (the ref path synthesizes each line at
    render time regardless — only the FIT is lost). But what it does not do is
    fail silently: every beat it could not measure comes back named, because
    an episode whose dialogue timing was never measured is exactly what burns
    an afternoon of GPU time and reads as a model problem.
    """
    import dialogue_synth as DS
    grown = touched = 0
    unmeasured = []
    try:
        cast = sb.get(f"bible_entries?project_id=eq.{project_id}"
                      f"&kind=eq.character&select=id,name,identity_line,doc")
    except Exception as e:      # noqa: BLE001
        log(f"measured dialogue timing SKIPPED — could not read the cast: {e}")
        return 0, 0, ["the whole storyboard (cast unreadable)"]

    for s in scenes:
        changed = False
        for b in scene_beats[s["id"]]:
            if not (b.get("dialogue") or []):
                continue
            items = DS.plan_lines([{"dialogue": b["dialogue"]}], cast)
            if not items:
                # `plan_lines` returns nothing for THREE reasons and cannot be
                # asked which: an uncast speaker (the same condition that
                # takes the dialogue spine down, and the reason one half-cast
                # character can cost a whole storyboard its timing), or more
                # speakers in one shot than MAX_AUDIO_SLOTS can carry. Naming
                # a cause it does not know would send someone to the bible
                # looking for a casting bug that is really a slot budget, so
                # it reports the fact and lists the candidates.
                unmeasured.append(
                    f"{_beat_label(s, b)} (no staging plan — an uncast "
                    f"speaker, or too many speakers in one shot)")
                continue
            try:
                durs = DS.measure_lines(items, project_id)
            except Exception as e:      # noqa: BLE001
                unmeasured.append(f"{_beat_label(s, b)} ({e})")
                continue
            floor = DS.shot_floor_from_measured(
                [durs.get(it["order"]) for it in items])
            cur = int(b.get("duration_ms") or 0)
            if floor > cur:
                try:
                    sb.patch(f"beats?id=eq.{b['id']}", {"duration_ms": floor})
                except Exception as e:      # noqa: BLE001
                    unmeasured.append(f"{_beat_label(s, b)} (not saved: {e})")
                    continue
                b["duration_ms"] = floor
                grown += floor - cur
                touched += 1
                changed = True
        if changed:
            total = sum(int(x.get("duration_ms") or 0)
                        for x in scene_beats[s["id"]])
            try:
                sb.patch(f"scenes?id=eq.{s['id']}", {"duration_ms": total})
            except Exception as e:      # noqa: BLE001
                log(f"scene {s['id'][:8]} duration not re-summed: {e}")

    if touched:
        log(f"measured dialogue timing: {grown:+d}ms across {touched} shot(s)")
    else:
        log("measured dialogue timing: every dialogue shot already fits")
    if unmeasured:
        # LOUD. This is the state that produced a 7.71s line in a 7.00s shot.
        log(f"measured dialogue timing INCOMPLETE — {len(unmeasured)} shot(s) "
            f"kept the words-per-second estimate: {'; '.join(unmeasured[:6])}"
            + (f" (+{len(unmeasured) - 6} more)" if len(unmeasured) > 6 else ""))
    if jid:
        note = f"Timing: {grown / 1000:+.1f}s across {touched} shot(s)"
        if unmeasured:
            note += f" — {len(unmeasured)} NOT measured (uncast or TTS down)"
        try:
            sb.job_progress(jid, 0.05, note=note)
        except Exception:      # noqa: BLE001
            pass
    return grown, touched, unmeasured


def handle_launch_render(job):
    """Turn an approved storyboard into generation_blocks + the job DAG.

    One cpu job plans everything server-side: run the deterministic planner
    over scenes/beats, insert block rows with their ref plans, then enqueue
    per-block chains (audio_slice → master_pass), each master depending on the
    previous block's master so chain anchors exist when needed. Blocks are
    enqueued ready-one-at-a-time via deps, so an interactive retake never
    waits more than one pass.
    """
    import planner

    payload = job.get("payload") or {}
    sid = payload["storyboard_id"]
    story = sb.get(f"storyboards?id=eq.{sid}")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,code,project_id")[0]
    project = sb.get(f"projects?id=eq.{ep['project_id']}")[0]
    scenes = sb.get(f"scenes?storyboard_id=eq.{sid}&order=idx")
    if not scenes:
        raise ValueError("storyboard has no scenes")
    scene_beats = {s["id"]: sb.get(f"beats?scene_id=eq.{s['id']}&order=idx") for s in scenes}
    beats_by_id = {b["id"]: b for bl in scene_beats.values() for b in bl}
    beats_ms = (story.get("audio_meta") or {}).get("beats_ms")
    locked = bool(story.get("audio_asset_id")) and project["medium"] == "music_video"

    # ---- measured dialogue timing, BEFORE the planner packs blocks ---------
    # The plan sizes a dialogue shot from a words-per-second GUESS and then
    # grows it to the RECORDED line lengths — but that growth only happens if
    # the plan could reach a TTS engine, and when it cannot the failure is one
    # log line: the shots keep the guess, the planner packs blocks around it,
    # and nothing downstream ever says the timing was never measured.
    #
    # Measured on NIGHT SHIFT, whose plan ran with one half-cast character:
    # Breeze's real pace across that episode's lines ranged 1.43-2.95 words
    # per second against the assumed 2.0, so one shot was handed a 7.71s line
    # in a 7.00s slot and only survived because its block had a third shot to
    # spill across.
    #
    # Launch is the last moment before the GPU time is spent, and the clips
    # are cached forever and staged by the render itself (`measure_lines` ->
    # `_ensure_line_asset`), so measuring here is never wasted work. Growth
    # only, so re-launching an episode is a no-op the second time.
    if beats_ms or locked:
        # A music video's block boundaries snap to the track's beat grid and
        # its <Audio 1> is a fixed-length master: growing a dialogue shot
        # would walk the picture off the music. The floor does not apply.
        log("measured dialogue timing skipped — this cut is locked to a track")
    else:
        _refit_measured_beats(scenes, scene_beats, ep["project_id"],
                              jid=job.get("id"))

    plan_input = [{"id": s["id"], "environment_id": s.get("environment_id"),
                   "beats": scene_beats[s["id"]]} for s in scenes]
    blocks = planner.plan_blocks(plan_input, medium=project["medium"], beats_ms=beats_ms)
    if not blocks:
        raise ValueError("planner produced no blocks")

    # ---- dialogue spine -----------------------------------------------------
    # ONE recorded track for the whole storyboard, locked into every block it
    # covers, instead of a fresh placement puzzle per block. It is the answer
    # to the two failures this pipeline kept measuring — a line cut at a chain
    # join, and a line re-placed differently in the block that inherits it —
    # because with a spine the audio is not re-decided at a boundary: the
    # boundary lands INSIDE a continuous recording that both sides slice from.
    #
    # Opt out with `params.dialogue_spine=false` (or payload). Never on a
    # music video: <Audio 1> is already the master track there, and a segment
    # has exactly one locked audio input.
    spine = None
    import dialogue_spine as DSP
    _want_spine = payload.get("dialogue_spine")
    if _want_spine is None:
        _want_spine = (payload.get("params") or {}).get("dialogue_spine")
    if _want_spine is None:
        _want_spine = True
    if (not locked and _want_spine
            and (payload.get("params") or {}).get("el_dialogue", True)):
        try:
            spine = DSP.build_for_storyboard(scenes, scene_beats, story, ep,
                                             ep["project_id"])
        except Exception as e:      # noqa: BLE001 — never kill a render for it
            log(f"dialogue spine unavailable — per-block staging instead: {e}")
            spine = None

    # Ref plan per block: identity refs for the cast, the environment master,
    # and any user-designated stills / storyboard panels / prop sheets. Built
    # once for the whole storyboard and looped over every block below.
    # NOTE `locked=` here means "the audio slots are spoken for", which is what
    # a spine also does — its blocks carry <Audio 1> and stage no voice refs.
    rp_ctx = ref_plan_ctx(scenes, list(beats_by_id.values()), ep["project_id"],
                          locked=locked or bool(spine), payload=payload)


    # Replace any previous plan for this storyboard (idempotent relaunch).
    sb.patch(f"storyboards?id=eq.{sid}", {"status": "rendering"})
    old = sb.get(f"generation_blocks?storyboard_id=eq.{sid}&select=id,status,idx,params")
    if any(b["status"] in ("generating",) for b in old):
        raise ValueError("a block is currently generating — cancel it first")
    if old:
        # A relaunch replaces the PLANNER's blocks and nothing else. Blocks a
        # user derived on the timeline — block_from_clip trims, clip-born
        # extends/chains — carry takes somebody chose, and deleting them
        # cascades block_takes and take_reviews away with nothing to say so.
        # They are parked in a high idx band instead, clear of the fresh
        # plan's 0..N (the (storyboard_id, idx) pair is unique).
        drop, parked = split_relaunch_blocks(old)
        if drop:
            import requests as _rq
            _rq.delete(f"{sb.REST}/generation_blocks?storyboard_id=eq.{sid}"
                       f"&id=in.({','.join(drop)})",
                       headers=sb.HEADERS, timeout=30)
        for _bid, _to in parked:
            sb.patch(f"generation_blocks?id=eq.{_bid}", {"idx": _to})
        if len(old) > len(drop):
            log(f"launch_render: kept {len(old) - len(drop)} user-derived "
                f"block(s) (timeline trims / extensions) — parked at idx "
                f"10000+ behind the new plan; assemble_cut appends them")

    block_ids, prev_id = [], None
    rows = []
    # The episode's RESOLUTION belongs on the block, not only on each
    # master_pass job. `handle_master_pass` has always read `params.width` /
    # `params.height` as its second fallback and nothing ever wrote them — so
    # every master_pass queued any other way (the director chat's
    # rerender_block / rerender_stale, a retake from the prompt modal, an
    # assembly re-render) fell through to its 1280x720 default and silently
    # re-rendered at a resolution the episode never used. Measured on Rei EP03,
    # planned at 864x480: a plain re-render came back 1280x720, which is a
    # different picture AND a geometry mismatch for assemble_cut to paper over.
    _bp = _block_params(payload)
    _d = payload.get("dims") or {}
    if _d.get("w") and _d.get("h"):
        _bp.setdefault("width", int(_d["w"]))
        _bp.setdefault("height", int(_d["h"]))
    # WHICH BLOCKS ARE FIGHTS is decided once, here, and stamped on the row —
    # not asked at render time. `_block_loras` is pure and has no scene to look
    # at, and a per-render lookup would let two takes of one block disagree
    # about whether it is a fight. Stamping it also makes the decision VISIBLE
    # and per-block overridable, which a derived answer never is.
    #
    # The signal is the scene's own `type`, which the writer already fills from
    # `dialogue|action|montage|quiet` and which `h3_prompt` already arms the
    # equipment discipline on. A block spans one location and may span two
    # scenes, so ANY action scene in it makes it a fight — half a block
    # rendering with the adapter and half without is the continuity break
    # `_block_loras` exists to prevent.
    _fight_scene_ids = {s["id"] for s in scenes
                        if str(((s.get("meta") or {}).get("type") or "")).lower() == "action"}
    for b in blocks:
        _is_fight = bool(_fight_scene_ids & set(b["scene_ids"] or []))
        _p = dict(_bp)
        # An explicit `fight` in params is the user's, and wins both ways.
        if "fight" not in _p and _is_fight:
            _p["fight"] = True
        # WHICH BLOCKS MOVE THE CAMERA is stamped the same way, off the
        # cinematographer's own camera lines: any shot in the block naming a
        # push/pull/track/orbit/crane/tilt/handheld/aerial move makes the
        # block a camera-adapter block. Explicit params win both ways.
        if "camera_motion" not in _p and any(
                camera_moves((beats_by_id.get(bid) or {}).get("camera"))
                for bid in (b["beat_ids"] or [])):
            _p["camera_motion"] = True
        # A spine block locks to the recorded track; a block with no dialogue
        # keeps native audio and H3's own soundscape. `locked_kind` is what
        # tells the compiler <Audio 1> is speech rather than a score, and it
        # rides `params` so a re-render of one block still knows.
        _spined = bool(spine) and DSP.locks(b["beat_ids"], beats_by_id)
        if _spined:
            _p["locked_kind"] = "dialogue"
        row = sb.insert("generation_blocks", {
            "storyboard_id": sid, "idx": b["idx"],
            "scene_ids": b["scene_ids"], "beat_ids": b["beat_ids"],
            "t_start_ms": b["t_start_ms"], "t_end_ms": b["t_end_ms"],
            "frames": 0, "trim": {}, "mode": "r2v",
            "audio_mode": "locked" if (locked or _spined) else "native",
            "audio_slice": ({"asset_id": story.get("audio_asset_id")} if locked
                            else {"asset_id": spine["asset_id"]} if _spined
                            else None),
            "chain_from_block_id": prev_id if b["chain"] else None,
            "status": "planned", "ref_plan": ref_plan_for(b, rp_ctx),
            "params": _p,
            "seed": payload.get("seed"),
        })
        rows.append(row)
        block_ids.append(row["id"])
        prev_id = row["id"]

    prev_master_job = None
    n_jobs = 0
    # WHERE THE BLOCKS RENDER, decided by the caller rather than pinned here.
    # `payload.lanes` is the same map `llm.job_lane` reads for the jobs the
    # PLAN emits; absent, both fall back to the pod's own lanes and this
    # function is byte-identical to what it always did. What it buys is a
    # desktop that can render an episode it planned: with a model map of its
    # own (`model_map.desktop.json`) the same `resolve()` builds the same graph
    # against files the engine window downloaded.
    #
    # Imported here rather than at module level: `llm` is a 4,000-line module
    # this one only ever needs two functions from, and every other reference to
    # it in this file is already lazy.
    import llm as _llm
    mp_lane = _llm.job_lane(payload, "master_pass")
    slice_lane = _llm.job_lane(payload, "audio_slice")
    # SEGMENT STORYBOARDS: one numbered board per block, composed from the
    # per-shot panels the plan already drew (`handlers.images.
    # handle_sheet_compose`), attached to the block's params and staged as
    # its `block_sheet` reference. Queued HERE because the blocks exist only
    # now — the plan's panels are per beat and know nothing of blocks — and
    # each master pass depends on its own board so the render waits for it.
    # The compose job refuses a board whose panels disagree (boardsheet.
    # grade_spread), in which case the block renders on its panels as before.
    want_sheets = payload.get("block_sheets")
    if want_sheets is None:
        want_sheets = (payload.get("params") or {}).get("block_sheets")
    sheet_lane = _llm.job_lane(payload, "audio_slice")     # a cpu job, like the slice
    for row in rows:
        deps = []
        if row.get("audio_mode") == "locked":
            slice_job = sb.insert("jobs", {
                "kind": "audio_slice", "status": "queued", "lane": slice_lane,
                "priority": int(payload.get("priority") or 50),
                "project_id": ep["project_id"], "episode_id": ep["id"],
                "payload": {"block_id": row["id"],
                            "label": f"{_block_ref(row['idx'])} audio slice"}})
            deps.append(slice_job["id"])
            n_jobs += 1
        if want_sheets and len(row.get("beat_ids") or []) >= 2:
            sheet_job = sb.insert("jobs", {
                "kind": "sheet_compose", "status": "queued", "lane": sheet_lane,
                "priority": int(payload.get("priority") or 50),
                "project_id": ep["project_id"], "episode_id": ep["id"],
                "payload": {"block_id": row["id"],
                            "label": f"{_block_ref(row['idx'])} storyboard"}})
            deps.append(sheet_job["id"])
            n_jobs += 1
        if prev_master_job and row.get("chain_from_block_id"):
            deps.append(prev_master_job)
        mp = sb.insert("jobs", {
            "kind": "master_pass", "status": "queued", "lane": mp_lane,
            "priority": int(payload.get("priority") or 50),
            "project_id": ep["project_id"], "episode_id": ep["id"],
            "model_id": payload.get("model_id") or "h3-local",
            "depends_on": deps,
            "payload": {"block_id": row["id"], "auto_activate": True,
                        "label": f"{_block_ref(row['idx'])} master",
                        "dims": payload.get("dims") or {}}})
        sb.patch(f"generation_blocks?id=eq.{row['id']}", {"status": "queued"})
        prev_master_job = mp["id"]
        n_jobs += 1

    sb.job_done(job["id"])
    # Count what the BLOCKS say rather than what `locked` (the music-video
    # flag) says: with a dialogue spine every speaking block is locked too,
    # and reporting "native audio" over 43 locked blocks is a summary line
    # that contradicts the rows it just wrote.
    n_locked = sum(1 for r in rows if r.get("audio_mode") == "locked")
    how = ("locked to the storyboard's music master" if locked
           else f"{n_locked}/{len(rows)} locked to the dialogue spine" if spine
           else "native audio")
    log(f"JOB DONE launch_render: {len(rows)} blocks, {n_jobs} jobs queued ({how})")


# ------------------------------------------------------------ master pass ----

def _delivered(sibling, this_block_id):
    """Does this block already have a picture the cut can use?

    Counted by TAKE, not by the `generated` status: a chained block whose
    predecessor was re-rendered is marked `stale` by `_mark_downstream_stale`
    and keeps its active take — and counting only `generated` meant the
    episode could never read as complete once any block had been replaced.
    NIGHT SHIFT (2026-09-02): two blocks failed on the first launch, every
    block was re-rendered to completion, and `assemble_cut` never queued
    because two siblings were `stale`. The `assemble_cut` promise of the
    wizard's Full auto is what this counts toward."""
    return (sibling.get("id") == this_block_id
            or bool(sibling.get("active_take_id"))
            or sibling.get("status") in ("generated", "stale"))

def handle_master_pass(job):
    jid = job["id"]
    payload = job.get("payload") or {}
    block = _load_block(payload["block_id"])
    # A CLIP-BORN block has no beats to compile — it renders from the stored
    # clip_gen recipe (`_publish_clip_block` writes it for the timeline's
    # extend/chain and for promoted clips), so every master_pass surface (the
    # retake modal, rerender_stale, a stale re-render behind a chain) delegates
    # back to the clip path instead of compiling an empty storyboard. Checked
    # before _load_context, which expects scenes to exist.
    # BEATS OUTRANK A STRAY RECIPE. A block that has beats is a shot the
    # compiler can describe; a recipe beside them is one it inherited from
    # the neighbour it was added after (the director's add_block used to copy
    # a neighbour's whole params, extension recipe included), and replaying
    # that renders the NEIGHBOUR's extension under this block's name — which
    # is what "it did an extension instead of a block for b29" was.
    _ck = (block.get("params") or {}).get("clip_gen")
    if isinstance(_ck, dict) and _ck.get("prompt"):
        if block.get("beat_ids"):
            log(f"master_pass: block {block['id'][:8]} carries a clip_gen recipe "
                f"AND beats — compiling from the beats; the recipe is a neighbour's")
        else:
            return _master_pass_clip_block(job, block, _ck)
    story, ep, project, scenes, beats, cast, env = _load_context(block)
    cast_by_id = {c["id"]: c for c in cast}

    # Per-run overrides. The block's stored `params` are the episode's pick;
    # this payload may name a different model, LoRA stack, step count or
    # director's note for THIS pass only — which is how a re-render asked for
    # in the director chat can say "do it on plain h3" without rewriting what
    # the rest of the episode renders on. `persist_params` is the opt-in that
    # makes the override stick; without it the row is untouched and the next
    # ordinary render is exactly as it was.
    params = {**(block.get("params") or {}), **_block_params(payload)}
    if payload.get("persist_params") and params != (block.get("params") or {}):
        sb.patch(f"generation_blocks?id=eq.{block['id']}", {"params": params})
        block["params"] = params

    # WHICH FAMILY renders this block, decided before anything is staged.
    # The prompt format, the reference topology, the frame grid and whether
    # audio references mean anything at all all follow from it — LTX 2.5 reads
    # prose, takes four subject slots plus a dedicated background, samples on
    # 8n+1, and generates its own audio with no reference-audio input.
    block_model = _block_model(block, params)
    is_ltx = "ltx" in str(block_model).lower()

    # A re-render may RESTAGE its references. The plan on the row was computed
    # when the episode was planned, and until this was reachable outside
    # launch_render nothing could recompute it — so an outfit variant cast
    # afterwards, a recast voice or a redrawn location never reached the
    # picture: every text surface showed the new wardrobe while the render was
    # still handed the old sheets. Written back, so the block's ref panel shows
    # what the render was actually given.
    #
    # It RAISES rather than falling back to the stored plan. The caller asked
    # for this specifically, and quietly rendering the old costume is the
    # silent downgrade that would send someone hunting the wrong bug.
    if payload.get("recompute_refs"):
        fresh = ref_plan_for(
            block, ref_plan_ctx(scenes, beats, ep["project_id"],
                                locked=block.get("audio_mode") == "locked",
                                payload=payload), params)
        # A CLOSING FRAME SURVIVES THE RECOMPUTE, because nothing can rebuild
        # it. `ref_plan_for` derives its entries from the beats — cast,
        # location, props, panels — and a START frame has a beat-level source
        # (`meta.start_frame_asset_id`) so it comes back. An END frame does
        # not: it is set only by PromptRefsModal writing straight into the
        # ref_plan, so a wholesale replace DELETES it. That is silent and then
        # fatal — the block is still `mode: flf`, and handle_master_pass raises
        # "needs a closing frame" on a block that had one a moment ago. Same
        # rule the slot budget already follows for these entries: a
        # deliberate frame never yields.
        if not any(e.get("purpose") == "end_frame" and e.get("asset_id")
                   for e in fresh):
            kept = next((e for e in (block.get("ref_plan") or [])
                         if e.get("purpose") == "end_frame" and e.get("asset_id")),
                        None)
            if kept:
                fresh.append(kept)
                log("ref_plan recompute: carried the closing frame across — "
                    "nothing derives one from the beats")
        # A PINNED entry survives too: a picture the director chat was handed
        # for this shot (`ref_asset_ids` on rerender_block/add_block) has no
        # beat-level source beyond the first one, so a wholesale replace would
        # drop every look after it. Same rule as the closing frame — a
        # deliberate picture never yields to the derivation.
        staged = {e.get("asset_id") for e in fresh if e.get("asset_id")}
        pinned = [e for e in (block.get("ref_plan") or [])
                  if e.get("pinned") and e.get("asset_id") and e.get("asset_id") not in staged]
        if pinned:
            fresh.extend(pinned)
            log(f"ref_plan recompute: carried {len(pinned)} pinned picture(s) across")
        sb.patch(f"generation_blocks?id=eq.{block['id']}", {"ref_plan": fresh})
        block["ref_plan"] = fresh
        log(f"ref_plan recomputed: {len(fresh)} entries staged")

    content_ms = block["t_end_ms"] - block["t_start_ms"]
    plan = h3_timing.plan_block(content_ms)
    sb.patch(f"generation_blocks?id=eq.{block['id']}",
             {"status": "generating", "frames": plan.render_f,
              "trim": {"warmup_f": plan.warmup_f, "cooldown_f": plan.cooldown_f,
                       "out_ms": plan.trim_ms}})

    # ---- stage references per ref_plan -------------------------------------
    ref_slots, ref_names = [], []
    # An author-designated start frame beats the inferred chain anchor: the
    # user picking "open this block on this image" is a deliberate override of
    # "continue from wherever the last block happened to end". Only one image
    # can be the opening frame, so the chain is skipped entirely when set.
    start_entry = next((e for e in (block.get("ref_plan") or [])
                        if e.get("purpose") == "start_frame" and e.get("asset_id")), None)
    start_asset = sb.asset_by_id(start_entry["asset_id"]) if start_entry else None
    if start_entry and not start_asset:
        log(f"start frame {start_entry.get('asset_id')} missing — falling back to the chain")
        start_entry = None
    chain_asset = None
    if not start_entry:
        chain_asset = (_chain_frame_asset(block, payload)
                       if block.get("chain_from_block_id") or payload.get("prev_frame_asset_id")
                       else None)
    slot = 1
    if start_entry:
        ref_names.append(_stage_asset(start_asset, jid, "chain"))
        ref_slots.append({"slot": slot, "kind": "start_frame"})
        slot += 1
    elif chain_asset:
        ref_names.append(_stage_asset(chain_asset, jid, "chain"))
        ref_slots.append({"slot": slot, "kind": "chain"})
        slot += 1
    # scene_ref entries map to the shots of their scene inside this block.
    # 'voice' entries are AUDIO — staged into their own slot family (official
    # §2.5: pictures and audios number independently), never as pictures.
    beat_scene = [b["scene_id"] for b in beats]
    voice_names, audio_ref_slots = [], []
    # Exact-dialogue lines beat voice-timbre anchors when they're available:
    # the recorded performance stages as partially_copy reference audio (the
    # measured block-5 A-path — 100% coverage where native failed 3x), and the
    # timbre refs it obsoletes stay home. Any failure here is LOUD and safe —
    # the block renders exactly as before on the timbre path.
    # NOTE: `mode` proper is computed later (payload can override) — the gate
    # reads the same sources; a non-r2v override on a dialogue block would be
    # caught by the r2v-only audio wiring downstream anyway.
    dialogue_ref = False
    # A locked-DIALOGUE block renders on the REFERENCE path BY DEFAULT
    # (2026-08-30): instead of the audiolock writing the spine slice over the
    # audio latent 1:1, the block takes the pre-spine native path — the SAME
    # recorded lines stage as per-line/exchange Ref2VA audio references,
    # partially_copy: placed verbatim with everything else GENERATED around
    # them. That restores the two things the lock structurally removes: H3
    # generates the track again, so mouths bind to lines it has to place
    # (per-line, per-speaker — stronger than asking it to diarize a foreign
    # locked track), and the writer's soundscape (props, room, movement)
    # renders instead of pink-noise room tone. Measured before it became the
    # default (three blocks, four arms): the two frozen-mouth shots
    # articulate, no-speech windows go from the -44.6 LUFS pink bed to a
    # -15..-22 LUFS generated room with real events, and with the spine
    # offsets + finish-by anchor every word survived. The community
    # "Minimax H3 Lipsync" workflow (civitai 2876401) is this exact shape.
    #
    # `dialogue_audio: "locked"` (params or payload) opts a block back onto
    # the audiolock — the spine, its slices and `audio_mode: "locked"` are
    # still built and stored at plan time precisely so that pin needs no
    # re-plan. Music-video locked blocks (locked_kind "music") are untouched:
    # reproducing the master track 1:1 is that product's whole contract.
    _dlg_audio = str(payload.get("dialogue_audio")
                     or params.get("dialogue_audio") or "ref").lower()
    if (_dlg_audio != "locked"
            and block.get("audio_mode") == "locked"
            and str(params.get("locked_kind") or "music") == "dialogue"):
        block = {**block, "audio_mode": "native"}
        dialogue_ref = True
        log(f"master_pass block {block['idx']}: dialogue on the reference "
            f"path (default) — recorded lines stage as Ref2VA references; "
            f"dialogue_audio=locked pins the audiolock back")
    _mode_guess = (payload.get("mode") or block.get("mode") or "r2v").lower()
    line_items = None
    if (_mode_guess == "r2v" and block.get("audio_mode") != "locked"
            and params.get("el_dialogue", True)):
        try:
            import dialogue_synth as DS
            if DS.enabled():
                planned = DS.plan_lines(beats, cast)
                # A beat pinned to a run clip (meta.xchg) has its DURATION cut
                # to that recording — so the block must stage that recording,
                # even when it holds ≤3 of the run's lines (a run split across
                # blocks). Per-line clips with formula offsets against pinned
                # cuts measured as DIALOGUE_CUTOFF on block 6, live.
                has_pin = any(((b.get("meta") or {}).get("xchg"))
                              for b in beats if b.get("dialogue"))
                # `force_line_clips` overrides both gates — it is the A/B lever
                # for whether one recorded conversation really beats a clip per
                # line (E2 measured the opposite of the design intent).
                force_line = bool(params.get("force_line_clips"))
                if force_line and planned:
                    line_items = _exchange_slots_for_block(
                        planned, beats, ep["project_id"], force_line=True)
                elif planned and not has_pin and len(planned) <= DS.MAX_AUDIO_SLOTS:
                    line_items = DS.ensure_assets(planned, ep["project_id"])
                elif planned:
                    # Recorded conversation(s), placed to fit the planned cuts
                    # — or None, and the timbre path takes over.
                    line_items = _exchange_slots_for_block(
                        planned, beats, ep["project_id"])
        except Exception as e:  # noqa: BLE001 — a synth failure must not kill the render
            log(f"dialogue synth unavailable — voice-timbre refs instead: {e}")
            line_items = None
    if line_items:
        dur_of_slot = {}
        for it in line_items:
            va = sb.asset_by_id(it["asset_id"])
            if not va:
                log(f"dialogue line asset {it['asset_id']} missing — timbre refs instead")
                line_items = None
                voice_names, audio_ref_slots = [], []
                break
            voice_names.append(_stage_asset(va, jid, "line", len(voice_names)))
            # asset_id rides the slot for the UI (the block's dialogue panel
            # plays these exact clips); the compiler ignores unknown keys.
            s = {"slot": len(voice_names), "kind": it["kind"],
                 "asset_id": it["asset_id"]}
            if it["kind"] == "line":
                s.update({"name": it["speaker"], "text": it["line"],
                          "shot_idx": it["shot_idx"], "order": it["order"],
                          # the recording's own length: what lets the compiler
                          # state when the line FINISHES, not only when it
                          # begins — on the ref path the offset drives
                          # placement and H3 drifts late, so an unanchored
                          # tail is the first thing to hit the block end
                          "dur_ms": int(va.get("duration_ms") or 0)})
                dur_of_slot[s["slot"]] = int(va.get("duration_ms") or 0)
            else:
                s.update({"lines": it["lines"], "start": it["start"]})
            audio_ref_slots.append(s)
        if line_items:
            # Placement offsets from the MEASURED clips: lines in one shot
            # play in sequence from the shot's lead-in, so the compiler can
            # say where each begins instead of hoping H3 spaces them.
            import dialogue_synth as DS
            by_shot = {}
            for s in audio_ref_slots:
                if s.get("kind") == "line":
                    by_shot.setdefault(s["shot_idx"], []).append(s)
            for _shot, group in by_shot.items():
                group.sort(key=lambda x: x["order"])
                offs = DS.line_offsets_ms([dur_of_slot.get(g["slot"], 0)
                                           for g in group])
                for g, off in zip(group, offs):
                    # Shot 1 opens at RENDER t=0 on a chained block and the
                    # trim removes the warmup — a content-relative offset
                    # there aims the line's head before the delivered take.
                    # Harmless while the offset merely described a placed
                    # recording; it PLACES one now, so say it on the clock
                    # the shot actually runs on.
                    g["at_ms"] = off + (h3_timing.frames_to_ms(plan.warmup_f)
                                        if g.get("shot_idx") == 1 else 0)
            # The label names the ENGINE that recorded them — a Breeze-cast
            # character's lines are Breeze clips, and "(ElevenLabs v3)" here
            # was a hardcoded string that survived the second provider.
            engines = sorted({"Breeze TTS 2" if DS.is_breeze(str(it.get("voice_id") or it.get("voice") or ""))
                              else "ElevenLabs v3" for it in line_items})
            log(f"dialogue synth: {len(line_items)} exact line ref(s) staged "
                f"({' + '.join(engines)}) — timbre refs skipped")
    for entry in (block.get("ref_plan") or []):
        if entry.get("asset_id") in (None, "prev_last_frame"):
            continue
        if entry.get("purpose") in ("start_frame", "end_frame"):
            continue            # staged separately (slot 1 / flf tail)
        if entry.get("purpose") == "voice":
            if line_items or len(voice_names) >= 3 or block.get("audio_mode") == "locked":
                continue
            if is_ltx:
                # LTX 2.5's r2v graph generates its own audio and has no
                # reference-AUDIO input at all — the MSR guide takes pictures.
                # Staging the clip anyway would upload a file the render cannot
                # read and then record it in `audio_refs` as though it had been
                # used, which is a prompt panel that lies about the take.
                log("LTX r2v takes no audio references — voice-timbre refs "
                    "skipped for this block (its speech is generated)")
                continue
            va = sb.asset_by_id(entry["asset_id"])
            if not va:
                log(f"voice ref asset {entry.get('asset_id')} missing — skipped")
                continue
            voice_names.append(_stage_asset(va, jid, "voice", len(voice_names)))
            audio_ref_slots.append({"slot": len(voice_names), "kind": "voice",
                                    "asset_id": entry["asset_id"],
                                    "name": entry.get("name") or entry.get("label")})
            continue
        asset = sb.asset_by_id(entry["asset_id"])
        if not asset:
            log(f"ref asset {entry.get('asset_id')} missing — skipped")
            continue
        ref_names.append(_stage_asset(asset, jid, "ref", slot))
        rs = {"slot": slot, "kind": entry.get("purpose", "other"),
              "name": entry.get("label"), "role": entry.get("role"),
              "desc": entry.get("desc")}
        for k in ("views", "columns"):
            # The coverage sheet's shape, carried the way `panels` is: the
            # compiler describes the picture, and neither number is derivable
            # from anything else in the slot.
            if entry.get(k):
                rs[k] = int(entry[k])
        if entry.get("panels"):
            # How many panels the sheet actually carries. Derivable from
            # shot_idxs, but only while the plan and the block agree about the
            # shot count — a block re-planned to fewer shots keeps a sheet drawn
            # for the old ones, and the compiler must describe the PICTURE.
            rs["panels"] = int(entry["panels"])
        if entry.get("purpose") in ("scene_ref", "look") and entry.get("scene_id"):
            rs["shot_idxs"] = [i + 1 for i, sid_ in enumerate(beat_scene)
                               if sid_ == entry["scene_id"]] or [1]
        elif entry.get("shot_idxs"):
            rs["shot_idxs"] = entry["shot_idxs"]
        ref_slots.append(rs)
        slot += 1
        if len(ref_names) >= 9:
            break

    # ---- mode: what this block is actually rendered as ----------------------
    # Every master pass used to run r2v regardless of what the block said,
    # because r2v is the only mode that carries identity references. It is
    # still the default, but a block can now ask for an FL2VA mode — those
    # take a start (and end) frame instead of a reference set, off a different
    # checkpoint, so the preconditions have to be checked before we spend GPU.
    mode = (payload.get("mode") or block.get("mode") or "r2v").lower()
    if mode not in H3_MODES:
        log(f"unknown mode {mode!r} — falling back to r2v")
        mode = "r2v"

    # The previous segment as a reference VIDEO — the vendor's documented
    # continuation channel, and the one ref2va family this pipeline never used
    # (9 pictures and 3 audios were staged; 0 of 3 videos). It carries what a
    # sentence cannot: where everyone actually ended up, in motion, with the
    # room's real geometry. Derived at render time from chain_from_block_id, so
    # it needs no re-plan and no ref_plan entry — same shape as chain_asset.
    # Must sit BELOW the mode resolution above: it is r2v-only, and reading
    # `mode` before it is assigned is an UnboundLocalError that fails the job
    # before ComfyUI is ever reached.
    # OPT-IN (params.video_ctx=true / payload.video_ctx=true), and default OFF
    # until the graph side is proven. Shipped default-on for one deploy and it
    # FAILED every chained block: b17 (unchained, so no video ref) rendered
    # clean while 18 and 19 — the two that stage <Video 1> — both died with a
    # ComfyUI *execution* error, which a prompt change cannot cause. Since
    # every block after the first in a scene is chained, default-on breaks an
    # episode render wholesale. The compile-side continuity sentence is
    # independent of this and stays on: it is text, and text cannot fail a
    # graph. Diagnose against VHS_LoadVideo before flipping this back.
    video_names, video_ref_slots = [], []
    want_video_ctx = params.get("video_ctx")
    if want_video_ctx is None:
        want_video_ctx = payload.get("video_ctx", False)
    if mode == "r2v" and want_video_ctx and block.get("chain_from_block_id"):
        try:
            prev = _load_block(block["chain_from_block_id"])
            take = sb.get(f"block_takes?id=eq.{prev.get('active_take_id')}"
                          f"&select=asset_id") if prev.get("active_take_id") else []
            prev_asset = sb.asset_by_id(take[0]["asset_id"]) if take else None
            if prev_asset:
                video_names.append(_stage_asset(prev_asset, jid, "prevseg"))
                video_ref_slots.append({"slot": len(video_names), "kind": "prev_segment",
                                        "block_idx": prev.get("idx")})
                log(f"video context: block {prev.get('idx')}'s take as <Video 1>")
        except Exception as e:      # noqa: BLE001 — context, never correctness
            log(f"video context unavailable: {e}")

    opening = ref_names[0] if (start_entry or chain_asset) else None
    end_entry = next((e for e in (block.get("ref_plan") or [])
                      if e.get("purpose") == "end_frame" and e.get("asset_id")), None)
    end_name = None
    if end_entry:
        end_asset = sb.asset_by_id(end_entry["asset_id"])
        if end_asset:
            end_name = _stage_asset(end_asset, jid, "end")
        else:
            log(f"end frame {end_entry.get('asset_id')} missing")

    if mode in ("i2v", "flf") and not opening:
        raise ValueError(
            f"block {block['idx']} is set to {mode}, which opens on a supplied frame, but it has "
            f"no start frame and no chain — mark a reference as the start frame, chain it to the "
            f"previous block, or switch it back to r2v")
    if mode == "flf" and not end_name:
        raise ValueError(
            f"block {block['idx']} is set to flf, which needs a closing frame — mark a reference "
            f"as the end frame or switch to i2v")

    # ---- locked audio slice -------------------------------------------------
    audio_name = None
    if block.get("audio_mode") == "locked":
        if mode != "r2v":
            raise ValueError(
                f"block {block['idx']} has locked audio, which rides the r2v audiolock graph — "
                f"{mode} has no audio input, so the track would be regenerated instead of reused")
        slice_id = (block.get("audio_slice") or {}).get("slice_asset_id")
        if not slice_id:
            raise ValueError("locked block has no audio slice — audio_slice job must run first")
        audio_name = _stage_asset(sb.asset_by_id(slice_id), jid, "audio")

    # ---- the recording is the clock -----------------------------------------
    # A dialogue-spine block's audio is ground truth (<Audio 1> ships 1:1), so
    # the envelope's shot stamps have to agree with where the spine actually
    # placed each line — beat durations are the PLAN's clock, and the two
    # drift whenever the recording's own rhythm did not fit the planned cuts
    # (place_exchange's lead-in fallback, a stale-pin re-solve, quantisation).
    # Measured on THE LATE SHIFT b1: the envelope bound Dennis's line to a cut
    # at 00:06.864 while the audio starts him at 5.69s — during an insert of a
    # BELL — and H3, told one clock and played another, kept his mouth shut.
    # `retime_beats` moves the stamps onto the measured spans (never the
    # audio); `at_ms` then tells the clause when a line starts INSIDE its
    # shot, for the cuts that could not fully absorb the drift.
    if (audio_name or dialogue_ref) and \
            str(params.get("locked_kind") or "music") == "dialogue":
        try:
            import dialogue_spine as DSP
            spine_a = sb.asset_by_id((block.get("audio_slice") or {}).get("asset_id"))
            _blk_ms = int(block["t_end_ms"]) - int(block["t_start_ms"])
            _sl = DSP.block_lines((spine_a or {}).get("meta"), beats,
                                  int(block["t_start_ms"]), _blk_ms)
            # Deep-enough copies first: the retimed durations and the per-line
            # `at_ms` are THIS compile's stamps, not edits to the storyboard.
            beats = [{**b, "dialogue": [dict(d) for d in (b.get("dialogue") or [])]}
                     for b in beats]
            _re = DSP.retime_beats(beats, _sl, _blk_ms)
            if _re is not None:
                _moved = sum(1 for b, d in zip(beats, _re)
                             if int(b.get("duration_ms") or 0) != d)
                for b, d in zip(beats, _re):
                    b["duration_ms"] = d
                log(f"spine retime: {_moved} shot stamp(s) moved onto the "
                    f"recording's own line spans")
            _cum, _starts = 0, {}
            for b in beats:
                _starts[b.get("id")] = _cum
                _cum += int(b.get("duration_ms") or 0)
            _by_beat = {}
            for l in _sl:
                _by_beat.setdefault(l["beat_id"], []).append(l)
            for b in beats:
                for d in (b.get("dialogue") or []):
                    m = next((l for l in _by_beat.get(b.get("id"), [])
                              if " ".join(str(l.get("line") or "").lower().split())
                              == " ".join(str(d.get("line") or "").lower().split())), None)
                    if m:
                        d["at_ms"] = max(0, m["t0_ms"] - _starts[b.get("id")])
            # Ref mode: the spine's measured onsets replace the lead-in
            # ladder on the staged slots — measured on b6, the ladder's
            # "0.7s into the shot" plus H3's own late drift ran a 4.5s
            # recording out of a 6.25s block and cost the quoted tail.
            if dialogue_ref and audio_ref_slots:
                _ov = DSP.ref_slot_offsets(
                    _sl, beats, h3_timing.frames_to_ms(plan.warmup_f),
                    audio_ref_slots)
                for _s in audio_ref_slots:
                    o = _ov.get(_s.get("slot"))
                    if o:
                        _s["at_ms"], _s["shot_idx"] = o["at_ms"], o["shot_idx"]
                if _ov:
                    log(f"ref offsets from the spine: "
                        f"{len(_ov)} line slot(s) re-placed")
        except Exception as e:          # noqa: BLE001 — a stamp correction
            log(f"spine retime skipped ({e}) — compiling on the planned stamps")

    # ---- which compiler ------------------------------------------------------
    # The prompt FORMAT belongs to the family, not to this function. LTX 2.5
    # reads continuous prose and was not trained on H3's `subject_definitions:`
    # envelope, so compiling H3's format for an LTX block hands it a format the
    # vendor's own guide says it does not read — which is exactly why LTX was
    # clip-only until now. `ltx_prompt` is keyword-compatible with `h3_prompt`
    # (the H3-only knobs are accepted and ignored), so this is a module swap
    # rather than a branch through the next hundred lines.
    PC = ltx_prompt if is_ltx else h3_prompt
    if is_ltx and audio_name:
        raise ValueError(
            f"block {block['idx']} has locked audio, which rides MiniMax H3's audiolock "
            f"graph — LTX 2.5 generates its own audio and has no locked-audio template, "
            f"so the track would be regenerated. Render this block on H3 or unlock it.")

    # ---- compile prompt -----------------------------------------------------
    # The compiler addresses people by their BASE name: an outfit variant's
    # "Zara Voss — courier rig" is a bible row, but the beats, dialogue and
    # voice refs all say "Zara Voss". The variant's identity_line (which
    # carries the wardrobe) rides under the base name, and if both the base
    # and a variant are somehow cast, the variant's line wins.
    compiler_cast, seen_names = [], set()
    for c in cast:
        base = c["name"].split(" — ")[0].strip()
        entry = {"name": base,
                 "identity_line": c.get("identity_line") or c.get("summary"),
                 "voice": (c.get("doc") or {}).get("voice"),
                 "singer": bool((c.get("doc") or {}).get("singer"))}
        if base in seen_names:
            if " — " in c["name"]:          # variant refines the base entry
                for cc in compiler_cast:
                    if cc["name"] == base:
                        cc.update(entry)
            continue
        seen_names.add(base)
        compiler_cast.append(entry)
    cast_by_id = {cid: {**c, "name": c["name"].split(" — ")[0].strip()}
                  for cid, c in cast_by_id.items()}

    compiled = PC.compile_block(
        render_ms=plan.render_ms,
        warmup_ms=h3_timing.frames_to_ms(plan.warmup_f),
        aspect=project.get("aspect") or "16:9",
        style=project.get("style") or "",
        medium=project["medium"],
        beats=_beats_for_prompt(block, beats, cast_by_id),
        cast=compiler_cast,
        environment=({"name": env["name"],
                      "identity_line": env.get("identity_line") or env.get("summary"),
                      "palette": (env.get("doc") or {}).get("palette"),
                      "background_life": (env.get("doc") or {}).get("background_life")}
                     if env else None),
        ref_slots=ref_slots if mode == "r2v" else [],
        mode=mode,
        has_end_frame=bool(end_name),
        audio_mode=block.get("audio_mode") or "native",
        # What <Audio 1> IS on a locked block: a music-video master track, or
        # this storyboard's own recorded dialogue (the spine). Written onto
        # the block at plan time so a one-off re-render of the block reaches
        # the same answer without re-deriving it from the storyboard.
        locked_kind=str(params.get("locked_kind") or "music"),
        lip_sync=(story.get("audio_meta") or {}).get("lip_sync", True),
        lyrics=_lyrics_in_window(story, block, h3_timing.frames_to_ms(plan.warmup_f)),
        next_opening=_next_opening(block),
        # A chained r2v block has a past whether or not it opens on a frame.
        # Gating this on chain_asset/start_entry meant a storyboard scene — a
        # run of chained r2v blocks, none of which carries an opening frame —
        # never learned that it continued from anything, and restaged its cast
        # from scratch each time (GEOGRAPHY_BREAK).
        prev_closing=_prev_closing(block) if (chain_asset or start_entry
                                              or block.get("chain_from_block_id")) else None,
        video_refs=video_ref_slots if mode == "r2v" else None,
        soundscape_hint=params.get("soundscape"),
        # A ref-dialogue block must NOT bake a per-block score: each block
        # would invent its own cue and no two would agree — the episode's
        # score belongs to `score_mix` at assembly, the same reason the
        # locked spine compiles music as N/A. An explicit params.music still
        # wins (someone asking for a cue on one block means it).
        music_hint=(params.get("music")
                    or ("N/A" if dialogue_ref else None)),
        audio_refs=audio_ref_slots if mode == "r2v" else None,
        scene_time=next((str((s.get("meta") or {}).get("time"))
                         for s in scenes if (s.get("meta") or {}).get("time")), None),
        vfx_language=((story.get("brief") or {}).get("world") or {}).get("vfx_language"),
        scene_type=next((str((s.get("meta") or {}).get("type"))
                         for s in scenes if (s.get("meta") or {}).get("type")), None),
        props=_props_for_scenes(project["id"], [s.get("slug") for s in scenes]),
        # Same block-level pick the render resolves below, asked for as prompt
        # tokens instead of files. It has to be here rather than in resolve():
        # an adapter whose trigger is missing loads clean and does nothing, and
        # the only place the token can go is inside the description — which is
        # compiled here, and stored, so the block panel shows what was sent.
        lora_triggers=R.lora_triggers(_block_model(block, params),
                                      _block_loras(block, params,
                                                   model=_block_model(block, params))),
    )
    # Retake creative note: appended to the compiled prompt, never part of the
    # deterministic format (invariant #6 — the compiler owns the structure).
    # NOT gated on `take_of`: a content re-render that replaces the active take
    # ("they kiss instead of shaking hands") carries its note the same way a
    # side-by-side retake does, and gating it meant the note was accepted and
    # silently dropped on exactly the path the director chat uses most.
    extra = (params.get("prompt_extra") or "").strip()
    if extra:
        compiled = dict(compiled)
        key = "detailed_description" if "detailed_description" in compiled else "description"
        compiled[key] = f"{compiled.get(key, '')}\nDirector's adjustment for this take: {extra}"
    # audio_refs beside the compiled prompt: the staged dialogue truth (which
    # clips, whose lines, measured offsets) so the block panel can show and
    # play exactly what the render was handed.
    sb.patch(f"generation_blocks?id=eq.{block['id']}",
             {"compiled_prompt": compiled,
              "audio_refs": audio_ref_slots or None})
    prompt_text = PC.full_prompt_text(compiled)

    # ---- resolve + render ---------------------------------------------------
    dims = payload.get("dims") or {}
    width = int(dims.get("w") or params.get("width") or 0)
    height = int(dims.get("h") or params.get("height") or 0)
    if not (width and height):
        # Nothing said what size this block is. Blocks planned before
        # launch_render persisted the episode's dims have no `params.width`, so
        # the honest fallback is what this block LAST rendered at — a re-render
        # that changes resolution is not a re-render of the same block. The
        # 1280x720 constant stays as the floor for a block that has never
        # rendered at all.
        prev = sb.get(f"block_takes?block_id=eq.{block['id']}"
                      f"&select=asset:assets(width,height)"
                      f"&order=created_at.desc&limit=1")
        a = (prev[0].get("asset") if prev else None) or {}
        width = width or int(a.get("width") or 1280)
        height = height or int(a.get("height") or 720)
    # payload seed wins so a retake can genuinely re-roll
    seed = int(payload.get("seed") or block.get("seed") or 42)
    # r2v hands the whole staged set to Ref2VA; the FL2VA modes take one or two
    # concrete frames and no reference list at all.
    img_kwargs = (
        {"ref_images": ref_names} if mode == "r2v"
        else {"source_image": opening} if mode == "i2v"
        else {"source_image": opening, "end_image": end_name} if mode == "flf"
        else {})
    if is_ltx and mode == "r2v":
        # LTX's MSR guide is FOUR SUBJECT slots plus a dedicated background,
        # each carrying a learned slot embedding — not H3's flat nine-picture
        # pool where a picture's ROLE is declared in the prompt instead. So the
        # set has to be sorted by what each picture IS, not merely truncated:
        #
        #   background  <- the location plate, by name. Left to the "fifth
        #                  image" fallback it would land in pic2 wearing a
        #                  subject's embedding.
        #   pic1..pic4  <- people, then props. Both are subjects of a frame.
        #   dropped     <- STORYBOARD PANELS. A panel is a composition, not a
        #                  subject, and there is no slot that means that here.
        #                  It is also the crutch LTX does not need: the A/B
        #                  measured H3 opening ON its panel and ignoring the
        #                  written camera, while LTX obeyed the written camera
        #                  with no panel staged at all. Spending a subject slot
        #                  on one would trade the identity it holds for framing
        #                  the prose already delivers.
        env_at = next((i for i, rs in enumerate(ref_slots)
                       if rs.get("kind") == "environment"), None)
        bg = ref_names[env_at] if env_at is not None and env_at < len(ref_names) else None
        subjects, dropped = [], []
        for i, name in enumerate(ref_names):
            if i == env_at:
                continue
            kind = (ref_slots[i].get("kind") if i < len(ref_slots) else None)
            (dropped if kind == "scene_ref" else subjects).append(name)
        if dropped:
            log(f"LTX r2v: {len(dropped)} storyboard panel(s) not staged — MSR has "
                f"subject slots and a background, no composition slot; the compiled "
                f"camera line carries the framing instead")
        if len(subjects) > 4:
            log(f"LTX r2v: {len(subjects)} subject refs staged, keeping the first 4 "
                f"(MSR has four subject slots) — the rest are dropped")
        img_kwargs = {"ref_images": subjects[:4],
                      **({"ref_background": bg} if bg else {})}

    # Motion-context chaining: hand the previous take's tail (frames + audio)
    # to the conditioning so the join continues the same motion and waveform.
    # The context occupies the warmup window our trim already removes; when
    # the previous block's AV latent is still on disk, the node slices context
    # from it directly (v0.2.0 lossless path) with the frames as fallback.
    # warmup < 5 (a near-ceiling block shed it) can't host even the smallest
    # legal context window, so the chain falls back to the plain frame anchor.
    from handlers import images as I
    motion_ctx = None
    if (mode == "r2v" and chain_asset and not audio_name and not is_ltx
            and plan.warmup_f >= 5 and _motion_ctx_wanted(block, payload, params)):
        ctx_name, ctx_ms = _chain_take_video(block, jid)
        if ctx_name:
            ctx_frames = int(ctx_ms * 24 / 1000)   # tail window: see CTX_TAIL_F
            latent_file = _chain_latent(block)
            motion_ctx = {"video": ctx_name,
                          "context_length": plan.warmup_f,
                          "skip_frames": max(0, ctx_frames - CTX_TAIL_F),
                          "latent_file": latent_file,
                          "spec": I._node_spec("MiniMaxH3MotionContext")}
            if latent_file:
                log(f"motion_ctx: latent path {os.path.basename(latent_file)}")
    # Every H3 master leaves its AV latent behind for the NEXT block's context
    # (cleaned up when the episode assembles). Harmless no-op on non-H3 graphs.
    context_save = ({"prefix": f"h3_context/{block['id']}/clip"}
                    if I._has_node("MiniMaxH3MotionContextSaveLatent") else None)

    # The planner's frame count is H3's 17n+5 grid; `exact_frames` is trusted by
    # resolve(), so an LTX block has to be re-snapped to 8n+1 or it dies in the
    # sampler. Snapping the padded render DURATION (not the content) keeps the
    # trim valid: frame_count rounds up, so the rendered clip still covers
    # warmup + content and `plan.trim_start_ms`/`trim_ms` cut the same window.
    render_f = (R.frame_count(block_model, plan.render_ms) if is_ltx
                else plan.render_f)

    # Resolved once and reused by the log below, so the journal reports the
    # stack the GRAPH got rather than a second call that could drift from it.
    _lora_picks = _block_loras(block, params, model=block_model)
    resolved = R.resolve(
        block_model, mode,
        positive=prompt_text, negative="",
        seed=seed, width=width, height=height, length=render_f,
        steps=params.get("steps"),
        ref_audios=[audio_name] if audio_name else (voice_names or None),
        ref_videos=video_names or None,
        exact_frames=render_f,
        workflow=AUDIOLOCK_WF if audio_name else None,
        source_audio=audio_name,
        motion_ctx=motion_ctx,
        context_save=context_save,
        loras=_lora_picks,
        # Orthogonal to model, style and turbo — hence a parameter rather than
        # a twin of each H3 row. Inherited from the block like every other
        # render flag, so an episode refines consistently or not at all.
        refine=params.get("refine"),
        split_pass=params.get("split_pass"),
        latent_upscale=params.get("latent_upscale"),
        **img_kwargs,
    )
    log(f"master_pass block {block['idx']} [{mode}] {block_model}: "
        f"{render_f}f {width}x{height} "
        f"{'locked-audio' if audio_name else 'native-audio'} "
        # Report what the GRAPH got, not what was staged: on LTX those differ
        # (panels are dropped, the plate moves to its own slot), and a count
        # that says 6 when four subjects were wired is a log that misleads
        # exactly when someone is debugging a reference.
        + (f"refs={len(img_kwargs.get('ref_images') or [])}"
           f"{'+bg' if img_kwargs.get('ref_background') else ''}"
           f" voices={len(voice_names)}"
           f"{' motion-ctx' if motion_ctx else ''}" if mode == "r2v"
           else f"open={'yes' if opening else 'no'} end={'yes' if end_name else 'no'}")
        # …and the ADAPTER STACK, which this line did not report until the
        # combat LoRA started being applied automatically. `clip_gen` has
        # always logged it; here it mattered less while every pick was a
        # deliberate one. Now that a fight block gets an adapter nobody chose,
        # "did this block render with combat?" has to be answerable from the
        # journal instead of by querying ComfyUI's running queue.
        + (" loras=" + ",".join(
            (l.get("key") if isinstance(l, dict) else str(l)) + (
                f"@{l['strength']}" if isinstance(l, dict) and l.get("strength") is not None else "")
            for l in _lora_picks)
           + (" [auto: fight]" if params.get("fight") else "")
           + (" [auto: camera]" if params.get("camera_motion") else "") if _lora_picks else "")
        + (" latent-upscale" if params.get("latent_upscale") else ""))
    pid = comfy.submit(resolved["graph"])
    sb.job_patch(jid, {"comfy_prompt_id": pid})
    outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=3600)

    sb.job_progress(jid, 0.9, note="trim + upload")
    raw = f"/tmp/{jid}_raw.mp4"
    comfy.fetch_output(outputs, resolved["outputs"], raw)

    # Trim render → exact content (output-side seek = frame exact), then
    # extract the trimmed clip's true final frame for the next chain link.
    trimmed = f"/tmp/{jid}_trim.mp4"
    args = ["-i", raw, "-ss", f"{plan.trim_start_ms / 1000:.3f}",
            "-t", f"{plan.trim_ms / 1000:.3f}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-preset", "veryfast", "-movflags", "+faststart"]
    args += (["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
             if media.has_audio(raw) else ["-an"])
    media.run_ff(args + [trimmed], "trim", cancel_check=lambda: sb.cancel_requested(jid))

    frame_png = f"/tmp/{jid}_last.png"
    media.extract_frame(trimmed, frame_png, from_end=True)

    base = f"blocks/{ep['code']}/{block['idx']:03d}"
    frame_key = f"{base}/last_{jid}.png"
    media.b2_put(frame_png, frame_key, content_type="image/png")
    frame_asset = sb.register_asset(frame_key, "frame", project_id=ep["project_id"],
                                    content_type="image/png", source_job_id=jid,
                                    meta={"block_id": block["id"], "role": "chain_anchor"},
                                    tags=["chain"])

    take_key = f"{base}/take_{jid}.mp4"
    media.b2_put(trimmed, take_key)
    info = media.probe(trimmed)
    take_asset = sb.register_asset(
        take_key, "video", project_id=ep["project_id"], content_type="video/mp4",
        bytes_=info["bytes"], width=info["width"], height=info["height"],
        duration_ms=info["duration_ms"], fps=info["fps"], source_job_id=jid,
        meta={"block_id": block["id"], "seed": seed,
              "fmt_version": compiled["fmt_version"],
              "last_frame_asset_id": frame_asset["id"]},
        tags=["block-take"])
    take = sb.insert("block_takes", {"block_id": block["id"], "job_id": jid,
                                     "asset_id": take_asset["id"], "kind": "master",
                                     "state": "pending"})

    upd = {"status": "generated", "seed": seed}
    # Three ways a take can land, and the distinction is the whole difference
    # between "give me another take" and "change what happens in this shot".
    #   activate="replace" — a CONTENT re-render: the new take becomes canonical
    #     immediately (the old ones stay in history, nothing is destroyed) and
    #     every chained successor is marked stale, because its anchor frame just
    #     moved. Before this existed a `take_of` render could never activate
    #     itself, so an edit made from the chat rendered and then sat invisible.
    #   activate="review" — leave it pending for the takes strip to choose.
    #   neither — the historical rule, untouched for every existing caller.
    activate = payload.get("activate")
    if activate in ("replace", "review"):
        make_active = activate == "replace"
    else:
        make_active = (payload.get("auto_activate", True)
                       and not payload.get("take_of"))
    if make_active:
        upd["active_take_id"] = take["id"]
        sb.patch(f"block_takes?id=eq.{take['id']}", {"state": "kept"})
    sb.patch(f"generation_blocks?id=eq.{block['id']}", upd)
    if activate == "replace":
        _mark_downstream_stale(block)

    # WHEN THIS WAS THE LAST BLOCK, the episode assembles itself.
    #
    # A BATCHED VLM JUDGE USED TO RIDE HERE TOO — a `take_review` behind every
    # take and a `visual_review_batch` every eighth block, both feeding an
    # automatic retake. Neither exists in this build: that judge wanted
    # faster-whisper and a resident 18GB vision model, so the jobs would be
    # written onto lanes nothing here claims and would sit queued for good,
    # which is worse than not offering the feature. `plan_cli.KINDS` is the
    # allow-list that says so from the other end.
    if not payload.get("take_of"):
        siblings = sb.get(f"generation_blocks?storyboard_id=eq.{block['storyboard_id']}"
                          f"&select=id,status,active_take_id")
        done_now = sum(1 for s in siblings if _delivered(s, block["id"]))
        is_last = done_now == len(siblings)
        if is_last:
            sb.insert("jobs", {
                "kind": "assemble_cut", "status": "queued", "lane": "cpu", "priority": 25,
                "project_id": ep["project_id"], "episode_id": ep["id"],
                "payload": {"storyboard_id": block["storyboard_id"]}})
            log("last block generated — assemble_cut queued")

    sb.job_done(jid, output_asset_id=take_asset["id"])
    for p in (raw, trimmed, frame_png):
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE master_pass block {block['idx']} -> take {take['id']} "
        f"({info['duration_ms']}ms, target {plan.trim_ms}ms)")


# ------------------------------------------------------------ audio slice ----
def handle_audio_slice(job):
    """Cut the storyboard's master track for one block: starts one warmup
    early (silence-padded when the block starts at t=0) and runs the whole
    padded render so the model hears audio through warmup and tail."""
    jid = job["id"]
    payload = job.get("payload") or {}
    block = _load_block(payload["block_id"])
    story = sb.get(f"storyboards?id=eq.{block['storyboard_id']}")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=code,project_id")[0]
    src_asset_id = (block.get("audio_slice") or {}).get("asset_id") or story.get("audio_asset_id")
    if not src_asset_id:
        raise ValueError("storyboard has no master audio asset")
    src = sb.asset_by_id(src_asset_id)

    plan = h3_timing.plan_block(block["t_end_ms"] - block["t_start_ms"])
    warmup_ms = h3_timing.frames_to_ms(plan.warmup_f)
    start = block["t_start_ms"] - warmup_ms
    pad = -start if start < 0 else 0

    local = f"/tmp/{jid}_src{os.path.splitext(src['b2_key'])[1] or '.wav'}"
    media.b2_get(src["b2_key"], local)
    out = f"/tmp/{jid}_slice.wav"
    media.slice_audio(local, out, start_ms=max(0, start),
                      duration_ms=plan.render_ms - pad, pad_start_ms=pad)

    key = f"blocks/{ep['code']}/{block['idx']:03d}/slice_{jid}.wav"
    media.b2_put(out, key, content_type="audio/wav")
    asset = sb.register_asset(key, "audio", project_id=ep["project_id"],
                              content_type="audio/wav", source_job_id=jid,
                              duration_ms=plan.render_ms,
                              meta={"block_id": block["id"], "offset_ms": start},
                              tags=["slice"])
    slice_meta = dict(block.get("audio_slice") or {})
    slice_meta.update({"asset_id": src_asset_id, "offset_ms": start,
                       "duration_ms": plan.render_ms, "slice_asset_id": asset["id"]})
    sb.patch(f"generation_blocks?id=eq.{block['id']}", {"audio_slice": slice_meta})
    sb.job_done(jid, output_asset_id=asset["id"])
    for p in (local, out):
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE audio_slice block {block['idx']} ({start}ms +{plan.render_ms}ms)")


# -------------------------------------------------------------- FLF patch ----
def handle_patch_flf(job):
    """Regenerate [in,out] of a take between its own boundary frames."""
    jid = job["id"]
    payload = job.get("payload") or {}
    block = _load_block(payload["block_id"])
    take = sb.get(f"block_takes?id=eq.{payload['take_id']}")[0]
    take_asset = sb.asset_by_id(take["asset_id"])
    story, ep, project, _scenes, _beats, _cast, _env = _load_context(block)

    in_ms, out_ms = int(payload["in_ms"]), int(payload["out_ms"])
    if out_ms - in_ms < 250:
        raise ValueError("patch range too small")
    # H3 needs ≥4s: widen symmetrically inside the clip, then trim back.
    span = out_ms - in_ms
    want = max(span, h3_timing.MIN_CONTENT_MS)
    grow = (want - span) / 2
    g_in = max(0, int(in_ms - grow))
    g_out = min(take_asset["duration_ms"] or out_ms, int(g_in + want))
    g_in = max(0, g_out - want)

    local = f"/tmp/{jid}_take.mp4"
    media.b2_get(take_asset["b2_key"], local)
    first_png, last_png = f"/tmp/{jid}_f.png", f"/tmp/{jid}_l.png"
    media.extract_frame(local, first_png, at_ms=g_in)
    media.extract_frame(local, last_png, at_ms=max(g_in, g_out - 42))  # last displayed frame

    fname = f"qamba_pf_{jid}.png"
    lname = f"qamba_pl_{jid}.png"
    import shutil
    shutil.copy(first_png, os.path.join(COMFY_ROOT, "input", fname))
    shutil.copy(last_png, os.path.join(COMFY_ROOT, "input", lname))

    plan = h3_timing.plan_block(g_out - g_in, warmup_f=0, cooldown_f=0)
    prompt = payload.get("prompt") or \
        h3_prompt.full_prompt_text(block.get("compiled_prompt")) if block.get("compiled_prompt") else ""
    body = payload.get("prompt") or prompt or "seamless continuation of the scene"
    # A block's compiled prompt already carries its trigger tokens (the master
    # pass baked them in); an override prompt from the payload does not, and
    # re-rendering one segment with the adapter inert is exactly the mid-block
    # look change patching exists to avoid. with_triggers is a no-op on the
    # first case.
    body = h3_prompt.with_triggers(
        body, R.lora_triggers(_block_model(block),
                              _block_loras(block, model=_block_model(block))))
    # Official FL2VA contract: the alignment instruction is the first line.
    body = h3_prompt.flf_alignment_line(g_out - g_in) + "\n\n" + body
    resolved = R.resolve(
        _block_model(block), "flf",
        positive=body,
        negative="", seed=int(payload.get("seed") or 42),
        width=take_asset["width"] or 1280, height=take_asset["height"] or 720,
        length=plan.render_f, exact_frames=plan.render_f,
        source_image=fname, end_image=lname,
        loras=_block_loras(block, model=_block_model(block)),
        # A patch is spliced INTO the block's own take, so a patch that skipped
        # the refine pass would be a visibly softer few seconds in the middle
        # of it — the same reasoning that makes patch_flf read `model_key`.
        refine=(block.get("params") or {}).get("refine"),
        split_pass=(block.get("params") or {}).get("split_pass"))
    log(f"patch_flf block {block['idx']} [{g_in}..{g_out}]ms {plan.render_f}f")
    pid = comfy.submit(resolved["graph"])
    sb.job_patch(jid, {"comfy_prompt_id": pid})
    outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=3600)

    raw = f"/tmp/{jid}_raw.mp4"
    comfy.fetch_output(outputs, resolved["outputs"], raw)
    patch = f"/tmp/{jid}_patch.mp4"
    args = ["-i", raw, "-t", f"{(g_out - g_in) / 1000:.3f}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-preset", "veryfast", "-movflags", "+faststart"]
    args += (["-c:a", "aac", "-b:a", "192k", "-ac", "2"] if media.has_audio(raw) else ["-an"])
    media.run_ff(args + [patch], "patch-trim")

    key = f"blocks/{ep['code']}/{block['idx']:03d}/patch_{jid}.mp4"
    media.b2_put(patch, key)
    info = media.probe(patch)
    asset = sb.register_asset(key, "video", project_id=ep["project_id"],
                              content_type="video/mp4", bytes_=info["bytes"],
                              width=info["width"], height=info["height"],
                              duration_ms=info["duration_ms"], fps=info["fps"],
                              source_job_id=jid,
                              meta={"block_id": block["id"], "patch_of": take["id"]},
                              tags=["patch"])
    ptake = sb.insert("block_takes", {"block_id": block["id"], "job_id": jid,
                                      "asset_id": asset["id"], "kind": "patch",
                                      "patch_range": {"in_ms": g_in, "out_ms": g_out},
                                      "state": "pending"})
    sb.job_done(jid, output_asset_id=asset["id"])
    for p in (local, first_png, last_png, raw, patch):
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE patch_flf -> take {ptake['id']}")


# ------------------------------------------------------------ patch splice ---
def handle_patch_splice(job):
    """base[0,in) + patch + base(out,end] -> spliced take; repoint active."""
    jid = job["id"]
    payload = job.get("payload") or {}
    block = _load_block(payload["block_id"])
    base = sb.get(f"block_takes?id=eq.{payload['base_take_id']}")[0]
    # Dep-chained splices can't know the patch take id at enqueue time —
    # resolve it from the patch job when given patch_job_id instead.
    if payload.get("patch_job_id") and not payload.get("patch_take_id"):
        rows = sb.get(f"block_takes?job_id=eq.{payload['patch_job_id']}&kind=eq.patch")
        if not rows:
            raise ValueError(f"patch job {payload['patch_job_id']} produced no take")
        patch = rows[0]
    else:
        patch = sb.get(f"block_takes?id=eq.{payload['patch_take_id']}")[0]
    pr = patch.get("patch_range") or {}
    in_ms, out_ms = int(pr["in_ms"]), int(pr["out_ms"])
    story = sb.get(f"storyboards?id=eq.{block['storyboard_id']}&select=episode_id")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=code,project_id")[0]

    base_a, patch_a = sb.asset_by_id(base["asset_id"]), sb.asset_by_id(patch["asset_id"])
    bl, pl = f"/tmp/{jid}_base.mp4", f"/tmp/{jid}_patch.mp4"
    media.b2_get(base_a["b2_key"], bl)
    media.b2_get(patch_a["b2_key"], pl)

    out = f"/tmp/{jid}_spliced.mp4"
    dur = base_a["duration_ms"]
    fc = (f"[0:v]trim=end={in_ms / 1000:.3f},setpts=PTS-STARTPTS[v0];"
          f"[1:v]setpts=PTS-STARTPTS[v1];"
          f"[0:v]trim=start={out_ms / 1000:.3f},setpts=PTS-STARTPTS[v2];"
          f"[v0][v1][v2]concat=n=3:v=1:a=0[v]")
    maps = ["-map", "[v]"]
    if media.has_audio(bl):
        # Keep the base take's audio bed across the whole clip (H3 native or
        # locked track) — the patch replaces picture only.
        fc += f";[0:a]atrim=end={dur / 1000:.3f},asetpts=PTS-STARTPTS[a]"
        maps += ["-map", "[a]"]
    media.run_ff(["-i", bl, "-i", pl, "-filter_complex", fc] + maps +
                 ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out],
                 "splice", cancel_check=lambda: sb.cancel_requested(jid))

    asset, stake = _publish_derived_take(
        jid, block, ep, out, name="spliced", kind="spliced", patch_range=pr,
        meta={"spliced_from": [base["id"], patch["id"]]})
    sb.job_done(jid, output_asset_id=asset["id"])
    for p in (bl, pl, out):
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE patch_splice -> take {stake['id']} (active)")


def _publish_derived_take(jid, block, ep, path, *, name, kind, meta=None,
                          patch_range=None, activate=True, mark_stale=True):
    """Upload a clip built from existing takes, register it, and make it the
    block's active take. -> (asset, take)

    The chain anchor is the part that must not be forgotten: the next block
    opens on this block's LAST FRAME, so any new active take has to publish a
    fresh `frame` asset and mark the downstream chain stale. Every derived
    take (splice, assembly) goes through here so that cannot be skipped in one
    path and remembered in another.

    `mark_stale=False` is for the ONE case where the sweep would be noise
    rather than safety: a block that did not exist a moment ago
    (`block_from_clip`). `_mark_downstream_stale` marks every chained block
    ABOVE this idx, and nothing chains from a block that has just been
    inserted — its neighbours' anchors are unchanged, by id. Marking them
    would invite a re-render of half an episode to record that a derived block
    was saved. The frame asset is still published either way, because the new
    block is a legitimate chain anchor for anything the editor points at it
    later.
    """
    key = f"blocks/{ep['code']}/{block['idx']:03d}/{name}_{jid}.mp4"
    media.b2_put(path, key)
    info = media.probe(path)
    frame_png = f"/tmp/{jid}_last.png"
    media.extract_frame(path, frame_png, from_end=True)
    fkey = f"blocks/{ep['code']}/{block['idx']:03d}/last_{jid}.png"
    media.b2_put(frame_png, fkey, content_type="image/png")
    frame_asset = sb.register_asset(fkey, "frame", project_id=ep["project_id"],
                                    content_type="image/png", source_job_id=jid,
                                    meta={"block_id": block["id"]}, tags=["chain"])
    asset = sb.register_asset(key, "video", project_id=ep["project_id"],
                              content_type="video/mp4", bytes_=info["bytes"],
                              width=info["width"], height=info["height"],
                              duration_ms=info["duration_ms"], fps=info["fps"],
                              source_job_id=jid,
                              meta={"block_id": block["id"],
                                    "last_frame_asset_id": frame_asset["id"],
                                    **(meta or {})},
                              tags=["block-take"])
    take = sb.insert("block_takes", {"block_id": block["id"], "job_id": jid,
                                     "asset_id": asset["id"], "kind": kind,
                                     "patch_range": patch_range,
                                     "state": "kept" if activate else "pending"})
    if activate:
        sb.patch(f"generation_blocks?id=eq.{block['id']}", {"active_take_id": take["id"]})
        if mark_stale:
            _mark_downstream_stale(block)
    try:
        os.remove(frame_png)
    except OSError:
        pass
    return asset, take


# ---------------------------------------------------------- assemble take ----
def _assembly_block(jid, src, ep, asm, payload):
    """The block an off-plan cut becomes. -> {block, idx, shifted, by_idx}

    It inherits the shot it was cut from — the same scenes, the same beats, the
    same references and params — because it IS that shot, re-cut. What it does
    NOT inherit is anything that describes a RENDER of the old length:

      * `t_end_ms` is the cut's own, so the block finally says how long it is;
      * `frames` and `trim` describe a render nobody made here;
      * `compiled_prompt` is left null rather than copied — the source's is
        stamped with ITS timestamps over ITS length, and a prompt that
        describes a different shot looks authoritative in PromptRefsModal;
      * `chain_from_block_id` is dropped. A chain anchor is the previous
        block's final frame; whatever chained from the SOURCE still chains from
        the source, by id, and the source still ends where it ended.
      * `audio_slice` is dropped with it. A locked slice is a window of the
        master track cut to the old length, and re-cutting it here would be a
        guess at which seconds a longer cut wants.
    """
    sid = src["storyboard_id"]
    cut_ms = int(asm["duration_ms"])
    idx, shifted, by_idx = place_block(sid, src, append=bool(payload.get("append")))
    block = sb.insert("generation_blocks", {
        "storyboard_id": sid, "idx": idx,
        "scene_ids": src.get("scene_ids") or [],
        "beat_ids": src.get("beat_ids") or [],
        "t_start_ms": int(src["t_start_ms"]),
        "t_end_ms": int(src["t_start_ms"]) + cut_ms,
        "frames": 0, "trim": {},
        "mode": src.get("mode") or "r2v",
        "compiled_prompt": None,
        "ref_plan": src.get("ref_plan") or [],
        "audio_mode": src.get("audio_mode") or "native",
        "audio_slice": None,
        "chain_from_block_id": None,
        "status": "generated",
        "params": {**(src.get("params") or {}),
                   "derived_from": {"block_id": src["id"], "assembly_id": asm["id"],
                                    "duration_ms": cut_ms}},
        "seed": src.get("seed"),
    })
    log(f"assemble_take: cut is {cut_ms}ms against {_block_ref(src['idx'])}'s "
        f"{int(src['t_end_ms']) - int(src['t_start_ms'])}ms — new "
        f"{_block_ref(idx)} ({block['id'][:8]}), {len(shifted)} renumbered")
    return {"block": block, "idx": idx, "shifted": shifted, "by_idx": by_idx}


def handle_assemble_take(job):
    """Render a `take_assemblies` row: the canonical performance, cut from
    several takes of one block.

    The row is an ordered list of SLICES — a take plus a window inside it — so
    each one is a plain trim of its own take and concat lays them end to end:
    one ffmpeg pass, no retiming. The result becomes an ordinary take of the
    block (kind 'spliced'), which is what keeps it inside every downstream rule
    already written: it can be reviewed, it can be superseded, and activating
    it re-anchors the chain.

    A cut is free to be a different length from the block it belongs to, so the
    delta is LOGGED rather than refused. What it decides is downstream: a
    shorter take shrinks the clip on the timeline (`blockSync.takeSwapPatch`)
    and a longer one is played only as far as the clip's slot reaches.
    """
    import assembly as A
    jid = job["id"]
    payload = job.get("payload") or {}
    rows = sb.get(f"take_assemblies?id=eq.{payload['assembly_id']}")
    if not rows:
        raise ValueError(f"assembly {payload['assembly_id']} not found")
    asm = rows[0]
    block = _load_block(asm["block_id"])
    story = sb.get(f"storyboards?id=eq.{block['storyboard_id']}&select=episode_id")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,code,project_id")[0]

    segments = asm["segments"] or []
    A.validate(segments, asm["duration_ms"])
    order = A.plan_inputs(segments)
    sb.patch(f"take_assemblies?id=eq.{asm['id']}",
             {"status": "rendering", "render_job_id": jid})

    takes = sb.get(f"block_takes?id=in.({','.join(order)})&select=id,asset_id,kind")
    by_id = {t["id"]: t for t in takes}
    missing = [t for t in order if t not in by_id]
    if missing:
        raise ValueError(f"assembly names takes that no longer exist: {missing}")

    # One download per TAKE, not per span — a take used three times is fetched
    # once and trimmed three times.
    files, input_of, audio_of, probes, tmp = {}, {}, {}, {}, []
    for i, tid in enumerate(order):
        a = sb.asset_by_id(by_id[tid]["asset_id"])
        if not a:
            raise ValueError(f"take {tid[:8]} has no asset")
        local = f"/tmp/{jid}_in{i}.mp4"
        media.b2_get(a["b2_key"], local)
        files[tid], input_of[tid] = local, i
        probes[tid] = media.probe(local)
        audio_of[tid] = probes[tid]["has_audio"]
        tmp.append(local)
    sb.job_progress(jid, 0.4, note=f"assembling {len(segments)} span(s)")

    # Concat's geometry is taken from the FIRST span's take, and everything
    # else is fitted to it. Takes of one block agree already; an uploaded one
    # need not, and the filter rejects a mismatch outright.
    lead = probes[segments[0]["take_id"]]

    args = []
    for tid in order:
        args += ["-i", files[tid]]
    silent_index = None
    if any(audio_of.values()) and not all(audio_of.values()):
        silent_index = len(order)
        args += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    fc, maps, want_audio = A.build_filtergraph(
        segments, input_of, audio_of=audio_of, silent_index=silent_index,
        width=lead["width"], height=lead["height"], fps=lead["fps"])

    out = f"/tmp/{jid}_assembled.mp4"
    enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
           "-preset", "veryfast", "-movflags", "+faststart"]
    enc += (["-c:a", "aac", "-b:a", "192k", "-ac", "2"] if want_audio else ["-an"])
    plan_ms = max(0, int(block.get("t_end_ms") or 0) - int(block.get("t_start_ms") or 0))
    delta = int(asm["duration_ms"]) - plan_ms
    log(f"assemble_take block {block['idx']}: {A.describe(segments)}"
        + (f" [{delta:+d}ms vs the block's {plan_ms}ms slot]" if plan_ms and abs(delta) > 40 else ""))
    media.run_ff(args + ["-filter_complex", fc] + maps + enc + [out], "assemble-take",
                 cancel_check=lambda: sb.cancel_requested(jid))

    sb.job_progress(jid, 0.8, note="publishing")
    meta = {"assembly_id": asm["id"], "assembled_from": order, "segments": segments}

    # A cut that does not fit its block becomes a BLOCK OF ITS OWN, which is
    # the same answer "save as new block" already gives a trim on the lane and
    # for the same reason: a take that is quietly the wrong length for its slot
    # is played short, or leaves a gap, and nothing downstream says so. The
    # browser refuses to send this any other way (`commitAssembly`), so the
    # length is a fact by the time it arrives rather than something to check.
    if payload.get("as_new_block"):
        target = _assembly_block(jid, block, ep, asm, payload)
        asset, take = _publish_derived_take(
            jid, target["block"], ep, out, name="assembled", kind="spliced",
            mark_stale=False, meta={**meta, "derived_from_block_id": block["id"]})
        info = media.probe(out)
        # The new block takes the SOURCE's place on the lane: the clip the user
        # was looking at is the one they assembled, and two clips over one
        # window is not what "save as its own block" means.
        _attach_to_clip({"clip_id": payload.get("clip_id")}, asset, info,
                        extra={"block_id": target["block"]["id"],
                               "label": _clip_label("shot", target["idx"],
                                                    _clip_now(payload.get("clip_id")))},
                        label="assemble_take")
        _repoint_linked_audio(payload.get("clip_id"), asset, info,
                              target["block"]["id"], target["idx"], "shot")
        _relabel_block_clips(target["shifted"], target["by_idx"],
                             _block_kinds(target["by_idx"].values()))
        _exclude_source_block(payload.get("clip_id"), block["id"])
        _exclude_from_other_cuts(payload.get("clip_id"), target["block"]["id"],
                                 label="assemble_take")
        block = target["block"]
    else:
        asset, take = _publish_derived_take(
            jid, block, ep, out, name="assembled", kind="spliced", meta=meta)
    sb.patch(f"take_assemblies?id=eq.{asm['id']}",
             {"status": "rendered", "output_take_id": take["id"]})

    sb.job_done(jid, output_asset_id=asset["id"])
    for p in tmp + [out]:
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE assemble_take block {block['idx']} -> take {take['id']} "
        f"({len(segments)} span(s) from {len(order)} take(s), active"
        f"{', as a new block' if payload.get('as_new_block') else ''})")


def _mark_downstream_stale(block):
    """The chain anchor changed: every later chained block is now stale."""
    sb.patch(f"generation_blocks?storyboard_id=eq.{block['storyboard_id']}"
             f"&idx=gt.{block['idx']}&chain_from_block_id=not.is.null"
             f"&status=in.(generated,stale)", {"status": "stale"})



# ------------------------------------------------------- block from a clip ---
# "SAVE AS NEW BLOCK": the trim on the lane becomes a block of its own.
#
# A block clip points at a `generation_blocks` row and at that block's active
# take, which is the WHOLE render. Trim the clip and the lane shows a WINDOW of
# that take while the block still describes all of it — so the trim lives in
# the cut and nowhere else, and three separate things then ignore it or
# overwrite it: `assemble_cut` concatenates take assets whole,
# `syncBlocksToTimeline` repoints the media under the clip every time a take
# lands, and `launch_render` deletes every block of the storyboard on a
# re-plan. Each of those is silent; you find out by looking at the picture.
#
# This ends it. The window is cut to its own asset, that asset becomes a NEW
# block's active take, and the clip repoints at the new block. Afterwards the
# trim IS the block, and every rule already written applies to it: it can be
# retaken, compared, extended, chained, reviewed and assembled.

#: A block shorter than this is not a shot. Mirrors `MIN_BLOCK_MS` in
#: src/lib/blockFromClip.ts, which is where the browser refuses first.
MIN_BLOCK_MS = 200


def place_block(sid, after, *, append=False):
    """Make room for a new block and say where it goes.
    -> (new_idx, shifted, by_idx)

    Straight after its anchor, so story order still reads as story order —
    `assemble_cut` orders by idx, and appending to the end would put a
    mid-episode shot after the last one. A block with no anchor has no story
    position to claim, so it genuinely does append.

    `append` is the caller asking for the OTHER trade at the moment of saving.
    Inserting renumbers every block after the anchor — which is what made a save
    look like it had duplicated a shot, because a clip's label is a stored
    snapshot of `idx` and every follower's went stale at once. Appending leaves
    all of them alone and costs story order instead: the shot renders at the END
    of the episode until it is moved. Neither is free, so the choice is offered
    rather than picked here.

    Shared by every route that adds a block — the trim promoted off a lane and
    the assembled cut that outgrew its own block — because the renumbering and
    the relabelling that has to follow it are the parts one path remembers and
    another forgets.
    """
    peers = sb.get(f"generation_blocks?storyboard_id=eq.{sid}&select=id,idx&order=idx")
    by_idx = {int(b["idx"]): b["id"] for b in peers}
    if after is not None and not append:
        shifted = idx_shift(by_idx.keys(), int(after["idx"]))
        for frm, to in shifted:
            sb.patch(f"generation_blocks?storyboard_id=eq.{sid}&idx=eq.{frm}", {"idx": to})
        return int(after["idx"]) + 1, shifted, by_idx
    return ((max(by_idx) + 1) if by_idx else 0), [], by_idx


def beats_in_window(beat_ids, by_id, in_ms, out_ms):
    """Which of a block's beats the window [in_ms, out_ms) actually covers.

    Pure, and it is what decides whether the derived block can ever be
    RE-RENDERED sanely. `handle_master_pass` compiles the prompt from
    `beat_ids`, and `h3_prompt` stamps `[Shot N] At HH:MM:SS.mmm` from their
    durations — so copying the source block's whole list onto a block a third
    its length puts every timestamp after the first past the end of the
    render. That is the same defect `revise_block`'s `_absorb_residual` exists
    to prevent, arriving from a different direction.

    `beat_ids` are stored in chronological order by `launch_render`, so the
    offsets are a running sum over their durations. A beat is kept when it
    OVERLAPS the window at all rather than when it sits wholly inside it: a
    shot the trim cuts in half is still a shot the block plays, and dropping
    it would leave the compiler with nothing to say about that time.
    """
    kept, at = [], 0
    for bid in beat_ids or []:
        dur = int((by_id.get(bid) or {}).get("duration_ms") or 0)
        if at < out_ms and at + dur > in_ms:
            kept.append(bid)
        at += dur
    # A window that fell between two beats — or a block whose beats record no
    # durations at all — keeps the first one rather than none. An empty
    # `beat_ids` compiles to an empty prompt, and a block that cannot describe
    # itself is worse than one that describes itself approximately.
    return kept or ([beat_ids[0]] if beat_ids else [])


def idx_shift(taken, after_idx):
    """The renumbering that opens a slot at `after_idx + 1`.

    -> [(from_idx, to_idx), …] HIGHEST FIRST, which is the only order that
    works: `generation_blocks` is `unique (storyboard_id, idx)` and the
    constraint is not deferrable, so shifting front to back collides with the
    row it is about to move. PostgREST patches a row at a time, so there is no
    single statement to hide behind. Same rule, same reason, as `add_scene`'s
    back-to-front resequence.
    """
    return [(i, i + 1) for i in sorted({int(i) for i in taken if int(i) > after_idx},
                                       reverse=True)]


def handle_block_from_clip(job):
    """Cut a timeline clip's window out of its take and make it a new block.

    Two shapes. With `block_id` it is the original "save as new block": the
    window of a BLOCK clip's take becomes a sibling block, inheriting the
    source's plan. With `block_id: null` it PROMOTES a blockless clip — a
    landed extend/chain from before those made blocks of their own, or
    imported media — into the storyboard: placement comes from
    `after_block_id` (the nearest lane neighbour, chosen in the browser
    looking at the lane), falling back to the tail of the episode's newest
    storyboard. Either way the result is an ordinary block with an active
    take, so the strip, assembly and reviews apply to it untouched.
    """
    jid = job["id"]
    payload = job.get("payload") or {}
    src = _load_block(payload["block_id"]) if payload.get("block_id") else None
    in_ms, out_ms = int(payload["in_ms"]), int(payload["out_ms"])
    if out_ms - in_ms < MIN_BLOCK_MS:
        raise ValueError(f"window {in_ms}-{out_ms}ms is too short to be a block")

    # WHERE the block goes: beside its source, beside the nearest lane
    # neighbour, or appended to the newest storyboard. A vanished neighbour is
    # a fallback rather than a failure — the row it named may have been
    # deleted between the click and the claim.
    after = src
    if src is None and payload.get("after_block_id"):
        rows = sb.get(f"generation_blocks?id=eq.{payload['after_block_id']}")
        after = rows[0] if rows else None
        if after is None:
            log(f"block_from_clip: neighbour {payload['after_block_id']} is "
                f"gone — appending to the newest storyboard instead")
    sid = (after or {}).get("storyboard_id") or _newest_storyboard_id(job.get("episode_id"))

    story = sb.get(f"storyboards?id=eq.{sid}&select=episode_id")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,code,project_id")[0]

    # The media is the one the CLIP is showing, not the block's active take.
    # They disagree whenever someone picked a take from the library for this
    # clip alone, and what the user trimmed is what they were looking at.
    a = sb.asset_by_id(payload["asset_id"])
    if not a:
        raise ValueError(f"asset {payload.get('asset_id')} not found")

    # A promoted clip whose window is the WHOLE file needs no cut: re-encoding
    # would register a byte-similar second copy of an asset already in the
    # library, so the take points at the media the clip already plays. A
    # source-block save always cuts — its window is a piece of a take, never
    # the take.
    media_ms = int(a.get("duration_ms") or 0)
    whole = src is None and in_ms <= 0 and media_ms > 0 and out_ms >= media_ms
    local = out = None
    if not whole:
        local = f"/tmp/{jid}_src.mp4"
        media.b2_get(a["b2_key"], local)
        sb.job_progress(jid, 0.3, note=f"cutting {in_ms}-{out_ms}ms")

        # The FILTER form, not `-ss`/`-to`. Their meaning depends on which
        # side of `-i` they sit and whether `-copyts` is set, and a stream
        # copy would snap to the nearest keyframe — which is exactly the trim
        # being wrong, silently and by up to a second. `trim` takes
        # input-timeline seconds and is what `patch_splice` already uses.
        out = f"/tmp/{jid}_block.mp4"
        s0, s1 = in_ms / 1000, out_ms / 1000
        fc = f"[0:v]trim=start={s0:.3f}:end={s1:.3f},setpts=PTS-STARTPTS[v]"
        maps = ["-map", "[v]"]
        enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
               "-preset", "veryfast", "-movflags", "+faststart"]
        if media.has_audio(local):
            fc += f";[0:a]atrim=start={s0:.3f}:end={s1:.3f},asetpts=PTS-STARTPTS[a]"
            maps += ["-map", "[a]"]
            enc += ["-c:a", "aac", "-b:a", "192k"]
        else:
            enc += ["-an"]
        media.run_ff(["-i", local, "-filter_complex", fc] + maps + enc + [out],
                     "block-from-clip", cancel_check=lambda: sb.cancel_requested(jid))

    # --- the row -------------------------------------------------------------
    # Straight after its anchor, so story order still reads as story order —
    # `assemble_cut` orders by idx, and appending to the end would put a
    # mid-episode shot after the last one. A promotion with no anchor has no
    # story position to claim, so it genuinely does append.
    #
    # `payload.append` is the user asking for the OTHER trade at the moment of
    # saving. Inserting renumbers every block after the anchor — which is what
    # made a save look like it had duplicated a shot, because a clip's label
    # is a stored snapshot of `idx` and every follower's went stale at once.
    # Appending leaves all of them alone and costs story order instead: this
    # shot renders at the END of the episode until it is moved. Neither is
    # free, so the choice is offered rather than picked here. Placement ONLY —
    # a source block still lends its beats, scenes and params below.
    place_at_end = bool(payload.get("append"))
    sb.job_progress(jid, 0.6,
                    note="adding the block" if place_at_end else "inserting the block")
    new_idx, shifted, by_idx = place_block(sid, after, append=place_at_end)

    if src:
        beats = sb.get(f"beats?id=in.({','.join(src['beat_ids'])})") if src.get("beat_ids") else []
        kept = beats_in_window(src.get("beat_ids"), {b["id"]: b for b in beats}, in_ms, out_ms)
        scenes = [s for s in (src.get("scene_ids") or [])
                  if s in {(b.get("scene_id")) for b in beats if b["id"] in kept}]
    else:
        kept, scenes = [], []

    # A promoted clip may carry its own RECIPE — handle_clip_gen stamps the
    # re-runnable payload onto the asset's meta — and that is what makes the
    # new block retakeable at all: no beats means nothing to compile, so
    # master_pass delegates to the recipe. It only travels when the window is
    # the WHOLE render: a retake replays the whole recipe, and takes of one
    # block should agree in length.
    recipe = _recover_recipe(a) if whole else None
    # The KIND comes from the recipe's own mode, so a promoted chain is a
    # chain rather than a nameless "shot". A caller may state it (the browser
    # knows which action made the clip); the recipe is the check.
    kind = (payload.get("clip_kind")
            or (_kind_from_mode(recipe.get("mode")) if recipe else None)
            or ("trim" if src else "shot"))

    if src:
        params = {**(src.get("params") or {}),
                  "derived_from": {"block_id": src["id"], "in_ms": in_ms, "out_ms": out_ms}}
    else:
        params = {"clip_kind": kind,
                  "derived_from": {"clip_id": payload.get("clip_id"),
                                   "asset_id": a["id"],
                                   "in_ms": in_ms, "out_ms": out_ms}}
        if recipe:
            # model_key/loras at the top level too: the extend modal seeds its
            # LoRA stack from params.loras, and inside the recipe they would
            # be invisible to it.
            params["clip_gen"] = recipe
            if recipe.get("model_key"):
                params["model_key"] = recipe["model_key"]
            if recipe.get("loras"):
                params["loras"] = recipe["loras"]

    r_mode = str((recipe or {}).get("mode") or "").lower()
    block = sb.insert("generation_blocks", {
        "storyboard_id": sid, "idx": new_idx,
        "scene_ids": scenes or ((src or after or {}).get("scene_ids") or []),
        "beat_ids": kept,
        # The plan's own clock for a source save, shifted to the window; a
        # promotion sits after its anchor.
        "t_start_ms": (int(src["t_start_ms"]) + in_ms) if src
                      else int((after or {}).get("t_end_ms") or 0),
        "t_end_ms": (int(src["t_start_ms"]) + out_ms) if src
                    else int((after or {}).get("t_end_ms") or 0) + (out_ms - in_ms),
        # Frames and trim describe a RENDER, and this block was cut or
        # adopted, never rendered — `master_pass` recomputes both from the
        # window (or replays the recipe) if anyone ever retakes it; claiming
        # the source block's padding here would be a measurement nobody made.
        "frames": 0, "trim": {},
        "mode": (src.get("mode") or "r2v") if src
                else (r_mode if r_mode in H3_MODES else "r2v"),
        # No compiled prompt, deliberately: the source block's is stamped with
        # ITS timestamps over ITS whole length. `master_pass` compiles from
        # the beats above, so leaving this null is the honest state — "not yet
        # compiled" — where a copy would be a prompt that describes a
        # different shot and looks authoritative in PromptRefsModal.
        "compiled_prompt": None,
        "ref_plan": (src.get("ref_plan") or []) if src else [],
        "audio_mode": (src.get("audio_mode") or "native") if src else "native",
        # A locked-audio block's slice is a window of the master track, so it
        # moves with the trim. Left alone it would re-cut the wrong seconds.
        "audio_slice": _shift_audio_slice(src.get("audio_slice"), in_ms, out_ms)
                       if src else None,
        # NOT chained. A chain anchor is the previous block's final frame, and
        # a window that starts mid-block does not open on it. The block that
        # chained from the SOURCE still chains from the source — anchors are
        # by id, and the source still ends where it ended.
        "chain_from_block_id": None,
        "status": "generated",
        "params": params,
        "seed": src.get("seed") if src else (recipe or {}).get("seed"),
    })

    if whole:
        # The take IS the clip's own media — no re-encode, no second copy.
        take = sb.insert("block_takes", {"block_id": block["id"], "job_id": jid,
                                         "asset_id": a["id"], "kind": "master",
                                         "patch_range": None, "state": "kept"})
        sb.patch(f"generation_blocks?id=eq.{block['id']}",
                 {"active_take_id": take["id"]})
        asset, info = a, {"duration_ms": media_ms}
        # The clip's geometry already IS this window; only the block link and
        # the label change. Best effort — the block exists either way.
        if payload.get("clip_id"):
            try:
                cur = sb.get(f"clips?id=eq.{payload['clip_id']}&select=label")
                sb.patch(f"clips?id=eq.{payload['clip_id']}",
                         {"block_id": block["id"],
                          "label": _clip_label(kind, new_idx,
                                               (cur or [{}])[0].get("label"))})
            except Exception as e:
                log(f"block_from_clip: could not relink the clip: {e}")
    else:
        asset, take = _publish_derived_take(
            jid, block, ep, out, name="trim", kind="spliced", mark_stale=False,
            meta={"derived_from_block_id": (src or {}).get("id"),
                  "derived_from_asset_id": a["id"],
                  "window_ms": [in_ms, out_ms]})

        # --- the lane ----------------------------------------------------------
        sb.job_progress(jid, 0.9, note="repointing the clip")
        info = media.probe(out)
        _attach_to_clip({"clip_id": payload.get("clip_id")}, asset, info,
                        extra={"block_id": block["id"],
                               "label": _clip_label(kind, new_idx, _clip_now(payload.get("clip_id")))},
                        label="block_from_clip")
    _repoint_linked_audio(payload.get("clip_id"), asset, info, block["id"], new_idx, kind)
    _relabel_block_clips(shifted, by_idx, _block_kinds(by_idx.values()))
    if src:
        _exclude_source_block(payload.get("clip_id"), src["id"])
    # And the new block must not be re-inserted into the episode's OTHER cuts
    # at an overlapping window by the next sync — see the helper's docstring.
    _exclude_from_other_cuts(payload.get("clip_id"), block["id"],
                             label="block_from_clip")

    sb.job_done(jid, output_asset_id=asset["id"])
    for p in (local, out):
        if not p:
            continue
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE block_from_clip: {('b' + str(src['idx'])) if src else 'clip'} "
        f"[{in_ms}-{out_ms}ms] -> block {new_idx} ({block['id'][:8]}, take "
        f"{take['id'][:8]}), {len(kept)}/{len((src or {}).get('beat_ids') or [])} "
        f"beat(s), {len(shifted)} block(s) renumbered")


def _repoint_linked_audio(clip_id, asset, info, block_id, new_idx, kind="plan"):
    """Move the detached AUDIO half onto the new take with its picture.

    A detached pair is two clips over the same window of the same file, and
    `LINK_KEYS` mirrors `t_start_ms`, `duration_ms`, `in_ms` and `out_ms`
    between them on every edit. Repointing only the picture leaves the sound on
    the OLD asset at the old offset — the two play the same content, so nothing
    looks wrong, and then the first trim mirrors the picture's geometry onto a
    clip whose media starts somewhere else and the pair goes out of sync by
    exactly the head trim. Silent, and found only by listening.

    The window is the whole cut on both halves, because the cut IS the window
    they shared. `block_id` moves too: `detachedClipFrom` copies it, and
    `_exclude_source_block` counts picture clips only, so the two agree.

    Best effort — the picture is already right, and failing a job whose render
    has landed to record a label is the worse trade.
    """
    if not clip_id:
        return
    try:
        rows = sb.get(f"clips?id=eq.{clip_id}&select=linked_clip_id")
        aud = rows[0].get("linked_clip_id") if rows else None
        if not aud:
            return
        dur = int(info.get("duration_ms") or 0)
        cur = sb.get(f"clips?id=eq.{aud}&select=label")
        sb.patch(f"clips?id=eq.{aud}", {
            "asset_id": asset["id"], "in_ms": 0, "out_ms": dur or None,
            "block_id": block_id,
            "label": _clip_label(kind, new_idx, (cur or [{}])[0].get("label"), audio=True)})
        log(f"block_from_clip: repointed the linked audio clip {aud} too")
    except Exception as e:
        log(f"block_from_clip: could not repoint the linked audio clip: {e}")


def _clip_now(clip_id):
    """This clip's current label, or None. Read so a written one survives."""
    if not clip_id:
        return None
    try:
        rows = sb.get(f"clips?id=eq.{clip_id}&select=label")
        return (rows or [{}])[0].get("label")
    except Exception:
        return None


def _block_kinds(block_ids):
    """{block_id: kind} for the blocks a renumber is about to relabel."""
    ids = [b for b in block_ids if b]
    if not ids:
        return {}
    try:
        rows = sb.get(f"generation_blocks?id=in.({','.join(ids)})&select=id,params")
    except Exception:
        return {}
    out = {}
    for r in rows:
        prm = r.get("params") or {}
        k = prm.get("clip_kind")
        if k not in _KIND_NOUN:
            rec = prm.get("clip_gen")
            k = (_kind_from_mode(rec.get("mode"))
                 if isinstance(rec, dict) and rec.get("prompt") else "plan")
        out[r["id"]] = k
    return out


def _shift_audio_slice(slice_, in_ms, out_ms):
    """A locked-audio block's window of the master track, moved with the trim.

    `handle_audio_slice` cuts `{asset_id, offset_ms, duration_ms}` out of the
    episode's track. Copied unchanged onto a derived block it would cut the
    source block's seconds — right length, wrong music, and nothing says so
    until you listen to it.
    """
    if not slice_:
        return None
    return {**slice_,
            "offset_ms": int(slice_.get("offset_ms") or 0) + in_ms,
            "duration_ms": out_ms - in_ms}


def _relabel_block_clips(shifted, by_idx, kinds=None):
    """Rename the lane clips of every block this insert renumbered.

    `syncBlocksToTimeline` writes the label when it FIRST places a clip and
    never again — the label is a stored column, not a derived one. So a
    renumber that stopped at `generation_blocks` would leave a lane where
    "Block 8" is block 8 and every clip after it names the block below itself.

    TWO THINGS IT MUST NOT DO, both measured on live data. It must not call a
    chain a block (`kinds` carries each renumbered block's own kind), and it
    must not overwrite a label a PERSON wrote — this used to patch every clip
    of the block in one statement, so "Chain: How the reference pi" became
    "Block 9" because seven unrelated blocks moved. Written per clip now,
    which costs a read and is the only way to see the label before replacing
    it.

    Best effort: a storyboard that renumbered correctly and a label that did
    not is a cosmetic fault, and failing the job here would leave the block
    already inserted.
    """
    kinds = kinds or {}
    for frm, to in shifted:
        bid = by_idx.get(frm)
        if not bid:
            continue
        try:
            kind = kinds.get(bid, "plan")
            for c in sb.get(f"clips?block_id=eq.{bid}&select=id,label"):
                cur = c.get("label")
                want = _clip_label(kind, to, cur,
                                   audio=bool(cur and str(cur).strip().endswith("· audio")))
                if want != cur:
                    sb.patch(f"clips?id=eq.{c['id']}", {"label": want})
        except Exception as e:
            log(f"block_from_clip: could not relabel clips of block {frm} -> {to}: {e}")


def _exclude_source_block(clip_id, block_id):
    """Record that this cut no longer holds the SOURCE block — IF it no longer
    does.

    The clip just repointed at the derived block, so the source may now have a
    kept take and no clip — which is the exact state `syncBlocksToTimeline`
    reads as "this block has just rendered and is missing from the lane". It
    would drop a full-length copy back onto the timeline on the next landing
    take or the next mount of the editor, over the trim that replaced it.
    `timelines.excluded_block_ids` is what tells those two states apart.

    **ONE BLOCK CAN OWN SEVERAL CLIPS**, which is why the check is a query and
    not an assumption. `splitAt` copies `block_id` onto both halves, so a block
    someone cut into three pieces has three clips — measured on live data, 51
    blocks with more than one picture clip. Saving ONE of those pieces as a new
    block leaves the other two still playing the source, and excluding it there
    would be a flag the next sync immediately undoes, written about a block
    that is plainly still in the cut.

    PICTURE clips only, matching `exclusionsAfterStep`'s own rule:
    `detachedClipFrom` copies `block_id` onto the detached audio half, and a
    block whose picture is gone is not in the cut because its sound outlived
    it.

    Best effort for the same reason as the relabel — the block exists and the
    lane is right; a missing flag is recoverable and a failed job here is not.
    """
    if not clip_id:
        return
    try:
        rows = sb.get(f"clips?id=eq.{clip_id}&select=track_id")
        if not rows:
            return
        tracks = sb.get(f"tracks?id=eq.{rows[0]['track_id']}&select=timeline_id")
        if not tracks:
            return
        tid = tracks[0]["timeline_id"]
        video = [t["id"] for t in
                 sb.get(f"tracks?timeline_id=eq.{tid}&kind=eq.video&select=id")]
        if video:
            still_there = sb.get(f"clips?block_id=eq.{block_id}"
                                 f"&track_id=in.({','.join(video)})&select=id")
            if still_there:
                log(f"block_from_clip: block {block_id[:8]} still has "
                    f"{len(still_there)} picture clip(s) — leaving it in the cut")
                return
        tl = sb.get(f"timelines?id=eq.{tid}&select=id,excluded_block_ids")
        if not tl:
            return
        cur = tl[0].get("excluded_block_ids") or []
        if block_id in cur:
            return
        sb.patch(f"timelines?id=eq.{tl[0]['id']}",
                 {"excluded_block_ids": [*cur, block_id]})
    except Exception as e:
        log(f"block_from_clip: could not record the source block as excluded: {e}")

# -------------------------------------------------------------- video edit ---
# H3's ceiling in wall clock — 365 frames at 24fps. Clamped in MS and BEFORE
# the grid call, because clamping a frame COUNT lands off-grid and
# `exact_frames` is documented as trusted by resolve(). Nothing in model_map
# expresses a per-family duration ceiling, so this is a backstop rather than a
# per-model limit.
_EDIT_MAX_MS = int(h3_timing.MAX_FRAMES / 24 * 1000)


def handle_video_edit(job):
    """Prompt-based edit of an existing clip: the source video becomes H3's
    reference Video 1 (plus optional image refs), r2v regenerates it.

    This is also what "Edit a take" in the prompt & references modal queues —
    the source is the anchored take, the brief is the prompt, and the modal's
    reference grid is `ref_asset_ids`. `<Video 1>`'s own instruction ("preserve
    framing, timing and subjects except where the instruction changes them") IS
    the "everything you didn't name is held" the modal promises, so the two
    agree by construction rather than by a second copy of the rule.
    """
    jid = job["id"]
    payload = job.get("payload") or {}
    src = sb.asset_by_id(payload["source_asset_id"])
    if not src:
        raise ValueError("source asset not found")
    ext = os.path.splitext(src["b2_key"])[1] or ".mp4"
    vname = f"qamba_edit_{jid}{ext}"
    media.b2_get(src["b2_key"], os.path.join(COMFY_ROOT, "input", vname))

    ref_names = []
    for i, aid in enumerate((payload.get("ref_asset_ids") or [])[:8]):
        a = sb.asset_by_id(aid)
        if a:
            ref_names.append(_stage_asset(a, jid, "ref", i))

    # A `Picture N` THE ENVELOPE WILL NOT DEFINE IS REFUSED, before the sampler
    # rather than after it. `compile_video_edit` defines <Picture 1..N> for the
    # images that actually staged, and naming one is what binds the change to
    # it — so an instruction reading "she should be holding the photo in
    # Picture 1" with nothing staged compiles an envelope containing no such
    # subject, and H3 returns the take essentially unchanged. That reads as the
    # edit feature not working, which is exactly what it was reported as. Same
    # posture as `resolve.lora_stack` on a picked-but-missing adapter: a render
    # that provably cannot do what was asked is a silent downgrade, and the
    # fix here costs the user one picture rather than a re-render.
    #
    # Note an id that did not RESOLVE contributes no <Picture N> either, so
    # counting `ref_names` rather than the payload catches a stale id too.
    dangling = h3_prompt.dangling_picture_refs(payload.get("prompt") or "",
                                               n_ref_images=len(ref_names))
    if dangling:
        named = ", ".join(f"Picture {n}" for n in dangling)
        raise ValueError(
            f"the edit instruction names {named}, and this render stages "
            f"{len(ref_names)} reference picture(s). Add the picture to the "
            f"edit's own reference grid (it starts empty — it does not inherit "
            f"the block's staged set), or describe the change without naming a "
            f"picture.")

    # WHICH CHECKPOINT AND WHICH ADAPTERS, and an edit OF A BLOCK inherits both
    # from that block.
    #
    # This handler pinned H3_MODEL whatever the caller picked, so an edit queued
    # from a modal whose header says "MiniMax H3 · Turbo" rendered on the
    # 20-step base — the same silent downgrade `handle_clip_gen` had until
    # `model_key` reached it. Fixing that with `payload.model_key` alone left
    # the other half: the handler RECEIVES `block_id` and never consulted it, so
    # every caller had to restate the block's own render settings and none of
    # them restated all of them. Measured across the three callers: the director
    # chat's `edit_video` (both twins) sends neither `model_key` nor `loras`, so
    # an edit through chat dropped to plain H3 AND lost every adapter;
    # PromptRefsModal sends `model_key` and not `loras`. So editing a FIGHT take
    # silently lost the combat adapter on every path — and an edit that quietly
    # renders without the adapter the block renders with is indistinguishable
    # from the feature not working.
    #
    # Inheriting here rather than at the call sites is the same reasoning
    # `handle_patch_flf` already follows: re-rendering part of an existing block
    # on a different checkpoint or a different adapter stack changes the look
    # mid-block. The payload still wins where it speaks — this only fills in
    # what the caller left unsaid. A BARE ASSET edit has no block to inherit
    # from and keeps H3_MODEL, which is why the default is not a required key.
    _eblock = None
    if payload.get("block_id"):
        try:
            _eblock = _load_block(payload["block_id"])
        except Exception:  # noqa: BLE001 — an edit must not die on a stale id
            _eblock = None
    if _eblock is not None:
        _ep = {**(_eblock.get("params") or {}), **_block_params(payload)}
        model = payload.get("model_key") or _block_model(_eblock, _ep)
        loras = payload.get("loras") or _block_loras(_eblock, _ep, model=model)
    else:
        model = payload.get("model_key") or H3_MODEL
        loras = payload.get("loras")
    # Invariant #5's generic form. `pad17` is H3's grid specifically, and
    # `exact_frames` is documented as TRUSTED by resolve() — so hardcoding it
    # renders an off-grid count on any other family, which dies deep in the
    # sampler rather than here.
    want_ms = min(_EDIT_MAX_MS, int(src["duration_ms"] or 5000))
    frames = R.frame_count(model, want_ms)
    # `frame_count` rounds UP (render long, trim exact), so a source AT the
    # ceiling lands just past it: a 15.2s clip asks for 379 frames against
    # H3's 365 legal maximum, which dies in the sampler rather than here. Walk
    # the duration back until the count is legal — never clamp the count
    # itself, which would land off the model's own grid.
    for _ in range(24):
        if frames <= h3_timing.MAX_FRAMES:
            break
        want_ms -= 250
        frames = R.frame_count(model, want_ms)
    # The vendor's edit format, compiled — not the instruction with a sentence
    # stapled on. `[video editing + audio reuse]`, the source declared as
    # <Video 1>, retention stating everything unnamed is held: the envelope is
    # what binds the instruction to the staged reference (see
    # compile_video_edit). Trigger placement mirrors the other three lora-
    # carrying call sites — an adapter whose trigger never reaches the prompt
    # contributes nothing
    # unless the prompt carries it, and the stack is inherited from the block
    # now, so an edit of a block whose adapters need one must place it too.
    prompt = h3_prompt.full_prompt_text(h3_prompt.compile_video_edit(
        payload.get("prompt") or "", n_ref_images=len(ref_names)))
    prompt = h3_prompt.with_triggers(prompt, R.lora_triggers(model, loras))
    # Dims: the caller's if it named them (the modal's resolution row claims to
    # be stored on the block and honoured), else the source's — an edit that
    # silently changes geometry is not an edit of that clip.
    dims = payload.get("dims") or {}
    width = int(dims.get("w") or payload.get("width") or src["width"] or 1280)
    height = int(dims.get("h") or payload.get("height") or src["height"] or 720)
    # …but NEVER LARGER THAN THE SOURCE, whoever asked. That precedence is
    # right for everything except its own ceiling: a block's stored params
    # outlive the take they were planned against, so "edit this clip" becomes
    # "edit it and upsample it" with nothing on screen saying so — and an edit
    # cannot add detail its own reference does not carry. b13's take is
    # 864x480 against params of 1280x736 and OOM'd on the first sampling step
    # (see cap_dims_to_source, which owns the arithmetic and the measurement).
    capped = R.cap_dims_to_source(model, width, height,
                                  src.get("width"), src.get("height"))
    if capped != (width, height):
        # Said out loud rather than applied quietly: the modal's resolution row
        # still reads 1280x736, so a render that silently disagreed with it is
        # the same class of lie this handler already had three of.
        log(f"video_edit capped {width}x{height} -> {capped[0]}x{capped[1]} "
            f"(source is {src.get('width')}x{src.get('height')} — an edit "
            f"never renders larger than the clip it edits)")
        width, height = capped
    resolved = R.resolve(
        model, "r2v", positive=prompt, negative="",
        seed=int(payload.get("seed") or 42),
        width=width, height=height,
        length=frames, exact_frames=frames,
        # Source dims ride along so _wire_refs can skip the downscale on a
        # source already at or below its half-render cap (it never upscales).
        ref_images=ref_names,
        ref_videos=[{"name": vname, "width": src.get("width"),
                     "height": src.get("height")}],
        loras=loras,
        refine=payload.get("refine"),
        split_pass=payload.get("split_pass"))
    log(f"video_edit {src['b2_key']} {frames}f {width}x{height} on {model} "
        f"vref=1 (half-res, see _wire_refs) refs={len(ref_names)}"
        + (f" loras={loras}" if loras else ""))
    pid = comfy.submit(resolved["graph"])
    sb.job_patch(jid, {"comfy_prompt_id": pid})
    outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=3600)

    raw = f"/tmp/{jid}_raw.mp4"
    comfy.fetch_output(outputs, resolved["outputs"], raw)
    mp4 = f"/tmp/{jid}.mp4"
    media.transcode_web(raw, mp4)
    key = f"edits/{jid}.mp4"
    media.b2_put(mp4, key)
    info = media.probe(mp4)
    asset = sb.register_asset(key, "video", project_id=src.get("project_id"),
                              content_type="video/mp4", bytes_=info["bytes"],
                              width=info["width"], height=info["height"],
                              duration_ms=info["duration_ms"], fps=info["fps"],
                              source_job_id=jid, origin="derived",
                              meta={"edit_of": src["id"], "prompt": payload.get("prompt"),
                                    "seed": int(payload.get("seed") or 42),
                                    "model_key": model},
                              tags=["edit"])
    if payload.get("block_id"):
        # `activate` follows master_pass's contract exactly, so "replace" means
        # the same thing on both paths: "review" (the default here — an edit is
        # a proposal until someone has looked at it) leaves the take pending
        # beside the others, "replace" makes it canonical and marks the chained
        # successors stale, because their anchor frame just moved.
        activate = payload.get("activate")
        take = sb.insert("block_takes", {"block_id": payload["block_id"], "job_id": jid,
                                         "asset_id": asset["id"], "kind": "edit",
                                         "state": "kept" if activate == "replace" else "pending"})
        # AND THE BLOCK HAS TO COME OUT OF `queued`. Anything that enqueues
        # through `queueBlockRender` moves the block to `queued` in the same
        # breath (so a sleeping pod doesn't read as "nothing happened"), and
        # only master_pass ever wrote a terminal status back — so an edit
        # queued from the prompt modal would have left the block spinning
        # forever with its take sitting right there.
        upd = {"status": "generated"}
        if activate == "replace":
            upd["active_take_id"] = take["id"]
        blk = sb.get(f"generation_blocks?id=eq.{payload['block_id']}&limit=1")
        sb.patch(f"generation_blocks?id=eq.{payload['block_id']}", upd)
        if activate == "replace" and blk:
            _mark_downstream_stale(blk[0])
    sb.job_done(jid, output_asset_id=asset["id"])
    for p in (raw, mp4):
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE video_edit -> {key}")


# --------------------------------------------------------- standalone clip ---
def _attach_to_clip(target, asset, info, extra=None, label="clip_gen"):
    """Land a finished render on the TIMELINE CLIP that was holding its place.

    `target: {"clip_id": …}` is the same late-bound shape `image_gen` uses to
    put a sheet on a bible entry and `music_gen` uses to make a track the
    episode's master: the job cannot know the asset id it is about to create,
    so it names the ROW the result belongs on.

    It exists because the timeline's own generate actions — extend a block,
    chain two blocks, add a block after — place a clip on the lane the moment
    you press the button, so the edit is real while the GPU works. That clip
    points at the extracted start frame (a still), and until this function
    existed nothing ever repointed it: the render landed in the library and
    the lane kept the placeholder for good. From the outside that is "the
    extension never arrived", with a picture sitting where the shot should be.

    What is patched and why:
      - `asset_id`, `in_ms` 0, `out_ms` = the whole render. This is the take.
      - `duration_ms` only ever SHRINKS, and only when the render came back
        shorter than the slot that was reserved for it. Every frame grid here
        rounds UP (invariant #5), so that is rare — but a clip longer than its
        own media plays black past the end and the preview sits on
        "buffering…", which is exactly the failure this function is fixing.
        Growing it instead would silently overlap whatever is next on the lane.
      - `extra`, for a caller that is repointing the clip at a different BLOCK
        as well as at different media (`block_from_clip`). It rides through
        here rather than being a second PATCH so the shrink rule and the
        stale-render flag cannot be remembered in one path and forgotten in
        the other.
      - `take_id` is CLEARED. A clip can be pinned to one of its block's takes
        (`clips.take_id`, which is how a block on the cut twice shows two
        takes), and this hands it media that is not that take — so a pin left
        behind is a clip the browser's next `syncBlocksToTimeline` repoints
        straight back to the pinned take, silently undoing the render that
        just landed on it. Nulling it is what makes the clip follow the block
        again, which is what a render targeted at it means.
    The timeline's cached render is stale afterwards: it was flattened against
    the placeholder.
    """
    cid = target.get("clip_id")
    if not cid:
        return
    rows = sb.get(f"clips?id=eq.{cid}&select=id,track_id,duration_ms,label")
    if not rows:
        log(f"{label}: clip {cid} is gone — the render stays in the library")
        return
    clip = rows[0]
    dur = int(info.get("duration_ms") or 0)
    patch = {"asset_id": asset["id"], "in_ms": 0, "out_ms": dur or None,
             "take_id": None, **(extra or {})}
    held = int(clip.get("duration_ms") or 0)
    if dur and held and dur < held:
        patch["duration_ms"] = dur
    sb.patch(f"clips?id=eq.{cid}", patch)

    note = f"{label}: attached to clip {cid} ({clip.get('label') or 'unnamed'})"
    if "duration_ms" in patch:
        note += f", trimmed {held}ms -> {dur}ms (the render came back short)"
    log(note)
    # The flattened master was built against the placeholder. Best effort: a
    # lane that is right and a stale flag that is missing is a far better
    # outcome than failing a render that has already succeeded.
    try:
        tracks = sb.get(f"tracks?id=eq.{clip['track_id']}&select=timeline_id")
        if tracks:
            sb.patch(f"timelines?id=eq.{tracks[0]['timeline_id']}", {"render_stale": True})
    except Exception as e:
        log(f"{label}: could not mark the timeline stale: {e}")


# What a RETAKE replays. Whitelisted rather than spread: `target`, `make_block`
# and `label` describe THIS job — replaying them would re-create the block or
# re-attach a clip — and anything else on the payload is transport, not recipe.
_RECIPE_KEYS = ("prompt", "mode", "model_key", "loras", "width", "height",
                "duration_ms", "seed", "steps", "negative", "refine",
                "split_pass", "latent_upscale", "start_asset_id", "end_asset_id",
                "ref_asset_ids", "ref_audio_asset_ids", "ref_background_index",
                "context_asset_id", "context_end_ms", "context_ops",
                "motion_ctx", "allow_speech", "workflow_id", "project_id")


def _clip_recipe(payload):
    """The re-runnable subset of a clip_gen payload."""
    return {k: payload[k] for k in _RECIPE_KEYS if payload.get(k) is not None}


# What a block is CALLED, twinned in src/lib/blockKind.ts. A chain is not
# "Block 9" — it is the join between 8 and 9, and naming it a block loses the
# one fact that explains why it is there.
_KIND_NOUN = {"chain": "Chain", "extend": "Extension", "shot": "Shot",
              "trim": "Block", "plan": "Block"}
# Twin of `labelIsAuto` in director/block_kind.js: the studio's own forms,
# optionally suffixed "· audio" (a detached half), "· rendering" (the dock's
# placeholder for a block whose first render is in flight) or "· failed".
_AUTO_LABEL = re.compile(
    r"^(Block|Chain|Extension|Shot)\s+\d+(\s*·\s*(audio|rendering|failed))?$", re.I)


def _kind_from_mode(mode):
    """The render mode IS the action: the chain modal sends flf, extend i2v."""
    m = str(mode or "").lower()
    return {"flf": "chain", "i2v": "extend"}.get(m, "shot")


def _block_label(kind, idx):
    return f"{_KIND_NOUN.get(kind, 'Block')} {int(idx) + 1}"


def _clip_label(kind, idx, current=None, audio=False):
    """The label a clip of this block should carry, KEEPING a written one.

    The lane's label is a stored column, so a renumber has to rewrite it — and
    for its whole life it rewrote every label, including ones a person typed.
    Measured: a chain the user had named "Chain: How the reference pi" came
    back as "Block 9" because seven unrelated blocks renumbered around it.
    Only the studio's own forms are rewritten.
    """
    if current and not _AUTO_LABEL.match(str(current).strip()):
        return current
    return _block_label(kind, idx) + (" · audio" if audio else "")


def _recover_recipe(asset):
    """The render recipe for a clip's media — from the asset, else from the
    JOB that made it.

    `handle_clip_gen` stamps `meta.clip_gen` now, but every extend and chain
    rendered BEFORE that has none — and those are exactly the clips someone
    wants to promote. The job row still has the whole payload, anchors
    included, so a promotion can recover a fully re-runnable recipe rather
    than producing a block that can never be retaken. Verified against two
    live chains: mode, both anchor frames, prompt, model_key, loras and dims
    all came back.
    """
    meta = asset.get("meta") or {}
    r = meta.get("clip_gen")
    if isinstance(r, dict) and r.get("prompt"):
        return r
    jid = asset.get("source_job_id")
    if not jid:
        return None
    try:
        rows = sb.get(f"jobs?id=eq.{jid}&select=kind,payload")
    except Exception as e:
        log(f"block_from_clip: could not read the source job: {e}")
        return None
    if not rows or rows[0].get("kind") != "clip_gen":
        return None
    r = _clip_recipe(rows[0].get("payload") or {})
    return r if r.get("prompt") else None


def _newest_storyboard_id(episode_id):
    """The storyboard a floating block joins when it has no anchor block."""
    if not episode_id:
        raise ValueError("no anchor block and no episode on the job — "
                         "cannot pick a storyboard to put the block in")
    rows = sb.get(f"storyboards?episode_id=eq.{episode_id}"
                  f"&select=id&order=created_at.desc&limit=1")
    if not rows:
        raise ValueError("the episode has no storyboard — plan one first")
    return rows[0]["id"]


def _block_episode(block):
    """storyboard -> episode {id, code, project_id} for one block."""
    story = sb.get(f"storyboards?id=eq.{block['storyboard_id']}&select=episode_id")[0]
    return sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,code,project_id")[0]


def split_relaunch_blocks(old):
    """Which of a storyboard's blocks a RELAUNCH may delete, and where the
    survivors go. -> (delete_ids, [(id, new_idx)] in a collision-free order)

    Pure, because both halves fail silently when wrong: deleting a derived
    block cascades its takes away, and a survivor left at idx 7 collides with
    the planner's own block 7 minutes later, failing the launch half-applied.
    Moves are emitted highest-current-idx first so applying them one PATCH at
    a time never lands on a slot another survivor has not vacated yet — the
    idx_shift rule.
    """
    def _derived(b):
        prm = b.get("params") or {}
        return isinstance(prm, dict) and bool(prm.get("clip_gen") or prm.get("derived_from"))
    keep = [b for b in old if _derived(b)]
    drop = [b["id"] for b in old if not _derived(b)]
    ranked = sorted(keep, key=lambda b: int(b.get("idx") or 0))
    moves = [(int(b.get("idx") or 0), b["id"], 10000 + i) for i, b in enumerate(ranked)]
    return drop, [(bid, to) for cur, bid, to in sorted(moves, key=lambda m: -m[0])
                  if cur != to]


def _claim_clip_for_block(clip_id, block_id, label="clip_gen"):
    """Put the new block's id on the clip that is holding its place, NOW.

    The lane's placeholder is claimed by `_attach_to_clip` at the very end of
    the job, and until it is, the block is a block with a kept take and no
    clip — which is precisely what `syncBlocksToTimeline` inserts a clip for.
    So the browser lays a SECOND clip of this block on the cut and the render
    arrives beside its placeholder instead of replacing it.

    That window is not a millisecond. Sitting in it is `_relabel_block_clips`,
    which reads and rewrites the lane label of every block this insert
    renumbered, one sequential round trip each — seconds on a long storyboard,
    and every one of those writes is itself a realtime event waking the query
    that triggers the sync. Measured on the live data: all four duplicated
    chain/extension blocks were inserted with 33+ blocks after them, against an
    average of 30 for the ones that came out clean.

    Claiming the clip before the take exists closes it: by the time there is
    anything for the sync to place, the clip already names the block and the
    sync takes its repoint branch. `_attach_to_clip` still writes `block_id`
    afterwards — the same value, so it is idempotent — along with the media and
    the label, which are what it is really for.

    Best effort: a claim that fails costs the duplicate this prevents, and
    failing a render that has already finished costs the render.
    """
    if not clip_id:
        return
    try:
        sb.patch(f"clips?id=eq.{clip_id}", {"block_id": block_id})
    except Exception as e:
        log(f"{label}: could not claim clip {clip_id} for block "
            f"{block_id[:8]} up front ({e}) — the sync may place a second "
            f"clip before _attach_to_clip lands")


def _exclude_from_other_cuts(clip_id, block_id, label="clip_gen"):
    """Keep a derived block off the CUTS it was not made on.

    `syncBlocksToTimeline` lays any block with a kept take and no clip onto
    whichever cut is open, at the block's planned window — and a derived
    block's window overlaps its neighbour's by construction (an extension
    starts where its source ends, which is where the NEXT block already sits;
    a trim sits inside its source's own span). So on every OTHER cut of the
    episode it would arrive as an overlapping insert nobody asked for.
    `excluded_block_ids` is the record that tells "left out on purpose" from
    "just rendered", and it self-heals: drag the block in and the sync clears
    it.

    Best effort, same reason as `_exclude_source_block`: the block and the
    lane it was made on are right, and a missing flag is recoverable where a
    failed job is not.
    """
    if not clip_id:
        return
    try:
        rows = sb.get(f"clips?id=eq.{clip_id}&select=track_id")
        if not rows:
            return
        tr = sb.get(f"tracks?id=eq.{rows[0]['track_id']}&select=timeline_id")
        if not tr:
            return
        tid = tr[0]["timeline_id"]
        tls = sb.get(f"timelines?id=eq.{tid}&select=episode_id")
        if not tls:
            return
        others = sb.get(f"timelines?episode_id=eq.{tls[0]['episode_id']}"
                        f"&id=neq.{tid}&select=id,excluded_block_ids")
        for t in others:
            cur = t.get("excluded_block_ids") or []
            if block_id in cur:
                continue
            sb.patch(f"timelines?id=eq.{t['id']}",
                     {"excluded_block_ids": [*cur, block_id]})
        if others:
            log(f"{label}: excluded block {block_id[:8]} from {len(others)} "
                f"other cut(s) — it belongs to the cut it was made on until "
                f"dragged in")
    except Exception as e:
        log(f"{label}: could not exclude the new block from other cuts: {e}")


def _publish_clip_block(job, payload, path, info):
    """Land a clip_gen render inside the TAKES SYSTEM. -> (block, asset, take)

    Two shapes, decided by the payload:
      * `target.block_id` — a RETAKE of an existing clip-born block: publish
        this file as another take. The first take of a block activates
        (it IS the content); later ones land `pending` for the strip to pick
        from, unless `payload.activate == "replace"`.
      * `make_block` — the FIRST render of a timeline extend/chain: insert a
        `generation_blocks` row beside its anchor and make this file its
        active take. `after_block_id` places it (idx shift, same as
        block_from_clip); `chain_from_block_id` records provenance, which is
        also what makes the extension go stale when its source block gets a
        new take. The block carries `params.clip_gen` — the re-runnable
        payload — which is what master_pass delegates to on any retake.
    """
    jid = job["id"]
    tgt = payload.get("target") or {}
    recipe = _clip_recipe(payload)

    if tgt.get("block_id"):
        block = _load_block(tgt["block_id"])
        ep = _block_episode(block)
        first = not block.get("active_take_id")
        activate = first or (payload.get("activate") == "replace")
        asset, take = _publish_derived_take(
            jid, block, ep, path, name="clip", kind="master",
            activate=activate, mark_stale=activate and not first,
            meta={"clip_gen": recipe} if recipe else None)
        # queueBlockRender moved the row to `queued` when the retake was
        # asked for; a landed take is a generated block either way.
        sb.patch(f"generation_blocks?id=eq.{block['id']}", {"status": "generated"})
        log(f"clip_gen: take {take['id'][:8]} landed on block "
            f"{block['id'][:8]} ({'active' if activate else 'pending'})")
        return block, asset, take

    mk = payload.get("make_block") or {}
    after = None
    if mk.get("after_block_id"):
        rows = sb.get(f"generation_blocks?id=eq.{mk['after_block_id']}")
        after = rows[0] if rows else None
        if after is None:
            log(f"clip_gen: anchor block {mk['after_block_id']} is gone — "
                f"appending to the newest storyboard instead")
    sid = (after or {}).get("storyboard_id") or _newest_storyboard_id(job.get("episode_id"))
    story = sb.get(f"storyboards?id=eq.{sid}&select=episode_id")[0]
    ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,code,project_id")[0]

    peers = sb.get(f"generation_blocks?storyboard_id=eq.{sid}&select=id,idx&order=idx")
    by_idx = {int(b["idx"]): b["id"] for b in peers}
    if after is not None:
        shifted = idx_shift(by_idx.keys(), int(after["idx"]))
        for frm, to in shifted:
            sb.patch(f"generation_blocks?storyboard_id=eq.{sid}&idx=eq.{frm}",
                     {"idx": to})
        new_idx = int(after["idx"]) + 1
    else:
        shifted = []
        new_idx = (max(by_idx) + 1) if by_idx else 0

    dur = int(info.get("duration_ms") or 0)
    t0 = int(after["t_end_ms"]) if after else 0
    mode = (payload.get("mode") or "t2v").lower()
    block = sb.insert("generation_blocks", {
        "storyboard_id": sid, "idx": new_idx,
        # The place and the people are the anchor's — an extension continues
        # its scene. No beats: this block renders from its stored recipe,
        # never from the compiler.
        "scene_ids": (after or {}).get("scene_ids") or [],
        "beat_ids": [],
        "t_start_ms": t0, "t_end_ms": t0 + dur,
        # frames/trim describe a render the PLANNER asked for; this one's
        # length is the recipe's.
        "frames": 0, "trim": {},
        "mode": mode if mode in H3_MODES else "t2v",
        "compiled_prompt": None,
        "ref_plan": [],
        "audio_mode": "native", "audio_slice": None,
        # Provenance AND staleness: when the source block gets a new take,
        # _mark_downstream_stale reaches this row — an extension of a replaced
        # take is honestly stale. Its retake still opens on the frame
        # extracted at creation (the recipe's start_asset_id), which the
        # delegation logs.
        "chain_from_block_id": mk.get("chain_from_block_id"),
        "status": "generated",
        # model_key/loras at the top level too: the extend modal seeds its
        # LoRA stack from params.loras, and inside the recipe they would be
        # invisible to it.
        # `clip_kind` is STAMPED rather than inferred later: it decides what
        # the lane calls this block and how it is drawn, and a chain that has
        # to be guessed at from its mode is one bad payload away from being
        # drawn as a shot.
        "params": {"clip_gen": recipe, "clip_kind": _kind_from_mode(mode),
                   **({"model_key": recipe["model_key"]} if recipe.get("model_key") else {}),
                   **({"loras": recipe["loras"]} if recipe.get("loras") else {})},
        "seed": payload.get("seed"),
    })
    # BEFORE the take exists, so the block is never briefly "kept take, no
    # clip" — see `_claim_clip_for_block`, which is where that failure and its
    # measurement are written down.
    _claim_clip_for_block(tgt.get("clip_id"), block["id"])
    asset, take = _publish_derived_take(
        jid, block, ep, path, name="clip", kind="master", mark_stale=False,
        meta={"clip_gen": recipe} if recipe else None)
    _relabel_block_clips(shifted, by_idx, _block_kinds(by_idx.values()))
    log(f"clip_gen: published as block {new_idx} ({block['id'][:8]}) with its "
        f"first take {take['id'][:8]}"
        + (f", chained from {str(mk.get('chain_from_block_id'))[:8]}"
           if mk.get("chain_from_block_id") else ""))
    return block, asset, take


def _master_pass_clip_block(job, block, recipe):
    """A master_pass aimed at a CLIP-BORN block replays its stored recipe.

    The block has no beats, so the compiler path has nothing to say about it —
    but master_pass is what every retake surface queues (the retake modal,
    rerender_stale, the reviewer), so the job kind stays and the RENDER
    delegates to handle_clip_gen with `target.block_id`, which publishes the
    result as another take. The prompt is edited on `params.clip_gen`
    (ClipRetakeModal persists it there before queueing), never through the
    beats-path brief.
    """
    import random
    jid = job["id"]
    payload = job.get("payload") or {}
    if payload.get("brief") or payload.get("prompt_extra"):
        log("master_pass: brief/prompt_extra are beats-path controls — a "
            "clip-born block's prompt lives in params.clip_gen; the note was "
            "not applied")
    sub = dict(recipe)
    # A replayed seed is the identical picture; a retake wants a new roll
    # unless the caller pinned one.
    sub["seed"] = int(payload.get("seed") or 0) or random.randint(1, 1_000_000_000)
    sub["target"] = {"block_id": block["id"]}
    sub["activate"] = payload.get("activate") or "replace"
    if payload.get("label"):
        sub["label"] = payload["label"]
    if recipe.get("chain_note_logged") is None and block.get("chain_from_block_id"):
        log(f"master_pass: block {block['id'][:8]} re-renders from the frame "
            f"extracted at its creation — if the source block has a new take, "
            f"extend it again rather than retaking this one")
    sb.patch(f"generation_blocks?id=eq.{block['id']}", {"status": "generating"})
    log(f"master_pass: block {block['id'][:8]} is clip-born — replaying its "
        f"recipe ({sub.get('mode') or 't2v'}, "
        f"{sub.get('model_key') or 'default model'})")
    try:
        return handle_clip_gen({**job, "payload": sub})
    except Exception:
        sb.patch(f"generation_blocks?id=eq.{block['id']}",
                 {"status": "generated" if block.get("active_take_id") else "failed"})
        raise


def handle_clip_gen(job):
    """A video that belongs to nobody: no block, no take, no storyboard.

    Every other video path here renders *a block of a storyboard*, which is
    right for an episode and wrong for "make me this shot" — there was no way
    to generate a clip from the library without inventing a scene to hang it
    on. This renders straight to an asset and stops.

    Mode preconditions mirror handle_master_pass: i2v/flf open on supplied
    frames, r2v takes the reference set, t2v takes neither.
    """
    jid = job["id"]
    payload = job.get("payload") or {}
    mode = (payload.get("mode") or "t2v").lower()
    if mode not in H3_MODES:
        raise ValueError(f"unknown mode {mode!r} (have: {', '.join(H3_MODES)})")
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("clip_gen needs a prompt")

    width = int(payload.get("width") or 1280)
    height = int(payload.get("height") or 720)
    # Render exactly what was asked for, on THIS model's frame grid.
    #
    # This used to be `h3_timing.pad17` unconditionally, and the count is passed
    # as `exact_frames`, which `resolve()` is documented to trust — so every
    # non-H3 family rendered an off-grid length from this path. LTX 2.5 is
    # 8n+1 where H3 is 17n+5: it was enabled in the catalog and could not
    # legally render one clip here.
    #
    # THE LENGTH THAT WAS ASKED FOR IS THE LENGTH THAT RENDERS — no floor.
    #
    # This used to clamp up to `h3_timing.MIN_FRAMES` (90f / 3.75s), which is
    # `plan_block`'s floor borrowed WITHOUT the thing that makes it safe there:
    # a block renders long and TRIMS to its exact content window, so the floor
    # costs sampling time and nothing else. Here there is no trim, so the floor
    # was the delivered length. Measured on one real chain: 916ms requested,
    # **3776ms delivered**, and a second chain asking 2333ms delivered 3776ms
    # too — every slider position under 3.75s produced the identical file while
    # the modal quoted the request back to two decimals.
    #
    # Trimming is not the fix on this path, which is why the clamp goes instead.
    # `flf` is the common case here (the timeline's chain action) and its render
    # IS the A-to-B journey: cut the head and it never departs frame A, cut the
    # tail and it never arrives at frame B. The length is the journey.
    #
    # What is lost is that H3 is documented at 4-15s, so a shorter render is out
    # of its trained distribution — a QUALITY judgement, not a limit the model
    # enforces (`h3_image_graph` renders 5 frames on purpose, and 22 is on the
    # 17n+5 grid and above the node's own `length` minimum). So it renders, and
    # says so once in the journal rather than silently substituting a length.
    # `pad17` still floors at 5 frames, so "nothing" is not expressible.
    want_ms = int(payload.get("duration_ms") or 5000)
    model_key = payload.get("model_key") or H3_MODEL
    if "h3" in model_key.lower():
        frames = h3_timing.pad17(min(h3_timing.MAX_FRAMES,
                                     h3_timing.ms_to_frames_ceil(want_ms)))
        if frames < h3_timing.MIN_FRAMES:
            log(f"clip_gen: {frames}f ({h3_timing.frames_to_ms(frames)}ms) is "
                f"below H3's documented 4s range — rendering it as asked, out "
                f"of distribution")
    else:
        frames = R.frame_count(model_key, want_ms)

    def stage(aid, tag, i=0):
        a = sb.asset_by_id(aid)
        if not a:
            raise ValueError(f"{tag} asset {aid} not found")
        return _stage_asset(a, jid, tag, i)

    ref_names = [stage(aid, "ref", i)
                 for i, aid in enumerate((payload.get("ref_asset_ids") or [])[:9])]
    start = payload.get("start_asset_id")
    end = payload.get("end_asset_id")
    if mode in ("i2v", "flf") and not start:
        raise ValueError(f"{mode} opens on a supplied frame — pick a start image")
    if mode == "flf" and not end:
        raise ValueError("flf needs a closing frame — pick an end image")

    # Ref2VA takes AUDIO references as well as pictures, and their slots number
    # independently of the images (official §2.5) — the master pass has staged
    # voice-timbre refs this way all along, but this free-standing path never
    # offered them, so a one-off clip had no way to hold a character's voice
    # across takes. Three is the node's ceiling.
    audio_names = [stage(aid, "refaudio", i)
                   for i, aid in enumerate((payload.get("ref_audio_asset_ids") or [])[:3])]

    img_kwargs = {}
    if mode == "r2v":
        img_kwargs["ref_images"] = ref_names
        if audio_names:
            img_kwargs["ref_audios"] = audio_names
        # WHICH staged picture is the location. Only LTX 2.5's MSR guide has a
        # dedicated background slot (H3's reference list is flat and ignores
        # this), and its slots carry learned embeddings — so a location left to
        # the "a fifth image must be the background" fallback lands in pic2
        # wearing a SUBJECT's embedding whenever a shot stages fewer than five
        # pictures, which is the common case. 1-based to match the payload's
        # own `<Picture N>` counting.
        bg = payload.get("ref_background_index")
        if bg is not None and 1 <= int(bg) <= len(ref_names):
            img_kwargs["ref_background"] = ref_names[int(bg) - 1]
    if mode in ("i2v", "flf"):
        img_kwargs["source_image"] = stage(start, "start")
    if mode == "flf":
        img_kwargs["end_image"] = stage(end, "end")

    # ── MOTION CONTEXT, for an extend ────────────────────────────────────────
    #
    # An extend opened on a FRAME and nothing else, so H3 re-decided the motion
    # from a still — the same "she puts the shard down twice" the episode chain
    # already fixed, on the one path that never got it. `handle_master_pass`
    # could not be reused: its context comes from `block.chain_from_block_id`,
    # and this path has no block. The CALLER knows the predecessor (it is the
    # clip being extended), so it names it.
    #
    # Three things this path has to do for itself:
    #
    #  * RENDER LONGER AND TRIM. The pinned window is replayed at the HEAD of
    #    the render. A block hides it in the warmup its trim already removes;
    #    this handler had no warmup at all, so pinning without one would open
    #    every extension on ~0.9s of its predecessor's tail. So the render is
    #    padded by the context length and the extra is cut off the front,
    #    leaving exactly the requested clip.
    #  * BOUND THE CONTEXT TO THE VISIBLE WINDOW. A block take's file IS its
    #    content; a timeline clip's file routinely runs past where the user
    #    trimmed it. `context_end_ms` is that point, so the motion is read from
    #    frames the viewer actually saw.
    #  * i2v ONLY. flf already pins both ends, and t2v/r2v have no predecessor
    #    by construction. The node itself is mode-agnostic — it attaches to
    #    whatever `PROMPT_INPUT_CLASSES` builder the template has — so this is
    #    a judgement about the EDIT, not a limitation.
    motion_ctx = None
    trim_f = 0
    ctx_id = payload.get("context_asset_id")
    if (mode == "i2v" and ctx_id and "h3" in model_key.lower()
            and _motion_ctx_wanted({}, payload)):
        ctx_asset = sb.asset_by_id(ctx_id)
        if not ctx_asset:
            log(f"clip_gen: context asset {ctx_id} not found — extending from "
                f"the frame alone")
        else:
            ctx_len = h3_timing.DEFAULT_WARMUP_F
            render_f = h3_timing.pad17(frames + ctx_len)
            # The pad rounds UP onto 17n+5, so the cut is always at least the
            # pinned window — i.e. the replay never survives into the clip.
            trim_f = render_f - frames
            end_ms = int(payload.get("context_end_ms")
                         or ctx_asset.get("duration_ms") or 0)
            end_f = int(end_ms * 24 / 1000)
            skip_f = max(0, end_f - CTX_TAIL_F)
            from handlers import images as I
            # The clip's LOOK, not the raw media's: a flipped or cropped
            # predecessor must pin the motion the viewer actually saw.
            motion_ctx = {"video": _stage_with_ops(ctx_asset, jid, "ctx",
                                                   payload.get("context_ops")),
                          "context_length": ctx_len,
                          "skip_frames": skip_f,
                          # 0 would read to the end of the FILE, past the trim.
                          "load_cap": max(1, end_f - skip_f) if end_f else 0,
                          "spec": I._node_spec("MiniMaxH3MotionContext")}
            log(f"clip_gen: motion context from {ctx_asset['b2_key']} "
                f"[{skip_f}..{end_f}f], pinning {ctx_len}f, rendering "
                f"{render_f}f and trimming {trim_f}f")
            frames = render_f

    # `model_key` is resolved at the top of this handler (the frame grid it
    # picks depends on it). Every other H3 call in this file renders a
    # storyboard block and stays pinned to H3_MODEL on purpose — an episode
    # should not switch checkpoints shot to shot. This is the free-standing
    # "make me this clip" path, same as GenComposer's image jobs, so it honors
    # the model the picker sent (a style variant, or
    # another family entirely), falling back to plain H3 when none is carried.

    # An IMPORTED graph takes a different route entirely. resolve() drives a
    # bundled template by matching class_type, which is safe only on templates
    # we wrote; someone else's graph is driven by the explicit slot map the
    # import tagged. See worker/resolve_custom.py for why.
    #
    # It is deliberately NOT merged into the branch below: a custom graph has
    # no `mode`, no model_map entry and no LoRA table, so everything that
    # follows from those would be a lie about it.
    custom_id = payload.get("workflow_id")
    if custom_id:
        # The workflow's own card is where a user goes to fix a refusal, so
        # `resolve_for_job` puts the reason on its row before re-raising —
        # shared with handle_image_gen, which needs the identical three steps.
        resolved = RC.resolve_for_job(
            custom_id, positive=prompt,
            negative=payload.get("negative") or None,
            seed=int(payload.get("seed") or 42),
            width=width, height=height, length=frames,
            source_image=img_kwargs.get("source_image"),
            end_image=img_kwargs.get("end_image"))
        wf = resolved["row"]
        # Refs are a MiniMax-specific staging contract (`_wire_refs` rewrites
        # placeholder slots on a node class an imported graph need not have),
        # so they are reported as ignored rather than silently dropped.
        if ref_names or audio_names:
            log(f"clip_gen custom: {len(ref_names)} image + {len(audio_names)} audio "
                f"reference(s) ignored — reference staging is H3-specific and a "
                f"custom graph declares its own inputs")
        log(f"clip_gen [custom] '{wf.get('name')}' {frames}f {width}x{height} "
            f"wrote={','.join(resolved['wrote']) or 'nothing'} "
            f"outputs={','.join(resolved['outputs'])}: '{prompt[:60]}'")
    else:
        # The composer writes this prompt, so a picked adapter's trigger is the
        # user's to remember — and the picker only shows it as a chip. Place it
        # for them, format-aware: this path's prompt is prose OR the vendor
        # envelope an enhance produced, and the token belongs inside the
        # description either way.
        prompt = h3_prompt.with_triggers(
            prompt, R.lora_triggers(model_key, payload.get("loras")))
        # CLOSE H3'S AUDIO CHANNELS. Its format is three fields and two are
        # sound; this path sends the prompt verbatim, so a bare prose extend
        # reaches the model with neither — and H3 fills them itself, which is
        # where a narrator nobody wrote comes from. `payload.allow_speech`
        # opts back in, and a prompt that already carries dialogue is left
        # alone (see with_audio_defaults). H3 families only: the fields are
        # MiniMax's, and appending them to an LTX prompt would be noise inside
        # the one field that model reads.
        if "h3" in model_key.lower():
            prompt = h3_prompt.with_audio_defaults(
                prompt, allow_speech=bool(payload.get("allow_speech")))
        resolved = R.resolve(
            model_key, mode, positive=prompt, negative=payload.get("negative") or "",
            seed=int(payload.get("seed") or 42),
            width=width, height=height, length=frames, exact_frames=frames,
            steps=payload.get("steps"), loras=payload.get("loras"),
            refine=payload.get("refine"), motion_ctx=motion_ctx,
            split_pass=payload.get("split_pass"),
            latent_upscale=payload.get("latent_upscale"), **img_kwargs)
        lora_note = (" loras=" + ",".join(
            l.get("key") if isinstance(l, dict) else str(l) for l in payload["loras"])
        ) if payload.get("loras") else ""
        log(f"clip_gen [{mode}] model={model_key} {frames}f {width}x{height} "
            f"refs={len(ref_names)}"
            f"{'+' + str(len(audio_names)) + 'audio' if audio_names else ''}"
            f"{lora_note}: '{prompt[:60]}'")
    try:
        pid = comfy.submit(resolved["graph"])
        sb.job_patch(jid, {"comfy_prompt_id": pid})
        outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=3600)
    except Exception as e:
        # ComfyUI's own refusal names the node and the class, which is the most
        # useful thing in the whole import flow — put it on the workflow's card
        # rather than leaving it only in the job's error_msg, where the person
        # who has to fix the graph will not look.
        if custom_id:
            RC.record_failure(custom_id, e)
        raise

    sb.job_progress(jid, 0.9, note="transcode + upload")
    raw = f"/tmp/{jid}_raw.mp4"
    comfy.fetch_output(outputs, resolved["outputs"], raw)
    if trim_f:
        # Output-side seek, so the cut is frame exact — the same recipe
        # handle_master_pass uses on its own warmup.
        cut = f"/tmp/{jid}_cut.mp4"
        args = ["-i", raw, "-ss", f"{trim_f / 24:.3f}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                "-preset", "veryfast", "-movflags", "+faststart"]
        args += (["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
                 if media.has_audio(raw) else ["-an"])
        media.run_ff(args + [cut], "ctx-trim",
                     cancel_check=lambda: sb.cancel_requested(jid))
        try:
            os.remove(raw)
        except OSError:
            pass
        raw = cut
    mp4 = f"/tmp/{jid}.mp4"
    media.transcode_web(raw, mp4)
    info = media.probe(mp4)
    tgt = dict(payload.get("target") or {})
    # ── THE TAKES SYSTEM ────────────────────────────────────────────────────
    # `make_block` publishes this render as a NEW generation_blocks row with
    # this file as its first take (the extend/chain modal sends it), and
    # `target.block_id` lands it as another take of an EXISTING clip-born
    # block (a retake). Either way the strip, assembly and take history work
    # untouched. Best effort past the render: the GPU minutes are already
    # spent, so failed bookkeeping falls back to a plain library publish with
    # the reason in the log, never a failed job over a finished picture.
    block = None
    asset = None
    if payload.get("make_block") is not None or tgt.get("block_id"):
        try:
            block, asset, _take = _publish_clip_block(job, payload, mp4, info)
        except Exception as e:
            log(f"clip_gen: block bookkeeping failed ({e}) — publishing to "
                f"the library instead")
            block = None
    if asset is None:
        key = f"library/gen/{jid}.mp4"
        media.b2_put(mp4, key)
        asset = sb.register_asset(key, "video", project_id=payload.get("project_id"),
                                  content_type="video/mp4", bytes_=info["bytes"],
                                  width=info["width"], height=info["height"],
                                  duration_ms=info["duration_ms"], fps=info["fps"],
                                  source_job_id=jid, origin="generated",
                                  meta={"prompt": prompt, "mode": mode,
                                        "seed": payload.get("seed"),
                                        "model": model_key,
                                        "workflow_id": custom_id,
                                        # the re-runnable payload, so a later
                                        # "save as new block" can carry it
                                        "clip_gen": _clip_recipe(payload)},
                                  tags=["library", "generated"])
    # A workflow is only 'ready' once something has RENDERED with it — a clean
    # import means the document is well-formed, not that it works.
    if custom_id:
        RC.record_success(custom_id)
    # Before job_done: the browser watches the job, and a clip still holding a
    # still frame when its job reads `done` is the bug this fixes wearing a
    # shorter timeout.
    # KEEP THE NAME. The chain modal writes "Chain: <the prompt>" onto the
    # clip it places, and overwriting that with "Block 9" is what made a chain
    # indistinguishable from the shots it joins the moment its block landed.
    _attach_to_clip(tgt, asset, info,
                    extra=({"block_id": block["id"],
                            "label": _clip_label(
                                (block.get("params") or {}).get("clip_kind", "shot"),
                                int(block["idx"]), _clip_now(tgt.get("clip_id")))}
                           if block else None))
    if block is not None and tgt.get("clip_id"):
        _exclude_from_other_cuts(tgt.get("clip_id"), block["id"], label="clip_gen")
    sb.job_done(jid, output_asset_id=asset["id"])
    for p_ in (raw, mp4):
        try:
            os.remove(p_)
        except OSError:
            pass
    log(f"JOB DONE clip_gen -> {asset['b2_key']}"
        + (f" (block {block['idx']})" if block else ""))


# ------------------------------------------------------------- transitions ---
def handle_transition_gen(job):
    """FLF bridge between clip A's last displayed frame and clip B's first."""
    jid = job["id"]
    payload = job.get("payload") or {}
    a = sb.asset_by_id(payload["from_asset_id"])
    b = sb.asset_by_id(payload["to_asset_id"])
    dur_ms = int(payload.get("dur_ms") or 1000)
    # Legal counts nearest short cuts: 22f (~0.9s) / 39f (~1.6s)
    frames = 22 if dur_ms <= 1200 else 39

    la, lb = f"/tmp/{jid}_a.mp4", f"/tmp/{jid}_b.mp4"
    media.b2_get(a["b2_key"], la)
    media.b2_get(b["b2_key"], lb)
    fa, fb = f"/tmp/{jid}_fa.png", f"/tmp/{jid}_fb.png"
    media.extract_frame(la, fa, at_ms=payload.get("from_at_ms"),
                        from_end=payload.get("from_at_ms") is None)
    media.extract_frame(lb, fb, at_ms=int(payload.get("to_at_ms") or 0))
    import shutil
    na, nb = f"qamba_ta_{jid}.png", f"qamba_tb_{jid}.png"
    shutil.copy(fa, os.path.join(COMFY_ROOT, "input", na))
    shutil.copy(fb, os.path.join(COMFY_ROOT, "input", nb))

    prompt = payload.get("prompt")
    if not prompt:
        # Vision-written bridge prompt when a Claude backend is configured;
        # llm.flf_prompt falls back to its template otherwise.
        import llm
        prompt = llm.flf_prompt(fa, fb, style=payload.get("style"))
    prompt = h3_prompt.flf_alignment_line(h3_timing.frames_to_ms(frames)) + "\n\n" + prompt
    resolved = R.resolve(H3_MODEL, "flf", positive=prompt, negative="",
                         seed=int(payload.get("seed") or 42),
                         width=a["width"] or 1280, height=a["height"] or 720,
                         length=frames, exact_frames=frames,
                         source_image=na, end_image=nb)
    log(f"transition_gen {frames}f between {a['b2_key']} -> {b['b2_key']}")
    pid = comfy.submit(resolved["graph"])
    sb.job_patch(jid, {"comfy_prompt_id": pid})
    outputs = comfy.wait(pid, on_tick=make_tick(job), timeout=1800)

    raw = f"/tmp/{jid}_raw.mp4"
    comfy.fetch_output(outputs, resolved["outputs"], raw)
    mp4 = f"/tmp/{jid}.mp4"
    media.transcode_web(raw, mp4)
    key = f"transitions/{jid}.mp4"
    media.b2_put(mp4, key)
    info = media.probe(mp4)
    asset = sb.register_asset(key, "video", project_id=a.get("project_id"),
                              content_type="video/mp4", bytes_=info["bytes"],
                              width=info["width"], height=info["height"],
                              duration_ms=info["duration_ms"], fps=info["fps"],
                              source_job_id=jid, origin="derived",
                              meta={"transition_from": a["id"], "transition_to": b["id"]},
                              tags=["transition"])
    sb.job_done(jid, output_asset_id=asset["id"])
    for p in (la, lb, fa, fb, raw, mp4):
        try:
            os.remove(p)
        except OSError:
            pass
    log(f"JOB DONE transition_gen -> {key}")

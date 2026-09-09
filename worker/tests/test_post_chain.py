"""The post chain: resolution, staging, cache keying and the lane guard.

Every failure this pins is a SILENT one — a pass that doesn't run, a cached
intermediate reused after the look changed, or ComfyUI loading beside a live
render — so none of it announces itself in the output file.
"""
import io
import json
import re
from unittest.mock import patch

import pytest

import post_chain as pc
from handlers import render


# ------------------------------------------------------------- resolution ----
def test_null_inherits_the_project_and_empty_dict_does_not():
    """The whole reason the column is nullable. `{}` is a clip saying "nothing",
    which has to survive a project-wide "everything gets grain"."""
    assert pc.resolve(None, {"grain": True}) == ("inherit", {"grain": True})
    assert pc.resolve({}, {"grain": True}) == ("custom", {})


def test_a_custom_chain_replaces_the_project_rather_than_merging():
    mode, chain = pc.resolve({"upscale": True}, {"grain": True})
    assert mode == "custom"
    assert chain == {"upscale": True}


def test_unknown_and_false_keys_are_dropped():
    """A jsonb column takes anything; a typo that reads as empty is a switch
    that looks on and renders off."""
    assert pc.normalize({"grian": True, "grain": False, "grain2": True}) == {}
    assert pc.normalize({"grain": True, "nope": True}) == {"grain": True}


def test_a_non_object_is_inherit_not_a_chain():
    for v in (None, [], "grain", 3):
        assert pc.normalize(v) is None


def test_ops_run_in_canon_order_whatever_order_the_row_lists_them():
    chain = {"grain": True, "upscale": True, "interpolate": True}
    assert pc.active_ops(chain) == ["upscale", "interpolate", "grain"]


def test_every_op_declares_a_stage_and_grain_finishes_last():
    assert set(pc.POST_STAGE) == set(pc.POST_ORDER)
    assert pc.POST_STAGE["grain"] == "finish"
    assert pc.POST_ORDER[-1] == "grain"


def test_stage_filter_splits_the_chain_around_the_normalize_step():
    chain = {op: True for op in pc.POST_ORDER}
    assert pc.active_ops(chain, "source") == [
        "upscale", "ltx_refine", "interpolate", "facefix", "h3_facefix"]
    assert pc.active_ops(chain, "finish") == ["color_match", "grain"]


def test_restore_runs_before_the_generative_refine():
    """Order, not membership. SeedVR2 recovers real detail and LTX 2.5
    resynthesises; running the refine first would have it invent detail that
    the restore then treats as signal."""
    assert pc.POST_ORDER.index("upscale") < pc.POST_ORDER.index("ltx_refine")
    # And both come before the frame rate: interpolating first would build the
    # new frames out of the picture neither pass has finished with yet.
    assert pc.POST_ORDER.index("ltx_refine") < pc.POST_ORDER.index("interpolate")


def test_needs_gpu_is_about_comfyui_not_about_cost():
    # color_match FLIPPED to True on 2026-08-23, and this test's own name is
    # the reason. It used to be a stub that raised; it now runs on KJNodes'
    # ColorMatch, so it occupies the serial ComfyUI queue even though colour
    # transfer loads no model and touches no GPU.
    assert pc.needs_gpu({"grain": True}) is False
    assert pc.needs_gpu({"color_match": True}) is True
    assert pc.needs_gpu({"upscale": True}) is True
    assert pc.needs_gpu({"ltx_refine": True}) is True
    assert pc.needs_gpu({"grain": True, "interpolate": True}) is True
    assert pc.needs_gpu({}) is False
    assert pc.needs_gpu(None) is False


def test_grain_is_the_only_pass_that_runs_without_comfyui():
    # As a set, because the trap is adding a pass that shells out to a graph
    # and forgetting GPU_OPS — which puts a ComfyUI job on the cpu lane,
    # beside a live render.
    assert set(pc.POST_ORDER) - pc.GPU_OPS == {"grain"}


# ------------------------------------------------------------- cache key -----
ASSET = {"b2_key": "blocks/b1.mp4"}
CLIP = {"in_ms": 0, "out_ms": 4000, "ops": []}


def test_an_empty_chain_keys_exactly_as_it_did_before_the_feature():
    """Adding a key unconditionally would invalidate every cached intermediate
    on the pod for a feature nobody has turned on yet."""
    legacy = json.dumps({"b2": ASSET["b2_key"], "in": 0, "out": 4000, "ops": [],
                         "fps": 24, "w": 1920, "h": 1080}, sort_keys=True)
    import hashlib
    assert render.op_hash(ASSET, CLIP, 24, 1920, 1080, None) \
        == hashlib.sha1(legacy.encode()).hexdigest()
    assert render.op_hash(ASSET, CLIP, 24, 1920, 1080, {}) \
        == render.op_hash(ASSET, CLIP, 24, 1920, 1080, None)


def test_turning_a_pass_on_changes_the_cache_key():
    """Otherwise the render serves the intermediate from before the change and
    the master comes back looking exactly as it did."""
    plain = render.op_hash(ASSET, CLIP, 24, 1920, 1080, {})
    grainy = render.op_hash(ASSET, CLIP, 24, 1920, 1080, {"grain": True})
    both = render.op_hash(ASSET, CLIP, 24, 1920, 1080, {"grain": True, "upscale": True})
    assert len({plain, grainy, both}) == 3


def test_the_key_is_the_resolved_chain_so_inheriting_clips_follow_the_project():
    """The hash takes the resolved ops, so a clip whose own column never
    changed still re-renders when the project's default does."""
    chain = pc.resolve(None, {"grain": True})[1]
    assert render.op_hash(ASSET, CLIP, 24, 1920, 1080, chain) \
        == render.op_hash(ASSET, CLIP, 24, 1920, 1080, {"grain": True})


def test_the_grade_reference_is_in_the_cache_key_but_only_when_it_is_read():
    """Both halves matter and each fails silently on its own.

    IN the key when color_match is on: the reference decides what the clip is
    graded to, so a new reference is a different picture — a key without it
    serves the old grade out of the clip cache forever, and nothing in the
    output says the render ignored the change.

    OUT of it otherwise: every clip cached before the field existed keeps its
    entry, which is the same rule `audio_detached` and `post` already follow.
    """
    cm = {"color_match": True}
    ga = {"mode": "asset", "asset_id": "ref-a", "strength": 1.0}
    gb = {"mode": "asset", "asset_id": "ref-b", "strength": 1.0}
    gs = {"mode": "source", "asset_id": "ref-a", "strength": 1.0}
    assert render.op_hash(ASSET, CLIP, 24, 1920, 1080, cm, ga) \
        != render.op_hash(ASSET, CLIP, 24, 1920, 1080, cm, gb)
    # The MODE is part of the key too: switching a project from asset to
    # source grading is a different picture for every clip that matches.
    assert render.op_hash(ASSET, CLIP, 24, 1920, 1080, cm, ga) \
        != render.op_hash(ASSET, CLIP, 24, 1920, 1080, cm, gs)
    assert render.op_hash(ASSET, CLIP, 24, 1920, 1080, cm, None) \
        != render.op_hash(ASSET, CLIP, 24, 1920, 1080, cm, ga)
    # A reference set on a chain that does not grade changes nothing.
    grain = {"grain": True}
    assert render.op_hash(ASSET, CLIP, 24, 1920, 1080, grain, ga) \
        == render.op_hash(ASSET, CLIP, 24, 1920, 1080, grain)


def test_post_chained_clips_carry_the_pipeline_version_and_plain_ones_do_not():
    """v2 invalidates every post-chained cache entry ON PURPOSE — they were
    rendered through crf-20 web transcodes with the range wash and the global
    grade flattening baked in. A plain clip's bytes never changed, so its
    entry survives; keying everyone would re-render a whole timeline to
    record a version bump that did not touch them."""
    assert render.op_hash(ASSET, CLIP, 24, 1920, 1080, {}) \
        == render.op_hash(ASSET, CLIP, 24, 1920, 1080, None)
    h_grain = render.op_hash(ASSET, CLIP, 24, 1920, 1080, {"grain": True})
    assert h_grain != render.op_hash(ASSET, CLIP, 24, 1920, 1080, {})


# ------------------------------------------------------------- lane guard ----
def test_a_comfyui_chain_refuses_to_run_on_the_cpu_lane():
    """worker.py fills the cpu pool concurrently with the serial gpu slot, so
    this is what stops SeedVR2 loading beside a live H3 render."""
    with pytest.raises(RuntimeError) as e:
        render._require_gpu_lane({"lane": "cpu"}, [{"grain": True}, {"upscale": True}], "tl_render")
    assert "upscale" in str(e.value) and "gpu" in str(e.value)


def test_an_ffmpeg_only_chain_stays_on_the_cpu_lane():
    render._require_gpu_lane({"lane": "cpu"}, [{"grain": True}, {}], "tl_render")


def test_the_guard_cannot_fire_on_a_render_queued_before_the_feature():
    """Every pre-existing clip resolves to an empty chain — nothing to refuse."""
    render._require_gpu_lane({"lane": "cpu"}, [pc.resolve(None, {})[1]] * 5, "tl_render")


def test_the_gpu_lane_takes_anything():
    render._require_gpu_lane({"lane": "gpu"}, [{"upscale": True}], "tl_render")


def test_the_desktops_own_lane_takes_it_too():
    """`local` is the DESKTOP's queue, and it qualifies for the same reason the
    pod's gpu slot does rather than by exception: localWorker runs one job at a
    time by construction, so there is no concurrent pool for a second model to
    land beside. Refusing it would refuse every local render of a cut that has
    a finishing pass on it — which is the render the picker exists for."""
    render._require_gpu_lane({"lane": "local"}, [{"upscale": True}], "tl_render")


def test_the_api_and_llm_pools_are_still_refused():
    """Those ARE filled concurrently, so the guard has to keep naming them —
    widening it to "not cpu" would have quietly let both through."""
    for lane in ("api", "llm", "cpu"):
        with pytest.raises(RuntimeError):
            render._require_gpu_lane({"lane": lane}, [{"upscale": True}], "tl_render")


# --------------------------------------------------- project default read ----
def test_an_unreadable_project_raises_rather_than_rendering_ungraded():
    """Falling back to "no passes" would produce a master without the look it
    was set up with and say nothing about it."""
    with patch.object(render.sb, "get", side_effect=RuntimeError("boom")):
        with pytest.raises(RuntimeError, match="post defaults"):
            render.project_post_chain("proj-1")


def test_a_project_with_no_post_setting_reads_as_no_passes():
    with patch.object(render.sb, "get", return_value=[{"settings": {"image_model": "krea2-local"}}]):
        assert render.project_post_chain("proj-1") == {}


# --------------------------------------------------- the clip's own window ----
# The source passes used to see the whole downloaded take, which is what made a
# real timeline render OOM: a 3.1s clip of a 12.0s take paid SeedVR2 and LTX 2.5
# over all twelve seconds, and the take's length is not something the edit can
# bring down.
WINDOWED = {"in_ms": 2000, "out_ms": 5000, "ops": []}


def _probe(dur_ms=12000, w=1280, h=736, fps=24.0):
    return {"width": w, "height": h, "duration_ms": dur_ms, "fps": fps,
            "has_audio": True, "bytes": 1}


def test_a_clip_that_plays_the_whole_take_is_not_re_encoded():
    """No window means the passes read the take as it was uploaded — the same
    bytes an untrimmed clip has always been restored from, with no extra
    generation in front of a pass that sharpens what it is given."""
    with patch.object(render.media, "probe", return_value=_probe()), \
         patch.object(render.media, "run_ff") as ff:
        assert render.source_window("/t/src.mp4", "/t/win.mp4",
                                    {"in_ms": 0, "out_ms": 12000}) is None
        assert render.source_window("/t/src.mp4", "/t/win.mp4", {}) is None
        ff.assert_not_called()


def test_the_window_carries_the_cut_and_nothing_else():
    """Trim only — no ops and no fit. The ops belong to the body render, which
    is the only step that knows the timeline's grid, and normalising here would
    hand the restore a letterboxed frame instead of original pixels."""
    with patch.object(render.media, "probe", return_value=_probe()), \
         patch.object(render.media, "has_audio", return_value=True), \
         patch.object(render.media, "run_ff") as ff:
        out = render.source_window("/t/src.mp4", "/t/win.mp4",
                                   {"in_ms": 2000, "out_ms": 5000,
                                    "ops": [{"op": "flip", "dir": "h"}]})
    assert out == "/t/win.mp4"
    args = ff.call_args[0][0]
    vf = args[args.index("-vf") + 1]
    assert vf == "trim=start=2.000:end=5.000,setpts=PTS-STARTPTS"
    assert "hflip" not in vf and "scale=" not in vf and "fps=" not in vf


def test_the_source_passes_see_the_clip_and_the_body_does_not_cut_twice():
    """Both halves fail silently on their own: leaving the take whole is the
    OOM, and leaving the cut on the body trims the window against its own zero
    and takes real frames out of the clip."""
    seen = {}

    def fake_apply_chain(job, src, dst, ops, **kw):
        seen["pre_src"] = src
        return dst

    def fake_body(src, dst, clip, **kw):
        seen["body_clip"] = clip
        return dst

    with patch.object(render.media, "probe", return_value=_probe()), \
         patch.object(render.media, "has_audio", return_value=True), \
         patch.object(render.media, "run_ff"), \
         patch.object(render, "render_clip_file", side_effect=fake_body), \
         patch("handlers.post.apply_chain", side_effect=fake_apply_chain):
        render.render_clip_with_post("/t/take.mp4", "/t/out.mp4", dict(WINDOWED),
                                     width=1280, height=720, fps=24,
                                     chain={"upscale": True})

    assert seen["pre_src"] == "/t/out.mp4.win.mp4"
    assert (seen["body_clip"]["in_ms"], seen["body_clip"]["out_ms"]) == (0, None)


def test_a_chain_with_no_source_pass_never_touches_the_source():
    """grain alone runs after the body render, so there is nothing to cut early
    and no reason to spend an encode."""
    with patch.object(render.media, "probe") as probe, \
         patch.object(render, "render_clip_file"), \
         patch("handlers.post.apply_chain", return_value="/t/out.mp4"):
        render.render_clip_with_post("/t/take.mp4", "/t/out.mp4", dict(WINDOWED),
                                     width=1280, height=720, fps=24,
                                     chain={"grain": True})
        probe.assert_not_called()


# ------------------------------------------------------------- VRAM bound ----
from handlers import post  # noqa: E402  (pulls comfy; render.py alone does not)

SV2_PX = 2560 * 1472   # 1280x736 at the pass's own scale 2


def test_a_clip_that_fits_is_passed_through_whole():
    """Windowing has to be invisible below the budget: one call, on the file it
    was given, no extra encode."""
    assert post.plan_windows(100, SV2_PX) == []
    calls = []
    with patch.object(post.media, "probe", return_value=_probe(dur_ms=4000)), \
         patch.object(post.media, "run_ff") as ff:
        post._windowed(None, "/t/a.mp4", "/t/b.mp4",
                       lambda i, o, tag: calls.append((i, o, tag)),
                       out_px_per_frame=SV2_PX, label="upscale")
    assert calls == [("/t/a.mp4", "/t/b.mp4", "")]
    ff.assert_not_called()


def test_the_windows_tile_the_clip_and_the_last_one_is_open():
    """Contiguous and gapless, or the join drops or repeats frames. The last
    window has no end because the frame count is duration x fps — ffprobe does
    not give an exact one without decoding — so a one-frame error must not be
    able to cut the final frame off a clip."""
    for frames in (128, 144, 212, 288, 300, 999):
        plan = post.plan_windows(frames, SV2_PX)
        assert plan and plan[0][0] == 0
        assert plan[-1][1] is None
        for (_, end), (start, _) in zip(plan, plan[1:]):
            assert end == start
        assert all(end - start <= post.POST_CHUNK_PIXELS // SV2_PX
                   for start, end in plan[:-1])


def test_every_measured_failure_is_split_and_the_budget_stays_under_them():
    """The measured points, SeedVR2 at scale 2 over 1280x736 on the 96 GB card:
    144 frames completed, 200 OOM'd at a 94055 MiB peak, 288 was the render
    that started this. Each of the two failures has to come back split, and the
    budget has to sit under the one that WORKED as well — 144 ran with ~30 GB
    spare and 200 with none, so the wall is close behind the last good size."""
    assert len(post.plan_windows(200, SV2_PX)) >= 2
    assert len(post.plan_windows(288, SV2_PX)) >= 3
    assert post.POST_CHUNK_PIXELS < 542_000_000        # the last size that ran


def test_a_bigger_frame_gets_fewer_frames_per_window():
    """The budget is pixel-frames, not frames: the same 8 seconds of 4K is four
    times the tensor 1080p is, and a frame cap would only bound one of them."""
    assert len(post.plan_windows(240, 3840 * 2160)) \
        > len(post.plan_windows(240, 1920 * 1080))


# ------------------------------------------------------ the clip's own slot ----
# A clip renders `[in_ms, out_ms]` and OCCUPIES `duration_ms` on the timeline,
# and those two disagreed on 8 of 21 clips of a real cut — net +1928ms, one of
# them +2151ms alone. The editor lays clips out by duration_ms, so the preview
# was right and the render was long; and because the audio lanes are placed at
# absolute t_start_ms, the picture drifted against the dialogue rather than
# merely ending late.
ASSET_12S = {"id": "a", "b2_key": "k.mp4", "duration_ms": 12000, "fps": 24}


def test_a_clip_whose_slot_matches_its_trim_is_not_re_keyed():
    """The fit has to be free for the clips it does not change, or repairing a
    handful of them re-renders a whole timeline."""
    clip = {"in_ms": 0, "out_ms": 3000, "duration_ms": 3000, "ops": []}
    slot, fit = render.clip_fit_ms(clip, ASSET_12S)
    assert slot == 3000 and fit is None
    assert render.op_hash(ASSET_12S, clip, 24, 1920, 1080, {}) \
        == render.op_hash(ASSET_12S, clip, 24, 1920, 1080, {}, fit_ms=None)


def test_a_clip_that_renders_longer_than_its_slot_is_re_keyed():
    """The real case: a generated take whose `out_ms` covers the whole render
    while `duration_ms` was only ever shrunk (see `_attach_to_clip`)."""
    clip = {"in_ms": 0, "out_ms": 3776, "duration_ms": 1625, "ops": []}
    slot, fit = render.clip_fit_ms(clip, ASSET_12S)
    assert (slot, fit) == (1625, 1625)
    assert render.op_hash(ASSET_12S, clip, 24, 1920, 1080, {}, fit_ms=fit) \
        != render.op_hash(ASSET_12S, clip, 24, 1920, 1080, {})


def test_a_speed_op_that_left_the_slot_behind_is_re_keyed_too():
    """The other direction, and it is why the fit pads as well as caps: 404ms
    of source at 1.5x is 269ms of picture in a 404ms slot."""
    clip = {"in_ms": 2911, "out_ms": 3315, "duration_ms": 404,
            "ops": [{"op": "speed", "rate": 1.5}]}
    slot, fit = render.clip_fit_ms(clip, ASSET_12S)
    assert slot == 404 and fit == 404


def test_the_fit_caps_and_pads_in_one_pass():
    """`tpad` then `-t` lands on the slot from either side without measuring
    the intermediate first."""
    vf, af = render.build_clip_filter([], width=1920, height=1080, fps=24,
                                      has_audio=True, in_ms=0, out_ms=3776,
                                      slot_ms=1625)
    assert "tpad=stop_mode=clone:stop_duration=1.625" in vf
    assert af.endswith("apad")
    plain, _ = render.build_clip_filter([], width=1920, height=1080, fps=24,
                                        has_audio=True, in_ms=0, out_ms=3776)
    assert "tpad" not in plain


def test_the_window_cut_is_never_fitted():
    """`source_window` runs at fit=False and hands the passes original pixels;
    padding there would put cloned frames INTO the restore."""
    vf, af = render.build_clip_filter([], width=1280, height=736, fps=24,
                                      has_audio=True, in_ms=2000, out_ms=5000,
                                      fit=False, slot_ms=1000)
    assert "tpad" not in vf and "apad" not in af


def test_the_final_mix_takes_the_longest_lane_not_the_picture():
    """`duration=first` is the picture's own audio, so an outro running past
    the last shot was cut at the last frame. Source-parsed: the mux is one
    ffmpeg call built from locals and there is nothing to call."""
    src = io.open("handlers/render.py", encoding="utf-8").read().replace("\r\n", "\n")
    mux = src[src.index("def handle_tl_render"):]
    assert "duration=longest[aout]" in mux
    assert "duration=first[aout]" not in mux    # the comment still names it
    # THE TAIL IS A CONCAT PIECE NOW, not a tpad in the final mux — a filtered
    # stream cannot also be `-c:v copy`, so the tpad version re-encoded the
    # whole cut at the last step on any timeline with an outro. The black
    # segment is encoded once with the same settings as every other piece and
    # stream-copied on, which is what lets `can_copy_video` actually fire.
    assert "tpad=stop_mode" not in mux
    assert "color=c=black" in mux                # the tail piece encode
    assert "anullsrc" in mux                     # ...with matching silence
    assert 'log(f"tl_render: {tail_ms}ms of audio past the last shot' in mux


def test_the_per_clip_post_chains_are_never_shadowed_in_the_render():
    """`chains` is the resolved post chain per clip, built at the top of
    handle_tl_render and read again 200 lines later to stamp the asset's
    `meta.post`. Rebinding the name in between fed that a list of filtergraph
    strings and blew up with `'str' object has no attribute 'get'` at the END
    of a 50-minute render — every clip and the whole assembly already spent.
    Nothing about the failure points at the shadow, so it is pinned here."""
    src = io.open("handlers/render.py", encoding="utf-8").read().replace("\r\n", "\n")
    fn = src[src.index("def handle_tl_render"):]
    fn = fn[:fn.index("\ndef ")] if "\ndef " in fn else fn
    binds = [ln for ln in fn.split("\n")
             if re.match(r"\s*chains\s*(,[^=]*)?=[^=]", ln)]
    assert len(binds) == 1, f"`chains` is assigned {len(binds)} times: {binds}"


# ─────────────────────────────────────────────── the 2026-08-25 repairs ────
def test_trim_chain_drops_interpolate_the_timeline_cannot_keep():
    """24fps source doubled to 48 and then locked back to a 24fps timeline is
    a model load, a sample and two encode generations that deliver the exact
    frames it started with — measured on a real cut (every interp intermediate
    at 48fps, every cached clip back at 24)."""
    ch = {"interpolate": True, "grain": True}
    a24 = {"fps": 24}
    assert render._trim_chain(ch, {}, a24, 24) == {"interpolate": False, "grain": True}
    # It survives where a frame it makes can land:
    assert render._trim_chain(ch, {}, a24, 48) == ch                 # fast timeline
    slow = {"ops": [{"op": "speed", "rate": 0.5}]}
    assert render._trim_chain(ch, slow, a24, 24) == ch               # slow motion
    fast = {"ops": [{"op": "speed", "rate": 2.0}]}
    assert render._trim_chain(ch, fast, a24, 24)["interpolate"] is False
    # No interpolate, nothing to decide:
    assert render._trim_chain({"grain": True}, {}, a24, 24) == {"grain": True}


def test_post_params_by_grade_mode():
    """Source mode plants a marker only render_clip_with_post can cash in;
    asset mode still names the still. An asset mode with no asset is the old
    unset state and gets no kwargs at all (the pass then RAISES, as ever)."""
    src = render._post_params({"mode": "source", "asset_id": None, "strength": 1.0})
    assert src["color_match"]["source_ref"] is True
    ast_ = render._post_params({"mode": "asset", "asset_id": "a1", "strength": 0.7})
    assert ast_["color_match"] == {"match_asset_id": "a1", "strength": 0.7}
    # No REFERENCE, so no color_match kwargs — the other passes' own tuning
    # rides in the same dict and is nothing to do with the grade.
    assert "color_match" not in render._post_params(
        {"mode": "asset", "asset_id": None, "strength": 1.0})


def test_source_mode_color_match_runs_pre_fit_with_the_clips_own_frame(tmp_path, monkeypatch):
    """The whole point of source mode: the matcher's reference is a frame of
    THIS clip's pre-post source, and the pass runs in the SOURCE stage — before
    the fit, so the letterbox bars the body render pads in are in neither side
    of the histogram."""
    import handlers.post as post

    calls = []

    def fake_chain(job, src, dst, ops, *, src_fps=24, params=None, tag="post",
                   cap_h=None):
        calls.append((tag, list(ops), {k: dict(v) for k, v in (params or {}).items()
                                       if isinstance(v, dict)}, cap_h))
        open(dst, "wb").write(b"x")
        return dst

    monkeypatch.setattr(post, "apply_chain", fake_chain)
    monkeypatch.setattr(render, "source_window", lambda *a, **k: None)
    monkeypatch.setattr(render, "render_clip_file",
                        lambda src, dst, clip, **k: open(dst, "wb").write(b"x") or dst)
    monkeypatch.setattr(render.media, "probe",
                        lambda p: {"duration_ms": 4000, "height": 736})
    grabbed = []
    monkeypatch.setattr(render.media, "extract_sheet",
                        lambda src, png, in_ms=0, out_ms=None, **k:
                        grabbed.append((in_ms, out_ms)) or open(png, "wb").write(b"p"))

    dst = str(tmp_path / "out.mp4")
    chain = {"upscale": True, "color_match": True, "grain": True}
    render.render_clip_with_post(str(tmp_path / "in.mp4"), dst, {"in_ms": 1000, "out_ms": 3000},
                                 width=1920, height=1080, fps=24, chain=chain,
                                 job={"id": "j1"},
                                 params=render._post_params({"mode": "source", "strength": 1.0}))
    pre = next(c for c in calls if c[0] == "pre")
    fin = [c for c in calls if c[0] == "fin"]
    assert pre[1] == ["upscale", "color_match"]          # moved, and LAST in source
    assert fin and fin[0][1] == ["grain"]                # nothing gradeable left behind
    cm = pre[2]["color_match"]
    assert "source_ref" not in cm                        # marker cashed, not forwarded
    assert cm["reference"].endswith(".cmsrc.png")
    assert grabbed == [(1000, 3000)]                     # the WINDOW, pooled — not one frame
    # SeedVR2's scale is what the timeline can keep, not a constant 2:
    assert pre[2]["upscale"]["scale"] == pytest.approx(1.47, abs=0.02)
    # …and the chain is told the frame it is heading for, so a pass is not
    # squashed to 1080 one hop before the render that wanted it.
    assert pre[3] == 1080


def test_source_mode_color_match_is_dropped_when_nothing_moved_the_color(monkeypatch, tmp_path):
    """grain is ffmpeg and range-clean; with no ComfyUI pass in the chain a
    self-match is a no-op that still costs a model-side hop. Dropped, loudly."""
    import handlers.post as post
    calls = []
    monkeypatch.setattr(post, "apply_chain",
                        lambda job, src, dst, ops, **k: calls.append(list(ops)) or src)
    monkeypatch.setattr(render, "render_clip_file",
                        lambda src, dst, clip, **k: open(dst, "wb").write(b"x") or dst)
    dst = str(tmp_path / "out.mp4")
    render.render_clip_with_post(str(tmp_path / "in.mp4"), dst, {},
                                 width=1920, height=1080, fps=24,
                                 chain={"color_match": True, "grain": True},
                                 job={"id": "j1"},
                                 params=render._post_params({"mode": "source", "strength": 1.0}))
    assert all("color_match" not in ops for ops in calls)


def test_asset_mode_color_match_stays_in_the_finish_stage(monkeypatch, tmp_path):
    """The original semantics survive under the original settings: a project
    that deliberately grades to one still keeps its finish-stage match and its
    named reference — nothing is extracted for it."""
    import handlers.post as post
    calls = []

    def fake_chain(job, src, dst, ops, *, src_fps=24, params=None, tag="post",
                   cap_h=None):
        calls.append((tag, list(ops), (params or {}).get("color_match")))
        open(dst, "wb").write(b"x")
        return dst

    monkeypatch.setattr(post, "apply_chain", fake_chain)
    monkeypatch.setattr(render, "source_window", lambda *a, **k: None)
    monkeypatch.setattr(render, "render_clip_file",
                        lambda src, dst, clip, **k: open(dst, "wb").write(b"x") or dst)
    monkeypatch.setattr(render.media, "probe",
                        lambda p: {"duration_ms": 4000, "height": 736})
    monkeypatch.setattr(render.media, "extract_sheet",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("extracted for asset mode")))
    dst = str(tmp_path / "out.mp4")
    render.render_clip_with_post(str(tmp_path / "in.mp4"), dst, {},
                                 width=1920, height=1080, fps=24,
                                 chain={"upscale": True, "color_match": True},
                                 job={"id": "j1"},
                                 params=render._post_params({"mode": "asset", "asset_id": "a9",
                                                             "strength": 1.0}))
    pre = next(c for c in calls if c[0] == "pre")
    fin = next(c for c in calls if c[0] == "fin")
    assert pre[1] == ["upscale"]
    assert fin[1] == ["color_match"]
    assert fin[2]["match_asset_id"] == "a9"

"""How the two generative post passes are TUNED.

Everything here is silent when it is wrong. A refine that samples at the wrong
size still delivers a clip; a sigma preset that does not resolve falls back to
a different schedule and says nothing; a SeedVR2 key that quietly becomes the
3B renders a perfectly good picture that is not the one that was asked for; and
a tuning left out of the cache key serves the previous settings forever.
"""
import pytest

import graphs
import handlers.post as post
from handlers import render


@pytest.mark.parametrize("kind,applier", [
    (post.handle_post_upscale, "apply_upscale"),
    (post.handle_post_ltx_refine, "apply_ltx_refine"),
])
def test_standalone_finishing_preserves_requested_portrait_height(monkeypatch, kind, applier):
    seen = []
    monkeypatch.setattr(post, "_load_source", lambda job: ({"id": "source", "fps": 24}, "in.mp4"))
    monkeypatch.setattr(post, applier, lambda *a, **kw: seen.append(kw))
    monkeypatch.setattr(post, "_finish", lambda *a, **kw: None)
    monkeypatch.setattr(post, "_rm", lambda *a: None)
    kind({"id": "job", "payload": {"cap_h": 2048}})
    assert seen[-1]["cap_h"] == 2048
    kind({"id": "job", "payload": {}})
    assert seen[-1]["cap_h"] is None
    for bad in [True, 0, 9000, "2048", 2048.5]:
        with pytest.raises(ValueError, match="cap_h"):
            kind({"id": "job", "payload": {"cap_h": bad}})


# ------------------------------------------------------- the target frame ----
def test_fit_samples_at_the_delivery_frame_rather_than_a_fixed_2x():
    """The point of the mode: an H3 take on a 1080p timeline is refined at
    1080p, not at 2560x1408 that `transcode_chain` then caps away."""
    assert post.refine_target(1280, 704, 1920, 1080) == (1920, 1056)


def test_the_target_keeps_the_SOURCE_aspect_and_never_the_timelines():
    """The body render letterboxes a landscape take into a portrait frame, so
    matching the TIMELINE's shape here would stretch the picture and then pad
    the stretch. A 16:9 take stays 16:9 and fits the portrait frame's width."""
    w, h = post.refine_target(640, 360, 1080, 1920)      # portrait timeline
    assert w / h == pytest.approx(640 / 360, abs=0.02)
    assert w <= 1080 + 32   # a step over the box is allowed where it buys shape


def test_a_take_the_frame_can_only_shrink_is_left_at_native():
    """A 720p landscape take delivered into a portrait cut is letterboxed down
    to ~607 wide — there is nothing to enlarge, so there is nothing to resample
    for."""
    assert post.refine_target(1280, 720, 1080, 1920) is None


def test_the_enlarge_is_capped_at_2x_like_the_restores():
    """Above 2x nothing on this box has a recipe — LTX's own learned upsampler
    stops there — so a tiny take on a 4K timeline restores, it does not
    hallucinate sixteen times the pixels."""
    w, h = post.refine_target(480, 270, 3840, 2160)
    assert (w, h) == (960, 544)
    # The cap is on the SCALE; the grid snap can land a step above it, the
    # same slack the box gets. What must never happen is a 4x frame.
    assert w <= 480 * 2 + 32 and h <= 270 * 2 + 32


def test_1080_is_the_ceiling_because_the_chain_transcode_is():
    """Every chain intermediate is capped at 1080 tall one hop later, so a
    1440p timeline gains nothing from sampling above it."""
    assert post.refine_target(1280, 704, 2560, 1440) == post.refine_target(1280, 704, 2560, 1080)


def test_a_take_already_at_the_delivery_size_falls_back_to_native():
    """None means "build no ImageScale node at all". A 2% stretch through
    lanczos costs a generation and delivers the same picture."""
    assert post.refine_target(1280, 720, 1280, 720) is None
    assert post.refine_target(1280, 704, 1280, 720) is None   # the 704 -> 720 case


def test_an_unknown_source_size_never_invents_one():
    """`assets.width` is null on plenty of rows and a probe can fail. Guessing
    a frame here would resize the shot to a number nobody chose."""
    assert post.refine_target(None, None, 1920, 1080) is None
    assert post.refine_target(1280, 704, 0, 0) is None


def test_the_target_lands_on_the_models_grid_without_stretching_the_picture():
    """Both at once, and the second half is what a per-axis floor gets wrong:
    `ImageScale` with crop disabled scales to exactly w x h, so an aspect the
    grid rounded badly is a stretch baked into the frame — and the body render
    then reads the STRETCHED frame's shape when it fits, so nothing undoes it.
    A 640x360 take floored on both axes comes out 3% wide."""
    for src in ((1280, 704), (1344, 768), (864, 480), (1080, 1920), (640, 360),
                (1216, 672), (960, 544), (480, 270)):
        for frame in ((1920, 1080), (1280, 720), (1080, 1920), (3840, 2160)):
            got = post.refine_target(*src, *frame)
            if not got:
                continue
            assert got[0] % 32 == 0 and got[1] % 32 == 0, (src, frame, got)
            err = abs(got[0] / got[1] - src[0] / src[1]) / (src[0] / src[1])
            # 0.74% is the measured worst case over these pairings; the bound
            # is the 32px grid, not the search.
            assert err < 0.01, (src, frame, got, err)


# -------------------------------------------------------------- the graph ----
LX = {"modes": {"t2v": {"checkpoint": "ltx.safetensors"}}, "text_encoders": ["te"],
      "vae": "v", "audio_vae": "av", "latent_upscaler": "up", "dim_step": 32}


def _classes(g):
    return {n["class_type"] for n in g.values()}


def test_a_target_resizes_in_pixel_space_before_the_encode():
    """The custom-resolution path: lanczos on the decoded frames, THEN the VAE.
    Resizing an already-encoded latent is what the learned upsampler is for,
    and it only knows one ratio."""
    g = graphs.ltx_refine_graph(LX, "in.mp4", target=(1920, 1056))
    scale = next(n for n in g.values() if n["class_type"] == "ImageScale")
    assert scale["inputs"]["upscale_method"] == "lanczos"
    assert (scale["inputs"]["width"], scale["inputs"]["height"]) == (1920, 1056)
    # Straight off the source frames, and the encode reads the resize.
    enc = next(k for k, n in g.items() if n["class_type"] == "VAEEncode")
    assert g[enc]["inputs"]["pixels"][0] == next(
        k for k, n in g.items() if n["class_type"] == "ImageScale")
    assert "LTXVLatentUpsampler" not in _classes(g)


def test_native_builds_no_resize_node_at_all():
    g = graphs.ltx_refine_graph(LX, "in.mp4")
    assert "ImageScale" not in _classes(g)
    assert "LTXVLatentUpsampler" not in _classes(g)


def test_the_2x_path_is_untouched():
    g = graphs.ltx_refine_graph(LX, "in.mp4", upscale=True)
    assert "LTXVLatentUpsampler" in _classes(g)
    assert "ImageScale" not in _classes(g)


def test_the_two_size_modes_refuse_to_stack():
    """Pre-resizing and then running a fixed-ratio learned upsampler is two
    resamples to reach a size neither was asked for."""
    with pytest.raises(RuntimeError, match="never both"):
        graphs.ltx_refine_graph(LX, "in.mp4", upscale=True, target=(1920, 1056))


def test_an_off_grid_target_is_snapped_rather_than_encoded():
    """1080 is not a multiple of 32 — the size the source workflow asks for.
    LTX's VAE downsamples by 32, so an off-grid encode is a pad or a failure
    deep in the sampler."""
    g = graphs.ltx_refine_graph(LX, "in.mp4", target=(1920, 1080))
    scale = next(n for n in g.values() if n["class_type"] == "ImageScale")
    assert scale["inputs"]["height"] % 32 == 0


def test_a_preset_name_resolves_to_a_schedule():
    g = graphs.ltx_refine_graph(LX, "in.mp4", sigmas="faithful")
    sig = next(n for n in g.values() if n["class_type"] == "ManualSigmas")
    assert sig["inputs"]["sigmas"] == graphs.LTX_REFINE_PRESETS["faithful"]


def test_a_raw_schedule_still_passes_through():
    """The preset table is a convenience, not a gate — an explicit string is
    how a measurement gets made in the first place."""
    g = graphs.ltx_refine_graph(LX, "in.mp4", sigmas="0.9, 0.4, 0.0")
    sig = next(n for n in g.values() if n["class_type"] == "ManualSigmas")
    assert sig["inputs"]["sigmas"] == "0.9, 0.4, 0.0"


def test_every_preset_is_a_descending_schedule_that_reaches_zero():
    for name, s in graphs.LTX_REFINE_PRESETS.items():
        vals = [float(x) for x in s.split(",")]
        assert vals[-1] == 0.0, name
        assert vals == sorted(vals, reverse=True), name
        assert vals[0] <= 1.0, name


def test_the_decode_tiles_only_where_a_plain_one_would_not_fit():
    small = graphs.ltx_refine_graph(LX, "in.mp4")
    big = graphs.ltx_refine_graph(LX, "in.mp4", target=(2560, 1440))
    assert "VAEDecode" in _classes(small) and "VAEDecodeTiled" not in _classes(small)
    assert "VAEDecodeTiled" in _classes(big)
    # 1080p decodes whole: the common delivery size must not pay for seams.
    assert "VAEDecodeTiled" not in _classes(
        graphs.ltx_refine_graph(LX, "in.mp4", target=(1920, 1056)))


def test_tiling_is_spatial_only():
    """A seam in space is a static edge the overlap blends away; a seam in TIME
    is a hitch in the motion, which is what this pass exists to avoid."""
    g = graphs.ltx_refine_graph(LX, "in.mp4", upscale=True)
    dec = next(n for n in g.values() if n["class_type"] == "VAEDecodeTiled")
    assert dec["inputs"]["temporal_size"] >= 4096


def test_the_audio_is_still_the_takes_own_and_not_the_refined_one():
    """The one thing the source workflow does differently, and deliberately not
    adopted: it feeds an EMPTY audio latent. Whatever conditions the sampler,
    what LANDS must be the source's soundtrack."""
    g = graphs.ltx_refine_graph(LX, "in.mp4", target=(1920, 1056))
    assert "LTXVAudioVAEEncode" in _classes(g)
    assert "LTXVEmptyLatentAudio" not in _classes(g)
    vid = next(n for n in g.values() if n["class_type"] == "CreateVideo")
    comp = next(k for k, n in g.items() if n["class_type"] == "GetVideoComponents")
    assert vid["inputs"]["audio"] == [comp, 1]


def test_video_cfg_reaches_the_guider():
    g = graphs.ltx_refine_graph(LX, "in.mp4", video_cfg=1.5)
    gd = next(n for n in g.values() if n["class_type"] == "LTXVDualCFGGuider")
    # The scales DISAGREEING is the whole mechanism — equal ones collapse the
    # guider to single-CFG and at 1.0 ComfyUI skips the uncond pass entirely.
    assert gd["inputs"]["video_cfg"] == 1.5 and gd["inputs"]["audio_cfg"] == 1.0


# ------------------------------------------------------- checkpoint keys ----
def test_a_key_maps_to_a_file_and_nothing_else_does():
    assert post.seedvr2_model("7b") == graphs.SEEDVR2_MODELS["7b"]
    assert post.seedvr2_model(None) == graphs.SEEDVR2_MODELS[graphs.SEEDVR2_DEFAULT]
    # The escape hatch for something dropped on the pod by hand.
    assert post.seedvr2_model("mine.safetensors") == "mine.safetensors"


def test_an_unknown_key_raises_rather_than_quietly_running_the_3b():
    """"The 7B pass looks exactly like the 3B pass" is the worst symptom
    available, because the render succeeded."""
    with pytest.raises(RuntimeError, match="unknown SeedVR2 model"):
        post.seedvr2_model("13b")


def test_every_declared_checkpoint_is_a_seedvr2_two_file():
    """SeedVR **1** (ByteDance-Seed/SeedVR-7B) is a raw multi-step `.pth` that
    UNETLoader cannot read and steps=1 is meaningless for. It is not a row."""
    for k, f in graphs.SEEDVR2_MODELS.items():
        assert f.startswith("seedvr2_") and f.endswith(".safetensors"), k


# --------------------------------------------------------- reading them ----
def test_settings_are_clamped_to_something_the_worker_can_act_on():
    assert render._post_opts({}) == render.POST_OPTS
    assert render._post_opts({"post_refine_size": "enormous",
                              "post_refine_sigmas": "crunchy",
                              "post_upscale_model": "70b",
                              "post_grade_method": "vibes",
                              "post_h3face_canvas": "4k"}) == render.POST_OPTS
    got = render._post_opts({"post_refine_size": "fit", "post_refine_sigmas": "faithful",
                             "post_refine_cfg": 9, "post_upscale_model": "7b",
                             "post_grade_method": "reinhard_lab_gpu",
                             "post_h3face_canvas": "512", "post_h3face_denoise": 4})
    assert got == {"refine_size": "fit", "refine_sigmas": "faithful",
                   "refine_cfg": 3.0, "upscale_model": "7b",
                   "grade_method": "reinhard_lab_gpu",
                   "h3face_canvas": "512", "h3face_denoise": 0.9}


def test_the_defaults_are_the_shipped_behaviour():
    """Every render written before these settings existed has to be
    byte-identical, so the defaults are not a fresh opinion."""
    assert render.POST_OPTS == {"refine_size": "native", "refine_sigmas": "",
                                "refine_cfg": 1.0, "upscale_model": "3b",
                                "grade_method": "mkl",
                                "h3face_canvas": "768", "h3face_denoise": 0.4}


# ------------------------------------------------------- the cache key ----
ASSET = {"b2_key": "k.mp4"}
CLIP = {"in_ms": 0, "out_ms": 1000}


def _h(chain, opts):
    return render.op_hash(ASSET, CLIP, 24, 1920, 1080, chain, None, opts=opts)


def test_changing_the_refine_size_re_renders_the_clips_that_use_it():
    """A cache keyed without it serves the old settings forever — the failure
    `pipe: 2` was added for, arriving one feature later."""
    chain = {"ltx_refine": True}
    assert _h(chain, {"refine_size": "native"}) != _h(chain, {"refine_size": "fit"})
    assert _h(chain, {"refine_sigmas": ""}) != _h(chain, {"refine_sigmas": "sharp"})
    assert _h(chain, {"refine_cfg": 1.0}) != _h(chain, {"refine_cfg": 1.5})


def test_changing_the_restore_checkpoint_re_renders_too():
    chain = {"upscale": True}
    assert _h(chain, {"upscale_model": "3b"}) != _h(chain, {"upscale_model": "7b"})


def test_a_tuning_for_a_pass_that_is_OFF_changes_nothing():
    """Same rule the grade reference follows: keying a clip on a setting its
    chain cannot read would re-render a timeline to record nothing."""
    chain = {"grain": True}
    assert _h(chain, {"refine_size": "fit", "upscale_model": "7b"}) == _h(chain, None)


def test_the_defaults_key_exactly_as_they_did_before_the_feature():
    """Adding these settings must not invalidate one existing intermediate."""
    for chain in ({}, {"grain": True}, {"ltx_refine": True}, {"upscale": True}):
        assert _h(chain, None) == _h(chain, dict(render.POST_OPTS))


# ------------------------------------------- the size mode becomes a frame ----
def _run(chain, opts, tmp_path, monkeypatch, *, src=(1280, 704), frame=(1920, 1080)):
    calls = []

    def fake_chain(job, s, d, ops, *, src_fps=24, params=None, tag="post",
                   cap_h=None):
        # The chain is told where the render is GOING — a constant 1080 here
        # is what made the whole post chain unable to deliver above 1080p.
        assert cap_h == max(1080, frame[1]), cap_h
        calls.append((tag, list(ops), {k: dict(v) for k, v in (params or {}).items()
                                       if isinstance(v, dict)}))
        open(d, "wb").write(b"x")
        return d

    monkeypatch.setattr(post, "apply_chain", fake_chain)
    monkeypatch.setattr(render, "source_window", lambda *a, **k: None)
    monkeypatch.setattr(render, "render_clip_file",
                        lambda s, d, clip, **k: open(d, "wb").write(b"x") or d)
    monkeypatch.setattr(render.media, "probe",
                        lambda p: {"duration_ms": 4000, "width": src[0], "height": src[1]})
    render.render_clip_with_post(str(tmp_path / "in.mp4"), str(tmp_path / "out.mp4"),
                                 dict(CLIP), width=frame[0], height=frame[1], fps=24,
                                 chain=chain, job={"id": "j1"},
                                 params=render._post_params({"mode": "source"}, opts))
    return next(c for c in calls if c[0] == "pre")[2]


def test_the_size_mode_is_resolved_and_never_forwarded(tmp_path, monkeypatch):
    """`apply_ltx_refine` takes upscale/target/fit_frame and has never heard of
    `size_mode` — a marker left in the kwargs is a TypeError at render time.

    And it is the FRAME that travels, not a target: resolving one here would
    need the LTX entry's own `dim_step`, and defaulting that was measured
    turning 1920x1056 into 1920x1024 — a 3% squash the graph's defensive snap
    applied silently."""
    p = _run({"ltx_refine": True}, {"refine_size": "fit"}, tmp_path, monkeypatch)
    assert "size_mode" not in p["ltx_refine"]
    assert p["ltx_refine"]["fit_frame"] == (1920, 1080)
    assert "target" not in p["ltx_refine"]


def test_2x_becomes_the_upsampler_and_native_becomes_neither(tmp_path, monkeypatch):
    p = _run({"ltx_refine": True}, {"refine_size": "2x"}, tmp_path, monkeypatch)
    assert p["ltx_refine"] == {"upscale": True}
    p = _run({"ltx_refine": True}, {"refine_size": "native"}, tmp_path, monkeypatch)
    assert p["ltx_refine"] == {}


def test_the_grid_is_the_models_own_and_not_a_default(tmp_path, monkeypatch):
    """LTX 2.5's `dim_step` is 64 and `refine_target`'s default is 32, so the
    pass resolves the frame against the ENTRY rather than a default.

    A COARSER GRID MOVES THE ANSWER, and this is the case that shows why the
    search matters: on 64 the aspect-true pair is 1984x1088 — a step OVER the
    box on both axes, 0.29% off the source's shape — where the naive snap of
    the 32-grid answer is 1920x1024 at 3.1% off, which is a visible vertical
    squash. Those 3% extra pixels cost one resample on the way out; the
    squash cannot be undone at all."""
    on64 = post.refine_target(1280, 704, 1920, 1080, step=64)
    assert on64 == (1984, 1088)
    assert post.refine_target(1280, 704, 1920, 1080, step=32) == (1920, 1056)
    for got in (on64, (1920, 1024)):
        err = abs(got[0] / got[1] - 1280 / 704) / (1280 / 704)
        assert (err < 0.005) is (got == on64), (got, err)


def test_fit_falls_through_to_native_when_there_is_nothing_to_gain(tmp_path, monkeypatch):
    """The frame still travels — `apply_ltx_refine` is what decides there is
    nothing to do, because only it knows the grid."""
    p = _run({"ltx_refine": True}, {"refine_size": "fit"}, tmp_path, monkeypatch,
             src=(1920, 1080), frame=(1920, 1080))
    assert p["ltx_refine"]["fit_frame"] == (1920, 1080)
    assert post.refine_target(1920, 1080, 1920, 1080, step=64) is None


def test_the_sigma_and_cfg_settings_reach_the_pass(tmp_path, monkeypatch):
    p = _run({"ltx_refine": True},
             {"refine_sigmas": "faithful", "refine_cfg": 1.5}, tmp_path, monkeypatch)
    assert p["ltx_refine"]["sigmas"] == "faithful"
    assert p["ltx_refine"]["video_cfg"] == 1.5


def test_cfg_at_1_sends_nothing_so_the_guider_stays_collapsed(tmp_path, monkeypatch):
    p = _run({"ltx_refine": True}, {"refine_cfg": 1.0}, tmp_path, monkeypatch)
    assert "video_cfg" not in p["ltx_refine"]


def test_the_restore_targets_the_TIMELINE_and_the_chain_carries_it(tmp_path, monkeypatch):
    """Two numbers that agree at 1080p and must not be conflated either side
    of it.

    The restore's fit-scale is what the TIMELINE can keep — it was
    `min(1080, height)`, which quoted `transcode_chain`'s own constant and so
    held a 4K timeline at a 1080p restore once that constant was lifted. The
    CHAIN's cap has a 1080 floor instead, so no intermediate below it changes
    size. Borrowing either for the other is a regression in one direction or
    the other: a 4K timeline restored at 1080, or a 704 timeline restored at
    1.53x for the body render to throw away."""
    p = _run({"upscale": True}, {}, tmp_path, monkeypatch,
             src=(1280, 704), frame=(3840, 2160))
    assert p["upscale"]["scale"] == 2.0            # the real cap, not 1080/704
    p = _run({"upscale": True}, {}, tmp_path, monkeypatch,
             src=(1280, 704), frame=(1280, 704))
    assert p["upscale"]["scale"] == 1.0            # nothing to gain, nothing spent
    assert render.chain_cap_h(704) == 1080         # …while the chain is unchanged
    assert render.chain_cap_h(2160) == 2160


def test_the_enlarge_ceiling_is_reachable_but_not_the_default(tmp_path, monkeypatch):
    """2.0 by measurement, not by accident: at 4K the whole enlarge is 1.27x
    the detail for 2.5x the time (121s/+75.1% against 300s/+95.2%), which is
    the same trade the supersample decision already declined. What was wrong
    was that a 4K timeline could not reach the ceiling AT ALL."""
    assert render.POST_UPSCALE_MAX_SCALE == 2.0
    p = _run({"upscale": True}, {}, tmp_path, monkeypatch,
             src=(1280, 704), frame=(3840, 2160))
    assert p["upscale"]["scale"] == 2.0
    monkeypatch.setattr(render, "POST_UPSCALE_MAX_SCALE", 3.5)
    p = _run({"upscale": True}, {}, tmp_path, monkeypatch,
             src=(1280, 704), frame=(3840, 2160))
    assert p["upscale"]["scale"] == pytest.approx(3.07, abs=0.01)
    # …and it is a CEILING, so nothing below it moves.
    p = _run({"upscale": True}, {}, tmp_path, monkeypatch,
             src=(1280, 704), frame=(1920, 1080))
    assert p["upscale"]["scale"] == pytest.approx(1.53, abs=0.02)


def test_the_checkpoint_key_reaches_the_restore(tmp_path, monkeypatch):
    p = _run({"upscale": True}, {"upscale_model": "7b"}, tmp_path, monkeypatch)
    assert p["upscale"]["model"] == "7b"
    # ...and the fit-scale is still computed alongside it, not replaced by it.
    assert p["upscale"]["scale"] == pytest.approx(1.53, abs=0.02)

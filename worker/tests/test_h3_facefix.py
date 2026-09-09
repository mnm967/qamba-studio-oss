"""The H3 face refine — the second face pass, and the opposite shape.

`facefix` inpaints every frame independently through an image model.
`h3_facefix` tracks the face, crops so the head fills a canvas and
re-generates the whole sequence in ONE H3 pass. What is pinned here is the
handful of decisions that are silent when wrong: a graph that renders and
ignores the audio, a mask contract the pack's own node reads, a patched model
that reaches one consumer and not the other, and the two passes running
together.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import graphs  # noqa: E402
import post_chain as pc  # noqa: E402

H3 = {
    "modes": {"i2v": {"checkpoint": "fl2va.safetensors"},
              "r2v": {"checkpoint": "ref2va.safetensors"}},
    "text_encoders": ["qwen3vl.safetensors"],
    "vae": "h3_video_vae.safetensors",
    "audio_vae": "h3_audio_vae.safetensors",
}


def _g(**kw):
    return graphs.h3_facefix_graph(H3, "clip.mp4", **kw)


def _of(g, cls):
    return [n for n in g.values() if n["class_type"] == cls]


def _one(g, cls):
    got = _of(g, cls)
    assert len(got) == 1, f"expected exactly one {cls}, got {len(got)}"
    return got[0]


def _id(g, cls):
    for nid, n in g.items():
        if n["class_type"] == cls:
            return nid
    raise AssertionError(cls)


# ------------------------------------------------------------- the graph ----
def test_the_pipeline_is_wired_end_to_end():
    g = _g()
    # crops -> latent -> sample -> decode -> stitched back over the ORIGINAL
    video = _id(g, "GetVideoComponents")
    track = _id(g, "H3FaceTrackCrop")
    assert _one(g, "H3FaceTrackCrop")["inputs"]["images"] == [video, 0]
    assert _one(g, "H3InjectVideoLatent")["inputs"]["images"] == [track, 0]
    stitch = _one(g, "H3FaceStitch")["inputs"]
    assert stitch["base_images"] == [video, 0], \
        "the composite goes back over the source frames, not over the crops"
    assert stitch["refined_crops"] == [_id(g, "VAEDecode"), 0]
    assert stitch["transform"] == [track, 1]


def test_the_canvas_and_the_frame_count_come_from_the_tracker():
    """H3's `length` is the tracker's own frame count, and the 17n+5 grid is
    the PACK's business — H3 rounds up and H3InjectVideoLatent pads the
    difference. A number computed here would be a second opinion about
    invariant #5."""
    g = _g()
    track = _id(g, "H3FaceTrackCrop")
    ref = _one(g, "MiniMaxH3ReferenceToVideo")["inputs"]
    assert ref["width"] == [track, 4]
    assert ref["height"] == [track, 5]
    assert ref["length"] == [track, 6]


def test_it_loads_fl2va_and_not_the_reference_checkpoint():
    """The r2v NODE is used for the AV latent and the audio ref; with no image
    references staged, ref2va's reference-processing blocks have nothing to
    process."""
    assert _one(_g(), "UNETLoader")["inputs"]["unet_name"] == "fl2va.safetensors"


def test_no_image_references_are_staged():
    g = _g()
    assert not _of(g, "LoadImage")
    ins = _one(g, "MiniMaxH3ReferenceToVideo")["inputs"]
    assert not [k for k in ins if k.startswith("ref_images")]


# -------------------------------------------------------------- the audio ---
def test_the_clips_own_track_is_the_one_audio_reference():
    """It is what the mouth has to match."""
    ins = _one(_g(), "MiniMaxH3ReferenceToVideo")["inputs"]
    assert ins["ref_audios.ref_audio_0"] == [_id(_g(), "GetVideoComponents"), 1]


def test_the_audio_lock_sits_between_the_injection_and_the_per_frame_denoise():
    """`H3PerFrameDenoise` rebuilds the VIDEO half of the noise mask and keeps
    the audio half exactly as it found it — its own comment says so. So the
    lock has to be upstream of it, or there is no audio-side zero to keep."""
    g = _g()
    lock = _one(g, "VRGDG_MiniMaxH3AudioDrive")["inputs"]
    assert lock["av_latent"] == [_id(g, "H3InjectVideoLatent"), 0]
    assert _one(g, "H3PerFrameDenoise")["inputs"]["av_latent"] == \
        [_id(g, "VRGDG_MiniMaxH3AudioDrive"), 0]


def test_a_silent_clip_skips_the_lock_and_still_denoises_per_frame():
    """There is nothing to lip-sync to, and H3PerFrameDenoise falls back to
    zeros for the audio half when the latent carries no mask yet — the same
    result, without a node that would raise on a missing AUDIO input."""
    g = _g(has_audio=False)
    assert not _of(g, "VRGDG_MiniMaxH3AudioDrive")
    assert _one(g, "H3PerFrameDenoise")["inputs"]["av_latent"] == \
        [_id(g, "H3InjectVideoLatent"), 0]
    ins = _one(g, "MiniMaxH3ReferenceToVideo")["inputs"]
    assert not [k for k in ins if k.startswith("ref_audios")]


def test_the_delivered_soundtrack_is_the_sources_own():
    """H3 is asked to attend to the audio so the mouth matches it, not to
    re-render it — `apply_ltx_refine`'s rule, and the reason no audio is
    decoded out of the sampler at all."""
    g = _g()
    assert _one(g, "CreateVideo")["inputs"]["audio"] == [_id(g, "GetVideoComponents"), 1]
    assert not _of(g, "VAEDecodeAudio")


# -------------------------------------------------------------- the model ---
def test_the_per_frame_denoise_patches_the_model_and_both_consumers_read_it():
    """It withholds the video mask from H3's per-token timesteps; without that
    the mask reaches the result twice and prints as a repeating grid at
    latent-cell size — for a UNIFORM mask as much as a varying one, which is
    why the node is not optional even at one strength. Its returned model has
    to reach the guider AND the scheduler, the pairing _splice_h3_refine is
    careful about."""
    g = _g()
    patched = [_id(g, "H3PerFrameDenoise"), 2]
    assert _one(g, "BasicGuider")["inputs"]["model"] == patched
    assert _one(g, "BasicScheduler")["inputs"]["model"] == patched


def test_the_sampler_reads_the_latent_the_per_frame_denoise_returned():
    g = _g()
    assert _one(g, "SamplerCustomAdvanced")["inputs"]["latent_image"] == \
        [_id(g, "H3PerFrameDenoise"), 0]


def test_a_lora_stack_lands_under_the_per_frame_denoise():
    g = _g(loras=[{"key": "x", "name": "adapter.safetensors", "strength": 0.8}])
    lora = _one(g, "LoraLoaderModelOnly")
    assert lora["inputs"]["model"] == ["1", 0]
    assert _one(g, "H3PerFrameDenoise")["inputs"]["model"][0] == _id(g, "LoraLoaderModelOnly")


def test_the_denoise_is_the_schedulers_and_the_default_is_the_packs_own():
    assert graphs.H3_FACE_DENOISE == 0.4
    assert _one(_g(), "BasicScheduler")["inputs"]["denoise"] == 0.4
    assert _one(_g(denoise=0.25), "BasicScheduler")["inputs"]["denoise"] == 0.25


# -------------------------------------------------------------- the canvas --
def test_auto_is_the_packs_own_sizing_and_a_number_is_manual():
    assert _one(_g(), "H3FaceTrackCrop")["inputs"]["canvas_mode"] == "auto_capped_768"
    manual = _one(_g(canvas=512), "H3FaceTrackCrop")["inputs"]
    assert manual["canvas_mode"] == "manual"
    assert (manual["canvas_width"], manual["canvas_height"]) == (512, 512)


def test_a_canvas_key_resolves_and_an_unknown_one_raises():
    """`seedvr2_model`'s rule: a stored pixel count is a setting the browser
    had no business knowing, and a silent fallback is the worst symptom
    available — the render succeeds at a size nobody chose."""
    from handlers.post import h3_face_canvas
    assert h3_face_canvas("auto") is None
    assert h3_face_canvas("768") == 768
    # AN ABSENT ARGUMENT IS THE SHIPPED DEFAULT, NOT `auto`. It read as `auto`
    # for one afternoon, which put every direct caller on the softest-measured
    # arm while the post chain (which sends POST_OPTS) got 768 — two callers of
    # one function rendering differently, silently.
    assert h3_face_canvas(None) == graphs.H3_FACE_CANVASES[graphs.H3_FACE_CANVAS_DEFAULT]
    assert h3_face_canvas("") == h3_face_canvas(None)
    with pytest.raises(RuntimeError, match="unknown H3 face canvas"):
        h3_face_canvas("enormous")


def test_a_missing_checkpoint_or_encoder_raises_rather_than_rendering():
    with pytest.raises(ValueError, match="fl2va"):
        graphs.h3_facefix_graph({**H3, "modes": {}}, "clip.mp4")
    with pytest.raises(ValueError, match="text encoder"):
        graphs.h3_facefix_graph({**H3, "text_encoders": []}, "clip.mp4")


# ------------------------------------------------------------- the chain ----
def test_the_pass_is_a_source_pass_that_drives_comfyui():
    assert pc.POST_STAGE["h3_facefix"] == "source"
    assert "h3_facefix" in pc.GPU_OPS


def test_the_two_face_passes_are_refused_together():
    """Alternatives, not a stack — running both rewrites the same faces twice.
    Refused BEFORE a render, because by the time an applier could notice the
    clip's GPU time is already spent."""
    assert pc.chain_conflict({"facefix": True, "h3_facefix": True})
    assert pc.chain_conflict({"h3_facefix": True, "grain": True}) is None
    assert pc.chain_conflict({"facefix": True}) is None
    assert pc.chain_conflict({}) is None
    assert pc.chain_conflict(None) is None


def test_the_conflict_stops_a_clip_before_the_source_window_is_cut():
    from handlers import render
    with pytest.raises(RuntimeError, match="pick one"):
        render.render_clip_with_post(
            "in.mp4", "out.mp4", {"in_ms": 0, "out_ms": 1000},
            width=1280, height=704, fps=24,
            chain={"facefix": True, "h3_facefix": True})


def test_windows_are_capped_by_h3s_frame_ceiling_not_the_pixel_budget():
    """At a 768 canvas the restore's 420M px-frame budget would allow ~712
    frames and H3's legal maximum is 365, so the frame count is what binds."""
    import h3_timing
    from handlers.post import plan_windows
    px = 768 * 768
    assert plan_windows(300, px, budget=h3_timing.MAX_FRAMES * px) == []
    plan = plan_windows(500, px, budget=h3_timing.MAX_FRAMES * px)
    assert len(plan) == 2 and plan[0][0] == 0 and plan[-1][1] is None
    # ... and the restore's own budget would NOT have split it, which is the
    # whole reason this pass passes a budget of its own.
    assert plan_windows(500, px) == []

# ------------------------------------------------- the node signatures ------
# Verbatim from the pack's own INPUT_TYPES (Carasibana/ComfyUI-H3-FaceRefine).
# `_fit_node_inputs` fills a missing REQUIRED key from its declared default —
# but only when a spec is present, and `_node_spec` returns None whenever
# ComfyUI is unreachable. So the builder has to supply every required input by
# itself or the graph fails validation at submit on exactly the runs where
# nothing could tell it what was missing.
PACK_REQUIRED = {
    "H3FaceTrackCrop": ["images", "detector", "confidence", "crop_factor",
                        "canvas_width", "canvas_height", "canvas_mode",
                        "smooth_window", "size_smooth_window", "smooth_method",
                        "size_mode"],
    "H3InjectVideoLatent": ["av_latent", "images", "vae"],
    "H3PerFrameDenoise": ["model", "av_latent", "transform",
                          "denoise_multiplier_small_face",
                          "denoise_multiplier_large_face", "scale_mode",
                          "face_px_small", "face_px_large", "gamma",
                          "smooth_frames"],
    "H3FaceStitch": ["base_images", "refined_crops", "transform",
                     "paste_region", "mask_dilation", "feather", "colour_match",
                     "blend", "undetected_frames"],
}


@pytest.mark.parametrize("cls,required", sorted(PACK_REQUIRED.items()))
def test_every_required_input_of_the_packs_nodes_is_supplied(cls, required):
    got = set(_one(_g(), cls)["inputs"])
    assert not set(required) - got, f"{cls} missing {sorted(set(required) - got)}"


def test_the_audio_reference_key_is_the_nodes_own_prefix():
    """`ref_audios.ref_audio_0`, and a wrong prefix is a key ComfyUI DROPS
    rather than rejects — the audio reference silently absent, i.e. a face
    refined against nothing to lip-sync to.

    The published inventory the worker can read offline TRIMS the autogrow
    template away (engine_manifest.trim keeps the type and not the options),
    so the DEFAULT has to be right too — it is what `_autogrow_key` falls back
    to whenever the live spec cannot be reached.
    """
    spec = {"input": {"optional": {"ref_audios": [
        "COMFY_AUTOGROW_V3", {"template": {"prefix": "ref_audio_", "max": 3}}]}}}
    for s in (spec, None, {"input": {"optional": {"ref_audios": ["COMFY_AUTOGROW_V3", {}]}}}):
        ins = _one(_g(ref_spec=s), "MiniMaxH3ReferenceToVideo")["inputs"]
        assert "ref_audios.ref_audio_0" in ins

# ------------------------------------------------------------- hard cuts ----
def test_the_cut_mode_is_the_packs_own_enum_string():
    """`auto (pyscenedetect)`, spaces and parentheses included. A combo value
    the node does not declare is a validation failure at submit — minutes into
    a job on this path — so the short key never reaches the graph."""
    assert graphs.H3_FACE_CUT_MODES["auto"] == "auto (pyscenedetect)"
    ins = _one(_g(cut_detection="auto"), "H3FaceTrackCrop")["inputs"]
    assert ins["cut_detection"] == "auto (pyscenedetect)"
    assert _one(_g(), "H3FaceTrackCrop")["inputs"]["cut_detection"] == "none"


def test_a_raw_enum_value_passes_through_unmapped():
    """So a mode the pack adds later needs no change here."""
    ins = _one(_g(cut_detection="something (new)"), "H3FaceTrackCrop")["inputs"]
    assert ins["cut_detection"] == "something (new)"


def test_an_unknown_cut_mode_raises_rather_than_rendering_without_it():
    """`h3_face_canvas`'s rule: a silent fallback is the worst outcome, because
    the render succeeds and only the smoothing is wrong."""
    import handlers.post as hp
    with pytest.raises(RuntimeError, match="unknown cut detection"):
        hp.apply_h3_facefix({"id": "x"}, "in.mp4", "out.mp4", cuts="sometimes")

"""LTX 2.5 — the second native-audio family, and the first whose official
pipeline is TWO-PASS (base at half resolution, latent 2x upsample, 4-sigma
refine). These pin the parts that are easy to break silently:

* the base-pass latent gets SCALED dims (`latent_scale`) while every other
  family's latents keep full size — clobbering the half-res latent with full
  dims makes the upsampler double past the target, and nothing errors;
* the frame count converts onto the 8n+1 grid at 24fps, not H3's 17n+5;
* the MSR r2v wiring puts the same references on BOTH guide nodes and knows
  that pic slots are POSITIONAL (learned slot embeddings), unlike H3's flat
  autogrow list;
* the distilled ManualSigmas schedules are never touched by the `steps` knob.
"""
import json
import os

import pytest

os.environ.setdefault("MODEL_TIER", "full")
os.environ.setdefault("WORKFLOWS_DIR", os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "workflows"))

import resolve as R

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def mm(monkeypatch):
    with open(os.path.join(ROOT, "infra", "model_map.full.json")) as f:
        full = json.load(f)
    monkeypatch.setattr(R, "ensure_model", lambda model, mm=None: full["full"]["models"][model])
    monkeypatch.setattr(R, "TIER", "full")
    return full


def _t2v(mm, **kw):
    kw.setdefault("width", 1280)
    kw.setdefault("height", 704)
    return R.resolve("ltx-25", "t2v", positive="a quiet street", negative="",
                     seed=7, length=81, mm=mm, **kw)


def _r2v(mm, refs, **kw):
    kw.setdefault("width", 1280)
    kw.setdefault("height", 704)
    return R.resolve("ltx-25", "r2v", positive="a quiet street", negative="",
                     seed=7, length=81, ref_images=refs, mm=mm, **kw)


def _nodes(g, ct):
    return [(nid, n) for nid, n in g.items() if n.get("class_type") == ct]


def test_base_pass_latent_is_half_size_and_the_length_is_full(mm):
    g = _t2v(mm, exact_frames=121)["graph"]
    (nid, lat), = _nodes(g, "EmptyLTXVLatentVideo")
    assert (lat["inputs"]["width"], lat["inputs"]["height"]) == (640, 352)
    assert lat["inputs"]["length"] == 121
    # the audio latent counts the SAME frames — it is never spatially scaled
    (_, aud), = _nodes(g, "LTXVEmptyLatentAudio")
    assert aud["inputs"]["frames_number"] == 121
    assert aud["inputs"]["frame_rate"] == 24


def test_half_res_snaps_to_32_whatever_the_request_was(mm):
    # dim_step 64 snaps the request so 2x(half) lands back on it exactly, and
    # the half-res base latent must stay on the /32 grid the VAE needs — pin
    # both off one awkward input.
    g = R.resolve("ltx-25", "t2v", positive="x", negative="", seed=1,
                  width=1200, height=672, length=49, exact_frames=49,
                  mm=mm)["graph"]
    (_, lat), = _nodes(g, "EmptyLTXVLatentVideo")
    assert lat["inputs"]["width"] % 32 == 0
    assert lat["inputs"]["height"] % 32 == 0


def test_other_families_latents_keep_full_dims(mm):
    g = R.resolve("minimax-h3", "t2v", positive="x", negative="", seed=1,
                  width=832, height=480, length=53, exact_frames=53,
                  mm=mm)["graph"]
    lats = [n for _, n in g.items()
            if n.get("class_type") in R.LATENT_CLASSES and "width" in n.get("inputs", {})]
    assert lats and all(n["inputs"]["width"] == 832 for n in lats)


def test_frames_convert_onto_the_8n_plus_1_grid(mm):
    # app length 81 Wan frames = 5s at 16fps -> 120 frames at 24fps -> 121
    g = _t2v(mm)["graph"]
    (_, lat), = _nodes(g, "EmptyLTXVLatentVideo")
    assert lat["inputs"]["length"] % 8 == 1


def test_loaders_are_rewritten_from_model_map(mm):
    g = _t2v(mm, exact_frames=121)["graph"]
    (_, unet), = _nodes(g, "UNETLoader")
    assert unet["inputs"]["unet_name"] == \
        "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"
    (_, up), = _nodes(g, "LatentUpscaleModelLoader")
    assert up["inputs"]["model_name"] == \
        "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"
    vaes = {n["inputs"]["vae_name"] for _, n in _nodes(g, "VAELoader")}
    assert vaes == {"ltx-2.5-video-vae-conv-bf16.safetensors",
                    "ltx-2.5-audio-vae-bf16.safetensors"}
    (_, clip), = _nodes(g, "CLIPLoader")
    assert clip["inputs"]["clip_name"] == \
        "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
    assert clip["inputs"]["type"] == "ltxv"


def test_the_distilled_sigma_schedules_are_not_a_steps_knob(mm):
    """ManualSigmas IS the distillation recipe; a caller's steps= must not
    rewrite it the way BasicScheduler entries take one."""
    g = _t2v(mm, exact_frames=121, steps=30)["graph"]
    sig = sorted(n["inputs"]["sigmas"] for _, n in _nodes(g, "ManualSigmas"))
    assert sig == ["0.85, 0.7250, 0.4219, 0.0",
                   "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"]


def test_prompt_lands_on_the_positive_encode_only(mm):
    g = _t2v(mm, exact_frames=121)["graph"]
    texts = sorted(n["inputs"]["text"] for _, n in _nodes(g, "CLIPTextEncode"))
    assert texts == ["", "a quiet street"]  # negative="" replaced the placeholder


def test_r2v_wires_the_same_refs_onto_both_guides_positionally(mm):
    g = _r2v(mm, ["face1.png", "face2.png"], exact_frames=121)["graph"]
    guides = _nodes(g, "ComfyUILTX25MSRMultiReferenceGuide")
    assert len(guides) == 2
    loads = {nid: n["inputs"]["image"] for nid, n in _nodes(g, "LoadImage")}
    for _, gd in guides:
        assert loads[gd["inputs"]["pic1"][0]] == "face1.png"
        assert loads[gd["inputs"]["pic2"][0]] == "face2.png"
        assert "pic3" not in gd["inputs"] and "background" not in gd["inputs"]
    # one LoadImage per distinct file, shared by both guides — not one per slot
    assert len(loads) == 2


def test_r2v_fifth_reference_becomes_the_background_slot(mm):
    g = _r2v(mm, ["a.png", "b.png", "c.png", "d.png", "plate.png"],
             exact_frames=121)["graph"]
    for _, gd in _nodes(g, "ComfyUILTX25MSRMultiReferenceGuide"):
        loads = {nid: n["inputs"]["image"] for nid, n in _nodes(g, "LoadImage")}
        assert loads[gd["inputs"]["background"][0]] == "plate.png"
        assert loads[gd["inputs"]["pic4"][0]] == "d.png"


def test_r2v_with_no_refs_refuses(mm):
    with pytest.raises(R.ResolveError):
        _r2v(mm, [], exact_frames=121)


def test_r2v_msr_lora_comes_from_model_map(mm):
    g = _r2v(mm, ["a.png"], exact_frames=121)["graph"]
    (_, lo), = _nodes(g, "ComfyUILTX25MSRICLoRALoader")
    assert lo["inputs"]["lora_name"] == "LTX-2.5-Licon-MSR-V1.safetensors"


def test_r2v_msr_lora_missing_from_map_raises(mm):
    mm["full"]["models"]["ltx-25"] = {
        **mm["full"]["models"]["ltx-25"]}
    mm["full"]["models"]["ltx-25"].pop("msr_lora")
    with pytest.raises(R.ResolveError, match="msr_lora"):
        _r2v(mm, ["a.png"], exact_frames=121)


def test_both_templates_have_a_save_node_and_audio_decode(mm):
    for build in (_t2v(mm, exact_frames=121), _r2v(mm, ["a.png"], exact_frames=121)):
        g = build["graph"]
        assert build["outputs"]
        assert _nodes(g, "LTXVAudioVAEDecode"), "native audio must decode"
        (_, cv), = _nodes(g, "CreateVideo")
        assert "audio" in cv["inputs"], "CreateVideo must mux the audio"


# ------------------------------------------------- the free-standing path ----
# `handle_clip_gen` computed its length with h3_timing.pad17 and passed it as
# `exact_frames`, which resolve() is documented to TRUST — so LTX 2.5 was
# enabled in the catalog and could not legally render one clip from the
# "make me this clip" path. 17n+5 is not 8n+1.


def test_frame_count_follows_the_models_own_grid(mm):
    for ms in (1000, 2500, 5000, 6592, 10000):
        n = R.frame_count("ltx-25", ms, mm)
        assert n % 8 == 1, f"{ms}ms -> {n} is off LTX's 8n+1 grid"
        assert n >= 1
        h3 = R.frame_count("minimax-h3", ms, mm)
        assert (h3 - 5) % 17 == 0, f"{ms}ms -> {h3} is off H3's 17n+5 grid"


def test_frame_count_rounds_up_like_pad17(mm):
    """Render long, trim exact — never deliver less than was asked for."""
    # 6592ms at 24fps is 158.2 frames; the next legal LTX count is >= 159
    n = R.frame_count("ltx-25", 6592, mm)
    assert n >= 159 and n % 8 == 1


def test_clip_gen_picks_the_grid_off_the_model_and_passes_a_background():
    """Source-parsed: the handler is a long function with live ComfyUI calls,
    and both of these are silent when wrong — an off-grid length fails deep in
    the sampler, and a missed background puts the location plate in a SUBJECT
    slot wearing a subject's learned embedding."""
    import pathlib
    import handlers.blocks as B
    src = pathlib.Path(B.__file__).read_text()
    body = src.split("def handle_clip_gen(")[1].split("\ndef ")[0]
    assert 'R.frame_count(model_key, want_ms)' in body
    assert '"h3" in model_key.lower()' in body
    assert 'ref_background_index' in body
    assert 'img_kwargs["ref_background"]' in body


def test_msr_reference_frames_stays_a_value_the_pack_accepts():
    """`reference_frames` is a COMBO of exactly "25" and "33" in
    liconstudio/ComfyUI-LTX2.5-MSR, which raises on anything else — and it is
    PER REFERENCE (`image.repeat(reference_frames, 1, 1, 1)`), not a budget
    shared between them.

    This exists because vrgamedevgirl's LTX 2.3 builder carries a tempting
    auto rule — 17/25/33/41 frames for 1/2/3/4+ subjects — and porting it here
    is wrong twice over: 17 and 41 are illegal values, and that rule scales a
    TOTAL frame batch so each packed image keeps its share, which a constant
    per-image 33 already does. Her own 2.5 loader has no strength control and
    her 2.5 workflow pins "33", same as ours.
    """
    import json
    import os
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    g = json.load(open(os.path.join(root, "workflows", "ltx25_r2v.json")))
    guides = [n for n in g.values()
              if isinstance(n, dict)
              and n.get("class_type") == "ComfyUILTX25MSRMultiReferenceGuide"]
    assert len(guides) == 2, "one guide per pass"
    for n in guides:
        assert str(n["inputs"]["reference_frames"]) in ("25", "33")

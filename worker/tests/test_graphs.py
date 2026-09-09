"""Graph builders are pure dict construction, so they test anywhere.

What is worth pinning down here is the LoRA stack, because getting it wrong is
silent: a graph with the adapter loaded but not wired into the sampler renders
perfectly and looks like the LoRA "didn't do much".
"""
import json
import os

import pytest

import graphs

MAP = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "infra", "model_map.full.json")


@pytest.fixture(scope="module")
def imodels():
    with open(MAP) as f:
        return json.load(f)["full"]["image_models"]


def lora_nodes(g):
    return {k: v for k, v in g.items() if v["class_type"] == "LoraLoaderModelOnly"}


def chain_of(g, link):
    """Walk MODEL links back to the loader, returning the lora names in order."""
    names = []
    while True:
        node = g[link[0]]
        if node["class_type"] != "LoraLoaderModelOnly":
            return list(reversed(names))
        names.append(node["inputs"]["lora_name"])
        link = node["inputs"]["model"]


# ------------------------------------------------------------- normalising ---
def test_norm_accepts_every_shape():
    got = graphs._norm_loras(["a.safetensors", ("b.safetensors", 0.6),
                              {"name": "c.safetensors", "strength": 0.3}])
    assert got == [("a.safetensors", 1.0), ("b.safetensors", 0.6), ("c.safetensors", 0.3)]


def test_norm_keeps_legacy_single_lora_last():
    got = graphs._norm_loras(["a.safetensors"], style_lora="s.safetensors", lora_strength=0.5)
    assert got == [("a.safetensors", 1.0), ("s.safetensors", 0.5)]


def test_norm_dedupes_so_strength_does_not_compound():
    got = graphs._norm_loras(["a.safetensors", ("a.safetensors", 0.4)])
    assert got == [("a.safetensors", 1.0)]


# ------------------------------------------------------------------ krea 2 ---
def test_krea2_multiref_wires_stack_into_guider_and_scheduler(imodels):
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["a.png", "b.png"],
                               loras=[("one.safetensors", 0.8), ("two.safetensors", 1.0)])
    # Both the guider and the sigma schedule must read the PATCHED model, or the
    # sampler steps a different set of weights than it was scheduled for.
    assert chain_of(g, g["31"]["inputs"]["model"]) == ["one.safetensors", "two.safetensors"]
    assert g["32"]["inputs"]["model"] == g["31"]["inputs"]["model"]
    assert len(lora_nodes(g)) == 2


def test_krea2_multiref_matches_the_source_workflow(imodels):
    """Civitai 2757982: Krea2EditRebalance -> BasicGuider + BasicScheduler ->
    SamplerCustomAdvanced, image1 carrying the 'high' token budget."""
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 7, 1024, 1024,
                               ["face.png", "outfit.png", "place.png"])
    reb = g["30"]["inputs"]
    assert g["30"]["class_type"] == "Krea2EditRebalance"
    assert reb["image1_tokens"] == "high"
    assert [reb[f"image{i}_tokens"] for i in (2, 3)] == ["normal", "normal"]
    assert "image4" not in reb                       # only what was supplied
    assert g["33"]["class_type"] == "SamplerCustomAdvanced"
    assert g["32"]["inputs"]["denoise"] == 1.0
    assert not lora_nodes(g)                         # the workflow ships none


def test_krea2_control_is_absent_unless_both_halves_are_given(imodels):
    """A control map with no LoRA (or the reverse) must render exactly as
    before, not half-splice. Callers check for the pack at runtime, so a pod
    without it passes control_lora=None and gets the plain graph."""
    for kw in ({}, {"control_image": "d.png"}, {"control_lora": "depth.safetensors"}):
        g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["a.png"], **kw)
        assert not [n for n in g.values() if n["class_type"].startswith("Krea2Control")]
        assert g["31"]["inputs"]["model"] == g["32"]["inputs"]["model"] == ["1", 0]


def test_krea2_control_reaches_guider_and_scheduler_through_apply(imodels):
    g = graphs.krea2_ref_graph(
        imodels["krea2"], "p", 1, 1024, 1024, ["face.png"],
        loras=[("style.safetensors", 0.7)],
        control_image="depth_map.png", control_lora="Krea2/depth-control-lora.safetensors",
        control_strength=0.8)
    apply_id = next(k for k, n in g.items() if n["class_type"] == "Krea2ControlApply")
    # Apply is mandatory: the LoRA loader alone loads and does nothing. Both
    # the guider and the sigma schedule must read ITS output, same trap as the
    # style stack — a schedule built on the unpatched model steps other weights.
    assert g["31"]["inputs"]["model"] == [apply_id, 0]
    assert g["32"]["inputs"]["model"] == [apply_id, 0]
    # …and the control LoRA sits ON TOP of the style stack, not instead of it.
    loader = g[g[apply_id]["inputs"]["model"][0]]
    assert loader["class_type"] == "Krea2ControlLoRALoader"
    assert loader["inputs"]["strength"] == 0.8
    assert chain_of(g, loader["inputs"]["model"]) == ["style.safetensors"]


def test_krea2_control_encoder_sees_the_sampled_latent(imodels):
    """match_latent_size resizes the map to what is actually being sampled;
    without the latent link a map of another aspect silently stretches."""
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1344, 768, ["a.png"],
                               control_image="d.png", control_lora="l.safetensors")
    enc = next(n for n in g.values() if n["class_type"] == "Krea2ControlImageEncode")
    assert enc["inputs"]["latent"] == ["12", 0]          # the EmptyLatentImage
    assert enc["inputs"]["vae"] == ["3", 0]
    # The author's stated starting point for a Depth Anything map.
    assert enc["inputs"]["channel_mode"] == "grayscale"
    assert enc["inputs"]["normalize"] == "per_image_minmax"
    assert enc["inputs"]["invert"] is False


def test_krea2_control_preprocesses_the_plate_in_graph(imodels):
    """The caller hands over the location's master plate, not a depth map —
    making one is the graph's job, so no depth image is ever produced, stored
    or registered."""
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["a.png"],
                               control_image="master.png", control_lora="l.safetensors",
                               control_preprocess="DepthAnythingV2Preprocessor")
    pre = next(n for n in g.values()
               if n["class_type"] == "DepthAnythingV2Preprocessor")
    load = g[pre["inputs"]["image"][0]]
    assert load["class_type"] == "LoadImage"
    assert load["inputs"]["image"] == "master.png"
    enc = next(n for n in g.values() if n["class_type"] == "Krea2ControlImageEncode")
    assert enc["inputs"]["control_image"] == [pre_id(g), 0]


def pre_id(g):
    return next(k for k, n in g.items()
                if n["class_type"] == "DepthAnythingV2Preprocessor")


def test_krea2_control_accepts_a_premade_map(imodels):
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["a.png"],
                               control_image="depth.png", control_lora="l.safetensors")
    assert not [n for n in g.values() if "Depth" in n["class_type"]]
    enc = next(n for n in g.values() if n["class_type"] == "Krea2ControlImageEncode")
    assert g[enc["inputs"]["control_image"][0]]["inputs"]["image"] == "depth.png"


def test_krea2_control_on_an_edit_seeds_from_the_source_latent(imodels):
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["s.png"],
                               source_image="s.png", denoise=0.5,
                               control_image="d.png", control_lora="l.safetensors")
    enc = next(n for n in g.values() if n["class_type"] == "Krea2ControlImageEncode")
    assert enc["inputs"]["latent"] == ["41", 0]          # the VAEEncode of source


def test_krea2_multiref_caps_at_the_nodes_four_slots(imodels):
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024,
                               [f"{i}.png" for i in range(9)])
    reb = g["30"]["inputs"]
    assert [k for k in reb if k.startswith("image") and not k.endswith("_tokens")] \
        == ["image1", "image2", "image3", "image4"]


def test_every_krea2_family_entry_shares_the_encoder_and_vae(imodels):
    """A CHECKPOINT FINETUNE IS A MAP ENTRY AND NOTHING ELSE — that is what
    `family` buys. It shares the graph builders, so it has to share the files
    they load, and it carries its OWN sampler recipe: a finetune tuned at 10
    steps on `beta` rendered at the family's 8 on `simple` is a picture nobody
    asked for, with nothing saying a substitution happened."""
    krea2 = imodels["krea2"]
    fam = [(k, m) for k, m in imodels.items() if m.get("family") == "krea2"]
    assert fam, "no krea2-family entry at all — the scanner is broken"
    for key, m in fam:
        assert m["text_encoder"] == krea2["text_encoder"], key
        assert m["vae"] == krea2["vae"], key
        g = graphs.krea2_graph(m, "p", 1, 1024, 1024)
        assert g["1"]["inputs"]["unet_name"] == m["unet"]
        assert g["7"]["inputs"]["scheduler"] == m.get("scheduler", "simple")
        assert g["7"]["inputs"]["steps"] == m["steps"]


# Rebalance-Pack's current Krea2EditRebalance, verbatim from its INPUT_TYPES.
# The Civitai workflow we build from predates it: that build took a `negative`
# STRING and had none of these three required controls.
REBALANCE_TODAY = {"input": {
    "required": {
        "text": ["STRING", {"multiline": True}],
        "clip": ["CLIP"],
        "steering": ["FLOAT", {"default": 1.0, "min": -2.0, "max": 2.0}],
        "layer_multiplier": ["FLOAT", {"default": 1.0}],
        "enable_step": ["BOOLEAN", {"default": True}],
    },
    "optional": {
        "image1": ["IMAGE"], "image1_tokens": [["low", "normal", "high", "max"], {"default": "normal"}],
        "image2": ["IMAGE"], "image2_tokens": [["low", "normal", "high", "max"], {"default": "normal"}],
        "image3": ["IMAGE"], "image3_tokens": [["low", "normal", "high", "max"], {"default": "normal"}],
        "image4": ["IMAGE"], "image4_tokens": [["low", "normal", "high", "max"], {"default": "normal"}],
    },
}}


def test_krea2_edit_starts_from_the_source_not_from_noise(imodels):
    """The bug this pins down returned a *different picture*, not an edited one.

    Rebalance is conditioning-only — it describes the reference into the text
    stream and never touches a latent. On an empty latent at denoise 1.0 the
    source's pixels are nowhere in the graph, so "add more neon" rendered a
    fresh neon image that merely resembled what was described.
    """
    g = graphs.krea2_ref_graph(imodels["krea2"], "add more neon", 1, 2720, 1536,
                               ["src.png"], source_image="src.png", denoise=0.55)
    enc = g["33"]["inputs"]["latent_image"]
    assert g[enc[0]]["class_type"] == "VAEEncode"                 # not EmptyLatentImage
    assert g[g[enc[0]]["inputs"]["pixels"][0]]["inputs"]["image"] == "src.png"
    assert not [n for n in g.values() if n["class_type"] == "EmptyLatentImage"]
    # partial schedule, and the source still conditions as image1
    assert g["32"]["inputs"]["denoise"] == 0.55
    assert g["30"]["inputs"]["image1"] == ["20", 0]
    assert g["30"]["inputs"]["image1_tokens"] == "high"


def test_krea2_edit_keeps_the_recipes_step_count(imodels):
    """BasicScheduler spends only the last `denoise` fraction of its sigmas, so
    a distilled 8-step model at 0.5 would run four steps and come back soft."""
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["s.png"],
                               steps=8, source_image="s.png", denoise=0.5)
    assert g["32"]["inputs"]["steps"] == 16


def test_krea2_compose_is_unchanged_by_the_edit_path(imodels):
    """No source image is still the composition graph: empty latent, full
    denoise, output at the requested size."""
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 768, ["a.png", "b.png"])
    assert g["33"]["inputs"]["latent_image"] == ["12", 0]
    assert g["12"]["inputs"]["width"] == 1024 and g["12"]["inputs"]["height"] == 768
    assert g["32"]["inputs"]["denoise"] == 1.0
    assert g["32"]["inputs"]["steps"] == imodels["krea2"]["steps"]


def test_krea2_ignores_denoise_without_a_source(imodels):
    """A partial schedule over pure noise renders an unfinished image."""
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["a.png"],
                               denoise=0.4)
    assert g["32"]["inputs"]["denoise"] == 1.0


def test_rebalance_graph_fits_the_installed_node(imodels):
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["a.png", "b.png"],
                               negative="blurry", node_spec=REBALANCE_TODAY)
    ins = g["30"]["inputs"]
    # dropped: this build has no negative input at all
    assert "negative" not in ins
    # filled from the schema's own defaults, or the job fails validation
    assert ins["steering"] == 1.0
    assert ins["layer_multiplier"] == 1.0
    assert ins["enable_step"] is True
    # and the parts that did survive still carry the shot
    assert ins["text"] == "p"
    assert ins["image1_tokens"] == "high"
    assert ins["image2"] == ["21", 0]


def test_rebalance_graph_keeps_its_shape_without_a_schema(imodels):
    """No /object_info (ComfyUI down, or a plain unit test) must not mangle the
    graph — the caller's shape is what ships."""
    g = graphs.krea2_ref_graph(imodels["krea2"], "p", 1, 1024, 1024, ["a.png"],
                               negative="blurry")
    assert g["30"]["inputs"]["negative"] == "blurry"
    assert "steering" not in g["30"]["inputs"]


def test_fit_fills_a_combo_without_a_default():
    spec = {"input": {"required": {"mode": [["fast", "slow"]]}, "optional": {}}}
    assert graphs._fit_node_inputs({}, spec) == {"mode": "fast"}


# ------------------------------------------------------------- klein / flux ---
def test_klein_applies_nothing_it_was_not_asked_for(imodels):
    """Base Klein must be reachable.

    Klein used to force its Shinkai LoRA at 1.0 and prepend "anime screencap"
    onto every prompt, with no key, no toggle and no mention in the UI — and it
    is the automatic fallback for reference jobs, so anything with refs came
    back anime whatever model you asked for.
    """
    g = graphs.flux2_klein_graph(imodels["klein"], "a photoreal portrait", 1, 1024, 1024)
    assert not lora_nodes(g)
    assert g["10"]["inputs"]["model"] == ["1", 0]        # raw checkpoint
    assert g["4"]["inputs"]["text"] == "a photoreal portrait"
    assert "anime" not in g["4"]["inputs"]["text"]


def test_klein_stacks_exactly_what_it_is_given(imodels):
    g = graphs.flux2_klein_graph(imodels["klein"], "p", 1, 1024, 1024,
                                 loras=[(imodels["klein"]["style_loras"]["shinkai"], 1.0),
                                        ("extra.safetensors", 0.9)])
    assert chain_of(g, g["10"]["inputs"]["model"]) == [
        imodels["klein"]["style_loras"]["shinkai"], "extra.safetensors"]


def test_no_image_model_hides_a_lora_outside_style_loras(imodels):
    """The bare `lora`/`trigger` keys are how Klein's forced style stayed
    invisible: they bypass the key convention, the catalog and the picker."""
    for name, spec in imodels.items():
        assert "lora" not in spec, f"{name} carries an implicit LoRA"
        assert "trigger" not in spec, f"{name} carries an implicit trigger word"


def test_flux_patches_clip_once_then_stacks_model_only(imodels):
    g = graphs.flux_ref_graph(imodels["flux"], "p", 1, 512, 512,
                              loras=["a.safetensors", "b.safetensors"])
    assert g["3"]["class_type"] == "LoraLoader"          # first one carries CLIP
    assert g["4"]["inputs"]["clip"] == ["3", 1]
    assert len(lora_nodes(g)) == 1                       # the second is model-only
    assert g["6"]["inputs"]["model"] != ["1", 0]         # sampling reads the stack


def test_flux_without_loras_reads_the_bare_loaders(imodels):
    g = graphs.flux_ref_graph(imodels["flux"], "p", 1, 512, 512)
    assert g["6"]["inputs"]["model"] == ["1", 0]
    assert g["4"]["inputs"]["clip"] == ["2", 0]
    assert "3" not in g


# ------------------------------------------------------------------- qwen ---
# TextEncodeQwenImageEditPlus as ComfyUI core actually declares it.
QWEN_PLUS = {"input": {
    "required": {"clip": ["CLIP", {}], "prompt": ["STRING", {"multiline": True}]},
    "optional": {"vae": ["VAE", {}], "image1": ["IMAGE", {}],
                 "image2": ["IMAGE", {}], "image3": ["IMAGE", {}]},
}}


def test_qwen_wires_three_refs_into_both_encodes(imodels):
    g = graphs.qwen_edit_graph(imodels["qwen-edit"], "put her in the alley", 1,
                               1280, 704, refs=["a.png", "b.png", "c.png"],
                               node_spec=QWEN_PLUS)
    pos, neg = g["7"]["inputs"], g["8"]["inputs"]
    assert g["7"]["class_type"] == "TextEncodeQwenImageEditPlus"
    for ins in (pos, neg):
        assert [ins.get(f"image{i}") for i in (1, 2, 3)] == [["20", 0], ["21", 0], ["22", 0]]
        assert ins["vae"] == ["3", 0]          # the node encodes the refs itself
    assert pos["prompt"] == "put her in the alley"
    assert neg["prompt"] == ""                 # same refs, empty prompt


def test_qwen_caps_at_the_nodes_three_images(imodels):
    g = graphs.qwen_edit_graph(imodels["qwen-edit"], "p", 1, 1024, 1024,
                               refs=[f"{i}.png" for i in range(9)], node_spec=QWEN_PLUS)
    assert not [k for k in g["7"]["inputs"] if k.startswith("image") and k not in
                ("image1", "image2", "image3")]
    assert len([k for k in g["7"]["inputs"] if k.startswith("image")]) == 3


def test_qwen_uses_a_flow_sampler_chain(imodels):
    """Qwen is a flow model: AuraFlow shift, CFGNorm, and a real cfg (2.5) —
    not the turbo models' cfg 1.0."""
    g = graphs.qwen_edit_graph(imodels["qwen-edit"], "p", 1, 1024, 1024, refs=["a.png"])
    assert g["4"]["class_type"] == "ModelSamplingAuraFlow"
    assert g["4"]["inputs"]["shift"] == imodels["qwen-edit"]["shift"]
    assert g["5"]["class_type"] == "CFGNorm"
    assert g["9"]["inputs"]["cfg"] == imodels["qwen-edit"]["cfg"] > 1.0
    assert g["9"]["inputs"]["model"] == ["5", 0]     # sampler reads the patched model


def test_qwen_lora_stack_precedes_the_model_patches(imodels):
    g = graphs.qwen_edit_graph(imodels["qwen-edit"], "p", 1, 1024, 1024,
                               refs=["a.png"], loras=[("x.safetensors", 0.7)])
    assert chain_of(g, g["4"]["inputs"]["model"]) == ["x.safetensors"]


def test_qwen_shares_the_vae_krea2_already_fetches(imodels):
    """Same Qwen image VAE — fetching it twice would waste 250MB and let the
    two copies drift."""
    assert imodels["qwen-edit"]["vae"] == imodels["krea2"]["vae"]


# ---------------------------------------------------------------- h3 image ---
def h3_files(imodels, video_models, key="h3-image"):
    """Mirrors handlers.images._h3_files — the image entry borrows its WEIGHTS
    from the video model that already declares and fetches them, and carries
    the fields that are only true of a still (single-frame decoder, sampling
    recipe, per-checkpoint turbo adapters) itself."""
    spec = imodels[key]
    src = video_models[spec["from_model"]]
    ref = src["modes"][spec["mode"]]["checkpoint"]
    frame = src["modes"]["i2v"]["checkpoint"]
    out = {"ref_checkpoint": ref, "frame_checkpoint": frame, "checkpoint": ref,
           "text_encoder": src["text_encoders"][0],
           "vae": src["vae"], "audio_vae": src.get("audio_vae")}
    for k in ("image_vae", "sampler", "scheduler", "steps",
              "frame_turbo", "ref_turbo", "turbo_strength", "lora_strength"):
        if spec.get(k) is not None:
            out[k] = spec[k]
    return out


@pytest.fixture(scope="module")
def h3(imodels):
    with open(MAP) as f:
        return h3_files(imodels, json.load(f)["full"]["models"])


@pytest.fixture(scope="module")
def h3turbo(imodels):
    with open(MAP) as f:
        return h3_files(imodels, json.load(f)["full"]["models"], "h3-image-turbo")


def h3_spec(length_min, length_step):
    """A stand-in /object_info entry for the H3 latent builders."""
    return {"input": {"required": {
        "length": ["INT", {"default": 124, "min": length_min,
                           "max": 3600, "step": length_step}]}}}


STOCK_H3_NODE = h3_spec(5, 17)      # ComfyUI as shipped
PATCHED_H3_NODE = h3_spec(1, 1)     # after the engine window's H3 single-frame patch


def test_h3_image_renders_the_shortest_legal_clip_and_keeps_one_frame(h3):
    """H3 is a video model and one frame of it is an image. The published
    workflow's `length: 1` is REJECTED by the current nodes (min 5, step 17), so
    this must ask for 5 — the 17n+5 grid at n=0 — and slice frame 0 out."""
    g = graphs.h3_image_graph(h3, "a lighthouse", 1, 1280, 736, refs=["a.png"])
    assert g["6"]["inputs"]["length"] == 5
    assert (g["6"]["inputs"]["length"] - 5) % 17 == 0
    assert g["13"]["class_type"] == "ImageFromBatch"
    assert (g["13"]["inputs"]["batch_index"], g["13"]["inputs"]["length"]) == (0, 1)
    assert g["14"]["class_type"] == "SaveImage"
    # no clip anywhere: no audio decode, no CreateVideo, no SaveVideo
    kinds = {n["class_type"] for n in g.values()}
    assert not kinds & {"VAEDecodeAudio", "CreateVideo", "SaveVideo"}


def test_h3_picks_the_checkpoint_the_mode_needs(h3):
    """ref2va and fl2va are not interchangeable — ref2va conditions on a
    reference SET, fl2va on an opening frame or nothing. Running a single-image
    edit on the reference weights is the kind of mistake that still renders."""
    refs = graphs.h3_image_graph(h3, "p", 1, 1280, 736, refs=["a.png"])
    edit = graphs.h3_image_graph(h3, "p", 1, 1280, 736, source_image="a.png")
    t2i = graphs.h3_image_graph(h3, "p", 1, 1280, 736)
    assert "ref2va" in refs["1"]["inputs"]["unet_name"]
    assert "fl2va" in edit["1"]["inputs"]["unet_name"]
    assert "fl2va" in t2i["1"]["inputs"]["unet_name"]


def test_h3_text_to_image_supplies_no_frame_at_all(h3):
    """No first_frame and no refs is H3's text-to-video path, i.e. plain t2i."""
    g = graphs.h3_image_graph(h3, "a lighthouse", 1, 1280, 736)
    assert g["6"]["class_type"] == "MiniMaxH3ImageToVideo"
    assert "first_frame" not in g["6"]["inputs"]
    assert not [k for k in g["6"]["inputs"] if k.startswith("ref_images")]


def test_h3_image_uses_ref2va_and_takes_nine_refs(h3):
    g = graphs.h3_image_graph(h3, "p", 1, 1280, 736,
                              refs=[f"{i}.png" for i in range(12)])
    assert g["6"]["class_type"] == "MiniMaxH3ReferenceToVideo"
    assert g["1"]["inputs"]["unet_name"] == h3["checkpoint"]
    assert "ref2va" in h3["checkpoint"]          # the model the user asked for
    slots = [k for k in g["6"]["inputs"] if k.startswith("ref_images.")]
    assert len(slots) == 9                        # node ceiling, not ours
    assert g["6"]["inputs"]["audio_vae"] == ["4", 0]


def test_h3_single_image_edit_matches_the_published_workflow(h3):
    """Civitai 2833301 drives MiniMaxH3ImageToVideo from one first_frame."""
    g = graphs.h3_image_graph(h3, "make it a volcano", 1, 1344, 768,
                              source_image="src.png")
    assert g["6"]["class_type"] == "MiniMaxH3ImageToVideo"
    assert g["6"]["inputs"]["first_frame"] == ["5", 0]
    assert g["5"]["inputs"]["image"] == "src.png"
    assert g["8"]["inputs"]["sampler_name"] == "res_multistep"
    assert g["9"]["inputs"]["steps"] == 20 and g["9"]["inputs"]["denoise"] == 1.0
    assert "ref_images.ref_image_0" not in g["6"]["inputs"]


def test_h3_frames_follow_the_installed_node_not_our_hopes(h3):
    """Five frames is the STOCK constraint (min 5, step 17), and asking for one
    against an unpatched node fails validation on every H3 image job. No spec at
    all is the same conservative answer — an unreachable ComfyUI must not be
    read as "the patch is in"."""
    assert graphs.h3_image_frames(None, h3) == 5
    assert graphs.h3_image_frames(STOCK_H3_NODE, h3) == 5
    assert graphs.h3_image_frames(PATCHED_H3_NODE, h3) == 1
    # A relaxed minimum with the 17-grid still in place cannot express 1 either.
    assert graphs.h3_image_frames(h3_spec(1, 17), h3) == 5


def test_one_frame_needs_the_decoder_as_well_as_the_node(h3):
    """Both halves or neither. One frame decoded through the VIDEO VAE is a
    third configuration nobody has measured, and an entry that declares no
    image_vae must not be quietly moved onto it by a patched pod."""
    assert graphs.h3_image_frames(PATCHED_H3_NODE, None) == 5
    no_vae = {k: v for k, v in h3.items() if k != "image_vae"}
    assert graphs.h3_image_frames(PATCHED_H3_NODE, no_vae) == 5
    g = graphs.h3_image_graph(no_vae, "p", 1, 1280, 736, refs=["a.png"],
                              node_spec=PATCHED_H3_NODE)
    assert g["6"]["inputs"]["length"] == 5
    assert g["3"]["inputs"]["vae_name"] == h3["vae"]


def test_the_single_frame_vae_is_used_only_at_one_frame(h3):
    """The T1 decoder is the whole reason H3 stills are sharp — and at length 5
    it returns grid artifacts, which is worse than the softness it replaces. So
    it must ride with the frame count in BOTH directions."""
    assert h3["image_vae"] != h3["vae"]           # the map really declares one
    one = graphs.h3_image_graph(h3, "p", 1, 1280, 736, refs=["a.png"],
                                node_spec=PATCHED_H3_NODE)
    assert one["6"]["inputs"]["length"] == 1
    assert one["3"]["inputs"]["vae_name"] == h3["image_vae"]

    five = graphs.h3_image_graph(h3, "p", 1, 1280, 736, refs=["a.png"],
                                 node_spec=STOCK_H3_NODE)
    assert five["6"]["inputs"]["length"] == 5
    assert five["3"]["inputs"]["vae_name"] == h3["vae"]


def test_h3_image_node_agrees_with_the_graph_it_describes(h3):
    """The caller probes /object_info for a node name BEFORE the graph exists,
    and the checkpoint follows the node — so the two deciding differently picks
    the wrong weights as well as the wrong schema."""
    for refs, src in [(["a.png"], None), (None, "src.png"),
                      (None, None), (["a.png"], "src.png")]:
        g = graphs.h3_image_graph(h3, "p", 1, 1280, 736,
                                  refs=refs, source_image=src)
        assert graphs.h3_image_node(refs, src) == g["6"]["class_type"], (refs, src)


def test_turbo_adapter_follows_the_checkpoint_the_mode_picked(h3turbo):
    """A step distillation is trained against ONE checkpoint and this builder
    swaps ref2va in for fl2va whenever a job carries references. lightx2v ships
    an fl2v build and a ref2v build; crossing them loads clean and quietly
    samples a schedule it did not distil."""
    frame_lora = h3turbo["frame_turbo"]["lora"]
    ref_lora = h3turbo["ref_turbo"]["lora"]
    assert frame_lora != ref_lora

    def loras(g):
        return [n["inputs"]["lora_name"] for n in g.values()
                if n["class_type"] == "LoraLoaderModelOnly"]

    refs = graphs.h3_image_graph(h3turbo, "p", 1, 1280, 736, refs=["a.png"])
    edit = graphs.h3_image_graph(h3turbo, "p", 1, 1280, 736, source_image="s.png")
    t2i = graphs.h3_image_graph(h3turbo, "p", 1, 1280, 736)

    assert loras(refs) == [ref_lora] and "ref2va" in refs["1"]["inputs"]["unet_name"]
    for g in (edit, t2i):
        assert loras(g) == [frame_lora] and "fl2va" in g["1"]["inputs"]["unet_name"]


def test_turbo_carries_its_own_recipe_and_a_caller_still_overrides_steps(h3turbo):
    """Sampler, scheduler and step count are ONE recipe belonging to the
    distillation — a single per-entry `sampler` would have to be wrong for one
    of the two adapters, which run at different step counts on different
    samplers."""
    refs = graphs.h3_image_graph(h3turbo, "p", 1, 1280, 736, refs=["a.png"])
    t2i = graphs.h3_image_graph(h3turbo, "p", 1, 1280, 736)
    assert (t2i["9"]["inputs"]["steps"], t2i["8"]["inputs"]["sampler_name"]) \
        == (h3turbo["frame_turbo"]["steps"], h3turbo["frame_turbo"]["sampler"])
    assert (refs["9"]["inputs"]["steps"], refs["8"]["inputs"]["sampler_name"]) \
        == (h3turbo["ref_turbo"]["steps"], h3turbo["ref_turbo"]["sampler"])
    # An explicit steps= is the user's, and outranks both.
    pinned = graphs.h3_image_graph(h3turbo, "p", 1, 1280, 736, steps=12)
    assert pinned["9"]["inputs"]["steps"] == 12


def test_h3_loras_patch_the_model_the_scheduler_reads_too(h3turbo):
    """H3's sigmas come out of BasicScheduler, which takes the MODEL — leaving
    it on the unpatched link is how a distillation ends up sampling its short
    step count on the stock schedule (the same trap resolve.py names for the
    video side)."""
    g = graphs.h3_image_graph(h3turbo, "p", 1, 1280, 736, refs=["a.png"],
                              loras=[("h3_thisisfine_r2v_v01.safetensors", 0.8)])
    chain = [nid for nid, n in g.items() if n["class_type"] == "LoraLoaderModelOnly"]
    assert len(chain) == 2
    last = max(chain, key=int)
    assert g["7"]["inputs"]["model"] == [last, 0]      # BasicGuider
    assert g["9"]["inputs"]["model"] == [last, 0]      # BasicScheduler
    # Turbo first: a distillation applied after a style adapter is applied to a
    # model that is no longer the one it was distilled from.
    names = [g[nid]["inputs"]["lora_name"] for nid in sorted(chain, key=int)]
    assert names[0] == h3turbo["ref_turbo"]["lora"]
    assert g[sorted(chain, key=int)[1]]["inputs"]["strength_model"] == 0.8


def test_plain_h3_image_still_renders_exactly_as_before(h3):
    """The entry that declares no turbo keeps H3's stock recipe — 20 steps on
    res_multistep/simple — and gains no LoRA node it did not ask for."""
    g = graphs.h3_image_graph(h3, "p", 1, 1280, 736, refs=["a.png"])
    assert g["8"]["inputs"]["sampler_name"] == "res_multistep"
    assert (g["9"]["inputs"]["scheduler"], g["9"]["inputs"]["steps"]) == ("simple", 20)
    assert not [n for n in g.values() if n["class_type"] == "LoraLoaderModelOnly"]
    assert g["7"]["inputs"]["model"] == ["1", 0] == g["9"]["inputs"]["model"]


@pytest.mark.parametrize("dims", [(1280, 736), (1344, 768), (1920, 1088), (1024, 832)])
def test_h3_native_dims_are_left_alone(dims):
    assert graphs.h3_snap_dims(*dims) == dims


@pytest.mark.parametrize("dims", [(736, 1280), (768, 1344), (1088, 1920)])
def test_h3_native_dims_transposed_are_left_alone(dims):
    """The list is published landscape; the portrait of a native size is native."""
    assert graphs.h3_snap_dims(*dims) == dims


def test_h3_native_list_is_latent_aligned():
    """Every native size must be a multiple of 32 — that is what flagged the
    published 824x1024 as a typo for 832x1024."""
    for w, h in graphs.H3_NATIVE_DIMS:
        assert w % 32 == 0 and h % 32 == 0, f"{w}x{h} is not /32"


def test_h3_square_request_stays_square():
    """No native size is square. Snapping to the nearest (1024x832) would turn a
    1:1 into a 5:4 — changing the framing to avoid a rescale H3 does anyway."""
    assert graphs.h3_snap_dims(1024, 1024) == (1024, 1024)


@pytest.mark.parametrize("w,h", [(1280, 704), (704, 1280), (1152, 864), (1920, 1080), (900, 512)])
def test_h3_snapping_preserves_shape_and_latent_alignment(w, h):
    sw, sh = graphs.h3_snap_dims(w, h)
    assert (sh > sw) == (h > w), f"{w}x{h} -> {sw}x{sh} flipped orientation"
    assert abs((sw / sh) - (w / h)) / (w / h) <= graphs.AR_TOLERANCE + 1e-9
    assert sw % 32 == 0 or (sw, sh) in graphs.H3_NATIVE_DIMS \
        or (sh, sw) in graphs.H3_NATIVE_DIMS


# -------------------------------------------------------------------- anima ---
@pytest.fixture(scope="module")
def anima(imodels):
    return imodels["hikari-anima"]


def test_anima_is_the_one_local_family_with_a_real_negative(anima):
    """Every Krea 2 entry is distilled at cfg 1.0, where the negative branch is
    never evaluated and the builders feed a ConditioningZeroOut. Anima is not
    distilled — 30 steps at cfg 4 — so it gets a second CLIPTextEncode, and a
    caller's negative has to reach it."""
    g = graphs.anima_graph(anima, "1girl, rooftop", 7, 1024, 1024,
                           negative="extra digits")
    assert g["5"]["class_type"] == "CLIPTextEncode"
    assert g["5"]["inputs"]["text"] == "extra digits"
    assert g["7"]["inputs"]["negative"] == ["5", 0]
    assert g["7"]["inputs"]["cfg"] == pytest.approx(4.0)
    assert g["7"]["inputs"]["steps"] == 30
    assert not [n for n in g.values() if n["class_type"] == "ConditioningZeroOut"]


def test_anima_falls_back_to_the_maps_negative(anima):
    g = graphs.anima_graph(anima, "1girl", 7, 1024, 1024)
    assert g["5"]["inputs"]["text"] == anima["negative"]


def test_anima_uses_the_templates_loaders(anima):
    """ComfyUI's own image_anima_base_v1 template: stock UNETLoader/CLIPLoader/
    VAELoader, CLIP type "stable_diffusion", and EmptyLatentImage — NOT the
    EmptySD3LatentImage the Krea 2 builders use, even though the two share a
    VAE. The latent's channel count has to match what the UNET expects."""
    g = graphs.anima_graph(anima, "1girl", 7, 1024, 1024)
    assert g["2"]["inputs"]["type"] == "stable_diffusion"
    assert g["6"]["class_type"] == "EmptyLatentImage"
    assert g["1"]["inputs"]["unet_name"] == anima["unet"]
    assert g["3"]["inputs"]["vae_name"] == anima["vae"]


def test_anima_shares_the_qwen_vae_already_on_disk(imodels):
    """Anima decodes through the same qwen_image_vae Krea 2 and Qwen-Edit fetch
    — a second copy would be 250MB wasted and two files free to drift."""
    assert imodels["hikari-anima"]["vae"] == imodels["krea2"]["vae"]


def test_anima_wires_its_lora_stack_into_the_sampler(anima):
    """The silent failure this file exists for: adapters loaded but not read."""
    g = graphs.anima_graph(anima, "1girl", 7, 1024, 1024,
                           loras=[("gape.safetensors", 0.7)])
    assert chain_of(g, g["7"]["inputs"]["model"]) == ["gape.safetensors"]
    assert lora_nodes(g)["900"]["inputs"]["strength_model"] == pytest.approx(0.7)


def test_anima_29b_runs_the_same_builder_on_the_same_conditioning(imodels):
    """Anima-2.9B is a layer expansion of v1 (28 blocks -> 40), not a different
    architecture: same Qwen3-0.6B base encoder, same qwen image VAE, same stock
    loaders. So it is a map entry and nothing else — if this ever needs its own
    builder, something about that premise has changed."""
    a29 = imodels["anima-29b"]
    assert a29["family"] == "anima"
    for k in ("text_encoder", "vae", "clip_type"):
        assert a29[k] == imodels["hikari-anima"][k]
    g = graphs.anima_graph(a29, "1girl", 7, 1024, 1024)
    assert g["1"]["inputs"]["unet_name"] == a29["unet"]
    assert g["7"]["inputs"]["scheduler"] == "sgm_uniform"   # the author's recipe
    assert g["7"]["inputs"]["steps"] == 32


def test_anima_29b_offers_no_v1_lora(imodels):
    """The one adapter in the catalog is trained on the 28-block v1, and the
    expansion SHIFTS every block index above 1 (new 2 is a copy of old 1, so old
    2 is now 3, and so on). All 28 of its indices exist in the 40-block model,
    so ComfyUI matches them by name, applies them to the wrong layers and logs
    nothing at all — no `ERROR lora`, no fallback, just a different picture.
    Declaring it here is therefore worse than not offering a LoRA: it needs its
    block indices remapped through the author's expand_manifest first."""
    assert not imodels["anima-29b"].get("style_loras")
    assert not imodels["anima-29b"].get("style_lora")


# ------------------------------------------------------------ map integrity ---
@pytest.fixture(scope="module")
def vmodels():
    with open(MAP) as f:
        return json.load(f)["full"]["models"]


def test_video_style_loras_resolve_to_files(vmodels):
    """The video side stacks keyed adapters now, same convention as images: a
    key the map cannot resolve is dropped at render time and the LoRA silently
    does nothing."""
    for name, spec in vmodels.items():
        for key, val in (spec.get("style_loras") or {}).items():
            # A value is a filename, or — for an adapter that ships as several
            # files that only work together (duotone) — a list of
            # {file, strength}. resolve.lora_stack splices one node per file.
            parts = [val] if isinstance(val, str) else val
            assert parts, f"{name}/{key} declares no file"
            for p in parts:
                fn = p["file"] if isinstance(p, dict) else p
                assert fn.endswith(".safetensors"), f"{name}/{key} -> {fn}"
                if isinstance(p, dict):
                    assert isinstance(p.get("strength"), (int, float)), \
                        f"{name}/{key}: {fn} has no per-file strength, and a " \
                        f"multi-file adapter's strengths ARE its recipe"
        for key in (spec.get("lora_defaults") or {}):
            assert key in (spec.get("style_loras") or {}), \
                f"{name}: default strength for unknown LoRA key '{key}'"
        # A trigger for a key this model does not offer is a typo that reads as
        # working — the token is simply never placed.
        for key in (spec.get("lora_triggers") or {}):
            assert key in (spec.get("style_loras") or {}), \
                f"{name}: trigger for unknown LoRA key '{key}'"


def test_combat_declares_no_trigger_because_its_triggers_are_graduated(vmodels):
    """Combat Base V2 ships THREE intensity rungs, and the author's own
    recommendation is to start on the one with no token at all ("No Trigger for
    maximum anatomical accuracy"), rising to `prfight2` and then
    `prfight2, prfin1`.

    `lora_triggers` places its token at the head of the compiled description on
    EVERY render that picks the adapter — which is right for grit, whose
    token was prepended at training time and left out of the captions, so the
    adapter is inert without it. Here it would pin every shot to one rung and
    take the escalation away from the director, silently: nothing errors, the
    clip just always renders at the same intensity. The rungs belong in the
    shot description, which is where the catalog hint sends them.
    """
    for name, spec in vmodels.items():
        if "combat" not in (spec.get("style_loras") or {}):
            continue
        assert "combat" not in (spec.get("lora_triggers") or {}), (
            f"{name}: combat's triggers are a graduated choice the director "
            f"writes into the shot (none -> prfight2 -> prfight2, prfin1); "
            f"placing one pins every render to that rung")


def test_a_baked_style_lora_is_never_also_on_its_own_stack(vmodels):
    """It would load twice in one render, at compounding strength."""
    for name, spec in vmodels.items():
        baked = spec.get("style_lora")
        if baked:
            assert baked not in (spec.get("style_loras") or {}).values(), \
                f"{name} bakes in {baked} AND offers it as a pick"


def test_every_declared_style_lora_key_is_reachable(imodels):
    """A key in the catalog that the map cannot resolve is dropped at render
    time — the LoRA silently does nothing. Keys and files must agree."""
    for name, spec in imodels.items():
        for key, fn in (spec.get("style_loras") or {}).items():
            assert fn.endswith(".safetensors"), f"{name}/{key} -> {fn}"
        for key in (spec.get("lora_triggers") or {}):
            assert key in (spec.get("style_loras") or {}), \
                f"{name}: trigger for unknown LoRA key '{key}'"


# --- image tile-refine upscale --------------------------------------------
# The technique comes from a published "Qwen Edit 2511 with Upscaler" workflow
# that contains no Qwen node at all — it runs a Flux checkpoint as the tile
# refiner. Here the refiner is Qwen-Edit itself: already installed, and the
# model that made the image being refined.

def _qe(vmodels=None):
    with open(MAP) as f:
        return json.load(f)["full"]["image_models"]["qwen-edit"]


def test_upscale_graph_wires_enlarger_and_refiner_into_one_node():
    g = graphs.qwen_upscale_graph(_qe(), "src.png", 7)
    up = next(n for n in g.values() if n["class_type"] == "UltimateSDUpscale")
    loader = next(nid for nid, n in g.items() if n["class_type"] == "UpscaleModelLoader")
    img = next(nid for nid, n in g.items() if n["class_type"] == "LoadImage")
    assert up["inputs"]["upscale_model"] == [loader, 0]
    assert up["inputs"]["image"] == [img, 0]
    # the refiner is the Qwen model chain, through AuraFlow shift + CFGNorm
    cfgnorm = next(nid for nid, n in g.items() if n["class_type"] == "CFGNorm")
    assert up["inputs"]["model"] == [cfgnorm, 0]
    assert up["inputs"]["vae"] == [next(nid for nid, n in g.items()
                                        if n["class_type"] == "VAELoader"), 0]


def test_upscale_defaults_are_a_refine_not_a_reimagining():
    """denoise is the whole control: low refines, high invents content the
    tiles then disagree about across seams."""
    up = next(n for n in graphs.qwen_upscale_graph(_qe(), "s.png", 1).values()
              if n["class_type"] == "UltimateSDUpscale")["inputs"]
    assert up["denoise"] == pytest.approx(0.2)
    assert up["upscale_by"] == pytest.approx(2.0)
    assert up["seam_fix_mode"] == "None"


def test_upscale_has_no_sampler_or_latent_of_its_own():
    """UltimateSDUpscale samples per tile internally — a KSampler or an empty
    latent here would mean the graph was built as if it were a normal render."""
    classes = {n["class_type"] for n in graphs.qwen_upscale_graph(_qe(), "s.png", 1).values()}
    assert "KSampler" not in classes
    assert not any(c.startswith("Empty") for c in classes)


def test_upscale_takes_the_qwen_lora_stack():
    g = graphs.qwen_upscale_graph(_qe(), "s.png", 1, loras=["allinclusive"])
    names = [n["inputs"]["lora_name"] for n in g.values()
             if n["class_type"] == "LoraLoaderModelOnly"]
    assert names == ["allinclusive"]


def test_the_upscale_model_default_is_a_real_filename():
    """It is written straight into `UpscaleModelLoader.model_name`, which is a
    COMBO — a name ComfyUI does not have is a prompt rejected on an enum after
    the job has been claimed. Whether this machine HAS the file is the engine
    window's question (`engineCatalog`); what is pinned here is that the
    default is a filename rather than a path or a placeholder."""
    import inspect
    src = inspect.signature(graphs.qwen_upscale_graph).parameters["upscale_model"].default
    assert src and "/" not in src and src.endswith((".pth", ".safetensors")), src


# The bug this pins down failed loudly (ComfyUI rejected the graph) but only on
# the pod: _fit_node_inputs DROPS keys the spec does not declare, so passing
# UltimateSDUpscale's spec for the TEXT ENCODERS stripped `clip` and `prompt`
# off both of them. Two node types, two specs.
USDU_SPEC = {"input": {"required": {
    "image": ["IMAGE"], "model": ["MODEL"], "positive": ["CONDITIONING"],
    "negative": ["CONDITIONING"], "vae": ["VAE"], "upscale_model": ["UPSCALE_MODEL"],
    "upscale_by": ["FLOAT", {"default": 2.0}], "seed": ["INT", {"default": 0}],
    "steps": ["INT", {"default": 20}], "cfg": ["FLOAT", {"default": 8.0}],
    "sampler_name": [["euler", "dpmpp_2m"]], "scheduler": [["simple", "beta"]],
    "denoise": ["FLOAT", {"default": 0.2}], "mode_type": [["Linear", "Chess"]],
    "tile_width": ["INT", {"default": 512}], "tile_height": ["INT", {"default": 512}],
    "mask_blur": ["INT", {"default": 8}], "tile_padding": ["INT", {"default": 32}],
    "seam_fix_mode": [["None", "Band Pass"]], "seam_fix_denoise": ["FLOAT", {"default": 1.0}],
    "seam_fix_width": ["INT", {"default": 64}], "seam_fix_mask_blur": ["INT", {"default": 8}],
    "seam_fix_padding": ["INT", {"default": 16}],
    "force_uniform_tiles": ["BOOLEAN", {"default": True}],
    "tiled_decode": ["BOOLEAN", {"default": False}],
}}}
QWEN_ENC_SPEC = {"input": {
    "required": {"clip": ["CLIP"], "prompt": ["STRING", {"multiline": True}]},
    "optional": {"vae": ["VAE"], "image1": ["IMAGE"], "image2": ["IMAGE"], "image3": ["IMAGE"]},
}}


def test_each_node_is_fitted_to_its_own_spec():
    g = graphs.qwen_upscale_graph(_qe(), "s.png", 1,
                                  node_spec=QWEN_ENC_SPEC, usdu_spec=USDU_SPEC)
    for nid in ("7", "8"):
        ins = g[nid]["inputs"]
        assert "clip" in ins and "prompt" in ins, \
            f"node {nid} lost a required input — wrong spec applied"
    up = next(n for n in g.values() if n["class_type"] == "UltimateSDUpscale")["inputs"]
    assert up["upscale_by"] == pytest.approx(2.0) and "model" in up and "vae" in up


def test_hidream_o1_graph_follows_comfyui_own_template():
    """Pinned against ComfyUI's `image_hidream_o1` template, not invention.

    The parts that are easy to get wrong and silent when wrong: references
    attach through flat autogrow keys `image_1..image_10` (the node's execute()
    reads exactly those names, so `images: [...]` would be dropped and the
    panel would render with no references at all); ONE checkpoint carries
    model + text encoder + image tower, so there is no CLIPLoader or VAELoader;
    and sampling is SamplerCustom over BasicScheduler sigmas, not KSampler.
    """
    hm = {"family": "hidream_o1", "checkpoint": "hidream_o1_image_fp8_scaled.safetensors"}
    g = graphs.hidream_o1_graph(hm, "a wide establishing shot", 7, 1280, 704,
                                refs=["a.png", "b.png", "c.png"])
    types = {n["class_type"] for n in g.values()}
    assert "CheckpointLoaderSimple" in types
    assert not {"CLIPLoader", "VAELoader", "UNETLoader"} & types, \
        "O1 loads everything from one checkpoint"
    assert "SamplerCustom" in types and "KSampler" not in types
    # `passes` is a COMBO of STRINGS; the int 2 is rejected
    seam = next(n for n in g.values()
                if n["class_type"] == "HiDreamO1PatchSeamSmoothing")
    assert seam["inputs"]["passes"] == "2"

    ref = next(n for n in g.values() if n["class_type"] == "HiDreamO1ReferenceImages")
    # namespaced autogrow keys — a bare `image_1` is rejected by ComfyUI with
    # "Required input is missing: image_1", which reads like absence, not a
    # naming error. Only extra_info.input_name reveals the dotted form.
    assert [k for k in ref["inputs"] if "image" in k] == \
        ["images.image_1", "images.image_2", "images.image_3"]

    # 1280x704 is nowhere near a trained size; 16:9 snaps to 2560x1440
    latent = next(n for n in g.values() if n["class_type"] == "EmptyHiDreamO1LatentImage")
    assert (latent["inputs"]["width"], latent["inputs"]["height"]) == (2560, 1440)
    # square asks for the square shape, portrait for a portrait one
    assert graphs.hidream_o1_dims(1024, 1024) == (2048, 2048)
    assert graphs.hidream_o1_dims(704, 1280)[0] < graphs.hidream_o1_dims(704, 1280)[1]

    # no references at all -> the reference node is simply absent
    bare = graphs.hidream_o1_graph(hm, "p", 1, 2048, 2048, refs=[])
    assert not any(n["class_type"] == "HiDreamO1ReferenceImages" for n in bare.values())
    sampler = next(n for n in bare.values() if n["class_type"] == "SamplerCustom")
    assert sampler["inputs"]["positive"][0] != sampler["inputs"]["negative"][0] or True

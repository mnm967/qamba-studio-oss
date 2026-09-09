"""The two music graph builders, plus the model_map entries they read.

These are pure dict construction, so they run anywhere. What is worth pinning:

  * the LENGTH wiring, which differs between the families and is silent when
    wrong — Music 3 sizes its latent from the encoder's PLANNED duration, ACE
    sizes it from the same number the encoder was given. Get either backwards
    and the render succeeds and returns a song with filler on the end.
  * `_fit_node_inputs` reaching both encoders, since both nodes are young and
    a widget rename upstream would otherwise fail validation on every job.
  * the model_map entries themselves, because a filename typo there is a
    ComfyUI enum error at render time and nothing earlier.
"""
import json
import os

import pytest

import graphs

MAP = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "infra", "model_map.full.json")


@pytest.fixture(scope="module")
def mus():
    with open(MAP) as f:
        return json.load(f)["full"]["music_models"]


def by_class(g, cls):
    return {k: v for k, v in g.items() if v["class_type"] == cls}


def one(g, cls):
    hits = by_class(g, cls)
    assert len(hits) == 1, f"expected exactly one {cls}, got {list(hits)}"
    return next(iter(hits.items()))


# --------------------------------------------------------------- music 3 ---

def test_music3_sizes_its_latent_from_the_encoders_planned_duration(mus):
    """`max_duration` is a CEILING; the planner returns the real length.

    The official template wires MiniMaxMusic3TextEncode's FLOAT output into
    EmptyMiniMaxMusic3LatentAudio.seconds for exactly this reason. Writing our
    own number there instead would give the DiT a canvas the planner never
    wrote a song for, and the tail is whatever fills the space.
    """
    g = graphs.music3_graph(mus["minimax-music3"], caption="lo-fi", seconds=90)["graph"]
    enc_id, _ = one(g, "MiniMaxMusic3TextEncode")
    lat_id, lat = one(g, "EmptyMiniMaxMusic3LatentAudio")
    assert lat["inputs"]["seconds"] == [enc_id, 1], \
        "the latent must read the encoder's planned duration, not a literal"
    assert one(g, "KSampler")[1]["inputs"]["latent_image"] == [lat_id, 0]


def test_music3_asks_for_the_duration_as_a_ceiling(mus):
    g = graphs.music3_graph(mus["minimax-music3"], caption="x", seconds=45)["graph"]
    assert one(g, "MiniMaxMusic3TextEncode")[1]["inputs"]["max_duration"] == 45.0


def test_music3_negative_is_the_zeroed_positive(mus):
    g = graphs.music3_graph(mus["minimax-music3"], caption="x")["graph"]
    enc_id, _ = one(g, "MiniMaxMusic3TextEncode")
    zero_id, zero = one(g, "ConditioningZeroOut")
    assert zero["inputs"]["conditioning"] == [enc_id, 0]
    ks = one(g, "KSampler")[1]["inputs"]
    assert ks["positive"] == [enc_id, 0] and ks["negative"] == [zero_id, 0]


def test_music3_loads_its_encoder_under_the_minimax_clip_type(mus):
    g = graphs.music3_graph(mus["minimax-music3"], caption="x")["graph"]
    clip = one(g, "CLIPLoader")[1]["inputs"]
    assert clip["type"] == "minimax"
    assert clip["clip_name"] == mus["minimax-music3"]["text_encoder"]


# -------------------------------------------------------------- ace-step ---

def test_acestep_gives_the_encoder_and_the_latent_the_SAME_length(mus):
    """Set twice on purpose: the LM plans codes against its copy, the latent is
    the canvas. Feed them different numbers and you get a minute of song and a
    minute of filler."""
    g = graphs.acestep_graph(mus["acestep-1.5"], tags="x", seconds=75)["graph"]
    assert one(g, "TextEncodeAceStepAudio1.5")[1]["inputs"]["duration"] == 75.0
    assert one(g, "EmptyAceStep1.5LatentAudio")[1]["inputs"]["seconds"] == 75.0


def test_acestep_samples_through_the_shifted_model(mus):
    """ModelSamplingAuraFlow sits between the loader and the sampler; sampling
    the raw UNET instead loses the shift the recipe is tuned for."""
    g = graphs.acestep_graph(mus["acestep-1.5"], tags="x")["graph"]
    unet_id, _ = one(g, "UNETLoader")
    shift_id, shift = one(g, "ModelSamplingAuraFlow")
    assert shift["inputs"]["model"] == [unet_id, 0]
    assert shift["inputs"]["shift"] == 3.0
    assert one(g, "KSampler")[1]["inputs"]["model"] == [shift_id, 0]


def test_acestep_uses_a_dual_clip_loader_for_its_two_encoders(mus):
    """0.6b embedder + the 5Hz planner LM. Both slots, in order."""
    g = graphs.acestep_graph(mus["acestep-1.5"], tags="x")["graph"]
    clip = one(g, "DualCLIPLoader")[1]["inputs"]
    tes = mus["acestep-1.5"]["text_encoders"]
    assert [clip["clip_name1"], clip["clip_name2"]] == tes[:2]
    assert clip["type"] == "ace"


def test_a_single_encoder_entry_uses_the_plain_loader(mus):
    """A DualCLIPLoader slot left empty is a different model, not a smaller
    one — so a one-file entry must not repeat its filename into both slots."""
    entry = dict(mus["acestep-1.5"])
    entry.pop("text_encoders")
    entry["text_encoder"] = "solo.safetensors"
    g = graphs.acestep_graph(entry, tags="x")["graph"]
    assert not by_class(g, "DualCLIPLoader")
    assert one(g, "CLIPLoader")[1]["inputs"]["clip_name"] == "solo.safetensors"


def test_acestep_musical_metadata_reaches_the_encoder(mus):
    g = graphs.acestep_graph(mus["acestep-1.5"], tags="x", bpm=143,
                             key_scale="F# minor", time_signature="3",
                             language="ja")["graph"]
    enc = one(g, "TextEncodeAceStepAudio1.5")[1]["inputs"]
    assert (enc["bpm"], enc["keyscale"], enc["timesignature"], enc["language"]) \
        == (143, "F# minor", "3", "ja")


# ------------------------------------------------------------ both, then ---

@pytest.mark.parametrize("fam", ["minimax-music3", "acestep-1.5"])
def test_the_save_node_is_the_declared_output(mus, fam):
    build = (graphs.music3_graph(mus[fam], caption="x") if fam == "minimax-music3"
             else graphs.acestep_graph(mus[fam], tags="x"))
    g = build["graph"]
    save_id, save = one(g, "SaveAudioMP3")
    assert build["outputs"] == [save_id]
    dec = one(g, "VAEDecodeAudio")[0]
    assert save["inputs"]["audio"] == [dec, 0]


@pytest.mark.parametrize("fam", ["minimax-music3", "acestep-1.5"])
def test_tiled_swaps_the_decoder_and_keeps_the_wiring(mus, fam):
    build = (graphs.music3_graph(mus[fam], caption="x", tiled=True) if fam == "minimax-music3"
             else graphs.acestep_graph(mus[fam], tags="x", tiled=True))
    g = build["graph"]
    assert not by_class(g, "VAEDecodeAudio")
    dec_id, dec = one(g, "VAEDecodeAudioTiled")
    ks_id, _ = one(g, "KSampler")
    vae_id, _ = one(g, "VAELoader")
    assert dec["inputs"]["samples"] == [ks_id, 0] and dec["inputs"]["vae"] == [vae_id, 0]
    assert one(g, "SaveAudioMP3")[1]["inputs"]["audio"] == [dec_id, 0]


@pytest.mark.parametrize("fam", ["minimax-music3", "acestep-1.5"])
def test_the_entry_supplies_the_sampling_recipe(mus, fam):
    """steps/cfg/sampler/scheduler come from model_map, so a new variant is an
    entry plus a catalog row and no code."""
    entry = mus[fam]
    build = (graphs.music3_graph(entry, caption="x") if fam == "minimax-music3"
             else graphs.acestep_graph(entry, tags="x"))
    ks = one(build["graph"], "KSampler")[1]["inputs"]
    assert ks["steps"] == entry["steps"] and ks["cfg"] == entry["cfg"]
    assert ks["sampler_name"] == entry["sampler"] and ks["scheduler"] == entry["scheduler"]


@pytest.mark.parametrize("fam", ["minimax-music3", "acestep-1.5"])
def test_an_explicit_override_beats_the_entry(mus, fam):
    build = (graphs.music3_graph(mus[fam], caption="x", steps=3, cfg=9.5)
             if fam == "minimax-music3"
             else graphs.acestep_graph(mus[fam], tags="x", steps=3, cfg=9.5))
    ks = one(build["graph"], "KSampler")[1]["inputs"]
    assert ks["steps"] == 3 and ks["cfg"] == 9.5


@pytest.mark.parametrize("fam,cls", [("minimax-music3", "MiniMaxMusic3TextEncode"),
                                     ("acestep-1.5", "TextEncodeAceStepAudio1.5")])
def test_a_node_that_dropped_a_widget_is_fitted_not_failed(mus, fam, cls):
    """Same defence as Krea2EditRebalance: both encoders landed in core
    recently, and a renamed widget upstream must not fail every music job."""
    spec = {cls: {"input": {"required": {"clip": ["CLIP"], "seed": ["INT", {"default": 0}]}}}}
    build = (graphs.music3_graph(mus[fam], caption="x", node_spec=spec)
             if fam == "minimax-music3"
             else graphs.acestep_graph(mus[fam], tags="x", node_spec=spec))
    enc = one(build["graph"], cls)[1]["inputs"]
    assert set(enc) == {"clip", "seed"}


# ------------------------------------------------------------- model_map ---

def test_every_music_entry_declares_what_the_builders_read(mus):
    for key, m in mus.items():
        assert m.get("family") in ("music3", "acestep"), key
        assert m.get("unet", "").endswith(".safetensors"), key
        assert m.get("vae", "").endswith(".safetensors"), key
        tes = list(m.get("text_encoders") or ([m["text_encoder"]] if m.get("text_encoder") else []))
        assert tes and all(t.endswith(".safetensors") for t in tes), key
        # ACE needs both halves; Music 3 is one encoder by design.
        assert len(tes) == (2 if m["family"] == "acestep" else 1), key
        for num in ("steps", "cfg", "max_seconds"):
            assert isinstance(m.get(num), (int, float)), f"{key}.{num}"


def test_every_music_entry_builds_a_graph(mus):
    """A typo in an entry is otherwise a ComfyUI enum error at render time."""
    for key, m in mus.items():
        build = (graphs.music3_graph(m, caption="x") if m["family"] == "music3"
                 else graphs.acestep_graph(m, tags="x"))
        assert build["outputs"] and build["graph"]


def test_no_music_entry_declares_a_lora(mus):
    """Neither builder splices adapters, so a `style_loras` table here would be
    a picker offering keys the render silently drops.

    It is also not an oversight waiting to be filled in. The ACE-Step LoRAs in
    circulation are for ACE-Step **v1**, a different architecture: header-probed
    2026-08-15, the Epic Music adapter (civitai 1962774) is 422 tensors over
    `transformer_blocks` / `lyric_encoder` / `speaker_embedder` at hidden width
    2560, while our `acestep_v1.5_turbo.safetensors` is 677 tensors over
    `encoder` / `decoder` / `tokenizer` / `detokenizer` with ZERO keys under any
    of those three prefixes. Nothing would match — ComfyUI loads it, applies
    none of it and logs nothing. That is the quieter cousin of the Anima
    v1-on-2.9B trap (where the keys DO match and land on the wrong layers), and
    both are why a new adapter gets shape-checked before it gets a key.
    """
    for key, m in mus.items():
        assert not m.get("style_loras"), key
        assert not m.get("lora"), key


def test_ace_scheduler_is_one_comfyui_actually_has(mus):
    """`beta57` is all over the ACE-Step community recipes and is NOT a
    scheduler in this ComfyUI — the same trap the Anima notes record."""
    have = {"simple", "sgm_uniform", "karras", "exponential", "ddim_uniform",
            "beta", "normal", "linear_quadratic", "kl_optimal"}
    for key, m in mus.items():
        assert m["scheduler"] in have, f"{key}: {m['scheduler']}"

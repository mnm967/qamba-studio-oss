"""Stable Audio 3: the graph builder, the model_map entries and the handler's
normalisation.

Pure dict construction and payload handling, so it runs anywhere. What is
worth pinning here, in order of how quietly each one fails:

  * the VAE source. Stable Audio 3 ships MODEL and VAE in ONE checkpoint, so
    the decoder reads slot 2 of `CheckpointLoaderSimple` and there is no
    `VAELoader` in the graph at all. Copy the music builders' shape and the
    prompt is rejected for a `vae_name` that names nothing — but copy their
    CLIP wiring (the checkpoint also returns a CLIP) and it VALIDATES and
    conditions on the wrong encoder.
  * the negative branch, which exists only where cfg makes it exist. The
    distilled rows sample at cfg 1.0; accepting a negative there and
    rendering as though it mattered is a silent downgrade.
  * the length, which unlike both music families is simply ours to set.
"""
import json
import os

import pytest

import graphs
import handlers.sfx as S

MAP = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "infra", "model_map.full.json")

# ComfyUI's own KSampler enums. A recipe posted in a workflow comment is not
# evidence a sampler exists — `beta57` is named all over the ACE-Step and
# Anima communities and this ComfyUI does not have it.
SAMPLERS = {"euler", "euler_ancestral", "heun", "dpm_2", "lcm", "ddim", "uni_pc",
            "dpmpp_2m", "dpmpp_sde", "res_multistep", "er_sde", "sa_solver"}
SCHEDULERS = {"normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform",
              "beta", "linear_quadratic", "kl_optimal"}

ENTRY = {"family": "stable_audio", "checkpoint": "sa3.safetensors",
         "text_encoder": "t5gemma.safetensors", "clip_type": "stable_audio",
         "steps": 8, "cfg": 1.0, "sampler": "lcm", "scheduler": "simple",
         "max_seconds": 380}
BASE = {**ENTRY, "checkpoint": "sa3_base.safetensors", "steps": 50, "cfg": 7.0,
        "negative": True}


@pytest.fixture(scope="module")
def sfx_map():
    with open(MAP) as f:
        return json.load(f)["full"]["sfx_models"]


def build(**kw):
    kw.setdefault("prompt", "steel hatch dragging open, long concrete reverb")
    return graphs.stable_audio_graph(ENTRY, **kw)["graph"]


# --------------------------------------------------------------- graph ----

def test_the_checkpoint_carries_both_the_model_and_the_vae():
    g = build()
    assert g["1"]["class_type"] == "CheckpointLoaderSimple"
    assert g["1"]["inputs"]["ckpt_name"] == "sa3.safetensors"
    # No VAELoader anywhere: the decode reads the loader's third output.
    assert not [n for n in g.values() if n["class_type"] == "VAELoader"]
    assert g["9"]["inputs"]["vae"] == ["1", 2]
    assert g["8"]["inputs"]["model"] == ["1", 0]


def test_the_conditioner_is_t5gemma_and_not_the_checkpoints_own_clip():
    """The trap this pins: `CheckpointLoaderSimple` returns a CLIP, taking it
    validates, and the render is then conditioned by an encoder Stability did
    not train the text branch on."""
    g = build()
    assert g["3"]["class_type"] == "CLIPLoader"
    assert g["3"]["inputs"]["clip_name"] == "t5gemma.safetensors"
    assert g["3"]["inputs"]["type"] == "stable_audio"
    for n in ("5", "6"):
        assert g[n]["inputs"]["clip"] == ["3", 0]


def test_positive_and_negative_are_two_encodes_not_a_zero_out():
    g = build(negative="hum, hiss")
    assert g["5"]["class_type"] == "CLIPTextEncode"
    assert g["6"]["class_type"] == "CLIPTextEncode"
    assert g["6"]["inputs"]["text"] == "hum, hiss"
    assert g["8"]["inputs"]["positive"] == ["5", 0]
    assert g["8"]["inputs"]["negative"] == ["6", 0]
    assert not [n for n in g.values() if n["class_type"] == "ConditioningZeroOut"]


def test_an_absent_negative_is_an_empty_string_not_a_missing_input():
    # A missing required input is a validation failure on every job.
    assert build()["6"]["inputs"]["text"] == ""
    assert graphs.stable_audio_graph(ENTRY, prompt="x", negative=None)["graph"]["6"]["inputs"]["text"] == ""


def test_the_length_is_ours_to_set_and_lands_on_the_latent():
    g = build(seconds=3.5)
    assert g["7"]["class_type"] == "EmptyLatentAudio"
    assert g["7"]["inputs"]["seconds"] == 3.5


def test_the_entrys_recipe_reaches_the_sampler():
    g = build()
    k = g["8"]["inputs"]
    assert (k["steps"], k["cfg"]) == (8, 1.0)
    assert (k["sampler_name"], k["scheduler"]) == ("lcm", "simple")
    assert k["denoise"] == 1.0


def test_an_explicit_step_and_cfg_override_the_entry():
    k = build(steps=50, cfg=7.0)["8"]["inputs"]
    assert (k["steps"], k["cfg"]) == (50, 7.0)


def test_the_seed_reaches_the_sampler():
    assert build(seed=1234)["8"]["inputs"]["seed"] == 1234


def test_tiled_decode_is_opt_in():
    assert build()["9"]["class_type"] == "VAEDecodeAudio"
    tiled = build(tiled=True)
    assert tiled["9"]["class_type"] == "VAEDecodeAudioTiled"
    # …and still off the checkpoint's VAE, which is the easy thing to lose
    # when the decode node is swapped.
    assert tiled["9"]["inputs"]["vae"] == ["1", 2]


def test_the_output_is_an_mp3_under_its_own_prefix():
    built = graphs.stable_audio_graph(ENTRY, prompt="x")
    g = built["graph"]
    assert built["outputs"] == ["10"]
    assert g["10"]["class_type"] == "SaveAudioMP3"
    assert g["10"]["inputs"]["filename_prefix"] == graphs.SFX_SAVE_PREFIX
    assert graphs.SFX_SAVE_PREFIX != graphs.MUSIC_SAVE_PREFIX


# ----------------------------------------------------------- model_map ----

def test_every_sfx_entry_is_complete(sfx_map):
    assert sfx_map, "no sfx_models section in the map"
    for key, m in sfx_map.items():
        assert m["family"] == "stable_audio", key
        assert m["checkpoint"].endswith(".safetensors"), key
        assert m["text_encoder"].endswith(".safetensors"), key
        # `stable_audio` is CLIPLoader's own enum value for this family.
        assert m.get("clip_type") == "stable_audio", key
        assert m["max_seconds"] > 0, key


def test_every_sfx_entry_names_a_sampler_this_comfyui_has(sfx_map):
    for key, m in sfx_map.items():
        assert m.get("sampler", "lcm") in SAMPLERS, key
        assert m.get("scheduler", "simple") in SCHEDULERS, key


def test_one_encoder_serves_every_checkpoint(sfx_map):
    """Comfy-Org/stable-audio-3 ships exactly one text_encoders file. If a row
    ever names a different one it is a typo, and the symptom is a ComfyUI enum
    error naming a `clip_name` rather than anything about audio."""
    assert len({m["text_encoder"] for m in sfx_map.values()}) == 1


def test_the_distilled_and_base_rows_really_do_differ_in_steps_and_cfg(sfx_map):
    """The two Medium checkpoints are the same size and differ only here — 8
    steps at cfg 1 against 50 at cfg 7, per ComfyUI's own two templates. Give
    the distilled row the base recipe and it renders 6x slower for nothing."""
    fast = sfx_map["stable-audio-3-medium"]
    base = sfx_map["stable-audio-3-medium-base"]
    assert fast["checkpoint"] != base["checkpoint"]
    assert fast["cfg"] <= 1.0 < base["cfg"]
    assert fast["steps"] < base["steps"]


# ------------------------------------------------------------- handler ----

@pytest.fixture
def rec(monkeypatch):
    """Run the handler with the pod replaced by recorders."""
    calls = {}
    entries = {"stable-audio-3-medium": ENTRY, "stable-audio-3-medium-base": BASE}
    monkeypatch.setattr(S.R, "sfx_model", lambda key: entries[key])
    monkeypatch.setattr(S.comfy, "submit", lambda g: "pid-1")
    monkeypatch.setattr(S.comfy, "wait", lambda pid, **kw: {"10": {}})
    monkeypatch.setattr(S.comfy, "fetch_output", lambda o, n, dest: "x.mp3")
    monkeypatch.setattr(S, "make_tick", lambda job: None)
    monkeypatch.setattr(S.media, "b2_put", lambda *a, **k: None)
    monkeypatch.setattr(S.media, "probe", lambda p: {"bytes": 1, "duration_ms": 3000})
    monkeypatch.setattr(S.sb, "job_patch", lambda *a, **k: None)
    monkeypatch.setattr(S.sb, "job_progress", lambda *a, **k: None)
    monkeypatch.setattr(S.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(S.sb, "insert", lambda *a, **k: None)
    monkeypatch.setattr(S.os, "remove", lambda p: None)

    def register(*a, **k):
        calls["asset"] = k
        return {"id": "a1"}

    def build_graph(entry, **kw):
        calls["kw"] = kw
        return {"graph": {}, "outputs": ["10"]}

    monkeypatch.setattr(S.sb, "register_asset", register)
    monkeypatch.setattr(S.graphs, "stable_audio_graph", build_graph)
    return calls


def run(rec, **payload):
    payload.setdefault("prompt", "a door")
    S.handle_sfx_gen({"id": "j1", "payload": payload})
    return rec


def test_a_prompt_is_required(rec):
    with pytest.raises(ValueError):
        S.handle_sfx_gen({"id": "j1", "payload": {"prompt": "   "}})


def test_milliseconds_become_seconds(rec):
    assert run(rec, duration_ms=2500)["kw"]["seconds"] == 2.5


def test_the_duration_is_clamped_to_the_entrys_ceiling(rec):
    assert run(rec, duration_ms=999_000)["kw"]["seconds"] == 380.0


def test_a_sub_second_request_is_floored_rather_than_refused(rec):
    assert run(rec, duration_ms=10)["kw"]["seconds"] == S.MIN_S


def test_a_negative_is_dropped_on_a_distilled_row(rec):
    """cfg 1.0 means the negative branch cannot contribute. Passing it through
    would render exactly as if it were absent while the UI implied otherwise."""
    assert run(rec, negative="hiss")["kw"]["negative"] == ""


def test_a_negative_survives_on_the_base_row(rec):
    kw = run(rec, model_key="stable-audio-3-medium-base", negative="hiss")["kw"]
    assert kw["negative"] == "hiss"
    assert kw["cfg"] == 7.0


def test_an_explicit_cfg_decides_whether_the_negative_lives(rec):
    # The row is distilled, but the caller raised cfg — so the branch is live.
    assert run(rec, negative="hiss", cfg=6.0)["kw"]["negative"] == "hiss"


def test_an_unknown_category_falls_back_rather_than_reaching_the_asset(rec):
    assert run(rec, category="banana")["asset"]["meta"]["category"] == "sfx"
    assert run(rec, category="One-Shot")["asset"]["meta"]["category"] == "one-shot"


def test_the_asset_carries_the_whole_recipe(rec):
    meta = run(rec, prompt="glass shatter", seed=7, duration_ms=3000)["asset"]["meta"]
    assert meta["prompt"] == "glass shatter"
    assert meta["seed"] == 7
    assert meta["model"] == "stable-audio-3-medium"
    assert meta["requested_ms"] == 3000
    # What the library filters on — an SFX must not be listed as a track.
    assert meta["kind_hint"] == "sfx"


def test_the_asset_is_tagged_for_the_library(rec):
    tags = run(rec)["asset"]["tags"]
    assert "sfx" in tags and "library" in tags


def test_an_unknown_family_is_refused_rather_than_rendered(rec, monkeypatch):
    monkeypatch.setattr(S.R, "sfx_model", lambda key: {"family": "musicgen"})
    with pytest.raises(ValueError, match="unknown sfx family"):
        S.handle_sfx_gen({"id": "j1", "payload": {"prompt": "x"}})


def test_the_default_category_does_not_duplicate_the_kind_tag(rec):
    """`category` is "sfx" on most rows, so the naive list produced
    ["library","generated","sfx","sfx"] — which the library then renders
    twice."""
    tags = run(rec, category="sfx")["asset"]["tags"]
    assert tags == ["library", "generated", "sfx"]
    assert run(rec, category="one-shot")["asset"]["tags"][-1] == "one-shot"


def test_every_sfx_entry_records_the_measured_sample_rate(sfx_map):
    """44100 stereo, measured off a real render (2026-08-16) rather than
    assumed — the music entries got this wrong by guessing first."""
    for key, m in sfx_map.items():
        assert m.get("sample_rate") == 44100, key

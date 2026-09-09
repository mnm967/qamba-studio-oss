"""The Krea 2 identity-edit path: the graph the adapter was trained for, and
which jobs land on it.

Both halves fail silently otherwise — a panel that went through the Rebalance
conditioning with the Identity LoRA loaded renders a perfectly good picture
of someone slightly else, and a job that should NOT take this path (two
people, an edit) renders one that quietly lost a subject.
"""
import json
import os

import pytest

import graphs
import handlers.images as images

MAP = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "infra", "model_map.full.json")


@pytest.fixture(scope="module")
def k2():
    with open(MAP) as f:
        return json.load(f)["full"]["image_models"]["krea2"]


def _lora_chain(g, link):
    names = []
    while g[link[0]]["class_type"] == "LoraLoaderModelOnly":
        names.append(g[link[0]]["inputs"]["lora_name"])
        link = g[link[0]]["inputs"]["model"]
    return list(reversed(names))


def test_the_recipe_is_declared_and_names_a_real_adapter(k2):
    ie = k2["identity_edit"]
    assert ie["lora"] in k2["style_loras"]
    assert ie["ref_boost"] >= 1.0


def test_single_source_wires_both_halves_of_the_trained_path(k2):
    g = graphs.krea2_identity_graph(k2, "a wide shot", 7, 1280, 704, subject="sub.png",
                                    identity_lora="krea2_identity_edit_v1_2.safetensors")
    patch = g["30"]["inputs"]
    enc, neg = g["31"]["inputs"], g["32"]["inputs"]
    # the source is BOTH the latent-side tokens and the encoder's grounding
    assert g[patch["source_latent"][0]]["class_type"] == "VAEEncode"
    assert patch["source_image"] == enc["image"] == neg["image"] == ["20", 0]
    assert patch["target_latent"] == g["7"]["inputs"]["latent_image"]
    assert patch["fit_mode"] == "fit" and patch["ref_boost"] == 3.0
    assert enc["prompt"] == "a wide shot" and neg["prompt"] == ""
    assert "source_latent_b" not in patch and "image_b" not in enc
    # the identity adapter leads the MODEL chain and the patch reads it
    assert _lora_chain(g, patch["model"]) == ["krea2_identity_edit_v1_2.safetensors"]
    assert g["7"]["inputs"]["model"] == ["30", 0]
    assert g["7"]["inputs"]["positive"] == ["31", 0]


def test_a_scene_takes_the_main_inputs_and_the_subject_the_b_inputs(k2):
    g = graphs.krea2_identity_graph(k2, "p", 7, 1280, 704, subject="sub.png",
                                    scene="plate.png", identity_lora="id.safetensors",
                                    ref_boost=4.0, scene_boost=0.8)
    patch, enc = g["30"]["inputs"], g["31"]["inputs"]
    assert g[patch["source_image"][0]]["inputs"]["image"] == "plate.png"
    assert g[patch["source_image_b"][0]]["inputs"]["image"] == "sub.png"
    assert g[enc["image"][0]]["inputs"]["image"] == "plate.png"
    assert g[enc["image_b"][0]]["inputs"]["image"] == "sub.png"
    assert patch["ref_boost"] == 4.0 and patch["ref_boost_a"] == 0.8


def test_the_identity_adapter_is_never_stacked_twice(k2):
    g = graphs.krea2_identity_graph(k2, "p", 7, 1280, 704, subject="s.png",
                                    identity_lora="id.safetensors",
                                    loras=[("id.safetensors", 0.5), ("realism.safetensors", 1.0)])
    assert _lora_chain(g, g["30"]["inputs"]["model"]) == ["id.safetensors", "realism.safetensors"]


# ---------------------------------------------------------------- routing --
ROUTE_MAP = {
    "image_models": {
        "krea2": {"family": "krea2", "unet": "k.safetensors", "text_encoder": "t.safetensors",
                  "vae": "v.safetensors", "steps": 8,
                  "style_loras": {"identity": "id.safetensors"},
                  "identity_edit": {"lora": "identity", "ref_boost": 3.0, "grounding_px": 768}},
        "klein": {"family": "klein", "unet": "kl.safetensors"},
        "qwen-edit": {"family": "qwen", "unet": "q.safetensors"},
    },
    "models": {},
}
BUILDERS = ("krea2_identity_graph", "krea2_ref_graph", "krea2_graph",
            "qwen_edit_graph", "flux2_klein_graph")


@pytest.fixture
def run(monkeypatch):
    seen = {}

    def recorder(name):
        def rec(*a, **kw):
            seen["builder"], seen["args"], seen["kwargs"] = name, a, kw
            return {"1": {"class_type": "Stub", "inputs": {}}}
        return rec

    for name in BUILDERS:
        monkeypatch.setattr(images.graphs, name, recorder(name))
    monkeypatch.setattr(images, "_load_map_tier", lambda: ROUTE_MAP)
    monkeypatch.setattr(images, "_node_spec", lambda name: None)
    monkeypatch.setattr(images, "make_tick", lambda job: (lambda *a, **k: None))
    monkeypatch.setattr(images, "_stage_refs",
                        lambda ids, jid: ([f"r{i}.png" for i, _ in enumerate(ids)], []))
    monkeypatch.setattr(images.comfy, "submit", lambda g: "pid")
    monkeypatch.setattr(images.comfy, "wait", lambda pid, on_tick=None: {})
    monkeypatch.setattr(images.comfy, "fetch_output", lambda outs, keys, png: None)
    monkeypatch.setattr(images.media, "b2_put", lambda *a, **k: None)
    monkeypatch.setattr(images.sb, "job_patch", lambda *a, **k: None)
    monkeypatch.setattr(images.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(images.sb, "register_asset", lambda *a, **k: {"id": "asset-1"})
    monkeypatch.setattr(images, "_has_node", lambda name: True)

    def go(payload):
        images.handle_image_gen({"id": "job-1", "payload": payload})
        return seen
    return go


def _spec(subjects):
    return {"kind": "panel", "cast": [], "panels": [],
            "ref_subjects": [{"kind": k, "name": n} for k, n in subjects],
            "refs": [n for _k, n in subjects]}


def test_a_one_character_panel_with_its_plate_takes_the_identity_path_ONLY_WHEN_ASKED(run):
    # Opt-in since the NIGHT SHIFT A/B (2026-09-02): with the plate as the
    # scene latent the identity path reproduced the plate's own wide framing
    # and lost the written medium shot, so the shape alone no longer routes.
    spec = _spec([("character", "Mara"), ("environment", "The shop")])
    got = run({"prompt": "a wide shot", "model_key": "krea2",
               "ref_asset_ids": ["a1", "a2"], "prompt_spec": spec})
    assert got["builder"] == "krea2_ref_graph"
    got = run({"prompt": "a wide shot", "model_key": "krea2",
               "ref_asset_ids": ["a1", "a2"], "prompt_spec": spec, "identity_edit": True})
    assert got["builder"] == "krea2_identity_graph"
    assert got["kwargs"]["subject"] == "r0.png" and got["kwargs"]["scene"] == "r1.png"
    assert got["kwargs"]["identity_lora"] == "id.safetensors"
    assert got["args"][1].startswith("Restage the person from the reference")


def test_a_one_character_still_with_no_plate_is_single_source(run):
    got = run({"prompt": "close-up", "model_key": "krea2", "ref_asset_ids": ["a1"],
               "prompt_spec": _spec([("character", "Mara")]), "identity_edit": True})
    assert got["builder"] == "krea2_identity_graph"
    assert got["kwargs"]["scene"] is None


def test_two_people_keep_the_rebalance_path(run):
    got = run({"prompt": "a two-shot", "model_key": "krea2", "ref_asset_ids": ["a1", "a2"],
               "prompt_spec": _spec([("character", "Mara"), ("character", "Tam")])})
    assert got["builder"] == "krea2_ref_graph"


def test_an_edit_keeps_the_rebalance_path(run):
    got = run({"prompt": "add rain", "model_key": "krea2", "mode": "edit",
               "ref_asset_ids": ["a1"], "prompt_spec": _spec([("character", "Mara")])})
    assert got["builder"] == "krea2_ref_graph"
    assert got["kwargs"]["source_image"] == "r0.png"


def test_free_references_from_the_composer_keep_the_rebalance_path(run):
    got = run({"prompt": "compose", "model_key": "krea2", "ref_asset_ids": ["a1"]})
    assert got["builder"] == "krea2_ref_graph"


def test_the_flag_asks_and_force_insists(run):
    # `identity_edit: true` asks for the path where the job CAN take it (one
    # character in image1, at most one plate); a free composer reference is
    # not that shape, so it stays on the rebalance path unless FORCED.
    got = run({"prompt": "compose", "model_key": "krea2", "ref_asset_ids": ["a1"],
               "identity_edit": True})
    assert got["builder"] == "krea2_ref_graph"
    got = run({"prompt": "compose", "model_key": "krea2", "ref_asset_ids": ["a1"],
               "identity_edit": "force"})
    assert got["builder"] == "krea2_identity_graph"
    got = run({"prompt": "p", "model_key": "krea2", "ref_asset_ids": ["a1"],
               "prompt_spec": _spec([("character", "Mara")]), "identity_edit": False})
    assert got["builder"] == "krea2_ref_graph"


def test_without_the_pack_installed_nothing_changes(run, monkeypatch):
    monkeypatch.setattr(images, "_has_node", lambda name: name == "Krea2EditRebalance")
    got = run({"prompt": "p", "model_key": "krea2", "ref_asset_ids": ["a1"],
               "prompt_spec": _spec([("character", "Mara")])})
    assert got["builder"] == "krea2_ref_graph"


def test_the_panel_spec_spelling_location_is_an_environment():
    """`scene_panel_specs` writes `kind: location` — the spelling that kept the
    identity path dark on the first real storyboard. Both spellings route."""
    from handlers import images as I
    payload = {"prompt_spec": {"ref_subjects": [{"kind": "character", "name": "Elena"},
                                                {"kind": "location", "name": "FORECOURT"}]}}
    assert I._identity_shape(payload, ["a", "b"])
    assert I._identity_order(payload["prompt_spec"], ["elena.png", "plate.png"]) == ("elena.png", "plate.png")
    # location FIRST (a wide, location-led) is still not the shape: image1 is the plate
    wide = {"prompt_spec": {"ref_subjects": [{"kind": "location", "name": "FORECOURT"},
                                             {"kind": "character", "name": "Dev"}]}}
    assert not I._identity_shape(wide, ["a", "b"])

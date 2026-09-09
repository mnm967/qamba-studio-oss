"""SenseNova U1.5 — the first image family whose nodes do their OWN sampling.

There is no KSampler, no VAE, no sigmas and nothing for `resolve.py` to
parameterise by `class_type`, so `graphs.sensenova_graph` writes the whole
graph. Everything pinned here fails SILENTLY when it is wrong:

* the t2i node's size is a COMBO, so an unlisted `WxH|R` string is a validation
  failure at submit — and a legal-looking `2720x1536` with no ratio suffix is
  not in the list;
* the reference path's autogrow key is NAMESPACED (`reference_images.image2`).
  ComfyUI drops an input a class does not declare rather than rejecting it, so
  a bare `image2` renders a ONE-reference picture and says nothing — the same
  trap `hidream_o1_graph` documents for `images.image_N`;
* `cfg_zero_star` exists on the t2i node only and the edit pipeline RAISES on
  it, so a model-level default meant for t2i would kill every reference render;
* the loader must name the /data directory and keep `device_map: none`, or the
  render either re-downloads 35GB into the HF cache or shards a model that fits
  on one card.
"""
import json
import os

import pytest

os.environ.setdefault("MODEL_TIER", "full")

import graphs

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The exact option list `SenseNovaU1LocalTextToImage.resolution` publishes,
# read off the installed node's /object_info rather than transcribed from the
# model card. Every string the builder can emit has to be in here.
NODE_RESOLUTION_OPTIONS = [
    "2048x2048|1:1", "2720x1536|16:9", "1536x2720|9:16", "2496x1664|3:2",
    "1664x2496|2:3", "2368x1760|4:3", "1760x2368|3:4", "1440x2880|1:2",
    "2880x1440|2:1", "1152x3456|1:3", "3456x1152|3:1",
]


@pytest.fixture
def sn():
    with open(os.path.join(ROOT, "infra", "model_map.full.json")) as f:
        return json.load(f)["full"]["image_models"]["sensenova-u1"]


def _node(g, cls):
    return next((n for n in g.values() if n["class_type"] == cls), None)


def test_the_map_entry_names_a_directory_not_a_file_under_comfy_models(sn):
    # It is a transformers checkpoint loaded by the pack's own loader, so it
    # sits outside models/<subdir> on purpose and relink_data.sh must NOT gain
    # a line for it.
    assert sn["family"] == "sensenova"
    assert sn["model_path"].startswith("/data/models/")
    assert not sn["model_path"].endswith(".safetensors")


def test_t2i_uses_the_text_to_image_node_and_no_reference_node(sn):
    g = graphs.sensenova_graph(sn, "a lighthouse", 7, 2720, 1536)
    assert _node(g, "SenseNovaU1LocalTextToImage")
    assert _node(g, "SenseNovaU1LocalImageEdit") is None
    assert _node(g, "LoadImage") is None


def test_every_resolution_the_builder_can_emit_is_one_the_node_offers(sn):
    # Walk the real native list plus a few studio sizes that must snap onto it.
    asks = [d for d in graphs.SENSENOVA_T2I_DIMS] + [
        (1280, 704), (1216, 672), (1024, 1024), (704, 1280), (1920, 1080),
        (832, 1216), (3840, 2160),
    ]
    for w, h in asks:
        g = graphs.sensenova_graph(sn, "x", 0, w, h)
        got = _node(g, "SenseNovaU1LocalTextToImage")["inputs"]["resolution"]
        assert got in NODE_RESOLUTION_OPTIONS, f"{w}x{h} -> {got!r}"


def test_a_landscape_ask_snaps_to_a_landscape_option(sn):
    # The studio's panels are 16:9-ish; snapping one to the 1:1 option would
    # reframe the shot, which is the failure hidream_o1_dims exists to avoid.
    g = graphs.sensenova_graph(sn, "x", 0, 1280, 704)
    assert _node(g, "SenseNovaU1LocalTextToImage")["inputs"]["resolution"] == "2720x1536|16:9"
    g = graphs.sensenova_graph(sn, "x", 0, 704, 1280)
    assert _node(g, "SenseNovaU1LocalTextToImage")["inputs"]["resolution"] == "1536x2720|9:16"


def test_references_switch_to_the_edit_node_with_namespaced_autogrow_keys(sn):
    g = graphs.sensenova_graph(sn, "x", 0, 2720, 1536,
                               refs=["a.png", "b.png", "c.png"])
    edit = _node(g, "SenseNovaU1LocalImageEdit")
    assert edit and _node(g, "SenseNovaU1LocalTextToImage") is None
    ins = edit["inputs"]
    # The primary is a plain `image`; every extra rides the autogrow input.
    assert ins["image"][0] in g and g[ins["image"][0]]["inputs"]["image"] == "a.png"
    assert "reference_images.image2" in ins
    assert "reference_images.image3" in ins
    # A BARE key is the silent failure this test exists for.
    assert "image2" not in ins and "image3" not in ins
    # Numbering starts at 2 — there is no `image1` on the autogrow template.
    assert "reference_images.image1" not in ins


def test_one_reference_stages_no_autogrow_key_at_all(sn):
    g = graphs.sensenova_graph(sn, "x", 0, 2048, 2048, refs=["only.png"])
    ins = _node(g, "SenseNovaU1LocalImageEdit")["inputs"]
    assert not [k for k in ins if k.startswith("reference_images.")]


def test_references_are_capped_at_the_entrys_max_refs(sn):
    many = [f"r{i}.png" for i in range(14)]
    g = graphs.sensenova_graph(sn, "x", 0, 2048, 2048, refs=many)
    ins = _node(g, "SenseNovaU1LocalImageEdit")["inputs"]
    staged = 1 + len([k for k in ins if k.startswith("reference_images.")])
    assert staged == int(sn["max_refs"]) == 10
    assert len([n for n in g.values() if n["class_type"] == "LoadImage"]) == 10


def test_the_edit_path_takes_an_explicit_output_size(sn):
    # Auto sizing takes its aspect from the FIRST input, which on a panel is
    # whichever reference happened to sort first — a character sheet, usually.
    g = graphs.sensenova_graph(sn, "x", 0, 2720, 1536, refs=["a.png"])
    size = _node(g, "SenseNovaU1EditOutputSize")
    assert size["inputs"] == {"preset": "Custom", "width": 2720, "height": 1536}
    assert _node(g, "SenseNovaU1LocalImageEdit")["inputs"]["output_size"][0] == "5"


def test_cfg_zero_star_survives_on_t2i_and_is_coerced_on_the_edit_path(sn):
    t = graphs.sensenova_graph(sn, "x", 0, 2048, 2048, cfg_norm="cfg_zero_star")
    assert _node(t, "SenseNovaU1LocalTextToImage")["inputs"]["cfg_norm"] == "cfg_zero_star"
    e = graphs.sensenova_graph(sn, "x", 0, 2048, 2048, refs=["a.png"],
                               cfg_norm="cfg_zero_star")
    assert _node(e, "SenseNovaU1LocalImageEdit")["inputs"]["cfg_norm"] == "none"


def test_the_loader_names_the_local_path_and_shards_nothing(sn):
    g = graphs.sensenova_graph(sn, "x", 0, 2048, 2048)
    ld = _node(g, "SenseNovaU1LocalLoader")
    assert ld["inputs"]["model_path"] == sn["model_path"]
    # device_map and vram_mode are mutually exclusive; `full` is what makes a
    # warm render 30s instead of minutes of per-layer CPU<->GPU swapping.
    assert ld["inputs"]["device_map"] == "none"
    assert ld["inputs"]["vram_mode"] == "full"
    # An empty gguf selection is what keeps the safetensors path.
    assert ld["inputs"]["gguf_checkpoint"] == ""


def test_payload_overrides_beat_the_map_and_the_map_beats_the_default(sn):
    g = graphs.sensenova_graph(sn, "x", 0, 2048, 2048, steps=8, cfg=2.5)
    ins = _node(g, "SenseNovaU1LocalTextToImage")["inputs"]
    assert ins["num_steps"] == 8 and ins["cfg_scale"] == 2.5
    g = graphs.sensenova_graph(sn, "x", 0, 2048, 2048)
    ins = _node(g, "SenseNovaU1LocalTextToImage")["inputs"]
    assert ins["num_steps"] == sn["steps"] and ins["cfg_scale"] == sn["cfg"]


def test_img_cfg_reaches_the_edit_node_only(sn):
    # There is no image-side guidance on a text-to-image render, and passing
    # the key would be a validation failure rather than a no-op.
    g = graphs.sensenova_graph(sn, "x", 0, 2048, 2048, refs=["a.png"], img_cfg=2.0)
    assert _node(g, "SenseNovaU1LocalImageEdit")["inputs"]["img_cfg_scale"] == 2.0
    g = graphs.sensenova_graph(sn, "x", 0, 2048, 2048)
    assert "img_cfg_scale" not in _node(g, "SenseNovaU1LocalTextToImage")["inputs"]


def test_the_graph_saves_something(sn):
    for refs in ([], ["a.png"]):
        g = graphs.sensenova_graph(sn, "x", 0, 2048, 2048, refs=refs)
        save = _node(g, "SaveImage")
        assert save and save["inputs"]["images"][0] == "2"


def test_the_prompt_shape_for_this_family_is_prose():
    # A comma-tag stack is the shape its own guide likes least: it reads an
    # instruction, and it needs each reference's ROLE named in words.
    import image_prompt
    assert image_prompt.SHAPES["sensenova"] == "prose"

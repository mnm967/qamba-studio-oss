"""Which graph an image_gen job lands on — the decision, not the drawing.

Every bug this file pins down was silent. A job whose references are staged and
then rendered without, or an edit that runs the composition graph, comes back as
a perfectly good image that is simply not what was asked for: no error, no
fallback line, nothing to read afterwards except the picture. So the routing is
asserted here rather than left to be noticed in the library.

The graph builders themselves are covered in test_graphs.py; these tests replace
them with recorders and only ask which one was called, with what.
"""
import pytest

import handlers.images as images

MAP = {
    "image_models": {
        "krea2": {"family": "krea2", "unet": "k.safetensors", "steps": 8},
        "klein": {"family": "klein", "unet": "kl.safetensors"},
        "flux": {"family": "flux", "unet": "f.safetensors", "kontext": "f-kontext.safetensors"},
        "flux2": {"family": "flux2", "unet": "f2.gguf"},
        # the full-precision entry: declares a reference budget, so it keeps
        # its own reference jobs instead of being diverted
        "flux2-dev": {"family": "flux2", "unet": "f2_fp8.safetensors",
                      "text_encoder": "mistral.safetensors", "vae": "v.safetensors",
                      "steps": 20, "max_refs": 4},
        "hikari-anima": {"family": "anima", "unet": "a.safetensors",
                         "text_encoder": "q06.safetensors", "vae": "qvae.safetensors",
                         "steps": 30, "cfg": 4.0,
                         "negative": "worst quality, low quality"},
        # H3 names no files of its own — it borrows the video entry's weights.
        "h3-image": {"family": "h3", "from_model": "minimax-h3", "mode": "r2v",
                     "steps": 20, "image_vae": "h3_t1_image_vae.safetensors",
                     "style_loras": {"thisisfine": "h3_thisisfine.safetensors"}},
    },
    "models": {
        "minimax-h3": {
            "vae": "h3_video_vae.safetensors", "audio_vae": "h3_audio_vae.safetensors",
            "text_encoders": ["qwen3vl.safetensors"],
            "modes": {"i2v": {"checkpoint": "h3_fl2va.safetensors"},
                      "r2v": {"checkpoint": "h3_ref2va.safetensors"}},
        },
    },
}

BUILDERS = ("krea2_ref_graph", "krea2_graph", "flux2_klein_graph", "flux2_ref_graph",
            "flux_kontext_graph", "flux_ref_graph", "h3_image_graph", "anima_graph")


@pytest.fixture
def run(monkeypatch):
    """Run handle_image_gen against stubs; return (builder name, kwargs, model)."""
    seen = {}

    def recorder(name):
        def rec(*a, **kw):
            seen["builder"], seen["args"], seen["kwargs"] = name, a, kw
            return {"1": {"class_type": "Stub", "inputs": {}}}
        return rec

    for name in BUILDERS:
        monkeypatch.setattr(images.graphs, name, recorder(name))
    monkeypatch.setattr(images, "_load_map_tier", lambda: MAP)
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
    def register(*a, **k):
        seen["meta"] = k.get("meta") or {}
        return {"id": "asset-1"}

    monkeypatch.setattr(images.sb, "register_asset", register)

    def go(payload, rebalance=True):
        monkeypatch.setattr(images, "_has_node", lambda name: rebalance)
        images.handle_image_gen({"id": "job-1", "payload": payload})
        return seen

    return go


def test_edit_on_krea2_seeds_the_sampler_with_the_source(run):
    """`mode: edit` is the difference between changing your picture and being
    handed a different one — see test_graphs for what the graph then does."""
    got = run({"prompt": "add more neon", "model_key": "krea2", "mode": "edit",
               "ref_asset_ids": ["a1"], "width": 2720, "height": 1536})
    assert got["builder"] == "krea2_ref_graph"
    assert got["kwargs"]["source_image"] == "r0.png"
    assert got["kwargs"]["denoise"] == 0.55


def test_r2i_on_krea2_still_composes(run):
    got = run({"prompt": "a room", "model_key": "krea2", "mode": "r2i",
               "ref_asset_ids": ["a1", "a2"]})
    assert got["builder"] == "krea2_ref_graph"
    assert got["kwargs"]["source_image"] is None
    assert got["kwargs"]["denoise"] == 1.0


def test_a_job_with_no_mode_composes_as_before(run):
    """Everything that enqueues without a mode — bible sheets, scene stills,
    the planner — must keep the behaviour it had."""
    got = run({"prompt": "ref sheet", "model_key": "krea2", "ref_asset_ids": ["a1"]})
    assert got["kwargs"]["source_image"] is None


def test_edit_on_flux_runs_kontext_not_klein(run):
    """Kontext is the one local graph that starts from the source's own pixels,
    and it was unreachable: any flux job carrying references was swapped to
    Klein, which composes a fresh frame."""
    got = run({"prompt": "make it night", "model_key": "flux", "mode": "edit",
               "ref_asset_ids": ["a1"]})
    assert got["builder"] == "flux_kontext_graph"
    assert got["args"][2] == "r0.png"


def test_flux_with_a_reference_SET_still_falls_back_to_klein(run):
    """Kontext edits one image. A set is a composition, which flux cannot do."""
    got = run({"prompt": "compose these", "model_key": "flux", "mode": "r2i",
               "ref_asset_ids": ["a1", "a2"]})
    assert got["builder"] == "flux2_klein_graph"


def test_flux2_never_renders_a_reference_job_without_the_references(run):
    """flux2_ref_graph takes no references at all, so a flux2 job with refs used
    to stage them, ignore them and render a plain text-to-image."""
    got = run({"prompt": "with this character", "model_key": "flux2",
               "ref_asset_ids": ["a1"]})
    assert got["builder"] == "flux2_klein_graph"


def test_flux2_without_references_is_untouched(run):
    got = run({"prompt": "a city", "model_key": "flux2"})
    assert got["builder"] == "flux2_ref_graph"


def test_krea2_falls_back_to_klein_when_the_node_is_missing(run):
    got = run({"prompt": "p", "model_key": "krea2", "mode": "edit",
               "ref_asset_ids": ["a1"]}, rebalance=False)
    assert got["builder"] == "flux2_klein_graph"


def test_anima_renders_text_to_image(run):
    got = run({"prompt": "1girl, city at night", "model_key": "hikari-anima"})
    assert got["builder"] == "anima_graph"
    assert got["kwargs"]["steps"] == 30


def test_anima_with_references_falls_back_rather_than_ignoring_them(run):
    """Anima is text-to-image only here — its ControlNet/inpainting stack is not
    installed. Same failure mode as plain flux2: staging refs and rendering a
    t2i over them is invisible from the outside."""
    got = run({"prompt": "this character in a bar", "model_key": "hikari-anima",
               "ref_asset_ids": ["a1"]})
    assert got["builder"] == "flux2_klein_graph"


def test_anima_negative_prompt_travels(run):
    """The one local family that is not distilled, so cfg > 1 and the negative
    branch is actually evaluated — a caller's negative must reach the graph."""
    got = run({"prompt": "1girl", "model_key": "hikari-anima",
               "negative": "extra digits"})
    assert got["kwargs"]["negative"] == "extra digits"


def test_the_edit_is_recorded_on_the_asset(run):
    """"Why does this look nothing like the source" has to be answerable from
    the row, not from the log tail of a pod that has since stopped."""
    got = run({"prompt": "add neon", "model_key": "krea2", "mode": "edit",
               "ref_asset_ids": ["a1"]})
    assert got["meta"]["edited_from"] == "a1"
    assert got["meta"]["denoise"] == 0.55
    assert got["meta"]["mode"] == "edit"


def test_flux2_with_a_ref_budget_keeps_its_own_references(run):
    """The GGUF entry still diverts; the fp8 entry does not.

    Diverting was right while `flux2_ref_graph` had no `refs` argument — it
    staged the images and rendered a text-to-image over them, invisible from
    outside. Now the builder chains a ReferenceLatent per image onto both
    conditionings (Klein's path; one architecture), so an entry declaring
    `max_refs` must keep its job and actually RECEIVE the references.
    """
    got = run({"prompt": "with this character", "model_key": "flux2-dev",
               "ref_asset_ids": ["a1", "a2"]})
    assert got["builder"] == "flux2_ref_graph"
    assert len(got["kwargs"].get("refs") or []) == 2, got["kwargs"]
    # the entry with no budget behaves as before
    assert run({"prompt": "x", "model_key": "flux2",
                "ref_asset_ids": ["a1"]})["builder"] == "flux2_klein_graph"


def test_h3_keeps_its_own_references_rather_than_being_diverted(run):
    """H3 takes NINE references — more than anything else local — so it must
    never land in the reference fallback that exists for models with no
    reference path at all."""
    got = run({"prompt": "these three in a bar", "model_key": "h3-image",
               "mode": "r2i", "ref_asset_ids": ["a1", "a2", "a3"]})
    assert got["builder"] == "h3_image_graph"
    assert got["kwargs"]["refs"] == ["r0.png", "r1.png", "r2.png"]
    assert got["kwargs"]["source_image"] is None


def test_h3_edit_of_one_image_sends_it_as_the_source(run):
    """One reference under `edit` is the published single-image edit, which runs
    fl2va from a first_frame — not the reference composition."""
    got = run({"prompt": "age her to 60", "model_key": "h3-image",
               "mode": "edit", "ref_asset_ids": ["a1"]})
    assert got["builder"] == "h3_image_graph"
    assert (got["kwargs"]["source_image"], got["kwargs"]["refs"]) == ("r0.png", None)


def test_a_lora_picked_for_h3_actually_reaches_the_graph(run):
    """It did not: the h3 branch called the builder with no `loras` at all, so a
    pick was resolved, logged and dropped on the floor — the silent no-op this
    codebase keeps getting bitten by."""
    got = run({"prompt": "p", "model_key": "h3-image", "mode": "r2i",
               "ref_asset_ids": ["a1"],
               "loras": [{"key": "thisisfine", "strength": 0.8}]})
    assert got["kwargs"]["loras"] == [("h3_thisisfine.safetensors", 0.8)]


def test_h3_falls_back_when_the_single_frame_vae_is_not_on_the_pod(run, monkeypatch):
    """The node patch rides in on any deploy; the 5.2GB decoder has its own
    fetch target. So "patched but not yet stocked" is a real state, and
    declared-but-absent would fail EVERY H3 image job on a missing VAE — much
    worse than the softness the file exists to fix."""
    patched = {"input": {"required": {
        "length": ["INT", {"default": 124, "min": 1, "max": 3600, "step": 1}]}}}
    monkeypatch.setattr(images, "_node_spec", lambda name: patched)

    monkeypatch.setattr(images.os.path, "exists", lambda p: False)
    absent = run({"prompt": "p", "model_key": "h3-image"})
    assert "image_vae" not in absent["args"][0]

    monkeypatch.setattr(images.os.path, "exists", lambda p: True)
    present = run({"prompt": "p", "model_key": "h3-image"})
    assert present["args"][0]["image_vae"] == "h3_t1_image_vae.safetensors"


def test_h3_steps_stay_unset_so_the_entrys_own_recipe_wins(run):
    """`steps` must reach the builder as None when nobody asked for one — the
    turbo entries carry a step count PER ADAPTER, and a handler-side default of
    20 would overwrite the distillation's 4 or 8 every time."""
    got = run({"prompt": "p", "model_key": "h3-image"})
    assert got["kwargs"]["steps"] is None
    assert run({"prompt": "p", "model_key": "h3-image",
                "steps": 12})["kwargs"]["steps"] == 12


def test_the_flux2_loader_follows_the_file_not_the_family():
    """One family, two loaders: the GGUF needs UnetLoaderGGUF and the fp8
    safetensors needs the stock UNETLoader. Hardcoding either makes the other
    fail at load with only a node error to go on."""
    import graphs
    gguf = graphs.flux2_ref_graph({"unet": "flux2-dev-Q4_K_M.gguf", "text_encoder": "t",
                                   "vae": "v"}, "p", 1, 1280, 704)
    fp8 = graphs.flux2_ref_graph({"unet": "flux2_dev_fp8mixed.safetensors",
                                  "text_encoder": "t", "vae": "v"}, "p", 1, 1280, 704)
    assert gguf["1"]["class_type"] == "UnetLoaderGGUF"
    assert fp8["1"]["class_type"] == "UNETLoader"
    withrefs = graphs.flux2_ref_graph({"unet": "x.safetensors", "text_encoder": "t", "vae": "v"},
                                      "p", 1, 1280, 704, refs=["a.png", "b.png"])
    assert sum(1 for n in withrefs.values()
               if n["class_type"] == "ReferenceLatent") == 4      # 2 refs x pos+neg

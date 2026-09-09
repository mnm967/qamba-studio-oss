"""LTX 2.5's four modes, through the REAL `resolve()` and the REAL templates.

`ltx25_i2v.json` and `ltx25_flf.json` are GENERATED from the t2v template — the
loaders, the two `ManualSigmas` schedules and the audio branch are copied rather
than retyped, so they cannot drift from the mode that is known to render. What
generation cannot check is the part `resolve()` does at build time, and that is
what is here.

THE BUG THESE PIN. `resolve()` finds the start and end stills by looking for a
consumer whose INPUT IS NAMED `start_image`/`first_frame` or
`end_image`/`last_frame` — MiniMax H3's spelling. Core's `LTXVAddGuide` calls
its picture `image` at BOTH ends of the clip and says which end it means in
`frame_idx`. So name-matching finds neither, the "anything else gets the source
image" fallback fires, and an flf render pins the START frame at both ends: a
graph that validates, submits, samples and returns a clip whose last frame is
its first. Nothing logs it.
"""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import resolve as R  # noqa: E402

MAP = json.load(open(os.path.join(REPO, "infra", "model_map.full.json"), encoding="utf-8"))
ENTRY = MAP["full"]["models"]["ltx-25"]


@pytest.fixture(autouse=True)
def _pod(monkeypatch):
    """The pod tier, the real templates, and no disk check.

    `ensure_model` asks the filesystem for 38GB of LTX; these tests are about
    which value lands in which input, so it is stubbed the same way
    `test_gguf_checkpoint.py` does.
    """
    monkeypatch.setattr(R, "TIER", "full")
    monkeypatch.setattr(R, "load_map", lambda: MAP)
    monkeypatch.setattr(R, "WORKFLOWS_DIR", os.path.join(REPO, "workflows"))
    monkeypatch.setattr(R, "ensure_model", lambda *a, **k: None)


def build(mode, **kw):
    args = dict(positive="a wet street at night", negative="", seed=42,
                width=1280, height=704, length=0, exact_frames=121, mm=MAP)
    args.update(kw)
    return R.resolve("ltx-25", mode, **args)


def by_class(g, ct):
    return [(k, n) for k, n in g.items() if n.get("class_type") == ct]


@pytest.mark.parametrize("mode", ["t2v", "i2v", "flf", "r2v"])
def test_every_declared_mode_builds_and_writes_a_file(mode):
    kw = {}
    if mode in ("i2v", "flf"):
        kw["source_image"] = "start.png"
    if mode == "flf":
        kw["end_image"] = "end.png"
    if mode == "r2v":
        kw["ref_images"] = ["a.png"]
    out = build(mode, **kw)
    assert out["workflow"] == f"ltx25_{mode}.json"
    assert out["outputs"], "a graph with no output node publishes nothing"


def test_the_first_pass_samples_at_half_size():
    # `latent_scale: 0.5` is the distilled recipe: sample small, upsample,
    # refine. `dim_step` 64 is what makes 2x(half) land exactly back on the
    # requested size, so there is no resize node anywhere in the graph.
    g = build("t2v")["graph"]
    _, latent = by_class(g, "EmptyLTXVLatentVideo")[0]
    assert (latent["inputs"]["width"], latent["inputs"]["height"]) == (640, 352)
    assert len(by_class(g, "LTXVLatentUpsampler")) == 1
    assert ENTRY["latent_scale"] == 0.5 and ENTRY["dim_step"] == 64


def test_flf_pins_two_DIFFERENT_pictures():
    """The one that matters — see the module docstring."""
    g = build("flf", source_image="start.png", end_image="end.png")["graph"]
    loads = {k: n["inputs"]["image"] for k, n in by_class(g, "LoadImage")}
    assert len(loads) == 2, "first-and-last needs two pictures"
    assert sorted(loads.values()) == ["end.png", "start.png"], (
        "both guides got the same picture — `resolve()` fell through to its "
        "'anything else gets the source image' branch, which is what happens "
        "when the end still is identified by INPUT NAME rather than frame_idx")

    # …and each is pinned at the end it belongs to, in BOTH passes.
    at = {}
    for _k, n in by_class(g, "LTXVAddGuide"):
        at.setdefault(loads[n["inputs"]["image"][0]], set()).add(n["inputs"]["frame_idx"])
    assert at["start.png"] == {0}
    assert at["end.png"] == {-1}


def test_a_guide_is_cropped_before_anything_reads_the_latent():
    # A guide is PREPENDED to the latent. Left in, pass 1's guides are
    # upsampled and pass 2 pins its own on top of them, and the decode emits
    # frames nobody asked for — a clip that is right apart from stills at the
    # front.
    g = build("i2v", source_image="start.png")["graph"]
    crops = by_class(g, "LTXVCropGuides")
    assert len(crops) == 2, "one per pass"
    _, ups = by_class(g, "LTXVLatentUpsampler")[0]
    _, dec = by_class(g, "VAEDecode")[0]
    assert ups["inputs"]["samples"][0] in {k for k, _ in crops}
    assert dec["inputs"]["samples"][0] in {k for k, _ in crops}
    # The AUDIO decode reads the SEPARATE — `LTXVCropGuides` is a video-latent
    # concept and has no audio half to hand back.
    _, aud = by_class(g, "LTXVAudioVAEDecode")[0]
    assert aud["inputs"]["samples"][0] in {k for k, _ in by_class(g, "LTXVSeparateAVLatent")}


def test_t2v_carries_no_guide_machinery_at_all():
    g = build("t2v")["graph"]
    assert not by_class(g, "LTXVAddGuide")
    assert not by_class(g, "LTXVCropGuides")
    assert not by_class(g, "LoadImage")


def test_both_passes_sample_and_the_second_continues_the_first():
    # The audio is the half that is easy to lose: a second empty audio latent
    # for pass 2 builds a graph that samples and decodes perfectly and throws
    # the first pass's soundtrack away.
    g = build("t2v")["graph"]
    assert len(by_class(g, "SamplerCustomAdvanced")) == 2
    assert len(by_class(g, "LTXVEmptyLatentAudio")) == 1
    seps = by_class(g, "LTXVSeparateAVLatent")
    concat2 = by_class(g, "LTXVConcatAVLatent")[1][1]
    assert concat2["inputs"]["audio_latent"] == [seps[0][0], 1]


def test_the_new_templates_did_not_drift_from_the_one_that_renders():
    # They are generated from `ltx25_t2v.json`, so the parts that were COPIED
    # must still be identical — a hand-edit to one of them is how a mode ends
    # up on a different schedule or a different encoder from its siblings.
    def load(name):
        with open(os.path.join(REPO, "workflows", name), encoding="utf-8") as fh:
            return json.load(fh)
    t2v = load("ltx25_t2v.json")
    for mode in ("i2v", "flf"):
        g = load(f"ltx25_{mode}.json")
        for nid in ("1", "2", "3", "4", "5", "10", "12", "13", "14", "20", "21", "22"):
            assert g[nid] == t2v[nid], f"ltx25_{mode}.json node {nid} drifted from t2v"


# --------------------------------------------------------------- the refine ---
#
# `apply_ltx_refine` is a POST-CHAIN pass, not a mode — LTX 2.5 run over
# finished footage instead of over its own first pass. It is the one consumer
# of this entry that has nothing to do with rendering a clip, and it was the
# thing most at risk from declaring `extra_nodes` on the entry: had it gone
# through `ensure_model`, every refine on the box would have started demanding
# a node pack it does not use.

def test_the_refine_pass_reads_the_entry_but_not_its_modes():
    """It takes the FRAME GRID and the files, and nothing mode-shaped.

    So adding `i2v`/`flf` to `modes` cannot reach it, and neither can
    `extra_nodes`: it never calls `ensure_model` or `resolve()` at all — it
    builds its graph straight from the entry dict.
    """
    src = open(os.path.join(HERE, "handlers", "post.py"), encoding="utf-8").read()
    body = src.split("def apply_ltx_refine(")[1].split("\ndef ")[0]
    assert "ensure_model" not in body, (
        "the refine pass would start demanding ltx-25's node packs, which it "
        "does not use — its own `_require_nodes` names the three core classes "
        "it needs")
    assert "R.resolve(" not in body, "it builds its graph directly, not through resolve()"
    assert 'graphs.ltx_refine_graph(' in body


def test_the_refine_pass_needs_only_core_nodes():
    # `_require_nodes` is what stands between a refine and a failure deep in
    # ComfyUI. All three are core (`comfy_extras/nodes_lt*.py`) — none is from
    # liconstudio's MSR pack, which is r2v's alone.
    src = open(os.path.join(HERE, "handlers", "post.py"), encoding="utf-8").read()
    body = src.split("def apply_ltx_refine(")[1].split("\ndef ")[0]
    # The list is built conditionally — a mode only demands the nodes it uses,
    # so a native-size refine does not fail on an absent upsampler — so the
    # requirement is the whole `need` block, not one call's arguments.
    req = body.split("need = [")[1].split("_require_nodes(")[0]
    assert "MSR" not in req, "the refine pass must not depend on the reference pack"
    # Every name here is core: nodes_lt*.py for the four LTX ones, nodes.py
    # for ImageScale, nodes.py for VAEDecodeTiled. If a mode ever needs a pack,
    # it needs a `postChain.ts` availability note with it.
    for cls in ("LTXVLatentUpsampler", "LTXVConcatAVLatent", "LTXVAudioVAEEncode",
                "ImageScale", "VAEDecodeTiled"):
        assert cls in req, cls


def test_the_frame_grid_the_refine_pads_to_is_still_the_entrys():
    # `apply_ltx_refine` pads its input UP to `frame_base`/`frame_rem` and cuts
    # the padding off the result, so the pass cannot change how long a clip is.
    # Those two keys are read off this entry — a mode change must not disturb
    # them, and this is the assertion that says so.
    assert ENTRY["frame_base"] == 8 and ENTRY["frame_rem"] == 1 and ENTRY["fps"] == 24

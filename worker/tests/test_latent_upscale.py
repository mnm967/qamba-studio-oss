"""The latent-upscale second pass: a small first pass, a learned latent
resize, the schedule's tail at full size — and PDD-safe, because it never
invents a sigma.

Every failure here is silent in the output: a graph whose first pass quietly
stayed full size renders fine and merely costs what it always did; one whose
audio came from the re-sampled pass renders fine with a different
soundtrack. So the wiring is pinned, on the plain row and on PDD.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MAP = os.path.join(ROOT, "infra", "model_map.full.json")
os.environ.setdefault("MODEL_TIER", "full")
os.environ.setdefault("WORKFLOWS_DIR", os.path.join(ROOT, "workflows"))

import resolve as R  # noqa: E402


@pytest.fixture
def full(monkeypatch):
    with open(MAP) as f:
        data = json.load(f)
    monkeypatch.setattr(R, "ensure_model",
                        lambda model, mm=None: data["full"]["models"][model])
    monkeypatch.setattr(R, "TIER", "full")
    return data


@pytest.fixture
def build(full):
    def _build(model="minimax-h3", mode="t2v", **kw):
        kw.setdefault("mm", full)
        kw.setdefault("positive", "x")
        kw.setdefault("negative", "")
        kw.setdefault("seed", 42)
        kw.setdefault("width", 1280)
        kw.setdefault("height", 736)
        kw.setdefault("length", 192)
        kw.setdefault("exact_frames", 192)
        if mode == "r2v":
            kw.setdefault("ref_images", ["a.png"])
        return R.resolve(model, mode, **kw)["graph"]
    return _build


def of(g, cls):
    return [nid for nid, n in g.items() if n.get("class_type") == cls]


def builder(g):
    return next(n for n in g.values()
                if n.get("class_type") in ("MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"))


def test_every_h3_row_declares_the_recipe(full):
    for k, m in full["full"]["models"].items():
        if k.startswith("minimax-h3"):
            assert m.get("latent_upscale"), k


def test_first_pass_dims_keep_the_aspect_on_the_grid():
    spec = R.LATENT_UPSCALE_DEFAULTS
    w, h = R.first_pass_dims(1280, 736, spec)
    assert w % 32 == 0 and h % 32 == 0
    assert 0.30 <= w * h / 1e6 <= 0.42, (w, h)
    assert abs(w / h - 1280 / 736) < 0.08
    # never larger than the target
    assert R.first_pass_dims(640, 352, spec) == (640, 352)


def test_off_by_default(build):
    g = build()
    assert not of(g, "MinimaxH3LatentUpscaler3D")
    assert builder(g)["inputs"]["width"] == 1280


def test_it_samples_small_then_upscales_to_the_requested_size(build):
    g = build(latent_upscale=True)
    b = builder(g)
    assert (b["inputs"]["width"], b["inputs"]["height"]) != (1280, 736)
    assert b["inputs"]["width"] * b["inputs"]["height"] < 0.5 * 1280 * 736
    up = g[of(g, "MinimaxH3LatentUpscaler3D")[0]]["inputs"]
    assert (up["mode.width"], up["mode.height"]) == (1280, 736)
    assert up["mode"] == "target dimensions"
    assert up["model_name"] == R.LATENT_UPSCALE_DEFAULTS["model"]


def test_the_video_half_is_upscaled_and_the_audio_half_carried_across(build):
    g = build(latent_upscale=True)
    sep = of(g, "LTXVSeparateAVLatent")[0]
    up = g[of(g, "MinimaxH3LatentUpscaler3D")[0]]["inputs"]
    cat = g[of(g, "LTXVConcatAVLatent")[0]]["inputs"]
    assert up["latent"] == [sep, 0]
    assert cat["video_latent"][0] == of(g, "MinimaxH3LatentUpscaler3D")[0]
    assert cat["audio_latent"] == [sep, 1]


def test_pass_two_reads_the_tail_of_the_same_schedule(build):
    g = build(latent_upscale=True)
    samplers = of(g, "SamplerCustomAdvanced")
    assert len(samplers) == 2
    first, second = samplers
    split = of(g, "SplitSigmasDenoise")[0]
    # pass 1 keeps the WHOLE schedule; pass 2 takes the low sigmas
    assert g[first]["inputs"]["sigmas"] == g[split]["inputs"]["sigmas"]
    assert g[second]["inputs"]["sigmas"] == [split, 1]
    assert g[split]["inputs"]["denoise"] == R.LATENT_UPSCALE_DEFAULTS["denoise"]
    # same guider, same sampler object, fresh noise
    assert g[second]["inputs"]["guider"] == g[first]["inputs"]["guider"]
    assert g[second]["inputs"]["sampler"] == g[first]["inputs"]["sampler"]
    assert g[second]["inputs"]["noise"] != g[first]["inputs"]["noise"]


def test_the_picture_comes_from_pass_two_and_the_sound_from_pass_one(build):
    g = build(latent_upscale=True)
    first, second = of(g, "SamplerCustomAdvanced")
    vdec = g[of(g, "VAEDecode")[0]]["inputs"]
    adec = g[of(g, "VAEDecodeAudio")[0]]["inputs"]
    assert vdec["samples"] == [second, 0]
    assert adec["samples"] == [first, 0]


def test_pdd_splits_its_own_trained_sigmas(build):
    g = build("minimax-h3-pdd", "r2v", latent_upscale=True)
    pdd = of(g, "MiniMaxH3PDDAccApply")[0]
    split = of(g, "SplitSigmasDenoise")[0]
    first, second = of(g, "SamplerCustomAdvanced")
    assert g[split]["inputs"]["sigmas"] == [pdd, 1]
    assert g[first]["inputs"]["sigmas"] == [pdd, 1]
    assert g[second]["inputs"]["sigmas"] == [split, 1]
    # and the guider still reads the PDD-patched model
    guider = g[g[second]["inputs"]["guider"][0]]
    assert guider["inputs"]["model"][0] == pdd


def test_it_does_not_stack_with_the_other_second_passes(build):
    with pytest.raises(R.ResolveError):
        build(latent_upscale=True, refine=True)
    with pytest.raises(R.ResolveError):
        build(latent_upscale=True, split_pass=True)


def test_a_model_with_no_recipe_raises(build, full):
    full["full"]["models"]["minimax-h3"].pop("latent_upscale")
    with pytest.raises(R.ResolveError):
        build(latent_upscale=True)


def test_a_dict_overrides_individual_keys(full):
    spec = R.latent_upscale_spec(full["full"]["models"]["minimax-h3"],
                                 {"denoise": 0.3, "first_pass_mp": None})
    assert spec["denoise"] == 0.3
    assert spec["first_pass_mp"] == 0.35


def test_the_block_carries_the_flag():
    import handlers.blocks as B
    assert "latent_upscale" in B._BLOCK_FLAGS

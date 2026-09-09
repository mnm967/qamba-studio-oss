"""The low-sigma second pass: one schedule, split, tail at reduced strength.

Every failure here is silent in the output file — a graph that samples the
whole schedule at full adapter strength renders fine and just looks like the
pass did nothing, which is the silent-downgrade shape this codebase keeps
naming.
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
    # off-pod: no checkpoints on disk and no `fetchmodel` to shell out to. Same
    # stand-down the style-splice tests use.
    monkeypatch.setattr(R, "ensure_model",
                        lambda model, mm=None: data["full"]["models"][model])
    monkeypatch.setattr(R, "TIER", "full")
    return data


@pytest.fixture
def mm(full):
    return full["full"]["models"]


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
        return R.resolve(model, mode, **kw)["graph"]
    return _build


def of(g, cls):
    return [nid for nid, n in g.items() if n.get("class_type") == cls]


# --- the recipe -----------------------------------------------------------

def test_every_h3_entry_that_can_refine_can_also_split(mm):
    """Both are second passes over the same graph shape. An entry offering one
    and not the other is an accident, not a decision."""
    for name, spec in mm.items():
        if "refine" in spec:
            assert "split_pass" in spec, f"{name} declares refine but not split_pass"


def test_a_model_with_no_recipe_raises_rather_than_rendering_one_pass(build, mm):
    """The refine rule, restated: a second pass that silently did not happen
    costs the same as it always did and returns a take nobody can tell from an
    unsplit one."""
    assert R.split_pass_spec({}, True) is None
    with pytest.raises(R.ResolveError, match="declares no `split_pass`"):
        build("wan2.2", "i2v", split_pass=True, source_image="a.png")


def test_off_by_default(build, mm):
    g = build()
    assert not of(g, "SplitSigmasDenoise")
    assert not of(g, "ExtendIntermediateSigmas")
    assert len(of(g, "SamplerCustomAdvanced")) == 1


def test_a_dict_overrides_individual_keys(mm):
    spec = R.split_pass_spec(mm["minimax-h3"], {"split": 0.4})
    assert spec["split"] == 0.4
    assert spec["lora_scale"] == 0.65      # untouched keys keep the recipe


# --- the graph ------------------------------------------------------------

def test_it_splits_one_schedule_and_adds_a_second_sampler(build):
    g = build(split_pass=True)
    ext, split = of(g, "ExtendIntermediateSigmas"), of(g, "SplitSigmasDenoise")
    assert len(ext) == 1 and len(split) == 1
    samplers = of(g, "SamplerCustomAdvanced")
    assert len(samplers) == 2
    # extend hangs off BasicScheduler, split off extend
    assert g[ext[0]]["inputs"]["sigmas"][0] == of(g, "BasicScheduler")[0]
    assert g[split[0]]["inputs"]["sigmas"][0] == ext[0]


def test_stage_one_takes_high_sigmas_and_stage_two_takes_low(build):
    """SplitSigmasDenoise returns (high_sigmas, low_sigmas). Crossing the slots
    samples the tail first and renders noise."""
    g = build(split_pass=True)
    split = of(g, "SplitSigmasDenoise")[0]
    stage2 = next(nid for nid, n in g.items()
                  if n.get("class_type") == "SamplerCustomAdvanced"
                  and R._islink(n["inputs"].get("latent_image"))
                  and g.get(n["inputs"]["latent_image"][0], {}).get("class_type")
                  == "SamplerCustomAdvanced")
    stage1 = g[stage2]["inputs"]["latent_image"][0]
    assert g[stage1]["inputs"]["sigmas"] == [split, 0], "stage 1 must take high_sigmas"
    assert g[stage2]["inputs"]["sigmas"] == [split, 1], "stage 2 must take low_sigmas"


def test_stage_two_adds_no_noise(build):
    """It continues stage 1's trajectory. RandomNoise there would restart it."""
    g = build(split_pass=True)
    assert len(of(g, "DisableNoise")) == 1
    stage2 = next(nid for nid, n in g.items()
                  if n.get("class_type") == "SamplerCustomAdvanced"
                  and g.get(R._islink(n["inputs"].get("noise")) and
                            n["inputs"]["noise"][0], {}).get("class_type")
                  == "DisableNoise")
    assert R._islink(g[stage2]["inputs"]["latent_image"])
    src = g[g[stage2]["inputs"]["latent_image"][0]]
    assert src["class_type"] == "SamplerCustomAdvanced"


def test_both_stages_share_one_sampler_object(build):
    """Turbo REPLACES KSamplerSelect in place, so a second sampler node would
    silently give stage 2 the stock one."""
    g = build("minimax-h3-turbo", split_pass=True)
    samplers = of(g, "SamplerCustomAdvanced")
    picks = {tuple(g[s]["inputs"]["sampler"]) for s in samplers}
    assert len(picks) == 1, "the two stages must read the same sampler node"


# --- the point of the whole thing ----------------------------------------

def test_stage_two_runs_the_adapters_turned_down(build):
    """This IS the feature. Same file, lower strength, on a duplicated chain —
    mutating the original instead would turn stage 1 down too."""
    g = build(split_pass=True, loras=[{"key": "combat", "strength": 1.0}])
    combat = [n for n in g.values()
              if n.get("class_type") == "LoraLoaderModelOnly"
              and n["inputs"].get("lora_name") == "h3_combat_v2.safetensors"]
    assert len(combat) == 2, "one node per stage"
    strengths = sorted(round(float(n["inputs"]["strength_model"]), 3) for n in combat)
    assert strengths == [0.65, 1.0], strengths


def test_the_distillation_is_turned_down_further_than_the_concept_lora(build):
    """Two scales, because the author reduces them by different amounts."""
    g = build("minimax-h3-turbo", split_pass=True,
              loras=[{"key": "combat", "strength": 1.0}])
    turbo = [n for n in g.values() if "Turbo" in (n.get("class_type") or "")
             and "strength" in (n.get("inputs") or {})]
    assert len(turbo) == 2
    assert sorted(round(float(n["inputs"]["strength"]), 3) for n in turbo) == [0.29, 1.0]


def test_stage_one_keeps_full_strength(build):
    g = build(split_pass=True, loras=[{"key": "combat", "strength": 1.0}])
    guiders = of(g, "BasicGuider")
    assert len(guiders) == 2
    # the guider whose chain reaches the loader through a 1.0 adapter is stage 1
    fulls = []
    for gid in guiders:
        loader, chain = R._model_chain(g, g[gid]["inputs"]["model"])
        assert loader is not None
        fulls.append(max(float(g[a]["inputs"].get("strength_model",
                                                  g[a]["inputs"].get("strength", 0)))
                         for a in chain) if chain else 0.0)
    assert 1.0 in fulls, "one stage must still run at full strength"


def test_both_stages_read_the_same_conditioning(build):
    g = build(split_pass=True)
    conds = {tuple(g[gid]["inputs"]["conditioning"]) for gid in of(g, "BasicGuider")}
    assert len(conds) == 1


# --- the audio rule, which is the opposite of refine's --------------------

def test_the_audio_comes_from_stage_two(build):
    """The documented difference from `refine`.

    There the audio deliberately keeps reading pass 1, because pass 2 is a
    RE-NOISED second render. Here stage 2 is the same denoise continuing, so
    its latent is the finished trajectory for both streams — reading audio off
    stage 1 would decode a half-denoised waveform.
    """
    g = build(split_pass=True)
    stage2 = next(nid for nid, n in g.items()
                  if n.get("class_type") == "SamplerCustomAdvanced"
                  and g.get(R._islink(n["inputs"].get("noise")) and
                            n["inputs"]["noise"][0], {}).get("class_type")
                  == "DisableNoise")
    for cls in ("VAEDecode", "VAEDecodeAudio"):
        for nid in of(g, cls):
            assert g[nid]["inputs"]["samples"] == [stage2, 0], \
                f"{cls} must read the finished latent, not the half-denoised one"


# --- interaction with the other second pass -------------------------------

def test_split_and_refine_are_refused_together(build):
    with pytest.raises(R.ResolveError, match="alternative"):
        build(split_pass=True, refine=True)


def test_refine_alone_still_works(build):
    g = build(refine=True)
    assert len(of(g, "SamplerCustomAdvanced")) == 2
    assert not of(g, "SplitSigmasDenoise")


def test_the_block_carries_the_flag():
    """An episode splits its schedule consistently or not at all — the same
    reasoning as motion_ctx and refine."""
    import handlers.blocks as B
    assert "split_pass" in B._BLOCK_FLAGS
    assert B._block_params({"split_pass": True})["split_pass"] is True


# --- the fl2va+ref2va hybrid ---------------------------------------------

def test_the_hybrid_is_r2v_only(mm):
    """It exists to be used AS ref2va — fl2va's image/audio character with
    ref2va's reference consistency. Declaring i2v/t2v/flf would offer a
    dequantised detour to the picture plain fl2va already renders. Same
    reasoning minimax-h3-hybrid uses to exclude r2v."""
    e = mm["minimax-h3-hybrid"]
    assert list(e["modes"]) == ["r2v"]
    assert "hybrid" in e["modes"]["r2v"]["checkpoint"]


def test_the_hybrid_keeps_the_h3_grid_and_both_second_passes(mm):
    """It is the same architecture, so a caller must not have to special-case
    the frame grid or lose the passes by switching to it."""
    base, e = mm["minimax-h3"], mm["minimax-h3-hybrid"]
    for k in ("fps", "frame_base", "frame_rem", "dim_step", "vae", "audio_vae"):
        assert e[k] == base[k], k
    assert "split_pass" in e and "refine" in e
    assert e["style_loras"].keys() == base["style_loras"].keys()


def test_the_hybrid_declares_no_turbo(mm):
    """The distillations here are trained against fl2va/ref2va, not against a
    dequantised-modulation merge. Declaring one would sample a schedule the
    adapter never saw and say nothing about it."""
    assert "turbo_lora" not in mm["minimax-h3-hybrid"]

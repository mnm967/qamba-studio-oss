"""The H3 two-pass refinement.

Adapted from vrgamedevgirl's `minimax_ref2video_2pass_audio_driven` graph:
sample, decode, upscale, re-encode, sample again at low denoise. It is a
RENDER PARAMETER rather than a model row on purpose — refinement is orthogonal
to checkpoint, style and distillation, and a twin of each of the six H3 rows is
twelve near-identical picker entries, which is the failure `style_loras`
already exists to avoid.
"""
import json
import os

import pytest

import resolve as R

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def mm(monkeypatch):
    with open(os.path.join(ROOT, "infra", "model_map.full.json")) as f:
        full = json.load(f)
    monkeypatch.setattr(R, "ensure_model", lambda model, mm=None: full["full"]["models"][model])
    monkeypatch.setattr(R, "TIER", "full")
    return full


def _r2v(mm, model="minimax-h3", **kw):
    kw.setdefault("width", 1280)
    kw.setdefault("height", 736)
    kw.setdefault("ref_images", ["face.png"])
    kw.setdefault("seed", 7)
    return R.resolve(model, "r2v", positive="a quiet street", negative="",
                     length=124, exact_frames=124, mm=mm, **kw)


def _classes(res):
    return [n["class_type"] for n in res["graph"].values() if isinstance(n, dict)]


def test_without_refine_the_graph_is_exactly_one_pass(mm):
    g = _r2v(mm)["graph"]
    assert [n["class_type"] for n in g.values()].count("SamplerCustomAdvanced") == 1
    assert "NeonH3RefineLatent" not in _classes(_r2v(mm))


def test_refine_adds_a_second_sampler_that_reads_the_rebuilt_av_latent(mm):
    res = _r2v(mm, refine=True)
    g = res["graph"]
    samplers = [nid for nid, n in g.items()
                if n["class_type"] == "SamplerCustomAdvanced"]
    assert len(samplers) == 2
    cat = next(nid for nid, n in g.items() if n["class_type"] == "NeonH3RefineLatent")
    # the second pass samples the rebuilt latent
    second = next(nid for nid in samplers if g[nid]["inputs"]["latent_image"] == [cat, 0])
    first = next(nid for nid in samplers if nid != second)
    # ... which is built from the FIRST pass's audio and an upscaled picture
    assert g[cat]["inputs"]["av_latent"] == [first, 0]
    enc = g[cat]["inputs"]["video_latent"][0]
    assert g[enc]["class_type"] == "VAEEncode"
    up = g[enc]["inputs"]["pixels"][0]
    assert g[up]["class_type"] == "ImageScale"
    dec = g[up]["inputs"]["image"][0]
    assert g[dec]["class_type"] == "VAEDecode"
    assert g[dec]["inputs"]["samples"] == [first, 0]


def _passes(g):
    cat = next(nid for nid, n in g.items() if n["class_type"] == "NeonH3RefineLatent")
    second = next(nid for nid, n in g.items()
                  if n["class_type"] == "SamplerCustomAdvanced"
                  and n["inputs"]["latent_image"] == [cat, 0])
    first = next(nid for nid, n in g.items()
                 if n["class_type"] == "SamplerCustomAdvanced" and nid != second)
    return first, second


def test_the_PICTURE_comes_from_pass_two(mm):
    """The whole point. Leaving the video decode pointed at pass 1 is a job
    that costs a second pass and delivers the first one's picture — silent,
    and indistinguishable from the refine being switched off."""
    g = _r2v(mm, refine=True)["graph"]
    first, second = _passes(g)
    out = [n for nid, n in g.items()
           if n["class_type"] == "VAEDecode"
           and any(c["inputs"].get("images") == [nid, 0]
                   for c in g.values() if isinstance(c, dict))]
    assert out, "the template's own video decode"
    for n in out:
        assert n["inputs"]["samples"] == [second, 0]


def test_the_SOUND_comes_from_pass_one(mm):
    """Measured, not assumed: with the audio decoded from the refined latent a
    4.5s block's soundtrack came back at 0.937 correlation and 8.9 dB SNR
    against the take it refines — a different render, not a re-encode
    artifact. `freeze_audio`'s zero mask does not promise otherwise; in
    vrgamedevgirl's own AudioDrive the mask exists so the VIDEO conditions on
    unperturbed audio and she re-MUXES the original waveform afterwards. Pass
    1's audio is our equivalent of that waveform, so decoding it there makes
    "the refined take sounds like the take it refines" true by construction."""
    g = _r2v(mm, refine=True)["graph"]
    first, second = _passes(g)
    aud = [n for n in g.values() if n["class_type"] == "VAEDecodeAudio"]
    assert aud, "the template's own audio decode"
    for n in aud:
        assert n["inputs"]["samples"] == [first, 0]


def test_both_passes_share_one_guider_and_one_sampler_choice(mm):
    """Her graph has two BasicGuiders and both read one model and one
    conditioning, so the second is decoration. Re-encoding the conditioning at
    the larger size would also be wrong: the references and prompt are the
    same shot."""
    g = _r2v(mm, refine=True)["graph"]
    samplers = [n for n in g.values() if n["class_type"] == "SamplerCustomAdvanced"]
    assert len({tuple(n["inputs"]["guider"]) for n in samplers}) == 1
    assert len({tuple(n["inputs"]["sampler"]) for n in samplers}) == 1
    # ... but NOT one schedule: the refine pass is the low-denoise one
    assert len({tuple(n["inputs"]["sigmas"]) for n in samplers}) == 2


def test_the_refine_schedule_is_short_and_low_denoise_and_snaps_to_32(mm):
    g = _r2v(mm, refine=True, width=1280, height=736)["graph"]
    cat = next(nid for nid, n in g.items() if n["class_type"] == "NeonH3RefineLatent")
    second = next(n for n in g.values()
                  if n["class_type"] == "SamplerCustomAdvanced"
                  and n["inputs"]["latent_image"] == [cat, 0])
    sig = g[second["inputs"]["sigmas"][0]]
    assert sig["inputs"]["steps"] == 4 and sig["inputs"]["denoise"] == 0.2
    up = next(n for n in g.values() if n["class_type"] == "ImageScale")
    assert up["inputs"]["width"] == 1600 and up["inputs"]["height"] == 928
    assert up["inputs"]["width"] % 32 == 0 and up["inputs"]["height"] % 32 == 0


def test_the_refine_scheduler_reads_the_same_model_the_first_one_does(mm):
    """H3's sigmas come off BasicScheduler, so a refine pass built against the
    bare loader would sample a turbo graph on the stock schedule — the exact
    failure `_splice_model_node`'s docstring already warns about for the
    guider/scheduler pair."""
    g = _r2v(mm, model="minimax-h3-turbo", refine=True)["graph"]
    scheds = [n for n in g.values() if n["class_type"] == "BasicScheduler"]
    assert len(scheds) == 2
    assert len({tuple(n["inputs"]["model"]) for n in scheds}) == 1


def test_the_two_passes_do_not_share_a_noise_seed(mm):
    g = _r2v(mm, refine=True, seed=7)["graph"]
    seeds = [n["inputs"]["noise_seed"] for n in g.values()
             if n["class_type"] == "RandomNoise"]
    assert len(seeds) == 2 and len(set(seeds)) == 2


def test_a_dict_overrides_the_model_recipe_key_by_key(mm):
    g = _r2v(mm, refine={"steps": 6, "scale": 1.0})["graph"]
    sig = [n for n in g.values() if n["class_type"] == "BasicScheduler"
           and n["inputs"]["steps"] == 6]
    assert sig and sig[0]["inputs"]["denoise"] == 0.2   # untouched key survives
    up = next(n for n in g.values() if n["class_type"] == "ImageScale")
    assert up["inputs"]["width"] == 1280


def test_freeze_audio_is_on_by_default_and_can_be_turned_off(mm):
    """The audio half is carried across from pass 1 and held. Hers re-encodes a
    waveform and re-noises it because she then overwrites the result with the
    user's locked track; we have no source to re-impose, so re-rolling an
    already-accepted soundtrack could only regress it."""
    on = next(n for n in _r2v(mm, refine=True)["graph"].values()
              if n["class_type"] == "NeonH3RefineLatent")
    assert on["inputs"]["freeze_audio"] is True
    off = next(n for n in _r2v(mm, refine={"freeze_audio": False})["graph"].values()
               if n["class_type"] == "NeonH3RefineLatent")
    assert off["inputs"]["freeze_audio"] is False


def test_every_local_h3_row_declares_a_recipe(mm):
    """Refinement is orthogonal to what distinguishes these rows, so a row that
    silently could not refine would be a picker toggle that does nothing on
    exactly one model."""
    mods = mm["full"]["models"]
    h3 = [k for k in mods if k.startswith("minimax-h3")]
    # The count is the tripwire: it exists so that ADDING an H3 row makes you
    # come and look at this list rather than silently shipping one more model
    # whose refine toggle does nothing. Bump it deliberately, never to make a
    # red test green. FIVE here — the base, turbo, lightx2v, the hybrid and
    # pdd. The upstream's three adult-content rows are not part of this build,
    # so this is 8 minus those, not a row that went missing.
    #
    # `minimax-h3-pdd` is the one DELIBERATE exemption below: refine and
    # split_pass are tuned against the 20-step schedule, and a PDD row's sigmas
    # are the distill's own trained block boundaries (only block sizes 4/8 on
    # the fine grid are legal), so re-noising a refine pass onto that
    # trajectory is an untested combination. The row declares neither, and
    # resolve() then RAISES on a refine request rather than rendering one pass
    # silently — the documented behaviour for a model with no recipe.
    assert len(h3) == 5
    for k in h3:
        if "pdd" in mods[k]:
            assert not mods[k].get("refine") and not mods[k].get("split_pass"), k
            continue
        assert R.refine_spec(mods[k], True), k
        # The other second pass, same reasoning — they are alternatives and a
        # row offering only one of them is an accident.
        assert R.split_pass_spec(mods[k], True), k


def test_asking_a_model_with_no_recipe_raises_rather_than_rendering_one_pass(mm):
    """A refine that silently does not happen costs the same as it always did
    and returns a take nobody can tell from an unrefined one."""
    with pytest.raises(R.ResolveError, match="declares no `refine` recipe"):
        R.resolve("ltx-25", "t2v", positive="x", negative="", seed=1,
                  width=1280, height=704, length=81, mm=mm, refine=True)


def test_refine_false_is_simply_off(mm):
    for falsey in (None, False, 0):
        assert "NeonH3RefineLatent" not in _classes(_r2v(mm, refine=falsey))

"""MMAudio (video -> audio).

Two things are pinned here and both fail SILENTLY on the pod:

* **The staged frame rate.** Kijai's port truncates the requested duration to
  `total_frames / 25` whenever the batch is short, with nothing but a
  `log.warning` inside ComfyUI to say so — so a soundtrack that stops before
  the picture is the natural result of loading a shot at its own 24fps.
* **The node fitting.** That pack's own README says "WIP WIP WIP", so its
  signature is the youngest in the studio; a graph built against a moved
  signature dies in validation, which reads as "MMAudio is broken".
"""
import json
import os

import pytest

import graphs
import mmaudio_spec as MS

MAP = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "infra", "model_map.full.json")


@pytest.fixture(scope="module")
def entry():
    with open(MAP) as f:
        return json.load(f)["full"]["v2a_models"]["mmaudio-large-44k-v2"]


def nodes(g, cls):
    return [v for v in g.values() if v["class_type"] == cls]


def only(g, cls):
    got = nodes(g, cls)
    assert len(got) == 1, f"expected exactly one {cls}, got {len(got)}"
    return got[0]


# --------------------------------------------------------------- the entry ---

def test_the_entry_names_all_four_files_and_they_are_distinct(entry):
    files = [entry[k] for k in ("model", "vae", "synchformer", "clip")]
    assert len(set(files)) == 4
    assert all(f.endswith(".safetensors") for f in files)


def test_resolve_looks_for_every_file_in_the_one_mmaudio_folder(entry):
    """All four loaders read `folder_paths.get_filename_list("mmaudio")`, so a
    'tidily' placed CLIP tower in text_encoders/ is invisible to the node."""
    import resolve as R
    assert sorted(R._v2a_files(entry)) == sorted(
        ("mmaudio", entry[k]) for k in ("model", "vae", "synchformer", "clip"))


# ---------------------------------------------------------- the frame rate ---

def test_the_video_is_staged_at_the_synchformer_rate(entry):
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="rain", seconds=8.0)["graph"]
    load = only(g, "VHS_LoadVideo")
    assert load["inputs"]["force_rate"] == 25
    assert load["inputs"]["select_every_nth"] == 1


@pytest.mark.parametrize("seconds", [1.0, 3.5, 8.0, 12.0, 30.0])
def test_enough_frames_are_loaded_that_the_duration_survives(entry, seconds):
    """`frame_load_cap` must reach 25 x duration or the node shortens the
    render — the one failure this whole builder is arranged around."""
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x", seconds=seconds)["graph"]
    cap = only(g, "VHS_LoadVideo")["inputs"]["frame_load_cap"]
    assert cap >= int(25 * seconds), f"{cap} frames cannot carry {seconds}s"


def test_a_callers_load_cap_wins_because_a_clip_runs_past_its_trim(entry):
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x", seconds=8.0,
                             load_cap=120, skip_frames=48)["graph"]
    load = only(g, "VHS_LoadVideo")
    assert load["inputs"]["frame_load_cap"] == 120
    assert load["inputs"]["skip_first_frames"] == 48


# ------------------------------------------------------------- the wiring ----

def test_the_sampler_reads_the_model_the_features_and_the_frames(entry):
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="a door slams",
                             negative="music", seconds=8.0, seed=7)["graph"]
    s = only(g, "MMAudioSampler")["inputs"]
    loader_id = [k for k, v in g.items() if v["class_type"] == "MMAudioModelLoader"][0]
    feats_id = [k for k, v in g.items() if v["class_type"] == "MMAudioFeatureUtilsLoader"][0]
    video_id = [k for k, v in g.items() if v["class_type"] == "VHS_LoadVideo"][0]
    assert s["mmaudio_model"] == [loader_id, 0]
    assert s["feature_utils"] == [feats_id, 0]
    # IMAGE is slot 0 of VHS_LoadVideo. Slot 2 is its AUDIO, which would be
    # the source's OWN soundtrack — the thing being replaced.
    assert s["images"] == [video_id, 0]
    assert s["prompt"] == "a door slams" and s["negative_prompt"] == "music"
    assert s["seed"] == 7


def test_the_44k_branch_needs_no_vocoder_node(entry):
    """MMAudioVoCoderLoader exists for 16k only — that branch asserts a vocoder
    input, while 44k downloads nvidia's BigVGAN itself. Adding the node would
    mean shipping 16k weights this box does not have."""
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x")["graph"]
    assert not nodes(g, "MMAudioVoCoderLoader")
    assert only(g, "MMAudioFeatureUtilsLoader")["inputs"]["mode"] == "44k"


def test_the_graph_ends_on_a_saver(entry):
    built = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x")
    save = only(built["graph"], "SaveAudioMP3")
    sampler_id = [k for k, v in built["graph"].items()
                  if v["class_type"] == "MMAudioSampler"][0]
    assert save["inputs"]["audio"] == [sampler_id, 0]
    assert built["outputs"] == [k for k, v in built["graph"].items()
                                if v["class_type"] == "SaveAudioMP3"]


def test_the_entrys_recipe_is_used_when_the_caller_says_nothing(entry):
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x")["graph"]
    s = only(g, "MMAudioSampler")["inputs"]
    assert s["steps"] == entry["steps"] and s["cfg"] == entry["cfg"]


def test_an_explicit_recipe_overrides_the_entry(entry):
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x",
                             steps=6, cfg=7.5)["graph"]
    s = only(g, "MMAudioSampler")["inputs"]
    assert s["steps"] == 6 and s["cfg"] == 7.5


def test_a_seed_past_64_bits_is_masked_rather_than_rejected(entry):
    """The node declares max 0xffffffffffffffff; JS `Date.now()`-ish seeds are
    fine but a caller sending something wider should not fail validation."""
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x",
                             seed=0x1_0000_0000_0000_0003)["graph"]
    assert only(g, "MMAudioSampler")["inputs"]["seed"] == 3


# ------------------------------------------------------- fitting the pack ----

def test_inputs_the_installed_node_does_not_declare_are_dropped(entry):
    """The `Krea2EditRebalance` lesson, applied to the youngest pack here."""
    spec = {"input": {"required": {
        "mmaudio_model": ("MMAUDIO_MODEL",), "feature_utils": ("MMAUDIO_FEATUREUTILS",),
        "duration": ("FLOAT", {"default": 8}), "steps": ("INT", {"default": 25}),
        "cfg": ("FLOAT", {"default": 4.5}), "seed": ("INT", {"default": 0}),
        "prompt": ("STRING", {}), "negative_prompt": ("STRING", {}),
        # `mask_away_clip` and `force_offload` have been dropped in this
        # imaginary build, and a new required knob has appeared.
        "solver": (["euler", "midpoint"], {}),
    }, "optional": {"images": ("IMAGE",)}}}
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x",
                             sampler_spec=spec)["graph"]
    s = only(g, "MMAudioSampler")["inputs"]
    assert "mask_away_clip" not in s and "force_offload" not in s
    assert s["solver"] == "euler"          # filled from the COMBO's first value
    assert s["images"][1] == 0             # the wiring survived


def test_with_no_spec_the_authored_shape_is_kept(entry):
    """spec=None is what keeps this builder testable with no ComfyUI running."""
    g = graphs.mmaudio_graph(entry, video="v.mp4", prompt="x")["graph"]
    s = only(g, "MMAudioSampler")["inputs"]
    assert s["mask_away_clip"] is False and s["force_offload"] is True


# ------------------------------------------------------------- the spec ------

def test_the_length_is_clamped_to_the_entrys_ceiling(entry):
    assert MS.clamp_seconds(999_000, entry["max_seconds"]) == entry["max_seconds"]
    assert MS.clamp_seconds(0, entry["max_seconds"]) == MS.MIN_SECONDS
    assert MS.clamp_seconds(8_000, entry["max_seconds"]) == 8.0


def test_only_a_length_outside_the_trained_band_gets_a_note():
    assert MS.duration_note(8.0) is None
    assert MS.duration_note(5.0) is None and MS.duration_note(12.0) is None
    assert "under" in MS.duration_note(4.9)
    assert "over" in MS.duration_note(12.1)


def test_clip_only_sees_the_head_of_the_shot_at_the_sync_rate():
    """Stated rather than hidden: at 25fps the CLIP tower's `[:8*duration]`
    slice is the first 8/25 of the batch. It is why this path always sends a
    text prompt."""
    assert MS.clip_coverage(8.0) == pytest.approx(0.32)


def test_the_refusal_names_a_screen_and_the_packs(monkeypatch):
    """A missing node pack fails deep inside ComfyUI's validator on a class
    name, which reads as a code bug rather than as "that pack was never
    installed" — so it is refused here, before the GPU is spent, with a fix
    the reader can perform.

    A SCREEN, not a command: the engine window is what adds these packs, and
    "run this bash script" is advice for a terminal this product exists not to
    need. The pack NAMES stay in the sentence because a user running a ComfyUI
    of their own has to install them there, and this is the one place they are
    written down.
    """
    from handlers import v2a
    monkeypatch.setattr(v2a, "_has_node", lambda _n: False)
    with pytest.raises(RuntimeError) as e:
        v2a._require_nodes()
    why = str(e.value)
    assert "engine window" in why
    assert "kijai/ComfyUI-MMAudio" in why and "VideoHelperSuite" in why
    assert "bash" not in why and ".sh" not in why
    # ...and every class it could not find, or the reader cannot tell which
    # pack is missing when only one of the two is.
    for n in v2a.REQUIRED_NODES:
        assert n in why


def test_the_video_loader_is_required_too():
    """MMAudio conditions on FRAMES. With only its own three nodes checked, a
    machine missing VideoHelperSuite passed this gate and died in ComfyUI's
    validator naming `VHS_LoadVideo` — a class name, which reads as a code bug
    rather than as a pack nobody installed."""
    from handlers import v2a
    assert "VHS_LoadVideo" in v2a.REQUIRED_NODES
    # ...and the 16k-only vocoder loader is still deliberately absent.
    assert "MMAudioVoCoderLoader" not in v2a.REQUIRED_NODES

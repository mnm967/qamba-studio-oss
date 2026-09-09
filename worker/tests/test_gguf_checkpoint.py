"""`resolve()` must write a GGUF entry's checkpoint into `UnetLoaderGGUF`.

THE BUG THIS PINS. That branch handled `high`/`low` and nothing else, because
until the desktop grew quantised MiniMax H3 the only GGUF template in the repo
was Wan's — and Wan is a high/low PAIR. An entry naming ONE `checkpoint` fell
through every clause and left the TEMPLATE'S OWN literal filename in place.

It is the worst shape a bug can take on this path: the graph validates, the
render succeeds, and it silently used whichever checkpoint the template happened
to ship with. Nothing in the job, the log or the output says so — you would only
find it by noticing that a Q3 render and a Q5 render look identical.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import resolve as R  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
DESKTOP = os.path.join(ROOT, "infra", "model_map.desktop.json")


@pytest.fixture(scope="module")
def mm():
    with open(DESKTOP) as f:
        return json.load(f)


@pytest.fixture(autouse=True)
def _no_disk_check(monkeypatch):
    """`resolve()` calls `ensure_model` first, which asks the DISK.

    That is the right thing on a machine that is about to render and the wrong
    thing here: these tests are about which filename lands in which loader, and
    nothing on a laptop holds 60GB of MiniMax H3. The presence check has its own
    coverage; this stubs it so a graph can be built without the weights.
    """
    monkeypatch.setattr(R, "ensure_model", lambda *a, **k: None)


def _loader(graph):
    return next(n for n in graph.values()
                if n.get("class_type") in ("UNETLoader", "UnetLoaderGGUF"))


@pytest.mark.parametrize("model", ["minimax-h3-q3", "minimax-h3-q4", "minimax-h3-q5"])
@pytest.mark.parametrize("mode", ["t2v", "i2v", "flf", "r2v"])
def test_the_gguf_loader_carries_the_entry_s_checkpoint(monkeypatch, mm, model, mode):
    monkeypatch.setattr(R, "TIER", "desktop")
    want = mm["desktop"]["models"][model]["modes"][mode]["checkpoint"]
    kw = dict(positive="a test", negative="", seed=1,
              width=864, height=480, length=0, exact_frames=73, mm=mm)
    if mode in ("i2v", "flf"):
        kw["source_image"] = "start.png"
    if mode == "flf":
        kw["end_image"] = "end.png"
    if mode == "r2v":
        kw["ref_images"] = ["a.png"]
    g = R.resolve(model, mode, **kw)["graph"]

    node = _loader(g)
    assert node["class_type"] == "UnetLoaderGGUF", "a quantised entry needs the GGUF loader"
    assert node["inputs"]["unet_name"] == want, (
        "the loader kept the template's own filename — the branch that only "
        "understood Wan's high/low pair")
    # `UnetLoaderGGUF` declares ONLY `unet_name`; `weight_dtype` is a validation
    # error at submit, which is after the block has waited its turn on the GPU.
    assert set(node["inputs"]) == {"unet_name"}


def test_r2v_is_a_different_checkpoint_from_the_other_modes(mm, monkeypatch):
    """`fl2va` cannot read reference images at all, and an episode is r2v."""
    monkeypatch.setattr(R, "TIER", "desktop")
    modes = mm["desktop"]["models"]["minimax-h3-q4"]["modes"]
    assert "Ref2VA" in modes["r2v"]["checkpoint"]
    for m in ("t2v", "i2v", "flf"):
        assert "FL2VA" in modes[m]["checkpoint"]
        assert modes[m]["checkpoint"] != modes["r2v"]["checkpoint"]


def test_the_safetensors_entry_is_unchanged_by_the_new_branch(monkeypatch, mm):
    """The clause was ADDED below the existing two, so nothing else moved."""
    monkeypatch.setattr(R, "TIER", "desktop")
    g = R.resolve("minimax-h3", "r2v", positive="x", negative="", seed=1,
                  width=864, height=480, length=0, exact_frames=73,
                  ref_images=["a.png"], mm=mm)["graph"]
    node = _loader(g)
    assert node["class_type"] == "UNETLoader"
    assert node["inputs"]["unet_name"] == "minimax_h3_ref2va_pruned_int8_convrot.safetensors"


def test_every_gguf_entry_names_a_template_that_exists_and_is_gguf(mm):
    """A workflow that is missing fails at resolve; one that kept `UNETLoader`
    fails at submit, on an enum, after the job has been claimed."""
    wf_dir = os.path.join(ROOT, "workflows")
    for key, m in mm["desktop"]["models"].items():
        if not key.startswith("minimax-h3-q"):
            continue
        for mode, spec in m["modes"].items():
            path = os.path.join(wf_dir, spec["workflow"])
            assert os.path.exists(path), f"{key}/{mode}: {spec['workflow']} is not on disk"
            with open(path) as f:
                tpl = json.load(f)
            cls = {n.get("class_type") for n in tpl.values() if isinstance(n, dict)}
            assert "UnetLoaderGGUF" in cls, f"{spec['workflow']} still loads through UNETLoader"
            assert "UNETLoader" not in cls

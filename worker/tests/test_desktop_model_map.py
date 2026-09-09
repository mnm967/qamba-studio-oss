"""The desktop tier of model_map, resolved by the pod's own `resolve.py`.

THE POINT OF THE MAP is that `master_pass` needs no branch: the same function
that builds a pod graph builds a desktop one, parameterised by files the engine
window can actually download. So the test is the real `resolve()` against the
real templates — anything less would be testing a JSON file against itself.

Verified once against a LIVE local engine as well (2026-08-30): every class in
the resolved r2v graph is among that engine's 857, every input is declared
(including the H3 builder's dotted autogrow families), and the UNETLoader loads
`minimax_h3_ref2va_int8_convrot.safetensors`. That half needs ComfyUI running,
so it is not repeated here.
"""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import resolve as R  # noqa: E402

MAP_PATH = os.path.join(REPO, "infra", "model_map.desktop.json")
MAP = json.load(open(MAP_PATH, encoding="utf-8"))
ENTRY = MAP["desktop"]["models"]["minimax-h3"]


@pytest.fixture
def desktop(monkeypatch, tmp_path):
    """A desktop: the generated map, the real templates, an empty model tree,
    and NO `fetchmodel` — which is the whole difference from the pod."""
    monkeypatch.setattr(R, "TIER", "desktop")
    monkeypatch.setattr(R, "load_map", lambda: MAP)
    monkeypatch.setattr(R, "COMFY_ROOT", str(tmp_path))
    monkeypatch.setattr(R, "WORKFLOWS_DIR", os.path.join(REPO, "workflows"))
    monkeypatch.setattr(R, "_has_fetcher", lambda: False)
    return tmp_path


def place_h3(root):
    for sub, fn in [
        ("diffusion_models", ENTRY["modes"]["r2v"]["checkpoint"]),
        ("diffusion_models", ENTRY["modes"]["i2v"]["checkpoint"]),
        ("vae", ENTRY["vae"]), ("vae", ENTRY["audio_vae"]),
        ("text_encoders", ENTRY["text_encoders"][0]),
    ]:
        d = root / "models" / sub
        d.mkdir(parents=True, exist_ok=True)
        (d / fn).write_text("x")


def test_with_no_weights_it_names_them_instead_of_shelling_out(desktop):
    """There is no `fetchmodel` on a laptop, and `subprocess` saying
    `FileNotFoundError: 'fetchmodel'` names neither the model nor the thing to
    do about it."""
    with pytest.raises(R.ResolveError) as e:
        R.ensure_model("minimax-h3", MAP)
    msg = str(e.value)
    assert "minimax-h3" in msg and "engine window" in msg
    assert ENTRY["modes"]["r2v"]["checkpoint"] in msg


def test_an_episode_block_resolves_on_the_reference_checkpoint(desktop):
    # `master_pass` renders a block in r2v — the mode the whole reference
    # system is built around — and `fl2va` cannot do it. The engine catalog
    # listed only fl2va until this work, so the desktop could hold 57GB of H3
    # and still not render one block of a storyboard.
    place_h3(desktop)
    out = R.resolve("minimax-h3", "r2v",
                    positive="a wet street at night", negative="",
                    seed=42, width=1280, height=720, length=0,
                    exact_frames=141, steps=20,
                    ref_images=["a.png", "b.png"], ref_audios=["v.mp3"])
    g = out["graph"]
    assert out["workflow"] == "minimax_h3_r2v.json"
    assert out["outputs"], "a graph with no output node publishes nothing"
    loaders = {n["class_type"]: n["inputs"] for n in g.values()}
    # READ FROM THE ENTRY, not written out here. The desktop tier substitutes
    # the PRUNED reference checkpoint (measured to render inside an enforced
    # 8GB where the pod's unpruned one needs 16), and a literal here would have
    # to be edited every time that decision moves — which is how this assertion
    # came to be checking a filename the map no longer names. The claim worth
    # pinning is that r2v loads the entry's REFERENCE checkpoint rather than
    # its fl2va one, and that survives the substitution.
    assert loaders["UNETLoader"]["unet_name"] == ENTRY["modes"]["r2v"]["checkpoint"]
    assert "ref2va" in ENTRY["modes"]["r2v"]["checkpoint"]
    assert ENTRY["modes"]["r2v"]["checkpoint"] != ENTRY["modes"]["i2v"]["checkpoint"]
    assert loaders["CLIPLoader"]["clip_name"] == ENTRY["text_encoders"][0]
    ref = next(n for n in g.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    assert ref["inputs"]["ref_images.ref_image_0"]
    assert ref["inputs"]["ref_images.ref_image_1"]
    assert ref["inputs"]["ref_audios.ref_audio_0"]


def test_every_mode_the_entry_declares_actually_builds(desktop):
    place_h3(desktop)
    for mode in sorted(ENTRY["modes"]):
        kw = dict(positive="x", negative="", seed=1, width=1280, height=720,
                  length=0, exact_frames=141, steps=20)
        if mode in ("i2v", "flf"):
            kw["source_image"] = "a.png"
        if mode == "flf":
            kw["end_image"] = "b.png"
        if mode == "r2v":
            kw["ref_images"] = ["a.png"]
        out = R.resolve("minimax-h3", mode, **kw)
        assert out["graph"], mode
        assert out["outputs"], mode


def test_the_frame_grid_and_the_dim_step_are_the_pod_s(desktop):
    # Invariant #5 does not change because the machine did: 17n+5 at 24fps,
    # width and height on /32. A desktop that snapped differently would render
    # a different picture from the same storyboard.
    place_h3(desktop)
    out = R.resolve("minimax-h3", "t2v", positive="x", negative="", seed=1,
                    width=1280, height=720, length=0, exact_frames=141, steps=20)
    lat = next(n for n in out["graph"].values()
               if n["class_type"] == "MiniMaxH3ImageToVideo")
    assert (lat["inputs"]["width"], lat["inputs"]["height"]) == (1280, 704)
    assert lat["inputs"]["length"] == 141
    assert ENTRY["frame_base"] == 17 and ENTRY["frame_rem"] == 5
    assert ENTRY["dim_step"] == 32 and ENTRY["fps"] == 24


def test_the_official_distillation_resolves_here_too(desktop):
    """PDD was refused outright until `install_engine` grew its node pack.

    It is the only distillation with a REFERENCE build, so it is the only one
    an EPISODE block can run end to end — every other one here is fl2va, and an
    episode renders r2v. What the splice has to get right is the same three
    things `test_pdd.py` pins on the pod: the file follows the checkpoint, the
    sigmas come off the Apply node (a graph still reading BasicScheduler
    samples the distilled trunk on the stock schedule), and the sampler is
    plain euler.
    """
    pdd_entry = MAP["desktop"]["models"]["minimax-h3-pdd"]
    for sub, fn in [
        ("diffusion_models", pdd_entry["modes"]["r2v"]["checkpoint"]),
        ("diffusion_models", pdd_entry["modes"]["i2v"]["checkpoint"]),
        ("vae", pdd_entry["vae"]), ("vae", pdd_entry["audio_vae"]),
        ("text_encoders", pdd_entry["text_encoders"][0]),
        ("pdd_acc", pdd_entry["pdd"]["fl2va"]),
        ("pdd_acc", pdd_entry["pdd"]["ref2va"]),
    ]:
        d = desktop / "models" / sub
        d.mkdir(parents=True, exist_ok=True)
        (d / fn).write_text("x")
    # …and the PACK, which the entry declares and `ensure_model` checks.
    (desktop / "custom_nodes" / "ComfyUI-MiniMax-H3-PDD-Acc").mkdir(parents=True)

    out = R.resolve("minimax-h3-pdd", "r2v", positive="a wet street", negative="",
                    seed=42, width=1280, height=720, length=0, exact_frames=141,
                    ref_images=["a.png"])
    g = out["graph"]
    apply = [n for n in g.values() if n["class_type"] == "MiniMaxH3PDDAccApply"]
    assert len(apply) == 1
    # r2v takes the REF2VA file. The two trunks share identical key sets, so a
    # crossed pairing applies cleanly and renders silently wrong.
    assert apply[0]["inputs"]["pdd_file"] == pdd_entry["pdd"]["ref2va"]
    aid = next(nid for nid, n in g.items()
               if n["class_type"] == "MiniMaxH3PDDAccApply")
    sca = [n for n in g.values() if n["class_type"] == "SamplerCustomAdvanced"][0]
    assert sca["inputs"]["sigmas"] == [aid, 1], "the schedule must be the node's own"
    assert [n for n in g.values()
            if n["class_type"] == "KSamplerSelect"][0]["inputs"]["sampler_name"] == "euler"
    # …and fl2va for everything else.
    g2 = R.resolve("minimax-h3-pdd", "t2v", positive="x", negative="", seed=1,
                   width=1280, height=720, length=0, exact_frames=141)["graph"]
    assert [n for n in g2.values()
            if n["class_type"] == "MiniMaxH3PDDAccApply"][0]["inputs"]["pdd_file"] \
        == pdd_entry["pdd"]["fl2va"]


def test_a_missing_pdd_file_is_NAMED_rather_than_found_inside_comfyui(desktop):
    """`ensure_model` walked checkpoints, VAEs and encoders and not this.

    On the pod that gap is survivable — a missing file shells out to
    `fetchmodel` — but a laptop has no fetcher, so the render reached ComfyUI
    and died on a `pdd_file` enum: a message about a dropdown, naming neither
    the model nor the download that would fix it.
    """
    place_h3(desktop)          # everything BUT the distillation
    with pytest.raises(R.ResolveError) as e:
        R.ensure_model("minimax-h3-pdd", MAP)
    msg = str(e.value)
    assert "MiniMax-H3-FL2VA-Acc-8Step.safetensors" in msg
    assert "engine window" in msg


def test_an_engine_without_the_PDD_PACK_is_told_which_pack(desktop):
    """The other half of the same gap, and the one an UPGRADE walks into.

    `install_engine` clones this pack now — but an engine installed before it
    did has every file on disk and no node to load them. Without the entry
    declaring `extra_nodes`, `ensure_model` sees nothing missing, the job is
    claimed, twenty gigabytes load, and ComfyUI rejects the prompt on a class
    name. The declaration is what turns that into a sentence naming the pack
    and the button that fixes it — the same one `ltx-25` and MMAudio carry.
    """
    e = MAP["desktop"]["models"]["minimax-h3-pdd"]
    for sub, fn in [("diffusion_models", e["modes"]["t2v"]["checkpoint"]),
                    ("vae", e["vae"]), ("vae", e["audio_vae"]),
                    ("text_encoders", e["text_encoders"][0]),
                    ("pdd_acc", e["pdd"]["fl2va"]),
                    ("pdd_acc", e["pdd"]["ref2va"])]:
        d = desktop / "models" / sub
        d.mkdir(parents=True, exist_ok=True)
        (d / fn).write_text("x")
    # every FILE present, and no pack
    with pytest.raises(R.ResolveError) as exc:
        R.ensure_model("minimax-h3-pdd", MAP)
    msg = str(exc.value)
    assert "ComfyUI-MiniMax-H3-PDD-Acc" in msg
    assert "engine window" in msg


def test_a_model_the_desktop_map_does_not_carry_says_so(desktop):
    # The turbo twin is dropped by the generator — its distillation is applied
    # through a node pack the installer does not add — and asking for it must
    # not silently fall through to something else.
    with pytest.raises(R.ResolveError) as e:
        R.resolve("minimax-h3-turbo", "r2v", positive="x", negative="", seed=1,
                  width=1280, height=720, length=0, exact_frames=141)
    assert "not available on tier 'desktop'" in str(e.value)


def test_the_generated_map_is_checked_in_and_says_it_is_generated():
    # The JS side regenerates and diffs it (`desktopModelMap.test.ts`); this is
    # the half that matters to the PYTHON — the file exists where the bundle
    # puts it, `load_map` can read it, and it is not something to hand-edit.
    assert MAP["desktop"]["models"], "no video models survived the prune"
    assert "_generated" in MAP


# ── MMAudio, the one entry that renders through the bundled pipeline ─────────

V2A = MAP["desktop"]["v2a_models"]["mmaudio-large-44k-v2"]


def place_mmaudio(root):
    """All four in ONE directory — the pack registers `mmaudio` itself and
    every loader reads its dropdown from there."""
    d = root / "models" / "mmaudio"
    d.mkdir(parents=True, exist_ok=True)
    for k in ("model", "vae", "synchformer", "clip"):
        (d / V2A[k]).write_text("x")


def test_the_v2a_entry_resolves_its_four_files_in_models_mmaudio(desktop):
    place_mmaudio(desktop)
    entry = R.v2a_model("mmaudio-large-44k-v2")
    assert entry["family"] == "mmaudio"
    assert entry["sync_fps"] == 25 and entry["mode"] == "44k"


def test_with_no_mmaudio_weights_it_names_the_engine_window_not_fetchmodel(desktop):
    # The desktop has no `fetchmodel`, so the pod's "run this and it will
    # download itself" is advice for a script that is not there. Every missing
    # file is named, because "download MMAudio" is not actionable when three of
    # the four already landed.
    with pytest.raises(R.ResolveError) as e:
        R.v2a_model("mmaudio-large-44k-v2")
    why = str(e.value)
    assert "engine window" in why
    assert "fetchmodel" not in why
    for k in ("model", "vae", "synchformer", "clip"):
        assert V2A[k] in why


def test_the_desktop_entry_is_the_pod_s_recipe(desktop):
    """The two maps must agree about the RENDER, or a desktop score and a pod
    score of the same clip are different sounds. `extra_nodes` is the one key
    that legitimately differs — the pod names what a shell script clones, and
    the generator keeps it only to decide whether the entry survives at all."""
    pod = json.load(open(os.path.join(REPO, "infra", "model_map.full.json"),
                         encoding="utf-8"))["full"]["v2a_models"]["mmaudio-large-44k-v2"]
    for k, v in pod.items():
        if k == "extra_nodes":
            continue
        assert V2A[k] == v, f"{k} drifted between the pod and the desktop"


# ── the IMAGE table, which `plan_cli` claims too now ──────────────────────

def test_every_desktop_image_entry_dispatches_to_a_real_builder():
    """`image_gen` is a desktop kind now, so its entries have to reach a graph.

    `handlers/images` dispatches on the entry's own `family` through a chain of
    `fam == "..."` tests, and the chain ENDS at the hosted `gpt-image-1.5`
    branch. So an entry whose family has no branch does not fail — it becomes
    an API call standing in for a model the user downloaded, which is the
    silent substitution the family field was introduced to stop.
    """
    src = open(os.path.join(HERE, "handlers", "images.py"), encoding="utf-8").read()
    import re
    branches = set(re.findall(r'fam == "([a-z0-9_]+)"', src))
    assert len(branches) >= 6, "the family-branch scanner is broken"
    for key, entry in MAP["desktop"]["image_models"].items():
        fam = entry.get("family") or key
        assert fam in branches, f"{key}: family '{fam}' has no builder branch"


def test_the_no_model_fallback_finds_something_on_the_desktop_tier():
    """`handle_image_gen` picks a model when the payload names none, walking a
    fixed order and ending at a HOSTED id. On the pod every name in it exists;
    on the desktop the generator has dropped Krea 2 and Klein (one encoder and
    one checkpoint the engine window cannot fetch), so the order has to still
    land on something local or a plan with no `image_model` quietly renders on
    somebody's API key."""
    import re
    src = open(os.path.join(HERE, "handlers", "images.py"), encoding="utf-8").read()
    have = set(MAP["desktop"]["image_models"])
    orders = re.findall(r'order = \(([^)]*)\)', src)
    assert len(orders) == 2, f"expected the two fallback orders, found {len(orders)}"
    for raw in orders:
        names = re.findall(r'"([a-z0-9_.-]+)"', raw)
        assert set(names) & have, f"none of {names} is on the desktop tier"

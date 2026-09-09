"""The precision-rung fallback: `resolve.apply_rungs`, and the one rule that
makes it safe to emit.

WHY IT EXISTS. A model_map entry names ONE file per role and `engineCatalog`
offers up to five of the same weights at different precisions — so a laptop
holding Klein 4B at Q4_K_M did not satisfy an entry naming the fp8, and the
render would have died inside ComfyUI on a `value_not_in_list` enum for a model
already on the disk. `gen_desktop_model_map.mjs` emits `_rungs`; this walks it.

The Rust twin (`planner.rs::apply_rungs`) decides what the PICKER calls ready
while this decides what the RENDER loads, so both are tested against the same
rules — a disagreement is a row that offers a model the job cannot resolve.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import resolve as R  # noqa: E402


def _machine(tmp_path, files, entry):
    """A COMFY_ROOT holding `files`, and a one-entry desktop map."""
    for sub, fn in files:
        d = tmp_path / "models" / sub
        d.mkdir(parents=True, exist_ok=True)
        (d / fn).write_text("")
    R.COMFY_ROOT = str(tmp_path)
    return {"image_models": {"k": json.loads(json.dumps(entry))}}


ENTRY = {
    "family": "flux2",
    "unet": "declared-fp8.safetensors",
    "text_encoder": "shared-te.safetensors",
    "_rungs": [
        {"id": "q5", "swap": {"declared-fp8.safetensors": "rung-Q5.gguf"}},
        {"id": "q4", "swap": {"declared-fp8.safetensors": "rung-Q4.gguf"}},
    ],
}


def test_the_declared_rung_wins_whenever_it_is_on_disk(tmp_path):
    # A machine holding BOTH renders on the one the map names. Preferring an
    # alternate would silently downgrade a correctly-provisioned machine.
    tier = _machine(tmp_path, [("diffusion_models", "declared-fp8.safetensors"),
                               ("diffusion_models", "rung-Q4.gguf")], ENTRY)
    R.apply_rungs(tier)
    assert tier["image_models"]["k"]["unet"] == "declared-fp8.safetensors"


def test_a_missing_declared_rung_falls_to_the_best_one_present(tmp_path):
    # Q5 is first in the table (quality order), so with only Q4 on disk it has
    # to keep looking rather than stopping at the first entry.
    tier = _machine(tmp_path, [("diffusion_models", "rung-Q4.gguf")], ENTRY)
    R.apply_rungs(tier)
    assert tier["image_models"]["k"]["unet"] == "rung-Q4.gguf"


def test_no_rung_at_all_leaves_the_declared_filename(tmp_path):
    # So the error names the file the engine window can be pointed at, rather
    # than whichever rung happened to be last in the table.
    tier = _machine(tmp_path, [], ENTRY)
    R.apply_rungs(tier)
    assert tier["image_models"]["k"]["unet"] == "declared-fp8.safetensors"


def test_the_rung_table_is_stripped_from_the_entry(tmp_path):
    # `_rungs` is full of filenames. Left on, every consumer that walks an
    # entry for weight-looking strings — `ensure_model`, the desktop's own
    # readiness check — would count every rung of the ladder as REQUIRED.
    tier = _machine(tmp_path, [("diffusion_models", "rung-Q4.gguf")], ENTRY)
    R.apply_rungs(tier)
    assert "_rungs" not in tier["image_models"]["k"]


def test_a_file_one_rung_keeps_and_another_replaces_must_still_be_present(tmp_path):
    # H3's real shape: each rung lists its own text encoder and the quantised
    # ones REUSE the int8 rung's, so the generator drops that identity mapping
    # from the GGUF swap while the studio swap still renames it. Judged on swap
    # targets alone the GGUF rung would be taken by a machine that has the
    # checkpoint and not the encoder.
    entry = {
        "ckpt": "int8-fl2va.safetensors",
        "te": "nvfp4-te.safetensors",
        "_rungs": [
            {"id": "studio", "swap": {"int8-fl2va.safetensors": "studio-fl2va.safetensors",
                                      "nvfp4-te.safetensors": "studio-te.safetensors"}},
            {"id": "q4", "swap": {"int8-fl2va.safetensors": "h3-Q4.gguf"}},
        ],
    }
    tier = _machine(tmp_path, [("diffusion_models", "h3-Q4.gguf")], entry)
    R.apply_rungs(tier)
    assert tier["image_models"]["k"]["ckpt"] == "int8-fl2va.safetensors"

    tier = _machine(tmp_path, [("diffusion_models", "h3-Q4.gguf"),
                               ("text_encoders", "nvfp4-te.safetensors")], entry)
    R.apply_rungs(tier)
    assert tier["image_models"]["k"]["ckpt"] == "h3-Q4.gguf"
    assert tier["image_models"]["k"]["te"] == "nvfp4-te.safetensors"


def test_an_entry_with_no_rung_table_is_untouched(tmp_path):
    # Which is every entry of the POD's map. Nothing here is conditional on the
    # tier name — the pod is inert because its map carries no `_rungs`.
    entry = {"unet": "a.safetensors"}
    tier = _machine(tmp_path, [], entry)
    before = json.loads(json.dumps(tier))
    R.apply_rungs(tier)
    assert tier == before


def test_the_real_generated_map_resolves_a_gguf_rung_and_the_graph_loads_it(tmp_path):
    """END TO END on the checked-in map, because the two halves are separate
    decisions: the swap has to fire, AND the builder has to load what it picks.

    `flux2_ref_graph` chooses `UnetLoaderGGUF` off the extension, which is the
    ONLY reason a `.gguf` rung may be offered for a family at all — see
    `GGUF_SAFE` in the generator.
    """
    import graphs

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    mm = json.load(open(os.path.join(here, "..", "infra", "model_map.desktop.json")))
    tier = mm["desktop"]
    entry = tier["image_models"]["flux2-klein-4b"]
    alt = next(a for a in entry["_rungs"] if a["id"] == "klein4b-q4")
    gguf = alt["swap"]["flux-2-klein-4b-fp8.safetensors"]

    files = [("diffusion_models", gguf),
             ("text_encoders", entry["text_encoder"]),
             ("vae", entry["vae"])]
    for sub, fn in files:
        d = tmp_path / "models" / sub
        d.mkdir(parents=True, exist_ok=True)
        (d / fn).write_text("")
    R.COMFY_ROOT = str(tmp_path)
    R.apply_rungs(tier)

    got = tier["image_models"]["flux2-klein-4b"]
    assert got["unet"] == gguf
    g = graphs.flux2_ref_graph(got, "p", 1, 512, 512, steps=got["steps"])
    loaders = [n["class_type"] for n in g.values() if "unet_name" in n.get("inputs", {})]
    assert loaders == ["UnetLoaderGGUF"], loaders


def test_a_gguf_rung_is_only_offered_where_the_builder_picks_its_loader(tmp_path):
    """THE RULE THAT MAKES THE TABLE SAFE, pinned against `graphs.py` itself.

    A rung swap must not change the GRAPH, and a `.gguf` needs
    `UnetLoaderGGUF` where a `.safetensors` needs the stock `UNETLoader`.
    `_unet_loader` is the one place that decides, and a builder reaches the
    rule by going through it.

    So: every entry whose rung table crosses that boundary must belong to a
    family whose builder does. Read off the real map and the real source,
    because the generator's `GGUF_SAFE` is a claim ABOUT this file.
    """
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = open(os.path.join(here, "graphs.py")).read()
    assert "def _unet_loader(" in src and "UnetLoaderGGUF" in src

    branches = set()
    for fam, fns in [("flux2", ["flux2_ref_graph"]),
                     ("qwen", ["qwen_edit_graph", "qwen_upscale_graph"]),
                     ("anima", ["anima_graph"]),
                     ("hidream_o1", ["hidream_o1_graph"])]:
        bodies = []
        for fn in fns:
            i = src.index(f"def {fn}(")
            bodies.append(src[i:src.index("\ndef ", i + 1)])
        # EVERY builder the family can reach, not just the first: `qwen-edit`'s
        # entry feeds the tile upscaler as well as the editor, and one of them
        # hardcoding a loader is an `image_upscale` that dies on a rung the
        # editor renders on happily.
        if all("_unet_loader(" in b for b in bodies):
            branches.add(fam)
    for fam in ("flux2", "qwen", "anima"):
        assert fam in branches, f"{fam}'s builder(s) stopped going through _unet_loader"

    # HIDREAM CANNOT BRANCH AND MUST NOT BE CLEARED. It reads one all-in-one
    # checkpoint through `CheckpointLoaderSimple`, and city96's pack registers
    # no checkpoint loader at all — so there is no GGUF node to reach. Its two
    # rungs are both safetensors, so it ladders on extension alone and loses
    # nothing.
    assert "hidream_o1" not in branches
    gen = open(os.path.join(here, "..", "scripts", "gen_desktop_model_map.mjs")).read()
    cleared = gen[gen.index("const GGUF_SAFE"):].split("\n")[0]
    assert "hidream" not in cleared, cleared

    mm = json.load(open(os.path.join(here, "..", "infra", "model_map.desktop.json")))
    for section in mm["desktop"].values():
        if not isinstance(section, dict):
            continue
        for key, entry in section.items():
            if not isinstance(entry, dict) or "_rungs" not in entry:
                continue
            for alt in entry["_rungs"]:
                for frm, to in alt["swap"].items():
                    if os.path.splitext(frm)[1] == os.path.splitext(to)[1]:
                        continue
                    assert entry.get("family") in branches, (
                        f"{key} offers rung {alt['id']} across "
                        f"{os.path.splitext(frm)[1]} -> {os.path.splitext(to)[1]}, "
                        f"but family {entry.get('family')!r} hardcodes its loader")

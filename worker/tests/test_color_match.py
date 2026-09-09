"""The grade: which ColorMatch node, and which transfer.

`ColorMatch` carries `DEPRECATED = True` in KJNodes and `ColorMatchV2` is the
same six algorithms on the V3 schema plus `reinhard_lab_gpu` (Lab mean/std
through Kornia, on the GPU). Both declare the same input NAMES, so preferring
V2 is a class-name change — but the two differ in what is REQUIRED, and the
new method exists on only one of them, so the selection has to be made against
the live engine rather than assumed.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "handlers"))

import graphs
import handlers.post as P


# The two nodes as the live /object_info reports them. v1 is a CLASSIC node
# (options in place of the type); V2 is V3-schema (`["COMBO", {"options":…}]`)
# — the split that makes `_combo_values` two-spelling, and the same one
# `engine_manifest.trim()` gets wrong.
V1 = {"input": {"required": {
          "image_ref": ["IMAGE", {}], "image_target": ["IMAGE", {}],
          "method": [["mkl", "hm", "reinhard", "mvgd", "hm-mvgd-hm", "hm-mkl-hm"],
                     {"default": "mkl"}]},
      "optional": {"strength": ["FLOAT", {}], "multithread": ["BOOLEAN", {}]}}}
V2 = {"input": {"required": {
          "image_target": ["IMAGE", {}], "image_ref": ["IMAGE", {}],
          "method": ["COMBO", {"options": ["mkl", "hm", "reinhard", "mvgd",
                                           "hm-mvgd-hm", "hm-mkl-hm",
                                           "reinhard_lab_gpu"],
                               "default": "mkl"}],
          "strength": ["FLOAT", {"default": 1.0}],
          "multithread": ["BOOLEAN", {"default": True}]}}}
#: A KJNodes new enough to have V2 and too old to have the GPU method.
V2_OLD = {"input": {"required": {**V2["input"]["required"],
                                 "method": ["COMBO", {"options": [
                                     "mkl", "hm", "reinhard", "mvgd",
                                     "hm-mvgd-hm", "hm-mkl-hm"]}]}}}


@pytest.fixture
def engine(monkeypatch):
    """Install a fake /object_info. Returns a setter."""
    state = {}
    monkeypatch.setattr(P.comfy, "object_info", lambda: state)
    return lambda **nodes: state.clear() or state.update(nodes)


# ------------------------------------------------------- reading the schema --
def test_the_combo_reader_handles_both_schema_spellings(engine):
    engine(ColorMatch=V1, ColorMatchV2=V2)
    assert P._combo_values("ColorMatch", "method")[0] == "mkl"
    assert "reinhard_lab_gpu" not in P._combo_values("ColorMatch", "method")
    # The V3 spelling is the one a naive reader returns EMPTY for.
    assert "reinhard_lab_gpu" in P._combo_values("ColorMatchV2", "method")


def test_an_unknown_node_reads_as_could_not_tell_rather_than_offers_nothing(engine):
    engine()
    assert P._combo_values("ColorMatchV2", "method") == ()


# --------------------------------------------------------- picking the node --
def test_v2_wins_where_the_pod_has_both(engine):
    engine(ColorMatch=V1, ColorMatchV2=V2)
    assert P._color_match_node("mkl") == "ColorMatchV2"


def test_v1_still_serves_a_pod_that_has_only_it(engine):
    # This pass shipped against v1 and must not start failing on a box where
    # it worked — KJNodes is pinned per-pod, so plenty will not have V2.
    engine(ColorMatch=V1)
    assert P._color_match_node("mkl") == "ColorMatch"


def test_the_gpu_method_falls_THROUGH_v1_rather_than_onto_it(engine):
    # v1 is installed and cannot serve the method; the point is that it is
    # skipped and V2 is chosen, not that the first installed node wins.
    engine(ColorMatch=V1, ColorMatchV2=V2)
    assert P._color_match_node("reinhard_lab_gpu") == "ColorMatchV2"


def test_a_method_no_installed_node_offers_RAISES_rather_than_grading_as_mkl(engine):
    # THE POINT OF THE WHOLE SELECTION. A cut grades consistently by
    # construction, so a silent substitution is invisible in the one place
    # anyone would look for it.
    engine(ColorMatch=V1)
    with pytest.raises(RuntimeError, match="ColorMatchV2-only"):
        P._color_match_node("reinhard_lab_gpu")


def test_a_v2_too_old_for_the_method_is_refused_too(engine):
    # `reinhard_lab_gpu` arrived in a KJNodes release, so having the NODE is
    # not having the METHOD — and the alternative is a `value_not_in_list`
    # rejection after the clip is already staged.
    engine(ColorMatchV2=V2_OLD)
    with pytest.raises(RuntimeError, match="ColorMatchV2-only"):
        P._color_match_node("reinhard_lab_gpu")
    assert P._color_match_node("mkl") == "ColorMatchV2"


def test_no_colormatch_at_all_names_the_pack_to_install(engine):
    engine()
    with pytest.raises(RuntimeError, match="install KJNodes"):
        P._color_match_node("mkl")


def test_a_method_this_studio_does_not_build_is_refused_before_the_engine(engine):
    engine(ColorMatchV2=V2)
    with pytest.raises(RuntimeError, match="not one this studio builds"):
        P._color_match_node("wavelet")


def test_an_unreadable_method_list_does_not_break_the_grade(engine):
    # Empty means "could not read the schema", not "offers nothing": every
    # method but the new one predates both nodes' current schemas, so refusing
    # here would break a working grade over a manifest quirk.
    engine(ColorMatch={"input": {}})
    assert P._color_match_node("mkl") == "ColorMatch"


# -------------------------------------------------------------- the graph ----
def _cm(**kw):
    return graphs.color_match_graph("clip.mp4", "ref.png", **kw)


def test_the_node_is_the_only_thing_the_class_choice_changes():
    v1 = _cm(node="ColorMatch")
    v2 = _cm(node="ColorMatchV2")
    assert v1["4"]["class_type"] == "ColorMatch"
    assert v2["4"]["class_type"] == "ColorMatchV2"
    assert v1["4"]["inputs"] == v2["4"]["inputs"]
    assert {k: v for k, v in v1.items() if k != "4"} == \
           {k: v for k, v in v2.items() if k != "4"}


def test_strength_and_multithread_are_always_written():
    # They are OPTIONAL on v1 and REQUIRED on V2, so a graph that omitted them
    # would validate on the node this pass shipped against and fail on the one
    # it is moving to.
    ins = _cm(node="ColorMatchV2")["4"]["inputs"]
    assert set(ins) == {"image_ref", "image_target", "method", "strength",
                        "multithread"}
    assert ins["multithread"] is True   # KJNodes' own default, so v1 is unchanged


def test_the_audio_survives_the_grade():
    # The Civitai workflow this pass descends from (2019629) is VHS
    # Load -> ColorMatch -> Combine and carries NO audio path at all, so its
    # output is silent. Ours reads the components and puts the track back.
    g = _cm()
    assert g["5"]["inputs"]["audio"] == ["2", 1]
    assert g["5"]["inputs"]["fps"] == ["2", 2]


def _node_union():
    """Every method the two ColorMatch nodes declare, per KJNodes' source."""
    return set(V1["input"]["required"]["method"][0]) | \
        set(V2["input"]["required"]["method"][1]["options"])


def test_every_colormatch_method_the_studio_builds_is_one_of_the_nodes_own():
    # A method in our table that neither node offers is a render that dies on
    # an enum. `vcg` is exempt — it is not a ColorMatch method at all.
    offered = set(graphs.COLOR_MATCH_METHODS) - {P.VCG_METHOD}
    assert offered <= _node_union()
    assert set(graphs.COLOR_MATCH_V2_ONLY) == \
        set(V2["input"]["required"]["method"][1]["options"]) - \
        set(V1["input"]["required"]["method"][0])


def test_what_is_refused_is_recorded_rather_than_quietly_dropped():
    # The node goes on declaring `hm-mvgd-hm`, so the next person to read its
    # combo list has to be able to tell a DECISION from an oversight — and the
    # refusal has to be a partition, not an overlap.
    refused = set(graphs.COLOR_MATCH_REFUSED)
    offered = set(graphs.COLOR_MATCH_METHODS) - {P.VCG_METHOD}
    assert refused
    assert not (refused & offered), "a method cannot be both offered and refused"
    assert offered | refused == _node_union(), \
        "every method the nodes declare is either offered or refused with a reason"
    for m, why in graphs.COLOR_MATCH_REFUSED.items():
        assert len(why) > 20, f"{m} is refused without a reason"


def test_a_refused_method_cannot_be_selected(engine):
    engine(ColorMatch=V1, ColorMatchV2=V2)
    for m in graphs.COLOR_MATCH_REFUSED:
        with pytest.raises(RuntimeError, match="not one this studio builds"):
            P._color_match_node(m)


# ------------------------------------------------------------- the LUT arm --
VCG_NODES = {
    "VCGLoadModel": {"input": {"required": {
        "model_name": [["vcg_combined_fp16.safetensors", "other.safetensors"], {}]}}},
    "VCGGenerateLUT": {"input": {"required": {}}},
    "VCGApplyLUT": {"input": {"required": {}}},
}


def test_the_lut_grade_is_not_routed_through_the_colormatch_picker(engine):
    # It has its own nodes and its own graph. Refused BY NAME here, or the
    # reader is sent looking for a KJNodes update that would not help.
    engine(ColorMatch=V1, ColorMatchV2=V2)
    with pytest.raises(RuntimeError, match="not a ColorMatch method"):
        P._color_match_node(P.VCG_METHOD)


def test_the_lut_grade_needs_its_pack(engine):
    engine(ColorMatch=V1)
    with pytest.raises(RuntimeError, match="missing node"):
        P._require_vcg()


def test_the_lut_grade_needs_its_WEIGHTS_and_says_which(engine):
    # The pack installed and the engine window's model list vcg never run: the node exists
    # and its combo does not carry the file. Caught here rather than as a
    # value_not_in_list rejection after the clip is staged.
    nodes = {k: dict(v) for k, v in VCG_NODES.items()}
    nodes["VCGLoadModel"] = {"input": {"required": {
        "model_name": [["something_else.safetensors"], {}]}}}
    engine(**nodes)
    with pytest.raises(RuntimeError, match="the engine window's model list vcg"):
        P._require_vcg()


def test_the_lut_grade_passes_when_the_pack_and_the_file_are_there(engine):
    engine(**VCG_NODES)
    P._require_vcg()          # must not raise


def test_the_lut_blends_toward_the_SOURCE_not_toward_its_own_preprocess():
    # MEASURED: VCG's preprocess ends on a batch-wide min-max normalise that
    # washes the picture out (gap 0.072-0.129 against plain mkl's 0.002-0.010),
    # so blending a partial strength toward it makes half strength worse than
    # either end. Toward the source, `strength` means what it means on every
    # other grade: 0 ungraded, 1 the full look.
    g = graphs.vcg_grade_graph("clip.mp4", "ref.png", strength=0.5)
    apply_ = g["6"]["inputs"]
    assert apply_["images"] == ["5", 0], "the LUT applies to the preprocess"
    assert apply_["original_images"] == ["2", 0], "and blends toward the SOURCE"
    assert apply_["strength"] == 0.5


def test_the_lut_grade_keeps_color_matchs_own_contract():
    # Same shape in and out, so apply_color_match can pick between them on one
    # setting and the chain, op_hash and cache are unchanged.
    a = graphs.color_match_graph("clip.mp4", "ref.png")
    b = graphs.vcg_grade_graph("clip.mp4", "ref.png")
    for g in (a, b):
        assert g["1"]["inputs"]["file"] == "clip.mp4"
        assert g["3"]["inputs"]["image"] == "ref.png"
        save = [n for n in g.values() if n["class_type"] == "SaveVideo"][0]
        vid = [n for n in g.values() if n["class_type"] == "CreateVideo"][0]
        assert vid["inputs"]["audio"] == ["2", 1], "the audio survives the grade"
        assert vid["inputs"]["fps"] == ["2", 2]
        assert save["inputs"]["format"] == "auto"


def test_the_lut_seed_is_FIXED_so_one_cut_grades_consistently():
    # The LUT is generated per clip, so a seed that varied per clip would put a
    # different roll of the same grade on every shot of one cut.
    a = graphs.vcg_grade_graph("a.mp4", "ref.png")
    b = graphs.vcg_grade_graph("b.mp4", "ref.png")
    assert a["5"]["inputs"]["seed"] == b["5"]["inputs"]["seed"] == graphs.VCG_SEED

"""A NEGATIVE reference — a picture to compose away from.

Only expressible on Qwen-Edit: it is the one image family with a negative
branch that is both present and evaluated (cfg 2.5 + CFGNorm). The mechanism is
cancellation — whatever both encoders share contributes nothing to the CFG
difference — so these pin the two ways that can silently break: the shared set
must stay IDENTICAL on both sides, and the extra picture must appear on the
negative side only.
"""
import graphs

QE = {"unet": "qwen.safetensors", "text_encoder": "qwen_te.safetensors",
      "vae": "qwen_vae.safetensors", "steps": 20, "cfg": 2.5}


def build(refs, negative_refs=None):
    g = graphs.qwen_edit_graph(QE, "a shot", 1, 1280, 704, refs,
                               negative="", negative_refs=negative_refs)
    def images(nid):
        ins = g[nid]["inputs"]
        return [g[ins[k][0]]["inputs"]["image"]
                for k in ("image1", "image2", "image3") if k in ins]
    return g, images("7"), images("8")


def test_without_a_negative_ref_both_encoders_see_the_same_images():
    _, pos, neg = build(["a.png", "b.png", "c.png"])
    assert pos == ["a.png", "b.png", "c.png"]
    assert neg == pos, "the historical contract — only the prompt differs"


def test_the_extra_picture_lands_on_the_negative_side_only():
    _, pos, neg = build(["face.png", "place.png"], ["prev.png"])
    assert "prev.png" not in pos
    assert neg == ["face.png", "place.png", "prev.png"]
    # everything shared cancels, so the differential IS the extra picture
    assert neg[:len(pos)] == pos


def test_the_positive_set_is_trimmed_so_the_differential_stays_clean():
    # Three positives + one negative would exceed the node's three-image
    # ceiling; evicting a SHARED reference from the negative instead would make
    # the differential "away from prev AND toward the evicted one".
    _, pos, neg = build(["a.png", "b.png", "c.png"], ["prev.png"])
    assert len(neg) <= 3
    assert pos == ["a.png", "b.png"]
    assert neg == ["a.png", "b.png", "prev.png"]
    assert neg[:len(pos)] == pos


def test_one_loader_per_distinct_file():
    g, _, _ = build(["a.png", "b.png"], ["prev.png"])
    loaded = sorted(n["inputs"]["image"] for n in g.values()
                    if n["class_type"] == "LoadImage")
    assert loaded == ["a.png", "b.png", "prev.png"]


def test_the_negative_branch_is_actually_evaluated():
    """A negative reference on a cfg-1 model is decoration; pin the cfg that
    makes this mechanism real."""
    g, _, _ = build(["a.png"], ["prev.png"])
    assert g["9"]["inputs"]["cfg"] > 1.0

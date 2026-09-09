"""Two guards in handle_master_pass, pinned by source because importing
handlers.blocks needs the pod's whole dependency set."""
import pathlib
import re

SRC = (pathlib.Path(__file__).resolve().parents[1] / "handlers" / "blocks.py").read_text()


def test_beats_outrank_a_stray_recipe():
    """A block WITH beats that also carries a neighbour's clip_gen recipe is
    compiled from its beats. Replaying the recipe rendered the neighbour's
    extension under the new block's name."""
    at = SRC.index("def handle_master_pass")
    body = SRC[at:at + 2500]
    assert 'if block.get("beat_ids"):' in body
    assert "_master_pass_clip_block(job, block, _ck)" in body
    # the delegation is the ELSE branch of the beats test
    assert body.index('if block.get("beat_ids"):') < body.index("_master_pass_clip_block(job, block, _ck)")


def test_pinned_pictures_survive_a_recompute():
    at = SRC.index("ref_plan recompute: carried the closing frame across")
    body = SRC[at:at + 1200]
    assert 'e.get("pinned")' in body
    assert "fresh.extend(pinned)" in body


def test_the_label_regex_accepts_the_placeholder_suffixes():
    m = re.search(r"_AUTO_LABEL = re\.compile\(\s*r\"([^\"]+)\"", SRC)
    assert m, "_AUTO_LABEL moved"
    rx = re.compile(m.group(1), re.I)
    for label in ["Block 20", "Extension 19", "Chain 3 · audio",
                  "Block 20 · rendering", "Shot 4 · failed"]:
        assert rx.match(label), label
    assert not rx.match("Chain: How the reference pi")

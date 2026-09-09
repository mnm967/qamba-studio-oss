"""A hosted image pick must render on the model that was PICKED.

`_family` falls back to the key itself for anything model_map does not declare,
and the tail of handle_image_gen's dispatch chain was a hardcoded gpt-image-1.5
call — so `gpt-image-2`, `gpt-image-1.5` and (once added) all three Nano Banana
rows routed identically, at quality "medium", whatever the wizard's picker
said. The picker was real; the choice was not.

Read off the source rather than executed: handle_image_gen needs ComfyUI, B2
and a live catalog. Same treatment test_image_routing.py already gives it.
"""
import inspect
import re

import handlers.images as I

SRC = inspect.getsource(I)
DISPATCH = SRC.split("ref_names, ref_paths = _stage_refs", 1)[1]


def test_a_hosted_row_is_dispatched_to_its_own_provider():
    assert "elif _hosted_row(model):" in DISPATCH, \
        "hosted picks still fall through to the gpt-image-1.5 tail"
    assert "PROVIDERS[hrow['provider']]" in DISPATCH


def test_the_hosted_branch_comes_BEFORE_the_last_resort():
    """Order is the whole fix: the bare `else` swallows everything, so a
    hosted branch after it can never run."""
    assert DISPATCH.index("elif _hosted_row(model):") < DISPATCH.index(
        "no model for"), "the hosted branch must precede the fallback"


def test_the_fallback_says_it_is_standing_in():
    """It stays as the genuine no-model last resort, but a substitution that
    announces itself is not the bug — a silent one is."""
    assert "falling back to" in DISPATCH


def test_only_a_known_provider_counts_as_hosted():
    """A row naming a provider with no adapter must NOT be treated as hosted —
    it would import a module that does not exist, mid-render."""
    src = inspect.getsource(I._hosted_row)
    assert "prov in PROVIDERS" in src
    assert 'prov == "local"' in src


def test_panels_default_to_the_low_tier():
    """Measured across all three tiers on one prompt and one reference set:
    the shot is correct at every tier and only environmental detail scales.
    low is $0.0304/image against medium $0.0668 and high $0.1903."""
    assert re.search(r'"low" if \(payload\.get\("prompt_spec"\) or \{\}\)'
                     r'\.get\("kind"\) == "panel"', DISPATCH), \
        "panels must ask for the cheapest tier that stages correctly"
    # …and an explicit request still wins.
    assert 'payload.get("quality")\n                       or (' in DISPATCH


def test_references_travel_as_URLS_not_comfy_input_paths():
    """The provider modules POST references to someone else's API; the staged
    ComfyUI input paths mean nothing there."""
    assert '"ref_urls": urls' in DISPATCH
    assert "B2_CDN_BASE" in DISPATCH


def test_hosted_spend_reaches_the_cost_ledger():
    """The api lane books every hosted generation exact; this path booked
    nothing at all, so a hosted image_gen spent money invisibly."""
    assert "hosted_cost = 0.0" in SRC, "must be defined for every branch"
    assert "sb.record_cost(job, hosted_cost" in SRC
    assert "estimate=False" in SRC


def test_the_result_is_moved_into_the_normal_tail():
    """Everything after the dispatch — B2 key, assets row, target attach — is
    shared, so the hosted branch has to land its file where the local ones do."""
    assert 'os.replace(out["local_path"], png)' in DISPATCH

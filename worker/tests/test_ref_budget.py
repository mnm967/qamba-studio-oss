"""The slot budget, which used to be `plan[:8]`.

Identity is assembled first and an outfit variant costs TWO pictures, so five
cast members fill the budget alone — and the tail that got truncated was the
location master, then the storyboard panels, then the props. Measured on Rei
E4: 5 of 17 blocks would have rendered with NO plate and 6 with no panel, in an
episode whose standing complaint was the location drifting. Truncation is not
an error, so nothing said a word.
"""
from handlers.blocks import IDENT_FLOOR, PICTURE_CAP, budget_refs


def ident(n):
    return [{"purpose": "character", "name": f"c{i}", "asset_id": f"a{i}"}
            for i in range(n)]


def env():
    return [{"purpose": "environment", "role": "master", "asset_id": "env"}]


def panels(n):
    return [{"purpose": "scene_ref", "role": "storyboard", "shot_idxs": [i + 1],
             "beat_id": f"b{i}", "asset_id": f"p{i}"} for i in range(n)]


def props(n):
    return [{"purpose": "look", "role": "prop", "asset_id": f"pr{i}"}
            for i in range(n)]


def test_the_location_plate_survives_a_crowded_block():
    """The exact ASTRONAUT_CAPTURE shape: 8 identity pictures for 5 people,
    one plate, two panels."""
    plan = ident(8) + env() + panels(2)
    out = budget_refs(plan)
    assert len(out) <= PICTURE_CAP
    assert any(e["purpose"] == "environment" for e in out), "plate was cut again"
    assert sum(1 for e in out if e["purpose"] == "scene_ref") == 2


def test_identity_keeps_the_strong_slots_and_yields_only_its_tail():
    plan = ident(8) + env() + panels(2)
    out = budget_refs(plan)
    kept = [e for e in out if e["purpose"] == "character"]
    # the FIRST identity pictures survive — ref_plan_for ranks them by who the
    # block's shots name, so the tail is the least-mentioned character
    assert [e["name"] for e in kept] == [f"c{i}" for i in range(len(kept))]
    # …and order is preserved overall, because <Picture N> is positional
    assert out == [e for e in plan if e in out]


def test_a_block_that_fits_is_untouched():
    plan = ident(4) + env() + panels(2) + props(1)
    assert budget_refs(plan) == plan


def test_a_user_designated_frame_never_yields():
    plan = ([{"purpose": "start_frame", "role": "first_frame", "asset_id": "sf"}]
            + ident(8) + env() + panels(2))
    out = budget_refs(plan)
    assert out[0]["purpose"] == "start_frame"
    assert any(e["purpose"] == "environment" for e in out)


def test_a_designated_beat_still_outranks_auto_material():
    still = [{"purpose": "look", "role": "look", "beat_id": "b3", "asset_id": "u"}]
    plan = ident(8) + env() + still + panels(2)
    out = budget_refs(plan)
    assert any(e.get("asset_id") == "u" for e in out), "the user's own pick was cut"


def test_panels_never_starve_identity_below_the_floor():
    plan = ident(3) + env() + panels(2)
    out = budget_refs(plan)
    assert sum(1 for e in out if e["purpose"] == "character") >= IDENT_FLOOR


def test_props_take_only_what_is_left():
    plan = ident(8) + env() + panels(2) + props(2)
    out = budget_refs(plan)
    assert not [e for e in out if e.get("role") == "prop"]
    assert len(out) == PICTURE_CAP

"""`beat_meta_after` — what a landed picture does to a beat's meta.

The single-slot modes (`panel` -> panel_asset_id, otherwise -> still_asset_id)
are last-writer-wins, which is correct for one render and catastrophic for
five: aimed at `panel`, a round of alternates overwrites itself and leaves one
arbitrary survivor. These pin the third mode that makes a CHOICE possible, the
two invariants around it — the user's own slot is never touched, and the list
cannot grow without bound — and the rule that makes a single redraw
recoverable: the panel it replaces is kept.

They call the REAL function. They used to re-implement it, which is worth a
note because the copy was word for word correct and still worth nothing: a
change to the handler would have left these passing.
"""
import handlers.images as images

after = images.beat_meta_after


def test_five_alternates_all_survive():
    meta = {}
    for i in range(5):
        meta = after(meta, f"a{i}", "panel_alt")
    assert meta["panel_alts"] == ["a0", "a1", "a2", "a3", "a4"]
    # and none of them claimed the slot the storyboard renders from
    assert "panel_asset_id" not in meta


def test_alternates_never_touch_the_user_slot():
    meta = after({"still_asset_id": "mine", "panel_asset_id": "drawn"},
                 "alt1", "panel_alt")
    assert meta["still_asset_id"] == "mine"
    assert meta["panel_asset_id"] == "drawn"


def test_the_list_is_bounded_and_newest_wins():
    meta = {}
    for i in range(images.PANEL_ALTS_KEPT + 3):
        meta = after(meta, f"a{i}", "panel_alt")
    assert len(meta["panel_alts"]) == images.PANEL_ALTS_KEPT
    assert meta["panel_alts"][-1] == f"a{images.PANEL_ALTS_KEPT + 2}"
    assert "a0" not in meta["panel_alts"]


def test_a_repeat_id_is_not_duplicated():
    meta = after(after({}, "same", "panel_alt"), "same", "panel_alt")
    assert meta["panel_alts"] == ["same"]


def test_the_single_slot_modes_are_unchanged():
    assert after({}, "p1", "panel")["panel_asset_id"] == "p1"
    assert after({}, "s1", "still")["still_asset_id"] == "s1"


def test_the_input_meta_is_not_mutated():
    """The handler patches what this returns; a caller that read the row for
    anything else must not see it change underneath."""
    meta = {"panel_asset_id": "old", "panel_alts": ["x"]}
    after(meta, "new", "panel")
    assert meta == {"panel_asset_id": "old", "panel_alts": ["x"]}


# ── a redraw keeps the panel it replaces ────────────────────────────────────
# One roll REPLACES `panel_asset_id`, which is the point of it — but the
# picture it replaced used to leave the beat entirely, so the redraw screen's
# own rail read "0 alternates" however many times you rolled and going back
# meant hunting the library by eye.

def test_a_replaced_panel_is_kept_as_an_alternate():
    meta = after({"panel_asset_id": "first"}, "second", "panel")
    assert meta["panel_asset_id"] == "second"
    assert meta["panel_alts"] == ["first"]


def test_a_first_draw_leaves_no_alternates():
    """Nothing was replaced, so there is nothing to offer — a beat drawn for
    the first time must not come back with a one-entry rail."""
    meta = after({}, "first", "panel")
    assert "panel_alts" not in meta


def test_redrawing_the_same_panel_twice_does_not_fill_the_list():
    meta = after({"panel_asset_id": "same"}, "same", "panel")
    assert "panel_alts" not in meta


def test_successive_redraws_read_as_the_shot_s_history():
    meta = {}
    for name in ("p1", "p2", "p3"):
        meta = after(meta, name, "panel")
    assert meta["panel_asset_id"] == "p3"
    assert meta["panel_alts"] == ["p1", "p2"]


def test_history_is_bounded_by_the_same_ceiling():
    meta = {}
    for i in range(images.PANEL_ALTS_KEPT + 5):
        meta = after(meta, f"p{i}", "panel")
    assert len(meta["panel_alts"]) == images.PANEL_ALTS_KEPT


def test_promoting_back_and_redrawing_does_not_duplicate():
    """The rail's own click sets `panel_asset_id` to an id already in the
    list; the next redraw displaces it, and it must not appear twice."""
    meta = after({}, "p1", "panel")          # first draw
    meta = after(meta, "p2", "panel")        # redraw: p1 kept
    meta["panel_asset_id"] = "p1"            # promoted back from the rail
    meta = after(meta, "p3", "panel")        # redraw again: p1 displaced
    assert meta["panel_alts"].count("p1") == 1

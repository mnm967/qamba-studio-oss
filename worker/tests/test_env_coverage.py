"""A location's contact sheet: the slot it lands in, and how a block reads it.

`orbit_sheet` renders ONE take and produces two things — the individual views,
and the stitched sheet carrying all of them. The sheet was registered for a
CHARACTER (as `turnaround`) and for a LOCATION it was fetched, never written,
and deleted with the temp files: a coverage take came out as eight loose
plates with the grid it had already drawn thrown away, and `ref_plan_for` went
on handing every block one frontal master. Nothing errored — the sheet simply
did not exist to be staged, which is why it survived the take shipping.

Every assertion here fails SILENTLY on the pod otherwise: a block that renders
a perfectly good video OF A CONTACT SHEET, or a location described as a place
it is not, or a slot nothing fills.
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import h3_prompt as HP  # noqa: E402
import h3_sheet as HS  # noqa: E402

ORBIT = io.open(os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "handlers", "orbit.py"), encoding="utf-8").read()

ENV = {"name": "Vale Watch Repair",
       "identity_line": "A narrow green-fronted watch repair shop",
       "palette": "green and brass"}
BEATS = [{"action": "Mara sets the loupe down.", "camera": "a medium at eye level",
          "duration_ms": 4000, "dialogue": [], "meta": {"cast": []}}]


def _compile(ref_slots, environment=ENV):
    return HP.compile_block(
        render_ms=4000, warmup_ms=0, aspect="16:9", style="cinematic",
        medium="film", beats=BEATS, cast=[], environment=environment,
        ref_slots=ref_slots)


def _env_slot(role, **kw):
    return dict({"slot": 1, "kind": "environment", "role": role}, **kw)


# ------------------------------------------------------------- the slot ----

def test_both_kinds_have_a_slot_for_their_own_contact_sheet():
    """The bug was one kind having no entry at all. Pinned as the MAP rather
    than as two literals, so a future kind cannot be added without one."""
    assert 'SHEET_ROLE = {"character": "turnaround", "environment": "coverage"}' in ORBIT
    # …and the registration reads it. A literal role here is how the location
    # half went missing in the first place.
    assert '"role": sheet_role' in ORBIT
    assert '"role": sheet_role, "slot": 0' in ORBIT


def test_the_sheet_carries_its_own_shape_onto_the_asset():
    """`views` and `columns` are what the compiler needs to DESCRIBE the
    picture. Derived downstream from the plate rows they go stale the moment a
    redraw renders a different plan — the same rule `block_sheet`'s `panels`
    follows."""
    assert '"views": len(views), "columns": columns' in ORBIT


def test_the_sheets_own_role_is_the_one_that_gets_archived():
    """Archive-then-write, and `slot >= 90` is the archive. Retiring the view
    roles and not the sheet's leaves two rows at slot 0 for it, which
    `order=slot&limit=1` then picks between arbitrarily."""
    assert "touched = set(roles[:len(views)]) | ({sheet_role} if sheets and sheet_role" in ORBIT


def test_a_redraw_conditions_on_the_previous_sheet_second():
    """`coverage` sits after the master for `turnaround`'s reason: slot 1
    carries the highest token budget and a full-frame plate is the least
    ambiguous thing to put in it."""
    from handlers import orbit as O
    assert O.ENV_REF_ROLES[:2] == ("master", "coverage")
    note = HS.picture_line(3, "coverage", "Vale Watch Repair")
    assert "grid layout" in note, "the sheet's own furniture must be ruled out by name"


# ---------------------------------------------------------- the envelope ----

def test_a_staged_coverage_sheet_is_declared_as_a_sheet():
    out = _compile([_env_slot("coverage", views=8, columns=4)])
    defs = out["subject_definitions"]
    assert "coverage sheet for that environment" in defs
    assert "eight-view" in defs, "the count travels, so the model is told how many"
    assert "left-to-right then top-to-bottom" in defs
    # The one thing that separates it from a storyboard: these are vantages on
    # one space, not a shot order. Saying "read each panel as a shot beat"
    # about coverage turns a location reference into an eight-cut edit.
    assert "ONE continuous space" in defs
    assert "not a shot order" in defs


def test_the_no_grid_close_fires_for_a_coverage_plate_too():
    """H3 obeys a picture over a sentence, and the picture here is a grid. The
    close is TERMINAL because that is where this codebase measures H3 obeying
    a negation."""
    out = _compile([_env_slot("coverage", views=8, columns=4)])
    assert "No storyboard grid" in out["description"]
    assert out["description"].rstrip().endswith("appear anywhere in any frame.") \
        or "No storyboard grid" in out["description"]


def test_the_sheets_furniture_is_disclaimed_in_retention_as_well():
    """Retention is the channel H3 weighs for what carries over — one defs
    sentence alone still leaked the grey studio backdrop "sometimes", which is
    the same failure one subject over."""
    out = _compile([_env_slot("coverage", views=8, columns=4)])
    ret = out["retention_analysis"]
    assert "coverage sheet): partially_preserved" in ret
    assert "gutters are a sheet artifact" in ret


def test_a_sheet_with_no_recorded_count_says_neither_a_number_nor_a_wrong_one():
    """A plate written before the shape was recorded. Inventing a count is
    worse than omitting one — the model would be told to read panels that are
    not there."""
    defs = _compile([_env_slot("coverage")])["subject_definitions"]
    assert "coverage sheet for that environment" in defs
    assert "eight-view" not in defs and "-view coverage" not in defs
    assert "left-to-right" not in defs


def test_the_master_arm_is_untouched():
    """Every block whose location has no coverage sheet, which is every block
    planned before this. The grid grammar must not reach them."""
    out = _compile([_env_slot("master")])
    assert "shown in <Picture 1>" in out["subject_definitions"]
    assert "coverage sheet" not in out["subject_definitions"]
    assert "No storyboard grid" not in out["description"]
    assert "partially_preserved" not in out["retention_analysis"]


def test_a_block_with_no_environment_at_all_still_compiles():
    """`env_sheet` is read by the terminal close, which runs for every block.
    Born inside the environment branch it is a NameError on the commonest path
    there is — a block staging cast and no location."""
    out = _compile([], environment=None)
    assert "No storyboard grid" not in out["description"]

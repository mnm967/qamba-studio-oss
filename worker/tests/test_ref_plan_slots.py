"""Which PICTURE a block is handed for a character and for a location.

Both of these shipped wrong and were invisible: the plan named the right
entry, so every surface said "Aki Minase" and "The city rooftops" while the
asset underneath was the wrong one.
"""
import re
import pathlib

SRC = (pathlib.Path(__file__).resolve().parents[1] / "handlers" / "blocks.py").read_text()


def test_character_sheets_exclude_the_archive():
    """`slot >= 90` is where regen_sheets.py parks a REPLACED sheet. The
    lookup had no filter and `{role: r}` over a slot-ASCENDING list is
    last-wins, so the archived sheet beat the live one for every role —
    measured on AFTERLIGHT v4, Aki's body reference in a rooftop night scene
    was her archived print-shop-uniform plate."""
    blk = SRC.split("for cid in cast_ids:")[1].split("# Voice-timbre")[0]
    q = re.search(r'bible_assets\?entry_id=eq\.\{cid\}[^"]*', blk).group(0)
    assert "slot=lt.90" in q, "character sheet lookup must exclude the archive"
    # and lowest-slot-wins, not last-wins
    assert "setdefault" in blk, "by_role must keep the LOWEST slot per role"
    assert "{r[\"role\"]: r for r in slots}" not in blk


def test_the_environment_reference_is_NAMED_and_never_an_arbitrary_plate():
    """A location carries master / alt_angle / detail / atmosphere / coverage,
    all at slot 0. Asking only for the lowest slot returned an arbitrary one —
    COLD-OPEN was conditioned on a `detail` close-up as its only picture of
    the place — so the roles are named, in a preference order.

    `coverage` leads it: a block stages exactly ONE picture of the place and
    `<Picture N>` is positional, so a contact sheet of every placement costs
    the same slot as one frontal frame. That is the character side's
    turnaround rule, arriving one kind over. `master` is the floor and must
    stay in the list — it is what every location planned before the coverage
    take has, which is nearly all of them.
    """
    seg = SRC.split("if env_id:")[1][:3400]
    assert 'env_roles = ["master"]' in seg, "the master must always be reachable"
    assert 'env_roles.insert(0, "coverage")' in seg, "the sheet outranks it"
    assert 'get("env_coverage", True)' in seg, "…and the arm stays switchable"
    assert "role=eq.{role}" in seg, "the role is named, not taken by slot order"
    assert "slot=lt.90" in seg


# ---------------------------------------------------------------------------
# A PROP THAT NAMES ITS SCENES USED TO STAGE NOWHERE. Measured on TEMPLE DUEL:
# `Temple staff` and `Altar candles` both declared
# ['THE MEASURE', 'THE PRESS', 'THE LESSON'] — the writer's prose spelling —
# while the scenes' own slugs are THE_MEASURE / THE_PRESS / THE_LESSON. The
# set intersection was therefore always empty, and declaring a scene list made
# a prop strictly WORSE off than declaring none (which stages globally).
# Nothing errored; the filter did exactly what it says.
# ---------------------------------------------------------------------------

def test_slug_comparison_is_normalised_on_every_side():
    """Both halves must go through the normaliser. Fixing only `declared`
    leaves the comparison exactly as broken as before."""
    assert "str(x).upper() for x in (doc.get(\"scenes\")" not in SRC
    assert "str(x).upper() for x in (pdoc.get(\"scenes\")" not in SRC
    assert SRC.count("_slugkey(") >= 6, "declared, want, slug_set and the scene_id lookup"


def test_slugkey_folds_the_two_spellings():
    import os
    os.environ.setdefault("SUPABASE_URL", "http://x")
    os.environ.setdefault("SUPABASE_ANON_KEY", "local")
    os.environ.setdefault("SUPABASE_ACCESS_TOKEN", "x")
    from handlers.blocks import _slugkey
    assert _slugkey("THE PRESS") == _slugkey("THE_PRESS")
    assert _slugkey("the-press") == _slugkey("THE_PRESS")
    assert _slugkey("  The Press  ") == _slugkey("THE_PRESS")
    # …and does not collapse genuinely different scenes together.
    assert _slugkey("THE_PRESS") != _slugkey("THE_LESSON")
    assert _slugkey(None) == ""

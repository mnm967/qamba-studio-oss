"""One identity picture per PERSON, not per bible row.

MEASURED on this studio's Rei EP03 v6, block idx 15 (2026-09-01): the plan
staged asset `66e0fdf4…` — Villian Rei's sheet — TWICE, spending one of eight
picture slots on a picture already in the set.

The cause is that a block routinely casts one person twice. `meta.cast` holds
whichever spelling the shot used and the cinematographer mixes them within a
scene, so that block's beats said both `Villian Rei` and `Villian Rei —
Glitching capture coat`. Both resolve to bible rows, and a variant with no
sheet of its own follows `doc.variant_of` to the parent's — so the two rows
hand back the same asset.

Where the variant DOES have its own sheet it is worse: two DIFFERENT pictures
of one person, disagreeing about the wardrobe, against a rule this codebase
states in as many words ("ONE identity picture per character, FULL STOP").

Parsed rather than executed: `ref_plan_for` is 300 lines of `sb.get` against a
live PostgREST with no seam to inject rows through — the same situation
`test_review_gate.py` and `scoreTrack.test.ts` are in.
"""
import pathlib
import re

SRC = pathlib.Path(__file__).resolve().parent.parent / "handlers" / "blocks.py"
BODY = SRC.read_text().replace("\r\n", "\n")


def _fn(name):
    at = BODY.index(f"def {name}(")
    nxt = BODY.find("\ndef ", at + 1)
    return BODY[at: nxt if nxt > 0 else len(BODY)]


REF_PLAN = _fn("ref_plan_for")


def test_identity_entries_are_deduped_before_they_reach_the_plan():
    assert "staged_ident" in REF_PLAN, (
        "the identity dedup is gone — a block casting one person under both "
        "spellings stages her sheet twice and spends a picture slot on it")
    # Keyed on the BASE name. Deduping on the asset only catches the case where
    # the variant has no sheet of its own; the base name catches both.
    seg = REF_PLAN.split("staged_ident.get(")[1][:200]
    assert seg.startswith("base"), f"dedup is not keyed on the base name: {seg[:60]!r}"


def test_the_entrys_OWN_sheet_wins_over_a_parent_fallback():
    # Whichever order the rows arrive in. A variant's own sheet is the only
    # picture of the costume that makes it a variant; the parent's is not.
    assert re.search(r"elif own and not prior\[1\]", REF_PLAN), \
        "the own-sheet-wins rule is gone"
    assert "own = pick is not None" in REF_PLAN, \
        "`own` is no longer computed before the parent-fallback branch, so a " \
        "parent's sheet is indistinguishable from the variant's own"


def test_a_replacement_keeps_its_POSITION():
    # `<Picture N>` is positional and the ordering decides who holds image1 —
    # the strong slot. Re-appending a replaced entry moves that person to the
    # back of the set.
    assert "plan[prior[0]] = ent" in REF_PLAN, \
        "the better sheet no longer replaces in place"
    body = REF_PLAN.split("elif own and not prior[1]:")[1][:220]
    assert "plan.append" not in body, \
        "a replacement appends instead of replacing — that reorders the set"


def test_a_person_staged_once_is_still_staged():
    # The obvious way to break a dedup is to drop everyone. A first sighting
    # must append.
    assert re.search(r"if prior is None:\s*\n\s*staged_ident\[base\] = \(len\(plan\), own\)"
                     r"\s*\n\s*plan\.append\(ent\)", REF_PLAN), \
        "a first sighting no longer appends"

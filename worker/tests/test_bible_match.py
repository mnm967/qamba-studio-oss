"""A re-plan must not write a second entry for someone already in the bible.

`_find_entry` matched names EXACTLY, so the writer filing her as "Guide Rei" on
one run and "Rei" on the next produced two characters with two face sheets —
two people on screen who are meant to be one. It now uses the same unambiguous
token-subset rule `storyplan.duplicate_cast` does, with the same both-sides
guard, because that guard is what stops "Rei" being bound to her own guide in a
cast that deliberately holds four of her.

Reuse is the cheap direction to be wrong in — nothing is deleted, an existing
row is referenced — but a wrong bind still costs a face, so the refusals are
reported instead of being silent.
"""
import llm


def E(kind, name, **kw):
    return {"id": f"{kind}:{name}", "kind": kind, "name": name, **kw}


REI = [
    E("character", "Rei"),
    E("character", "Guide Rei"),
    E("character", "Knight Rei"),
    E("character", "Villian Rei"),
    E("environment", "Plant World"),
]


def test_an_exact_name_is_the_same_entry():
    assert llm._find_entry(REI, "character", "Guide Rei")["name"] == "Guide Rei"
    assert llm._find_entry(REI, "character", "  guide rei ")["name"] == "Guide Rei"


def test_a_kind_is_never_crossed():
    assert llm._find_entry(REI, "environment", "Guide Rei") is None
    assert llm._find_entry(REI, "prop", "Plant World") is None


def test_an_unambiguous_shortening_is_the_same_person():
    """The case this was written for: the writer says 'Mika' this run and
    'Mika Chen' last run, and nothing recognised the pair."""
    bible = [E("character", "Mika Chen"), E("character", "Haru")]
    assert llm._find_entry(bible, "character", "Mika")["name"] == "Mika Chen"
    assert llm._find_entry(bible, "character", "Mika Chen")["name"] == "Mika Chen"


def test_a_name_inside_several_is_refused_from_both_sides():
    """'Rei' sits inside three entries, so no reading says which she is.
    'Guide Rei' contains only 'Rei' and looks unambiguous from where IT stands
    — checking one side would merge the protagonist into her own guide."""
    assert llm._find_entry(REI, "character", "Rei")["name"] == "Rei"      # exact wins
    bible = [e for e in REI if e["name"] != "Rei"]                        # …now no exact
    assert llm._find_entry(bible, "character", "Rei") is None


def test_a_new_name_containing_two_existing_ones_is_refused():
    assert llm._find_entry(REI, "character", "Rei the Guide") is None


def test_an_unrelated_name_is_new():
    assert llm._find_entry(REI, "character", "Haru") is None
    assert llm._find_entry([], "character", "Anyone") is None
    assert llm._find_entry(REI, "character", "") is None


def test_a_refusal_is_reported_rather_than_silent():
    near = llm.near_duplicate_names(REI, "character", "Rei the Guide")
    assert sorted(near) == ["Guide Rei", "Rei"]
    # An entry that IS the match reports nothing about itself…
    assert llm.near_duplicate_names(REI, "character", "Guide Rei") == ["Rei"]
    # …and a genuinely new name has nothing to report.
    assert llm.near_duplicate_names(REI, "character", "Haru") == []
    assert llm.near_duplicate_names(REI, "environment", "Rei") == []


def test_punctuation_and_case_do_not_make_a_new_person():
    bible = [E("character", "Mrs. Katagiri")]
    assert llm._find_entry(bible, "character", "mrs katagiri")["name"] == "Mrs. Katagiri"


def test_a_split_location_stays_two_places():
    """One environment is one SETUP — its plates are four angles on one view —
    so a place seen from outside AND from within is written as two entries
    (`storyplan`'s writer contract). The pair must survive matching."""
    bible = [E("environment", "Observatory — EXTERIOR"),
             E("environment", "Observatory — INTERIOR")]
    assert llm._find_entry(bible, "environment",
                           "Observatory — INTERIOR")["name"].endswith("INTERIOR")
    assert llm._find_entry(bible, "environment", "Observatory") is None
    assert sorted(llm.near_duplicate_names(bible, "environment", "Observatory")) == [
        "Observatory — EXTERIOR", "Observatory — INTERIOR"]


def test_only_people_match_on_a_token_subset():
    """A person's name is an IDENTIFIER and identifiers shorten; a prop or
    location name is a DESCRIPTION and descriptions compose. Measured on the
    first real re-plan: "Training doorway creature" was bound to the prop
    "Training doorway", so a creature became a reflective rectangle in a chalk
    circle and no sheet for it was ever queued."""
    props = [E("prop", "Training doorway")]
    assert llm._find_entry(props, "prop", "Training doorway creature") is None
    assert llm._find_entry(props, "prop", "Training doorway")["name"] == "Training doorway"
    # …but the reported near-miss still names it, so the new entry is one
    # somebody was told about.
    assert llm.near_duplicate_names(props, "prop", "Training doorway creature") == [
        "Training doorway"]
    # A single-word location is the same trap one word further apart.
    envs = [E("environment", "Glass House")]
    assert llm._find_entry(envs, "environment", "Glass House ruins") is None
    # People keep the rule the evidence was gathered on.
    cast = [E("character", "Mika Chen")]
    assert llm._find_entry(cast, "character", "Mika")["name"] == "Mika Chen"


def test_an_outfit_variant_is_not_folded_into_its_parent():
    """`doc.variant_of` children are named '<parent> — <outfit>' and are their
    own castable entries. Token-subset would happily swallow one."""
    bible = [E("character", "Aki Minase"),
             E("character", "Aki Minase — Print-shop uniform")]
    hit = llm._find_entry(bible, "character", "Aki Minase")
    assert hit["name"] == "Aki Minase"
    hit = llm._find_entry(bible, "character", "Aki Minase — Print-shop uniform")
    assert hit["name"] == "Aki Minase — Print-shop uniform"


# ---------------------------------------------------------- identity binding --
# The name is a label; the identity line is the content. Measured on Rei E4:
# the writer copied "Interdimensional Observatory Hideout"'s identity line
# word for word onto a new entry named "… — INTERIOR", the name matcher
# correctly refused the name, and the bible grew a twin with its own plates.

OBS_IDENT = ("A cracked glass dome crowns tarnished brass instruments, dusty "
             "blue star charts cover curved walls, amber lamps pool over "
             "repaired tables, and violet portal light stains the central floor.")


def _obs():
    return [{"id": "e1", "kind": "environment",
             "name": "Interdimensional Observatory Hideout",
             "identity_line": OBS_IDENT, "doc": {}}]


def test_a_copied_identity_binds_whatever_the_name_says():
    hit = llm._find_entry(_obs(), "environment",
                          "Interdimensional Observatory Hideout — INTERIOR",
                          identity=OBS_IDENT)
    assert hit and hit["id"] == "e1"


def test_a_lightly_edited_copy_still_binds():
    edited = OBS_IDENT.replace("violet portal light", "soft violet light")
    hit = llm._find_entry(_obs(), "environment", "Observatory Interior",
                          identity=edited)
    assert hit and hit["id"] == "e1"


def test_a_paraphrase_stays_a_separate_entry():
    # A genuinely different setup of the same place must NOT bind — the
    # interior/exterior convention exists to give it its own plates.
    hit = llm._find_entry(_obs(), "environment",
                          "Interdimensional Observatory Hideout — EXTERIOR",
                          identity="The domed observatory seen from the ridge "
                                   "outside, its cracked glass catching dawn, "
                                   "moss on the stone foundations and a rope "
                                   "bridge to the entrance.")
    assert hit is None


def test_identity_binding_respects_kind():
    hit = llm._find_entry(_obs(), "prop", "Observatory model", identity=OBS_IDENT)
    assert hit is None


def test_short_identities_never_bind():
    # Six distinct words is below the floor — "a dark room" matching another
    # "a dark room" proves nothing about being the same place.
    hit = llm._find_entry(_obs() + [{"id": "e2", "kind": "environment",
                                     "name": "Cell", "identity_line": "a dark room",
                                     "doc": {}}],
                          "environment", "Vault", identity="a dark room")
    assert hit is None

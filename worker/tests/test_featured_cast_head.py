"""`featured_cast` finds a person by the name the prose actually uses.

The tail fallback was written for entity names — "Fractured Reflection
Creature" is called "the creature" — and it looks at the wrong end of a
person's name. The cinematographer writes prose, and prose calls Osei Kofi
"Osei".

MEASURED on THE LAST SERVICE (2026-08-21): across all 49 shots the camera and
action text named cast members 74 times by FIRST name and ZERO times in full.
So exact matching found nobody, `feat` was empty on every beat, every panel
fell back to the roster, and the staging decision this function exists to make
— plus the mention-ORDER rule that decides who gets image1 — was inert for the
whole storyboard.

It is not a neutral failure. On a wide, `order_anchors(faces_when_wide=1)`
stages the location plate and ONE face; the second character stays named twice
in the action prose with no sheet, and the model draws them from words. The
observed result was a DUPLICATE of the staged character, in her own rust-red
sweater and satchel, standing in for a 60-year-old man.
"""
from image_prompt import featured_cast as F

CAST = ["Mara Vale", "Osei Kofi"]
ACTION = ("Mara stands at the front edge of the walnut repair bench with the "
          "turned tool tray between her and Osei. Osei remains seated beneath "
          "the wall of stopped clocks.")


def test_the_shot_that_produced_a_second_mara():
    assert F(ACTION, CAST) == ["Mara Vale", "Osei Kofi"]


def test_mention_order_still_decides_slot_one():
    """image1 carries the high token budget; whoever the text names first gets
    the conditioning. That rule only works if the names match at all."""
    assert F("Osei looks up. Mara does not move.", CAST)[0] == "Osei Kofi"


def test_a_bare_first_name_never_swallows_a_variant():
    """The guard the tail rule already had, carried over unchanged: 'Guide
    Rei' has the head 'guide', while its tail 'rei' has two owners and is
    skipped — so a bare 'Rei' is Rei and nobody else."""
    assert F("Rei turns away", ["Rei", "Guide Rei", "Astronaut Rei"]) == ["Rei"]
    assert F("Guide Rei steps in", ["Rei", "Guide Rei", "Astronaut Rei"]) == ["Guide Rei"]


def test_an_ambiguous_first_name_is_a_miss_not_a_guess():
    """Two people who share a given name: neither is credited from it alone.
    Same rule as `match_brief_name` — ambiguity is a miss."""
    got = F("Osei crosses the room", ["Osei Kofi", "Osei Mensah"])
    assert got == []


def test_the_tail_rule_still_finds_a_creature():
    """Tails run before heads, so nothing that resolved before changes."""
    assert F("the creature lunges through the reflection",
             ["Fractured Reflection Creature", "Rei"]) == ["Fractured Reflection Creature"]


def test_a_pronoun_only_beat_still_stages_nobody():
    """Empty means "fall back to the roster" — a beat that casts by pronoun
    must not be un-anchored."""
    assert F("the two stand in silence", ["Mara Vale", "Osei Kofi"]) == []


def test_a_short_first_name_is_not_matched():
    """The >=4 character floor the tail rule already applied: a three-letter
    fragment collides with ordinary prose."""
    assert F("she saw the tam on the hook", ["Tam Reed"]) == []


def test_possessive_rules_survive_a_head_match():
    """A name that only ever OWNS something is not in the shot."""
    assert F("Osei's watch sits open on the bench", CAST) == []
    assert F("Osei's hands sit open on the bench", CAST) == ["Osei Kofi"]


# ---------------------------------------------------------------------------
# A THREE-LETTER GIVEN NAME. The >=4 floor above was replaced by two sharper
# guards after TEMPLE DUEL rendered a two-hander duel with only one of the two
# fighters declared: the bible filed him as "Master Ren", the cinematographer
# wrote "Ren", and neither the exact pass nor the fallback could see him.
# ---------------------------------------------------------------------------

def test_a_three_letter_given_name_resolves_to_its_bible_entry():
    """The TEMPLE DUEL case. `featured_cast` returned ['Lian'] for every shot
    of blocks 4 and 6, so "stage exactly the featured" dropped Master Ren's
    sheet and the compiled envelope declared no <Subject> for him at all."""
    cast = ["Lian", "Master Ren"]
    assert F("Ren folds beneath the heel and steps clear.", cast) == ["Master Ren"]
    assert F("Lian whips a spinning heel toward Ren's ribs.", cast) == \
        ["Lian", "Master Ren"]


def test_a_short_common_noun_is_told_from_a_name_by_its_determiner():
    """Not by a hand-written vocabulary of short words — English puts an
    article in front of a common noun and nothing in front of a name."""
    assert F("she saw the tam on the hook", ["Tam Reed"]) == []
    assert F("Tam crosses the shop toward the bench", ["Tam Reed"]) == ["Tam Reed"]
    # One bare occurrence is enough; the hat reading needs every one determined.
    assert F("the tam hangs there until Tam lifts it down", ["Tam Reed"]) == \
        ["Tam Reed"]


def test_a_function_word_is_never_a_name_at_any_length():
    """"The Other Reader" has the head "the". No article, pronoun or
    preposition is ever somebody's name, so these are refused categorically —
    the determiner test would never even be reached for them."""
    assert F("the light falls across the floor", ["The Other Reader"]) == []
    assert F("that was all of it", ["That Which Waits"]) == []


def test_two_letters_is_still_refused_outright():
    assert F("she checks the id badge again", ["Id Kwon"]) == []


def test_a_strike_landing_on_a_body_part_keeps_its_owner_in_frame():
    """`ribs` was absent from _BODY_TERMS, so the ONE shot in TEMPLE DUEL b6
    that named Master Ren in full read as him owning a detachable object and
    dropped him. A fight is written almost entirely in body parts."""
    cast = ["Lian", "Master Ren"]
    for part in ("ribs", "torso", "midsection", "forearm", "shin", "chin"):
        assert "Master Ren" in F(f"the staff drives at Master Ren's {part}.", cast), part


def test_a_possessive_over_your_own_motion_keeps_you_in_frame():
    cast = ["Lian", "Master Ren"]
    assert "Lian" in F("Lian's pull meets nothing and carries her past him.", cast)
    # …but a detachable object still leaves its owner out of frame.
    assert F("Osei's watch sits open on the bench.", ["Mara Vale", "Osei Kofi"]) == []

"""What the shot's own text says is IN FRAME, and two ways it lied.

Both were measured on Rei E3 v6's rendered panels, not reasoned about.
"""
import image_prompt as IP

CAST = ["Rei", "Guide Rei", "Knight Rei", "Miko", "Astronaut Rei",
        "Fractured Reflection Creature"]


def test_a_name_that_only_owns_something_is_not_in_frame():
    """MEMORY_RETURN b4: "the photograph remains flat beside Astronaut Rei's
    helmet" staged her sheet, and H3 drew her standing in the observatory —
    a room she is imprisoned a world away from."""
    out = IP.featured_cast(
        "The worn photograph remains flat beside Astronaut Rei's helmet "
        "and the empty cloudy marble.", CAST)
    assert "Astronaut Rei" not in out


def test_a_possessive_over_a_BODY_PART_is_still_the_person():
    """The distinction is detachable vs not. A palm cannot be somewhere she
    is not, so she stages — and dropping her here is the failure in the other
    direction, which is how "the camera pushes in on Villian Rei's tightening
    face" stopped staging Villian Rei."""
    assert "Astronaut Rei" in IP.featured_cast(
        "Astronaut Rei's gloved palm presses against the pane.", CAST)
    assert "Villian Rei" in IP.featured_cast(
        "the camera pushes in on Villian Rei's tightening face", ["Villian Rei"])


def test_a_curly_apostrophe_is_read_as_a_possessive_too():
    assert "Astronaut Rei" not in IP.featured_cast(
        "The photograph lies beside Astronaut Rei’s helmet.", CAST)


def test_but_owning_something_while_present_still_stages():
    """The rule is "ONLY ever possessive", not "possessive anywhere"."""
    out = IP.featured_cast(
        "Miko catches Astronaut Rei's helmet, then Astronaut Rei raises one hand.", CAST)
    assert "Astronaut Rei" in out and "Miko" in out


def test_a_character_called_by_a_common_noun_is_staged():
    """BORROWED_SKY b6 is ABOUT the creature and staged no reference for it,
    so it came back with ordinary human hands."""
    out = IP.featured_cast(
        "The creature lunges through the reflection. Its translucent "
        "needlelike fingers strike the pane where Rei's face had been.", CAST)
    assert "Fractured Reflection Creature" in out


def test_the_common_noun_fallback_never_fires_on_an_ambiguous_tail():
    """"Guide Rei" must not reduce to "rei" and swallow everyone."""
    out = IP.featured_cast("Rei steps back from the reflected city.", CAST)
    assert out == ["Rei"], out


def test_mention_order_still_decides_slot_one():
    out = IP.featured_cast("Villian grips Miko while Knight Rei braces.",
                           ["Miko", "Knight Rei"])
    assert out == ["Miko", "Knight Rei"]


def test_longest_name_first_still_consumes():
    out = IP.featured_cast("Astronaut Rei snaps sideways.", CAST)
    assert out == ["Astronaut Rei"], out


PROPS = ["Guide Rei's Cloudy Marble", "Contained Black Hole Marble",
         "Remember this love photograph", "Cracked-world map", "Portal Machine"]


def test_a_prop_written_the_way_prose_writes_it_is_found():
    """"one cloudy marble" is Guide Rei's Cloudy Marble. Its LAST word alone
    collides with Contained Black Hole Marble, so one-word tails find neither
    — which is why the marble was never staged as a reference."""
    out = IP.featured_cast("Guide Rei follows behind, one cloudy marble in her glove.",
                           PROPS)
    assert out == ["Guide Rei's Cloudy Marble"], out


def test_the_other_marble_is_not_dragged_in_with_it():
    out = IP.featured_cast("She unfolds the contained black hole marble.", PROPS)
    assert out == ["Contained Black Hole Marble"], out


def test_the_photograph_is_found_by_its_common_noun():
    out = IP.featured_cast("Wind lifts the photograph's corner.", PROPS)
    assert out == ["Remember this love photograph"], out

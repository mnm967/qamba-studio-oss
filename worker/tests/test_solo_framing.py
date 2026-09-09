"""A two-figure shot size, at a beat that casts one person.

`shot_framing`'s OVER-THE-SHOULDER text is "framed past one figure's shoulder
onto the other, who faces camera". At a beat whose cast is one name that is a
written instruction to invent the second — and the model obeys it.

MEASURED on THE LAST SERVICE ARRIVAL b4: cast `['Mara Vale']`, camera "an
over-the-shoulder medium close-up behind Mara", and the panel came back with a
man's back in the foreground AND a third woman standing behind her, in a film
with a cast of three.

Dropping the framing is not the answer — a solo over-the-shoulder is a real
shot the cinematographer asks for (here, behind Mara looking through a
doorway). It is rewritten so the foreground shoulder is a COMPOSITIONAL
element rather than a second character, and phrased positively: these panels
render on krea2, whose own guide says an SDXL-family model cannot subtract, so
"no second person" reads as a second person.
"""
from image_prompt import shot_framing, solo_framing

OTS = shot_framing("an over-the-shoulder medium close-up behind Mara")[0]


def test_the_panel_that_grew_two_extras():
    out = solo_framing(OTS, ["Mara Vale"])
    assert "one figure's shoulder onto the other" not in out
    assert "Mara Vale" in out
    assert out.startswith("OVER-THE-SHOULDER")


def test_a_real_two_hander_is_untouched():
    assert solo_framing(OTS, ["Mara Vale", "Osei Kofi"]) == OTS


def test_no_staged_cast_is_untouched():
    """Zero subjects is a location or insert panel; there is no name to put in
    the sentence and nothing to disambiguate."""
    assert solo_framing(OTS, []) == OTS
    assert solo_framing(OTS, None) == OTS


def test_a_two_shot_of_one_person_becomes_a_medium():
    two = shot_framing("a two-shot at eye level")[0]
    out = solo_framing(two, ["Mara Vale"])
    assert "both figures" not in out and "Mara Vale" in out


def test_a_framing_that_never_implied_two_is_untouched():
    for cam in ("a close-up at eye level", "a wide establishing shot",
                "an insert on the watch"):
        f = shot_framing(cam)[0]
        assert solo_framing(f, ["Mara Vale"]) == f, cam


def test_the_rewrite_is_positive_not_a_negation():
    """krea2 cannot subtract — `prompt_guides.js` says so in as many words."""
    out = solo_framing(OTS, ["Mara Vale"])
    for bad in ("no second", "not a second", "without a second", "no other person"):
        assert bad not in out.lower()

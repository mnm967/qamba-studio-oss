"""A beat may spell a cast name EITHER WAY, and the panel must find them.

The cinematographer writes a character as the bible files them ("Villian Rei —
Glitching capture coat") on one beat and by base name ("Villian Rei") on the
next, in one scene. `scene_panel_specs` keyed its lookup by BASE name and read
it with the RAW name, so every full-form beat matched nobody: `named` came back
empty, `featured_cast` was handed an empty roster — it can only ever constrain
someone, never introduce them — and the panel fell through to `cast_rows[:1]`,
the scene's FIRST cast member, who is routinely not in the shot.

Measured on Rei EP04 CITY_CAPTURE_2 b1/b2 (2026-08-31): both beats cast Villian
Rei and Astronaut Rei, both staged GUIDE REI's sheet, and both rendered her
brown jacket while Villian Rei — staged nowhere — was drawn from prose. Nothing
errored, which is why it survived: the fallback is a legal path and exists for
the beat that casts by pronoun.

Twin of the cases at the bottom of src/lib/panelSpec.test.ts.
"""
import llm

# Guide Rei FIRST, exactly as the live scene rows have it — she is what the
# fallback reached for.
CAST = [
    {"id": "e-guide", "name": "Guide Rei", "identity_line": "brown hooded jacket",
     "doc": {}},
    {"id": "e-v-coat", "name": "Villian Rei — Glitching capture coat",
     "identity_line": "black layered coat, glitching seams",
     "doc": {"variant_of": "e-v"}},
    {"id": "e-a", "name": "Astronaut Rei", "identity_line": "orange flight suit",
     "doc": {}},
]
ENV = {"id": "e-city", "name": "Alternate City",
       "identity_line": "flooded neon street"}
CAMERA = ("A wide lateral tracking shot at low angle; the camera follows the "
          "car's spin, then holds as Villian Rei becomes translucent")
ACTION = ("Villian Rei phases through the spinning car, and she solidifies "
          "behind it, already facing Astronaut Rei.")


def shot(cast):
    return [{"camera": CAMERA, "action": ACTION, "cast": list(cast),
             "dialogue": []}]


def test_a_beat_that_spells_a_cast_name_in_full_stages_that_character():
    (anchors, spec), = llm.scene_panel_specs(
        shot(["Villian Rei — Glitching capture coat",
              "Astronaut Rei — Astronaut capture suit"]),
        CAST, ENV, style="Anime (2D)")
    ids = [a.get("entry_id") for a in anchors]
    # the scene's first cast member is not in this shot and must not be staged
    assert "e-guide" not in ids, ids
    # …and the spec DESCRIBES only who was staged: a wide keeps one face, and
    # naming the other over a reference set holding no picture of her is the
    # MEMORY_RETURN b1 failure this module already guards against.
    assert [c["name"] for c in spec["cast"]] == ["Villian Rei"]
    # a wide leads on the plate and carries ONE face by default — whoever the
    # camera names first, which is the mention-order slot-1 rule
    assert ids == ["e-city", "e-v-coat"], ids


def test_a_base_name_beat_still_resolves_to_the_scenes_variant():
    """The control for the fix: `cast_rows` IS the scene's cast, so a base name
    must land on the variant it cast rather than on nothing."""
    (anchors, spec), = llm.scene_panel_specs(
        shot(["Villian Rei", "Astronaut Rei"]), CAST, ENV, style="Anime (2D)")
    ids = [a.get("entry_id") for a in anchors]
    assert ids == ["e-city", "e-v-coat"], ids
    # …and the spec DESCRIBES only who was staged: a wide keeps one face, and
    # naming the other over a reference set holding no picture of her is the
    # MEMORY_RETURN b1 failure this module already guards against.
    assert [c["name"] for c in spec["cast"]] == ["Villian Rei"]


def test_a_beat_naming_nobody_in_its_text_still_falls_back_to_its_roster():
    """The fallback the bug was hiding behind is correct and must survive: a
    beat that casts by pronoun contributes its whole roster, not nobody."""
    shots = [{"camera": "a medium two-shot at eye level",
              "action": "The two stand in silence as the rain thickens.",
              "cast": ["Villian Rei — Glitching capture coat"], "dialogue": []}]
    (anchors, _), = llm.scene_panel_specs(shots, CAST, ENV, style="Anime (2D)")
    ids = [a.get("entry_id") for a in anchors]
    assert "e-v-coat" in ids, ids
    assert "e-guide" not in ids, ids


def test_an_unknown_cast_name_is_dropped_rather_than_raising():
    """A scene whose `cast_ids` still name a deleted entry — a draft discard
    reaches entries a later plan created — must not take the panel down with
    it. The name simply resolves to nobody and the others still stage."""
    (anchors, _), = llm.scene_panel_specs(
        shot(["Villian Rei — Glitching capture coat", "Nobody At All"]),
        CAST, ENV, style="Anime (2D)")
    ids = [a.get("entry_id") for a in anchors]
    assert ids == ["e-city", "e-v-coat"], ids

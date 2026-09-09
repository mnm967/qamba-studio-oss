"""Reference sheets are written for the model that will actually run them.

The prompt used to be an f-string built by whoever enqueued the job, ignoring
`director/prompt_guides.js` entirely. These pin the parts of the guide that are
mechanical: ordering, the word ceiling, no motion language, no negations.
"""
import pytest

import image_prompt as ip

MARA = {"kind": "character", "role": "full_body", "name": "Mara",
        "identity": "shaved head, burn scar on the jaw, salt-bleached oilskin coat",
        "style": "anime"}
BAY = {"kind": "environment", "role": "master", "name": "Halvard Bay",
       "identity": "flooded rooftops, sodium lamps on black water, mist",
       "style": "anime"}


def test_subject_comes_first_for_sdxl_families():
    """Krea 2 reads the front of the prompt hardest, and on a reference sheet
    the identity line is the entire point."""
    out = ip.compose(MARA, "krea2")
    assert out.startswith("Mara, shaved head, burn scar on the jaw")
    # ...and the rest arrives in guide order.
    order = ["full-body", "studio key light", "backdrop", "anime style"]
    positions = [out.find(bit) for bit in order]
    assert all(p > 0 for p in positions), out
    assert positions == sorted(positions), out


def test_no_motion_language_and_no_negations():
    # The BODY stays free of negations and motion grammar. An environment's
    # terminal ENVIRONMENT_EMPTY close-out is the one deliberate exception
    # (measured: H3-rendered plates walked pedestrians through "the location
    # alone" until told "no person" outright), so it is split off before the
    # check rather than exempting the words themselves.
    for spec, fam in [(MARA, "krea2"), (BAY, "krea2"), (MARA, "seedream")]:
        out = ip.compose(spec, fam).lower()
        body = out.split("the place stands completely empty")[0]
        for banned in (" no ", "without", "push in", "push-in", "pan ", "dolly", "tracking",
                       " then "):
            assert banned not in f" {body} ", f"{banned!r} in {body!r}"


def test_a_location_is_not_told_to_keep_a_consistent_character_design():
    out = ip.compose(BAY, "krea2")
    assert "character design" not in out
    assert "coherent art direction" in out
    assert "consistent character design" in ip.compose(MARA, "krea2")


def test_environments_argue_from_both_sides():
    # "Name what IS there" held while plates rendered on krea2 and stopped
    # holding on H3 — a cinematic video model fills an empty set by default.
    # So the subject line still names what is in frame AND the terminal
    # close-out names what is not; the two argue from both sides.
    out = ip.compose(BAY, "krea2")
    assert "the location alone" in out
    assert out.rstrip(".").endswith("anywhere in the frame")
    assert out.startswith("flooded rooftops")


def test_a_location_gets_angles_and_air_not_a_character_turnaround():
    """The sheet slots are the one place a place and a person diverge hardest:
    a location has no face and no outfit, it has other angles onto itself."""
    angles = {r: ip.compose({**BAY, "role": r}, "krea2") for r in ip.ENVIRONMENT_ROLES}
    assert "reverse angle" in angles["alt_angle"]
    assert "materials" in angles["detail"]
    assert "air of the place" in angles["atmosphere"]
    assert len(set(angles.values())) == len(ip.ENVIRONMENT_ROLES)   # four plates, four prompts
    for out in angles.values():
        assert "full-body" not in out and "portrait" not in out


def test_a_character_slot_on_a_location_falls_back_to_the_master():
    """`role` rides along from whatever queued the job, and an old payload (or
    a hand-attached ref) can carry "face" on a location. Shooting a harbour
    head-and-shoulders is worse than shooting it wide."""
    assert ip.compose({**BAY, "role": "face"}, "krea2") == ip.compose(BAY, "krea2")


def test_stays_under_the_sdxl_word_ceiling():
    """The BODY is capped; the style clause is exempt and always survives.

    It used to be one capped string, which meant the richest identity lines
    silently amputated their own style clause and rendered in the model's
    default look — photoreal sheets in an anime project (measured on
    AFTERLIGHT). The ceiling still exists, it just can't eat the one clause
    that decides what the picture looks like."""
    wordy = {**MARA, "identity": " ".join(f"detail{i}" for i in range(90))}
    out = ip.compose(wordy, "krea2")
    style = ip._style_clause(MARA["style"], "stack", "character")
    assert out.endswith(style)
    body = out[:-len(style)].rstrip(" ,")
    assert len(body.split()) <= ip.WORD_CAP
    assert not body.endswith(",")           # cut on a clause, not mid-phrase


def test_prose_families_get_sentences_not_a_keyword_stack():
    out = ip.compose(MARA, "seedream")
    assert out.count(".") >= 2
    assert out.startswith("Mara, shaved head")
    assert "Rendered in anime style" in out
    for sentence in out.split(". "):
        assert sentence[:1] == sentence[:1].upper(), f"lowercase sentence: {sentence!r}"


def test_the_name_is_not_repeated_when_the_identity_already_opens_with_it():
    spec = {**MARA, "identity": "Mara, shaved head and a burn scar"}
    assert ip.compose(spec, "krea2").startswith("Mara, shaved head and a burn scar,")


@pytest.mark.parametrize("role,expected", [
    # `face` is deliberately absent: it is the one role whose framing LEADS as
    # a positive imperative rather than sitting mid-stack as a negation, and it
    # has its own file (test_face_plate.py). See FACE_MOVE.
    ("full_body", "full-body shot"),
    ("side", "profile view"),
    ("outfit", "wardrobe clearly visible"),
])
def test_the_role_decides_the_framing(role, expected):
    assert expected in ip.compose({**MARA, "role": role}, "krea2")


def test_the_face_role_leads_with_its_crop_instead():
    out = ip.compose({**MARA, "role": "face"}, "krea2")
    assert out.startswith(ip.FACE_MOVE.rstrip("."))
    assert "no shoulders" not in out


def test_a_thin_entry_still_produces_something_renderable():
    out = ip.compose({"kind": "character"}, "krea2")
    assert "a person" in out and "full-body" in out
    assert ip.compose({}, None)            # no family, no spec: never raises


def test_unknown_family_falls_back_to_the_stack_shape():
    assert ip.compose(MARA, "wan2.2") == ip.compose(MARA, "krea2")


def test_a_designed_frame_is_neither_a_sheet_nor_an_empty_location():
    """VFX concept frames depict a moment — people included — so the studio
    backdrop and the "location alone" line both have to stay out of them."""
    out = ip.compose({"kind": "scene", "role": "still", "style": "anime",
                      "identity": "the lamp gutters as the water reaches the sill"}, "krea2")
    assert out.startswith("the lamp gutters")
    assert "cinematic frame, 16:9" in out
    assert "backdrop" not in out
    assert "the location alone" not in out
    assert "coherent art direction" in out


def test_the_sheet_spec_the_planner_sends_composes_cleanly():
    import llm
    entry = {"kind": "character", "name": "Mara", "identity_line": "shaved head, burn scar",
             "summary": "the diver"}
    spec = llm._sheet_spec(entry, "anime")
    assert spec == {"kind": "character", "role": "full_body", "name": "Mara",
                    "identity": "shaved head, burn scar", "style": "anime"}
    # The plain-text fallback a pre-prompt_spec worker would use is the same
    # prompt, just composed early.
    assert llm._sheet_prompt(entry, "anime") == ip.compose(spec)


@pytest.mark.parametrize("camera,leads", [
    # the measured failure: this rendered as an eye-level medium two-shot
    ("a wide establishing shot at high angle; a tracking shot follows Aki and "
     "Haru through the black water at slow speed", True),
    ("an extreme wide of the flooded dome; the camera holds a static shot", True),
    ("a full shot of Aki at the rail; the camera pushes in slowly", True),
    ("a wide shot across the platform", True),
    # a figure shot that merely READS the space is not location-led, even
    # though "wide" is a substring of it
    ("a medium wide shot at eye level beside the couch", False),
    ("an extreme close-up of the sketchbook pages at a low angle", False),
    ("a medium close-up of Haru; the camera holds", False),
    ("an over-the-shoulder close-up behind Aki toward Haru", False),
    ("", False),
])
def test_location_leads_only_on_sizes_where_the_space_is_the_subject(camera, leads):
    assert ip.location_leads(camera) is leads


def test_order_anchors_gives_image1_to_the_location_only_when_wide():
    faces = [("A", "Aki's face sheet"), ("H", "Haru's face sheet")]
    env = ("E", "the Observatory location, its master plate")

    wide, first = ip.order_anchors("a wide establishing shot at high angle", faces, env)
    assert first is True
    # location takes image1 and ONE face rides along — at this size identity is
    # a few dozen pixels and the plate has to fill the frame
    assert [a for a, _ in wide] == ["E", "A"]

    close, first2 = ip.order_anchors("a medium close-up of Haru", faces, env)
    assert first2 is False
    assert [a for a, _ in close] == ["A", "H", "E"]

    # pairs stay paired, or [REFERENCES] would name the wrong picture
    assert [t for _, t in wide][0].startswith("the Observatory")
    # no location to lead with -> unchanged
    assert ip.order_anchors("a wide shot", faces, None)[0] == faces


def test_a_panel_is_composed_in_the_dialect_its_model_reads():
    """`kind == "panel"` used to return the bracketed format to EVERY family.

    HiDream-O1's own guidance asks for coherent descriptive sentences at 50-75
    tokens; the bracketed panel prompt is ~350 words of ALL-CAPS sections with
    a 90-word identity paragraph per character, which is the shape it likes
    least. Identity is what the staged reference sheets are for.
    """
    spec = {"kind": "panel", "style": "anime",
            "camera": "a wide establishing shot at high angle",
            "action": "Aki and Haru wade toward the telescope cage",
            "time_of_day": "night",
            "cast": [{"name": "Aki", "identity": "a very long identity line " * 20}],
            "location": {"name": "Hoshimi Observatory",
                         "identity": "a flooded dome knee-deep in still black water"},
            "world": {"palette": "rain-grey blue, indigo"}}
    stack = ip.compose(spec, "krea2")
    prose = ip.compose(spec, "hidream_o1")
    assert "[FRAMING]" in stack and "[LOCKED CHARACTER" in stack
    assert "[" not in prose, prose
    assert len(prose.split()) < 90, f"{len(prose.split())} words"
    # the framing fact survives, as a sentence rather than a shouted directive
    assert "figures small in the frame" in prose
    assert "flooded dome" in prose and "night" in prose
    # style lands at the END, and reads as English
    assert prose.rstrip().endswith(".") and "an anime storyboard frame" in prose
    # the identity paragraph is NOT pasted in — that is the sheets' job
    assert "a very long identity line a very long" not in prose


KNIGHT = {
    "kind": "character", "role": "face", "name": "Knight Rei", "style": "anime",
    "identity": ("Dark wavy chin-length hair with a teal streak, blue eyes, slender "
                 "build, wearing silver-blue plate armor over mail, a dark cloak, "
                 "armored gauntlets, greaves, and period boots, holding a "
                 "cracked-star shield and longsword"),
}


def test_a_face_cropped_from_a_reference_leads_with_the_crop():
    """Measured on h3-image-turbo with the turnaround staged: the composed plate
    put 55 words of armour, cloak, greaves, boots, shield and longsword in front
    of "tight face portrait", and came back as a full-body knight holding the
    sword. The same character asked as "give me a Tight face portrait of her" —
    no identity line at all — came back correct.

    The identity paragraph is not merely in the wrong place, it argues with the
    crop: every clause after "holding" is a reason to draw a body. And it is
    redundant, because the reference IS the identity.
    """
    from image_prompt import compose
    plain = compose(KNIGHT)
    cropped = compose({**KNIGHT, "from_ref": True})
    # The ASYMMETRY is the point, and both halves ask for the crop first. With
    # no reference the identity prose is all there is, so it is TRIMMED to what
    # a head shot can show rather than dropped (FACE_MOVE); with one, the
    # picture carries the identity and the prose goes entirely (CHARACTER_MOVE).
    assert plain.startswith(compose.__globals__["FACE_MOVE"].rstrip("."))
    assert "Knight Rei, Dark wavy" in plain, "the t2i plate still needs its face"
    for word in ("longsword", "shield", "greaves", "boots", "gauntlets"):
        assert word not in plain, f"{word!r} invites a body on a head portrait"
    # One reference: the instruction leads…
    assert cropped.startswith("Crop in tight on this character's FACE")
    # …the equipment that pulled a whole body is gone…
    for word in ("longsword", "shield", "greaves", "boots", "gauntlets", "armor"):
        assert word not in cropped, f"{word!r} still invites a full body"
    # …and the name, the light, the ground and the style all survive.
    assert "Knight Rei" in cropped
    assert "mid-grey backdrop" in cropped and "anime style" in cropped


def test_a_role_that_adds_what_the_reference_lacks_keeps_its_identity():
    """The asymmetry is the whole rule: a face taken off a turnaround is a CROP
    and the prose is redundant, while a full body derived from a face plate is
    the opposite — the wardrobe exists only in the words."""
    from image_prompt import compose
    body = compose({**KNIGHT, "role": "full_body", "from_ref": True})
    assert body.startswith("Knight Rei, Dark wavy")
    assert "longsword" in body and "full-body shot" in body


def test_a_location_is_unaffected_by_the_character_rule():
    from image_prompt import compose
    p = compose({"kind": "environment", "role": "alt_angle", "name": "Observatory",
                 "identity": "a flooded glass dome", "style": "anime",
                 "from_ref": True})
    assert p.startswith("Rotate the camera around this location")
    # A location's description still FOLLOWS its move — the plate has to stay
    # the same place, not just a different camera.
    assert "flooded glass dome" in p


def test_sited_prop_is_shot_in_place_not_on_grey():
    """A prop fixed to a location carries no placement information as a
    product shot on grey, and H3 then puts it anywhere — a scaffold warning
    sign came back filling half the frame."""
    from image_prompt import compose
    grey = compose({"kind": "prop", "name": "Scaffold warning sign",
                    "identity": "a yellow steel KEEP OUT sign", "style": "anime"})
    sited = compose({"kind": "prop", "name": "Scaffold warning sign",
                     "identity": "a yellow steel KEEP OUT sign",
                     "sited": True, "style": "anime"})
    assert "the object alone, centered" in grey
    assert "mid-grey background" in grey
    assert "the object alone, centered" not in sited
    assert "mid-grey background" not in sited
    assert "in place in its own location" in sited
    assert "placement and scale are unambiguous" in sited


def test_illustrated_prop_names_who_is_on_the_page():
    """AFTERLIGHT's sketchbook is Aki's drawings OF HARU and came back full of
    drawings of Aki, because her sheets are what the model had seen most of."""
    from image_prompt import compose
    p = compose({"kind": "prop", "name": "The sketchbook",
                 "identity": "a kraft-paper sketchbook",
                 "depicts": "Haru", "style": "anime"})
    assert "depict Haru" in p
    assert "and no one else" in p


def test_readable_still_names_its_exact_text():
    from image_prompt import compose
    p = compose({"kind": "prop", "name": "Ren's frequency printout",
                 "identity": "a thermal paper strip", "reads": "881.0 MHz",
                 "style": "anime"})
    assert '"881.0 MHz"' in p and "straight-on" in p


# Every shape a prop can take, since the three of them phrase framing
# differently and each one used to name a medium in its own words.
PROP_SHAPES = [
    pytest.param({}, id="plain"),
    pytest.param({"sited": True}, id="sited"),
    pytest.param({"reads": "KEEP OUT"}, id="readable"),
    pytest.param({"depicts": "Haru"}, id="illustrated"),
]


@pytest.mark.parametrize("extra", PROP_SHAPES)
def test_a_prop_never_names_its_own_medium(extra):
    """The style clause is the ONLY place a medium may be named.

    Every prop shape used to state one in its own words — "product
    photograph", "photographed in place", "photographed straight-on" — and in
    a comma-tag prompt that lands in the first ten words while the style clause
    lands sixty words later. Measured on an anime project: all eight props came
    back photoreal product shots while their own prompts ended "…, anime style,
    coherent art direction, high detail", and the locations, whose branch names
    a light rather than a medium, came back anime.
    """
    from image_prompt import compose
    p = compose({"kind": "prop", "name": "The marble",
                 "identity": "a cloudy glass marble with a teal wisp",
                 "style": "anime", **extra})
    assert "anime style" in p                      # the clause still lands
    for word in ("photograph", "photographed", "photo ", "photorealistic"):
        assert word not in p.lower(), f"{word!r} outranks the style clause"


@pytest.mark.parametrize("spec", [
    {"kind": "character", "role": "face"},
    {"kind": "character", "role": "turnaround"},
    {"kind": "environment", "role": "master"},
    {"kind": "environment", "role": "detail"},
    {"kind": "prop", "role": "ref"},
    {"kind": "scene", "role": "still"},
])
def test_no_branch_claims_a_medium_the_style_did_not_ask_for(spec):
    """The same rule, across the whole file — a branch may state framing and
    light, never what the picture is rendered as."""
    from image_prompt import compose
    p = compose({**spec, "name": "Subject", "identity": "a thing", "style": "anime"}).lower()
    for word in ("photograph", "photorealistic", "live-action", "3d render"):
        assert word not in p, f"{spec} says {word!r}"


# --- H3 panels use the vendor's reference envelope ---------------------------
H3_PANEL = {
    "kind": "panel", "style": "Anime (2D)",
    "camera": "a close-up where the face fills most of the frame",
    "action": "Astronaut Rei loses orientation as the bands stream into Villian Rei's hand.",
    "cast": [{"name": "Astronaut Rei", "identity": "orange EVA harness"},
             {"name": "Villian Rei", "identity": "black wrapped coat"}],
    "location": {"name": "Capture Site", "identity": "blue-violet crystal planes"},
    "ref_subjects": [
        {"kind": "character", "name": "Astronaut Rei", "identity": "teal streak, orange harness"},
        {"kind": "character", "name": "Villian Rei", "identity": "blue streak, black coat"},
        {"kind": "location", "name": "Capture Site", "identity": "blue-violet crystal planes"}],
}


def test_an_h3_panel_binds_every_subject_to_its_own_picture():
    """Prose names the people and hopes the encoder works out which staged
    picture is which. Measured on an Astronaut Rei / Villian Rei two-shot: it
    does not — one takes the conditioning and the other drifts, and the render
    is a perfectly good picture of the wrong person."""
    from image_prompt import compose
    out = compose(H3_PANEL, "h3")
    assert out.startswith("subject_definitions:")
    for i, who in enumerate(["Astronaut Rei", "Villian Rei", "Capture Site"], start=1):
        assert f"<Subject {i}> is {who}" in out
        assert f"<Picture {i}>" in out
    assert "retention_analysis:" in out and "fully_preserved" in out
    assert "detailed_description:" in out


def test_the_picture_number_is_the_staged_position():
    """`ref_subjects` rides with `refs`, which rides with `anchors` — so on a
    wide, where the location takes slot 1, it must be <Picture 1> and not keep
    the number it would have had in cast order."""
    from image_prompt import compose
    wide = {**H3_PANEL, "ref_subjects": [H3_PANEL["ref_subjects"][2],
                                         H3_PANEL["ref_subjects"][0]]}
    out = compose(wide, "h3")
    assert "<Subject 1> is Capture Site, the location recorded in <Picture 1>" in out
    assert "<Subject 2> is Astronaut Rei, the person in <Picture 2>" in out


def test_a_reference_that_only_defines_a_character_gets_no_picture_entry():
    """§2.2 of the vendor guide: an image used only to define a character,
    scene, costume or style is cited INSIDE that subject, never as a standalone
    `<Picture N> is …` line. Every panel reference is of that kind."""
    from image_prompt import compose
    out = compose(H3_PANEL, "h3")
    for i in (1, 2, 3):
        assert f"<Picture {i}> is " not in out


def test_the_description_acts_on_the_labels_it_defined():
    from image_prompt import compose
    body = compose(H3_PANEL, "h3").split("detailed_description:")[1]
    assert "<Subject 1> (Astronaut Rei)" in body      # original casing kept
    assert "<Subject 3> (Capture Site)" in body
    # Longest first: "Astronaut Rei" must not be relabelled by a bare "Rei".
    assert "<Subject 2> (Villian Rei)" in body


def test_with_nothing_staged_it_stays_prose():
    """An envelope whose subject_definitions is empty is worse than the prose
    it replaced — there is no binding to state."""
    from image_prompt import compose
    bare = {k: v for k, v in H3_PANEL.items() if k != "ref_subjects"}
    assert compose(bare, "h3") == compose(bare, "seedream")


def test_other_families_are_untouched():
    from image_prompt import compose
    assert compose(H3_PANEL, "krea2").startswith("[STYLE]:")
    assert "subject_definitions" not in compose(H3_PANEL, "seedream")


def test_the_longest_shot_size_wins_however_the_table_is_grouped():
    """SHOT_FRAMING is written grouped by family, which put "close-up" ahead of
    "over-the-shoulder" — so every "over-the-shoulder close-up" the planner
    wrote (three of PLANT-GLASSHOUSE's and MEMORY-RELEASE's fifteen shots)
    composed as a plain CLOSE-UP and the reverse was silently dropped. The
    sort is what makes the docstring's promise true rather than aspirational."""
    from image_prompt import SHOT_FRAMING, shot_framing
    assert shot_framing("an over-the-shoulder close-up behind Rei")[0] \
        .startswith("OVER-THE-SHOULDER")
    assert shot_framing("a medium two-shot at eye level")[0].startswith("TWO-SHOT")
    # the pairs it was already getting right must stay right
    assert shot_framing("a medium close-up at eye level")[0].startswith("MEDIUM CLOSE-UP")
    assert shot_framing("an extreme close-up on the pane")[0].startswith("EXTREME CLOSE-UP")
    assert shot_framing("an extreme wide of the dome")[0].startswith("EXTREME WIDE")
    assert shot_framing("a medium wide of the doorway")[0].startswith("MEDIUM WIDE")
    # and every key still resolves to something rather than falling through
    for key, _ in SHOT_FRAMING:
        assert shot_framing(f"a {key} shot")[0], key


# ---------------------------------------------------------------- location plates
#
# The camera-lock bug: every panel of a scene staged the same master plate, so
# every panel of a scene came back on the same camera.

def test_a_surface_shot_takes_the_detail_plate():
    """An insert or an extreme close-up is a shot ABOUT a surface, and the
    detail plate is a macro of one. Matching them is free accuracy."""
    from image_prompt import location_plate
    for cam in ("an insert at high angle; the camera holds a static shot",
                "an extreme close-up at eye level on the scorched reverse"):
        roles, took = location_plate(cam)
        assert roles[0] == "detail", cam
        # never leaves the anchor unresolvable on a location with one plate
        assert roles[-1] == "master"
        # a fixed pick must not consume a rotation turn
        assert took is False


def test_a_shot_down_the_reverse_axis_takes_the_reverse_plate():
    from image_prompt import location_plate
    for cam in ("an over-the-shoulder close-up behind Rei",
                "a medium shot, reverse angle on the pair",
                "a wide shot from behind the machine"):
        roles, took = location_plate(cam)
        assert roles[0] == "alt_angle", cam
        assert took is False


def test_the_detail_plate_is_never_the_general_environment_reference():
    """A macro of one surface conditioning a medium shot gets you a wall."""
    from image_prompt import PLATE_RING
    assert "detail" not in PLATE_RING


def test_the_turn_counter_skips_the_shots_that_did_not_rotate():
    """THE regression this exists for, on TRAINING-MISFIRE's real camera lines.
    Rotating on the raw BEAT index would advance the ring on the insert and the
    two fixed picks as well, so the rotating shots would land on 0,1,3,6 % 3 =
    master, alt_angle, master, master — two adjacent wides on one plate and the
    third vantage never used at all. Counting only the shots that rotate walks
    the ring properly."""
    from image_prompt import plate_plan
    cameras = [
        "a wide establishing shot at eye level",                    # rotate
        "a medium close-up at eye level toward Rei's hands",        # rotate
        "an insert at high angle as the photograph falls",          # detail
        "a medium shot at eye level beside the creature",           # rotate
        "a low-angle medium shot behind Rei's thrust",              # reverse
        "an extreme close-up at high angle on the reverse",         # detail
        "a wide shot at eye level with Guide Rei's throw",          # rotate
    ]
    assert [p[0] for p in plate_plan(cameras)] == [
        "master", "alt_angle", "detail", "atmosphere", "alt_angle",
        "detail", "master"]


def test_no_two_neighbouring_shots_share_a_vantage():
    """The property that actually breaks the "shot from one seat" look. It is
    NOT global uniqueness: three plates rotating over a scene with four wides
    must repeat, and the repeat lands six shots apart — which is a re-establish,
    not the failure. Widening it is a matter of drawing more plates, not of
    picking differently."""
    from image_prompt import plate_plan
    cameras = ["a wide establishing shot at eye level",
               "a medium shot at eye level",
               "a wide shot of the whole space",
               "a full shot of the pair",
               "a medium wide of the doorway"]
    picks = [p[0] for p in plate_plan(cameras)]
    assert all(a != b for a, b in zip(picks, picks[1:])), picks


def test_a_scene_of_nothing_but_wides_cycles_every_plate():
    from image_prompt import plate_plan
    plan = plate_plan(["a wide establishing shot at eye level"] * 4)
    assert [p[0] for p in plan] == ["master", "alt_angle", "atmosphere", "master"]


PLATE_PANEL = {**H3_PANEL, "camera": "a wide establishing shot at eye level",
               "plate": "alt_angle"}


def test_a_staged_plate_turns_the_framing_into_a_camera_move():
    """ENVIRONMENT_MOVE's lesson one layer up: beside a location plate a
    DESCRIPTIVE framing gets the plate reproduced and an IMPERATIVE gets a new
    vantage. Same words, different mood."""
    from image_prompt import PLATE_MOVE, compose
    out = compose(PLATE_PANEL, "seedream")
    assert out.startswith(PLATE_MOVE)
    # the framing itself survives — this replaces the mood, not the content
    assert "wide establishing view" in out


def test_without_a_plate_the_framing_is_still_described():
    """Sheets, key stills and any panel whose location has no plate on file
    compose exactly as before — the imperative is scoped to a staged plate."""
    from image_prompt import PLATE_MOVE, compose
    bare = {k: v for k, v in PLATE_PANEL.items() if k != "plate"}
    out = compose(bare, "seedream")
    assert PLATE_MOVE not in out
    assert out.startswith("A wide establishing view")


def test_the_location_is_partially_preserved_and_the_cast_is_not():
    """H3 §4.1: `fully_preserved` means the defined role is fully preserved, and
    a location subject claiming it is the model being told to keep the plate's
    camera. `partially_preserved` is the marker for content still used with some
    characteristics changed — keep the place, move the camera. Identity keeps
    `fully_preserved`, which is the whole point of a character sheet."""
    from image_prompt import compose
    ret = compose(PLATE_PANEL, "h3").split("retention_analysis:")[1] \
        .split("detailed_description:")[0]
    loc = [ln for ln in ret.splitlines() if "<Subject 3>" in ln]
    assert loc and "partially_preserved" in loc[0]
    assert "fully_preserved" not in loc[0]
    for s in ("<Subject 1>", "<Subject 2>"):
        assert any("fully_preserved" in ln for ln in ret.splitlines() if s in ln)


def test_the_envelope_names_which_plate_it_was_handed():
    from image_prompt import compose
    out = compose(PLATE_PANEL, "h3")
    assert "its reverse-angle plate" in out
    assert "its master plate" not in out


def test_the_bracketed_families_get_the_move_too():
    """Krea 2 and Qwen-Edit read the bracketed contract, and they stage the same
    plate — [FRAMING] describes the picture wanted, [CAMERA] commands the move."""
    from image_prompt import compose
    out = compose(PLATE_PANEL, "krea2")
    assert "[CAMERA]:" in out and out.index("[FRAMING]:") < out.index("[CAMERA]:")
    assert "[CAMERA]:" not in compose(
        {k: v for k, v in PLATE_PANEL.items() if k != "plate"}, "krea2")


def test_the_plate_ring_matches_its_browser_twin():
    """Same hand-kept-in-step problem as the anchor rule below, and the same
    failure mode: a browser redraw that picks a different plate than the batch
    did produces one odd panel in a scene, with nothing to say why."""
    import pathlib
    import re
    from image_prompt import PLATE_RING
    ts = (pathlib.Path(__file__).resolve().parents[2]
          / "src" / "lib" / "panelSpec.ts").read_text()
    ring = re.search(r'PLATE_RING\s*=\s*\[([^\]]*)\]', ts).group(1)
    assert [x.strip().strip('"') for x in ring.split(",") if x.strip()] == list(PLATE_RING)


def test_the_panel_anchor_rule_matches_its_browser_twin():
    """`panelSpec.ts` and `llm.py` both build panel jobs — the browser redraws
    one, the planner queues the first forty — and they are kept in step BY HAND.
    Fixing only the browser copy is exactly what happened: turnaround-first
    shipped, a new draft went straight back to face plates, and the two halves
    of one feature disagreed with nothing to catch it.
    """
    import pathlib
    import re
    import llm
    ts = (pathlib.Path(__file__).resolve().parents[2]
          / "src" / "lib" / "panelSpec.ts").read_text()
    # Scope to the function BODY: the docstring above it quotes the old
    # `roles: ["face"]` to explain what changed, and a bare findall reads that
    # first and "proves" a rule nobody ships.
    body = ts.split("export function characterAnchor")[1].split("\n}")[0]
    lists = re.findall(r'roles:\s*\[([^\]]*)\]', body)
    parse = lambda s: [x.strip().strip('"') for x in s.split(",") if x.strip()]
    ts_variant, ts_base = parse(lists[0]), parse(lists[1])

    assert llm._character_anchor({"id": "x", "doc": {}})["roles"] == ts_base
    assert llm._character_anchor({"id": "x", "doc": {"variant_of": "p"}})["roles"] == ts_variant
    # `first` is what stops a preference list staging four pictures of one
    # person; both twins must ask for it.
    assert llm._character_anchor({"id": "x", "doc": {}})["first"] is True
    assert "first: true" in ts


# ------------------------------------------------------- empty environments --
# The first draft whose plates rendered on H3 came back with pedestrians in
# them — five and six people walking through frames whose prompt said "the
# location alone". A cinematic video model populates an empty set by default,
# and a positive descriptor mid-stack loses to that prior. The close-out is
# terminal and cap-exempt, the style clause's own treatment: inside the capped
# body a long identity line would amputate exactly this line, invisibly.

def _env_spec(role="alt_angle", **over):
    return {"kind": "environment", "role": role, "name": "Glass House",
            "identity": "An elongated glasshouse of wet black frames "
                        "and iridescent panes stands among emerald vines.",
            "style": "Anime (2D)", **over}


def test_every_environment_role_ends_empty_of_people():
    for role in ("master", "alt_angle", "detail", "atmosphere"):
        for family in ("krea2", "h3"):
            p = ip.compose(_env_spec(role, from_ref=(role != "master")), family)
            assert p.rstrip(".").endswith("anywhere in the frame"), (role, family, p[-90:])


def test_the_empty_clause_survives_a_long_identity_line():
    long_identity = " ".join(["ornate wrought-iron detail"] * 60)
    p = ip.compose(_env_spec("atmosphere", identity=long_identity,
                             note="x " * 40), "krea2")
    assert "empty of people" in p


def test_characters_and_props_are_not_told_to_be_empty():
    char = ip.compose({"kind": "character", "role": "face", "name": "Rei",
                       "identity": "black bob", "style": "Anime (2D)"}, "krea2")
    prop = ip.compose({"kind": "prop", "role": "ref", "name": "Marble",
                       "identity": "a cloudy glass marble", "style": "Anime (2D)"}, "krea2")
    assert "empty of people" not in char
    assert "empty of people" not in prop


# ------------------------------------------------------------ featured_cast --
# The staging decision behind panels: which cast names the shot's own text
# actually says. The trap it exists for is a cast of "Rei" plus four
# "<Something> Rei" variants — ASTRONAUT_CAPTURE's flashback — where a
# substring scan credits plain Rei with every mention of the others.


def test_featured_cast_does_not_credit_rei_with_astronaut_reis_mentions():
    names = ["Miko", "Astronaut Rei", "Villian Rei", "Guide Rei",
             "Knight Rei", "Rei"]
    got = ip.featured_cast(
        "Astronaut Rei snaps both gloved hands sideways and drives suspended "
        "cars through the haze toward Villian Rei.", names)
    assert got == ["Astronaut Rei", "Villian Rei"]


def test_featured_cast_orders_by_mention_and_reads_possessives():
    got = ip.featured_cast(
        "a close-up at dutch angle; the camera pushes in on Villian Rei's "
        "tightening face as Astronaut Rei watches",
        ["Astronaut Rei", "Villian Rei"])
    assert got == ["Villian Rei", "Astronaut Rei"]


def test_featured_cast_is_empty_when_the_text_casts_by_pronoun():
    assert ip.featured_cast("the two stand in silence", ["Rei", "Miko"]) == []


def test_plain_rei_still_matches_when_actually_said():
    got = ip.featured_cast("Rei watches Astronaut Rei fall.",
                           ["Rei", "Astronaut Rei"])
    assert got == ["Rei", "Astronaut Rei"]


def test_a_location_named_after_a_character_does_not_swallow_her_label():
    """Measured on ASTRONAUT_CAPTURE b6, whose location really is called
    "Alternate City — Astronaut Rei Flashback". The location key is the
    longest, so it substituted first, and "astronaut rei" then matched inside
    the location's own label: the stored prompt read `<Subject 3> (Alternate
    City — <Subject 1> (Astronaut Rei) Flashback)` and the shot was told a
    character was part of the place's name. Placeholders make a later name
    unable to match into an earlier replacement."""
    spec = {"kind": "panel", "style": "Anime (2D)",
            "camera": "an extreme close-up at eye level",
            "action": "Astronaut Rei reaches toward the fracture as Villian "
                      "Rei drags her backward ten meters.",
            "cast": [{"name": "Astronaut Rei", "identity": "orange suit"},
                     {"name": "Villian Rei", "identity": "black coat"}],
            "location": {"name": "Alternate City — Astronaut Rei Flashback",
                         "identity": "tilted glass towers over flooded streets"},
            "plate": "alt_angle",
            "refs": ["a", "b", "c"],
            "ref_subjects": [
                {"kind": "character", "name": "Astronaut Rei",
                 "identity": "orange suit"},
                {"kind": "character", "name": "Villian Rei",
                 "identity": "black coat"},
                {"kind": "location", "name": "Alternate City — Astronaut Rei Flashback",
                 "identity": "tilted glass towers"}]}
    out = ip.compose(spec, "h3")
    body = out.split("detailed_description:")[1]
    # the location keeps its own name intact — no subject label spliced inside
    assert "(Alternate City — Astronaut Rei Flashback)" in body
    assert "<Subject 1> (Astronaut Rei) Flashback" not in body
    # and the character still gets bound somewhere in the description
    assert "<Subject 1> (Astronaut Rei)" in body
    # no sentinel leaked into the prompt
    assert "" not in out and "" not in out

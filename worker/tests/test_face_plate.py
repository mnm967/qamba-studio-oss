"""The t2i face plate: a HEAD portrait, asked for as one.

The face plate is the identity anchor every other reference derives from, and
it is the ONE text-to-image sheet in the set — no picture carries the identity,
so every word is drawn from prose. It was being handed the whole identity line,
wardrobe and footwear included, in front of a framing clause that asked for a
head and said "no shoulders" — a negation, mid-stack, in a file that documents
these models cannot subtract.

Measured on THE LATE SHIFT (SenseNova U1.5, 2026-08-29): a prompt ending
"...and brown desert boots, tight face portrait filling the frame... no
shoulders" came back head-and-shoulders in full wardrobe, and "navy
council-issue tabard" rendered as the words COUNCIL ISSUE printed on the chest.
"""
import image_prompt as ip

DENNIS = ("Dennis has close-cropped silver-black hair, dark brown eyes, a "
          "broad build, a small pale scar beneath his left eyebrow, a brown "
          "corduroy jacket over a pale blue shirt, a knitted burgundy tie, "
          "half-moon reading glasses on a cord, and brown desert boots.")
PRIYA = ("Priya has dark brown hair in a high bun with a blue biro through it, "
         "hazel eyes, a slim build, a chipped green-painted thumbnail, an "
         "oversized grey hoodie under a navy council-issue tabard, black "
         "jeans, scuffed white trainers, and a silver hoop in her right ear.")


def _face(name, identity):
    return ip.compose({"kind": "character", "role": "face", "name": name,
                       "identity": identity, "style": "live-action sitcom"})


def test_nothing_below_the_collar_reaches_a_face_plate():
    p = _face("Dennis Okonkwo", DENNIS).lower()
    for gone in ("boots", "corduroy jacket", "shirt", "tie", "broad build"):
        assert gone not in p, f"{gone!r} is in a head-portrait prompt"


def test_the_wardrobe_phrase_that_rendered_AS_TEXT_is_gone():
    """'navy council-issue tabard' came back as COUNCIL ISSUE printed across
    the chest — a wardrobe phrase on a plate that should show no chest."""
    p = _face("Priya Raval", PRIYA).lower()
    for gone in ("tabard", "hoodie", "jeans", "trainers", "thumbnail"):
        assert gone not in p, f"{gone!r} is in a head-portrait prompt"


def test_the_face_itself_survives():
    """Trimming must not gut the anchor: with no reference, this prose IS the
    identity."""
    p = _face("Dennis Okonkwo", DENNIS).lower()
    for kept in ("silver-black hair", "dark brown eyes", "scar", "glasses"):
        assert kept in p, f"{kept!r} was dropped from the identity anchor"
    q = _face("Priya Raval", PRIYA).lower()
    for kept in ("high bun", "hazel eyes", "silver hoop"):
        assert kept in q


def test_the_crop_leads_and_is_stated_positively():
    """Two causes, both measured on Knight Rei: the framing sat BEHIND a
    paragraph arguing for a body, and it asked by negation."""
    p = _face("Dennis Okonkwo", DENNIS)
    assert p.startswith(ip.FACE_MOVE.rstrip(".")), "the crop instruction must lead"
    assert "no shoulders" not in p, "the crop must not be asked for by negation"


def test_a_line_that_is_all_wardrobe_is_kept_whole():
    """A face plate with no identity in it is worse than one with too much."""
    only = "a brown corduroy jacket over a pale blue shirt and brown boots"
    assert ip.face_identity(only) == only


def test_other_roles_keep_the_whole_line():
    """A full body and a turnaround are exactly where the wardrobe belongs."""
    for role in ("full_body", "turnaround", "outfit", "side"):
        p = ip.compose({"kind": "character", "role": role, "name": "Priya",
                        "identity": PRIYA, "style": "x"}).lower()
        assert "tabard" in p, f"{role} lost its wardrobe"


def test_the_crop_from_ref_path_is_untouched():
    """`CHARACTER_MOVE` drops the prose entirely because the PICTURE carries
    the identity. That asymmetry is the point and must survive."""
    p = ip.compose({"kind": "character", "role": "face", "name": "Priya",
                    "identity": PRIYA, "style": "x", "from_ref": True})
    assert p.startswith(ip.CHARACTER_MOVE["face"].rstrip("."))
    assert "hazel eyes" not in p, "the crop path must still drop the prose"


def test_it_is_pure_and_survives_an_empty_line():
    assert ip.face_identity(None) in ("", None)
    assert ip.face_identity("") == ""


# ---------------------------------------------------------------------------
# AGE IS THE ONE IDENTITY FACT A HEAD CROP CANNOT RECOVER FROM WARDROBE.
#
# `identity_line` is the ONLY description a t2i face plate is drawn from, and
# it is repeated verbatim into every shot's subject definition — so a line
# without an age has no age anywhere in the production. Measured on THE LATE
# SHIFT: the brief said "DENNIS OKONKWO, 50s" / "PRIYA, late 20s" / "FENELLA,
# 40s" and all three identity lines came back ageless, with nothing in
# `doc.age` either. Dennis (twenty-two years in the job) rendered as a man in
# his thirties. It was not the writer being careless — the contract asked for
# "hair, eyes, build, distinguishing mark, outfit, accessories" and never for
# an age.
#
# It only became VISIBLE once the face plate stopped carrying the wardrobe:
# "a broad heavy build" was doing the ageing, and a head crop correctly drops
# it. So the trim did not cause this, it uncovered it.

def test_the_writer_is_asked_for_an_apparent_age():
    import pathlib
    src = (pathlib.Path(__file__).resolve().parent.parent
           / "storyplan.py").read_text()
    # the FIRST "identity_line" in the file is a mechanical fallback, not the
    # contract — target the contract's own spec sentence.
    spec = src.split('"identity_line": "ONE sentence')[1][:700]
    assert "APPARENT AGE" in spec, (
        "identity_line must ask for an age — it is the only description the "
        "face plate has and it rides into every shot")


def test_an_age_clause_survives_the_face_trim():
    """The trim drops below the collar; an age is a face fact and must stay."""
    for line in ("Dennis is a Black man in his fifties, with close-cropped "
                 "silver-black hair, a broad heavy build, and brown boots.",
                 "Priya is a South Asian woman in her late twenties, with a "
                 "high bun, hazel eyes, black jeans, and white trainers."):
        out = ip.face_identity(line)
        assert ("fifties" in out or "twenties" in out), out
        assert "boots" not in out and "jeans" not in out


# ---------------------------------------------------------------------------
# A WIDE MUST NOT DROP A CHARACTER THE ACTION PROSE STILL NAMES.
#
# `order_anchors(faces_when_wide=1)` is a SLOT-BUDGET rule from the four-image
# families, and its failure mode was already recorded: the dropped character
# stays named in the prose with no sheet and the model draws them from words.
# Measured on THE LATE SHIFT TRUMPET_INTAKE b1 (SenseNova U1.5) — beat cast
# ["Dennis", "Priya"], action "Priya crosses ... opposite Dennis", ONE face
# staged, and the panel came back with Priya plus TWO invented strangers
# behind the counter and no Dennis.

def test_a_ten_slot_family_keeps_its_faces_on_a_wide():
    assert ip.wide_face_cap("sensenova-u1") == 4
    assert ip.wide_face_cap("h3-image-turbo") == 4


def test_a_four_image_family_still_drops_to_one():
    """Krea 2 takes four images and Qwen three — there the choice is real and
    the plate has to win. Nothing about those families changed."""
    assert ip.wide_face_cap("krea2") == 1
    assert ip.wide_face_cap("qwen-edit") == 1
    assert ip.wide_face_cap(None) == 1


def test_the_cap_actually_reaches_order_anchors():
    faces = [("f1", "a"), ("f2", "b"), ("f3", "c")]
    env = ("env", "loc")
    wide = "a wide establishing shot of the whole room"
    one, _ = ip.order_anchors(wide, faces, env, faces_when_wide=1)
    many, _ = ip.order_anchors(wide, faces, env,
                               faces_when_wide=ip.wide_face_cap("sensenova-u1"))
    assert one == [env, faces[0]], "the small-ceiling behaviour must be intact"
    assert many == [env] + faces, "a ten-slot family must keep every face"
    # …and the LOCATION still leads either way: that is the composition rule,
    # and it is not what was wrong.
    assert many[0] == env


def test_the_planner_passes_it():
    import inspect, llm
    src = inspect.getsource(llm.plan_storyboard)
    assert "wide_faces=image_prompt.wide_face_cap(" in src, (
        "the panel loop must pass the family's wide-face cap, or the default "
        "of 1 silently drops a character on every wide")


# ---------------------------------------------------------------------------
# TWELVE SCENES IN ONE ROOM OPENED ON TWELVE MASTER PLATES.
#
# The plate ring restarted at 0 per SCENE. That is right when consecutive
# scenes are in different places and wrong for a bottle episode: every scene
# then opens on the master, which is the one-camera lock the rotation exists
# to break, re-installed one layer up. Measured on THE LATE SHIFT (12 scenes,
# ONE room): the scene-opening panels correlated at mean 0.809 / worst 0.937
# on the 48x27 luma metric, against 0.532 for the failure that PROMPTED the
# rotation and 0.040 after it shipped. Within a scene the ring was working
# perfectly, so only the openings collided.

def test_the_ring_can_pick_up_where_the_last_scene_left_it():
    cams = ["a wide establishing shot", "a medium two-shot", "a close-up"]
    assert [r[0] for r in ip.plate_plan(cams)][0] == "master"
    assert [r[0] for r in ip.plate_plan(cams, start_turn=1)][0] == "alt_angle"
    assert [r[0] for r in ip.plate_plan(cams, start_turn=2)][0] == "atmosphere"
    # …and it wraps rather than running off the end of the ring.
    assert ([r[0] for r in ip.plate_plan(cams, start_turn=3)]
            == [r[0] for r in ip.plate_plan(cams)])


def test_the_default_is_exactly_the_old_behaviour():
    """Every board planned before the stamp has no `plate_turn`, and must
    compose byte-identically to how it rendered."""
    cams = ["a wide establishing shot", "a tracking shot", "an insert"]
    assert ip.plate_plan(cams) == ip.plate_plan(cams, start_turn=0)
    assert ip.plate_plan(cams) == ip.plate_plan(cams, start_turn=None)


def test_the_turn_is_carried_per_LOCATION_and_stamped():
    """Keyed by environment so a genuine new place still establishes on its
    master, and written to the scene so the browser twin reads the same number
    instead of recomputing one it cannot know."""
    import inspect, llm
    src = inspect.getsource(llm.plan_storyboard)
    assert "plate_turn_by_env" in src
    assert 'scene.get("environment_id")' in src, "must key on the LOCATION"
    assert '"plate_turn"' in src and "scenes?id=eq." in src, "must be stamped"


def test_the_advance_counts_rotating_shots_not_beats():
    """`plate_plan` only advances on the shots that actually take a ring
    plate. Advancing by beat count puts the next scene at an arbitrary point
    and the stamped number stops describing what was staged."""
    import inspect, llm
    src = inspect.getsource(llm.plan_storyboard)
    assert "image_prompt.PLATE_RING" in src

#!/usr/bin/env python3
"""Golden fixtures for the panel prompt, emitted by the REAL composer.

`src/lib/panelPrompt.ts` is a twin of the prose branch of
`worker/image_prompt.py`, and `src/lib/panelSpec.ts` is a twin of its STAGING
decision (`featured_cast` / `remote_speakers`). This is what stops them
drifting. A
hand-written parity test only ever checks the cases somebody thought of; the
failure here is a panel that renders perfectly well and differs from the one
the pod would have drawn, which no assertion about state can see.

So: real specs go through the Python, the strings are committed, and
`panelPrompt.test.ts` asserts the TypeScript reproduces them byte for byte.

    python3 scripts/gen_panel_golden.py            # write
    python3 scripts/gen_panel_golden.py --check    # fail if stale

`--check` is what `worker/tests/test_panel_golden.py` runs, so a change to the
Python composer fails the suite until the fixture is regenerated and the twin
is brought along with it.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "worker"))
os.environ.setdefault("SUPABASE_URL", "http://sb.invalid")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-key")
os.environ.setdefault("B2_BUCKET", "test-bucket")

import image_prompt as IP                                    # noqa: E402

OUT = os.path.join(ROOT, "src", "lib", "__fixtures__", "panel_prompts.json")

REI = {"name": "Villian Rei", "identity": "short black bob with a white streak, red jacket"}
MIKO = {"name": "Miko", "identity": "cropped silver hair, grey coat"}
ASTRO = {"name": "Astronaut Rei", "identity": "orange EVA suit, white-and-grey helmet"}
GUIDE = {"name": "Guide Rei", "identity": "long brown coat, travel-worn boots"}
STREET = {"name": "Flooded Street",
          "identity": "ankle-deep black water under sodium light, shuttered "
                      "storefronts either side, a tram line running down the middle "
                      "and cables sagging overhead between leaning poles"}


def spec(**over):
    base = {"kind": "panel", "style": "anime",
            "camera": "a medium shot, holding still",
            "action": "Villian Rei phases through the spinning car",
            "cast": [REI], "location": STREET}
    base.update(over)
    return base


#: Every branch of `_panel_prose`, plus the cases where the two languages
#: disagree most easily: the word caps (which cut on a clause), the
#: longest-key-wins framing sort, Python's `capitalize`, `rstrip(".")`, and the
#: a/an article test.
CASES = [
    # --- the three opening branches ---------------------------------------
    ("plate and frame", "openai", spec(plate="master",
                                       camera="a wide lateral tracking shot at low angle")),
    ("plate, no frame", "openai", spec(plate="alt_angle", camera="the camera drifts")),
    ("frame, no plate", "openai", spec(camera="an extreme wide shot at high angle")),
    ("neither", "openai", spec(camera="the camera drifts", location=None)),
    ("plate and frame, no angle", "openai", spec(plate="detail", camera="a wide shot")),

    # --- the framing table, including the sort-order trap ------------------
    ("over-the-shoulder close-up", "openai",
     spec(camera="an over-the-shoulder close-up on Rei")),
    ("insert", "openai", spec(camera="an insert on the polaroid")),
    ("two-shot", "openai", spec(camera="a two-shot, eye level")),
    ("extreme close-up", "openai", spec(camera="an extreme close-up of her hand")),
    ("medium close-up", "openai", spec(camera="a medium close-up, worm's eye")),
    ("full shot", "openai", spec(camera="a full shot from overhead")),
    ("establishing", "openai", spec(camera="a wide establishing shot")),
    ("size overrides camera", "openai",
     spec(size="a close-up", camera="an extreme wide shot")),
    ("unknown camera", "openai", spec(camera="the camera does something new")),

    # --- cast --------------------------------------------------------------
    ("no cast", "openai", spec(cast=[])),
    ("two named", "openai", spec(cast=[REI, MIKO])),
    ("four named, cut to three", "openai", spec(cast=[REI, MIKO, ASTRO, GUIDE])),
    ("a blank name is dropped", "openai", spec(cast=[{"name": "  "}, MIKO])),

    # --- the word caps ------------------------------------------------------
    ("long location identity (cap 22, clause cut)", "openai", spec(plate="master")),
    ("long action (cap 30)", "openai", spec(action=(
        "Villian Rei lands on the flooded ground several meters from Astronaut Rei "
        "and stamps one boot hard, and a blue-violet crystallization wave races "
        "outward through the water and beneath the street surface, visible as "
        "glowing crystal veins under the transparent floodwater"))),
    ("long palette (cap 8)", "openai", spec(world={
        "palette": "indigo and rose, sodium amber, wet asphalt black, with cold "
                   "cyan rim light and a bloom on every practical"})),
    ("short palette", "openai", spec(world={"palette": "indigo and rose"})),
    ("world with era only", "openai", spec(world={"era": "1974"})),

    # --- the small string rules --------------------------------------------
    ("action with trailing dots", "openai", spec(action="She turns away...")),
    ("empty action falls back", "openai", spec(action="   ")),
    ("style beginning with a vowel", "openai", spec(style="anime")),
    ("style beginning with a consonant", "openai", spec(style="cinematic 35mm")),
    ("empty style falls back", "openai", spec(style="")),
    ("style beginning uppercase", "openai", spec(style="Ink-wash")),
    ("time of day", "openai", spec(time_of_day="just before dawn")),
    ("messy whitespace everywhere", "openai",
     spec(action="  she   turns \n away  ", style=" anime  ",
          time_of_day="  night ")),
    ("location with no identity", "openai",
     spec(location={"name": "Rooftop"}, plate="master")),
    ("location is not a dict", "openai", spec(location="Rooftop")),

    # --- the other provider -------------------------------------------------
    ("google composes identically", "google", spec(plate="master",
                                                   camera="a wide shot at low angle")),
]


#: `finalize_spec` decides what the composer is even shown: the plate is
#: corrected to the one on file, and the subject list is pruned to the anchors
#: that resolved. Pure given (spec, planned, taken, has_refs), so it goldens
#: exactly like the composer does — and it must, because only the plate
#: correction currently reaches the prose branch and "the part that happens not
#: to matter today" is precisely what rots.
A, B, C = "e-rei", "e-street", "e-ghost"
SUBJ = [{"kind": "character", "name": "Villian Rei"},
        {"kind": "location", "name": "Flooded Street"}]
FINALIZE = [
    ("nothing resolved to nothing", {"plate": "master", "ref_subjects": SUBJ,
                                     "refs": ["a", "b"], "cast_complete": True},
     [{"entry_id": A, "roles": ["turnaround"]}, {"entry_id": B, "roles": ["master"]}],
     [{"entry_id": A, "role": "turnaround"}, {"entry_id": B, "role": "master"}], True),
    ("the plate falls back to what is on file", {"plate": "alt_angle", "ref_subjects": SUBJ},
     [{"entry_id": A}, {"entry_id": B}],
     [{"entry_id": A, "role": "turnaround"}, {"entry_id": B, "role": "master"}], True),
    ("a dropped subject prunes the envelope", {"plate": "master", "ref_subjects": SUBJ,
                                               "refs": ["a", "b"], "cast_complete": True},
     [{"entry_id": C}, {"entry_id": B}],
     [{"entry_id": B, "role": "master"}], True),
    ("no refs means no from_ref", {"ref_subjects": SUBJ}, [], [], False),
    ("a mismatched length is left alone", {"ref_subjects": SUBJ, "cast_complete": True},
     [{"entry_id": A}], [{"entry_id": A, "role": "face"}], True),
    ("a character role never corrects the plate", {"plate": "master", "ref_subjects": SUBJ},
     [{"entry_id": A}, {"entry_id": B}],
     [{"entry_id": A, "role": "turnaround"}, {"entry_id": B, "role": "face"}], True),
]


#: The STAGING decision, which is a different question from the prompt above
#: and had no golden at all — so the two twins were pinned only by
#: hand-written tests, and hand-written parity has now failed twice here. It
#: failed SILENTLY both times: `panelSpec.ts` kept a `>= 4 characters` floor
#: for months after this file replaced it with the function-word and
#: determiner guards, and its own test was NAMED for the old contract ("a
#: short first name is not matched"), so it passed for the wrong reason. The
#: cost was measured on SPINE_RUN: 11 of 59 panels staged one fewer character
#: sheet than the planner had, and H3 drew the missing one from prose.
#:
#: Every case here is a real shape — a three-letter given name, a title-first
#: three-part name, a possessive over an object and over a body part, the
#: determiner test either way, an ambiguous fragment, and the phone caller.
NAMES = ["Lucy Voss", "Kai Renn", "Captain Rhea Dorne", "Dr. Sato Ibarra",
         "Juno Vale", "Mara Voss", "The Reclaimer"]
LAST_SERVICE = ["Mara Vale", "Osei Kofi", "Tam Reed"]
FEATURED = [
    # --- the exact pass and the possessive rule ----------------------------
    ("full names, mention order", "Lucy Voss turns as Kai Renn steps in", NAMES, True),
    ("a possessive over an object", "Osei's watch sits open on the bench", LAST_SERVICE, True),
    ("a possessive over a body part", "Osei's hands sit open on the bench",
     LAST_SERVICE, True),
    ("a possessive over a fight body part", "she drives the staff into Osei's ribs",
     LAST_SERVICE, True),
    ("a possessive over your own motion", "Osei's lunge meets nothing", LAST_SERVICE, True),
    ("props do not exclude possessives", "the photograph's corner is bent",
     ["The Photograph"], False),

    # --- the head/tail fallback --------------------------------------------
    ("a person by first name", "Osei crosses the room toward Mara", LAST_SERVICE, True),
    ("a creature by its tail", "the creature lunges through the reflection",
     ["Fractured Reflection Creature", "Rei"], True),
    ("an ambiguous first name is a miss", "Osei crosses the room",
     ["Osei Kofi", "Osei Mensah"], True),
    ("a bare name never swallows a variant", "Guide Rei steps in",
     ["Rei", "Guide Rei", "Astronaut Rei"], True),

    # --- the guards that replaced the >=4 floor -----------------------------
    ("a three-letter given name IS a person", "Kai closes his burned knuckles around it",
     NAMES, True),
    ("…and a determined common noun is not", "she saw the tam on the hook",
     ["Tam Reed"], True),
    ("…and an undetermined one is", "Tam crosses the shop toward the bench",
     ["Tam Reed"], True),
    # The tail must be AMBIGUOUS or the head is never consulted — the first
    # draft of this case matched on "reader" and proved nothing about the
    # guard it was named for, which is the same disease as the frozen test
    # this fixture exists to replace.
    ("a function word is never a name", "the reader turns the page",
     ["The Other Reader", "The First Reader"], True),

    # --- the MIDDLE rule ----------------------------------------------------
    ("a title-first name is called by its middle",
     "Rhea enters from the lower right and drives south along the grating", NAMES, True),
    ("…including one behind an abbreviation",
     "the pulse reaches the gantry; Sato grips its rail", NAMES, True),
    # Same trap: with one marble the TAIL finds it and the middle rule never
    # runs. Two marbles make "marble" ambiguous, the heads are absent, and the
    # only fragments left are interior ones sitting behind an article.
    ("a determined middle is a common noun, not a name",
     "she sets it down on the glass beside the marble",
     ["Contained Black Hole Marble", "Cloudy Glass Marble"], True),
    ("…and an undetermined one still finds its owner",
     "cloudy glass catches the light",
     ["Contained Black Hole Marble", "Cloudy Glass Marble"], True),
    ("the real SPINE_RUN b3 that shipped wrong",
     "an insert at eye level; the camera Tracking Shot with small amplitude at fast "
     "speed beside the passing hands Lucy comes through frame left behind Rhea and "
     "presses the Shield Array Override Key into Kai's right palm. Kai closes his "
     "burned knuckles around it and breaks toward the west cable trunk, leaving Sato "
     "exposed for a beat behind him.", NAMES, True),
    ("the real two-shot that staged the wrong pair",
     "a medium two-shot at eye level between Rhea and Lucy; the camera Arcs with "
     "medium amplitude at slow speed around Rhea Rhea leaves the cradle edge and "
     "steps into the center work floor toward Juno. Another floor tremor pushes "
     "Lucy's shoulder into the south chest plate.", NAMES, True),

    # --- the empty answer, which is a real answer ---------------------------
    ("a pronoun beat names nobody", "the two stand in silence", NAMES, True),
]

#: `remote_speakers` was absent from the browser twin ENTIRELY, so a voice on
#: the far end of a phone was staged as a character sheet there and dropped
#: here. Both halves matter: the device case must drop, and the in-frame case
#: must NOT — deleting someone who is standing in the room is the worse error.
REMOTE = [
    ("a caller with no body in the shot",
     "Mara Vale holds the phone to her ear at the counter",
     ["Mara Vale", "Tam Reed"], ["Tam Reed"]),
    ("…but a hand on the phone is a body",
     "Tam's hand closes over the phone on the counter",
     ["Mara Vale", "Tam Reed"], ["Tam Reed"]),
    ("no device word, nobody is remote",
     "Mara Vale and Tam Reed stand either side of the bench",
     ["Mara Vale", "Tam Reed"], ["Tam Reed"]),
    ("a title-first name in frame is not a caller",
     "Rhea leans over the intercom while Rhea keeps one boot on the rail",
     ["Captain Rhea Dorne"], ["Captain Rhea Dorne"]),
]


def build():
    from handlers import images as HI
    return {
        "_generated_by": "scripts/gen_panel_golden.py — do not hand-edit",
        "_pins": "src/lib/panelPrompt.ts against worker/image_prompt.py",
        "cases": [
            {"name": name, "family": family, "spec": s,
             "prompt": IP.compose(s, IP.compose_family(
                 "gpt-image-2" if family == "openai" else "nano-banana-2", family))}
            for name, family, s in CASES
        ],
        "finalize": [
            {"name": name, "spec": sp, "planned": planned, "taken": taken,
             "has_refs": has_refs,
             "out": HI.finalize_spec(dict(sp), planned, taken, has_refs)}
            for name, sp, planned, taken, has_refs in FINALIZE
        ],
        "featured_cast": [
            {"name": name, "text": text, "names": names,
             "possessive_excludes": pe,
             "out": IP.featured_cast(text, names, possessive_excludes=pe)}
            for name, text, names, pe in FEATURED
        ],
        "remote_speakers": [
            {"name": name, "text": text, "cast_names": cast, "speakers": spk,
             "out": IP.remote_speakers(text, cast, spk)}
            for name, text, cast, spk in REMOTE
        ],
    }


def main():
    doc = build()
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        have = open(OUT).read() if os.path.exists(OUT) else ""
        if have != text:
            print("panel_prompts.json is STALE — run: python3 scripts/gen_panel_golden.py")
            sys.exit(1)
        print(f"panel golden ok — {len(doc['cases'])} compose, "
              f"{len(doc['finalize'])} finalize, "
              f"{len(doc['featured_cast'])} featured, "
              f"{len(doc['remote_speakers'])} remote")
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w").write(text)
    print(f"wrote {OUT} — {len(doc['cases'])} compose, "
          f"{len(doc['finalize'])} finalize, "
          f"{len(doc['featured_cast'])} featured, "
          f"{len(doc['remote_speakers'])} remote")


if __name__ == "__main__":
    main()

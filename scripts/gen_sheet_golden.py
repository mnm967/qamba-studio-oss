#!/usr/bin/env python3
"""Golden fixtures for the REFERENCE-SHEET prompt, emitted by the REAL composer.

`src/lib/sheetPrompt.ts` is a twin of the prose branch of `compose()` in
`worker/image_prompt.py`, and this is what stops the two drifting. A
hand-written parity test only ever checks the cases somebody thought of; the
failure here is a sheet that renders perfectly well and differs from the one
the pod would have drawn — after which a character's identity anchor depends
on which machine drew it.

So: real specs go through the Python, the strings are committed, and
`sheetPrompt.test.ts` asserts the TypeScript reproduces them byte for byte.

    python3 scripts/gen_sheet_golden.py            # write
    python3 scripts/gen_sheet_golden.py --check    # fail if stale

`--check` is what `worker/tests/test_sheet_golden.py` runs, so a change to the
Python composer fails the suite until the fixture is regenerated and the twin
is brought along with it. Same shape as gen_panel_golden.py next door.
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

OUT = os.path.join(ROOT, "src", "lib", "__fixtures__", "sheet_prompts.json")

# Real lines off this studio's own bibles — the long, clause-heavy shape is the
# whole point: it is what makes the face trim and the name-prefix rule bite.
REI = ("short black bob with a white streak at the left temple, amber eyes, a "
       "slight build, wearing a cropped red jacket over a grey tee, black "
       "cargo trousers and scuffed white trainers")
KNIGHT = ("Knight Rei, dark wavy chin-length hair, grey eyes, a broad heavy "
          "build, in articulated steel plate with armored gauntlets, greaves, "
          "and period boots, holding a cracked-star shield and longsword")
DENNIS = ("a Black man in his fifties, close-cropped greying hair, half-moon "
          "reading glasses on a cord, a navy council-issue tabard and brown "
          "desert boots")
CITY = ("a rain-slicked alternate-city street under sodium light, shuttered "
        "storefronts either side, a tram line running down the middle and "
        "cables sagging overhead between leaning poles")
WORLD = {"era": "1974", "palette": "indigo and rose, sodium amber, wet asphalt black",
         "style_notes": "practical lighting only, no lens flares",
         "vfx_language": "ribbons of emberlight"}


def spec(**over):
    base = {"kind": "character", "role": "full_body", "name": "Villian Rei",
            "identity": REI, "style": "anime"}
    base.update(over)
    return base


def env(**over):
    base = {"kind": "environment", "role": "master",
            "name": "Alternate City — Astronaut Rei Flashback", "identity": CITY}
    base.update(over)
    return spec(**base)


#: Every branch of the prose path through `compose()`, plus the cases where the
#: two languages disagree most easily: Python's `str.replace("..", ".")`
#: (GLOBAL, unlike JS's string form), `capitalize` on the joined body, the
#: `rstrip(".")` on each part, `re.escape` on the name prefix test, and the
#: below-collar trim's `\bWORDs?\b`.
CASES = [
    # --- character, t2i (no reference carrying the identity) ---------------
    ("character full_body", "openai", spec()),
    ("character face trims below the collar", "openai", spec(role="face")),
    ("character face, a knight's equipment line", "openai",
     spec(role="face", name="Knight Rei", identity=KNIGHT)),
    ("character face, THE LATE SHIFT's boots-on-a-head-portrait", "openai",
     spec(role="face", name="Dennis Okonkwo", identity=DENNIS)),
    ("character face, everything looks like wardrobe so the line is kept",
     "openai", spec(role="face", identity="a heavy build in a long coat, holding a case")),
    ("character side", "openai", spec(role="side")),
    ("character outfit", "openai", spec(role="outfit")),
    ("character turnaround", "openai", spec(role="turnaround")),
    ("an unknown character role falls back to full_body", "openai",
     spec(role="detail")),

    # --- character, FROM A REFERENCE: the move leads, the prose goes -------
    ("face from ref drops the identity paragraph", "openai",
     spec(role="face", from_ref=True)),
    ("side from ref", "openai", spec(role="side", from_ref=True)),
    ("full_body from ref keeps the identity (it ADDS information)", "openai",
     spec(role="full_body", from_ref=True)),
    ("turnaround from ref keeps the identity", "openai",
     spec(role="turnaround", from_ref=True)),
    ("face from ref with no name", "openai", spec(role="face", name="", from_ref=True)),

    # --- the name/identity prefix rule ------------------------------------
    ("identity already opens with the name", "openai",
     spec(name="Villian Rei", identity="Villian Rei, short black bob, red jacket")),
    ("a name with regex metacharacters", "openai",
     spec(name="Rei (v2)", identity="short black bob, red jacket")),
    ("no identity at all", "openai", spec(identity="")),
    ("neither name nor identity", "openai", spec(name="", identity="")),

    # --- environment: the plate rotation, which is the reported case ------
    ("environment master", "openai", env()),
    ("environment alt_angle t2i", "openai", env(role="alt_angle")),
    ("environment alt_angle FROM the master — the move leads", "openai",
     env(role="alt_angle", from_ref=True)),
    ("environment detail from ref", "openai", env(role="detail", from_ref=True)),
    ("environment atmosphere from ref", "openai", env(role="atmosphere", from_ref=True)),
    ("environment master from ref has no move and keeps the framing", "openai",
     env(from_ref=True)),
    ("a character role on a location falls back to master", "openai",
     env(role="turnaround")),
    ("environment with no identity", "openai", env(identity="")),

    # --- prop --------------------------------------------------------------
    ("prop plain", "openai",
     spec(kind="prop", role="ref", name="Cloudy Glass Marble",
          identity="a fist-sized marble of cloudy black glass with a hairline crack")),
    ("prop readable", "openai",
     spec(kind="prop", role="ref", name="Registry Notice",
          identity="a folded municipal notice on thin yellow paper",
          reads="ALL RESIDENTS MUST RE-REGISTER BY 14 MARCH")),
    ("prop readable that depicts someone", "openai",
     spec(kind="prop", role="ref", name="Aki's sketchbook",
          identity="a battered A5 sketchbook open to a double page",
          reads="4 MARCH", depicts="Haru Katagiri")),
    ("prop sited in its location", "openai",
     spec(kind="prop", role="ref", name="Scaffold warning sign",
          identity="a yellow-and-black hazard sign zip-tied to scaffold tube",
          reads="DANGER — OVERHEAD WORK", sited=True)),
    ("prop sited with no text", "openai",
     spec(kind="prop", role="ref", name="Weapon rack",
          identity="a floor-standing rack of brass-capped hardwood staffs", sited=True)),

    # --- scene (a designed VFX frame) --------------------------------------
    ("scene still", "openai",
     spec(kind="scene", role="still",
          identity="the split floor of the atrium, rose light welling up through it")),
    ("scene with the world's vfx grammar", "openai",
     spec(kind="scene", role="still", identity="the portal opening over the street",
          world=WORLD)),

    # --- world cohesion ----------------------------------------------------
    ("character with the whole world bible", "openai", spec(world=WORLD)),
    ("a face plate takes the era and NOT the palette", "openai",
     spec(role="face", world=WORLD)),
    ("style_notes ride a location and not a character", "openai", env(world=WORLD)),
    ("world with era only", "openai", spec(world={"era": "1974"})),
    ("world is not a dict", "openai", spec(world="1974")),

    # --- note + style ------------------------------------------------------
    ("a director's tweak is appended", "openai",
     spec(note="make the jacket black and take the trainers off")),
    ("empty style falls back", "openai", spec(style="")),
    ("style on a location says art direction, not character design", "openai",
     env(style="cinematic 35mm")),
    ("messy whitespace everywhere", "openai",
     spec(name="  Villian   Rei ", identity=" short  black \n bob ",
          style=" anime  ", note="  do it  ")),
    ("an identity ending in a period", "openai",
     spec(identity="short black bob with a white streak.")),
    ("a note ending in a period", "openai", spec(note="Make it rain.")),

    # --- the other provider -------------------------------------------------
    ("google composes identically", "google", spec(role="face")),
    ("google, an alt angle from the master", "google", env(role="alt_angle", from_ref=True)),
]


def build():
    return {
        "_generated_by": "scripts/gen_sheet_golden.py — do not hand-edit",
        "_pins": "src/lib/sheetPrompt.ts against worker/image_prompt.py",
        "cases": [
            {"name": name, "family": family, "spec": s,
             "prompt": IP.compose(s, IP.compose_family(
                 "gpt-image-2" if family == "openai" else "nano-banana-2", family))}
            for name, family, s in CASES
        ],
    }


def main():
    doc = build()
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        have = open(OUT).read() if os.path.exists(OUT) else ""
        if have != text:
            print("sheet_prompts.json is STALE — run: python3 scripts/gen_sheet_golden.py")
            sys.exit(1)
        print(f"sheet golden ok — {len(doc['cases'])} compose")
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w").write(text)
    print(f"wrote {OUT} — {len(doc['cases'])} compose")


if __name__ == "__main__":
    main()

"""Reference sheets as ONE H3 take — the ref2va form, and its shot plans.

The premise is C_Nugget's (PoopMan333/H3_Character_Sheet_Generator) and is the
same one `graphs.orbit_sheet_graph` already runs on: six images of a character
generated separately disagree with each other — jaw shifts, wardrobe drifts,
colour walks — and six frames of ONE generation cannot, because they come out
of a single denoising trajectory. What is new here is the CONDITIONING and the
EXTRACTION, and both are structural rather than cosmetic:

  * **ref2va, not i2v.** The orbit path opens the take on ONE anchor picture,
    so a bible entry holding a face plate AND a full body AND an outfit variant
    contributes exactly one of them and the rest are thrown away. H3's
    reference mode takes NINE, which is the whole reason that repo exists
    ("you can build a character out of bits — a face from here, armour from
    there — and it'll actually hold them together"). A sheet is the one render
    in this studio with the most pictures available to it and it was using the
    fewest.

  * **Fixed-index extraction on CORE nodes.** The views come out with
    `ImageFromBatch` at computed frame numbers and `ImageStitch` into a contact
    sheet — no custom pack. The orbit path depends on lumos675/ComfyUI-OrbitSheets
    for its prompt builders, its frame picker and its sheet, and this file's
    whole job is `h3_prompt`'s job one shape over: deterministic Python
    producing the vendor envelope (invariant #6). A pack that imports fine and
    dies at execution is a failure this codebase keeps paying for; a pack that
    is simply not needed cannot have it.

THE TWO SHAPES ARE NOT INTERCHANGEABLE, and both authors say so themselves.
A CHARACTER turns on a CONTINUOUS orbit — C_Nugget's README is explicit that
the no-cut spin is what holds the character together — while a LOCATION is
covered by HARD CUTS between locked-off placements, which is ethanfel's
H3_Cinematic_Multishot_Coverage (built on C_Nugget's method, and the workflow
C_Nugget's own README redirects room requests to). That is not a preference:
you cannot orbit the inside of a room from a single vantage, and a cut is the
only way to state a genuinely new placement. So `character` beats are one
sweep sampled at four phases, and `location` beats are timestamped cuts.

WHAT A "BEAT" IS AND WHY IT IS NOT A "VIEW". A beat is a span of the take that
the PROMPT describes; a view is a frame the sheet EXTRACTS. They are 1:1 for a
cut plan and they are not for an orbit — one continuous sweep is a single
instruction that yields four usable angles. Collapsing them would make the
character plan inexpressible.

Pure functions over plain dicts, no I/O, so the format is pinned byte-for-byte
by tests rather than by rendering.
"""

import h3_prompt as HP

FMT_VERSION = 1

FPS = 24

# H3-native, and what both published workflows use — landscape for coverage of
# a space, portrait for a standing figure. `graphs.h3_snap_dims` would pick
# these anyway; naming them keeps the extraction frames measured against the
# geometry they were measured on.
CHAR_DIMS = (768, 1344)
LOC_DIMS = (1344, 768)

# 17*7+5 — invariant #5 at n=7, and the length both workflows ship.
SHEET_FRAMES = 124
# 17*4+5 — C_Nugget's "4 panel (faster)" packet, ~40% fewer frames.
SHEET_FRAMES_FAST = 73

# How long after a cut the picture is trusted. ethanfel's README: the supplied
# extraction frames "sit near the center of each static shot rather than on the
# cut", because H3 "can still blur or interpolate around a requested edit
# point". Two frames is what his own opening view uses.
SETTLE_F = 2


def frame_ms(frame):
    """Milliseconds at a frame index. The cut stamps in the prompt and the
    extraction indices are derived from ONE number so they cannot disagree —
    a stamp that lands between frames is a cut the extractor then samples on
    the wrong side of."""
    return int(round(int(frame) * 1000.0 / FPS))


def stamp(frame):
    """A frame as the official MM:SS.mmm cut time. `h3_prompt._ts` is the one
    implementation of that format; a second one here is the twin drift this
    repo keeps naming."""
    return HP._ts(frame_ms(frame))


# ---------------------------------------------------------------- views ----
# Each view carries its own bible ROLE, so the handler no longer holds a tuple
# that has to stay in step with a prompt builder living in another repo. That
# parallel-tuple arrangement is what put 'side_right'/'back'/'scared' — none of
# them legal — into `bible_assets.role` on the orbit path's first live run.
#
# `bible_assets.role` is CHECK-constrained (migration 20260806180000) to
# ref / face / full_body / side / outfit / turnaround / master / alt_angle /
# detail / atmosphere. A role outside it is a PostgREST 400 at the END of a
# render that has already spent its GPU time. What each view actually IS is
# recorded on the ASSET instead (`meta.view`), which is where a finer label
# belongs — there is no bible slot that means "right profile".

def _view(label, role, phase):
    return {"label": label, "role": role, "phase": float(phase)}


# The four phases C_Nugget's 6-panel workflow extracts its orbit at, as
# fractions of the ORBIT BEAT rather than of the take: frames 2/21/42/63 of a
# 72-frame sweep. They are deliberately NOT the geometric quarters (0/18/36/54)
# — those are what the angles should be and these are where the author found
# them by looking at real output, because H3 ramps into a prompted move rather
# than starting at speed. Measured values beat derived ones; the derivation is
# the thing that was wrong.
ORBIT_PHASES = (0.028, 0.292, 0.583, 0.875)

CHAR_VIEWS = (
    _view("front, full figure", "full_body", ORBIT_PHASES[0]),
    _view("left profile", "side", ORBIT_PHASES[1]),
    _view("back", "ref", ORBIT_PHASES[2]),
    _view("right profile", "ref", ORBIT_PHASES[3]),
)
# Phases inside their OWN beat, and these reproduce C_Nugget's published
# extraction frames exactly: face beat 72..96 at 0.5 is frame 84, face beat
# 96..124 at 0.6 is frame 113. Both are his.
CHAR_FACE_VIEWS = (
    _view("face, square to camera", "face", 0.5),
    _view("face, three-quarter", "ref", 0.6),
)

# C_Nugget's 4-panel packet: a 180 turn rather than a full 360, so the back
# view is the one that goes. Its measured phases (frames 2/24/45 of a ~48-frame
# sweep) sit later in the beat than the 6-panel's for the same reason.
CHAR_VIEWS_FAST = (
    _view("front, full figure", "full_body", 0.042),
    _view("left three-quarter", "side", 0.5),
    _view("right three-quarter", "ref", 0.9375),
)
CHAR_FACE_VIEW_FAST = _view("face, square to camera", "face", 0.8)

# The eight coverage placements, and the four bible plates they fill.
#
# `plate_plan`'s ring is master -> alt_angle -> atmosphere with detail OUT of
# it (a macro of one surface conditions a medium into a wall), so the four
# legal env roles want four genuinely different setups — which is exactly what
# "one plate per location is one camera position for the whole scene" says is
# missing. This take produces all four in one pass: the source-matched opener
# is the master, the 90 profile is a true reverse axis, the 180 wide is the
# most different vantage available, and the 85mm compressed view is the detail.
# The four three-quarters land on `ref`, where a picker can still reach them.
# The opener samples as EARLY as the settle allows (phase 0, clamped to
# SETTLE_F) where every other view samples its beat's midpoint. Shot 1 is the
# source-matched view, so it is the least-drifted frame in the take and the one
# that has to agree with the reference; every later placement is inferred and
# wants the most settled frame instead. ethanfel extracts his opener at frame 2
# and the rest at their midpoints, which is the same rule.
LOC_VIEWS = (
    _view("source-oriented establishing", "master", 0.0),
    _view("45 three-quarter", "ref", 0.5),
    _view("90 profile", "alt_angle", 0.5),
    _view("135 low three-quarter", "ref", 0.5),
    _view("180 reverse wide", "atmosphere", 0.5),
    _view("225 high three-quarter", "ref", 0.5),
    _view("270 compressed detail", "detail", 0.5),
    _view("315 hero three-quarter", "ref", 0.5),
)

# Lens and height per placement, in ethanfel's own order. Prose, because that
# is what the model reads — the degrees are the load-bearing part and the lens
# is what stops eight identical framings of eight different angles.
LOC_SETUPS = (
    ("", "matching the source image's own camera side, camera height, framing "
         "logic and lens character"),
    ("45 degrees clockwise around the target, at eye level",
     "a 40 mm medium-wide three-quarter composition"),
    ("90 degrees clockwise around the target, at eye level",
     "a 65 mm clean profile composition"),
    ("135 degrees clockwise around the target, slightly below eye level",
     "a 35 mm low three-quarter composition"),
    ("180 degrees clockwise around the target, at eye level",
     "a 32 mm reverse wide composition that reveals the opposite side of the "
     "frozen scene"),
    ("225 degrees clockwise around the target, slightly above eye level",
     "a 50 mm high three-quarter composition"),
    ("270 degrees clockwise around the target, at eye level",
     "an 85 mm compressed profile or detail composition"),
    ("315 degrees clockwise around the target, at eye level",
     "a 50 mm balanced hero three-quarter composition"),
)


# ----------------------------------------------------------------- plan ----
# A plan is BEATS (what the prompt describes) + VIEWS (what the sheet
# extracts), with every frame number absolute and every timestamp derived from
# a frame. Nothing downstream re-derives either: `graphs.h3_sheet_graph` reads
# `views[i]["frame"]` and the compiler reads `beats[i]["start"]`, so the cut a
# stamp announces and the frame a view is taken from are the same arithmetic.


def _beat(start, end, prose, kind="cut"):
    return {"start": int(start), "end": int(end), "prose": prose, "kind": kind}


def _place(views, beat):
    """Absolute frames for a beat's views, at their measured phases.

    Clamped SETTLE_F inside the beat at both ends: a phase of 0 would sample
    the cut itself, which is the one frame H3 is documented to blur through.
    """
    lo, hi = beat["start"], max(beat["start"] + 1, beat["end"] - 1)
    out = []
    for v in views:
        f = beat["start"] + v["phase"] * (beat["end"] - beat["start"])
        f = min(max(int(round(f)), lo + SETTLE_F), hi)
        out.append(dict(v, frame=f))
    return out


def plan_character(*, fast=False, length=None, scared=False):
    """A turnaround as ONE continuous sweep, sampled at four phases, then one
    or two hard-cut face beats.

    The sweep is C_Nugget's and the reason it is not cuts is in his README:
    "It generates a slow 360 with no hard cuts, so the character stays
    consistent". The face beats ARE cuts because a close-up is a placement, not
    a point on the orbit — and the sheet needs a face plate that a shot can be
    anchored on, which a full-figure frame at any angle is not.
    """
    total = int(length or (SHEET_FRAMES_FAST if fast else SHEET_FRAMES))
    if fast:
        turn = int(round(total * 48.0 / SHEET_FRAMES_FAST))
        beats = [
            _beat(0, turn,
                  "the camera makes one smooth constant-speed move a half turn "
                  "around the subject, starting square on the front and ending "
                  "behind the subject's shoulder line", kind="move"),
            _beat(turn, total,
                  "the camera is at a locked-off head-and-shoulders close-up, "
                  "the face square to camera and the eyes into the lens"),
        ]
        views = _place(CHAR_VIEWS_FAST, beats[0]) + \
            _place([CHAR_FACE_VIEW_FAST], beats[1])
        return {"kind": "character", "length": total, "beats": beats,
                "views": views, "columns": 2, "dims": CHAR_DIMS}

    turn = int(round(total * 72.0 / SHEET_FRAMES))
    face2 = int(round(total * 96.0 / SHEET_FRAMES))
    beats = [
        _beat(0, turn,
              "the camera makes one smooth constant-speed orbit right around "
              "the subject, a full 360 degrees: starting square on the front, "
              "passing the subject's left side a quarter of the way round, "
              "directly behind at halfway, the right side three quarters of "
              "the way round, and returning to the front", kind="move"),
        _beat(turn, face2,
              "the camera is at a locked-off head-and-shoulders close-up, the "
              "face square to camera and the eyes into the lens"),
        _beat(face2, total,
              "the camera is at a locked-off head-and-shoulders close-up with "
              "the head turned to a three-quarter angle, the eyes still "
              "forward"),
    ]
    face = list(CHAR_FACE_VIEWS)
    if scared:
        # The pack's sixth shot. Kept expressible because a frightened face is
        # a genuinely useful plate, and deliberately off by default: it costs a
        # beat, and every beat spent on expression is a beat not spent on the
        # turn the sheet exists for.
        face = [face[0], dict(face[1], label="face, alarmed")]
    views = _place(CHAR_VIEWS, beats[0]) + \
        _place([face[0]], beats[1]) + _place([face[1]], beats[2])
    return {"kind": "character", "length": total, "beats": beats,
            "views": views, "columns": 3, "dims": CHAR_DIMS}


def plan_location(*, shots=8, length=None, lead=None):
    """Coverage of a space as `shots` hard cuts between locked-off placements.

    ethanfel's shape. The cuts are chosen on FRAME BOUNDARIES and the stamps
    are derived from them, which is what makes the extraction exact: his own
    published stamps (00:00.333, 00:00.958, …) are frames 8, 23, 38 … at 24
    fps, i.e. he was already doing this — but a stamp written independently of
    the frame it names drifts by up to half a frame per cut and the extractor
    then samples the wrong side of one.

    The opening beat is SHORT (`lead`) because shot 1 is the source-matched
    view: it needs no establishing time, and giving it a full share spends
    frames on the one angle the reference already shows.
    """
    total = int(length or SHEET_FRAMES)
    n = max(2, min(int(shots), len(LOC_VIEWS)))
    lead = int(lead if lead is not None else round(total * 8.0 / SHEET_FRAMES))
    lead = max(SETTLE_F + 2, min(lead, total // n))
    span = (total - lead) / float(n - 1)
    beats, cuts = [], [0, lead]
    for i in range(2, n):
        cuts.append(int(round(lead + (i - 1) * span)))
    cuts.append(total)
    for i in range(n):
        place, comp = LOC_SETUPS[i]
        if i == 0:
            prose = ("the shot is a source-oriented establishing view of the "
                     "whole space, " + comp)
        else:
            prose = ("the shot cuts to a camera placed exactly " + place +
                     ", using " + comp + ". The camera is immediately locked off")
        beats.append(_beat(cuts[i], cuts[i + 1], prose))
    views = []
    for i in range(n):
        views += _place([LOC_VIEWS[i]], beats[i])
    return {"kind": "location", "length": total, "beats": beats,
            "views": views, "columns": 4, "dims": LOC_DIMS}


# -------------------------------------------------------------- pictures ----
# C_Nugget's A-prompt convention, applied from the bible ROLE rather than typed
# by hand: "One line per image. Say what to take, and — this bit matters more
# than people expect — say what to IGNORE. If you don't rule things out by
# name, backgrounds and the wrong person's hair sneak through."
#
# Our reference sets already know what each picture IS — `bible_assets.role` is
# exactly that — so the exclusion can be generated. A face plate contributes a
# face and must not contribute wardrobe; a body sheet contributes wardrobe and
# must not re-decide the face. Getting that backwards is how a turnaround comes
# back wearing the collar from the head-and-shoulders crop.
PICTURE_NOTES = {
    "face": ("the face and head of {name}. Use the facial structure, the "
             "features, the hair and the skin exactly. Ignore its framing, its "
             "background and its crop, and take no clothing from it"),
    "full_body": ("{name}'s whole figure and complete wardrobe. Use every "
                  "garment, its colour, its cut and its fastenings. Ignore the "
                  "background and ignore the pose"),
    "turnaround": ("{name} seen from several angles. Use it to resolve any "
                   "surface the other pictures do not show. Ignore its grid "
                   "layout, its panel borders and its backdrop"),
    "outfit": ("the wardrobe {name} is dressed in. Use the garments and their "
               "colours only. Ignore the face, the hair and the background"),
    "side": ("{name}'s profile. Use it to resolve the head and body shape from "
             "the side. Ignore the background"),
    "master": ("the location itself. Use its architecture, its materials, its "
               "fixtures, its palette and its light. Ignore any person who "
               "happens to be in it"),
    "alt_angle": ("the same location from a second vantage. Use it to resolve "
                  "geometry the master does not show. Ignore any person in it"),
    "detail": ("a close surface of the location. Use its material and texture "
               "only; it does not describe the layout"),
    "atmosphere": ("the location's light and mood. Use the colour and the "
                   "quality of the light; it does not describe the layout"),
    # The location's own contact sheet, staged into a REDRAW of it. Its note is
    # `turnaround`'s one kind over and for the same reason: it is the picture
    # that resolves surfaces no single plate shows, and it is also a picture OF
    # A GRID, which H3 will happily reproduce if nothing rules the grid out by
    # name. C_Nugget's A-prompt convention is exactly this — "say what to take,
    # and say what to IGNORE".
    "coverage": ("the same location seen from several camera placements at "
                 "once. Use it to resolve geometry, materials and layout that "
                 "the other pictures leave ambiguous. Ignore its grid layout, "
                 "its panel borders and its gutters"),
    "ref": ("further reference for {name}. Use whatever it resolves that the "
            "other pictures leave ambiguous. Ignore its background"),
}


def picture_line(idx, role, name, note=None):
    """One `<Picture N> = …` definition. `note` overrides the role's default,
    which is how a caller says something the role cannot ("use the shield; it
    is attached to his back")."""
    body = note or PICTURE_NOTES.get(role) or PICTURE_NOTES["ref"]
    return f"<Picture {idx}> = " + body.format(name=name or "the subject")


# ---------------------------------------------------------------- prose ----
# Both authors' tuned staging text. It is carried rather than paraphrased for
# `prompt_guides.js`'s reason: a paraphrase drops exactly what looks like
# wording and is actually the instruction — "no contact shadow on the ground
# beneath it" is what stops the figure sitting in a pool of its own shadow, and
# a shorter "plain backdrop" does not.

CHAR_STAGING = (
    "Solid light grey seamless backdrop, one flat uniform tone edge to edge, "
    "with no gradient, no vignette, no texture and no floor line. Nothing else "
    "is in frame. The subject casts no shadow onto the backdrop and no contact "
    "shadow on the ground beneath it, and it does not sit in its own shadow. "
    "Soft form shading on the subject itself is correct and should read its "
    "shape. Long telephoto lens, near-orthographic.\n"
    "The subject holds one relaxed A-pose throughout: arms hanging slightly "
    "away from the body, palms toward the thighs, feet shoulder-width apart, "
    "head level, calm neutral expression, eyes open and looking forward.\n"
    "The subject is completely frozen, as rigid and motionless as a statue. "
    "Only the camera moves. There is no wind, no breeze, no air movement, no "
    "breathing, no settling, no sway and no secondary motion of any kind. "
    "Orientation, surfaces and lighting are identical in every shot, and the "
    "subject stays the same size in frame."
)

LOC_STAGING = (
    "Treat the location as one rigid frozen world. Every object, wall, floor, "
    "opening, furnishing, reflection, practical light, cast shadow and contact "
    "shadow remains fixed in world space, and any person present is perfectly "
    "motionless: no breathing, blinking, gaze change, gesture, hair movement, "
    "cloth movement or pose change. Infer only surfaces the references do not "
    "show, conservatively and consistently, and keep every inferred surface "
    "identical once it has been established."
)

# TERMINAL, and that is measured: H3 is the family this studio records obeying
# a negation at the END of the description (the panel prompt's "no split
# screen, no lettering", the cast-close). The same words mid-stack are read as
# things to draw.
CHAR_CAMERA_CLOSE = (
    "The camera is the only thing in the scene that moves at any point. No "
    "zoom, no push in, no dolly, no tilt, no roll, no handheld shake, no "
    "motion blur and no dissolves. No text, no labels, no watermark, no panel "
    "borders and no split screen appear anywhere in the frame."
)

LOC_CAMERA_CLOSE = (
    "These are discrete camera placements, not points along a visible camera "
    "path. At every stated timestamp execute a true instantaneous cut, and the "
    "first frame after each cut is already fully resolved, sharp and stable at "
    "the new camera position. Never show the camera travelling between "
    "placements: no orbit, pan, tilt, truck, dolly, pedestal, crane, zoom, "
    "whip-pan, speed ramp, motion blur, optical flow, morph, dissolve, "
    "crossfade, transitional frame or intermediate angle. Within each shot the "
    "camera is locked off and static. No text, no labels, no watermark and no "
    "split screen appear anywhere in the frame."
)

SILENCE = ("No dialogue, voices, room tone, Foley, ambience or sound effects; "
           "complete silence.")


def _beat_prose(plan):
    """The beats as H3 shot syntax.

    A MOVE beat is written as a span (`[Shot 1] Over the first 3.0 seconds…`)
    because it is one continuous instruction that the sheet samples four times;
    a CUT beat takes the official `[Shot N] At MM:SS.mmm, …` stamp. Writing an
    orbit as a series of stamped cuts is what turns a turnaround into four
    unrelated angles — the thing one take is chosen to avoid.
    """
    out = []
    for i, b in enumerate(plan["beats"], 1):
        secs = (b["end"] - b["start"]) / float(FPS)
        if b["kind"] == "move":
            out.append(f"[Shot {i}] Over the first {secs:.1f} seconds, "
                       f"{b['prose']}. The subject does not move at all.")
        elif i == 1:
            out.append(f"[Shot {i}] {b['prose'][0].upper()}{b['prose'][1:]}.")
        else:
            out.append(f"[Shot {i}] At {stamp(b['start'])}, {b['prose']}.")
    return "\n\n".join(out)


def compile_sheet(plan, *, name, identity, pictures, style="",
                  picture_notes=None, target=None):
    """The six-field H3 envelope for a sheet take.

    `pictures` is the staged reference set as `[{"role": …}, …]` in the order
    they reach the node — `<Picture N>` is POSITIONAL, so a caller that prunes
    a reference must prune it here too or every later binding slides one
    picture left. That is the same rule `ref_plan_for` follows and the same way
    it goes wrong.

    Returns the dict `h3_prompt.full_prompt_text` renders, so the two
    compilers' output is assembled by one function and cannot drift in
    punctuation, field order or spacing.
    """
    pics = list(pictures or [])
    notes = picture_notes or {}
    defs = [picture_line(i, p.get("role") or "ref", name, notes.get(i))
            for i, p in enumerate(pics, 1)]
    subject_no = len(pics) + 1
    is_char = plan["kind"] == "character"
    # "is the location <name>" reads as a double article the moment a name
    # starts with one ("the watch-repair shopfront"), and every location this
    # studio writes does.
    what = (f"<Subject {subject_no}> is {name}" if is_char
            else f"<Subject {subject_no}> is {name}, the place these pictures show")
    if identity:
        what += f" — {identity.rstrip('.')}"
    defs.append(what + ".")
    # THE PICTURES OUTRANK THE WORDS, and this is measured rather than
    # cautious. A live 6-view take whose identity line described a different
    # person from the staged plates followed the PLATES for five views and the
    # PROSE on the sixth — the last beat, i.e. the one furthest from the
    # reference conditioning. That is the orbit path's "the description and the
    # anchor must agree, or the take reconciles them after the first cut" bug
    # arriving on the reference path, and it survives here because divergence
    # is a real state in this studio rather than a mistake: a user-attached
    # sheet can contradict a written line (`_reconcile_identity` exists for
    # exactly that, and keeps `doc.identity_line_written` beside it), and an
    # outfit variant's line is its parent's plus a change of clothes.
    #
    # So the ranking is stated instead of left to be inferred. It costs one
    # sentence and it is the vendor's own `fully_preserved` said out loud.
    if pics:
        defs.append(
            f"Where the pictures and this description disagree, the pictures "
            f"decide: they are the authority for anything they show of "
            f"<Subject {subject_no}>, and the description only covers what "
            f"they do not show.")

    shots = HP._shots_list(range(1, len(plan["beats"]) + 1))
    ret = [f"<Picture {i}> ({shots}): fully_preserved - every characteristic "
           f"this picture is used for is carried into the target unchanged."
           for i in range(1, len(pics) + 1)]
    ret.append(
        f"<Subject {subject_no}> ({shots}): fully_preserved - identity, "
        + ("proportions, wardrobe, materials and colour are identical in every "
           "shot; only the camera differs."
           if is_char else
           "architecture, materials, fixtures, palette, lighting direction and "
           "shadow placement are identical in every shot; only the camera "
           "differs."))

    head = (f"{style.rstrip('.')}. " if style else "")
    if is_char:
        summary = ("[reference generation] The target video is a character "
                   f"reference turnaround of <Subject {subject_no}>, shot as "
                   "one continuous take so that every view agrees with every "
                   "other.")
        body = (head + "A character reference sheet study. " + CHAR_STAGING +
                "\n\n" + _beat_prose(plan) + "\n\n" + CHAR_CAMERA_CLOSE)
    else:
        tgt = target or f"<Subject {subject_no}>"
        summary = ("[reference generation] The target video creates "
                   f"{len(plan['beats'])} static coverage views of "
                   f"<Subject {subject_no}>, centred on {tgt}, using the same "
                   "reference-defined space and the same exact identities. The "
                   "views are joined only by instantaneous editorial hard cuts.")
        body = (head + "A coherent location coverage study matching the "
                "references' visual medium, texture, colour science, lighting "
                "and production design. " + LOC_STAGING +
                "\n\n" + _beat_prose(plan) + "\n\n" + LOC_CAMERA_CLOSE)

    return {"subject_definitions": "\n".join(defs), "summary": summary,
            "retention_analysis": "\n".join(ret), "description": body,
            "soundscape": SILENCE, "music": "None.",
            "fmt_version": FMT_VERSION}


def sheet_prompt(plan, **kw):
    """`compile_sheet` rendered to the string the node's prompt input takes."""
    return HP.full_prompt_text(compile_sheet(plan, **kw))

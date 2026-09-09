"""Reference-sheet and still prompts, written the way each image family reads.

The prompt that reached ComfyUI used to be a hand-built f-string —
"character reference sheet, anime style: <identity line>. Full body, neutral
pose…" — assembled by whoever happened to enqueue the job, while
`director/prompt_guides.js` carried an actual guide for these models that
nothing in the generation path ever read. So Krea 2 rendered prompts written to
no guide at all.

This composes from structured facts instead, in the order the target family
reads hardest, and it runs in the image handler — the one place the family is
finally known, *after* the reference fallback may have swapped Krea 2 for
Klein. Composing upstream would have written an SDXL-ordered prompt and then
run it on a different architecture.

Mirrors the image entries of director/prompt_guides.js (krea2 / seedream /
openai + the generic fallback); keep them in step. The vendor rules that matter
here are: front-loaded subject, concrete physical nouns, photographic framing,
a named light source, no motion language (a still has no push-in), no negations
(the model cannot subtract), and roughly 70 words before SDXL attention thins.
"""
import re

WORD_CAP = 70

# Which shape a family wants. "stack" = SDXL-family ordering, terse clauses;
# "prose" = models that read natural sentences (Seedream, GPT Image).
SHAPES = {
    "krea2": "stack",
    "klein": "stack",
    "flux": "stack",
    "flux2": "stack",
    # Anima reads danbooru-style tags plus artist tags — comma-separated terse
    # clauses with the subject first, which is exactly what "stack" produces.
    # It notably does NOT want quality tags: Hikari Anima was trained with
    # "masterpiece, best quality…" removed, so adding them back fights the
    # finetune. The negative prompt is where its artifact terms live, and that
    # rides model_map (`negative`), not this composer.
    "anima": "stack",
    "seedream": "prose",
    # HiDream-O1's own guide is explicit: coherent descriptive SENTENCES, not
    # fragmented tags, and 50-75 tokens. The bracketed panel format is ~400 and
    # is the shape it likes least.
    "hidream_o1": "prose",
    "openai": "prose",
    # Gemini's image models are LLM-native instruction followers, the same
    # reasoning the sensenova entry below spells out — a comma-tag stack is
    # the shape they like least. Declared here rather than left to the
    # default, which is what silently handed them the SDXL contract.
    "google": "prose",
    "h3": "prose",          # H3-as-image-model reads its video-style prose
    # A unified multimodal model: it reads an instruction the way an LLM
    # does, and its own best-practices guide asks for natural language
    # naming each reference's ROLE plus an explicit keep/change split.
    # A comma-tag stack is the shape it likes least.
    "sensenova": "prose",
}


def compose_family(family, provider=None):
    """Which DIALECT to compose in, given a model's family and its provider.

    A HOSTED row is not in model_map, so `_family` falls back to the catalog
    id — `gpt-image-2`, `nano-banana-pro` — and SHAPES has never had an entry
    for one. Every hosted panel therefore composed as "stack", the default:
    the bracketed ALL-CAPS SDXL contract, handed to the instruction followers
    it was written least for. Measured 2026-08-31 on a real CITY_CAPTURE_2
    panel spec — `compose(spec, "gpt-image-2")` opens
    `[STYLE]: anime, night, … [FRAMING]: WIDE: …` where `compose(spec,
    "openai")` writes the sentences GPT Image actually reads.

    That is exactly the failure `_panel_prompt`'s own docstring records being
    fixed once — "this branch returned the bracketed format to every model, so
    an instruction follower got a prompt written for the SDXL-shaped families"
    — and the fix threaded `family` through without ever reaching hosted rows,
    because a hosted row's family is an id no table names.

    The PROVIDER is the thing SHAPES can name, and it is what those rows
    genuinely share: every gpt-image row is one model family however it is
    catalogued. Anything SHAPES does not name (a LOCAL row's "local", or a
    provider added later) keeps the family, so this can only ever correct a
    row that would otherwise have taken the default by accident.
    """
    return provider if provider in SHAPES else family


FRAMING = {
    "still": "cinematic frame, 16:9",
    # character sheet slots. The face plate is the identity anchor every later
    # reference derives from — face ONLY, filling the frame, no shoulders or
    # outfit to distract the identity models that consume it.
    "face": "tight face portrait filling the frame, front view, neutral "
            "expression, hair fully visible, no shoulders",
    "full_body": "full-body shot, standing in a neutral pose, front view",
    "side": "full-body profile view",
    "outfit": "waist-up, wardrobe clearly visible",
    # The turnaround is a GRID sheet: six views of the same person in ONE
    # image, consistent by construction because they render together —
    # separate per-angle generations drift, and the drift is exactly what an
    # identity reference exists to prevent.
    "turnaround": ("character turnaround reference sheet, a 2x3 grid of six "
                   "views of the SAME person, thin white gutters separating "
                   "the cells, reading left-to-right top-to-bottom — "
                   "view 1: front full-body standing relaxed; view 2: back "
                   "full-body same stance; view 3: left profile full-body; "
                   "view 4: right three-quarter full-body; view 5: face "
                   "close-up front; view 6: face close-up right "
                   "three-quarter — identical face, hair, build and wardrobe "
                   "in every view"),
    # location sheet slots — a place has angles and air, not a face and an
    # outfit, and asking a location for "full-body, front view" is how an
    # environment sheet comes back looking like a character turnaround.
    "master": "wide establishing shot at eye level",
    "alt_angle": "wide shot from the opposite side of the space, reverse angle",
    "detail": "close-up on the surfaces, materials and dressing at chest height",
    "atmosphere": "wide shot filled with the air of the place",
}

# Location slots each want their own light: the master and the reverse angle
# are legibility plates (you have to be able to read the geography off them),
# the detail plate is about material, and the atmosphere plate is the one
# allowed to be dramatic.
ENVIRONMENT_ROLES = ("master", "alt_angle", "detail", "atmosphere")

# When a plate is drawn FROM a master, the framing has to be an INSTRUCTION TO
# MOVE THE CAMERA — not a description of a picture.
#
# Measured: with the descriptive `FRAMING` strings above, H3 anchored on a
# master reproduced it. Luma correlation between each angle and its own master,
# where 1.0 is the same picture: Glass House 0.895, Observatory 0.853, Plant
# World 0.578 — three near-duplicates per location, `detail` never a close-up
# of anything. Against krea2's 0.296 / 0.476 / 0.279, which moved the camera and
# lost the style instead.
#
# The cause is shape, not capability: H3 obeys camera direction well (measured
# separately across eight angles) when the direction LEADS and reads as a move.
# A description sits behind the identity line and competes with a picture that
# already shows the place — so the model does the safe thing and returns the
# reference. These are phrased the way an image-editing instruction is: an
# imperative, addressed to "this location", stating what the move should
# REVEAL, which is the part that makes a new vantage necessary rather than
# optional.
ENVIRONMENT_MOVE = {
    "alt_angle": ("Rotate the camera around this location to the opposite side "
                  "and show the reverse angle. I want an entirely new vantage on "
                  "the same place — reveal what was behind the first view, with "
                  "the architecture and dressing already established staying "
                  "recognisably the same place."),
    "detail": ("Move the camera in extremely close on ONE specific surface of "
               "this location — its materials, wear and dressing at arm's "
               "length, macro detail. Not the wide view: pick a single part of "
               "it and fill the frame with that."),
    "atmosphere": ("Hold this location and change only the air in it: the same "
                   "place, re-lit by its own signature light, haze and depth "
                   "carrying the mood. Move the camera enough that this reads "
                   "as a different frame of the place, not the same one."),
}

# The same problem on the CHARACTER side, and the same fix.
#
# Measured on Knight Rei (h3-image-turbo, one turnaround staged as the
# reference): the composed face plate read "Knight Rei, dark wavy chin-length
# hair … armored gauntlets, greaves, and period boots, holding a cracked-star
# shield and longsword. Tight face portrait filling the frame … no shoulders."
# It came back as a FULL-BODY knight holding the sword and the shield. The same
# character, same model, same reference, asked as "give me a Tight face portrait
# of her" — 36 characters, no identity line — came back as a correct tight face
# portrait.
#
# Two things are wrong with the long form and only one is position. A knight's
# identity line is a description of a whole standing figure WITH EQUIPMENT, so
# it does not merely sit in front of the crop, it argues with it: every clause
# after "holding" is a reason to draw a body. And it is redundant — the
# reference already IS the identity, which is why the 36-character ask worked at
# all.
#
# So for a crop taken FROM a reference, the framing leads as an instruction and
# the identity paragraph is dropped. The name stays, because a name is not a
# description of a body. Roles that ADD information the reference lacks (a full
# body derived from a face plate, an outfit sheet) keep the identity line — there
# the prose is load-bearing, and this is the same asymmetry `_style_clause` has
# on a ref-anchored render.
CHARACTER_MOVE = {
    "face": ("Crop in tight on this character's FACE and fill the frame with it "
             "— head only, front view, neutral expression, hair fully visible, "
             "cropped at the neck. Not the standing figure: this is a portrait "
             "of the head, and nothing they are wearing or carrying below the "
             "collar is in shot."),
    "side": ("Turn this character to a full profile and show them from the side "
             "— one clean side-on view, head to feet, same person, same "
             "wardrobe."),
}
# Which target roles are a CROP of what the reference already shows. A face
# taken off a turnaround is the case above; a full body taken off a face plate
# is the opposite and is deliberately absent.
CROP_FROM_REF_ROLES = tuple(CHARACTER_MOVE)

# ---------------------------------------------------------------------------
# THE FACE PLATE IS THE ONE t2i SHEET IN THE SET, AND IT WAS BEING ASKED FOR A
# HEAD WHILE BEING HANDED A DESCRIPTION OF A WHOLE DRESSED FIGURE.
#
# `CHARACTER_MOVE` above fixes exactly this and only reaches the `from_ref`
# path — a face CROPPED from an existing reference, where the identity prose is
# redundant and can simply be dropped. A tier-1 face plate has no reference, so
# it took the short `FRAMING["face"]` string with the entire identity line in
# front of it. Measured on THE LATE SHIFT (SenseNova U1.5, 2026-08-29), the
# prompt that shipped ended:
#
#     ...half-moon reading glasses on a cord, and brown desert boots, tight
#     face portrait filling the frame, front view, ... no shoulders
#
# Boots, on a head portrait. Both plates came back head-AND-shoulders in full
# wardrobe, and one rendered "navy council-issue tabard" as the literal words
# COUNCIL ISSUE printed across the chest. Two causes, the same two the Knight
# Rei note records: the framing sits BEHIND a paragraph arguing for a body, and
# "no shoulders" is a NEGATION buried mid-stack — the thing this file says
# these models cannot do, in the one place nothing had checked.
#
# The prose cannot be dropped here the way it is on the crop path (there is no
# picture carrying the identity), so it is TRIMMED to what is above the collar
# and the framing becomes a leading imperative. The failure direction is safe:
# a clause wrongly dropped is wardrobe missing from a shot that wanted a head,
# and a clause wrongly kept is exactly today's behaviour.
FACE_MOVE = ("A tight head-and-hair portrait that fills the frame, front view, "
             "neutral expression, cropped at the neck")
# Below the collar. Same shape as `featured_cast`'s `_BODY_TERMS` — a list
# consulted only to DROP, so a miss costs a word and never a person.
_BELOW_COLLAR = (
    "jacket", "coat", "shirt", "blouse", "tie", "hoodie", "hood", "tabard",
    "suit", "trousers", "jeans", "skirt", "dress", "sweater", "jumper",
    "cardigan", "vest", "waistcoat", "tunic", "uniform", "overall", "apron",
    "boots", "shoes", "trainers", "sneakers", "sandals", "socks",
    "belt", "trouser", "sleeve", "collar", "pocket", "lanyard", "badge",
    "bag", "case", "satchel", "backpack", "holding", "carrying", "clipboard",
    "watch", "bracelet", "ring", "nail", "nails", "thumbnail", "fingernail",
    "gloves", "gauntlet", "greaves", "armour", "armor", "shield", "sword",
    "cloak", "cape", "robe", "mail", "chestplate", "breastplate",
    "build", "frame", "figure", "physique", "shoulders", "torso", "waist",
)


def face_identity(identity):
    """An identity line trimmed to what a HEAD PORTRAIT can show. Pure.

    Splits the comma-stack these lines are written as and drops any clause
    naming something below the collar. Anything unrecognised is KEPT — the
    point is to remove the clauses that argue for a standing figure, not to
    curate the description.
    """
    text = _clean(identity)
    if not text:
        return text
    kept = []
    for clause in re.split(r",\s*", text):
        c = clause.strip()
        if not c:
            continue
        bare = re.sub(r"^(and|with|wearing|in)\s+", "", c, flags=re.I)
        if any(re.search(rf"\b{t}s?\b", bare, re.I) for t in _BELOW_COLLAR):
            continue
        kept.append(c)
    # Everything looked like wardrobe: keep the line rather than send a prompt
    # with no person in it. A face plate with no identity is worse than one
    # with too much.
    if not kept:
        return text
    out = ", ".join(kept)
    return re.sub(r",\s*and\s*$", "", out).rstrip(", ")

# Reference sheets want flat, repeatable conditions — the identity has to read
# the same in every later shot, so the light and ground are fixed here rather
# than left to the model's mood.
CHARACTER_LIGHT = "even neutral studio key light from the front"
CHARACTER_GROUND = "plain seamless mid-grey backdrop"
# Props get their OWN light and ground, and the reason is measured rather than
# tidy. Removing "product photograph" from the prop branch was necessary and did
# nothing on its own: re-rendered on h3-image-turbo at the same seed, a black
# marble in an anime project came back a photoreal studio product shot anyway.
# Three variants, same seed, same subject:
#   A  style clause last,  "raking studio key light" + "seamless backdrop" -> photoreal
#   B  style clause FIRST, same light and ground                           -> photoreal
#   C  style clause first, "even flat lighting" + "plain mid-grey background" -> anime
# B is the informative one: moving the style clause to the head of the prompt
# changed NOTHING, so position was never the variable. "Raking studio key light
# showing material and wear" and "seamless backdrop" are the working vocabulary
# of product photography, and naming a photographic SETUP specifies a medium
# just as surely as naming the medium did — which is the same rule the branch
# below already states, one level less obvious.
#
# Characters keep the studio words: their sheets render correctly in anime
# (a face plate has a face to anchor the style), and an unmeasured change to
# the identity anchor every other reference derives from is not worth taking.
PROP_LIGHT = "even flat lighting that shows its form and materials clearly"
PROP_GROUND = "plain mid-grey background"
ENVIRONMENT_LIGHT = "motivated natural light"
ENVIRONMENT_LIGHT_BY_ROLE = {
    "detail": "raking motivated light across the materials",
    "atmosphere": "the location's own signature light, haze in the air",
}
# "no people" is a negation and these models cannot subtract, so name what IS
# in frame instead.
ENVIRONMENT_SUBJECT = "the location alone, architecture and props only"
# …which held for as long as plates rendered on krea2, and stopped holding the
# day they rendered on H3: a cinematic VIDEO model populates an empty set by
# default, and a positive descriptor buried mid-stack lost to that prior —
# Rei E4's first H3-drawn plates came back with five and six pedestrians in
# them, walking through frames whose prompt said "the location alone". H3 is
# also the family this codebase has MEASURED obeying terminal negations (the
# panel prompt's "no split screen, no lettering…" and the cast_complete close
# both land), so the environment close-out gets the same shape: last, plain,
# and absolute. Kept SEPARATE from ENVIRONMENT_SUBJECT because the subject
# line names what is in frame and this names what is not — the two argue from
# both sides, which is what finally sticks. Applied TERMINAL and CAP-EXEMPT in
# compose(), the same treatment the style clause gets and for the same reason:
# inside the capped body a long identity line would amputate exactly this, and
# the failure would be invisible until a crowd walked through a plate.
ENVIRONMENT_EMPTY = ("The place stands completely empty of people — no person, "
                     "no figure, no crowd, no silhouette anywhere in the frame")


def _clean(v):
    return " ".join(str(v).split()) if isinstance(v, str) and v.strip() else ""


def _style_clause(style, shape, kind):
    # "consistent character design" is the point of a character sheet and
    # nonsense on a location.
    consistency = "consistent character design" if kind == "character" else "coherent art direction"
    s = _clean(style)
    if not s:
        return f"{consistency}, high detail"
    if shape == "stack":
        return f"{s} style, {consistency}, high detail"
    return f"Rendered in {s} style, with {consistency} and high detail."


def _cap(text, words=WORD_CAP):
    """SDXL attention thins past ~70 words; cut on a clause, never mid-phrase."""
    parts = text.split()
    if len(parts) <= words:
        return text
    kept = " ".join(parts[:words])
    cut = max(kept.rfind(","), kept.rfind(";"))
    return (kept[:cut] if cut > len(kept) * 0.6 else kept).rstrip(" ,;")


def compose(spec, family=None):
    """spec = {kind, role, identity, name, style, note, world}. Returns a prompt.

    `kind` is "character", "environment", "scene" (a designed frame for one
    moment), "scene_grid" (a whole scene's beats as one storyboard grid) or
    "block_sheet" (ONE generation block's shots as one numbered contact sheet);
    `role` is the slot — a character's ("face", "full_body", "side", "outfit",
    "turnaround"), a location's ("master", "alt_angle", "detail",
    "atmosphere") or "still". `world` = {era, palette, style_notes} — the
    writer's world bible, woven into every sheet so cast, locations and props
    come out of ONE production design instead of each sheet inventing its own
    era.
    """
    spec = spec if isinstance(spec, dict) else {}
    shape = SHAPES.get(family or "", "stack")
    kind = _clean(spec.get("kind")) or "character"
    if kind == "scene_grid":
        return _grid_prompt(spec)
    if kind == "block_sheet":
        return _sheet_prompt(spec)
    if kind == "panel":
        # Family MATTERS here and used to be dropped on the floor: this branch
        # returned the bracketed format to every model, so an instruction
        # follower got a prompt written for the SDXL-shaped families.
        return _panel_prompt(spec, shape, family)
    role = _clean(spec.get("role")) or ("master" if kind == "environment" else "full_body")
    identity = _clean(spec.get("identity"))
    name = _clean(spec.get("name"))
    note = _clean(spec.get("note"))
    world = spec.get("world") if isinstance(spec.get("world"), dict) else {}
    # A slot from the other kind's sheet is not a framing this kind can use:
    # fall back to its own default rather than shooting a location full-body.
    default_role = "master" if kind == "environment" else "full_body"
    if kind == "environment" and role not in ENVIRONMENT_ROLES:
        role = default_role
    framing = FRAMING.get(role, FRAMING[default_role])

    if kind == "scene":
        # A designed frame for one moment: whatever it depicts is the subject,
        # people included, so neither the empty-location line nor the studio
        # backdrop applies.
        parts = [identity or name or "a cinematic moment",
                 FRAMING.get(role, FRAMING["still"]), ENVIRONMENT_LIGHT]
    elif kind == "prop":
        # A prop is an OBJECT. This kind used to fall through to the character
        # branch, which is how "a Registry baton" came back as a person in a
        # teal outfit holding nothing — the framing said full-body and the
        # model obliged with a body.
        #
        # NOTHING HERE NAMES A MEDIUM — only `_style_clause` does. All three
        # shapes below used to ("product photograph", "photographed in place",
        # "photographed straight-on"), and in a comma-tag prompt that is a
        # instruction sitting in the first ten words while the style clause sits
        # sixty words later, at the tail. Measured on an anime project: every
        # prop came back a photoreal product shot while its own prompt ended
        # "…, anime style, coherent art direction, high detail", and its
        # locations — whose branch says "motivated natural light", a lighting
        # term rather than a medium claim — came back anime. Framing and light
        # are safe to state; what it is RENDERED AS is the style's to say.
        subject = identity or name or "a hand prop"
        reads = _clean(spec.get("reads"))
        depicts = _clean(spec.get("depicts"))
        if spec.get("sited"):
            # A prop fixed to a location has to be shown THERE. On grey it says
            # nothing about where it hangs, and H3 then places it wherever it
            # likes — a scaffold warning sign came back filling half the frame.
            # The location plate is staged as a reference, so this describes the
            # object in its setting rather than alone.
            parts = [subject,
                     "shown in place in its own location, at the height "
                     "and position it actually occupies",
                     "the surrounding structure visible around it so its "
                     "placement and scale are unambiguous",
                     ENVIRONMENT_LIGHT]
            if reads:
                parts.insert(1, f'bearing the exact legible text "{reads}"')
        elif reads or depicts:
            # A READABLE conveys plot through its face: shoot it flat and
            # straight-on with its exact text named, or the model typesets
            # its own words and every block inherits the wrong document.
            parts = [subject]
            if reads:
                parts.append(f'bearing the exact legible text "{reads}"')
            if depicts:
                # An illustrated readable is about WHO is on the page, and the
                # model defaults to whoever it has seen most of: AFTERLIGHT's
                # sketchbook — Aki's drawings OF HARU, the plot's whole hinge —
                # came back full of drawings of Aki. The depicted character's
                # sheet is staged as a reference; this says to draw from it.
                parts.append(f"the drawings on the page depict {depicts}, "
                             f"rendered as hand-drawn studies of that person "
                             f"and no one else")
            parts += ["laid flat, seen straight-on filling the frame, "
                      "every printed element sharp and readable",
                      PROP_LIGHT, PROP_GROUND]
        else:
            parts = [subject, "the object alone, centered, filling the frame",
                     PROP_LIGHT, PROP_GROUND]
    elif kind == "environment":
        subject = identity or name or "an interior space"
        move = ENVIRONMENT_MOVE.get(role) if spec.get("from_ref") else None
        if move:
            # The MOVE leads. Behind a paragraph describing a place the model is
            # already looking at, a framing clause loses to the picture — see
            # ENVIRONMENT_MOVE. The description still follows, because the plate
            # has to stay the same location, not just a different camera.
            parts = [move, subject, ENVIRONMENT_SUBJECT,
                     ENVIRONMENT_LIGHT_BY_ROLE.get(role, ENVIRONMENT_LIGHT)]
        else:
            parts = [subject, ENVIRONMENT_SUBJECT, framing,
                     ENVIRONMENT_LIGHT_BY_ROLE.get(role, ENVIRONMENT_LIGHT)]
    else:
        move = CHARACTER_MOVE.get(role) if spec.get("from_ref") else None
        if move:
            # The MOVE leads and the identity paragraph goes — see
            # CHARACTER_MOVE. Only the NAME survives, because a name cannot be
            # mistaken for an instruction to draw a body, and the reference
            # carries everything the dropped prose was saying.
            parts = [move] + ([name] if name else []) + [CHARACTER_LIGHT, CHARACTER_GROUND]
        else:
            # Front-load the subject: SDXL reads the head of the prompt hardest,
            # and the identity line is the whole point of a reference sheet.
            ident = face_identity(identity) if role == "face" else identity
            subject = ident or name or "a person"
            if name and ident and not re.match(rf"^{re.escape(name)}\b", ident, re.I):
                subject = f"{name}, {ident}"
            if role == "face":
                # The crop LEADS and is stated positively — see FACE_MOVE. The
                # trimmed identity follows, because a t2i plate has no picture
                # carrying it.
                parts = [FACE_MOVE, subject, CHARACTER_LIGHT, CHARACTER_GROUND]
            else:
                parts = [subject, framing, CHARACTER_LIGHT, CHARACTER_GROUND]

    if note:
        parts.append(note)
    # World cohesion: era and palette ride every sheet. The face plate is the
    # one exception for palette — a neutral identity anchor must not be tinted
    # by the piece's grade.
    era = _clean(world.get("era"))
    if era:
        parts.append(f"set in {era}")
    pal = _clean(world.get("palette"))
    if pal and role != "face":
        parts.append(f"palette of {pal}")
    style_notes = _clean(world.get("style_notes"))
    if style_notes and kind != "character":
        parts.append(style_notes)
    # The magic/effects grammar rides only the frames that show effects — the
    # VFX plates (kind "scene"). A character turnaround with "ribbons of
    # emberlight" appended grows glowing props that aren't in the wardrobe.
    vfx = _clean(world.get("vfx_language"))
    if vfx and kind == "scene":
        parts.append(f"all magical effects rendered as {vfx}")
    parts.append(_style_clause(spec.get("style"), shape, kind))

    if shape == "prose":
        head = parts[0].rstrip(".")
        body = ", ".join(p.rstrip(".") for p in parts[1:-1])
        body = body[:1].upper() + body[1:]          # it is a sentence, so open like one
        out = f"{head}. {body}. {parts[-1]}".replace("..", ".")
        if kind == "environment":
            # Terminal and cap-exempt, same treatment as the style clause —
            # see ENVIRONMENT_EMPTY for why it exists and why it goes LAST.
            out = f"{out.rstrip('.')}. {ENVIRONMENT_EMPTY}."
        return out
    # The STYLE CLAUSE IS NEVER TRUNCATED. It is appended last (the subject has
    # to lead — these models read the head hardest), and capping the joined
    # string therefore amputated it on exactly the characters with the richest
    # identity lines: measured, a 70-word Aki prompt lost "2D-animated anime"
    # and rendered photoreal while short-lined Haru kept his. That is what
    # "some sheets came back live-action in an anime project" was, and it is
    # invisible unless you diff the stored prompt against the style field.
    # The turnaround's framing is itself a six-view contract, so it gets a
    # wider body cap — the standard cap would amputate views 4-6.
    tail = parts[-1]
    body = _cap(", ".join(p.rstrip(".") for p in parts[:-1]),
                words=160 if role == "turnaround" else WORD_CAP)
    if kind == "environment":
        # Terminal and cap-exempt, same treatment as the style clause — see
        # ENVIRONMENT_EMPTY for why it exists and why it goes LAST.
        return f"{body}, {tail}. {ENVIRONMENT_EMPTY}."
    return f"{body}, {tail}"


# A shot size is only obeyed when it says how much of the FRAME the subject
# takes. "a wide shot" buried in a clause of camera-move prose was ignored —
# every panel of AFTERLIGHT's storyboard came back the same medium two-shot
# whatever the beat asked for. Longest keys first so "medium close-up" and
# "extreme wide" win over "medium" / "wide".
SHOT_FRAMING = [
    ("extreme close-up", "EXTREME CLOSE-UP: one detail — eyes, hands, or an "
     "object — fills the whole frame; nothing else is legible"),
    ("medium close-up", "MEDIUM CLOSE-UP: head and shoulders fill the frame, "
     "cut around mid-chest; the background is soft and secondary"),
    ("close-up", "CLOSE-UP: the face fills most of the frame; little of the "
     "surroundings is visible"),
    ("extreme wide", "EXTREME WIDE: the location dominates; any figure is "
     "small in the frame and the space around them is the subject"),
    ("medium wide", "MEDIUM WIDE: figures from the knees up, with a clear "
     "read of the space they stand in"),
    ("establishing", "WIDE ESTABLISHING: the whole location reads at once; "
     "figures occupy less than a third of the frame height"),
    ("wide", "WIDE: the whole location reads at once; figures occupy less "
     "than a third of the frame height"),
    ("full", "FULL SHOT: figures head to foot, the location visible around "
     "them"),
    ("two-shot", "TWO-SHOT: both figures in frame together from the waist up"),
    ("over-the-shoulder", "OVER-THE-SHOULDER: framed past one figure's "
     "shoulder onto the other, who faces camera"),
    ("insert", "INSERT: the object alone, filling the frame"),
    ("medium", "MEDIUM SHOT: figures from the waist up"),
]

SHOT_ANGLES = [
    ("bird", "seen from directly overhead, looking straight down"),
    ("overhead", "seen from directly overhead, looking straight down"),
    ("high angle", "the camera is above the subject, looking down"),
    ("worm", "the camera is at ground level, looking steeply up"),
    ("low-angle", "the camera is below the subject, looking up"),
    ("low angle", "the camera is below the subject, looking up"),
    ("eye level", "the camera is at the subject's eye level"),
    ("eye-level", "the camera is at the subject's eye level"),
]


# Longest key WINS, and the list above is not in that order — it is grouped by
# family, which put "close-up" ahead of "over-the-shoulder". So every
# "over-the-shoulder close-up" in the storyboard (three of PLANT-GLASSHOUSE and
# MEMORY-RELEASE's fifteen shots) composed as a plain CLOSE-UP and the reverse
# was dropped, which is the same complaint as the camera lock one notch finer:
# the planner writes coverage and the panel does not render it. Sorted here
# rather than by hand so a new entry cannot reintroduce it.
_SHOT_FRAMING_BY_LEN = sorted(SHOT_FRAMING, key=lambda kv: -len(kv[0]))


def shot_framing(camera):
    """Camera prose -> (framing instruction, angle instruction). Pure.

    The planner writes a full camera line — size, angle, and the official
    motion grammar ("the camera Tilts Down with small amplitude at slow
    speed"). Motion is meaningless in a still and dilutes the part that is
    not, so only size and angle survive here, each expanded into what it
    means for the frame."""
    cam = _clean(camera).lower()
    size = next((txt for key, txt in _SHOT_FRAMING_BY_LEN if key in cam), "")
    angle = next((txt for key, txt in SHOT_ANGLES if key in cam), "")
    return size, angle


# Sizes where the SPACE is the subject and a face is a few dozen pixels tall.
#
# INSERT WAS TRIED HERE AND LOST — worth recording, because the reasoning for
# adding it is good and the result is not. An insert's subject is an OBJECT, so
# a face plate in image1 is as wrong as it is on a wide: measured on
# PLANT-GLASSHOUSE b3, "an insert at high angle on the photograph reflected in
# the pane" came back as a medium three-shot of the cast. Leading with the
# location's DETAIL plate instead (one seed, same beat, everything else fixed)
# did not produce an insert either — it produced a generic shot of the
# glasshouse frontage, i.e. a picture of whatever held image1, again. It also
# made the scene MORE repetitive, which is measurable: b3's correlation against
# its neighbours went 0.17 -> 0.37 (b2), 0.18 -> 0.34 (b4), -0.01 -> 0.14 (b1),
# and the scene's mean 0.040 -> 0.083.
#
# The lesson is that the strong slot decides the SUBJECT, and neither of the two
# pictures a panel stages is the subject of an insert. The fix is the prop's own
# sheet in image1 — `panelSpec` builds face + location anchors only and has
# never staged a prop — not a different choice between the two wrong ones.
LOCATION_LED_SIZES = ("EXTREME WIDE", "WIDE ESTABLISHING", "WIDE", "FULL SHOT")


def panel_cast_cap(model_key):
    """How many face sheets a panel may stage, by the family rendering it.

    The old flat cap of TWO was sized for the reference ceilings of the models
    panels started on — Krea2EditRebalance takes four images, the Qwen 2509
    encoder three, so two faces plus a location plate was the budget. H3 takes
    NINE, and keeping the flat cap there is what put invented extras into
    finished panels: a beat casting three people staged two sheets, the third
    stayed in the ACTION prose, and H3 drew them from words alone — measured on
    MEMORY-RELEASE b4, where uncast Guide Rei came back as a different person
    standing in the background. The cap follows the family: whoever the third
    person is, their sheet is a better source than their sentence.

    SenseNova is the second family past two, and for the same reason rather
    than by analogy: its edit node takes TEN images (`max_refs` in model_map)
    against Krea 2's four and Qwen 2509's three, so the two-face budget those
    ceilings bought does not apply to it either. It is capped at H3's 4 and not
    at its own ceiling — a panel also stages the location plate and any prop,
    and nothing here has been measured staging more than four faces at once.

    Matched on the substring because both spellings of a pick reach here — the
    catalog id browser-side ("h3-image-turbo-local"), the model_map key on the
    planner ("h3-image-turbo"). Twinned in panelSpec.ts.
    """
    k = str(model_key or "").lower()
    return 4 if ("h3" in k or "sensenova" in k) else 2


def location_leads(camera):
    """Should the location plate hold image1 for this shot? Pure.

    Measured on AFTERLIGHT E3: a beat whose camera reads "a wide establishing
    shot at high angle … through the black water" rendered as an eye-level
    medium two-shot with no water and no dome. `[FRAMING]` said "figures
    occupy less than a third of the frame height" and was ignored outright —
    because the panel staged two FACE plates in slots 1-2, and image1 carries
    the high token budget in both reference encoders, so the model composed a
    portrait of the people it was handed. The same lever that fixes identity
    drift on close shots breaks the frame on wide ones; it has to be applied
    by shot size rather than uniformly. At this size identity is unrecoverable
    anyway, so spending the strongest slot on a face buys nothing and costs
    the shot its location."""
    size, _ = shot_framing(camera)
    return bool(size) and size.split(":")[0] in LOCATION_LED_SIZES


# Things a person cannot be separated from. A possessive over one of these
# means the person is in frame ("Villian Rei's tightening face"); a possessive
# over anything else means only the OBJECT is ("Astronaut Rei's helmet", where
# the helmet has been torn off and carried a world away from her). Scanned a
# few words deep, because the noun is routinely modified — "Rei's gloved palm",
# "Rei's tightening face".
# A FIGHT IS WRITTEN ALMOST ENTIRELY IN BODY PARTS, and this list being short
# was a fight-specific staging bug rather than a cosmetic gap. Measured on
# TEMPLE DUEL: the shot "Lian drives the staff in a flat arc at Master Ren's
# ribs" is the ONE shot in its block that names him in full — and `ribs` was
# absent here, so the possessive rule read it as him owning a detachable
# object, dropped him from the featured set, and his character sheet was never
# staged for the whole block. He was then drawn from prose alone. Anything a
# strike LANDS ON belongs here; the list is only ever consulted after a
# possessive, so a false include is cheap and a false exclude deletes someone
# who is being hit.
_BODY_TERMS = (
    "face|faces|eye|eyes|gaze|look|expression|hand|hands|palm|palms|finger|"
    "fingers|fingertip|fingertips|fist|fists|arm|arms|elbow|elbows|wrist|"
    "wrists|forearm|forearms|knuckle|knuckles|shoulder|"
    "shoulders|head|hair|brow|jaw|mouth|lips|teeth|throat|neck|chest|back|"
    "spine|waist|hip|hips|knee|knees|leg|legs|foot|feet|heel|heels|skin|body|"
    "rib|ribs|ribcage|torso|midsection|midriff|stomach|belly|abdomen|gut|"
    "sternum|collarbone|flank|side|shin|shins|calf|calves|thigh|thighs|"
    "ankle|ankles|toe|toes|chin|cheek|cheeks|temple|forehead|scalp|ear|ears|"
    "nose|tongue|armpit|groin|"
    # …and a possessive over your OWN MOTION is you, for the same reason: a
    # body cannot be separated from its momentum. "Lian's pull meets nothing"
    # is Lian on screen being carried past him, not a disembodied force.
    "pull|push|weight|momentum|charge|lunge|swing|strike|blow|kick|punch|"
    "guard|reach|footing|balance|follow-through|"
    "breath|voice|grip|silhouette|shadow|figure|frame|profile|posture|stance")
_BODY_AFTER = re.compile(rf"\s*(?:\w+\s+){{0,2}}(?:{_BODY_TERMS})\b")


# A THREE-LETTER GIVEN NAME IS A NORMAL NAME, and the head/tail fallback below
# used to refuse one outright. Its `len < 4` floor was written to stop a short
# FRAGMENT matching arbitrary prose while scanning a whole cast — but "Ren",
# "Rei", "Kim", "Ana", "Jun" are the names people actually have, and a bible
# that files someone as "Master Ren" while the cinematographer writes "Ren"
# then matches on neither. MEASURED on TEMPLE DUEL: across blocks 4 and 6 the
# prose named Master Ren fourteen times, `featured_cast` returned ['Lian']
# every time, so "stage exactly the featured" dropped his sheet, the compiled
# envelope declared no <Subject> for him at all, and H3 was asked to render a
# two-hander duel against a man it had never been shown. It grounded the
# strikes on the one thing it HAD been shown — the pillar.
#
# What replaces the floor is TWO guards, because length was standing in for two
# different worries and neither is length:
#
#   1. A FUNCTION WORD is never a person. "The Other Reader" has the head
#      "the", and no article, pronoun or preposition is ever somebody's name,
#      so these are refused categorically at any length.
#   2. A CONTENT WORD is told apart from a name by its DETERMINER. English
#      puts an article in front of a common noun and nothing in front of a
#      name: "she saw the tam on the hook" is a hat, "Tam crosses the shop" is
#      a person. So a short fragment must appear at least once WITHOUT a
#      determiner in front of it. That replaces a hand-written vocabulary of
#      short nouns, which would have been invented knowledge going stale in a
#      file that already warns against exactly that.
#
# Two letters stays refused outright — there is no safe way to scan for one.
# A refused fragment merely restores the previous behaviour (fall back to the
# roster), so a false refusal is cheap and a false omission stages nobody.
_MIN_NAME_FRAGMENT = 3
_SHORT_FRAGMENT_MAX = 4          # below this width, the determiner test applies
_FUNCTION_WORDS = {
    "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "of", "in",
    "on", "at", "to", "for", "with", "by", "from", "as", "into", "onto",
    "over", "under", "up", "down", "out", "off", "is", "are", "was", "were",
    "be", "been", "am", "do", "does", "did", "has", "have", "had", "will",
    "would", "can", "could", "may", "might", "must", "shall", "should",
    "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his",
    "she", "her", "hers", "it", "its", "they", "them", "their", "who",
    "whom", "whose", "that", "this", "these", "those", "there", "here",
    "not", "no", "all", "any", "each", "every", "some", "both", "few",
    "more", "most", "than", "then", "when", "where", "why", "how", "if",
}
_DETERMINERS = {
    "the", "a", "an", "his", "her", "its", "their", "our", "my", "your",
    "this", "that", "these", "those", "some", "any", "no", "one", "each",
    "every", "another", "other", "same",
}
_TRAILING_WORD = re.compile(r"[a-z']+$")


def _undetermined_somewhere(src, t):
    """Does `t` appear at least once WITHOUT an article in front of it?

    The name/common-noun test for a short fragment. Scans the same haystack
    `scan` will, so a span already consumed by a longer name (blanked to NULs)
    cannot answer for this one.
    """
    for m in re.finditer(rf"\b{re.escape(t)}\b", src):
        w = _TRAILING_WORD.search(src[:m.start()].rstrip())
        if not (w and w.group(0) in _DETERMINERS):
            return True
    return False


def _fragment_ok(t, src, *, require_undetermined=False):
    """May this head/tail/middle be scanned for as a name? See the note above.

    `require_undetermined` applies the determiner test at ANY width, and the
    MIDDLE rule below is what passes it. A head is a name's distinguishing
    word and a tail is its family name or its head noun; a middle is neither,
    so it is the position where a common noun is likeliest to sit —
    "Contained Black Hole Marble" has the middles "black" and "hole", and
    neither is anybody's name. The determiner test IS the name/common-noun
    discrimination that answers this, and it is already trusted for short
    fragments, so the middle rule reuses it rather than inventing a second
    one: "Rhea enters from the lower right" is a person, "the black hole
    marble" is a thing.
    """
    if len(t) < _MIN_NAME_FRAGMENT or t in _FUNCTION_WORDS:
        return False
    if ((require_undetermined or len(t) < _SHORT_FRAGMENT_MAX)
            and not _undetermined_somewhere(src, t)):
        return False
    return True


def _name_fragments(parts, width, end):
    """The `width`-word fragments of one split name at one END. Pure.

    `middle` is STRICTLY interior — from index 1 to the last start that still
    leaves a word after it — so a two-word name has none and a three-word name
    has exactly one at width 1. That is the entire point of it: a head/tail
    pair reads "Osei Kofi" (the prose says "Osei") and reads NEITHER end of
    "Captain Rhea Dorne", whom the prose calls Rhea. Twin of panelSpec.ts.
    """
    if len(parts) < width:
        return []
    if end == "tail":
        return [" ".join(parts[-width:])]
    if end == "head":
        return [" ".join(parts[:width])]
    return [" ".join(parts[i:i + width]) for i in range(1, len(parts) - width)]


def featured_cast(text, names, *, possessive_excludes=True):
    """Which of these cast names the shot's own text says -> in mention order.

    The STAGING decision, not just a sort. `beats.meta.cast` is the
    cinematographer's list and its contract says "ONLY the characters visibly
    in frame during this beat" — and on ASTRONAUT_CAPTURE the model wrote the
    scene's whole five-name roster onto every beat anyway (it agrees with the
    rule and then ignores it — dialogue style and camera monoculture, again;
    only a deterministic check changes it). Staging the roster is what broke
    the panels that broke: a close-up on one face staged five pictures and
    montaged, and the wordless breath beat staged four character sheets and
    came back AS a character sheet, grey ground and all.

    Matching is word-boundary and LONGEST NAME FIRST with each match consumed
    (the span is blanked with NULs so offsets hold): this cast is "Rei" plus
    four "<Something> Rei" variants, and a substring scan credits plain Rei
    with every mention of the others. Consuming means "Astronaut Rei snaps…"
    features Astronaut Rei and does NOT feature Rei.

    Empty when the text names nobody — the caller falls back to the roster,
    because a beat can cast by pronoun ("the two stand in silence") and
    staging nobody there would un-anchor the shot."""
    src = str(text or "").lower()
    uniq = sorted({str(n) for n in names if n}, key=len, reverse=True)
    hits, possessive_only = [], {}

    def scan(needle):
        """Every occurrence of `needle` -> (first offset, was-ever-bare).

        Shared by the exact pass and the head/tail fallback so the POSSESSIVE
        rule cannot apply to one and not the other. It did not, before: the
        fallback set `bare` unconditionally, so "Osei's watch sits open on the
        bench" put Osei in frame — the exact failure measured on MEMORY_RETURN,
        arriving through the back door.
        """
        nonlocal src
        pat = re.compile(rf"\b{re.escape(needle)}\b")
        m, first, bare = pat.search(src), None, False
        while m:
            first = m.start() if first is None else first
            # POSSESSIVE or not. "Astronaut Rei's helmet" puts the HELMET in
            # frame, not her — measured on MEMORY_RETURN, where three beats
            # naming her only as the owner of an object staged her sheet and
            # H3 drew her bodily present in a room she is imprisoned far away
            # from. A name that appears at least once WITHOUT the apostrophe
            # is a person in the shot and stages normally; a name that only
            # ever owns something does not.
            tail = src[m.end():m.end() + 2]
            if not (tail.startswith("'s") or tail.startswith("\u2019s")):
                bare = True
            elif _BODY_AFTER.match(src[m.end() + 2:]):
                # A possessive over a BODY PART is the person: "Villian Rei's
                # tightening face", "Astronaut Rei's chest", "her gloved palm".
                # Only a DETACHABLE object leaves them out of frame — which is
                # the whole distinction, and getting it wrong in the other
                # direction drops someone the shot is plainly about.
                bare = True
            src = src[:m.start()] + "\x00" * (m.end() - m.start()) + src[m.end():]
            m = pat.search(src)
        return first, bare

    for nm in uniq:
        first, bare = scan(nm.lower())
        if first is not None:
            hits.append((first, nm))
            possessive_only[nm] = not bare

    # A character the prose calls by a COMMON NOUN rather than their name.
    # "The creature lunges through the reflection" is the Fractured Reflection
    # Creature, and exact-name matching never staged it — so the one shot in
    # BORROWED_SKY that is ABOUT the creature was drawn with no reference for
    # it and came back with ordinary human hands. Only the entry's last word
    # is tried, and only when it is UNIQUE across this cast: "Guide Rei" would
    # otherwise reduce to "rei" and swallow every mention of everyone.
    # Longest tail first: "Guide Rei's Cloudy Marble" is written "one cloudy
    # marble" in the prose, and its LAST word alone collides with "Contained
    # Black Hole Marble" — so a one-word rule finds neither. Two words
    # disambiguate them and still catch "the creature".
    # …and the HEAD, under the same guards, because a PERSON is called by the
    # end of their name that a creature is not. The tail rule finds "the
    # creature" for Fractured Reflection Creature; it looks at the wrong end
    # for "Osei Kofi", whom the prose calls "Osei" — and the cinematographer
    # writes prose. MEASURED on THE LAST SERVICE: across 49 shots the camera
    # and action text named cast members 74 times by first name and ZERO times
    # in full, so exact matching found nobody, every beat fell back to the
    # roster, and the staging decision this function exists to make was inert.
    # The consequence is not neutral: on a wide, `order_anchors` drops to one
    # face, the unstaged second character stays in the action prose, and the
    # model draws them from words — measured, as a DUPLICATE of the staged
    # character wearing her clothes.
    #
    # Tails are tried before heads at each width so nothing that already
    # resolves changes: a name the tail rule matches is in `matched` and its
    # head is never consulted. The uniqueness guard carries over unchanged and
    # is what keeps "Guide Rei" from reducing to "rei" — that head belongs to
    # the real "Rei" as well, so it has two owners and is skipped.
    # …and the MIDDLE, last of the three, because a head/tail pair reads a
    # two-word name and cannot read a three-word one. A person filed with a
    # TITLE is called by the word between the ends: this project's own cast
    # has "Captain Rhea Dorne" and "Dr. Sato Ibarra", and the prose says Rhea
    # and Sato. MEASURED on SPINE_RUN/SALVAGE_AWAKENING: neither name ever
    # matched on its own text, so each was staged only in the beats where the
    # character happens to have a LINE — the speaker string carries the full
    # name into the haystack and the exact pass finds it there. A beat billed
    # "a medium two-shot at eye level between Rhea and Lucy" staged Lucy and
    # JUNO (named once, as the direction Rhea walks toward) and left the
    # two-shot's other half to be drawn from prose; a beat with Rhea alone in
    # it matched nobody at all, emptied `feat`, and fell back to staging four
    # of the scene's five cast.
    #
    # Middles run after heads at each width for the reason tails run before
    # heads: a name that already resolves is in `matched` and never consults
    # the next rule, so nothing that works today changes. They are the one
    # position that carries the determiner test at every width — see
    # `_fragment_ok`.
    matched = {nm for _, nm in hits}
    for width in (2, 1):
        for end in ("tail", "head", "middle"):
            parts_of = {}
            for nm in uniq:
                for key in _name_fragments(nm.lower().split(), width, end):
                    parts_of.setdefault(key, []).append(nm)
            for t, owners in parts_of.items():
                if (len(owners) != 1 or owners[0] in matched
                        or not _fragment_ok(t, src,
                                            require_undetermined=end == "middle")):
                    continue
                first, bare = scan(t)
                if first is not None:
                    hits.append((first, owners[0]))
                    # The possessive rule applies to a HEAD and not to a TAIL,
                    # and that is the people/objects distinction this function
                    # already draws, not a special case. A tail match is a
                    # common noun for a THING — "the photograph's corner" is a
                    # part of the photograph, so the photograph is in frame. A
                    # head match is a person's given name, and "Osei's watch
                    # sits open on the bench" puts the WATCH in frame and
                    # leaves Osei out of it (measured on MEMORY_RETURN, where
                    # three beats naming a character only as the owner of an
                    # object staged her sheet and H3 drew her bodily present
                    # in a room she is imprisoned far away from).
                    # A MIDDLE binds possessives for the head's reason and
                    # not the tail's: it is a person's given name, so "Rhea's
                    # helmet" puts the helmet in frame and not her.
                    possessive_only[owners[0]] = (not bare) if end != "tail" else False
                    matched.add(owners[0])

    # `possessive_excludes` is about PEOPLE. "Astronaut Rei's helmet" leaves
    # her out of frame; "the photograph's corner" puts the PHOTOGRAPH in it —
    # an object's possessive is a part of that object, which is the same
    # relation the body-part list encodes for a person. Callers matching props
    # pass False.
    if not possessive_excludes:
        return [nm for _, nm in sorted(hits)]
    return [nm for _, nm in sorted(hits) if not possessive_only.get(nm)]


# The sentinel a two-pass name substitution parks its replacements behind:
# swap every name for a token, expand every token at the end, so a name
# substituted later cannot match INSIDE one substituted earlier.
#
# Private-use codepoints on purpose. They cannot occur in prose, and they carry
# no word character, which is what `\b…\b` needs in order not to match into a
# token — a bare index ("0", "1") would be found by the digits real prose
# carries ("a 20-year-old", a time of day, a palette).
BIND_TOKEN = "{}"


# Things a voice arrives THROUGH. Deliberately short and concrete: "line" and
# "call" are left out because a shop full of clocks has lines and a scene can
# call for anything, and a false positive here deletes a character who really
# is in the room.
_VOICE_DEVICE = re.compile(
    r"\b(phone|telephone|mobile|cell ?phone|handset|receiver|speakerphone|"
    r"speaker|intercom|radio|tannoy|headset|earpiece|voicemail|answering "
    r"machine|video ?call|monitor|screen)\b", re.I)


def remote_speakers(text, cast_names, speakers):
    """Who SPEAKS in this beat without being in it. Pure.

    A character on the other end of a phone has no body in the shot, and
    nothing in the pipeline said so — so a phone caller was cast, given a
    character sheet as `<Picture N>`, given a subject definition, AND given a
    physical position by the Continuity Director. MEASURED on THE LAST SERVICE
    b0, whose `positions` read:

        "Tam Reed": "at the phone in Mara Vale's hand, facing Mara Vale, seated"

    H3 was handed a face, a name and a stated posture, so it drew her — seated
    in the shop in b0 and standing in the street in b1, in a film where she is
    only ever a voice on a call.

    The test is the one `featured_cast` already makes, plus a device: a speaker
    the beat's own text does not put IN FRAME, in a beat that names something a
    voice comes out of. That reuses the possessive rule for free, which is what
    makes b1 work — "Tam's careful instruction continues" mentions her by name,
    and an instruction is not a body part, so she is possessive-only and not in
    the shot.

    Conservative on purpose. It returns nobody when there is no device word,
    because deleting a character who IS in the room is far worse than drawing
    one who is not: the shot loses its second face and the model invents one.
    """
    txt = str(text or "")
    if not _VOICE_DEVICE.search(txt):
        return []
    spoke = {str(s).strip() for s in (speakers or []) if str(s or "").strip()}
    if not spoke:
        return []
    return [n for n in cast_names or []
            if n in spoke and not _appears_in_frame(txt, n)]


def _appears_in_frame(text, name):
    """Does this ONE name appear as a body in this text?

    Asked per name rather than by running `featured_cast` over the whole cast,
    because that function's head/tail/middle FALLBACK is guarded for scanning
    a whole roster: a fragment must be UNIQUE across the cast and must survive
    the function-word and determiner tests. Here the question is narrower
    ("is this specific person in the shot"), and the EXACT pass carries no
    such guards, so handing it the name's own forms one at a time gets the
    possessive rule applied to a name the roster scan would have refused.

    EVERY part is a form, not just the ends. "Captain Rhea Dorne" is called
    Rhea, and with only {first, last} this reported her as absent from a shot
    that plainly names her — which on the phone-caller path deletes a
    character who is standing in the room, the one failure `remote_speakers`
    is documented as refusing to risk.

    Without this, "Tam's hand closes over the phone" reports her as a voice on
    the far end of it, and the fix deletes a character who is standing there.
    """
    parts = str(name or "").split()
    forms = {name} | (set(parts) if len(parts) > 1 else set())
    return bool(featured_cast(text, [f for f in forms if f]))


def listener_clause(speaker, cast_names):
    """Name the non-speakers as non-speakers, for ONE spoken line. Pure.

    The wrong-speaker guard. With several faces staged, a video model syncs
    whichever mouth it decides is talking — `h3_prompt` has carried this on the
    branch where a RECORDING is placed since the dialogue work, and it was
    missing from two places that need it just as much: the branch where H3
    performs the line itself (the loud fallback whenever `place_exchange`
    returns None or ElevenLabs is down), and `ltx_prompt` entirely. LTX is
    measured speaking a quoted line verbatim and lip-synced, on up to four
    staged subject slots, so it is the worse of the two exposures.

    The non-speakers are also told to stay present and REACT. Silence alone
    reads as a frozen cast, which is the reviewer's own ACTION_FLAT; naming a
    visible reaction is vrgamedevgirl's rule for the same problem, and hers is
    the stronger wording ("must still be visible ... who react, watch, move,
    pose"). No specific action is invented here — blocking belongs to the
    Continuity Director, and this clause must not contradict `positions`.

    `cast_names` is the pool the CALLER deems safe to name, and both callers
    resolve it to people the prompt has ALREADY put in this shot: H3 passes the
    beat's cast intersected with the subjects its envelope declares, LTX passes
    the beat's cast (pruned upstream by `blocks._beats_for_prompt` to who the
    shot names). So this clause only ever constrains someone; a name that
    appeared here and nowhere else would be an invitation to draw them.
    """
    plain = _clean(str(speaker or "").split(" — ")[0])
    others = [n for n in (cast_names or []) if n and n != plain]
    if not plain or not others:
        return ""
    verb = "listens" if len(others) == 1 else "listen"
    return (f"Only {plain}'s lips move on this line; {', '.join(others)} "
            f"{verb} without speaking, staying visibly in frame and reacting.")


def offscreen_vo_clause(cast_names):
    """The V.O. twin of `listener_clause`, for a line marked `offscreen`. Pure.

    An off-screen line has no on-screen mouth, and the vendor's own grammar
    demands that be SAID: the base-modes guide's voiceover rule is the exact
    phrase "says in an off-screen voiceover" followed immediately by a
    statement that on-screen lips remain closed. The caller emits the phrase;
    this clause is the lips statement, shared by both compilers the way
    `listener_clause` is.

    It returns something even with NOBODY staged — that is the case it is
    needed most: a bare `says:` beside an empty cast is an invitation for H3
    to invent the speaker (the invented-extra artifact, measured repeatedly),
    and an insert shot of an object is exactly where a V.O. line lands.
    `cast_names` is the same pool `listener_clause` takes: people the prompt
    has already put in this shot, so naming them only ever constrains.
    """
    others = [n for n in (cast_names or []) if n]
    if not others:
        return ("No one appears on screen speaking this line; every mouth in "
                "frame stays completely closed while it plays.")
    verb = "listens" if len(others) == 1 else "listen"
    return (f"No one on screen speaks this line; {', '.join(others)} "
            f"{verb} with lips completely closed, visibly reacting to what "
            f"is heard.")


def offscreen_speakers(text, dialogue):
    """Who speaks in this shot ONLY as an off-screen voice. Pure.

    `remote_speakers`' deliberate cutaway twin: a line marked `offscreen` is
    the cinematographer saying the camera is elsewhere while the voice
    continues (a listener reaction, an insert), so its speaker must not be
    counted into the shot by the line — not positioned, not staged by voice
    alone, not held against the cast-close claim. A speaker with any
    UNMARKED line in the same shot is on screen and does not qualify; and a
    speaker the shot's own prose puts in frame stays (the DP wrote them into
    the picture — the flag loses to the action, which is the conservative
    direction: drawing someone who is there beats deleting someone who is).
    `text=None` skips the prose check, for callers that handle the action
    path separately.
    """
    by_speaker: dict = {}
    for d in (dialogue or []):
        if not isinstance(d, dict):
            continue
        nm = _clean(str(d.get("speaker") or "").split(" — ")[0])
        if not nm:
            continue
        by_speaker.setdefault(nm, []).append(bool(d.get("offscreen")))
    out = []
    for nm, flags in by_speaker.items():
        if not all(flags):
            continue
        if text is not None and _appears_in_frame(str(text or ""), nm):
            continue
        out.append(nm)
    return out


# Which of a location's four plates conditions a given SHOT, and the wording
# that stops the model reproducing it.
#
# The bible draws four plates per location — master / alt_angle / detail /
# atmosphere — and every panel of every scene staged the MASTER. Measured on
# Rei E3: the Observatory carries 19 panels and the Glass House 7, each
# conditioned on one picture, and the result is a scene shot from one seat.
# PLANT-GLASSHOUSE's panels 1/5/7/9 are the same frame with different figures
# in it; its close-ups and inserts escape, because on those a FACE holds image1
# and the plate sits in the weak slot. So the lock is the plate, not the model —
# the same "reference in the strong slot wins" mechanism `location_leads`
# exploits deliberately, seen from its cost side.
#
# Two rules, and the second is the one that breaks the repeat:
#
#   * A shot whose subject is a SURFACE takes the detail plate, and a shot that
#     looks back down the axis takes the reverse. That is what those plates ARE;
#     matching them is free accuracy.
#   * Everything else ROTATES. A scene's wides are the shots that repeat, and
#     they repeat because they all ask for the same thing — handing consecutive
#     ones different vantages of the same place is the cheapest coverage there
#     is. `turn` counts only the shots that reach this branch: rotating on the
#     raw beat index puts TRAINING-MISFIRE's two wides (b0 and b6) back on the
#     same plate, which is precisely the failure.
#
# `detail` is deliberately NOT in the ring. It is a macro of one surface, so a
# medium shot conditioned on it gets a wall. The list is a PREFERENCE order —
# `_resolve_anchor` with `first` takes the first role that resolves — so a
# location with only a master (a returning one, or a user-supplied sheet) keeps
# behaving exactly as it did.
PLATE_RING = ("master", "alt_angle", "atmosphere")
# Sizes whose subject is a surface or an object rather than the space.
PLATE_SURFACE_SIZES = ("INSERT", "EXTREME CLOSE-UP")
PLATE_REVERSE_RE = re.compile(r"over[-\s]the[-\s]shoulder|reverse|from behind|"
                              r"\bbehind\b", re.I)


def location_plate(camera, turn=0):
    """Which location plate this shot wants -> (roles, took_a_turn). Pure.

    `roles` is a preference order for the late-bound anchor. `took_a_turn` says
    whether the ROTATION was used, and the caller advances `turn` only then —
    see the note above on why counting every beat re-collides the wides."""
    size, _ = shot_framing(camera)
    key = size.split(":")[0] if size else ""
    if key in PLATE_SURFACE_SIZES:
        return ["detail", "master"], False
    if PLATE_REVERSE_RE.search(camera or ""):
        return ["alt_angle", "master"], False
    i = turn % len(PLATE_RING)
    return list(PLATE_RING[i:] + PLATE_RING[:i]), True


def plate_plan(cameras, start_turn=0):
    """The whole scene's plate choices in one pass -> list of role lists.

    The turn counter is per SCENE and only the rotating shots advance it, so a
    caller holding one beat cannot work it out alone. Both twins call this with
    the scene's cameras in order, which is also what makes the two agree.

    `start_turn` is where the ring picks up, and it exists for the BOTTLE
    EPISODE. Restarting at 0 per scene is right when consecutive scenes are in
    different places — a new location should establish itself — and wrong when
    they are not: every scene then opens on the master plate, which is the
    one-camera lock this rotation exists to break, re-installed at the scene
    layer. Measured on THE LATE SHIFT (12 scenes, ONE room, SenseNova U1.5):
    the five rendered scene-opening panels correlated at mean 0.809 / worst
    0.937 on the 48x27 luma metric, against 0.532 for the failure that
    prompted the rotation and 0.040 after it shipped. Within a scene the
    rotation was working perfectly (master -> alt_angle -> atmosphere ->
    detail -> master); only the openings collided.

    It is STAMPED at plan time (`scenes.meta.plate_turn`), not derived here,
    for the reason `params.fight` is: the browser redraws ONE scene and cannot
    count the scenes before it, so a number the two sides compute separately
    is a number they will eventually disagree about — and two twins that
    disagree is a worse failure than a re-establish.
    """
    out, turn = [], int(start_turn or 0)
    for cam in cameras:
        roles, took = location_plate(cam, turn)
        out.append(roles)
        if took:
            turn += 1
    return out


# How a staged plate is DESCRIBED to the model, per role. A plate is the same
# place from a different mark, and saying which mark is what lets the shot's own
# camera direction argue with it on equal terms.
PLATE_LABEL = {
    "master": "its master plate, the establishing view",
    "alt_angle": "its reverse-angle plate, shot from the opposite side",
    "detail": "its detail plate, a close look at its materials and dressing",
    "atmosphere": "its atmosphere plate, the place in its own signature light",
}

# The panel's camera-move imperative.
#
# This is `ENVIRONMENT_MOVE`'s lesson applied one layer up, and it is the same
# measurement: a DESCRIPTIVE framing beside a location plate gets the plate
# reproduced (luma correlation 0.85-0.90 against the reference), an IMPERATIVE
# that reads as a move gets a genuine new vantage. Panels stated their framing
# descriptively — `[FRAMING]: WIDE ESTABLISHING: …` — and H3 did the safe thing.
#
# It leads, for the reason the framing already leads: this has to be read before
# the identity paragraphs, not after them.
PLATE_MOVE = ("Reposition the camera inside this location and shoot a new setup")
PLATE_MOVE_TAIL = ("The reference plate establishes what the place is made of, "
                   "not where this camera stands")


def wide_face_cap(model_key):
    """How many faces may ride along when the LOCATION leads a wide. Pure.

    `order_anchors`'s default of ONE is a slot-budget rule, not a composition
    one: it was written when a panel had four reference images to spend
    (Krea2EditRebalance) or three (the Qwen 2509 encoder), so a wide genuinely
    had to choose between the plate and the cast. Its failure mode is already
    written down — the second character stays named in the action prose with
    no sheet, and the model draws them from words.

    Measured on THE LATE SHIFT TRUMPET_INTAKE b1 (SenseNova U1.5, 2026-08-29):
    the beat casts Dennis and Priya, the action reads "Priya crosses ... and
    places it on the counter opposite Dennis", ONE face was staged, and the
    panel came back with Priya plus TWO invented strangers behind the counter
    and no Dennis at all.

    SenseNova takes ten reference images and H3 nine, so on those families the
    budget that forced the choice does not exist and dropping a face buys
    nothing. Same families and same reasoning as `panel_cast_cap`, which is
    the cap this then rides under — this only says "do not drop below it".
    Twinned in panelSpec.ts.
    """
    k = str(model_key or "").lower()
    return 4 if ("h3" in k or "sensenova" in k) else 1


def order_anchors(camera, faces, env, *, faces_when_wide=1):
    """Reference order for one panel -> (ordered, location_first).

    `faces` and `env` are (anchor, label) pairs and stay paired: `[REFERENCES]`
    names each picture by its NUMBER ("reference 1 is Aki's face sheet"), so
    reordering the anchors without reordering the labels would describe the set
    wrongly — worse than the original problem, because the model would be told
    the location plate is somebody's face.

    Close shots keep the existing order — faces first, sorted by who the shot
    is about, location last. Wide shots invert it and keep at most one face, so
    the plate that has to fill the frame is the one the encoder weights."""
    faces = list(faces)
    if env and location_leads(camera):
        return [env] + faces[:faces_when_wide], True
    return faces + ([env] if env else []), False


# Shot size as a natural clause. The bracketed composer shouts
# "WIDE ESTABLISHING: … figures occupy less than a third of the frame height";
# a prose model wants the same fact as a sentence it can read.
PROSE_FRAMING = {
    "EXTREME WIDE": "a very wide view where the place itself is the subject and "
                    "any figures are small and distant",
    "WIDE ESTABLISHING": "a wide establishing view of the whole place, with the "
                         "figures small in the frame",
    "WIDE": "a wide view of the whole place, with the figures small in the frame",
    "FULL SHOT": "a full-length view showing the figures head to foot with the "
                 "place around them",
    "MEDIUM WIDE": "a medium-wide view of the figures from the knees up, the "
                   "space clearly readable behind them",
    "TWO-SHOT": "both figures together in frame from the waist up",
    "MEDIUM SHOT": "the figures from the waist up",
    "OVER-THE-SHOULDER": "framed past one figure's shoulder onto the other",
    "MEDIUM CLOSE-UP": "a medium close-up, head and shoulders",
    "CLOSE-UP": "a close-up where the face fills most of the frame",
    "EXTREME CLOSE-UP": "an extreme close-up of a single detail filling the frame",
    "INSERT": "the object alone, filling the frame",
}


# Framings whose WORDING requires two people. Emitted at a beat that casts
# one, they are a written instruction to invent the second — measured on THE
# LAST SERVICE ARRIVAL b4, whose cast is Mara alone and whose `[FRAMING]` read
# "framed past one figure's shoulder onto the other, who faces camera": the
# panel came back with a man's back in the foreground AND a third woman behind
# her. The cinematographer legitimately asks for an over-the-shoulder on a
# solo beat (here, behind Mara looking through a doorway), so the framing has
# to survive with one subject rather than be dropped.
#
# Phrased POSITIVELY — a soft out-of-focus shoulder IS the shot's foreground —
# because these panels render on krea2, an SDXL-family model whose own guide in
# `prompt_guides.js` says it cannot subtract: "no second person" is read as a
# second person. Only H3 is measured obeying a terminal negation.
_SOLO_FRAMING = {
    "OVER-THE-SHOULDER":
        "OVER-THE-SHOULDER: framed past a soft, out-of-focus shoulder in the "
        "near foreground onto {who}, whose face is the only one visible",
    "TWO-SHOT": "MEDIUM SHOT: {who} alone in frame from the waist up",
}


def solo_framing(frame, subjects):
    """Rewrite a two-figure framing when only one person is staged. Pure."""
    if not frame or len(subjects or []) != 1:
        return frame
    head = str(frame).split(":", 1)[0].strip().upper()
    tmpl = _SOLO_FRAMING.get(head)
    return tmpl.format(who=subjects[0]) if tmpl else frame


def _panel_prose(spec):
    """A panel for a model that reads sentences (HiDream-O1, Seedream, GPT).

    Written to HiDream-O1's published guidance: coherent descriptive sentences
    rather than tag fragments, spatial relationships carried by clauses, the
    camera stated plainly, style at the END, and 50-75 tokens total. The
    bracketed composer is none of those things — it is ~400 tokens of
    ALL-CAPS sections with two 90-word identity paragraphs, and identity is
    what the reference sheets are for.
    """
    size, angle = shot_framing(spec.get("size") or spec.get("camera"))
    frame = PROSE_FRAMING.get(size.split(":")[0] if size else "", "")
    loc = spec.get("location") if isinstance(spec.get("location"), dict) else {}
    place = _clean(loc.get("name"))
    place_desc = _clean(loc.get("identity"))
    names = [_clean(c.get("name")) for c in (spec.get("cast") or []) if _clean(c.get("name"))]
    who = " and ".join(names[:3])

    out = []
    # With a location plate staged, the framing has to be an INSTRUCTION TO MOVE
    # THE CAMERA rather than a description of a picture — see PLATE_MOVE. Same
    # words either way; what changes is whether the sentence commands or
    # narrates, and that is the whole difference between a new vantage and a
    # copy of the plate.
    plate = _clean(spec.get("plate"))
    if plate and frame:
        out.append(f"{PLATE_MOVE}: {frame}"
                   + (f", {angle}" if angle else "") + f". {PLATE_MOVE_TAIL}.")
    elif plate:
        out.append(f"{PLATE_MOVE}"
                   + (f", {angle}" if angle else "") + f". {PLATE_MOVE_TAIL}.")
    elif frame:
        out.append(frame.capitalize() + (f", {angle}" if angle else "") + ".")
    # The place carries the frame on a wide, so it leads and keeps its
    # distinguishing clause — trimmed, because the cap is the whole point.
    if place:
        out.append(f"The location is {place}"
                   + (f", {_cap(place_desc, words=22)}" if place_desc else "") + ".")
    action = (_clean(spec.get("action")) or "the scene continues").rstrip(".")
    out.append((f"{who}: " if who else "") + _cap(action, words=30) + ".")
    tod = _clean(spec.get("time_of_day"))
    if tod:
        out.append(f"It is {tod}.")
    style = _clean(spec.get("style")) or "cinematic"
    world = spec.get("world") if isinstance(spec.get("world"), dict) else {}
    pal = _clean(world.get("palette"))
    art = "an" if style[:1].lower() in "aeiou" else "a"
    out.append(f"In the style of {art} {style} storyboard frame"
               + (f", {_cap(pal, words=8)}" if pal else "") + ".")
    return " ".join(out)


def _h3_panel(spec):
    """A panel in MiniMax H3's REFERENCE-MODE envelope (r2v).

    Prose panels name the people and hope the encoder works out which staged
    picture is which. Measured on an Astronaut Rei / Villian Rei two-shot: it
    does not — one character takes the conditioning and the other drifts, and
    the failure is invisible because the render is a perfectly good picture of
    the wrong person. The envelope states the binding instead, which is the
    whole reason it exists.

    Written to `director/knowledge/h3_official_ref_mode.md`, not a paraphrase of
    it. Two rules there are easy to get backwards and both are load-bearing:

    * A picture used ONLY to define a character, scene, costume or style gets NO
      standalone `<Picture N>` entry — it is cited INSIDE that item's
      `<Subject N>` definition (§2.2). Every reference a panel stages is of that
      kind, so this emits subjects, never bare picture entries.
    * A label keeps its meaning across every section (§2), so the same
      `<Subject N>` that was defined is the one the description acts on.

    `<Picture N>` is the 1-based position in the STAGED order — `ref_subjects`
    rides with `refs`, which rides with `anchors`, so the numbering cannot drift
    from what the graph is actually handed.
    """
    subjects = [s for s in (spec.get("ref_subjects") or []) if isinstance(s, dict)]
    if not subjects:
        # Nothing staged: there is no binding to state, and an envelope with an
        # empty subject_definitions is worse than the prose it replaced.
        return _panel_prose(spec)

    defs, retention, label_of = [], [], {}
    for i, s in enumerate(subjects, start=1):
        nm = _clean(s.get("name")) or f"subject {i}"
        who = _clean(s.get("identity"))
        label_of[nm.lower()] = (f"<Subject {i}>", nm)
        if s.get("kind") == "location":
            # WHICH plate, and what a plate is FOR. A location reference is the
            # one staged picture whose framing must NOT survive into the render
            # — it is a record of a place, not of this shot — and until the
            # envelope said so it claimed `fully_preserved`, which in H3's own
            # grammar (§4.1) means "the defined role is fully preserved". The
            # model obliged: every panel of a scene came back on the plate's
            # camera. `partially_preserved` is the marker for content that is
            # still used with some defined characteristics changed, which is
            # exactly the contract wanted here — keep the place, move the
            # camera.
            #
            # Note the phrasing: never "<Picture N> is …". §2.2 reserves that
            # form for a picture that is a target frame or composition anchor,
            # and a plate is neither — it is cited INSIDE the subject it
            # defines. (Pinned by
            # test_a_reference_that_only_defines_a_character_gets_no_picture_entry.)
            plate = PLATE_LABEL.get(_clean(spec.get("plate")), "a reference plate")
            defs.append(f"<Subject {i}> is {nm}, the location recorded in "
                        f"<Picture {i}>, {plate}"
                        + (f" — {_cap(who, words=22)}" if who else "")
                        + f". Take its architecture, materials, dressing and "
                          f"palette from <Picture {i}>; its camera position and "
                          f"composition are NOT this shot's and are overridden "
                          f"by the framing below.")
            retention.append(f"<Subject {i}> partially_preserved — the place "
                             f"itself is carried over unchanged; the camera is "
                             f"repositioned for this shot, so the vantage, "
                             f"framing and composition are new.")
        else:
            defs.append(f"<Subject {i}> is {nm}, the person in <Picture {i}>"
                        + (f" — {_cap(who, words=20)}" if who else "")
                        + f". Face, hair and wardrobe must match <Picture {i}> exactly.")
            retention.append(f"<Subject {i}> fully_preserved — identity and "
                             f"costume carried unchanged from <Picture {i}>.")

    # The description is the prose panel with each name replaced by the label it
    # was defined under, so the section that acts is talking about the same
    # things the section that defined them did.
    body = _panel_prose(spec)
    # When every person the beat casts has a staged sheet, the set is CLOSED,
    # and saying so is what stops the model adding company. Without the line,
    # a two-hander in a lived-in location routinely grew a bystander; with a
    # cast member left UNSTAGED (a wide whose six names outrun the slot cap)
    # the claim would contradict the action prose naming them, so the builders
    # only set `cast_complete` when nobody was dropped.
    if spec.get("cast_complete"):
        body += (" The only people on screen are the defined subjects — "
                 "no other person, figure or silhouette appears anywhere "
                 "in the frame.")
    # Longest name first: "Astronaut Rei" must not be relabelled by "Rei".
    # `count=1` on purpose — the label binds on first use and the rest of the
    # sentence stays readable prose rather than a wall of angle brackets.
    #
    # Each substitution lands as a NUMERIC PLACEHOLDER first, expanded once at
    # the end, because a later name can otherwise match INSIDE an earlier
    # replacement. Measured on ASTRONAUT_CAPTURE b6, whose location is named
    # "Alternate City — Astronaut Rei Flashback": the location key is the
    # longest, so it substituted first, and "astronaut rei" then found its
    # first occurrence inside the location's own label — the stored prompt read
    # `<Subject 3> (Alternate City — <Subject 1> (Astronaut Rei) Flashback)`,
    # i.e. the shot was told a character was part of the place's name. A
    # placeholder carries no letters, so `\b…\b` cannot match into it.
    # The sentinel is deliberately non-alphanumeric (private use area): a bare
    # "1" would collide with digits the prose already carries ("drags her
    # backward ten meters", a palette, a time of day). Both loops always run,
    # so no sentinel survives into the stored prompt.
    subs = {}
    for key, (lab, nm) in sorted(label_of.items(), key=lambda kv: -len(kv[0])):
        token = BIND_TOKEN.format(len(subs))
        subs[token] = f"{lab} ({nm})"
        body = re.sub(rf"\b{re.escape(key)}\b", token, body, count=1, flags=re.I)
    for token, text in subs.items():
        body = body.replace(token, text)

    return ("subject_definitions:\n" + "\n".join(defs)
            + "\n\nretention_analysis:\n" + "\n".join(retention)
            + "\n\ndetailed_description:\n" + body)


def _panel_prompt(spec, shape="stack", family=None):
    """ONE storyboard panel — the shot this beat is, as a single frame.

    `shape` picks the dialect: "prose" families get sentences (_panel_prose),
    everything else gets the bracketed contract below.

    Deliberately NOT the grid format: there is no layout to contract for, so
    the whole [GRID]/[PANEL N] apparatus goes away and what's left is a shot
    description with the identities locked to the staged reference sheets.

    The grade that a grid used to guarantee by rendering panels together is
    carried here by repetition instead — every panel of a scene gets the same
    style clause, the same world palette and the same time of day, in the same
    order — so panels of one scene still agree even though they are separate
    renders. No word cap: this goes to the reference-editing families, which
    read instructions rather than tag stacks."""
    # H3 is the one family with a published REFERENCE format, and CLAUDE.md
    # already records the measurement: prose is right for a SHEET (one subject,
    # no composition to state) and wrong for a PANEL, which stages several
    # references that have to be told apart.
    if family == "h3":
        return _h3_panel(spec)
    if shape == "prose":
        return _panel_prose(spec)
    world = spec.get("world") if isinstance(spec.get("world"), dict) else {}
    out = []

    style_bits = [_clean(spec.get("style")) or "photorealistic cinematic"]
    pal = _clean(world.get("palette"))
    if pal:
        style_bits.append(f"palette of {pal}")
    era = _clean(world.get("era"))
    if era:
        style_bits.append(f"set in {era}")
    tod = _clean(spec.get("time_of_day"))
    if tod:
        style_bits.append(str(tod))
    style_bits.append("one continuous photographic look, as if pulled from a "
                      "finished film")
    out.append(f"[STYLE]: {', '.join(style_bits)}.")

    # FRAMING leads, on its own, before the action — a shot size buried in a
    # clause of camera prose is simply not obeyed (measured: every panel of a
    # 42-panel storyboard came back a medium two-shot regardless of the plan).
    frame, angle = shot_framing(spec.get("size") or spec.get("camera"))
    frame = solo_framing(frame, [r.get("name") for r in (spec.get("ref_subjects") or [])
                                 if r.get("kind") == "character" and r.get("name")])
    if frame:
        out.append(f"[FRAMING]: {frame}"
                   + (f"; {angle}" if angle else "") + ".")
    elif angle:
        out.append(f"[FRAMING]: {angle}.")
    # A staged location plate is reproduced unless the prompt asks for a MOVE —
    # see PLATE_MOVE. [FRAMING] above describes the picture wanted; this
    # commands the camera, and the imperative is what the measurement says is
    # load-bearing.
    plate = _clean(spec.get("plate"))
    if plate:
        # Naming the plate is not decoration: it tells the model what KIND of
        # picture it is holding, which is how "don't reuse its framing" becomes
        # actionable rather than a bare prohibition.
        out.append(f"[CAMERA]: the location reference is "
                   f"{PLATE_LABEL.get(plate, 'a reference plate')}. "
                   f"{PLATE_MOVE}. {PLATE_MOVE_TAIL} — this is a different "
                   f"camera setup in the same place, so the vantage, the "
                   f"composition and what falls where in frame are new.")

    action = (_clean(spec.get("action")) or "the scene continues").rstrip(".")
    out.append(f"[SHOT]: {action}. "
               f"A single cinematic widescreen frame — one continuous image, "
               f"no split screen, no panels, no borders, no inset, and no "
               f"lettering, captions, signage text, handwriting or character "
               f"names rendered anywhere in the picture.")

    for c in (spec.get("cast") or [])[:3]:
        nm, ident = _clean(c.get("name")), _clean(c.get("identity"))
        if not nm:
            continue
        out.append(f"[LOCKED CHARACTER — {nm.upper()}]: {ident or nm}. "
                   f"Exactly one {nm} in the frame.")
    loc = spec.get("location") if isinstance(spec.get("location"), dict) else {}
    if _clean(loc.get("name")):
        out.append(f"[LOCKED LOCATION — {_clean(loc['name']).upper()}]: "
                   f"{_clean(loc.get('identity')) or _clean(loc['name'])}.")

    refs = [r for r in (spec.get("refs") or []) if _clean(str(r))]
    if refs:
        listed = "; ".join(f"reference {i + 1} is {_clean(str(r))}"
                           for i, r in enumerate(refs))
        out.append(f"[REFERENCES]: the supplied images are this production's "
                   f"own reference sheets — {listed}. The people in this frame "
                   f"are exactly those people and the place is exactly that "
                   f"place; the plain grey studio backdrop in any reference "
                   f"sheet is a sheet artifact and appears nowhere in this "
                   f"frame. Take identity and design from the references, "
                   f"never their framing — this frame is staged as described "
                   f"in [SHOT].")
    return " ".join(out)


def _grid_prompt(spec):
    """One storyboard grid for a whole scene — every beat a panel.

    Panels rendered TOGETHER share grade, faces and staging by construction,
    which is the continuity that per-shot references only approximate. The
    format mirrors the working [STYLE]/[GRID]/[LOCKED]/[PANEL] convention:
    style first (it governs everything), the grid contract, identity locks for
    everyone on screen, then one line per panel. Identities additionally bind
    to the staged reference sheets when `refs` names them — a lock written
    from prose alone reproduces the wrong-faces failure that got scene stills
    demoted to display-only.

    No word cap: this is an instruction block for the reference-editing
    families (Qwen-Edit / Klein / Krea 2), not an SDXL tag stack.
    """
    rows = int(spec.get("rows") or 1)
    cols = int(spec.get("cols") or 1)
    panels = [p for p in (spec.get("panels") or []) if isinstance(p, dict)]
    n = len(panels) or 1
    world = spec.get("world") if isinstance(spec.get("world"), dict) else {}

    style_bits = [_clean(spec.get("style")) or "photorealistic cinematic"]
    pal = _clean(world.get("palette"))
    if pal:
        style_bits.append(f"palette of {pal}")
    era = _clean(world.get("era"))
    if era:
        style_bits.append(f"set in {era}")
    tod = _clean(spec.get("time_of_day"))
    if tod:
        style_bits.append(f"every panel at {tod}")
    style_bits.append(
        "one continuous photographic look — the same lens family, the same "
        "grade, the same light logic in every panel, as if all panels were "
        "pulled from one finished film")

    out = [f"[STYLE]: {', '.join(style_bits)}.",
           f"[GRID]: {rows}x{cols} storyboard, {n} panels, bold black "
           f"borders, clear white gutters, panels clearly separated, reading "
           f"left-to-right top-to-bottom, each panel a cinematic widescreen "
           f"frame; clean photographic frames with no lettering, captions or "
           f"panel numbers printed anywhere."]

    for c in (spec.get("cast") or [])[:4]:
        nm, ident = _clean(c.get("name")), _clean(c.get("identity"))
        if not nm:
            continue
        out.append(f"[LOCKED CHARACTER — {nm.upper()}]: "
                   f"{ident or nm}. Identical face, hair, build and wardrobe "
                   f"in every panel {nm} appears in.")
    loc = spec.get("location") if isinstance(spec.get("location"), dict) else {}
    if _clean(loc.get("name")):
        out.append(f"[LOCKED LOCATION — {_clean(loc['name']).upper()}]: "
                   f"{_clean(loc.get('identity')) or _clean(loc['name'])}. "
                   f"The same real place, seen from different angles panel to "
                   f"panel.")

    refs = [r for r in (spec.get("refs") or []) if _clean(str(r))]
    if refs:
        listed = "; ".join(f"reference {i + 1} is {_clean(str(r))}"
                           for i, r in enumerate(refs))
        out.append(f"[REFERENCES]: the supplied images are this production's "
                   f"own reference sheets — {listed}. Every panel showing a "
                   f"referenced person shows exactly that person, and the "
                   f"location panels show exactly that place; the plain grey "
                   f"studio backdrop in any reference sheet is a sheet "
                   f"artifact and appears in no panel.")

    for k, p in enumerate(panels, start=1):
        size = _clean(p.get("size"))
        action = _clean(p.get("action")) or "the scene continues"
        cast = [_clean(x) for x in (p.get("cast") or []) if _clean(x)]
        who = f" ({', '.join(cast)})" if cast else ""
        out.append(f"[PANEL {k}]: {size + '. ' if size else ''}{action}{who}.")
    for k in range(n + 1, rows * cols + 1):
        out.append(f"[PANEL {k}]: solid matte black, empty.")
    return " ".join(out)


# The one negation H3 is asked to obey about the sheet itself. TERMINAL and
# stated in the video prompt rather than here — see h3_prompt.SHEET_NEGATION.
SHEET_NUMBER_RULE = (
    "Print a large white panel number in a solid black square in the top-left "
    "corner of each panel, counting from 1. No other lettering, captions, "
    "subtitles, signage text, handwriting or character names anywhere.")


def _sheet_prompt(spec):
    """ONE generation block's shots as one NUMBERED contact sheet.

    The block twin of `_grid_prompt`, and the differences are the whole point.
    A scene grid existed to be SLICED into per-beat panels — which is why it
    was retired: qwen-edit reproduced its reference images as panels instead of
    composing a layout, and a mis-drawn grid fed the slicer panels that were
    halves of other panels. This sheet is never sliced. It is staged WHOLE into
    the block's own r2v render as a single `<Picture 1>`, so a malformed one
    costs a bad reference rather than N confidently-wrong panels, and
    `gridsheet.verify_grid` is a quality gate rather than a safety one.

    What it buys over N separately-rendered panels is the thing separate
    renders cannot have: **one grade, one street, one style, by construction**.
    Measured on Rei E3 MEMORY_CAPTURE b13, its four beats drawn both ways at
    gpt-image-2, comparing the four panels against the four cells of one sheet:

        hue spread   95.6deg -> 4.4deg        (22x tighter)
        saturation   172.1   -> 9.9           (17x tighter)
        luma corr    +0.142  -> +0.086        (still four different shots)

    The last row is what makes the first two honest: consistency bought by
    repeating one frame would show up as luma correlation RISING toward the
    0.5+ that the panel-variety measurement calls "shot from one seat". It fell.
    The four separate panels had come back as four different cities at three
    different times of day, one of them in daylight with the wrong cast.

    Composed for the reference-editing families (gpt-image-2 measured; the grid
    contract is an instruction block, not an SDXL tag stack), so no word cap.
    """
    rows = int(spec.get("rows") or 1)
    cols = int(spec.get("cols") or 1)
    panels = [p for p in (spec.get("panels") or []) if isinstance(p, dict)]
    n = len(panels) or 1
    world = spec.get("world") if isinstance(spec.get("world"), dict) else {}

    style_bits = [_clean(spec.get("style")) or "photorealistic cinematic"]
    pal = _clean(world.get("palette"))
    if pal:
        style_bits.append(f"palette of {pal}")
    era = _clean(world.get("era"))
    if era:
        style_bits.append(f"set in {era}")
    tod = _clean(spec.get("time_of_day"))
    if tod:
        style_bits.append(f"every panel at {tod}")
    style_bits.append(
        "one continuous look — the same lens family, the same grade, the same "
        "light logic in every panel, as if all panels were pulled from one "
        "finished film")

    out = [f"[STYLE]: {', '.join(style_bits)}.",
           f"[GRID]: a {rows}x{cols} storyboard contact sheet, {n} panel"
           f"{'' if n == 1 else 's'}, bold black borders, clear white gutters, "
           f"panels clearly separated, reading left-to-right then "
           f"top-to-bottom, each panel a cinematic widescreen frame. "
           f"{SHEET_NUMBER_RULE}"]

    for c in (spec.get("cast") or [])[:4]:
        nm, ident = _clean(c.get("name")), _clean(c.get("identity"))
        if not nm:
            continue
        out.append(f"[LOCKED CHARACTER — {nm.upper()}]: "
                   f"{ident or nm}. Identical face, hair, build and wardrobe "
                   f"in every panel {nm} appears in.")
    # The location lock is STRONGER than the scene grid's, and it is the half
    # that separates a storyboard from a mood board: these panels are
    # consecutive shots of one continuous moment, so the place may not change
    # between them. Stated as "the same real street seen from N camera
    # positions" rather than as a prohibition — the panel work already measured
    # that a descriptive framing beside a plate gets the plate reproduced while
    # an imperative that reads as a MOVE gets a new vantage.
    loc = spec.get("location") if isinstance(spec.get("location"), dict) else {}
    if _clean(loc.get("name")):
        out.append(f"[LOCKED LOCATION — {_clean(loc['name']).upper()}]: "
                   f"{_clean(loc.get('identity')) or _clean(loc['name'])}. "
                   f"The same real place in every panel, seen from "
                   f"{n} different camera positions — the same architecture, "
                   f"the same signage, the same ground, the same weather and "
                   f"the same time of day in all of them.")

    refs = [r for r in (spec.get("refs") or []) if _clean(str(r))]
    if refs:
        listed = "; ".join(f"reference {i + 1} is {_clean(str(r))}"
                           for i, r in enumerate(refs))
        out.append(f"[REFERENCES]: the supplied images are this production's "
                   f"own reference sheets — {listed}. Every panel showing a "
                   f"referenced person shows exactly that person; the plain "
                   f"grey studio backdrop in any character sheet is a sheet "
                   f"artifact and appears in no panel.")

    for k, p in enumerate(panels, start=1):
        # FRAMING leads each panel for the reason it leads a single panel: a
        # shot size buried in a clause of camera prose is not obeyed. Here it
        # matters more, not less — the sheet is the only place the block's
        # shots 3..N get a composition at all.
        frame, angle = shot_framing(p.get("size") or p.get("camera"))
        cast = [_clean(x) for x in (p.get("cast") or []) if _clean(x)]
        frame = solo_framing(frame, cast)
        bits = [b for b in (frame, angle) if b]
        action = _clean(p.get("action")) or "the scene continues"
        who = f" ({', '.join(cast)})" if cast else ""
        out.append(f"[PANEL {k}]: {'; '.join(bits) + '. ' if bits else ''}"
                   f"{action}{who}.")
    for k in range(n + 1, rows * cols + 1):
        out.append(f"[PANEL {k}]: solid matte black, empty.")
    return " ".join(out)


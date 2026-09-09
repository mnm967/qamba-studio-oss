"""Compile one storyboard block into LTX 2.5's prose, deterministically.

Invariant #6's rule applies here exactly as it does to `h3_prompt`: the studio
compiles the vendor format from structured beats, and the LLM never writes it.
What differs is the format itself — LTX reads continuous prose and was NOT
trained on MiniMax H3's `subject_definitions:` / `retention_analysis:` envelope,
so a block rendered on LTX through the H3 compiler is being handed a format the
vendor's own guide (and ours, `director/prompt_guides.js` → `ltx-2.5`) says it
does not read. That was the whole reason LTX could not render episode blocks.

The element order is the vendor's own (docs.ltx.io prompting guide): the SHOT
first, then the scene's light and texture, then the action, then who the people
are, then the camera move, then what is heard. Two of its rules are load-bearing
and both were measured absent:

  * CARRY THE ACTION TO ITS END. An extreme close-up asked for a hand reaching
    while a second character dragged her backward came back as a flawless
    close-up in which the drag never happened.
  * SAY HOW THE SUBJECTS LOOK ONCE THE MOVE IS OVER. The vendor calls this
    critical for completing a motion; without it a lateral track ended on an
    unbidden close-up of a bystander.

Reference handling is the other half of the difference. H3 numbers a flat pool
of pictures and the prompt must bind `<Picture N>` to each subject; LTX's MSR
guide has four subject slots plus a dedicated background, each carrying a
learned slot embedding, so the binding is structural and re-describing a staged
face here only competes with the sheet. Hence: name people, direct what they
DO, and never restate wardrobe (the r2v note in our own guide).
"""
import re

import image_prompt

FMT_VERSION = 1

# The official motion grammar the cinematographer writes ("with large amplitude
# at fast speed") is H3's phrasing. LTX wants the move in plain words, so the
# jargon is mapped rather than passed through.
#
# It is mapped as ONE unit, and that ordering is the bug this replaces. The
# first version substituted the words first and stripped the connectives after,
# so `at slow speed` became `at slowly` — the `at ` strip is guarded by a
# lookahead for `<word> speed`, which by then no longer matched. Every real
# planner camera line carries this construction, so every LTX block rendered
# with it. Verified against the live Rei E3 storyboard's own camera strings.
_AMPLITUDE = {"large": "far", "small": "slightly", "medium": "steadily"}
_SPEED = {"fast": "quickly", "slow": "slowly", "medium": "at a steady pace"}
_MOVE_GRAMMAR = re.compile(
    r"\bwith\s+(large|small|medium)\s+amplitude"
    r"(?:\s+at\s+(fast|slow|medium)\s+speed)?"
    r"|\bat\s+(fast|slow|medium)\s+speed", re.I)
# The planner's move clause opens by naming the camera, and the caller prepends
# "The camera " — so without this every block read "The camera the camera
# tracks laterally...". Also verified against the live storyboard.
_LEADING_CAMERA = re.compile(r"^(?:and\s+)?(?:the\s+)?camera\s+", re.I)


def _plain_words(m):
    """One `with <amplitude> at <speed>` construction -> plain adverbs.

    Speed leads because it reads better in front of the distance ("pushes in
    slowly and slightly" over "slightly and slowly"), and either half may be
    absent — the planner writes both, one, or neither."""
    amp, speed, speed_only = m.group(1), m.group(2), m.group(3)
    parts = []
    if speed or speed_only:
        parts.append(_SPEED[(speed or speed_only).lower()])
    if amp:
        parts.append(_AMPLITUDE[amp.lower()])
    return " and ".join(parts)


def _plain_move(camera):
    """The camera clause in plain words, jargon mapped. Pure.

    `camera` is the planner's whole line — "a medium close-up at high angle; the
    camera arcs with large amplitude at slow speed around A and B". The size and
    angle are stated separately (they open the paragraph), so this keeps only
    what the camera DOES.

    A line with no semicolon is not always moveless: "the camera holds a static
    shot on the space just left" is the whole line, and returning "" for it
    dropped the camera direction entirely on every held beat. So the fallback
    is to take from wherever the line names the camera.
    """
    text = image_prompt._clean(camera)
    if ";" in text:
        move = text.split(";", 1)[1]
    else:
        hit = re.search(r"\bthe\s+camera\b", text, re.I)
        move = text[hit.start():] if hit else ""
    if not move.strip():
        return ""
    move = _MOVE_GRAMMAR.sub(_plain_words, move)
    move = _LEADING_CAMERA.sub("", move.strip())
    move = re.sub(r"\s{2,}", " ", move).strip(" .,;")
    return move


def _framing(camera):
    """(prose framing, prose angle) for a shot. Reuses the panel composer's own
    tables so a block and its storyboard panel describe the same shot the same
    way."""
    size, angle = image_prompt.shot_framing(camera)
    key = size.split(":")[0] if size else ""
    return image_prompt.PROSE_FRAMING.get(key, ""), angle


def _who(beat, positions):
    """Who is in this shot and where they stand, from the planner's own
    blocking. Positions are what stop independent renders drifting people
    around a location, and they are the cheapest way to satisfy the vendor's
    "how subjects appear" rule for the START of a shot."""
    names = [n for n in (beat.get("cast_names") or []) if n]
    if not names:
        return ""
    placed = [f"{n} {positions[n]}" for n in names
              if isinstance(positions.get(n), str) and positions.get(n).strip()]
    if placed:
        return "; ".join(placed)
    return " and ".join(names[:4])


def _dialogue(beat):
    """Spoken lines, in quotes, with the lip-sync instruction the guide asks
    for. LTX was measured speaking a quoted line verbatim and lip-synced.

    Which is exactly why the listeners are named as listeners, per line. That
    guard shipped in `h3_prompt` and was missing here — on the model that
    lip-syncs BEST, staging up to four subject slots, so nothing said whose
    mouth to move. `image_prompt.listener_clause` is the one rule both
    compilers call; see its docstring for why the non-speakers are also told
    to react rather than merely to be silent.

    The pool is the beat's own cast, which `blocks._beats_for_prompt` has
    already pruned to who the shot names — so this cannot name someone the
    block did not stage.
    """
    cast = [n for n in (beat.get("cast_names") or []) if n]
    out = []
    for d in (beat.get("dialogue") or []):
        line = image_prompt._clean(d.get("line"))
        if not line:
            continue
        who = image_prompt._clean(d.get("speaker")) or "the speaker"
        delivery = image_prompt._clean(d.get("delivery"))
        if d.get("offscreen"):
            # The DP's V.O. cutaway: the voice continues while the camera is
            # on the listener or an insert. LTX reads prose, so the off-screen
            # fact is stated in words rather than MiniMax's grammar — and the
            # lips-closed clause is the shared rule both compilers call, most
            # needed here on the model that lip-syncs BEST: an unmarked quoted
            # line would put the words in whichever staged mouth it picks.
            say = f'{who}\'s voice is heard from off-screen, "{line.rstrip(chr(34))}"'
            if delivery:
                say += f", {delivery.rstrip('.')}"
            say += ". " + image_prompt.offscreen_vo_clause(cast).rstrip(".")
            out.append(say)
            continue
        say = f'{who} says, "{line.rstrip(chr(34))}"'
        if delivery:
            say += f", {delivery.rstrip('.')}"
        say += ", their lips moving in sync with the words"
        guard = image_prompt.listener_clause(who, cast)
        if guard:
            # The caller joins on ". " and strips a trailing period, so the
            # guard is appended as its own sentence rather than a clause.
            say += ". " + guard.rstrip(".")
        out.append(say)
    return ". ".join(out)


def compile_block(*, render_ms, beats, cast=None, environment=None,
                  ref_slots=None, style="", medium="film", scene_time=None,
                  scene_type=None, props=None, soundscape_hint=None,
                  prev_closing=None, vfx_language=None, lora_triggers=None,
                  **_h3_only):
    """One block -> {description, soundscape, music, fmt_version}.

    Keyword-compatible with `h3_prompt.compile_block` so `handle_master_pass`
    can pick a compiler and call it once; the H3-only knobs it always passes
    (retention analysis, `<Video N>` context slots, lyrics, audio ref slots,
    `has_end_frame`, `lip_sync`, `audio_mode`, `next_opening`) are accepted and
    ignored here rather than making the call site branch on twenty arguments.

    Returned dict is deliberately the same SHAPE the H3 compiler returns, so
    `generation_blocks.compiled_prompt` stays one column that PromptRefsModal
    can render either way.
    """
    beats = list(beats or [])
    env = environment or {}
    sents, sounds = [], []

    if prev_closing:
        sents.append(f"Continuing directly from the previous shot, in which "
                     f"{image_prompt._clean(prev_closing).rstrip('.')}")

    place = image_prompt._clean(env.get("name"))
    look = image_prompt._clean(env.get("identity_line") or env.get("summary"))
    palette = image_prompt._clean(env.get("palette"))

    for i, beat in enumerate(beats):
        frame, angle = _framing(beat.get("camera"))
        move = _plain_move(beat.get("camera"))
        positions = beat.get("positions") or {}
        opener = ("The video begins on" if i == 0 else "Then cut to")
        shot = f"{opener} {frame or 'the scene'}"
        if angle:
            shot += f", {angle}"
        sents.append(shot)
        if i == 0:
            # The scene's own light and texture, once — the vendor's second
            # element. The staged background plate carries the place, so this
            # is a short reminder rather than a description of it.
            if place:
                setting = f"The place is {place}"
                if look:
                    setting += f", {image_prompt._cap(look, words=18)}"
                sents.append(setting)
            if scene_time:
                sents.append(f"It is {image_prompt._clean(scene_time)}")
            if palette:
                sents.append(f"The palette is {image_prompt._cap(palette, words=10)}")
        who = _who(beat, positions)
        if who:
            sents.append(who)
        action = image_prompt._clean(beat.get("action"))
        if action:
            sents.append(image_prompt._cap(action, words=45).rstrip("."))
        if move:
            # …and how they look once it is over. The vendor calls this
            # critical for completing a motion; deterministically, the honest
            # statement is that the shot still holds the framing it opened on
            # and the action has finished playing.
            sents.append(f"The camera {move}")
            sents.append(f"When the move settles the shot still holds "
                         f"{frame or 'this framing'} and the action above has "
                         f"played all the way through")
        line = _dialogue(beat)
        if line:
            sents.append(line)
        sfx = image_prompt._clean(beat.get("sfx"))
        if sfx:
            sounds.append(sfx.rstrip("."))

    if props:
        named = [image_prompt._clean(p.get("name")) for p in props
                 if image_prompt._clean(p.get("name"))]
        if named:
            sents.append(f"The {', '.join(named[:3])} on screen are the ones "
                         f"shown in the reference images")
    if vfx_language:
        sents.append(image_prompt._cap(image_prompt._clean(vfx_language), words=20))
    if style:
        sents.append(f"{image_prompt._clean(style)}, cinematic lighting")

    description = ". ".join(s.rstrip(".") for s in sents if s).strip() + "."

    # A named SOURCE, never an atmosphere: measured, "faint room tone" comes
    # back at -46 LUFS (silence) while footsteps and a siren land at -24.
    if soundscape_hint:
        sounds.insert(0, image_prompt._clean(soundscape_hint).rstrip("."))
    soundscape = ". ".join(sounds) + "." if sounds else ""
    return {"description": description, "soundscape": soundscape, "music": "",
            "fmt_version": FMT_VERSION}


def full_prompt_text(compiled):
    """The exact string handed to LTX's text encoder.

    One paragraph. The sound rides INSIDE the same prose rather than in a
    labelled section — a labelled `overall_soundscape:` is H3's format, and the
    guide is explicit that LTX was not trained to read it.
    """
    text = compiled.get("description") or ""
    sound = compiled.get("soundscape") or ""
    if sound:
        text = f"{text.rstrip()} {sound.rstrip()}"
    return text.strip()

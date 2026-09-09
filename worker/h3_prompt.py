"""MiniMax H3 prompt compiler — the ONE place the official format is produced.
LLMs fill scenes/beats/bible rows upstream; this module compiles them
deterministically so format bugs are fixable in exactly one tested spot.

fmt_version 5 targets the official guides verbatim
(VIDEO_PROMPT_WRITING_GUIDE_ref_en + _base_en, stored in
director/knowledge/h3_official_*.md):

  Full-reference (r2v) output = six labeled sections:
    subject_definitions   <Subject/Picture/Audio N> labels + roles
    summary               [task types] + one-paragraph target description
    retention_analysis    per-label relationship markers
                          (fully_preserved / partially_preserved / fully_copy …)
    detailed_description  style opening, then [Shot 1] / [Shot N] At MM:SS.mmm
                          with subject labels, official camera grammar,
                          speaker IDs outside <d>, lyric cues
    overall_soundscape    ambience & physical sound only
    non_diegetic_music    audience-only score (N/A allowed)

  Base modes (t2v/i2v/flf) keep the three-field body; FL2VA additionally
  gets its alignment instruction line (flf_alignment_line helper).

Lip-sync policy for reused music (<Audio 1> fully_copy):
  lip_sync=True   a visible subject re-performs the lyric:
                  `<Subject 1> (S1) sings, <d>[English] …</d>`
  lip_sync=False  the documented no-new-speaker construction:
                  `When <Audio 1> reaches the phrase <d>…</d>, …` and every
                  mouth stays closed — beats still cut on the music.

Pure functions over plain dicts — no DB access — so golden tests pin the
format byte-for-byte. fmt_version bumps on any output change.
"""

import re

import image_prompt
import vocal_events as VE

FMT_VERSION = 20    # a location's picture may be its coverage contact sheet

# The two labels `full_prompt_text` puts the description behind — six-section
# form and three-field form. `with_triggers` needs them to find where the prose
# actually starts in an already-rendered prompt; neither is a substring of the
# other, so the search order is arbitrary.
_DESC_LABELS = ("detailed_description:", "integrated_multimodal_description:")

MEDIUM_LABEL = {
    "music_video": "music video",
    "film": "film",
    "series": "episode",
}

STYLE_OPENING = {
    "anime": "2D-animated anime",
    "cinematic": "live-action cinematic",
    "watercolor": "watercolor-animated",
    "retro": "vintage-film",
}


# ---- spoken numbers -------------------------------------------------------
# H3 mispronounces DIGIT forms and says spelled-out numbers correctly.
# Measured on AFTERLIGHT STATIC, same scene and window both times, only the
# digits changed: "08:14. 881 megahertz" came back as "Lotto at C-Tore, 880 on
# megahertz", while "oh eight fourteen. eight hundred eighty-one megahertz"
# transcribed as "Oh, 814, 881 megahertz" — the ASR normalising spoken words
# back to digits, which is only possible if the audio said them. THE-BOOK's
# dates ("March third. March eighteen.") were already words and always worked.
#
# Applied at COMPILE time, so a writer keeps typing "08:14" and the model still
# says it. Lines already written as words pass through untouched.
_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
         "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
         "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety"]
_ORDINAL = {"1": "first", "2": "second", "3": "third", "4": "fourth",
            "5": "fifth", "6": "sixth", "7": "seventh", "8": "eighth",
            "9": "ninth", "10": "tenth", "11": "eleventh", "12": "twelfth",
            "13": "thirteenth", "18": "eighteenth", "20": "twentieth",
            "21": "twenty-first", "30": "thirtieth"}


def _under_100(n: int) -> str:
    if n < 20:
        return _ONES[n]
    t, o = divmod(n, 10)
    return _TENS[t] + (f"-{_ONES[o]}" if o else "")


def number_words(n) -> str:
    """0-9999 as spoken English. 881 -> 'eight hundred eighty-one'. Pure."""
    n = int(n)
    if n < 100:
        return _under_100(n)
    if n < 1000:
        h, r = divmod(n, 100)
        return _ONES[h] + " hundred" + (f" {_under_100(r)}" if r else "")
    th, r = divmod(n, 1000)
    return _ONES[th] + " thousand" + (f" {number_words(r)}" if r else "")


def _time_words(h: str, m: str) -> str:
    """08:14 -> 'oh eight fourteen'; 21:00 -> 'twenty-one hundred'.

    A leading zero is spoken "oh", the way an operator reads a clock — which is
    also how the character who says these lines is written."""
    hh = ("oh " + _ONES[int(h)]) if h.startswith("0") and int(h) < 10 else _under_100(int(h))
    if int(m) == 0:
        return f"{hh} hundred"
    mm = ("oh " + _ONES[int(m)]) if int(m) < 10 else _under_100(int(m))
    return f"{hh} {mm}"


def speakable(text: str) -> str:
    """Digit forms in a SPOKEN line rewritten as words. Pure."""
    if not text:
        return text
    out = re.sub(r"\b(\d{1,2}):(\d{2})\b",
                 lambda m: _time_words(m.group(1), m.group(2)), text)
    out = re.sub(r"\b(\d{1,4})(st|nd|rd|th)\b",
                 lambda m: _ORDINAL.get(m.group(1),
                                        number_words(m.group(1)) + m.group(2)), out)
    return re.sub(r"\b\d{1,4}\b", lambda m: number_words(m.group(0)), out)


def _spoken(d) -> str:
    """A dialogue entry's WORDS — the vocal events stripped. `<d>…</d>` is what
    H3 lip-syncs, and "(sigh)" inside it is a word to mouth; the event is said
    as action instead (`_event_lead`)."""
    return VE.strip_events((d or {}).get("line") or "")


def _event_lead(d) -> str:
    """" sighs, then" / "" — the vocal events a line carries, as the action
    the character performs before the words. Inserted after the speaker's
    `(S1)` label so "<Subject 1> (S1) sighs, then says: …" reads as one
    clause, and the recorded line (which CONTAINS the sigh, on Breeze) is
    still bound to the same speaker."""
    ev = VE.event_prose(VE.events_in((d or {}).get("line") or ""))
    return f" {ev}, then" if ev else ""


def _ts(ms: int) -> str:
    """Official cut-time format: MM:SS.mmm."""
    s, ms = divmod(int(ms), 1000)
    m, s = divmod(s, 60)
    return f"{m:02d}:{s:02d}.{ms:03d}"


def _sentence(text: str) -> str:
    text = (text or "").strip()
    if text and text[-1] not in ".!?…":
        text += "."
    return text


def _clause(text: str) -> str:
    return (text or "").strip().rstrip(".!…")


class CompileError(ValueError):
    pass


def _trigger_prefix(triggers, text: str) -> str:
    """`"tok, tok2, "` for the trigger tokens `text` does not already carry.

    A LoRA trigger is a token its author prepended at TRAINING time and kept out
    of the captions, so it appears nowhere in the prose the adapter learned and
    the adapter contributes nothing unless it is in the prompt — it loads
    cleanly, logs nothing and does nothing, which is the silent downgrade this
    codebase keeps naming.

    Substring containment is the same "already there" test `resolve()` uses for
    its model-level trigger. It is crude, and deliberately so: these tokens are
    invented strings precisely so they collide with nothing, and the failure it
    guards (the token twice) is worse than the one it risks.
    """
    out, seen = [], set()
    low = (text or "").lower()
    for t in (triggers or []):
        t = (t or "").strip().strip(",").strip()
        k = t.lower()
        if not t or k in seen or k in low:
            continue
        seen.add(k)
        out.append(t)
    return ", ".join(out) + ", " if out else ""


def with_triggers(text: str, triggers) -> str:
    """Put LoRA trigger tokens into an ALREADY-RENDERED prompt string.

    `compile_block` takes its tokens directly and needs none of this; the
    free-standing clip path (`handle_clip_gen`) does, because there the prompt
    is whatever the composer sent — plain prose, or the vendor envelope an
    enhance produced for an `h3`-format family.

    Which it is decides where the token can go. Stapled to the front of an
    envelope it lands above `subject_definitions:`, outside every field H3
    reads — the token is then present in the string and absent from the prompt,
    which is the worst of both. So it goes immediately after the description
    label when there is one, and at the front only when there is not.
    """
    text = text or ""
    pre = _trigger_prefix(triggers, text) if text.strip() else ""
    if not pre:
        return text
    for label in _DESC_LABELS:
        i = text.find(label)
        if i == -1:
            continue
        # Step over the label's own separator (newline for the six-section form,
        # a space for the three-field one) so the token opens the prose.
        j = i + len(label)
        while j < len(text) and text[j] in " \t\n":
            j += 1
        return text[:j] + pre + text[j:]
    return pre + text


# The vendor's own token for "there is none of this". Do NOT reach for it on
# `overall_soundscape`: the guide says `N/A` there means COMPLETE SILENCE and
# is only for when silence was asked for, where on `non_diegetic_music` it just
# means no score.
_NA = "N/A"
# Measured precedent for a terminal negation: H3 is the family this codebase
# records obeying one (the panel prompt's "no split screen, no lettering", and
# `cast_complete`'s close of the cast set). Kept to one sentence, at the end.
_NO_SPEECH = ("No character speaks, and there is no narration, voice-over or "
              "sung vocal anywhere in the clip.")
_SPEECH_MARKERS = ("says:", "<d>", "speaks", "dialogue:", "voice-over", "voiceover",
                   "narrat", "whispers", "shouts", "replies")


def with_audio_defaults(text: str, *, allow_speech: bool = False) -> str:
    """Close H3's two AUDIO channels on a prompt nobody compiled.

    H3's format is three fields and two of them are sound. `compile_block`
    writes all three; the free-standing clip path sends `payload.prompt`
    VERBATIM (invariant #6's one documented exception), so an extend or a
    chain reaches the model with no `overall_soundscape` and no
    `non_diegetic_music` at all — and H3 fills both itself. Measured on two
    renders of a silent fight: speech-band energy at -20.3 and -21.4 dB
    against the source block's -25.3, i.e. the model inventing an audio bed,
    which is where "a background voice-over from nowhere" comes from.
    `non_diegetic_music` is literally the channel for it — the guide's words
    are "background music that the characters cannot hear and only the
    audience can hear".

    Two things this deliberately does NOT do:

      * It never writes `overall_soundscape`. `N/A` there means complete
        silence and the guide says to use it only when silence was asked for;
        anything else would be this module inventing sound design, which is
        the writer's job. Ambience is not the complaint — invented speech is.
      * It never touches a prompt that already carries dialogue. A prompt with
        `says:` or `<d>` wants speech, and closing the channel under it would
        silently drop the line the user wrote.

    Idempotent, so an enhance that already produced a full envelope passes
    through untouched.
    """
    text = text or ""
    if not text.strip():
        return text
    low = text.lower()
    wants_speech = allow_speech or any(m in low for m in _SPEECH_MARKERS)

    # ORDER MATTERS. On BARE PROSE the whole string is the description, so the
    # clause has to be placed while that is still true — append the music field
    # first and `_append_to_description` finds no label, puts the clause at the
    # end of everything, and lands it INSIDE the music value. Which is the
    # exact failure its own docstring warns about, one line up.
    out = text
    if not wants_speech and _NO_SPEECH.lower() not in low:
        out = _append_to_description(out, _NO_SPEECH)
    if "non_diegetic_music:" not in low:
        out = out.rstrip() + f"\n\nnon_diegetic_music: {_NA}"
    return out


def _append_to_description(text: str, clause: str) -> str:
    """Put a terminal clause at the END of the description field.

    The mirror of `with_triggers`, which opens it: same reason for the same
    care. Stapled to the end of an ENVELOPE the clause lands after
    `non_diegetic_music:`, outside every field H3 reads — present in the
    string and absent from the prompt. So it goes at the end of the
    description's own text when there is a label, and at the end of the whole
    thing when there is not.
    """
    for label in _DESC_LABELS:
        i = text.find(label)
        if i == -1:
            continue
        # The description runs until the next field label, or to the end.
        rest = text[i + len(label):]
        ends = [rest.find(f"\n{k}") for k in
                ("overall_soundscape:", "non_diegetic_music:", "subject_definitions:",
                 "retention_analysis:")]
        cut = min([e for e in ends if e != -1], default=-1)
        if cut == -1:
            head, tail = text, ""
        else:
            j = i + len(label) + cut
            head, tail = text[:j], text[j:]
        return head.rstrip() + " " + clause + tail
    return text.rstrip() + " " + clause


def _staged_others(beat, subj_no):
    """This beat's cast, intersected with the subjects the envelope declares.

    Note `subj_no` means DECLARED, not "holds a picture" — a cast member with
    no reference slot still gets a `<Subject N>` and an identity line. That is
    fine, and the intersection is still the right filter: both halves are
    people the prompt has already put in this shot, so the guard can only ever
    constrain someone, never introduce them. An undeclared name appearing in a
    guard sentence would be the invented-extra artifact, since a guard is
    prose and prose is what H3 draws extra people out of."""
    return [nm for nm in (beat.get("cast_names") or []) if nm in subj_no]


_COUNT_WORDS = ("zero", "one", "two", "three", "four", "five", "six",
                "seven", "eight", "nine")


def _count_word(n) -> str:
    """Small counts as words ("four-panel"), anything else as digits.

    The vendor's own storyboard examples spell the panel count ("six-panel"),
    and a digit next to the panel NUMBERS the sheet is asked to print reads as
    one of them."""
    n = int(n)
    return _COUNT_WORDS[n] if 0 <= n < len(_COUNT_WORDS) else str(n)


def _shots_list(idxs) -> str:
    return ", ".join(f"[Shot {i}]" for i in idxs)


def _bind_subject_names(action, present, subj_no, shot_no, *, tagged=True):
    """One shot's action prose, with each present character's name replaced by
    the label the envelope defined them under.

    THREE RULES: LONGEST NAME FIRST, ON WORD BOUNDARIES, THROUGH PLACEHOLDERS.
    They are `image_prompt._h3_panel`'s rules arriving on the video side, and
    each was a bug here first. The panel compiler learned them from a location
    called "Alternate City - Astronaut Rei Flashback"; this one learned them
    from a cast of "Rei", "Guide Rei", "Knight Rei" and "Astronaut Rei".

    WHAT THE PLAIN `action.replace(name, rep, 1)` DID TO THAT CAST, measured on
    Rei EP04 b45 and reproducible from its stored prompt: the loop ran in
    `present` order, which is cast order, so "Rei" was substituted first - and
    "Rei" is a substring of "Guide Rei", so the first occurrence her replace
    found was the one INSIDE the guide's name. All three shots came back
    reading `Guide <Subject 1> (Rei - black zip hoodie ...)`. Guide Rei's own
    identity line and her `<Picture 1>` binding never reached the description
    at all, so the render was told the leader is a black-hoodie Rei holding no
    reference picture, and drew exactly that. Nothing errored; the take is a
    perfectly good picture of the wrong character.

    EVERY occurrence of a name is consumed, and only the FIRST carries the
    label. Consuming just the first - which is what `count=1` does, and all the
    old code did - leaves a second "Guide Rei" standing for the shorter name to
    match into one sentence later, which is the same bug wearing a different
    hat. Expanding the rest to the bare name is the official section 5.3 rule
    the old comment already stated: the tag binds on first use and the sentence
    stays readable prose rather than a wall of angle brackets.

    CASE-SENSITIVE, deliberately, and that is the one thing here that does not
    change. The panel twin matches case-insensitively; widening this one would
    newly capture a name that is also an ordinary word ("Guide", "May", "Will")
    in prose this compiler has read correctly for its whole life.
    """
    subs = {}

    def _tok(text):
        token = image_prompt.BIND_TOKEN.format(len(subs))
        subs[token] = text
        return token

    for c in sorted(present, key=lambda x: -len(x["name"])):
        nm = c["name"]
        pat = re.compile(rf"\b{re.escape(nm)}\b")
        if not pat.search(action):
            continue
        ident = _clause(c.get("identity_line") or "") if shot_no == c["shots"][0] else ""
        if tagged:
            sn = subj_no[nm]
            first = (f"<Subject {sn}> ({nm} — {ident})" if ident
                     else f"<Subject {sn}> ({nm})")
        else:
            # No tags to hang the identity line on, so it goes inline the way
            # the official FL2VA examples repeat it: Name - attributes - verb.
            first = f"{nm} — {ident} —" if ident else nm
        head, rest, hits = _tok(first), _tok(nm), []

        def _once(m, head=head, rest=rest, hits=hits):
            hits.append(1)
            return head if len(hits) == 1 else rest

        action = pat.sub(_once, action)
    for token, text in subs.items():
        action = action.replace(token, text)
    return action


def compile_block(
    *,
    render_ms: int,
    warmup_ms: int,
    aspect: str,
    style: str,
    medium: str,
    beats: list,
    cast: list,
    environment: dict | None,
    ref_slots: list,
    mode: str = "r2v",
    has_end_frame: bool = False,
    audio_mode: str = "native",
    lip_sync: bool = True,
    lyrics: list | None = None,
    locked_kind: str = "music",
    next_opening: str | None = None,
    prev_closing: str | None = None,
    soundscape_hint: str | None = None,
    music_hint: str | None = None,
    audio_refs: list | None = None,
    video_refs: list | None = None,
    scene_time: str | None = None,
    vfx_language: str | None = None,
    scene_type: str | None = None,
    props: list | None = None,
    lora_triggers: list | None = None,
) -> dict:
    """Compile one master pass into the official full-reference format.

    beats: ordered [{start_ms (content-relative), duration_ms, action, camera,
      dialogue: [{speaker, line, delivery?, language?}], sfx,
      cast_names: [str]  — who is visibly in frame this beat,
      positions: {name: "at the teller cage"}  — planner-authored spatial
      anchors, stated per shot so independent renders cannot drift people
      across the location}]
    lora_triggers: tokens the block's picked LoRAs need present in the prompt
      (`resolve.lora_triggers`), placed once at the head of the description.
      Almost every H3 adapter needs none; the ones that do were trained with the
      token prepended and the captions stripped of it, so without it here the
      LoRA loads, logs nothing and does nothing. It goes INSIDE the description
      rather than in front of the compiled envelope for the reason invariant #6
      exists: above `subject_definitions:` is outside every field H3 reads.
    scene_type: the scene's type ("action" arms the equipment discipline
      clause — fights are where models invent weapons).
    props: [{name, look?}] — the story's bible props present in this segment;
      compiled into an equipment line so objects stay the objects designed.
    cast: [{name, identity_line}] — block-level cast; order fixes S1/S2…
    environment: {name, identity_line?|summary?, palette?}
    ref_slots: [{slot (1-based picture number), kind: 'chain'|'start_frame'|
      'character'|'environment'|'scene_ref'|'look', name?, role?, desc?,
      shot_idxs?: [int]}] — mirrors the job's staged reference-image order.

      Three kinds are images of a *scene* rather than a subject, and the
      difference matters more than any other declaration in the prompt:
        chain / start_frame — the target video opens on this exact frame.
          Fully preserved, composition included.
        scene_ref           — a composed storyboard panel for a shot. Its
          framing is intentional, so composition is followed.
        look                — a design/VFX reference. Its rendering is
          followed and its framing explicitly is NOT; copying the staging of
          a look plate overrides the shot we planned.
    lyrics: [{t0_ms, t1_ms, text, singer?}] — RENDER-relative; locked mode only
    locked_kind: what the locked <Audio 1> IS — "music" (the MV master track,
      the historical only case) or "dialogue" (a dialogue spine: the segment's
      recorded conversation placed at true time). Decides the vocal verb
      ("sings" vs "says") and how <Audio 1> is declared; ignored off locked.
    prev_closing: one sentence of what the preceding segment ended on (action
      and/or its final spoken line), stated with the chain declaration so the
      continuation actually continues instead of restarting the moment.
    audio_refs: [{slot (1-based audio number), kind, name, …}] — staged
      reference AUDIO files, numbered independently of pictures (official
      §2.5). Three kinds:
        voice      — a voice-timbre reference for the named cast member: the
                     speaker keeps that timbre, the signal is never copied.
        line       — the named cast member's spoken line, ALREADY PERFORMED
                     (ElevenLabs v3): {text, shot_idx, order}. partially_copy —
                     placed on the timeline verbatim, lips synced to it, all
                     other sound generated around it. Measured (block-5 A/B):
                     100% coverage where the native path failed three times.
        exchange   — ONE recorded conversation (text-to-dialogue) holding
                     every line of the segment in order:
                     {lines: [{speaker, line, shot_idx, order, at_ms}],
                      start: {shot_idx, at_ms}} — at_ms are measured
                     shot-relative placements, start says where the clip
                     itself begins. Same partially_copy contract; each
                     speaker's lips sync to their OWN lines only.
    cast entries may carry `voice` (pitch/timbre/pace prose) — woven in at the
      speaker's first vocal appearance per official §4.4 — and `singer` (bool)
      for locked-audio lip-sync preference.

    mode: the H3 mode this block renders as. <Subject N>/<Picture N> is Ref2VA
      syntax — the FL2VA modes (i2v/flf/t2v) have no reference set to number,
      so emitting those tags there is addressing pictures that were never
      supplied. Non-r2v modes get the same content as plain prose plus the
      FL2VA alignment sentence for whichever frames were handed over.
    """
    if not beats:
        raise CompileError("block has no beats")

    # Numbers are rewritten ONCE, here, so every downstream use — the shot
    # lines, the locked-audio clauses and the summary — says the same thing.
    # Copies, never mutation: `beats` belongs to the caller and the same rows
    # feed the ElevenLabs path, which does not need this.
    beats = [{**b, "dialogue": [{**d, "line": speakable(d.get("line") or "")}
                                for d in (b.get("dialogue") or [])]}
             for b in beats]

    # ---- who actually appears (beat-level cast, S-ids in cast order) --------
    present: list = []
    for c in cast:
        shots = [i + 1 for i, b in enumerate(beats)
                 if c["name"] in (b.get("cast_names") or [])]
        if shots:
            present.append({**c, "shots": shots})
    # Fallback: nothing tagged (legacy rows) — treat every cast member as
    # present everywhere rather than dropping identity anchors.
    if not present and cast:
        present = [{**c, "shots": list(range(1, len(beats) + 1))} for c in cast]
    speaker_ids = {c["name"]: f"S{i + 1}" for i, c in enumerate(present)}
    locked = audio_mode == "locked"
    if locked and locked_kind == "dialogue":
        # ON A LOCKED TRACK THE S-IDS DESCRIBE VOICES THAT ALREADY EXIST.
        # Native H3 invents the voices, so cast order is as good a labelling
        # as any — the ids merely have to be distinct. A dialogue spine is the
        # opposite: <Audio 1> is ground truth, the model has to DIARIZE it,
        # and the natural index over a recording is order of first appearance.
        # Cast order disagreed with it whenever the second-listed character
        # spoke first (THE LATE SHIFT b1: Priya speaks at 3.2s and was S2,
        # Dennis at 6.1s and was S1), which hands the model a labelling it
        # cannot reconcile with what it hears. Number speakers by the order
        # their first line lands in THIS segment; non-speakers keep their
        # sheets and take the remaining ids.
        order, seen = [], set()
        for b in beats:
            for d in (b.get("dialogue") or []):
                nm = (d.get("speaker") or "").split(" — ")[0].strip()
                if nm and nm not in seen:
                    seen.add(nm)
                    order.append(nm)
        for c in present:
            if c["name"] not in seen:
                order.append(c["name"])
        speaker_ids = {nm: f"S{i + 1}" for i, nm in enumerate(order)
                       if any(c["name"] == nm for c in present) or nm in seen}
    # EVERY voice gets its OWN id, present or not. The map above is built
    # from `present`, so a speaker with no staged body — a phone caller, a
    # fully off-screen V.O. — was absent from it, and the dialogue loop's
    # `sid or 'S1'` fallback then labelled their lines with the FIRST
    # on-screen character's id: two voices, one label, which the model reads
    # as one person speaking both. Fresh ids append after the cast's (the
    # official grammar's own rule for a voice with no defined subject: a
    # stable description plus its own Sx). The locked-dialogue branch already
    # numbers every speaker, so this is a no-op there.
    nxt = len(speaker_ids)
    for b in beats:
        for d in (b.get("dialogue") or []):
            raw = str(d.get("speaker") or "").strip()
            if raw and raw not in speaker_ids \
                    and raw.split(" — ")[0].strip() not in speaker_ids:
                nxt += 1
                speaker_ids[raw] = f"S{nxt}"
    # Who actually SPEAKS in this segment — the multishot pack's measured
    # per-subject asymmetry ("verified blind across a full chain, no
    # cross-speaker bleed"): with several subjects declared, the ones that own
    # lines are declared as speaking and everyone else merely appears, so each
    # voice claim has its own anchor instead of competing for one audio lane.
    # Affirmative on both sides — at cfg 1.0 negations get rendered.
    speaks = {(d.get("speaker") or "").split(" — ")[0].strip()
              for b in beats for d in (b.get("dialogue") or [])}
    speaks.discard("")

    # ---- subject_definitions ------------------------------------------------
    # r2v numbers its inputs (<Picture 1>, <Subject 1>) because Ref2VA is given
    # a set to address. FL2VA is not, so on those modes the same declarations
    # go out as prose and the frames are described by position instead.
    tagged = mode == "r2v"

    def _subj(n, name):
        """How to name a subject where the tag alone reads fine (summary,
        retention). The body and dialogue want the tag AND the name, so they
        build their own."""
        return f"<Subject {n}>" if tagged else name

    defs = []
    chain = next((r for r in ref_slots
                  if r.get("kind") in ("chain", "start_frame")), None)
    # r2v belongs here as much as i2v does, and its absence was silent. A
    # storyboard scene renders as a run of CHAINED r2v blocks — `chain_from_block_id`
    # is set on every one after the first — but r2v carries no opening frame, so
    # neither branch above fired and the continuation sentence below was compiled
    # for nobody. Measured on AFTERLIGHT's OBSERVATORY: blocks 18 and 19 are
    # chained, `mentions_prev` false in both, and the reviewer's complaint about
    # them was GEOGRAPHY_BREAK — characters restaged from scratch because nothing
    # told the model the segment had a past. Per-shot positions are compiled
    # (the blocking pass writes them); what was missing is that the shot CONTINUES.
    continuing = bool(chain and chain.get("kind") == "chain") or \
        (mode in ("i2v", "r2v") and bool(prev_closing))
    if tagged and chain and chain.get("kind") == "start_frame":
        defs.append(
            f"<Picture {chain['slot']}> is the first frame of [Shot 1]: "
            f"the target video opens on this exact image.")
    elif tagged and chain:
        defs.append(
            f"<Picture {chain['slot']}> is the first frame of [Shot 1], "
            f"the exact final frame of the preceding segment of this video.")
    elif mode == "i2v":
        defs.append("The supplied image is the first frame of [Shot 1]: the target video "
                    "opens on this exact image and continues from it.")
    # A reference VIDEO is the vendor's own continuation channel (ref mode:
    # cite <Video N> "where its source state, structure, or continuation
    # relationship applies"), and ref2va takes three of them. Videos number
    # independently of pictures and audios, exactly as §2.5 says of audio.
    # Phrased entirely in the positive: "begins after its final frame" rather
    # than "does not replay it" — a prohibition is the shape that produced two
    # signs when one was asked for.
    for v in (video_refs or []):
        defs.append(
            f"<Video {v['slot']}> is the preceding segment of this same video, "
            f"ending on the exact moment this segment continues from. Take from "
            f"it the geography of the space, where each subject stands and which "
            f"way they face, and the lighting; the target video begins after its "
            f"final frame and carries that arrangement forward.")
    if continuing and prev_closing:
        defs.append(f"The preceding segment ended as {_clause(prev_closing)}; "
                    f"the target video continues FROM that completed moment — the "
                    f"actions already performed there are finished and are not "
                    f"repeated or re-enacted.")
        # The dialogue twin of the line above. Without it a continuation
        # re-performs its predecessor's closing line (in whichever mouth is
        # handy) and its own lines get squeezed past the cut — measured live
        # as the block 8→9 echo cascade.
        if audio_mode != "locked":
            first_dlg = next(((i + 1, b["dialogue"][0]) for i, b in enumerate(beats)
                              if b.get("dialogue")), None)
            if first_dlg:
                k, d0 = first_dlg
                who0 = (d0.get("speaker") or "the first speaker").split(" — ")[0].strip()
                defs.append(f"No words spoken in the preceding segment are spoken "
                            f"again in this one; the first dialogue in this segment "
                            f"is {who0}'s line in [Shot {k}].")
            else:
                defs.append("No words spoken in the preceding segment are spoken "
                            "again in this one; no dialogue from before carries over.")
    elif mode == "flf":
        defs.append("The first supplied image is the first frame of [Shot 1] and the second is "
                    "the final frame of the segment: the target video opens on the first exactly "
                    "and arrives at the second exactly.")
    subj_no = {}
    n = 0
    for c in present:
        n += 1
        subj_no[c["name"]] = n
        pics = [r for r in ref_slots
                if r.get("kind") == "character" and r.get("name") == c["name"]]
        src = " and ".join(f"<Picture {p['slot']}>" for p in pics)
        src_txt = f", shown in {src}" if src and tagged else ""
        lead = f"<Subject {n}> is {c['name']}" if tagged else c["name"]
        # The speak/appear clause only exists when there is an asymmetry to
        # state: a lone subject, or a segment where everyone or no one talks,
        # keeps the historical byte-identical line.
        speak_txt = ""
        if len(present) > 1 and speaks and any(p["name"] in speaks for p in present) \
                and not all(p["name"] in speaks for p in present):
            speak_txt = (", speaking in this segment" if c["name"] in speaks
                         else ", who appears in this segment")
        defs.append(f"{lead}{src_txt}{speak_txt}: "
                    f"{_sentence(c.get('identity_line') or c['name'])}")
    env_subj = None
    # Initialised OUT here because the terminal no-grid close reads it and runs
    # for every block, environment or not — born inside the branch below it is
    # a NameError on the commonest path there is.
    env_sheet = None
    env_pic = next((r for r in ref_slots if r.get("kind") == "environment"), None)
    if environment is not None:
        n += 1
        env_subj = n
        env_line = _clause(environment.get("identity_line")
                           or environment.get("summary") or environment.get("name", ""))
        env_sheet = env_pic if (env_pic or {}).get("role") == "coverage" else None
        src_txt = (f", shown across <Picture {env_pic['slot']}>"
                   if env_sheet else f", shown in <Picture {env_pic['slot']}>") \
            if env_pic and tagged else ""
        pal = f"; its palette of {environment['palette']} is retained" \
            if environment.get("palette") else ""
        # The writer's background_life is what keeps a location from playing
        # as an empty backdrop: it rides the environment's definition so every
        # shot inherits the same inhabitation.
        bg = _clause(environment.get("background_life") or "")
        bg_txt = f" Background life of the space, present in every shot: {bg}." if bg else ""
        lead = (f"<Subject {n}> is the {environment.get('name', 'environment')} environment"
                if tagged else f"The {environment.get('name', 'environment')} environment")
        defs.append(f"{lead}{src_txt}: {env_line}{pal}.{bg_txt}")
        # THE ENVIRONMENT'S PICTURE CAN BE A CONTACT SHEET, and then it is a
        # picture OF A GRID — which H3 obeys over a sentence, exactly as it
        # does with a segment storyboard. Left undeclared, the one slot that
        # says what the place looks like tells the model to render panels.
        #
        # So the same grammar the `block_sheet` definition uses is applied
        # here, with the one difference that matters: a storyboard's panels are
        # a SHOT ORDER and these are VANTAGES ON ONE SPACE, simultaneous rather
        # than sequential. Saying "read each panel as a shot beat" about a
        # coverage sheet would turn a location reference into an eight-cut
        # edit nobody planned.
        if env_sheet and tagged:
            k = int(env_sheet.get("views") or 0)
            count = f"{_count_word(k)}-view " if k else ""
            order = (" read left-to-right then top-to-bottom,"
                     if env_sheet.get("columns") else "")
            defs.append(
                f"<Picture {env_sheet['slot']}> is the complete {count}coverage "
                f"sheet for that environment,{order} each panel the same single "
                f"place photographed from a different camera placement. Take "
                f"its architecture, materials, fixtures, dressing, palette and "
                f"light from every panel together, and treat the panels as "
                f"views of ONE continuous space rather than as separate "
                f"locations or as one composite image. They are not a shot "
                f"order and not a sequence of cuts.")
    for r in ref_slots:
        if r.get("kind") not in ("scene_ref", "look", "block_sheet"):
            continue
        target = _shots_list(r.get("shot_idxs") or [1])
        desc = _clause(r.get("desc") or r.get("name") or "the intended look")
        if r.get("kind") == "block_sheet":
            # THE ONE PICTURE THAT IS THE WHOLE SEGMENT. A `scene_ref` panel is
            # bound to one shot; this is bound to the shot ORDER, and the
            # sentence that makes it work is the last one — without it H3 reads
            # a grid as a composition to reproduce and renders a video of a
            # storyboard. It is the vendor's own grammar for a contact sheet
            # (amao2001's r2v storyboard workflow, whose sheet definition is
            # "Treat each panel as a separate chronological shot beat, not as
            # one composite image").
            k = int(r.get("panels") or len(r.get("shot_idxs") or []) or 1)
            defs.append(
                f"<Picture {r['slot']}> is the complete {_count_word(k)}-panel "
                f"storyboard for this segment, numbered 1 to {k}, read "
                f"left-to-right then top-to-bottom. It is the shot-order, "
                f"composition, camera-height, staging, action, character, "
                f"costume, location and lighting reference for the whole "
                f"segment. Treat each numbered panel as a separate "
                f"chronological shot beat, not as one composite image: the "
                f"target video is those {_count_word(k)} shots played in "
                f"order, and is never a grid.")
        elif r.get("kind") == "look":
            # Say the negative explicitly. Without it H3 reads any scene image
            # as something to reproduce, and a VFX plate's framing quietly
            # replaces the shot that was actually planned.
            kindword = "an effect reference" if r.get("role") == "vfx" else "a look reference"
            defs.append(f"<Picture {r['slot']}> is {kindword} for {target}, "
                        f"defining {desc}. It supplies rendering only — its framing, "
                        f"camera angle and the placement of anything in it are not copied.")
        else:
            defs.append(f"<Picture {r['slot']}> is a storyboard reference for {target}, "
                        f"defining {desc}; its framing is intended.")
    # Character AND prop sheets are shot on a studio grey — and H3 obeys
    # pictures over prose, so without the disclaimer the backdrop leaks into
    # scenes as a bare grey void behind the cast (live E2 did exactly this,
    # and it recurred "sometimes" with the disclaimer stated only once in
    # defs — it is now also a retention entry naming the exact pictures,
    # because retention is the channel H3 weighs for what to carry over).
    grey_slots = [r["slot"] for r in ref_slots
                  if r.get("kind") == "character" or r.get("role") == "prop"]
    if tagged and grey_slots:
        pics = ", ".join(f"<Picture {s}>" for s in grey_slots)
        env_name = (environment or {}).get("name")
        defs.append(f"The plain grey studio backdrop visible in the reference "
                    f"sheets ({pics}) is a reference-sheet artifact: it never "
                    f"appears in the target video. Every shot takes place inside "
                    f"the declared environment"
                    + (f" — the {env_name}" if env_name else "") + ".")
    if locked:
        defs.append("<Audio 1> is the segment's complete recorded audio track: "
                    "every spoken line of this segment, performed and placed at "
                    "its true time." if locked_kind == "dialogue" else
                    "<Audio 1> is the supplied master music track for this segment.")
    # Voice-timbre references (official §2.4): the speaker keeps the reference
    # audio's timbre; the signal itself is never copied into the target.
    # Line references are the stronger form: the recorded performance itself,
    # placed verbatim (partially_copy) with everything else generated around it.
    voice_refs = []
    line_refs = []
    _ord = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
            6: "sixth", 7: "seventh", 8: "eighth"}
    # Which line numbers are V.O. cutaways, in the SAME numbering the vocal
    # loop uses (nth dialogue entry across the block's beats). The audio-ref
    # declarations and bindings below are subject-gated — and a fully
    # off-screen speaker is deliberately NOT a subject, so without this set
    # their staged recording would play undeclared and unbound while the
    # native `says:` branch re-performs the words: the FMT-12
    # double-performance, back again from the other end.
    offscreen_orders = set()
    _n = 0
    for b in beats:
        for d in (b.get("dialogue") or []):
            _n += 1
            if d.get("offscreen"):
                offscreen_orders.add(_n)
    if tagged:
        for a in (audio_refs or []):
            if a.get("kind") == "exchange":
                # One clip, many speakers: keep it when anyone in it is
                # present; lines of absent speakers stay unbound (the audio
                # still plays; nobody on screen is told to mouth them) —
                # EXCEPT a line marked offscreen, which binds as V.O.: its
                # speaker is deliberately absent, and leaving it unbound
                # would have the native branch re-perform words the clip
                # already carries.
                xl = [l for l in (a.get("lines") or [])
                      if subj_no.get(l.get("speaker"))
                      or l.get("order") in offscreen_orders]
                if not xl:
                    continue
                line_refs.append(a)
                names = list(dict.fromkeys(l["speaker"] for l in xl))

                def _who_bit(nm):
                    if subj_no.get(nm):
                        return f"<Subject {subj_no[nm]}> ({nm}) ({speaker_ids[nm]})"
                    sid_ = speaker_ids.get(nm)
                    return f"{nm} ({sid_})" if sid_ else str(nm)
                who_list = ", ".join(_who_bit(nm) for nm in names)
                listed = "; ".join(
                    f"{l['speaker']} ({speaker_ids.get(l['speaker'], 'S1')}) in "
                    f"[Shot {l.get('shot_idx', 1)}]: \"{_clause(l.get('line') or '')}\""
                    for l in xl)
                defs.append(
                    f"<Audio {a['slot']}> is the recorded conversation between "
                    f"{who_list} — every spoken line of this segment, in order, "
                    f"exactly as performed: {listed}.")
                continue
            n = subj_no.get(a.get("name") or a.get("speaker"))
            sid = speaker_ids.get(a.get("name") or a.get("speaker"))
            if (a.get("kind") == "line" and not n and sid
                    and a.get("order") in offscreen_orders):
                # A per-line clip for a fully off-screen speaker: no subject
                # to hang it on, and the voice is real — skipping it (the old
                # rule) leaves a staged recording the envelope never declares,
                # and the native branch then re-performs the words over it.
                line_refs.append(a)
                who = a.get("name") or a.get("speaker")
                defs.append(
                    f"<Audio {a['slot']}> is {who}'s ({sid}) spoken line "
                    f"\"{_clause(a.get('text') or '')}\" — the "
                    f"{_ord.get(a.get('order', 1), 'next')} line of dialogue, "
                    f"heard as an off-screen voice in [Shot {a.get('shot_idx', 1)}].")
                continue
            if not n or not sid:
                continue            # not present or never speaks in this block
            who = a.get("name") or a.get("speaker")
            if a.get("kind") == "line":
                line_refs.append(a)
                where = ("heard as an off-screen voice in"
                         if a.get("order") in offscreen_orders else "spoken in")
                defs.append(
                    f"<Audio {a['slot']}> is <Subject {n}>'s ({who}) ({sid}) "
                    f"spoken line \"{_clause(a.get('text') or '')}\" — the "
                    f"{_ord.get(a.get('order', 1), 'next')} line of dialogue, "
                    f"{where} [Shot {a.get('shot_idx', 1)}].")
            elif a.get("kind") == "voice":
                voice_refs.append(a)
                # Affirmative ownership, no exclusivity prohibition. The old
                # wording ended "…never to any other speaker", and the
                # multishot pack measured exactly that shape backfiring at
                # cfg 1.0 ("is never blended with <Subject 1>" CAUSED the
                # blending — negations get rendered). Their verified
                # no-cross-speaker-bleed recipe is one plain possessive claim
                # per anchor, which is what this now is.
                defs.append(f"<Audio {a['slot']}> is a recording of "
                            f"<Subject {n}>'s ({who}) ({sid}) speaking voice.")

    # ---- summary ------------------------------------------------------------
    tasks = []
    opens_on_frame = bool(chain) or mode in ("i2v", "flf")
    if opens_on_frame:
        tasks.append("keyframe completion")
    if tagged and (present or env_pic
                   or any(r.get("kind") in ("scene_ref", "look") for r in ref_slots)):
        tasks.append("reference generation")
    if not tasks and mode == "t2v":
        tasks.append("text to video")
    if locked:
        tasks.append("audio reuse")
    style_word = STYLE_OPENING.get((style or "").lower(), style or "cinematic")
    label = MEDIUM_LABEL.get(medium, "video")
    first_act = _clause(beats[0].get("action"))
    last_act = _clause(beats[-1].get("action"))
    subj_list = ", ".join(_subj(subj_no[c["name"]], c["name"]) for c in present) or "the scene"
    def _lc(t):  # lowercase the leading article/verb, never a name
        return (t[0].lower() + t[1:]) if t[:2].istitle() is False and t and t[0].isupper() and t.split(" ")[0] not in {c["name"] for c in cast} else t
    summary = (f"[{' + '.join(tasks) if tasks else 'reference generation'}] "
               f"The target video is one continuous segment of a {style_word} {label} "
               f"featuring {subj_list}. It opens as {_lc(first_act[:160]) if first_act else 'the segment begins'} "
               f"and ends as {_lc(last_act[:160]) if last_act else 'the segment closes'}.")
    if chain:
        summary += " The segment begins from <Picture 1>."
    elif mode == "i2v":
        summary += " The segment begins from the supplied image."
    elif mode == "flf":
        summary += " The segment begins from the first supplied image and ends on the second."
    if locked:
        summary += " <Audio 1> is reused as the complete final audio track."

    # ---- retention_analysis -------------------------------------------------
    ret = []
    if chain:
        origin = ("the supplied opening image" if chain.get("kind") == "start_frame"
                  else "the preceding segment's final frame")
        ret.append(f"<Picture {chain['slot']}> ([Shot 1] first frame): fully_preserved - "
                   f"the segment opens on {origin} exactly, composition and lighting.")
    elif mode in ("i2v", "flf"):
        ret.append("The supplied first frame ([Shot 1] first frame): fully_preserved - the "
                   "segment opens on it exactly, composition and lighting.")
        if mode == "flf" and has_end_frame:
            ret.append("The supplied final frame (last frame of the segment): fully_preserved - "
                       "the segment arrives at it exactly.")
    for c in present:
        ret.append(f"{_subj(subj_no[c['name']], c['name'])} (appears in {_shots_list(c['shots'])}): "
                   f"fully_preserved - {c['name']}'s face, hair, outfit and accessories "
                   f"are retained exactly in every appearance.")
    # The backdrop exclusion restated as retention (same channel that names
    # what IS carried over — one defs sentence alone still leaked grey
    # "sometimes"): the sheets are partially preserved, subject yes, ground no.
    if tagged and grey_slots:
        pics = ", ".join(f"<Picture {s}>" for s in grey_slots)
        ret.append(f"{pics} (reference sheets): partially_preserved - the "
                   f"subjects are taken exactly; the plain grey studio backdrop "
                   f"behind them is a sheet artifact and appears in no shot of "
                   f"the target video.")
    if env_subj is not None:
        who = f"<Subject {env_subj}>" if tagged else (environment or {}).get("name", "The environment")
        ret.append(f"{who} (the environment): fully_preserved - "
                   f"its layout, materials and lighting logic are retained.")
        # Restated in the channel H3 WEIGHS for what carries over — the same
        # belt-and-braces the grey studio backdrop needed, and for the same
        # measured reason: one defs sentence alone still leaked the artifact
        # "sometimes".
        if env_sheet and tagged:
            ret.append(f"<Picture {env_sheet['slot']}> (coverage sheet): "
                       f"partially_preserved - the place's own surfaces, "
                       f"materials and light are taken exactly; its grid "
                       f"layout, panel borders and gutters are a sheet "
                       f"artifact and appear in no shot of the target video.")
    for r in ref_slots:
        if r.get("kind") not in ("scene_ref", "look", "block_sheet"):
            continue
        shots = _shots_list(r.get("shot_idxs") or [1])
        if r.get("kind") == "block_sheet":
            # fully_preserved, where a single-shot panel is only
            # partially_preserved — and the difference is deliberate. A panel
            # offers ONE composition and its colour is allowed to defer to the
            # scene; a sheet is the only thing carrying the segment's shot
            # ORDER and its internal consistency IS the artifact (one grade,
            # one location, one style across every panel, measured 22x tighter
            # in hue than the same shots drawn separately). Telling H3 its
            # rendering may drift would throw away the property it was made
            # for. Retention is the channel H3 weighs hardest.
            k = int(r.get("panels") or len(r.get("shot_idxs") or []) or 1)
            ret.append(
                f"<Picture {r['slot']}> (the segment's storyboard): "
                f"fully_preserved - retain its {_count_word(k)}-stage shot "
                f"order, its changes in camera height and distance, the "
                f"staging and placement of the subjects in each frame, its "
                f"palette and its rendering style. The location, the weather "
                f"and the time of day do not change between its panels and "
                f"must not change between the shots of the target video.")
        elif r.get("kind") == "look":
            ret.append(f"<Picture {r['slot']}> ({shots} "
                       f"{'effect' if r.get('role') == 'vfx' else 'look'} reference): "
                       f"partially_preserved - its color, light behavior, material and "
                       f"texture are followed; its framing, camera angle and subject "
                       f"placement are not.")
        else:
            # "the effect's color…" was copy-paste from the look/vfx branch
            # above: a storyboard panel contains no "effect", so the rule named
            # a referent that appears nowhere else in the prompt. Retention is
            # the channel H3 weighs hardest for what to carry over, so the one
            # entry that should have been saying "match this composition" was
            # spending itself on a noun with no antecedent.
            ret.append(f"<Picture {r['slot']}> ({shots} storyboard reference): "
                       f"partially_preserved - its composition, staging and the "
                       f"placement of subjects in frame are followed; its color and "
                       f"rendering defer to the scene.")
    if locked:
        ret.append("<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the target "
                   "video's complete final audio track.")
    for a in voice_refs:
        # Affirmative form (the "…is not copied" tail measured as the negation
        # trap at cfg 1.0); "references the voice timbre … speaks with the
        # same voice" is the multishot pack's verified per-voice binding.
        ret.append(f"<Audio {a['slot']}>: reference - the target audio references "
                   f"the voice timbre in <Audio {a['slot']}> so {a['name']} speaks "
                   f"with the same voice.")
    for a in line_refs:
        if a.get("kind") == "exchange":
            start = a.get("start") or {}
            where = (f", beginning about {start['at_ms'] / 1000:.1f} seconds "
                     f"into [Shot {start.get('shot_idx', 1)}]"
                     if start.get("at_ms") is not None else "")
            ret.append(f"<Audio {a['slot']}>: partially_copy - <Audio {a['slot']}> "
                       f"is placed on the target video's timeline verbatim"
                       f"{where}: it is the segment's complete spoken dialogue, "
                       f"exactly as recorded, and no line of it is re-performed. "
                       f"Ambience, movement and all other sound are generated "
                       f"around it. Each speaker's lips are precisely synced to "
                       f"their own lines within it, and to no one else's.")
            continue
        who = a.get("name") or a.get("speaker")
        ret.append(f"<Audio {a['slot']}>: partially_copy - <Audio {a['slot']}> "
                   f"is placed on the target video's timeline verbatim as "
                   f"{who}'s spoken dialogue in [Shot {a.get('shot_idx', 1)}], "
                   f"exactly as recorded; ambience, movement and all other "
                   f"sound are generated around it, and {who}'s lips are "
                   f"precisely synced to it.")

    # ---- detailed_description ----------------------------------------------
    # Official §4.4: a speaker's first vocal event establishes a stable voice
    # identity (pitch, timbre, pace). The writer's voice descriptor is woven in
    # exactly once per block — this is what keeps a character's voice the same
    # across every chained segment.
    voice_of = {c["name"]: _clause(c.get("voice") or "") for c in present}
    announced: set = set()
    # nth-dialogue-line-in-block -> staged line-ref audio slot, so the vocal
    # clause can bind performance to the placed recording instead of asking
    # for a second one.
    line_slot = {}
    line_at = {}
    line_dur = {}
    for a in line_refs:
        if a.get("kind") == "line" and a.get("order"):
            line_slot[a["order"]] = a["slot"]
            if a.get("at_ms") is not None:
                line_at[a["order"]] = a["at_ms"]
            if a.get("dur_ms"):
                line_dur[a["order"]] = a["dur_ms"]
        elif a.get("kind") == "exchange":
            for l in (a.get("lines") or []):
                if l.get("order") and (subj_no.get(l.get("speaker"))
                                       or l["order"] in offscreen_orders):
                    line_slot[l["order"]] = a["slot"]
                    if l.get("at_ms") is not None:
                        line_at[l["order"]] = l["at_ms"]
    dlg_no = 0

    def vocal_who(name):
        sn_ = subj_no.get(name)
        first = name not in announced and bool(voice_of.get(name))
        announced.add(name)
        vtxt = voice_of.get(name, "")
        if sn_ and tagged:
            return (f"<Subject {sn_}> ({name}, {vtxt})" if first
                    else f"<Subject {sn_}> ({name})")
        base = name or "The speaker"
        return f"{base}, with {vtxt}," if first else base

    pal = f", with a palette of {environment['palette']}" \
        if environment and environment.get("palette") else ""
    # Time of day is stated once, up front, and holds for the whole segment.
    # It was never compiled before, and H3 defaulted a night platform to
    # overcast daylight — flipping day/night between blocks of one scene.
    when = f" The entire segment takes place at {_clause(scene_time)}; the light never changes to another time of day." \
        if scene_time else ""
    # One design grammar for every impossible effect, stated once up front —
    # without it each block invents its own magic and the same spell renders
    # three different colors across a scene.
    fx = f" Every magical or energy effect in the segment follows one design language: {_clause(vfx_language)}." \
        if vfx_language else ""
    # Equipment discipline: name the designed objects, and in action scenes
    # close the set — H3 conjures shields and second weapons the moment fight
    # prose implies a need for one (measured live: two combatants spawned
    # shields no bible, prompt or storyboard ever mentioned).
    gear = ""
    if props:
        listing = "; ".join(
            p["name"] + (f" ({_clause(p['look'])})" if p.get("look") else "")
            for p in props if p.get("name"))
        if listing:
            gear = f" The story's designed hand props in this segment: {listing}."
    if (scene_type or "").lower() == "action":
        gear += (" No weapon, shield, armor piece or handheld device beyond "
                 "those named in this description appears in any shot — nobody "
                 "produces new equipment mid-action.")
    body = [f"The target video is in a {style_word} {label} style{pal}.{when}{fx}{gear}"]
    # A staged segment storyboard is bound SHOT BY SHOT, not just declared once
    # in the definitions. `<Picture N>` holds every shot of the block, so the
    # only thing that says which panel is which shot is this sentence — without
    # it the sheet is a mood board and H3 picks whichever panel it likes for
    # the opening. Shot 1 gets "opens exactly on", the rest "cuts to", which is
    # the vendor's own storyboard phrasing.
    sheet = next((r for r in ref_slots if r.get("kind") == "block_sheet"), None)
    for i, b in enumerate(beats):
        at = "" if i == 0 else f" At {_ts(b['start_ms'] + warmup_ms)}, the shot cuts."
        if sheet:
            at = (f" The target video opens exactly on panel 1 of "
                  f"<Picture {sheet['slot']}>." if i == 0 else
                  f" At {_ts(b['start_ms'] + warmup_ms)}, the shot cuts to "
                  f"panel {i + 1} of <Picture {sheet['slot']}>.")
        # Subject labels: first clear appearance carries the identity line,
        # later appearances reuse `<Subject n> (Name)` (official §5.3). The
        # binding itself is `_bind_subject_names` - a cast of overlapping names
        # is the common case here, not a corner one.
        action = _bind_subject_names(_clause(b.get("action")), present, subj_no,
                                     i + 1, tagged=tagged)
        cam = _clause(b.get("camera"))
        line = f"[Shot {i + 1}]{at} {action}."
        # Spatial anchors, restated per shot: independent segment renders obey
        # the sentence in front of them, not the one two shots back.
        #
        # …but never for a voice on the far end of a phone. The Continuity
        # Director places every name it is given, and given a phone caller it
        # writes a BODY: measured on THE LAST SERVICE b0, `positions` read
        # `"Tam Reed": "at the phone in Mara Vale's hand, facing Mara Vale,
        # seated"`. Stated to H3 beside her staged character sheet, that is an
        # instruction to draw her — and it did, seated in the shop in b0 and
        # standing in the street in b1, in a film where she is only ever a
        # voice on a call. The staging side drops her sheet
        # (`ref_plan_for`); this drops the sentence that would have H3 invent
        # one anyway.
        remote = set(image_prompt.remote_speakers(
            f"{b.get('camera') or ''} {b.get('action') or ''}",
            list((b.get("positions") or {}).keys()),
            [(d or {}).get("speaker") for d in (b.get("dialogue") or [])]))
        # A deliberate V.O. cutaway is the same situation by choice: a line
        # marked `offscreen` means the camera is elsewhere while the voice
        # continues, so a position sentence for its speaker is an instruction
        # to draw them into the shot the DP just cut away from. Only a
        # speaker whose EVERY line here is marked, and whom the shot's own
        # prose does not put in frame (the action outranks the flag).
        remote |= set(image_prompt.offscreen_speakers(
            f"{b.get('camera') or ''} {b.get('action') or ''}",
            b.get("dialogue")))
        pos = {nm: p for nm, p in (b.get("positions") or {}).items()
               if nm not in remote}
        if pos:
            line += (" In this shot " + ", and ".join(
                f"{nm} is {_clause(p)}" for nm, p in pos.items()) + ".")
        line += (f" {cam[0].upper()}{cam[1:]}." if cam else "")

        if locked:
            line += _locked_audio_clause(
                b, i, present, subj_no, speaker_ids, lyrics, warmup_ms, lip_sync,
                vocal_who=vocal_who,
                verb="says" if locked_kind == "dialogue" else "sings")
        else:
            final_beat = i == len(beats) - 1
            for d in (b.get("dialogue") or []):
                sid = speaker_ids.get(d.get("speaker"))
                who = vocal_who(d.get("speaker") or "The speaker")
                deliv = _clause(d.get("delivery") or "")
                # "says quietly:" for adverbs, "says in a low whisper:" for phrases
                deliv_txt = (f" in {deliv}" if deliv.split(" ")[0] in ("a", "an", "the")
                             else (f" {deliv}" if deliv else ""))
                lang = d.get("language", "English")
                evt = _event_lead(d)
                # A line in the FINAL shot gets pinned to the front of it:
                # H3 places unanchored lines late, and a late line in the last
                # shot runs into the trim ("Sil. Ope—"). Stated per line, not
                # as a general note — the general note was already there and
                # was not enough.
                when = (", speaking immediately as the shot begins and completing "
                        "the line within the first half of the shot" if final_beat
                        else "")
                dlg_no += 1
                slot = line_slot.get(dlg_no)
                # A line marked `offscreen` is the cinematographer's V.O.
                # cutaway: the voice continues while the camera is on the
                # listener or an insert. The vendor's base-modes guide has
                # exact grammar for it — "says in an off-screen voiceover",
                # followed immediately by a statement that on-screen lips
                # remain closed — and until this branch the compiler could
                # only ever bind a line to an on-camera mouth, so the DP's
                # own "cut to the listener DURING a long line" rule was
                # unexpressible.
                offscreen = bool(d.get("offscreen"))
                if slot:
                    # A staged line ref: the performance already exists, so the
                    # vocal clause BINDS to it (the locked path's grammar) —
                    # stating "says:" beside "placed verbatim" made H3 perform
                    # the line AND place the recording (block 4's rerun spoke
                    # every line twice, measured live). The delivery adverb
                    # stays out: the recording carries the read. A measured
                    # offset says WHERE in the shot the line begins — computed
                    # from the recorded durations, never guessed.
                    at = line_at.get(dlg_no)
                    # A measured placement outranks the final-shot "speak
                    # immediately" nudge: the recording plays where the
                    # placement math put it (tail room already solved), and
                    # stating both gives H3 two contradictory clocks.
                    # …and where it ENDS. The offset alone under-anchors: on
                    # the reference path H3 starts a line late (measured +0.7
                    # to +1.3s past the stated offset on b6) and an unanchored
                    # tail is what runs into the block end — the recording's
                    # own length makes the finish a number instead of a hope.
                    dur = line_dur.get(dlg_no)
                    end_txt = (f" and finishing the complete line by about "
                               f"{(at + dur) / 1000:.1f} seconds, well before "
                               f"the shot ends"
                               if at is not None and dur else "")
                    at_txt = (f", beginning about {at / 1000:.1f} seconds into "
                              f"the shot{end_txt}" if at is not None else "")
                    if offscreen:
                        # No mouth to sync: the recording plays as V.O. The
                        # lips-closed clause replaces the listener guard — it
                        # is the vendor's own required follow-up, and it also
                        # covers the empty-cast insert, where a bare `says:`
                        # would invite H3 to invent the speaker.
                        line += (f" {who} ({sid or 'S1'}){evt} says in an "
                                 f"off-screen voiceover, the voice heard "
                                 f"exactly from <Audio {slot}>{at_txt}"
                                 f"{when if at is None else ''}: "
                                 f"<d>[{lang}] {_spoken(d)}</d>")
                        line += " " + image_prompt.offscreen_vo_clause(
                            _staged_others(b, subj_no))
                    else:
                        line += (f" {who} ({sid or 'S1'}){evt} speaks, precisely "
                                 f"lip-synced to <Audio {slot}>{at_txt}"
                                 f"{when if at is None else ''}: "
                                 f"<d>[{lang}] {_spoken(d)}</d>")
                        # The wrong-speaker guard: with a recording placed on
                        # the timeline, H3 sometimes syncs whichever mouth is
                        # largest in frame. Name the listeners as listeners,
                        # per line.
                        guard = image_prompt.listener_clause(
                            d.get("speaker"), _staged_others(b, subj_no))
                        if guard:
                            line += " " + guard
                elif offscreen:
                    # No recording staged (the loud fallback path) — H3
                    # performs the voice itself, still off-screen: the exact
                    # vendor phrase, delivery kept (there is no recording to
                    # carry the read), lips-closed clause required after.
                    line += (f" {who} ({sid or 'S1'}){evt} says in an off-screen "
                             f"voiceover{deliv_txt}{when}: "
                             f"<d>[{lang}] {_spoken(d)}</d>")
                    line += " " + image_prompt.offscreen_vo_clause(
                        _staged_others(b, subj_no))
                else:
                    line += (f" {who} ({sid or 'S1'}){evt} says{deliv_txt}{when}: "
                             f"<d>[{lang}] {_spoken(d)}</d>")
                    # The SAME guard, and its absence here was the gap: this is
                    # the branch H3 performs itself, reached whenever a line
                    # was not staged as audio — the documented loud fallback
                    # when `place_exchange` cannot fit a run, or ElevenLabs is
                    # down. A block with three faces and no recording had
                    # nothing telling H3 whose mouth to move.
                    guard = image_prompt.listener_clause(
                        d.get("speaker"), _staged_others(b, subj_no))
                    if guard:
                        line += " " + guard
        body.append(line)
    closing = "The final shot holds its composition steady through the last frame"
    if next_opening:
        closing += f", ending framed exactly on: {_clause(next_opening)} — the next segment opens on this composition"
    closing += "."
    if any(b.get("dialogue") for b in beats[-1:]) and not locked:
        # A line that starts late in the final shot gets its tail trimmed off
        # with the render padding. Say the timing requirement outright.
        closing += (" Every spoken line begins early enough in its shot to "
                    "finish completely, well before the segment ends.")
    body.append(closing)
    description = "\n".join(body)

    # CLOSE THE CAST, when every person this block names has a staged picture.
    #
    # `image_prompt` has done this for PANELS since the invented-extra artifact
    # was measured there, and the block compiler never did — so stills closed
    # their set and the VIDEO, where an extra moves and persists for the whole
    # segment, did not. Measured on THE LAST SERVICE: a two-hander in the watch
    # shop came back with TWO unnamed men standing in the foreground. H3 is the
    # family this file records as obeying terminal negations (the panel's "no
    # split screen, no lettering"), so the sentence works — it was simply
    # absent.
    #
    # Only when NOBODY was dropped, the same rule the panel builders follow: a
    # block whose slot budget evicted a cast member still has that person in
    # the action prose, and claiming a closed set there contradicts it. Remote
    # speakers are excluded from the claim rather than counted as missing —
    # a voice on a phone is not a person the shot failed to stage.
    named = set()
    for b in beats:
        roster = ((b.get("meta") or {}).get("cast") or [])
        remote = set(image_prompt.remote_speakers(
            f"{b.get('camera') or ''} {b.get('action') or ''}", roster,
            [(d or {}).get("speaker") for d in (b.get("dialogue") or [])]))
        # A V.O.-only speaker is a voice, not a person the shot failed to
        # stage — same treatment as a phone caller, or a beat whose roster
        # still carries them (an old storyboard, a hand edit) blocks the
        # close over someone deliberately out of frame.
        remote |= set(image_prompt.offscreen_speakers(
            f"{b.get('camera') or ''} {b.get('action') or ''}",
            b.get("dialogue")))
        named |= {n for n in roster if n not in remote}
    if named and named <= set(subj_no):
        description += ("\nThe only people anywhere in this segment are the "
                        "defined subjects — no other person, figure, silhouette "
                        "or passer-by appears in any shot.")

    # DISCLAIM THE SHEET'S OWN FURNITURE, terminally.
    #
    # The one real hazard of staging a contact sheet: it is a picture of a
    # grid, drawn with borders, white gutters and printed panel numbers, and
    # H3 obeys a picture over a sentence. Left unsaid it renders the grid —
    # a video OF a storyboard rather than the storyboard's shots. The
    # reference workflow this grammar comes from says exactly this ("No
    # storyboard grid, panel borders, numbers, split screen") and puts it at
    # the END, which is where this file already records H3 obeying a negation
    # (the panel prompt's "no split screen, no lettering", the cast close
    # above). Terminal and unconditional: it costs one sentence, and the
    # failure it prevents wastes a whole block render.
    # A staged COVERAGE sheet is the same hazard wearing a different hat: one
    # of the block's pictures is a grid, so the close has to fire whether the
    # grid arrived as the segment storyboard or as the location's plate.
    if sheet or env_sheet:
        description += (
            "\nThe target video is ordinary full-frame footage. No storyboard "
            "grid, no panel borders, no gutters, no printed panel numbers, no "
            "split screen, no multi-panel layout, no inset, no captions, no "
            "subtitles, no lettering and no watermark appear anywhere in any "
            "frame.")

    # A picked LoRA's trigger opens the description — where the adapters' own
    # authors put it ("begin the output with <token>, "), and checked against
    # the whole description so a writer who already used the word doesn't get
    # it twice.
    description = _trigger_prefix(lora_triggers, description) + description

    # ---- soundscape / music -------------------------------------------------
    if locked and locked_kind == "dialogue":
        # A dialogue spine is speech, not score: claiming it as "audience-only
        # music" would tell the model the words are non-diegetic. N/A is the
        # vendor's own no-score token.
        soundscape = ("<Audio 1> provides the complete final audio track: the "
                      "segment's spoken dialogue and the room tone beneath it.")
        music = "N/A"
    elif locked:
        soundscape = ("<Audio 1> provides the complete final audio track; no separate "
                      "ambience or sound effects are added on top.")
        music = "<Audio 1> is directly reused as the complete audience-only music."
    else:
        sfx = [s for s in (b.get("sfx") for b in beats) if s]
        if soundscape_hint:
            soundscape = _sentence(soundscape_hint)
        elif sfx:
            soundscape = _sentence("; ".join(dict.fromkeys(sfx))[:400])
        else:
            env_name = environment.get("name") if environment else None
            soundscape = _sentence(
                f"Natural ambience of {env_name}" if env_name else "Quiet natural room ambience")
        # A bare "N/A" passes through untouched — the vendor's own no-score
        # token, and what the ref-dialogue path sends: a score baked into one
        # block cannot be episode-consistent, so scoring happens at assembly
        # (`score_mix`), exactly as on the locked spine. `_sentence` would
        # ship "N/A." — punctuation on a token the model matches literally.
        music = ("N/A" if (music_hint or "").strip().upper() == "N/A"
                 else _sentence(music_hint) if music_hint else
                 "A restrained cinematic score at a moderate tempo that never dominates the scene.")

    return {
        "subject_definitions": "\n".join(defs),
        "summary": summary,
        "retention_analysis": "\n".join(ret),
        "description": description,
        "soundscape": soundscape,
        "music": music,
        "fmt_version": FMT_VERSION,
    }


def _lyrics_in_shot(beat, lyrics, warmup_ms):
    if not lyrics:
        return []
    b0 = beat["start_ms"] + warmup_ms
    b1 = b0 + beat["duration_ms"]
    return [l for l in lyrics if l["t0_ms"] < b1 and l["t1_ms"] > b0]

def _locked_audio_clause(beat, i, present, subj_no, speaker_ids, lyrics,
                         warmup_ms, lip_sync, vocal_who=None, verb="sings"):
    """Per-shot audio handling for a fully-copied audio track.

    `verb` is "sings" for the MV master track (the historical wording, kept
    byte-identical) and "says" for a dialogue spine — the official dialogue
    grammar's own verb, with the mouths-closed lines phrased affirmatively."""
    spoken = verb != "sings"
    explicit = beat.get("dialogue") or []
    in_window = _lyrics_in_shot(beat, lyrics, warmup_ms)
    who_of = vocal_who or (lambda nm: (f"<Subject {subj_no[nm]}> ({nm})"
                                       if subj_no.get(nm) else nm or "The performer"))
    if lip_sync:
        out = ""
        if explicit:
            for d in explicit:
                sid = speaker_ids.get(d.get("speaker"))
                who = who_of(d.get("speaker") or "The performer")
                lang = d.get("language", "English")
                # `at_ms` is the line's MEASURED start inside this shot (the
                # dialogue-spine retime writes it). Said only when the line
                # starts noticeably after the cut: after retiming most lines
                # begin at their own cut, and stamping "0.1s in" on those is
                # a second clock for H3 to reconcile against the first. FMT 18.
                at = d.get("at_ms")
                when = (f", beginning about {at / 1000:.1f}s into this shot"
                        if isinstance(at, (int, float)) and at >= 400 else "")
                evt = _event_lead(d)
                if d.get("offscreen"):
                    # The DP's V.O. cutaway on the locked path: the track
                    # carries the words either way, so the win here is
                    # diarization — the model is told outright that no
                    # on-screen mouth belongs to this line, instead of
                    # hunting for one (the frozen-grin failure mode).
                    out += (f" {who} ({sid or 'S1'}){evt} {verb} in an off-screen "
                            f"voiceover heard from <Audio 1>{when}: "
                            f"<d>[{lang}] {_spoken(d)}</d> No one on screen "
                            f"mouths this line; every visible mouth stays "
                            f"completely closed while it plays.")
                else:
                    out += (f" {who} ({sid or 'S1'}){evt} {verb}, precisely lip-synced to "
                            f"<Audio 1>{when}: <d>[{lang}] {_spoken(d)}</d>")
            if spoken:
                listeners = [nm for nm in (beat.get("cast_names") or [])
                             if subj_no.get(nm) and nm not in
                             {(d.get("speaker") or "").split(" — ")[0].strip()
                              for d in explicit}]
                if len(listeners) == 1:
                    out += (f" {listeners[0]} listens with their mouth closed, "
                            f"reacting to what is said.")
                elif listeners:
                    out += (f" {', '.join(listeners)} listen with mouths closed, "
                            f"reacting to what is said.")
        elif in_window and present and (beat.get("cast_names") or []):
            # Who performs the overlapping lyric, in order of authority:
            # the lyric's own named singer, then a singer-flagged cast member
            # of this beat, then the first present cast member (legacy). A
            # marked singer is why the wrong face stops mouthing the chorus.
            in_beat = [nm for nm in beat["cast_names"] if nm in subj_no]
            l = in_window[0]
            lyric_singer = next((nm for nm in in_beat
                                 if nm.lower() == str(l.get("singer") or "").lower()), None)
            flagged = next((c["name"] for c in present
                            if c.get("singer") and c["name"] in in_beat), None)
            name = lyric_singer or flagged or (in_beat[0] if in_beat else None)
            if name:
                out += (f" {who_of(name)} "
                        f"({speaker_ids[name]}) sings, precisely lip-synced to "
                        f"<Audio 1>: <d>[English] {l['text']}</d>")
                others = [nm for nm in in_beat if nm != name]
                if others:
                    out += (f" {', '.join(others)} do not sing; their mouths stay "
                            f"closed." if len(others) > 1 else
                            f" {others[0]} does not sing; their mouth stays closed.")
            else:
                out += (" Every mouth on screen stays closed during this shot."
                        if spoken else
                        " No one on screen sings during this shot; every mouth "
                        "stays closed.")
        else:
            out += (" Every mouth on screen stays closed during this shot."
                    if spoken else
                    " No one on screen sings during this shot; every mouth stays closed.")
        return out
    # lip_sync off — the documented no-new-speaker construction: the track is
    # the only vocal source, motion syncs to it, mouths never sing.
    if in_window:
        l = in_window[0]
        return (f" When <Audio 1> reaches the phrase <d>[English] {l['text']}</d>, "
                f"the action lands on that accent without anyone singing; every "
                f"mouth stays closed.")
    return " No vocals are performed on screen; every mouth stays closed."


def flf_alignment_line(duration_ms: int, *, first_shot: int = 1, last_shot: int | None = None) -> str:
    """Official FL2VA instruction line (must be the prompt's first line)."""
    sec = f"{duration_ms / 1000:.2f}"
    ls = last_shot or first_shot
    return (f"How the reference pictures align with the target video — "
            f"Picture 1 (from Shot {first_shot}) aligns with the 0.00-second mark "
            f"of the target video; Picture 2 (from Shot {ls}) aligns with the "
            f"{sec}-second mark of the target video.")


def compile_video_edit(instruction: str, *, n_ref_images: int = 0) -> dict:
    """The ref-mode envelope for a prompt-based VIDEO EDIT, compiled
    deterministically — invariant #6's shape applied to `handle_video_edit`.

    For its whole life that handler sent the user's sentence plus one appended
    declaration, i.e. bare prose — and the vendor's own full-reference guide
    (director/knowledge/h3_official_ref_mode.md, shipped verbatim) says an edit
    is a six-section rewrite whose summary opens `[video editing]` with `The
    target video is an edited version of <Video 1>.` and whose retention says
    what is preserved. The envelope is what NAMES the references — the same
    mechanism that made director-written panels beat panel prose 8/8 — so the
    edit instruction rides inside the format the model was trained to read,
    with everything not named declared held.

    Label numbering is the node's own presentation order (images first, then
    each soundtrack's <Audio j> immediately before its <Video k>): with
    `n_ref_images` pictures staged, the source is always <Video 1> and its
    soundtrack <Audio 1>, because it is the only video and the only audio.
    `audio reuse` is declared because the wiring always stages the source's
    soundtrack alongside its frames (VHS slot 2) — an edit keeps the take's
    own sound. The instruction itself is passed VERBATIM: this compiles the
    envelope around the user's words, it never rewrites them.
    """
    change = " ".join((instruction or "").split()).rstrip(".") or \
        "recreate the source video faithfully"
    defs = []
    for i in range(1, max(0, int(n_ref_images)) + 1):
        defs.append(f"<Picture {i}> is a reference image for the requested "
                    f"change; follow its rendering where the instruction "
                    f"names it, not its framing.")
    defs.append("<Video 1> is the source video for the target video edit.")
    defs.append("<Audio 1> is the synchronized audio track of <Video 1> and "
                "is reused in the target video.")
    return {
        "subject_definitions": "\n".join(defs),
        "summary": (f"[video editing + audio reuse] The target video is an "
                    f"edited version of <Video 1>. The one change: {change}."),
        "retention_analysis": (
            "<Video 1> is fully preserved — the same shots, framing, camera "
            "movement, subjects, actions, timing and pacing as the source — "
            "except where the requested change applies.\n"
            "<Audio 1> is directly reused as the target video's audio track."),
        "description": (
            f"The target video reproduces <Video 1> shot for shot: the same "
            f"composition, the same subjects in the same positions, the same "
            f"actions at the same timing, the same lighting and camera "
            f"movement. Exactly one change is applied: {change}. Everything "
            f"the change does not name matches <Video 1>."),
        "soundscape": ("Identical to <Audio 1> — the source video's own "
                       "soundtrack, reused unchanged."),
        "music": "N/A",
    }


# A `Picture N` the instruction names. Deliberately only the word the envelope
# itself emits: "image 2" and "reference 2" are things people write about the
# shot rather than about a slot, and a false positive here REFUSES a render
# that would have worked. The number is required for the same reason — "the
# picture she is holding" is prose, not a label.
_PICTURE_LABEL = re.compile(r"<?\s*\bpictures?\s*#?\s*(\d+)\s*>?", re.I)


def dangling_picture_refs(instruction: str, *, n_ref_images: int = 0) -> list:
    """The `Picture N` labels an instruction names that nothing will define.

    `compile_video_edit` defines `<Picture 1>`..`<Picture N>` for the images
    that were actually staged, and NAMING one is what binds the change to it —
    the same mechanism that made director-written panels beat panel prose. So
    the two failure modes are opposite and both silent: a staged picture the
    prompt never names is a picture the render ignores, and a name with no
    picture behind it is an instruction pointing at nothing. The second is the
    one measured in the wild: the modal's edit reference grid starts EMPTY and
    is session-local (it deliberately does not inherit the block's staged
    set), so "she should be holding the photo in Picture 1" with nothing added
    to that grid compiled an envelope with no `<Picture …>` definition at all
    and rendered the take back unchanged.

    Returned rather than raised so each caller can choose: the worker refuses
    (a render that cannot do what was asked is minutes of GPU time and a take
    nobody wanted), and the browser twin `danglingPictureRefs` in
    src/lib/retake.ts says so before the button is pressed. Keep the two in
    step — a refusal only the pod makes is one the user meets after waiting.
    """
    want = {int(m.group(1)) for m in _PICTURE_LABEL.finditer(instruction or "")}
    have = max(0, int(n_ref_images or 0))
    return sorted(n for n in want if n < 1 or n > have)


def full_prompt_text(compiled: dict) -> str:
    """The exact string handed to the H3 conditioning node's prompt input."""
    if compiled.get("subject_definitions") is not None:
        return (
            "subject_definitions:\n" + compiled["subject_definitions"] +
            "\n\nsummary:\n" + compiled["summary"] +
            "\n\nretention_analysis:\n" + compiled["retention_analysis"] +
            "\n\ndetailed_description:\n" + compiled["description"] +
            "\n\noverall_soundscape:\n" + compiled["soundscape"] +
            "\n\nnon_diegetic_music:\n" + compiled["music"]
        )
    return (
        "integrated_multimodal_description: " + compiled["description"] +
        "\n\noverall_soundscape: " + compiled["soundscape"] +
        "\n\nnon_diegetic_music: " + compiled["music"]
    )

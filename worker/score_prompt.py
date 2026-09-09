"""The film's SCORE, compiled — deterministic, from the composer's structure.

Invariant #6's shape, one media kind over: the LLM produces a structured score
plan (`storyplan.COMPOSER_CONTRACT`) and this module turns it into the caption
the model actually reads. Nothing here asks a model for the vendor format, and
nothing upstream writes one.

Why it exists at all. Until now an episode's score prompt was the WRITER's own
`music` field — one to three sentences of scene-setting prose ("a lonely piano
over city rain") — handed to Music 3 verbatim. That is a mood, not a record.
Music 3's own guide (`director/prompt_guides.js`) asks for three passes in a
fixed order — global metadata, vocal, arrangement — and names real instruments
and real production techniques as the thing that carries a record where mood
adjectives do not. A one-line mood satisfies none of it, so every score this
studio has generated for a film was a generic bed that happened to be in the
right key of sad.

Two shapes, because the two families want opposite ones and handing either the
other's is the exact failure a per-family guide exists to prevent: Music 3
reads a CAPTION (prose, three passes, tempo and key stated IN the text because
it has no typed inputs for them), ACE-Step reads TAGS (comma-separated,
strongest first, and tempo/key/time-signature deliberately absent because they
are typed controls on that encoder — writing "120 BPM" into the tag list is
how it becomes a lyric).

The one thing this module states that the composer never decides is that the
music is UNDERSCORE. That is structural — it is a score for a film, so it
plays beneath dialogue and has to leave room — and it is the single most
load-bearing sentence in the caption, which is why it is placed in the head
(the model reads the front hardest) and is exempt from the word cap, exactly
as `image_prompt`'s style clause is. A caption trimmed to its budget with the
underscore instruction amputated is a song again, and the failure is invisible
until the mix fights the dialogue.
"""

# `director/prompt_guides.js` targets ~110 words for a music rewrite. Past
# this a caption stops being read as description and starts being read as
# narrative.
MAX_WORDS = 110

# No single field may eat the budget. Measured on the first real composer
# artifact: a 32-word `arc` and a 30-word `production` consumed everything
# after the head, and the ARRANGEMENT — the instrument list — was dropped from
# the caption entirely. That is the one pass the guide singles out as
# load-bearing ("name real instruments … rather than mood adjectives"), so
# losing it to a verbose sentence is the underscore-clause failure one level
# down. The contract asks for "one sentence" per field; this is what makes
# that true when the model writes three.
MAX_FIELD_WORDS = 26

# An instrument is a NAME plus its technique, not a sentence. The guide's own
# example — "brushed drums, upright bass, Rhodes through a tape delay" — is
# 2-5 words each; the composer returned "felted upright piano, close-miked in
# the low register", which is eight.
MAX_INSTRUMENTS = 6
MAX_INSTRUMENT_WORDS = 5

# Words no instrument name ends on. Counting words alone cut "granular tape
# loop made from isolated piano-string resonance" to "granular tape loop made
# from", which is not the name of anything — and a caption full of dangling
# prepositions is one the model finishes for you.
_TRAILING = {"made", "from", "in", "with", "and", "of", "the", "a", "at",
             "on", "for", "to", "into", "through", "over", "under", "by",
             "played", "recorded", "using", "held", "set"}

# ACE-Step's guide asks for a much shorter list — two or three words a tag.
MAX_TAGS = 14

# What a film score IS, said in the model's own terms. Cap-exempt (see the
# module docstring); `listening scenario` is pass 1 of the Music 3 guide.
UNDERSCORE_CLAUSE = ("Film underscore: it plays beneath dialogue and never "
                     "competes with a voice, leaving the midrange open.")
UNDERSCORE_TAGS = ("film score", "underscore", "sparse midrange")


def _clean(v):
    """One line of prose, no trailing punctuation duplication."""
    s = " ".join(str(v or "").split())
    return s.rstrip(" .;,") if s else ""


def _sentence(s, cap=MAX_FIELD_WORDS):
    """One capped sentence. Trimmed at a CLAUSE boundary where there is one —
    a field cut mid-phrase reads as a typo, and the model completes it."""
    s = _clean(s)
    if not s:
        return ""
    words = s.split()
    if cap and len(words) > cap:
        head = " ".join(words[:cap])
        cut = max(head.rfind(","), head.rfind(";"), head.rfind(" — "))
        s = head[:cut] if cut > len(head) // 2 else head
        s = s.rstrip(" .,;—")
    return s[0].upper() + s[1:] + "."


def _names(v, limit=8):
    """A list field the model may have sent as a list OR as prose."""
    if isinstance(v, (list, tuple)):
        out = [_clean(x) for x in v]
    else:
        out = [_clean(x) for x in str(v or "").split(",")]
    return [x for x in out if x][:limit]


def _instrument(s):
    """One instrument, named — the HEAD CLAUSE, not the first N words.

    The composer writes "felted upright piano, close-miked in the low
    register": the name is everything before the comma and the rest is a
    performance note that belongs in `evolution`. Where there is no comma the
    words are capped and any dangling function word is dropped, so "granular
    tape loop made from isolated piano-string resonance" arrives as "granular
    tape loop" rather than as "granular tape loop made from".
    """
    head = _clean(str(s).split(",")[0])
    words = head.split()
    if len(words) > MAX_INSTRUMENT_WORDS:
        words = words[:MAX_INSTRUMENT_WORDS]
    while words and words[-1].lower() in _TRAILING:
        words.pop()
    return " ".join(words)


def _instruments(v):
    out, seen = [], set()
    for raw in _names(v, MAX_INSTRUMENTS * 2):
        name = _instrument(raw)
        k = name.lower()
        if name and k not in seen:
            seen.add(k)
            out.append(name)
    return out[:MAX_INSTRUMENTS]


def _bpm(v):
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return None
    return n if 30 <= n <= 220 else None


def _word_count(s):
    return len(s.split())


def _fit(head, tail_sentences, budget):
    """Assemble head + as many tail sentences as the budget allows.

    Drops WHOLE sentences from the end rather than truncating mid-clause: a
    caption ending "...brushed drums enter at the" is a caption the model
    finishes for you. The head is never trimmed — it carries the underscore
    instruction and the genre, which are what make this a score.
    """
    out = list(head)
    for s in tail_sentences:
        if not s:
            continue
        if _word_count(" ".join(out + [s])) > budget:
            break
        out.append(s)
    return " ".join(x for x in out if x)


def caption(score, *, title=None, style=None, instrumental=True):
    """The MiniMax Music 3 caption: prose, three passes, guide order.

    `instrumental` suppresses pass 2 rather than writing "no vocals" here —
    `handlers/music.INSTRUMENTAL_HINT` already appends exactly that, and two
    statements of it in one caption is the model reading its own production
    notes back.
    """
    score = score or {}
    idiom = _clean(score.get("idiom")) or _clean(style) or "cinematic orchestral score"
    bpm = _bpm(score.get("bpm"))
    key = _clean(score.get("key_scale"))

    # ---- pass 1: global metadata -------------------------------------------
    meta = idiom
    if bpm:
        meta += f", around {bpm} BPM"
    if key:
        meta += f", in {key}"
    head = [_sentence(meta), UNDERSCORE_CLAUSE]
    arc = _sentence(score.get("arc"))
    production = _sentence(score.get("production"))

    # ---- pass 2: vocal ------------------------------------------------------
    vocal = "" if instrumental else _sentence(score.get("vocal"))

    # ---- pass 3: arrangement ------------------------------------------------
    instruments = _instruments(score.get("instruments"))
    arr = ""
    if instruments:
        arr = _sentence("Arrangement: " + ", ".join(instruments), cap=None)
    evolution = _sentence(score.get("evolution"))
    motif = _sentence(score.get("motif"))
    space = _sentence(score.get("space"), cap=12)

    # The arrangement is RESERVED, not queued behind the prose. Guide order is
    # preserved in the output — it still comes after the metadata — but its
    # words are subtracted from the budget first, so a long `arc` can no
    # longer evict the instrument list. Same rule as the underscore clause:
    # what the guide says carries the record does not compete for space with
    # what merely describes it.
    budget = MAX_WORDS - _word_count(arr)
    before = _fit(head, [arc, production, vocal], budget)
    out = " ".join(x for x in (before, arr) if x)
    return _fit([out], [evolution, motif, space], MAX_WORDS)


def tags(score, *, style=None, instrumental=True):
    """The ACE-Step tag list.

    Tempo, key and time signature are TYPED controls on this encoder and are
    deliberately absent — `handlers/music` snaps them onto the node's own
    enums, and a tag saying "92 BPM" reaches the model as words to sing.
    """
    score = score or {}
    out = []
    for t in _names(score.get("idiom"), 3) or _names(style, 1):
        out.append(t)
    out.extend(UNDERSCORE_TAGS)
    out.extend(_instruments(score.get("instruments")))
    for extra in ("groove", "mood", "production"):
        out.extend(_names(score.get(extra), 2))
    if instrumental:
        out.append("instrumental")
    seen, uniq = set(), []
    for t in out:
        k = t.lower()
        if k and k not in seen:
            seen.add(k)
            uniq.append(t)
    return ", ".join(uniq[:MAX_TAGS])


def compile_prompt(score, *, family="music3", title=None, style=None,
                   instrumental=True):
    """The caption or the tag list, whichever this family reads."""
    if str(family or "").startswith("acestep"):
        return tags(score, style=style, instrumental=instrumental)
    return caption(score, title=title, style=style, instrumental=instrumental)


def typed_meta(score):
    """The ACE-Step typed controls the plan carries, for the job payload.

    Returned separately from the tags for the reason the tags omit them: they
    are node inputs, not words. Music 3 declares none of these, and
    `llm.plan_storyboard` drops them for that family rather than writing a
    payload key nothing reads.
    """
    score = score or {}
    out = {}
    bpm = _bpm(score.get("bpm"))
    if bpm:
        out["bpm"] = bpm
    key = _clean(score.get("key_scale"))
    if key:
        out["key_scale"] = key
    ts = _clean(score.get("time_signature"))
    if ts:
        out["time_signature"] = ts
    return out

"""Vocal events — `(sigh)`, `(laugh)` — as they travel through the pipeline.

Breeze TTS 2 performs an event written inline in the line, in parentheses:
"(sigh) It's good to hear your voice again." The writer is allowed to put
them there (storyplan.WRITER_CONTRACT), so a dialogue line is no longer only
words — and three consumers have to agree on what to do with the part that is
not words:

  * the SYNTH keeps them (Breeze performs them; ElevenLabs v3 gets its own
    bracket spelling, `[sighs]`);
  * the H3 ENVELOPE strips them out of `<d>…</d>` — a `<d>` line is what the
    model lip-syncs, and "(sigh)" inside it is four syllables to mouth — and
    says the event as ACTION prose instead ("she sighs, then says:");
  * the REVIEWER strips them from the expected line, or the ASR is asked to
    hear the word "sigh" and DIALOGUE_MISSING fires on a line that was
    performed exactly.

Pure module, no imports beyond `re`, imported by all three. Only the four
events the model's authors document are kept; anything else in parentheses
inside a line ("(beat)", "(pause)", "(laughs softly)") is a stage direction
that reaches no engine and is dropped from the spoken text. The screenshot
palette of the Breeze studio UI lists two dozen more as "plausible but
untested"; a token the model reads aloud as a word is worse than a dropped
one, so they are not offered to the writer.
"""
import re

# event token -> (ElevenLabs v3 tag, action prose)
EVENTS = {
    "laugh": ("[laughs]", "laughs"),
    "sigh": ("[sighs]", "sighs"),
    "cough": ("[coughs]", "coughs"),
    "clears throat": ("[clears throat]", "clears their throat"),
}

_PAREN = re.compile(r"\(\s*([^()]{1,40}?)\s*\)")


def _key(inner):
    k = re.sub(r"\s+", " ", inner.strip().lower())
    # accept the obvious inflections — "laughs", "sighs", "clears his throat"
    if k in EVENTS:
        return k
    if k in ("laughs", "laughing", "chuckle", "chuckles"):
        return "laugh"
    if k in ("sighs", "sighing"):
        return "sigh"
    if k in ("coughs", "coughing"):
        return "cough"
    if re.fullmatch(r"clears? (?:his|her|their|the)? ?throat", k):
        return "clears throat"
    return None


def events_in(line):
    """The documented vocal events a line carries, in order of appearance."""
    out = []
    for m in _PAREN.finditer(line or ""):
        k = _key(m.group(1))
        if k:
            out.append(k)
    return out


def strip_events(line):
    """The line with EVERY parenthetical removed — the words to lip-sync and
    the words the reviewer expects to hear. Whitespace and a stranded leading
    comma are tidied so "(sigh) It's good" -> "It's good"."""
    out = _PAREN.sub("", line or "")
    out = re.sub(r"\s{2,}", " ", out).strip()
    out = re.sub(r"^[,;:\-\s]+", "", out)
    return out


def sanitize_events(line):
    """The line as a BREEZE input: documented events kept in the model's own
    spelling, every other parenthetical dropped."""
    def sub(m):
        k = _key(m.group(1))
        return f"({k})" if k else ""
    out = _PAREN.sub(sub, line or "")
    return re.sub(r"\s{2,}", " ", out).strip()


def to_elevenlabs(line):
    """The line as an ELEVENLABS v3 input: each documented event becomes its
    v3 audio tag, the rest are dropped."""
    def sub(m):
        k = _key(m.group(1))
        return EVENTS[k][0] if k else ""
    out = _PAREN.sub(sub, line or "")
    return re.sub(r"\s{2,}", " ", out).strip()


def event_prose(events):
    """"sighs" / "laughs, then clears their throat" — what the envelope says
    the character DOES before speaking. Empty for no events."""
    verbs = [EVENTS[e][1] for e in events if e in EVENTS]
    if not verbs:
        return ""
    if len(verbs) == 1:
        return verbs[0]
    return ", ".join(verbs[:-1]) + f", then {verbs[-1]}"

"""ElevenLabs v3 exact-dialogue synthesis — the A-path made production.

Measured before it was built (block-5 A/B, 2026-08-10): three v3 line clips
staged as reference AUDIO with `partially_copy` retention rendered 100%
dialogue coverage with zero issues on a block that had failed its lines three
times natively — while H3 still generated the room around the words (−44dB
ambience floor between lines vs digital silence on the audiolock variant).
Speaker similarity against the actual reference hit 0.865 where native takes
never broke ~0.5.

Division of labor (invariant #6 intact): the writer emits `delivery` prose
per line; THIS module maps it deterministically onto v3 audio tags and synths
the clips; `h3_prompt` writes the exact-use envelope; H3 places the recorded
lines and lip-syncs to them. The LLM never writes the vendor format, and the
performance is chosen (voice, tone, tags) rather than rolled.

Fallbacks are loud and safe: no API key, an uncast speaker, too many
voices, or an ElevenLabs failure all mean the block renders exactly as
before (voice-timbre refs) with one log line saying so — a network blip must
never kill a $0.45 render.

TWO ENGINES SINCE 2026-09-01. ElevenLabs v3 is the hosted path above; Breeze
TTS 2 (worker/breeze_tts.py, served on the pod) is the local one, and it
changes three things: a character's voice is DESIGNED from the writer's
`doc.voice` prose instead of cast from a table (`cast_breeze_voice`), every
line is CLONED from that designed clip with the writer's `delivery` as a
voice-DIRECTION instruction rather than a tag, and the writer may put VOCAL
EVENTS in the line itself — "(sigh) It's good to hear your voice" — which the
engine performs (vocal_events.py). A Breeze voice id is `breeze:<clip asset>`
so everything keyed on voice ids is untouched; an exchange with a Breeze voice
in it is ASSEMBLED per line with exact spans rather than recorded as one v3
conversation, and `_synth` stays the ElevenLabs call (the tests stub it).

Slot budget: Ref2VA takes ≤3 audio references. ≤3 lines stage one clip per
line (the measured-good case). More lines become ONE recorded CONVERSATION
via the text-to-dialogue endpoint — v3 performs the whole exchange with
natural turn-taking, the reviewer's own ASR measures where each line landed
inside it, and the plan cuts the shots to the recording (dialogue-first).
This replaced the per-speaker merged clips, which placed unreliably under
heavy action (NEONFALL blocks 17/20/25: parts of a merged clip simply
dropped); a single continuous conversation has the interleaving baked in,
so H3 places one object instead of weaving three.
"""
import hashlib
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request

import breeze_tts as BT
import sb
import vocal_events as VE
import voice_engines as ENG
from status import log

API = "https://api.elevenlabs.io/v1"
MODEL_ID = "eleven_v3"
# A Breeze-cast character's voice id is `breeze:<asset id of its designed
# reference clip>` — a STRING, deliberately, so every place that treats a
# voice id as an opaque key (plan_lines' dedupe, line_key, exchange_key, the
# `taken` sets, the asset meta) keeps working unchanged. See `_entry_voice`.
BREEZE_PREFIX = ENG.PREFIXES["breeze"]
BREEZE_MODEL_ID = "breeze-tts-2"
# EVERY LOCAL ENGINE IS 24 kHz MONO s16le, and the exchange assembler depends
# on it: `concat_wavs` lays clips end to end and reports their spans without
# resampling, so a second engine at another rate would put every line after
# the first at the wrong timestamp — silently, since the audio still plays.
# Asserted here rather than assumed, so a third engine says so on import.
LOCAL_SAMPLE_RATE = BT.SAMPLE_RATE
# Gap between consecutive lines when an exchange is ASSEMBLED from per-line
# clips (Breeze has no multi-speaker conversation endpoint the way
# ElevenLabs' text-to-dialogue is one call): a conversational beat, under the
# 500ms `LINE_GAP_MS` a shot floor allows, so the plan's own cut points land
# in performed-ish silence just as they do on a v3 exchange.
XCHG_GAP_MS = 350
XCHG_LEAD_MS = 250
MAX_AUDIO_SLOTS = 3
MAX_XCHG_CHARS = 1800    # text-to-dialogue validates ≤2000 chars across inputs
MAX_XCHG_VOICES = 10     # its voice ceiling — far past Ref2VA's 3 timbre slots

# Curated library voices (public premade ids), keyed the way writers describe
# voices — same matching shape as llm.pick_tts_voice. Order matters: earlier
# rows win ties. The gender tag is a hard filter once the descriptor names
# one: "a warm low mezzo-soprano" cast GEORGE because "warm" matched him and
# no axis said she was a woman (measured — Mrs. Katagiri, AFTERLIGHT E1).
VOICE_TABLE = [
    ("EXAVITQu4vr4xnSDxMaL", "Sarah", "f",  ("low", "clipped", "precise", "controlled",
                                             "confident", "professional", "woman")),
    ("pFZP5JQG7iQjIQuC4Bku", "Lily", "f",   ("velvet", "smooth", "transactional",
                                             "mature", "measured", "british")),
    ("Xb7hH8MSUJpSbSDYk0k2", "Alice", "f",  ("cold", "clinical", "formal", "crisp",
                                             "courteous", "clear")),
    ("FGY2WhTYpPnrIDTdsKH5", "Laura", "f",  ("rapid", "quick", "energetic", "young",
                                             "bright", "chatty", "wiry")),
    # Every male voice here used to be middle-aged and heavy, so a young, quiet
    # man had nowhere to land: AFTERLIGHT's Haru — "a soft, breathy baritone …
    # restrained volume", 23 — cast as Brian (deep, resonant, middle-aged) on
    # the strength of one "slow" match, and read a decade too old for two
    # episodes. Gender filtering alone can't fix that; the pool has to contain
    # the register. These three are the account's `age=young` males.
    ("bIHbv24MWmeRgasZH58o", "Will", "m",   ("soft", "breathy", "gentle", "quiet",
                                             "restrained", "relaxed", "calm",
                                             "chill", "young", "hesitant")),
    ("IKne3meq5aSn9XLyUdCD", "Charlie", "m", ("confident", "deep", "young",
                                              "assured", "direct")),
    ("TX3LPaxmHKxFdv7VOQHJ", "Liam", "m",   ("bright", "quick", "energetic",
                                             "young", "upbeat", "eager")),
    ("nPczCjzI2devNBz1zQrb", "Brian", "m",  ("deep", "gravel", "low", "slow", "bass",
                                             "heavy", "resonant", "man")),
    ("onwK4e9ZLuTAKqWW03F9", "Daniel", "m", ("steady", "broadcast", "formal",
                                             "neutral", "flat")),
    ("JBFqnCBsd6RMkjVDRZzb", "George", "m", ("warm", "storyteller", "older", "wise")),
    ("cgSgspJ2msm6clMCkdW9", "Jessica", "f", ("playful", "warm", "light", "soft")),
]

_FEM = re.compile(r"\b(soprano|mezzo(?:-soprano)?|contralto|alto|woman|female|girl|feminine|she|her)\b")
_MASC = re.compile(r"\b(baritone|bass|tenor|man|male|boy|masculine|he|his)\b")

# delivery prose -> ONE leading v3 audio tag. Deterministic, first hit wins;
# no hit means no tag (punctuation and the voice itself carry the read).
TAG_MAP = [
    (("whisper", "hushed", "under her breath", "under his breath"), "[whispers]"),
    (("laugh", "amused", "wry"), "[laughs]"),
    (("chuckle",), "[chuckles]"),
    (("sigh", "weary", "tired", "resigned"), "[sighs]"),
    (("sarcas", "dry", "deadpan"), "[sarcastic]"),
    (("excited", "thrilled", "eager"), "[excited]"),
    (("curious", "wonder"), "[curious]"),
    (("angry", "furious", "snarl", "harsh"), "[angry]"),
    (("sad", "grief", "mourn", "broken"), "[sad]"),
    (("cry", "tear", "sob"), "[crying]"),
    (("pleased", "satisfied", "smug", "triumphant"), "[pleased]"),
    (("firm", "decisive", "command", "order"), "[firm]"),
    (("afraid", "fear", "frightened", "panicked"), "[fearful]"),
    (("nervous", "anxious", "shaky", "trembling", "hesitant"), "[nervously]"),
    (("mischie", "teasing", "playful", "sly"), "[mischievously]"),
    (("surprised", "startled", "taken aback", "stunned"), "[surprised]"),
    (("annoyed", "frustrat", "exasperat", "irritat"), "[annoyed]"),
    (("thoughtful", "considering", "distant", "far away"), "[thoughtful]"),
    (("awe", "breathless", "wonder-struck"), "[awe]"),
    (("happy", "bright", "cheerful", "grinning", "smiling"), "[happy]"),
    (("exhale", "breath out", "held breath"), "[exhales]"),
    (("dramatic",), "[dramatically]"),
    (("calm", "controlled", "level", "even"), ""),
]


def el_enabled():
    return bool(os.environ.get("ELEVENLABS_API_KEY"))


def breeze_enabled():
    return BT.enabled()


def qwen_enabled():
    return ENG.engine("qwen").enabled()


def local_providers():
    """Local engines that are configured AND answering, in preference order.
    `resolve_provider` asks this rather than testing engines by name, so a
    third engine needs no branch here either."""
    return ENG.available()


def enabled():
    """Can this box record dialogue at all — with EITHER engine."""
    return el_enabled() or breeze_enabled()


def is_breeze(voice_id):
    return ENG.split(voice_id)[0] == "breeze"


def breeze_asset_id(voice_id):
    name, aid = ENG.split(voice_id)
    return aid if name == "breeze" else None


def is_local(voice_id):
    """Is this voice a designed CLIP on this box rather than a vendor id?

    The question every `is_breeze` in this module was really asking. A second
    local engine is what made the difference matter: `is_breeze` now means
    "Breeze specifically" and this means "not ElevenLabs"."""
    return ENG.is_local(voice_id)


def local_engine(voice_id):
    """The client module a local voice id belongs to, or None for a vendor
    id. One lookup instead of a branch per call site — see voice_engines."""
    return ENG.engine_of(voice_id)


def local_asset_id(voice_id):
    return ENG.asset_id(voice_id)


def provider_default():
    """Which engine a plan casts with when its payload does not say.

    `DIALOGUE_PROVIDER` on the box wins; otherwise Breeze whenever it is
    serving, else ElevenLabs. A provider named but not available is reported
    by `resolve_provider`, never silently swapped."""
    want = (os.environ.get("DIALOGUE_PROVIDER") or "").strip().lower()
    if want:
        return want
    return ENG.first_available() or "elevenlabs"


def resolve_provider(want=None):
    """(provider actually usable, note) for a requested provider name.

    A request for an engine that is not reachable falls back to the other
    one, and SAYS so — the fallback is the ElevenLabs-outage posture this
    module has always had, but a silent swap would leave an episode cast in
    a voice nobody chose with nothing in the log to explain it."""
    want = (want or provider_default()).strip().lower()
    if want in ENG.ENGINES:
        if ENG.serving(want):
            return want, None
        # A LOCAL ENGINE FALLS BACK TO ANOTHER LOCAL ONE FIRST. Both design a
        # voice from the writer's prose, so the cast still comes out of the
        # description; ElevenLabs falls back to a TABLE of library voices,
        # which is a different kind of answer and the further one from what
        # was asked for.
        other = next((n for n in ENG.available() if n != want), None)
        if other:
            return other, (f"{want} was asked for but its server is not "
                           f"answering — casting on {other} instead")
        if el_enabled():
            return "elevenlabs", (f"{want} was asked for but its server is not "
                                  f"answering — casting on ElevenLabs instead")
        return None, f"{want} was asked for and no engine is available"
    if want == "elevenlabs":
        if el_enabled():
            return "elevenlabs", None
        local = ENG.first_available()
        if local:
            return local, ("elevenlabs was asked for but ELEVENLABS_API_KEY "
                           f"is unset — casting on {local} instead")
        return None, "elevenlabs was asked for and neither engine is available"
    return None, f"unknown dialogue provider {want!r}"


def cast_voice(descriptor, taken, hint=""):
    """Nearest library voice for a written voice description, avoiding reuse
    while an alternative exists — the ElevenLabs twin of llm.pick_tts_voice.

    Gender is a hard filter when the prose declares one (vocal register terms
    included: mezzo/contralto vs baritone/bass), read from the descriptor
    plus `hint` (the character's identity line — 'a 60-year-old woman…').
    Within the pool, more keyword hits outrank table order."""
    d = (descriptor or "").lower()
    probe = f"{d} {(hint or '').lower()}"
    g = "f" if _FEM.search(probe) else ("m" if _MASC.search(probe) else None)
    pool = [r for r in VOICE_TABLE if g is None or r[2] == g] or VOICE_TABLE
    scored = sorted((r for r in pool if any(k in d for k in r[3])),
                    key=lambda r: -sum(k in d for k in r[3]))
    ranked = [r[0] for r in scored]
    ranked += [r[0] for r in pool if r[0] not in ranked]
    return next((v for v in ranked if v not in taken), ranked[0])


def tag_for(delivery):
    d = (delivery or "").lower()
    for keys, tag in TAG_MAP:
        if any(k in d for k in keys):
            return tag
    return ""


def _speech_text(line, delivery, voice_id=None):
    """What the ENGINE is handed for a line.

    ElevenLabs: ONE leading v3 tag compiled from `delivery`, and any inline
    vocal event the writer put in the line respelt as its v3 tag ("(sigh)" ->
    "[sighs]"). A LOCAL engine spells events its own way (`EVENT_STYLE`):
    Breeze keeps the model's own parenthesised form because it PERFORMS them,
    and carries `delivery` separately as the voice-DIRECTION instruction (see
    `_instruction`); Qwen has no event vocabulary, so they are stripped to the
    words to lip-sync. Every path drops stage directions that reach no engine
    ("(beat)")."""
    m = local_engine(voice_id)
    if m is not None:
        # EACH ENGINE SPELLS AN EVENT ITS OWN WAY and the difference is not
        # cosmetic: Breeze PERFORMS "(sigh)", Qwen has no documented event
        # vocabulary and would read the word aloud. `EVENT_STYLE` is declared
        # on the engine so a new one states its own answer instead of
        # inheriting Breeze's by accident.
        style = getattr(m, "EVENT_STYLE", "none")
        return VE.sanitize_events(line) if style == "native" else VE.strip_events(line)
    tag = tag_for(delivery)
    return f"{tag} {VE.to_elevenlabs(line)}".strip()


def _instruction(delivery):
    """A writer's `delivery` note as a Breeze voice-direction instruction, or
    None for a plain clone (cfg 1.0 — the reference reproduced faithfully).
    The note is prose already ("through a held breath", "flat, not looking
    up"), so it is handed over as one imperative sentence rather than
    re-mapped through a tag table: that table exists because ElevenLabs takes
    a closed set of tags, and Breeze takes open language."""
    d = (delivery or "").strip().rstrip(".")
    if not d or tag_for(d) == "" and d.lower() in ("calm", "controlled", "level", "even"):
        return None
    if d.lower().startswith(("speak", "say", "deliver", "read")):
        return d + "."
    return f"Speak {d}."


def line_key(voice_id, speech_text, instruction=None):
    """The content hash a line clip is cached under, forever.

    THE ENGINE'S `MODEL_ID` IS IN IT and must keep its value: every clip on
    B2 is keyed by this, and `beats.meta.xchg` pins a run of shots to a
    recording by the same hash — so changing what a local engine reports
    orphans its cache and unpins its exchanges without failing anything.
    `_model_id_of` returns `breeze-tts-2` for a Breeze voice exactly as the
    old branch did, which is what makes a second engine free here."""
    if is_local(voice_id):
        return hashlib.sha1(f"{_model_id_of(voice_id)}|{voice_id}|{speech_text}|"
                            f"{instruction or ''}".encode()).hexdigest()[:16]
    return hashlib.sha1(f"{MODEL_ID}|{voice_id}|{speech_text}".encode()).hexdigest()[:16]


def _synth(voice_id, speech_text):
    body = json.dumps({"text": speech_text, "model_id": MODEL_ID}).encode()
    last = None
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(
                f"{API}/text-to-speech/{voice_id}?output_format=mp3_44100_128",
                data=body, method="POST",
                headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"],
                         "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — one retry, then the caller falls back
            last = e
    raise RuntimeError(f"elevenlabs synth failed: {last}")


_REF_CLIPS = {}      # asset id -> local path of a fetched Breeze reference clip


def _ref_clip(asset_id):
    """The designed reference clip on disk, fetched once per process."""
    p = _REF_CLIPS.get(asset_id)
    if p and os.path.exists(p):
        return p
    a = sb.asset_by_id(asset_id)
    if not a or not a.get("b2_key"):
        raise RuntimeError(f"voice reference {asset_id} is gone")
    import media
    ext = os.path.splitext(a["b2_key"])[1] or ".mp3"
    dest = f"/tmp/voiceref_{asset_id[:8]}{ext}"
    media.b2_get(a["b2_key"], dest)
    _REF_CLIPS[asset_id] = dest
    return dest


def _ref_text(asset_id):
    a = sb.asset_by_id(asset_id)
    txt = ((a or {}).get("meta") or {}).get("speech_text")
    if not txt:
        raise RuntimeError(f"voice reference {asset_id} records no transcript")
    return txt


def _local_line(voice_id, speech_text, instruction=None, *, wav=False):
    """One line in a LOCALLY-cast voice -> mp3 bytes (or WAV for the exchange
    assembler). CLONE from the character's designed clip; where the engine
    supports it, DIRECT that clone with the delivery note. Seeded from the
    line itself, so a re-synth of a cached miss reproduces the same read.

    THE INSTRUCTION IS DROPPED BEFORE IT IS SENT on an engine that cannot use
    it, rather than after: `supports_direction` is what decides, so a Qwen
    line never carries a note its own client would have to warn about. It is
    a real loss and it is stated here — on Qwen the delivery reaches the read
    only through the writer's punctuation."""
    name, aid = ENG.split(voice_id)
    m = ENG.engine(name)
    if instruction and not ENG.supports_direction(voice_id):
        instruction = None
    seed = int(hashlib.sha1(f"{speech_text}|{instruction or ''}".encode()).hexdigest()[:8], 16) % (2 ** 31)
    data = m.speak(speech_text, ref_audio_path=_ref_clip(aid), ref_text=_ref_text(aid),
                   instruction=instruction, seed=seed)
    return data if wav else m.to_mp3(data)


# The old name, kept because it is what the Breeze tests call and what a
# reader greps for. One engine's spelling of the general thing.
def _breeze_line(voice_id, speech_text, instruction=None, *, wav=False):
    return _local_line(voice_id, speech_text, instruction, wav=wav)


def _voice_of_doc(doc):
    """The voice id a bible doc names, honouring an explicit provider choice
    and never guessing between two: a character cast on ElevenLabs by an
    earlier plan and re-cast on Breeze by a later one carries
    `voice_provider`, and that is what decides."""
    doc = doc or {}
    prov = (doc.get("voice_provider") or "").lower()
    el = doc.get("el_voice_id")
    # A LOCAL engine's designed clip lives at `doc.<engine>_voice.asset_id`.
    # `breeze_voice` is what every row written before a second engine existed
    # carries, and it keeps meaning exactly what it meant.
    def _clip(name):
        return ((doc.get(f"{name}_voice") or {}).get("asset_id"))
    if prov in ENG.ENGINES:
        aid = _clip(prov)
        return ENG.voice_id(prov, aid) if aid else None
    if prov == "elevenlabs":
        return el
    if el:
        return el
    for name in ENG.ENGINES:
        aid = _clip(name)
        if aid:
            return ENG.voice_id(name, aid)
    return None


def _entry_voice(entry, by_id):
    """A cast entry's voice id — an ElevenLabs id or `breeze:<clip>` — with an
    outfit variant borrowing its parent's, same as every other identity fact."""
    doc = entry.get("doc") or {}
    vid = _voice_of_doc(doc)
    if not vid and doc.get("variant_of"):
        parent = by_id.get(doc["variant_of"])
        if parent:
            vid = _voice_of_doc(parent.get("doc") or {})
        else:
            rows = sb.get(f"bible_entries?id=eq.{doc['variant_of']}&select=doc")
            vid = _voice_of_doc(rows[0].get("doc") or {}) if rows else None
    return vid


_AGE = re.compile(r"\b(?:(?:late|early|mid)[- ]?)?(?:\d{2})s\b|\b\d{2}-year-old\b|"
                  r"\b(?:teenage[rd]?|teen|young|elderly|old|middle-aged|ageing|aging)\b", re.I)
# EXPLICIT, so it outranks a vocal range. `_FEM` matches "mezzo" and
# "contralto" because those ARE evidence about a voice — but they are evidence
# only where nothing was said outright, and a character the writer files as
# nonbinary being designed as "a woman" because her range is mezzo is the
# studio misgendering its own cast.
_ENBY = re.compile(r"\bnon[- ]?binary\b|\benby\b|\bgenderqueer\b|\bagender\b|"
                   r"\bthey/them\b", re.I)


def _who(voice, identity_line):
    """woman | man | person, from the character before the vocal range.

    THE IDENTITY LINE IS ASKED FIRST and the voice prose is the fallback. They
    are different kinds of evidence: the identity line names the PERSON (the
    writer's contract makes apparent age its opening attribute, and the
    pronouns are in there too), while "contralto" or "tenor" names a RANGE,
    which correlates and does not decide. Reading one combined string let the
    range win whenever it appeared first, which on this studio's own bible is
    every character whose voice is described before their pronoun.
    """
    ident = (identity_line or "").lower()
    if _ENBY.search(ident):
        return "person"
    for text in (ident, (voice or "").lower()):
        if _FEM.search(text):
            return "woman"
        if _MASC.search(text):
            return "man"
    return "person"


def voice_instruction(voice, identity_line=""):
    """The writer's `doc.voice` prose as a Breeze voice-DESIGN instruction.

    The model designs from natural language, so the prose is handed over
    nearly verbatim — what is added is what the writer puts elsewhere: the
    character's apparent age and sex live in the identity line (the face
    plate is drawn from it), and a voice designed without them is a voice of
    no particular person."""
    who = _who(voice, identity_line)
    m = _AGE.search(identity_line or "")
    age = (m.group(0).strip() + " ") if m else ""
    v = (voice or "").strip().rstrip(".")
    if v:
        v = v[0].lower() + v[1:]
        return f"A {age}{who}, speaking English: {v}."
    return f"A {age}{who} speaking English with a natural, clear voice."


def design_voice(name, voice, identity_line, project_id, engine="breeze"):
    """DESIGN a character's voice once, from prose, and register the clip.

    The clip is the character's timbre reference from here on — what
    `voice_ref_asset_id` points at, what every line CLONES from, what the
    reviewer's speaker verifier compares takes against. Cached forever by
    (engine, name, instruction) — the ENGINE is in the key because the same
    description on two models is two different voices, and a cache that
    conflated them would hand a re-cast character the other engine's clip.
    A re-plan re-uses the same voice rather than rolling
    a new one, which is what makes a returning character sound like themself
    in the next episode. Returns {asset_id, ref_text, instruction}."""
    instruction = voice_instruction(voice, identity_line)
    text = (f"This is how {name} sounds when they speak: a plain sentence, "
            f"unhurried, in an ordinary moment.")
    m = ENG.engine(engine)
    key = hashlib.sha1(
        f"design|{engine}|{name}|{instruction}|{text}".encode()).hexdigest()[:16]
    b2_key = f"audio/voices/{engine}_{key}.mp3"
    rows = sb.get(f"assets?b2_key=eq.{urllib.parse.quote(b2_key)}&select=id")
    if rows:
        return {"asset_id": rows[0]["id"], "ref_text": text, "instruction": instruction}
    seed = int(hashlib.sha1(name.encode()).hexdigest()[:8], 16) % (2 ** 31)
    data = m.to_mp3(m.design(instruction, text, seed=seed))
    import media
    local = f"/tmp/{engine}_design_{key}.mp3"
    with open(local, "wb") as f:
        f.write(data)
    try:
        media.b2_put(local, b2_key, content_type="audio/mpeg")
        dur = media.probe(local).get("duration_ms")
        asset = sb.register_asset(
            b2_key, "audio", project_id=project_id, content_type="audio/mpeg",
            duration_ms=dur, origin="generated",
            meta={"kind": "voice_design", "provider": engine,
                  "model": getattr(m, "MODEL_ID", engine),
                  "speaker": name, "speech_text": text, "instruction": instruction,
                  "voice": ENG.voice_id(engine, key), "kind_hint": "voice"},
            tags=["voice-ref", f"{engine}-design"])
        return {"asset_id": asset["id"], "ref_text": text, "instruction": instruction}
    finally:
        try:
            os.remove(local)
        except OSError:
            pass


def cast_local_voice(entry, project_id, engine="breeze"):
    """Design (or re-use) a character's voice on a LOCAL engine and write it
    onto the entry: `doc.<engine>_voice`, `doc.voice_provider = <engine>`, and
    the `voice_ref_asset_id` every Ref2VA block stages as the timbre anchor.
    Returns the voice id (`<engine>:<asset>`)."""
    doc = dict(entry.get("doc") or {})
    name = (entry.get("name") or "").split(" — ")[0].strip() or "the character"
    dv = design_voice(name, doc.get("voice"), entry.get("identity_line") or "",
                      project_id, engine=engine)
    doc[f"{engine}_voice"] = dv
    doc["voice_provider"] = engine
    sb.patch(f"bible_entries?id=eq.{entry['id']}",
             {"doc": doc, "voice_ref_asset_id": dv["asset_id"]})
    entry["doc"] = doc
    entry["voice_ref_asset_id"] = dv["asset_id"]
    return ENG.voice_id(engine, dv["asset_id"])


def cast_breeze_voice(entry, project_id):
    """The Breeze spelling of `cast_local_voice`, kept because it is what
    `llm.py`, `director_tools` and the tests all call."""
    return cast_local_voice(entry, project_id, engine="breeze")


def plan_lines(beats, cast):
    """The block's dialogue -> staging plan, or None when this block should
    keep the timbre-ref path (no dialogue, an uncast speaker, or a speaker
    count the slot budget can't carry).

    Returns [{speaker, voice_id, shot_idx, order, line, speech_text, key}] —
    one item per LINE; merging into per-speaker clips happens at asset time
    when the count exceeds the slot budget."""
    by_id = {c["id"]: c for c in cast}
    by_base = {}
    for c in cast:
        by_base.setdefault(c["name"].split(" — ")[0].strip().lower(), c)
    items, order = [], 0
    for i, b in enumerate(beats):
        for d in (b.get("dialogue") or []):
            line = (d.get("line") or "").strip()
            speaker = (d.get("speaker") or "").split(" — ")[0].strip()
            if not line or not speaker:
                continue
            entry = by_base.get(speaker.lower())
            if entry is None:
                log(f"dialogue synth: '{speaker}' not in cast — timbre refs instead")
                return None
            vid = _entry_voice(entry, by_id)
            if not vid:
                log(f"dialogue synth: {speaker} has no cast voice — timbre refs instead")
                return None
            order += 1
            speech = _speech_text(line, d.get("delivery"), vid)
            ins = (_instruction(d.get("delivery"))
                   if ENG.supports_direction(vid) else None)
            items.append({"speaker": speaker, "voice_id": vid,
                          "shot_idx": i + 1, "order": order, "line": line,
                          "speech_text": speech,
                          **({"instruction": ins} if ins else {}),
                          "key": line_key(vid, speech, ins)})
    if not items:
        return None
    # The old ceiling was 3 speakers (one timbre slot each). An exchange clip
    # is ONE slot holding the whole conversation, so the only hard limit left
    # is the text-to-dialogue voice ceiling (ElevenLabs only — a Breeze
    # exchange is assembled per line and has no voice count).
    if (not all(is_local(it["voice_id"]) for it in items)
            and len({it["voice_id"] for it in items}) > MAX_XCHG_VOICES):
        log(f"dialogue synth: {len({it['voice_id'] for it in items})} voices "
            f"> {MAX_XCHG_VOICES} — timbre refs instead")
        return None
    return items


def _model_id_of(voice_id):
    """What MODEL a clip in this voice was recorded on, for the asset meta.
    Off the engine module rather than a constant per engine, so a row says
    which checkpoint made it without this file learning every engine's
    name."""
    m = local_engine(voice_id)
    return getattr(m, "MODEL_ID", "local") if m is not None else MODEL_ID


def _ensure_line_asset(it, project_id):
    """One line clip as a registered asset, cached forever by content hash —
    a retake of the block re-uses the identical clip instead of re-rolling
    the performance."""
    b2_key = f"audio/lines/{it['key']}.mp3"
    rows = sb.get(f"assets?b2_key=eq.{urllib.parse.quote(b2_key)}&select=id")
    if rows:
        return rows[0]["id"]
    import media
    if is_local(it["voice_id"]):
        data = _local_line(it["voice_id"], it["speech_text"], it.get("instruction"))
    else:
        data = _synth(it["voice_id"], it["speech_text"])
    local = f"/tmp/line_{it['key']}.mp3"
    with open(local, "wb") as f:
        f.write(data)
    try:
        media.b2_put(local, b2_key, content_type="audio/mpeg")
        dur = media.probe(local).get("duration_ms")
        asset = sb.register_asset(
            b2_key, "audio", project_id=project_id, content_type="audio/mpeg",
            duration_ms=dur, origin="generated",
            meta={"line": it["line"], "speaker": it["speaker"],
                  "voice_id": it["voice_id"],
                  "model": _model_id_of(it["voice_id"]),
                  "speech_text": it["speech_text"],
                  **({"instruction": it["instruction"]} if it.get("instruction") else {})},
            tags=["dialogue-line"])
        return asset["id"]
    finally:
        try:
            os.remove(local)
        except OSError:
            pass


def _synth_dialogue(inputs):
    """One text-to-dialogue call: inputs [{text, voice_id}] -> mp3 bytes.
    v3 performs the exchange as a conversation — reactions, overlap-adjacent
    timing, breath between turns — which is exactly the pacing the per-line
    clips (fixed 500ms gaps) could not give."""
    body = json.dumps({"inputs": inputs, "model_id": MODEL_ID}).encode()
    last = None
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(
                f"{API}/text-to-dialogue?output_format=mp3_44100_128",
                data=body, method="POST",
                headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"],
                         "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=240) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — one retry, then the caller falls back
            last = e
    raise RuntimeError(f"elevenlabs dialogue synth failed: {last}")


def exchange_key(items):
    return hashlib.sha1(("xchg|" + "|".join(
        f"{it['voice_id']}~{it['speech_text']}"
        + (f"~{it['instruction']}" if it.get("instruction") else "")
        for it in items)).encode()).hexdigest()[:16]


def _wav_of_mp3(data):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "mp3", "-i", "pipe:0",
                        "-ac", "1", "-ar", str(LOCAL_SAMPLE_RATE), "-f", "wav", "pipe:1"],
                       input=data, capture_output=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError("exchange: mp3 -> wav decode failed")
    return r.stdout


def _assemble_exchange(items):
    """A run of lines with a LOCAL voice in it -> (mp3 bytes, [{t0_ms,
    t1_ms}] per item). Every line is synthesized in its own voice and the
    clips are laid end to end with a conversational gap, so the spans are
    EXACT by construction — no ASR alignment, no interpolated stragglers.
    An ElevenLabs line in a mixed cast is decoded to WAV and joins the same
    concat."""
    parts = []
    for it in items:
        if is_local(it["voice_id"]):
            parts.append(_local_line(it["voice_id"], it["speech_text"],
                                     it.get("instruction"), wav=True))
        else:
            parts.append(_wav_of_mp3(_synth(it["voice_id"], it["speech_text"])))
    wav, starts = BT.concat_wavs(parts, gap_ms=XCHG_GAP_MS, lead_ms=XCHG_LEAD_MS)
    spans = [{"t0_ms": t0, "t1_ms": t0 + BT.wav_duration_ms(p)}
             for t0, p in zip(starts, parts)]
    return BT.to_mp3(wav), spans


def _align_lines(path, items, duration_ms):
    """Where each line landed inside the exchange clip, measured by the same
    ASR + word-alignment the reviewer's DIALOGUE_CUTOFF trusts. Returns
    [{t0_ms, t1_ms}] parallel to items, or None when the measurement is too
    weak to stake shot timing on (the caller falls back loudly)."""
    try:
        import audioqa
        import shot_contract as C
    except Exception as e:  # noqa: BLE001 — off-pod / reviewer unavailable
        log(f"exchange align: reviewer ASR unavailable: {e}")
        return None
    words, _text = audioqa.transcribe(path)
    if not words:
        return None
    # compare_dialogue silently skips lines that normalize to nothing, which
    # would shift the zip — pre-split into alignable and not.
    alignable = [it for it in items if C._norm(it["line"])]
    pseudo = {"dialogue": [{"speaker": it["speaker"], "line": it["line"]}
                           for it in alignable],
              "content_ms": duration_ms}
    matches, _issues = C.compare_dialogue(pseudo, words)
    span_of = {}
    weak = 0
    for it, m in zip(alignable, matches):
        if m.get("t0") is not None and m.get("coverage", 0) >= 0.5:
            span_of[it["order"]] = [int(m["t0"] * 1000), int(m["t1"] * 1000)]
        else:
            weak += 1
    if weak > max(1, len(alignable) // 3):
        log(f"exchange align: {weak}/{len(alignable)} lines unmatched — "
            f"alignment too weak to cut shots against")
        return None
    # Interpolate the stragglers between their measured neighbors, keep the
    # sequence monotonic, and hand back one span per item.
    out, prev_end = [], 0
    for i, it in enumerate(items):
        span = span_of.get(it["order"])
        if span is None:
            nxt = next((span_of[j["order"]][0] for j in items[i + 1:]
                        if j["order"] in span_of), duration_ms)
            span = [prev_end + 150, max(prev_end + 550, nxt - 150)]
        span[0] = max(span[0], prev_end - 250)
        span[1] = max(span[1], span[0] + 200)
        prev_end = span[1]
        out.append({"t0_ms": span[0], "t1_ms": span[1]})
    return out


def ensure_exchange_asset(items, project_id):
    """ONE recorded conversation for a run of dialogue, cached forever by
    content, with per-line spans measured into its meta. Raises when the clip
    cannot be made or measured — callers catch and fall back."""
    assembled = any(is_local(it["voice_id"]) for it in items)
    if not assembled and sum(len(it["speech_text"]) for it in items) > MAX_XCHG_CHARS:
        raise RuntimeError(f"exchange over {MAX_XCHG_CHARS} chars — too much "
                           f"dialogue for one recorded conversation")
    key = exchange_key(items)
    b2_key = f"audio/lines/xchg_{key}.mp3"
    rows = sb.get(f"assets?b2_key=eq.{urllib.parse.quote(b2_key)}"
                  f"&select=id,duration_ms,meta")
    if rows and (rows[0].get("meta") or {}).get("lines"):
        r = rows[0]
        return {"asset_id": r["id"], "duration_ms": int(r.get("duration_ms") or 0),
                "lines": r["meta"]["lines"], "key": key}
    import media
    local = f"/tmp/xchg_{key}.mp3"
    try:
        exact = None
        if rows:                     # registered but never aligned: re-measure
            media.b2_get(b2_key, local)
        elif assembled:
            data, exact = _assemble_exchange(items)
            with open(local, "wb") as f:
                f.write(data)
        else:
            data = _synth_dialogue([{"text": it["speech_text"],
                                     "voice_id": it["voice_id"]} for it in items])
            with open(local, "wb") as f:
                f.write(data)
        dur = int(media.probe(local).get("duration_ms") or 0)
        # An assembled exchange KNOWS where every line sits; the recorded
        # conversation has to be measured by ear (the reviewer's own ASR).
        aligned = exact or _align_lines(local, items, dur)
        if not aligned:
            raise RuntimeError("exchange alignment failed")
        lines = [{"speaker": it["speaker"], "line": it["line"],
                  "shot_idx": it["shot_idx"], "order": it["order"],
                  "t0_ms": a["t0_ms"], "t1_ms": a["t1_ms"]}
                 for it, a in zip(items, aligned)]
        model_id = BREEZE_MODEL_ID if assembled else MODEL_ID
        if rows:
            sb.patch(f"assets?id=eq.{rows[0]['id']}",
                     {"meta": {"lines": lines, "model": model_id, "kind": "exchange"}})
            return {"asset_id": rows[0]["id"], "duration_ms": dur,
                    "lines": lines, "key": key}
        media.b2_put(local, b2_key, content_type="audio/mpeg")
        asset = sb.register_asset(
            b2_key, "audio", project_id=project_id, content_type="audio/mpeg",
            duration_ms=dur, origin="generated",
            meta={"lines": lines, "model": model_id, "kind": "exchange"},
            tags=["dialogue-line", "exchange"])
        return {"asset_id": asset["id"], "duration_ms": dur,
                "lines": lines, "key": key}
    finally:
        try:
            os.remove(local)
        except OSError:
            pass


def exchange_portion(asset_row, t0_ms, t1_ms, project_id):
    """A block-sized cut of an exchange clip (a run can span two generation
    blocks; each block places only ITS lines). Cut points land in recorded
    silence — the caller picks them between line spans. Cached by range."""
    src_key = asset_row["b2_key"]
    base = hashlib.sha1(f"{src_key}|{int(t0_ms)}|{int(t1_ms)}".encode()).hexdigest()[:16]
    b2_key = f"audio/lines/xchgp_{base}.mp3"
    rows = sb.get(f"assets?b2_key=eq.{urllib.parse.quote(b2_key)}&select=id,duration_ms")
    if rows:
        return rows[0]["id"]
    import media
    src = f"/tmp/xp_src_{base}.mp3"
    out = f"/tmp/xp_out_{base}.mp3"
    media.b2_get(src_key, src)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src,
                    "-ss", f"{t0_ms / 1000:.3f}", "-to", f"{t1_ms / 1000:.3f}",
                    "-c:a", "libmp3lame", "-b:a", "128k", out], check=True)
    try:
        media.b2_put(out, b2_key, content_type="audio/mpeg")
        asset = sb.register_asset(
            b2_key, "audio", project_id=project_id, content_type="audio/mpeg",
            duration_ms=int(media.probe(out).get("duration_ms") or 0),
            origin="generated",
            meta={"parent_b2_key": src_key, "t0_ms": int(t0_ms), "t1_ms": int(t1_ms)},
            tags=["dialogue-line", "exchange"])
        return asset["id"]
    finally:
        for p in (src, out):
            try:
                os.remove(p)
            except OSError:
                pass


# Timing derived from MEASURED clips, not the 2.0-words/sec guess: a line's
# floor is its recorded length plus a handoff beat, and a shot holding lines
# needs them in sequence plus room for the action around them.
LINE_GAP_MS = 500        # breath between consecutive lines in one shot
SHOT_LEAD_MS = 700       # the shot opens before the first word
SHOT_TAIL_MS = 900       # the last word lands before the cut
# ...and, on the REF path only, room for H3 STARTING THE LINE LATE.
#
# The offset in the compiled envelope is advisory: the model wants a beat of
# picture before anyone speaks, and neither the offset nor the finish-by
# anchor stops it waiting. Measured on NIGHT SHIFT across the four lines
# where the comparison is exact — a SHOT-1 line, whose shot clock is the
# block clock, so the onset needs no inference from where H3 chose to cut:
#
#   | told (content) | started | late by |
#   |     0.70s      |  2.34s  | +1.64s  |
#   |     0.70s      |  2.50s  | +1.80s  |
#   |     0.70s      |  2.62s  | +1.92s  |
#   |     0.70s      |  3.49s  | +2.79s  |
#
# COMPARE AGAINST 0.70s, NOT the 1.62s in `audio_refs[].at_ms`. That field is
# on the RENDER clock — `ref_slot_offsets` adds `warmup_ms` to a shot-1 line
# because shot 1 opens at render t=0 and the trim removes the warmup — so the
# delivered take is 917ms (22f at 24fps) shorter at the head than the number
# the prompt states. Measuring a delivered onset against the stored at_ms
# understates the lateness by exactly one warmup, which is how this was first
# scored at 0.7-1.9s.
#
# 2800ms is what covers the worst of the four: the floor needs
# `lead + late >= onset`, so late >= onset - SHOT_LEAD_MS = 2.79s. It is a
# REAL cost — every dialogue shot grows, ~+18s over that episode's eight, so
# roughly +11% of its runtime — and it is cheaper than the re-render it
# replaces.
#
# IT IS NOT SEED NOISE, which is why planning for it is the only fix: the
# same block re-rendered on a fresh seed started at 3.42s against 3.49s. The
# lateness is a property of the shot (that one opens on a pan onto the
# speaker), so a re-roll cannot recover a line the shot has no room for.
#
# Deliberately NOT folded into SHOT_TAIL_MS, which two spine-path callers
# also read (`dialogue_spine`'s lead-in clamp and `pin_run_durations`): both
# place a recording EXACTLY, so there is no lateness there to allow for and
# widening their landing beat would only shorten a lead-in. `late_ms=0` opts
# out. It buys room AFTER the line and does not move the OFFSET — a model
# that already ignores the offset will not be fixed by an earlier one, and an
# earlier one costs the beat of picture the model is evidently waiting for.
#
# FOUR SAMPLES, one episode, one checkpoint (PDD), one TTS engine (Breeze).
# The measurement is a speech-band RMS envelope against the beat durations,
# cheap to repeat on any finished episode: widen the evidence before trusting
# this number far, and re-check it on a different checkpoint.
LATE_START_MS = 2800     # ref-path allowance for a late-starting line


def shot_floor_from_measured(durs_ms, *, lead_ms=SHOT_LEAD_MS,
                             gap_ms=LINE_GAP_MS, tail_ms=SHOT_TAIL_MS,
                             late_ms=LATE_START_MS):
    """Minimum shot duration for measured line lengths, ms. Pure.

    `late_ms` is the ref-path allowance for H3 starting the line after it is
    told to — see LATE_START_MS. Pass 0 for a shot whose audio is placed
    exactly (a spine slice), where the model performs no line of its own.
    """
    durs = [int(d) for d in durs_ms if d]
    if not durs:
        return 0
    return lead_ms + sum(durs) + gap_ms * (len(durs) - 1) + tail_ms + late_ms


def line_offsets_ms(durs_ms, *, lead_ms=SHOT_LEAD_MS, gap_ms=LINE_GAP_MS):
    """Where each measured line starts inside its shot, ms. Pure."""
    out, t = [], lead_ms
    for d in durs_ms:
        out.append(t)
        t += int(d or 0) + gap_ms
    return out


def pin_run_durations(spans_by_shot, *, lead_ms=SHOT_LEAD_MS, tail_ms=SHOT_TAIL_MS):
    """Cut a run of consecutive dialogue shots to ONE recorded exchange.

    spans_by_shot: [[(t0_ms, t1_ms), ...] per shot] in CLIP time — each
    shot's measured line spans, in order. The boundary between two shots
    lands in the middle of the recorded pause between their lines (a cut in
    performed silence), the first shot opens lead_ms before the first word,
    the last holds tail_ms after the last. Returns [duration_ms per shot].
    Pure — this is the 'time the clips from the dialogue' arithmetic."""
    if not spans_by_shot or any(not s for s in spans_by_shot):
        return []
    starts = [s[0][0] for s in spans_by_shot]
    ends = [s[-1][1] for s in spans_by_shot]
    bounds = [starts[0] - lead_ms]
    for a, b in zip(ends, starts[1:]):
        bounds.append((a + b) // 2)
    bounds.append(ends[-1] + tail_ms)
    return [max(250, bounds[i + 1] - bounds[i]) for i in range(len(spans_by_shot))]


# Placement slack inside a shot. Near-zero on purpose: `pin_run_durations`
# puts each cut at the MIDDLE of a recorded pause, so a tight conversational
# pause (~250ms) leaves ~125ms each side — margins of 200/350 made placement
# infeasible BY CONSTRUCTION on runs the plan itself pinned (measured: STATIC
# fell to timbre refs). A line starting exactly at its cut-in is normal
# editing; the only hard rule is that no line CROSSES a cut, plus a hair of
# tail so trim rounding can't clip the last word.
PLACE_HEAD_MS = 0
PLACE_TAIL_MS = 60


def place_exchange(lines, shot_windows, clip_ms=None, block_ms=None):
    """The one clip-start offset (block-content ms) that puts every line of
    an exchange clip inside its planned shot.

    lines: [{t0_ms, t1_ms, shot_idx}] in CLIP time; shot_windows:
    {shot_idx: (start_ms, end_ms)} in block-content time. `clip_ms` and
    `block_ms` are the whole clip's duration and the block's, and they are
    what stops a clip from overhanging the segment end. Returns P ≥ 0 or
    None when the recorded pacing cannot fit the planned cuts (the caller
    falls back rather than letting a line straddle a cut). Pure."""
    # A clip LONGER than the block can never fit, whatever the per-line
    # windows say — and this is not hypothetical: E2 staged three of them
    # (b12 +441ms, b15 +290ms, b18 +441ms) and every one lost its tail to
    # DIALOGUE_PARTIAL / DIALOGUE_CUTOFF. The per-line loop below can't
    # catch it, because the last line's own window is satisfied by a shot
    # that the trim then cuts short.
    if clip_ms and block_ms and clip_ms > block_ms:
        return None
    lo, hi = 0, None
    for l in lines:
        win = shot_windows.get(l["shot_idx"])
        if not win:
            return None
        s0, s1 = win
        lo = max(lo, s0 + PLACE_HEAD_MS - l["t0_ms"])
        h = s1 - PLACE_TAIL_MS - l["t1_ms"]
        hi = h if hi is None else min(hi, h)
    if hi is None or lo > hi:
        return None
    # The whole clip has to end inside the block too, not just each line
    # inside its shot: the tail after the last line is still audio.
    if clip_ms and block_ms:
        hi = min(hi, block_ms - clip_ms)
        if lo > hi:
            return None
    # CENTRE the placement in the feasible window. Placing as late as the
    # margins allowed (which is what fixed head-loss into the warmup trim on
    # block 6) left only PLACE_TAIL_MS of slack at the other end, and E2's
    # reviewer duly measured tails landing 0.08-0.15s before the cut. The
    # midpoint spends the same slack on both ends, so drift in either
    # direction — warmup trim at the head, frame quantisation at the tail —
    # has somewhere to go.
    return int((lo + hi) // 2)


def measure_lines(items, project_id):
    """items (plan_lines shape) -> {order: duration_ms}, synthesizing (and
    caching forever) any clip that doesn't exist yet. The render later stages
    these exact assets, so measuring is never wasted work."""
    out = {}
    for it in items:
        aid = _ensure_line_asset(it, project_id)
        a = sb.asset_by_id(aid)
        out[it["order"]] = int((a or {}).get("duration_ms") or 0)
    return out


def canonical_ref_asset(voice_id, name, project_id):
    """A stable per-voice reference clip (cached forever) — the speaker
    verifier's ground truth once a character speaks in an ElevenLabs voice.
    Comparing EL-voiced takes against the old OpenAI tts refs ranked noise
    (sims -0.05..0.2, measured on block 19's rerun) and false-flagged
    sample-exact dialogue."""
    if is_local(voice_id):
        # The designed clip is the reference by construction — every line was
        # cloned FROM it — so there is nothing to synthesize. True of every
        # local engine, which is why this asks `is_local` and not the engine.
        return local_asset_id(voice_id)
    it = {"voice_id": voice_id, "speaker": name,
          "line": f"This is how {name} sounds when they speak.",
          "speech_text": f"This is how {name} sounds when they speak."}
    it["key"] = line_key(voice_id, it["speech_text"])
    return _ensure_line_asset(it, project_id)


def ensure_assets(items, project_id):
    """Staging plan -> [{asset_id, kind, ...}] within the slot budget:
    per-line clips when they fit (≤3 — the measured-decisive case), ONE
    recorded conversation when they don't. Raises on ElevenLabs/alignment
    failure — the caller catches and falls back to timbre refs."""
    if len(items) <= MAX_AUDIO_SLOTS:
        return [{"kind": "line", "asset_id": _ensure_line_asset(it, project_id),
                 **it} for it in items]
    return [{"kind": "exchange", **ensure_exchange_asset(items, project_id)}]

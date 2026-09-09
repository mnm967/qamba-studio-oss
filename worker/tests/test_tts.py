"""`handle_tts` — which provider speaks the line, and what the asset records.

The routing is the whole risk here. `dialogue_synth` casts every character an
ElevenLabs voice at plan time and every dialogue block speaks in it, so a line
auditioned through the OpenAI chain is not an audition of the take you will
get — but `bible_entry_id` must KEEP the OpenAI chain, because that key means
"this recording is the character's timbre reference" and the reviewer's
speaker verifier compares takes against it. Swapping the provider under that
key silently re-baselines every similarity score in `take_reviews`.
"""
import pytest

import handlers.tts as T


@pytest.fixture
def rec(monkeypatch):
    calls = {"synth": [], "openai": [], "patched": []}
    import dialogue_synth as ds

    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")

    def el_synth(voice_id, speech):
        calls["synth"].append((voice_id, speech))
        return b"mp3"

    def oai(text, emotion=None, openai_voice="alloy"):
        calls["openai"].append((text, emotion, openai_voice))
        return b"mp3", 1.5, "openai"

    monkeypatch.setattr(ds, "_synth", el_synth)
    monkeypatch.setattr(T.genmedia, "generate_audio", oai)
    monkeypatch.setattr(T.genmedia, "_mp3_duration", lambda d: 2.0)
    monkeypatch.setattr(T.media, "b2_put", lambda *a, **k: None)
    monkeypatch.setattr(T.sb, "job_progress", lambda *a, **k: None)
    monkeypatch.setattr(T.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(T.sb, "insert", lambda *a, **k: None)
    monkeypatch.setattr(T.sb, "patch", lambda p, b: calls["patched"].append((p, b)))
    monkeypatch.setattr(T.os, "remove", lambda p: None)
    # Module globals, not builtins: `open(...)` inside tts.py resolves through
    # this module's namespace first, so the patch is scoped to the handler
    # rather than to every fixture and plugin in the session.
    monkeypatch.setattr(T, "open", lambda *a, **k: _Sink(), raising=False)

    def register(*a, **k):
        calls["asset"] = k
        return {"id": "a1"}

    monkeypatch.setattr(T.sb, "register_asset", register)
    calls["rows"] = {}
    monkeypatch.setattr(T.sb, "get", lambda q: calls["rows"].get(q, []))
    return calls


class _Sink:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def write(self, b):
        return len(b)


def run(rec, **payload):
    payload.setdefault("text", "Hold the line.")
    T.handle_tts({"id": "j1", "payload": payload, "project_id": "p1"})
    return rec


def entry_row(eid, voice):
    return (f"bible_entries?id=eq.{eid}&select=id,name,doc",
            [{"id": eid, "name": "Aki", "doc": {"el_voice_id": voice} if voice else {}}])


# ------------------------------------------------------------ routing ----

def test_no_voice_named_means_the_openai_chain(rec):
    run(rec, voice="nova")
    assert rec["openai"] == [("Hold the line.", None, "nova")]
    assert not rec["synth"]


def test_an_unknown_openai_voice_falls_back_to_alloy(rec):
    """`gpt-4o-mini-tts` accepts six names. The old picker offered a seventh
    ('clone_voice_1') and every line it made came back as alloy."""
    run(rec, voice="clone_voice_1")
    assert rec["openai"][0][2] == "alloy"


def test_an_explicit_elevenlabs_voice_wins(rec):
    run(rec, el_voice_id="EXAVITQu4vr4xnSDxMaL")
    assert rec["synth"] == [("EXAVITQu4vr4xnSDxMaL", "Hold the line.")]
    assert not rec["openai"]


def test_a_speaker_speaks_in_their_cast_voice(rec):
    k, v = entry_row("e1", "voice-aki")
    rec["rows"][k] = v
    run(rec, speaker_entry_id="e1")
    assert rec["synth"][0][0] == "voice-aki"


def test_an_uncast_speaker_degrades_loudly_rather_than_failing(rec):
    k, v = entry_row("e1", None)
    rec["rows"][k] = v
    run(rec, speaker_entry_id="e1")
    assert not rec["synth"]
    assert rec["openai"], "a narrated line beats a failed job"


def test_a_missing_key_sends_everything_down_the_openai_chain(rec, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    run(rec, el_voice_id="voice-aki")
    assert not rec["synth"] and rec["openai"]


def test_a_voice_reference_keeps_the_openai_chain(rec):
    """`bible_entry_id` is the reviewer's ground truth. It must not silently
    change provider — see `reviewer.canonical_ref_asset`."""
    run(rec, bible_entry_id="e1", voice="nova")
    assert not rec["synth"]
    assert rec["openai"][0][2] == "nova"
    assert rec["patched"][0][1] == {"voice_ref_asset_id": "a1"}


# ---------------------------------------------------------- delivery ----

def test_delivery_becomes_a_v3_audio_tag_on_the_elevenlabs_path(rec):
    run(rec, el_voice_id="v", emotion="whispers")
    assert rec["synth"][0][1] == "[whispers] Hold the line."


def test_delivery_stays_prose_on_the_openai_path(rec):
    """OpenAI TTS takes `instructions`, not bracket tags — genmedia owns that
    translation, so the raw word goes through."""
    run(rec, emotion="whispers")
    assert rec["openai"][0][1] == "whispers"


def test_an_unmapped_delivery_adds_no_tag(rec):
    run(rec, el_voice_id="v", emotion="wistful")
    assert rec["synth"][0][1] == "Hold the line."


# -------------------------------------------------------------- asset ----

def test_the_asset_records_who_spoke_and_through_what(rec):
    k, v = entry_row("e1", "voice-aki")
    rec["rows"][k] = v
    meta = run(rec, speaker_entry_id="e1", speaker="Aki")["asset"]["meta"]
    assert meta["provider"] == "elevenlabs"
    assert meta["voice"] == "voice-aki"
    assert meta["speaker"] == "Aki"
    assert meta["line"] == "Hold the line."
    # What the library filters on.
    assert meta["kind_hint"] == "voice"


def test_an_empty_line_is_refused(rec):
    with pytest.raises(ValueError):
        T.handle_tts({"id": "j1", "payload": {"text": "  "}})


# --------------------------------------------------------- provider ----
# The picker is only real if the worker reads it. The panel this replaced
# shipped a five-engine dropdown that `handle_tts` never looked at, so every
# engine it offered rendered as OpenAI's alloy.

def clone_row(rec, **over):
    row = {"id": "c1", "name": "Rei", "provider": "fish", "reference_id": "v1",
           "sample_asset_id": None, "sample_text": "", "status": "ready", **over}
    rec["rows"]["voice_clones?id=eq.c1&select=id,name,provider,reference_id,"
                "sample_asset_id,sample_text,status"] = [row]
    return row


def test_an_explicit_provider_overrides_what_the_payload_implies(rec):
    """A speaker with a cast voice would infer elevenlabs; naming openai wins."""
    k, v = entry_row("e1", "voice-aki")
    rec["rows"][k] = v
    run(rec, speaker_entry_id="e1", provider="openai", voice="nova")
    assert not rec["synth"]
    assert rec["openai"][0][2] == "nova"


def test_an_unknown_provider_falls_back_to_inference_rather_than_failing(rec):
    run(rec, provider="suno", voice="echo")
    assert rec["openai"][0][2] == "echo"


def test_the_provider_is_recorded_on_the_asset(rec):
    assert run(rec)["asset"]["meta"]["provider"] == "openai"


def test_a_clone_provider_with_no_clone_is_refused(rec):
    """Rendering the stock voice instead would sound exactly like a clone that
    failed, which is the confusion the whole panel rewrite is about."""
    with pytest.raises(ValueError, match="cloned voice"):
        T.handle_tts({"id": "j1", "payload": {"text": "hi", "provider": "fish"}})


def test_a_clone_wins_over_a_contradicting_provider(rec, monkeypatch):
    clone_row(rec)
    import voice_clone as VC
    monkeypatch.setattr(VC, "synth", lambda c, t, **k: b"mp3")
    run(rec, voice_clone_id="c1", provider="openai")
    assert rec["asset"]["meta"]["provider"] == "fish"
    assert rec["asset"]["meta"]["voice_clone_id"] == "c1"
    assert not rec["openai"]


def test_a_clone_that_is_still_registering_is_refused(rec):
    clone_row(rec, status="pending")
    with pytest.raises(ValueError, match="not ready"):
        T.handle_tts({"id": "j1", "payload": {"text": "hi", "voice_clone_id": "c1"}})


def test_a_deleted_clone_is_refused(rec):
    with pytest.raises(ValueError, match="no longer exists"):
        T.handle_tts({"id": "j1", "payload": {"text": "hi", "voice_clone_id": "c1"}})


def test_the_delivery_tag_is_placed_only_where_the_engine_reads_one(rec):
    """s2-pro reads v3's bracket grammar; Fish's hosted API applies the clone's
    own prosody and would read a stray tag out loud."""
    assert T._tagged("Hold.", "whispers", "fish-local") == "[whispers] Hold."
    assert T._tagged("Hold.", "whispers", "elevenlabs") == "[whispers] Hold."
    assert T._tagged("Hold.", "whispers", "fish") == "Hold."
    assert T._tagged("Hold.", "whispers", "openai") == "Hold."
    assert T._tagged("Hold.", None, "fish-local") == "Hold."


# ── a designed voice is the SAME voice however it was asked for ─────────────

def test_the_design_branch_builds_the_planner_s_own_sentence():
    """A voice ref made from the bible page and a voice the plan casts have to
    be the same voice.

    The clip a DESIGN produces is not a preview: it becomes the character's
    `voice_ref_asset_id` — what every later line CLONES from, and what the
    reviewer's speaker verifier baselines every take against. This branch used
    to hand the engine the raw delivery note (`Speak A gravelly contralto...`),
    so that reference was designed with no age and no sex in it at all, while
    `dialogue_synth.design_voice` built `A 56-year-old woman, speaking
    English: a gravelly contralto...` for the same character. Two paths
    designing one voice is the drift `voice_engines` exists to end, one layer
    down.
    """
    src = open(T.__file__).read()
    body = src[src.index("# No cast voice and no clone"):]
    body = body[:body.index("voice = f\"{provider}:design\"")]
    assert "ds.voice_instruction(" in body, (
        "the design branch has to use the planner's own builder")
    assert "_speaker_entry(" in body, "...and it needs the identity line to do it"
    # An explicit description still wins — that is a caller describing a voice
    # outright rather than naming a character.
    assert body.index("payload.get(\"instruction\")") < body.index("ds.voice_instruction(")


def test_the_speaker_lookup_fetches_the_identity_line():
    """`_local_voice` and `_el_voice` select `id,name,doc` — enough for a
    voice id and not for a voice. Apparent age and sex live in the identity
    line, which is a COLUMN, not a `doc` key."""
    src = open(T.__file__).read()
    body = src[src.index("def _speaker_entry("):]
    body = body[:body.index("def _el_voice(")]
    assert "identity_line" in body
    # It answers for either spelling: the voice-ref payload sends both, and a
    # line job sends only the speaker.
    assert "speaker_entry_id" in body and "bible_entry_id" in body


def test_a_designed_voice_records_the_sentence_it_was_designed_from():
    """OTHERWISE THE FIX IS INVISIBLE, which is how it was reported: the
    enrichment happens HERE, at render time, from `doc.voice` plus the
    speaker's identity line — so it is in neither the job payload nor the
    asset, and the prompt modal (which renders the payload) shows the same
    bare prose whether the engine got "a low warm alto..." or "A 24-year-old
    woman, speaking English: a low warm alto...". A correct render and a
    broken one looked identical from every surface in the app.

    `dialogue_synth.design_voice` already records its own instruction; this
    branch did not.
    """
    src = open(T.__file__).read()
    meta = src[src.index('meta={"line": text'):]
    meta = meta[:meta.index("origin=") if "origin=" in meta[:200] else 400]
    assert '"instruction": designed' in meta, (
        "the designed instruction has to reach the asset")
    # ...and it is what was SENT, so an empty description records the
    # engine's own fallback rather than "".
    body = src[src.index("# No cast voice and no clone"):]
    body = body[:body.index('voice = f"{provider}:design"')]
    assert "designed = design or fallback" in body
    assert "m.design(designed," in body, "record the same string that was sent"


# ── a LOCAL engine's design IS the character's cast ─────────────────────────

class _StubEngine:
    """The shape `voice_engines.engine(...)` returns, minus the GPU."""
    DEFAULT_INSTRUCTION = "Speak clearly and naturally."

    def __init__(self):
        self.designed = []

    def enabled(self):
        return True

    def design(self, instruction, text, seed=42):
        self.designed.append((instruction, text))
        return b"wav"

    def to_mp3(self, data):
        return b"mp3"


@pytest.fixture
def breeze(rec, monkeypatch):
    """A breeze that designs, over an entry that carries prose and no cast."""
    import voice_engines as ENG
    eng = _StubEngine()
    monkeypatch.setattr(ENG, "engine", lambda name: eng)
    doc = {"voice": "A gravelly contralto.", "speech_pattern": "clipped"}
    rec["rows"]["bible_entries?id=eq.e1&select=id,name,doc"] = [
        {"id": "e1", "name": "Rhea", "doc": doc}]
    rec["rows"]["bible_entries?id=eq.e1&select=id,name,doc,identity_line"] = [
        {"id": "e1", "name": "Rhea", "doc": doc,
         "identity_line": "A 56-year-old woman."}]
    rec["rows"]["bible_entries?id=eq.e1&select=doc"] = [{"doc": doc}]
    rec["engine"] = eng
    return rec


def _entry_patch(rec):
    return next(b for p, b in rec["patched"] if p.startswith("bible_entries?id=eq.e1"))


def test_a_designed_local_voice_is_READ_BACK_as_a_cast_voice(breeze):
    """THE ROUND TRIP, because each half looked correct on its own.

    `handle_tts` wrote `voice_ref_asset_id` and nothing else, which is the
    whole job on ElevenLabs (the voice is a library id the planner writes from
    a table) and half of it on a local engine, where the RECORDING is the
    voice. `dialogue_synth._voice_of_doc` is the only reader, and it answered
    None — so every character came out with a timbre clip on the bible page
    and no cast voice, `plan_lines` refused every block, and a 29-beat episode
    rendered entirely on voice-timbre refs. Nothing errored anywhere.

    Assert through `_voice_of_doc` rather than on the keys: the two files have
    to agree about the SPELLING as well as the write.
    """
    import dialogue_synth as ds
    run(breeze, provider="breeze", speaker_entry_id="e1", bible_entry_id="e1")

    body = _entry_patch(breeze)
    assert body["voice_ref_asset_id"] == "a1", "the timbre pin still happens"
    assert ds._voice_of_doc(body["doc"]) == "breeze:a1", (
        "the designed clip has to read back as this character's cast voice")


def test_the_cast_write_keeps_the_rest_of_the_sheet(breeze):
    """`doc` is ONE jsonb column, so a patch that did not read-modify-write
    would drop the writer's voice prose, the speech pattern and every other
    field on the character sheet."""
    run(breeze, provider="breeze", speaker_entry_id="e1", bible_entry_id="e1")
    doc = _entry_patch(breeze)["doc"]
    assert doc["voice"] == "A gravelly contralto."
    assert doc["speech_pattern"] == "clipped"


def test_the_cast_records_what_the_clip_SAYS(breeze):
    """Every later line CLONES from this clip, and a clone is given
    (audio, text) — so the reference text is not bookkeeping, it is the half
    that makes the clip usable. Same shape `cast_local_voice` stores."""
    run(breeze, provider="breeze", speaker_entry_id="e1", bible_entry_id="e1")
    dv = _entry_patch(breeze)["doc"]["breeze_voice"]
    assert dv["asset_id"] == "a1"
    assert dv["ref_text"] == "Hold the line.", "what was actually recorded"
    assert dv["instruction"], "and the sentence it was designed from"


def test_an_elevenlabs_voice_reference_still_writes_only_the_pin(rec):
    """Nothing changes for the engine whose voice is a library id: its cast is
    the planner's table lookup, and writing a `doc` here would claim this clip
    is the voice."""
    k, v = entry_row("e1", "voice-aki")
    rec["rows"][k] = v
    run(rec, el_voice_id="voice-aki", bible_entry_id="e1")
    assert _entry_patch(rec) == {"voice_ref_asset_id": "a1"}


def test_a_line_read_in_an_ALREADY_CAST_voice_does_not_recast(rec, monkeypatch):
    """The clone branch: the entry is cast, this job is one line read in that
    voice, and repointing the character's voice at a single line's recording
    would replace a purpose-built timbre reference with a performance."""
    import voice_engines as ENG
    import dialogue_synth as ds
    monkeypatch.setattr(ENG, "engine", lambda name: _StubEngine())
    monkeypatch.setattr(ds, "_local_line", lambda *a, **k: b"mp3")
    doc = {"breeze_voice": {"asset_id": "design-clip"}, "voice_provider": "breeze"}
    for q in ("bible_entries?id=eq.e1&select=id,name,doc",
              "bible_entries?id=eq.e1&select=id,name,doc,identity_line"):
        rec["rows"][q] = [{"id": "e1", "name": "Rhea", "doc": doc,
                           "identity_line": "A 56-year-old woman."}]
    run(rec, provider="breeze", speaker_entry_id="e1", bible_entry_id="e1")
    assert "doc" not in _entry_patch(rec), "an existing cast is not repointed"


def test_a_designed_clip_records_the_transcript_a_CLONE_will_need(breeze):
    """Without this the cast is real and every line throws.

    `dialogue_synth._ref_text` reads `meta.speech_text` and RAISES
    ("records no transcript") when it is absent — a clone is handed
    (audio, transcript) and a reference that cannot say what it says is not a
    reference. `handle_tts` recorded `meta.line`, which is the text BEFORE
    `_speech_text` decided what this engine does with its vocal events.

    The failure lands inside `handle_master_pass`'s synth guard, so the block
    degrades to voice-timbre refs — the exact symptom the cast write above
    exists to end, arriving one layer down and looking identical.
    """
    import dialogue_synth as ds
    run(breeze, provider="breeze", speaker_entry_id="e1", bible_entry_id="e1")
    meta = breeze["asset"]["meta"]
    assert meta.get("speech_text"), "a local clip has to record its transcript"

    # The round trip: what the clip RECORDS is what `_ref_text` ASKS FOR.
    # Asserting the key by name would pass just as well with the two files
    # disagreeing about its spelling, which is the whole failure here.
    saved = ds.sb.asset_by_id
    try:
        ds.sb.asset_by_id = lambda aid: {"id": aid, "meta": meta}
        assert ds._ref_text("a1") == meta["speech_text"]
    finally:
        ds.sb.asset_by_id = saved

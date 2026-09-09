"""dialogue_synth's Breeze seam — the pure halves.

A Breeze voice id is `breeze:<clip asset>`, a string, so everything keyed on
voice ids is untouched; what changes is how a line is spelt for each engine,
what the cache key includes, and which engine a plan casts on. Network, DB,
and the synth itself stay stubbed (sb is stubbed before import, exactly as
test_dialogue_synth does).
"""
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_saved = {k: sys.modules.get(k) for k in ("sb", "status")}
sys.modules["sb"] = types.SimpleNamespace(get=lambda *a, **k: [],
                                          asset_by_id=lambda *a: None,
                                          patch=lambda *a, **k: None)
sys.modules["status"] = types.SimpleNamespace(log=lambda *a, **k: None)
import dialogue_synth as DS  # noqa: E402
import breeze_tts as BT  # noqa: E402
for _k, _v in _saved.items():
    if _v is None:
        sys.modules.pop(_k, None)
    else:
        sys.modules[_k] = _v


def _cast():
    return [
        {"id": "m1", "name": "Mara Voss",
         "doc": {"voice_provider": "breeze", "breeze_voice": {"asset_id": "aaaa-1"},
                 "voice": "a low, dry contralto"}},
        {"id": "m2", "name": "Mara Voss — Sable extraction kit",
         "doc": {"variant_of": "m1"}},
        {"id": "o1", "name": "Odile", "doc": {"el_voice_id": "pFZP5JQG7iQjIQuC4Bku"}},
    ]


def test_a_breeze_voice_is_a_string_id_the_variant_inherits():
    cast = _cast()
    by_id = {c["id"]: c for c in cast}
    assert DS._entry_voice(cast[0], by_id) == "breeze:aaaa-1"
    assert DS._entry_voice(cast[1], by_id) == "breeze:aaaa-1"
    assert DS.is_breeze("breeze:aaaa-1") and not DS.is_breeze("pFZP5JQG7iQjIQuC4Bku")
    assert DS.breeze_asset_id("breeze:aaaa-1") == "aaaa-1"


def test_an_explicit_provider_decides_between_two_voices():
    # cast on ElevenLabs by one plan, re-cast on Breeze by a later one: the
    # provider stamp says which, and neither guesses
    both = {"el_voice_id": "X", "breeze_voice": {"asset_id": "B"}}
    assert DS._voice_of_doc({**both, "voice_provider": "breeze"}) == "breeze:B"
    assert DS._voice_of_doc({**both, "voice_provider": "elevenlabs"}) == "X"
    assert DS._voice_of_doc({**both}) == "X"           # unstamped: the older cast wins
    assert DS._voice_of_doc({"breeze_voice": {"asset_id": "B"}}) == "breeze:B"


def test_plan_lines_spells_each_line_for_its_engine():
    items = DS.plan_lines([{"dialogue": [
        {"speaker": "Mara Voss", "line": "(sigh) Terms.", "delivery": "through a held breath"},
        {"speaker": "Odile", "line": "(sigh) Terms.", "delivery": "through a held breath"},
    ]}], _cast())
    mara, odile = items
    # Breeze keeps the event in its own spelling and takes the delivery as an
    # instruction; ElevenLabs gets the tag spelling and its delivery tag
    assert mara["speech_text"] == "(sigh) Terms."
    assert mara["instruction"] == "Speak through a held breath."
    # ...the delivery tag ("held breath" -> [exhales]) AND the event's tag
    assert odile["speech_text"] == "[exhales] [sighs] Terms."
    assert "instruction" not in odile
    # ...and the words are the same on both, which is what the envelope binds
    assert mara["line"] == odile["line"] == "(sigh) Terms."


def test_the_cache_key_includes_the_instruction_on_breeze_only():
    a = DS.line_key("breeze:aaaa-1", "Terms.", "Speak slowly.")
    b = DS.line_key("breeze:aaaa-1", "Terms.", None)
    assert a != b
    # the ElevenLabs key is byte-stable: an instruction cannot reach that engine
    assert DS.line_key("X", "Terms.", "Speak slowly.") == DS.line_key("X", "Terms.")


def test_a_plain_delivery_is_no_instruction_at_all():
    assert DS._instruction(None) is None
    assert DS._instruction("calm") is None
    assert DS._instruction("grinning") == "Speak grinning."
    assert DS._instruction("speak slowly, flat") == "speak slowly, flat."


def test_voice_instruction_carries_age_and_sex_from_the_identity_line():
    ins = DS.voice_instruction("a low, gravelly voice, slow deliberate pace",
                               "A 50s man with a broad heavy build and a grey beard")
    assert ins.startswith("A 50s man"), ins
    assert "low, gravelly voice" in ins
    ins2 = DS.voice_instruction("warm mezzo-soprano", "late 20s woman, black bob")
    assert ins2.startswith("A late 20s woman"), ins2
    assert DS.voice_instruction("", "").endswith("natural, clear voice.")


def test_the_identity_line_outranks_the_vocal_range():
    """They are different KINDS of evidence and only one of them decides.

    `_FEM` matches "contralto" and "mezzo" because a range really is evidence
    about a voice — but it is evidence only where nothing was said outright,
    and reading one combined string let the range win whenever it happened to
    come first. It always does: `doc.voice` is passed before the identity
    line."""
    ins = DS.voice_instruction("a light, reedy alto",
                               "A 60-year-old man with a stooped frame; his hands shake")
    assert ins.startswith("A 60-year-old man"), ins
    # ...and the range still answers when the identity line says nothing.
    assert DS.voice_instruction("a warm tenor", "a figure in a long coat"
                                ).startswith("A man"), "the range is the fallback"


def test_a_nonbinary_character_is_not_designed_as_a_woman():
    """MEASURED on this studio's own bible: Juno Vale is filed "23-year-old
    nonbinary person" and described as "a quick bright mezzo voice", and the
    combined-string rule cast them as a woman off the word "mezzo" — the
    studio misgendering its own cast, in the clip that becomes the character's
    permanent timbre reference. They are the one character of 92 whose `who`
    this rule changes; the other 91 are identical."""
    ins = DS.voice_instruction(
        "A quick bright mezzo voice with a restless pace and a broad belt-station accent.",
        "23-year-old nonbinary person with black curly hair shaved at one temple")
    assert ins.startswith("A 23-year-old person,"), ins
    assert "mezzo" in ins, "the range still describes the voice"
    for spelling in ("non-binary", "enby", "genderqueer", "agender"):
        assert DS.voice_instruction("a soprano", f"a 30-year-old {spelling} lead"
                                    ).startswith("A 30-year-old person"), spelling


def test_an_all_breeze_exchange_ignores_the_elevenlabs_voice_ceiling():
    cast = [{"id": f"c{i}", "name": f"P{i}",
             "doc": {"voice_provider": "breeze", "breeze_voice": {"asset_id": f"a{i}"}}}
            for i in range(12)]
    items = DS.plan_lines([{"dialogue": [{"speaker": f"P{i}", "line": "Hi."} for i in range(12)]}],
                          cast)
    assert items is not None and len(items) == 12


def test_canonical_ref_of_a_breeze_voice_is_its_designed_clip():
    assert DS.canonical_ref_asset("breeze:aaaa-1", "Mara", "p") == "aaaa-1"


def test_concat_wavs_reports_exact_line_starts():
    import wave, io
    def tone(ms):
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(BT.SAMPLE_RATE)
            w.writeframes(b"\x01\x00" * int(BT.SAMPLE_RATE * ms / 1000))
        return buf.getvalue()
    wav, starts = BT.concat_wavs([tone(1000), tone(500)], gap_ms=350, lead_ms=250)
    assert starts == [250, 250 + 1000 + 350]
    assert BT.wav_duration_ms(wav) == 250 + 1000 + 350 + 500


def test_resolve_provider_never_swaps_silently(monkeypatch):
    # "neither engine" was accurate while there were exactly two. There are
    # three now (breeze, qwen, elevenlabs) and the count is open, so the
    # message generalised with the code — the BEHAVIOUR under test, that a
    # swap is always reported and an impossible one refused, is unchanged.
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("BREEZE_TTS_URL", raising=False)
    monkeypatch.delenv("QWEN_TTS_URL", raising=False)
    assert DS.resolve_provider("breeze") == (None, "breeze was asked for and no engine is available")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    prov, why = DS.resolve_provider("breeze")
    assert prov == "elevenlabs" and "breeze was asked for" in why
    monkeypatch.setenv("BREEZE_TTS_URL", "http://127.0.0.1:7860")
    monkeypatch.setattr(BT, "health", lambda timeout=5: {"status": "ok"})
    assert DS.resolve_provider("breeze") == ("breeze", None)
    assert DS.resolve_provider("elevenlabs") == ("elevenlabs", None)
    monkeypatch.delenv("DIALOGUE_PROVIDER", raising=False)
    assert DS.provider_default() == "breeze"

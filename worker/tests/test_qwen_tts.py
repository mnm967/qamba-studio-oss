"""Qwen3-TTS as a second LOCAL voice engine, and the contract that makes a
third one a table row rather than thirty more branches.

Most of what is pinned here is a hazard that was live while this was written,
not a hypothetical: the cache key that would have orphaned every clip on B2,
the module name that would have shadowed the pip package, the delivery
instruction one engine cannot use, and the event spelling one engine would
read aloud. None of those fails loudly.
"""
import hashlib
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
_saved = {k: sys.modules.get(k) for k in ("sb", "status")}
sys.modules["sb"] = types.SimpleNamespace(get=lambda *a, **k: [],
                                          asset_by_id=lambda *a: None)
sys.modules["status"] = types.SimpleNamespace(log=lambda *a, **k: None)
import dialogue_synth as DS  # noqa: E402
import qwen_voice as QV  # noqa: E402
import voice_engines as ENG  # noqa: E402
for _k, _v in _saved.items():
    if _v is None:
        sys.modules.pop(_k, None)
    else:
        sys.modules[_k] = _v


# --------------------------------------------------------------- the wire --

def test_the_client_and_the_server_agree_about_multipart():
    """The one seam between two files that never run in the same interpreter.

    `qwen_voice` builds the body in the worker's Python and
    `qwen_tts_serve.parse_multipart` reads it in the Qwen venv's, so nothing
    else would catch a disagreement — and `cgi` is gone in 3.13, so the
    server's reader is `email`, not the stdlib helper the client was written
    against."""
    import qwen_tts_serve as SRV
    body, ctype = QV._multipart(
        {"text": "Hello there.", "seed": "42", "language": "English",
         "instruction": "", "ref_text": "a plain sentence"},
        {"ref_audio": ("reference.wav", b"RIFF\x00\x00\xff\xfe binary", "audio/wav")})
    fields, files = SRV.parse_multipart(body, ctype)
    assert fields["text"] == "Hello there."
    assert fields["seed"] == "42"
    assert fields["language"] == "English"
    assert fields["ref_text"] == "a plain sentence"
    # The last field must survive — an off-by-one in a hand-rolled scanner
    # drops exactly this one and nothing says so.
    assert set(fields) == {"text", "seed", "language", "instruction", "ref_text"}
    assert files["ref_audio"] == b"RIFF\x00\x00\xff\xfe binary"


def test_a_unicode_field_survives_the_wire():
    """The prose is the voice: an em dash or a name with an accent in the
    instruction is ordinary here, and a latin-1 round trip would mangle it."""
    import qwen_tts_serve as SRV
    ins = "A 60-year-old woman, speaking English: warm, unhurried — a little dry."
    body, ctype = QV._multipart({"instruction": ins, "text": "x"}, {})
    fields, _ = SRV.parse_multipart(body, ctype)
    assert fields["instruction"] == ins


# ------------------------------------------------------- the engine table --

REQUIRED = ("enabled", "health", "speak", "design", "to_mp3", "wav_duration_ms",
            "concat_wavs", "write_temp", "park", "unpark", "gpu_busy",
            "ensure_up", "not_serving_reason")


def test_every_engine_provides_the_whole_surface():
    """What makes `voice_engines` a dict lookup instead of a branch. An engine
    missing one of these fails at the call site that needs it, which is
    somewhere in the middle of an episode's plan."""
    for name in ENG.ENGINES:
        m = ENG.engine(name)
        missing = [f for f in REQUIRED if not callable(getattr(m, f, None))]
        assert not missing, f"{name} is missing {missing}"
        assert isinstance(getattr(m, "SAMPLE_RATE", None), int)
        assert isinstance(getattr(m, "MODEL_ID", None), str)


def test_every_local_engine_is_24k_mono():
    """`_assemble_exchange` lays clips end to end and reports their spans with
    no resample, so an engine at another rate puts every line after the first
    at the wrong timestamp — and the audio still plays, so nothing complains."""
    for name in ENG.ENGINES:
        assert ENG.engine(name).SAMPLE_RATE == DS.LOCAL_SAMPLE_RATE == 24000


def test_a_voice_id_round_trips_and_a_vendor_id_is_not_local():
    for name in ENG.ENGINES:
        vid = ENG.voice_id(name, "asset-1")
        assert ENG.split(vid) == (name, "asset-1")
        assert ENG.is_local(vid)
    # An ElevenLabs id, a Fish reference id: no prefix, not ours.
    assert ENG.split("EXAVITQu4vr4xnSDxMaL") == (None, None)
    assert not ENG.is_local("EXAVITQu4vr4xnSDxMaL")
    assert ENG.engine_of("EXAVITQu4vr4xnSDxMaL") is None


def test_our_module_does_not_shadow_the_pip_package():
    """`qwen_tts_serve` does `from qwen_tts import Qwen3TTSModel` with
    sys.path[0] == worker/. A client module called `qwen_tts` would win that
    lookup and the server could never load a checkpoint."""
    assert ENG.ENGINES["qwen"] == "qwen_voice"
    assert not (Path(__file__).parent.parent / "qwen_tts.py").exists()


# ------------------------------------------------------------ cache keys --

def test_the_breeze_cache_key_did_not_move():
    """GENERALISING `line_key` MUST NOT ORPHAN THE CACHE. Every line clip on
    B2 is keyed by this hash and `beats.meta.xchg` pins a run of shots to a
    recording by it, so a changed value re-synthesises every clip this studio
    has recorded AND unpins every exchange — silently, because a miss is a
    legal path. The literal below is the formula the Breeze-only version
    used."""
    want = hashlib.sha1(
        b"breeze-tts-2|breeze:abc|Hello there.|Speak warmly.").hexdigest()[:16]
    assert DS.line_key("breeze:abc", "Hello there.", "Speak warmly.") == want
    el = hashlib.sha1(b"eleven_v3|EXAV|Hello there.").hexdigest()[:16]
    assert DS.line_key("EXAV", "Hello there.") == el


def test_the_engine_model_ids_are_the_ones_the_keys_were_built_with():
    """The two halves of the line above: `breeze_tts.MODEL_ID` is what
    `_model_id_of` returns, and it has to equal the constant the old branch
    hardcoded."""
    assert ENG.engine("breeze").MODEL_ID == DS.BREEZE_MODEL_ID == "breeze-tts-2"
    assert DS._model_id_of("breeze:a") == "breeze-tts-2"
    assert DS._model_id_of("qwen:a") == ENG.engine("qwen").MODEL_ID
    assert DS._model_id_of("EXAV") == DS.MODEL_ID


def test_two_engines_designing_from_one_description_do_not_share_a_clip(monkeypatch):
    """The designed clip is the character's timbre reference and every line
    clones from it, so a cache keyed without the engine would hand a re-cast
    character the OTHER model's voice."""
    seen = []
    monkeypatch.setattr(DS.sb, "get", lambda q, *a, **k: seen.append(q) or [])
    for name in ("breeze", "qwen"):
        try:
            DS.design_voice("Haru", "a soft, breathy baritone", "23-year-old man",
                            "p1", engine=name)
        except Exception:  # noqa: BLE001 — it stops at the (stubbed) synthesis
            pass
    assert len(seen) == 2 and seen[0] != seen[1]
    assert "breeze_" in seen[0] and "qwen_" in seen[1]


# ------------------------------------------------- what the engines differ on --

def test_only_an_engine_that_can_direct_is_asked_to(monkeypatch):
    """Breeze steers a cloned line from the delivery note; Qwen's
    `generate_voice_clone` takes no `instruct` at all. The note is dropped
    BEFORE the call, so a Qwen line never carries one its own client would
    have to warn about."""
    assert ENG.supports_direction("breeze:a") is True
    assert ENG.supports_direction("qwen:a") is False
    assert ENG.supports_direction("EXAV") is False

    got = {}
    monkeypatch.setattr(DS, "_ref_clip", lambda a: "/tmp/ref.wav")
    monkeypatch.setattr(DS, "_ref_text", lambda a: "a plain sentence")
    for name in ("breeze", "qwen"):
        m = ENG.engine(name)
        monkeypatch.setattr(m, "speak",
                            lambda t, **kw: got.__setitem__(name, kw) or b"WAV")
        monkeypatch.setattr(m, "to_mp3", lambda d, **kw: b"MP3")
        DS._local_line(f"{name}:a", "Hello.", "Speak warmly.")
    assert got["breeze"]["instruction"] == "Speak warmly."
    assert got["qwen"]["instruction"] is None


def test_each_engine_spells_a_vocal_event_its_own_way():
    """Breeze PERFORMS "(sigh)"; Qwen has no documented event vocabulary and
    would read the word aloud, so the events are stripped to the words to
    lip-sync. Declared per engine (`EVENT_STYLE`) so a new one states its own
    answer instead of inheriting Breeze's."""
    line = "(sigh) It's good to hear your voice."
    assert DS._speech_text(line, None, "breeze:a") == line
    assert DS._speech_text(line, None, "qwen:a") == "It's good to hear your voice."
    assert "[sighs]" in DS._speech_text(line, None, "EXAV")


def test_a_qwen_cast_character_is_read_off_the_doc(monkeypatch):
    """`doc.<engine>_voice.asset_id` + `doc.voice_provider`. The Breeze
    spelling is what every row written before a second engine carries and it
    keeps meaning exactly what it meant."""
    assert DS._voice_of_doc({"voice_provider": "qwen",
                             "qwen_voice": {"asset_id": "Q1"}}) == "qwen:Q1"
    assert DS._voice_of_doc({"voice_provider": "breeze",
                             "breeze_voice": {"asset_id": "B1"}}) == "breeze:B1"
    assert DS._voice_of_doc({"el_voice_id": "EXAV"}) == "EXAV"
    # An explicit provider wins over a clip the other engine left behind.
    assert DS._voice_of_doc({"voice_provider": "elevenlabs", "el_voice_id": "EXAV",
                             "breeze_voice": {"asset_id": "B1"}}) == "EXAV"


def test_the_designed_clip_is_its_own_reference_on_every_local_engine():
    """The speaker verifier's baseline. Every line was cloned FROM this clip,
    so there is nothing to synthesize — true of any local engine, which is
    why `canonical_ref_asset` asks `is_local` and not the engine."""
    for name in ENG.ENGINES:
        assert DS.canonical_ref_asset(f"{name}:aaaa-1", "Mara", "p") == "aaaa-1"


# ------------------------------------------------------------- resolution --

def test_a_local_engine_falls_back_to_the_other_local_one_first(monkeypatch):
    """Both design from the writer's prose, so the cast still comes out of the
    description. ElevenLabs falls back to a TABLE of library voices, which is
    a different kind of answer and the further one from what was asked for."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    monkeypatch.setattr(ENG, "serving", lambda n: n == "qwen")
    monkeypatch.setattr(ENG, "available", lambda: ["qwen"])
    prov, why = DS.resolve_provider("breeze")
    assert prov == "qwen" and "breeze was asked for" in why and "qwen" in why

    monkeypatch.setattr(ENG, "serving", lambda n: False)
    monkeypatch.setattr(ENG, "available", lambda: [])
    prov, why = DS.resolve_provider("breeze")
    assert prov == "elevenlabs" and "ElevenLabs" in why


def test_qwen_refuses_rather_than_guessing(monkeypatch):
    monkeypatch.delenv("QWEN_TTS_URL", raising=False)
    for bad in ("", "   "):
        try:
            QV.speak(bad, instruction="a warm voice")
            assert False, "empty text should raise"
        except (ValueError, RuntimeError):
            pass
    # Neither a reference nor an instruction is not a mode.
    monkeypatch.setenv("QWEN_TTS_URL", "http://127.0.0.1:7870")
    try:
        QV.speak("Hello.")
        assert False, "no mode should raise"
    except ValueError as e:
        assert "reference" in str(e)


def test_the_two_checkpoints_are_named_and_are_not_the_same_one():
    """The pair IS the unit: `generate_voice_design` raises unless the
    checkpoint is the VoiceDesign one and `generate_voice_clone` raises unless
    it is Base, so a single-checkpoint install can design and never speak a
    second line in the same voice."""
    assert "VoiceDesign" in QV.DESIGN_REPO
    assert QV.CLONE_REPO.endswith("-Base")
    assert QV.DESIGN_REPO != QV.CLONE_REPO


def test_an_unusable_lock_file_does_not_fail_the_line(monkeypatch, tmp_path, capsys):
    """`fs.protected_regular` makes a /tmp lock owned by another user
    permanently unopenable — root included. Measured on the pod 2026-09-07,
    where an install run over SSM (root) left a lock the `ubuntu` worker could
    stat and not open. The client lock is BEST EFFORT (the server holds its
    own request lock), so losing it must cost concurrency and never a line."""
    import contextlib

    for mod in (QV, __import__("breeze_tts")):
        mod._warned.clear()
        # a path open() refuses, exactly as EPERM on a foreign /tmp lock does
        monkeypatch.setattr(mod, "LOCK_PATH", str(tmp_path / "nope" / "x.lock"))
        with contextlib.ExitStack() as stack:
            mod._flock(stack, print)          # must not raise
        said = capsys.readouterr().out
        assert "not usable" in said, f"{mod.__name__} said nothing about the lock"
        assert "server serialises" in said, f"{mod.__name__} did not say why it is safe"


def test_the_lock_is_only_ever_taken_when_fcntl_exists(monkeypatch, tmp_path):
    """Windows has no fcntl and the desktop runs one job at a time."""
    import contextlib
    monkeypatch.setattr(QV, "fcntl", None)
    monkeypatch.setattr(QV, "LOCK_PATH", str(tmp_path / "nope" / "x.lock"))
    with contextlib.ExitStack() as stack:
        QV._flock(stack, print)

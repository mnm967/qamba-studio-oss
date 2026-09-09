"""Cloned voices — the provider layer and the registration job.

Two providers that mean different things by "clone", behind one interface.
What is worth pinning:

  * a zero-shot clone has NO reference id, and that is correct rather than
    pending. Treat a null id as failure and the local provider can never
    finish; treat it as success on the hosted one and every line renders in a
    stranger's voice.
  * sample length. It is the single most common reason a clone sounds nothing
    like the speaker, it is knowable before a single credit is spent, and both
    providers publish the same 10-30s window.
  * every failure resolves the ROW. A job that dies while `voice_clones.status`
    stays `pending` is a spinner that never ends and never says why.
"""
import os

import pytest

import voice_clone as VC
import handlers.voice as V


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    monkeypatch.setattr(VC, "log", lambda *a, **k: None)
    monkeypatch.setattr(V, "log", lambda *a, **k: None)


# ------------------------------------------------------- availability ----

def test_a_provider_with_no_key_is_reported_not_offered(monkeypatch):
    monkeypatch.delenv("FISH_API_KEY", raising=False)
    ok, why = VC.providers()["fish"]
    assert ok is False and "FISH_API_KEY" in why


def test_the_local_provider_needs_both_the_weights_and_the_repo(monkeypatch, tmp_path):
    monkeypatch.setattr(VC, "S2_ROOT", str(tmp_path / "s2"))
    monkeypatch.setattr(VC, "S2_REPO", str(tmp_path / "repo"))
    assert VC.providers()["fish-local"][0] is False
    (tmp_path / "s2").mkdir()
    (tmp_path / "s2" / "codec.pth").write_text("x")
    # weights but no inference tree — still not runnable
    assert VC.providers()["fish-local"][0] is False
    (tmp_path / "repo").mkdir()
    assert VC.providers()["fish-local"][0] is True


def test_registering_on_an_unavailable_provider_raises_with_the_reason(monkeypatch):
    monkeypatch.delenv("FISH_API_KEY", raising=False)
    with pytest.raises(VC.CloneError, match="FISH_API_KEY"):
        VC.register("fish", name="x", sample_path="/tmp/x.mp3", duration_ms=15_000)


# ------------------------------------------------------------ samples ----

@pytest.mark.parametrize("ms", [0, None, 1_500, 3_999])
def test_an_unusable_sample_is_refused_before_a_credit_is_spent(ms):
    with pytest.raises(VC.CloneError):
        VC.check_sample(ms)


def test_a_very_long_sample_is_refused_rather_than_truncated(monkeypatch):
    with pytest.raises(VC.CloneError, match="trim"):
        VC.check_sample(300_000)


@pytest.mark.parametrize("ms", [10_000, 20_000, 30_000])
def test_the_published_window_passes_with_no_warning(ms):
    assert VC.check_sample(ms) == ""


def test_a_short_but_usable_sample_warns_instead_of_failing():
    """6s can work and often does. Refusing it would be wrong; saying nothing
    means a poor clone with no explanation."""
    w = VC.check_sample(6_000)
    assert w and "short" in w


def test_a_long_but_usable_sample_warns():
    assert "room tone" in VC.check_sample(60_000)


# ----------------------------------------------------------- register ----

def test_zero_shot_registration_returns_no_id_and_that_is_success(monkeypatch, tmp_path):
    monkeypatch.setattr(VC, "S2_ROOT", str(tmp_path / "s2"))
    monkeypatch.setattr(VC, "S2_REPO", str(tmp_path / "repo"))
    (tmp_path / "s2").mkdir(); (tmp_path / "s2" / "codec.pth").write_text("x")
    (tmp_path / "repo").mkdir()
    rid, warn = VC.register("fish-local", name="Rei", sample_path="/nope",
                            duration_ms=15_000)
    assert rid is None and warn == ""


def test_the_hosted_registration_posts_a_private_fast_tts_model(monkeypatch, tmp_path):
    """`visibility` is the sharp one: this is somebody's recorded voice, and
    the endpoint's own default puts a model on a public discovery page."""
    sample = tmp_path / "s.mp3"
    sample.write_bytes(b"audio")
    monkeypatch.setenv("FISH_API_KEY", "k")
    seen = {}

    class R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"_id": "voice-123"}'

    def urlopen(req, timeout=0):
        seen["url"] = req.full_url
        seen["auth"] = req.headers.get("Authorization")
        seen["body"] = req.data.decode("utf-8", "replace")
        return R()

    monkeypatch.setattr(VC.urllib.request, "urlopen", urlopen)
    rid, _ = VC.register("fish", name="Rei", sample_path=str(sample),
                         sample_text="hello there", duration_ms=15_000)
    assert rid == "voice-123"
    assert seen["url"].endswith("/model")
    assert seen["auth"] == "Bearer k"
    for field in ('name="type"', "tts", 'name="visibility"', "private",
                  'name="train_mode"', "fast", 'name="voices"', "hello there"):
        assert field in seen["body"], field


def test_a_response_with_no_id_is_an_error_not_a_clone(monkeypatch, tmp_path):
    sample = tmp_path / "s.mp3"; sample.write_bytes(b"a")
    monkeypatch.setenv("FISH_API_KEY", "k")

    class R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"detail": "quota"}'

    monkeypatch.setattr(VC.urllib.request, "urlopen", lambda *a, **k: R())
    with pytest.raises(VC.CloneError, match="no model id"):
        VC.register("fish", name="x", sample_path=str(sample), duration_ms=15_000)


def test_the_id_is_read_under_either_spelling(monkeypatch, tmp_path):
    sample = tmp_path / "s.mp3"; sample.write_bytes(b"a")
    monkeypatch.setenv("FISH_API_KEY", "k")

    class R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"id": "v9"}'

    monkeypatch.setattr(VC.urllib.request, "urlopen", lambda *a, **k: R())
    assert VC.register("fish", name="x", sample_path=str(sample),
                       duration_ms=15_000)[0] == "v9"


# -------------------------------------------------------------- synth ----

def test_a_hosted_clone_with_no_id_yet_refuses_rather_than_using_a_stock_voice(monkeypatch):
    monkeypatch.setenv("FISH_API_KEY", "k")
    with pytest.raises(VC.CloneError, match="registration"):
        VC.synth({"provider": "fish", "name": "Rei", "reference_id": None}, "hi")


def test_a_zero_shot_clone_with_no_clip_refuses_rather_than_rendering_a_stranger(
        monkeypatch, tmp_path):
    monkeypatch.setattr(VC, "S2_ROOT", str(tmp_path / "s2"))
    monkeypatch.setattr(VC, "S2_REPO", str(tmp_path / "repo"))
    (tmp_path / "s2").mkdir(); (tmp_path / "s2" / "codec.pth").write_text("x")
    (tmp_path / "repo").mkdir()
    with pytest.raises(VC.CloneError, match="reference clip"):
        VC.synth({"provider": "fish-local", "name": "Rei"}, "hi", sample_path=None)


def test_a_hosted_clone_speaks_through_the_fish_reference_id(monkeypatch):
    monkeypatch.setenv("FISH_API_KEY", "k")
    import genmedia
    seen = {}

    def gen(text, **kw):
        seen.update(kw); seen["text"] = text
        return b"mp3", 1.0, "fish"

    monkeypatch.setattr(genmedia, "generate_audio", gen)
    out = VC.synth({"provider": "fish", "name": "Rei", "reference_id": "v1"}, "hello")
    assert out == b"mp3"
    assert seen["fish_reference_id"] == "v1"


# ---------------------------------------------------------------- job ----

@pytest.fixture
def job(monkeypatch, tmp_path):
    state = {"clone": {"id": "c1", "name": "Rei", "provider": "fish",
                       "sample_asset_id": "a1", "sample_text": "", "status": "pending"},
             "asset": {"id": "a1", "b2_key": "audio/x.mp3", "kind": "audio",
                       "duration_ms": 15_000},
             "patches": []}

    def get(q):
        if q.startswith("voice_clones?"):
            return [state["clone"]] if state["clone"] else []
        if q.startswith("assets?"):
            return [state["asset"]] if state["asset"] else []
        return []

    monkeypatch.setattr(V.sb, "get", get)
    monkeypatch.setattr(V.sb, "patch", lambda p, b: state["patches"].append(b))
    monkeypatch.setattr(V.sb, "job_progress", lambda *a, **k: None)
    monkeypatch.setattr(V.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(V.media, "b2_get", lambda k, d: None)
    monkeypatch.setattr(V.media, "probe", lambda p: {"duration_ms": state["asset"]["duration_ms"]})
    monkeypatch.setattr(V.os, "remove", lambda p: None)
    monkeypatch.setattr(V.VC, "register", lambda *a, **k: ("voice-1", ""))
    return state


def run(job_state, **payload):
    payload.setdefault("voice_clone_id", "c1")
    V.handle_voice_clone({"id": "j1", "payload": payload})
    return job_state


def test_a_successful_registration_marks_the_row_ready_with_its_id(job):
    patch = run(job)["patches"][-1]
    assert patch["status"] == "ready"
    assert patch["reference_id"] == "voice-1"
    assert patch["error_msg"] is None


def test_the_warning_rides_on_the_row_rather_than_only_the_log(job, monkeypatch):
    monkeypatch.setattr(V.VC, "register", lambda *a, **k: ("v", "6.0s is short"))
    assert "short" in run(job)["patches"][-1]["meta"]["warning"]


def test_a_failed_registration_resolves_the_row_to_error(job, monkeypatch):
    monkeypatch.setattr(V.VC, "register",
                        lambda *a, **k: (_ for _ in ()).throw(VC.CloneError("quota")))
    with pytest.raises(VC.CloneError):
        run(job)
    assert job["patches"][-1] == {"status": "error", "error_msg": "quota"}


def test_a_missing_sample_is_an_error_on_the_row_not_a_silent_pending(job):
    job["asset"] = None
    with pytest.raises(Exception):
        run(job)
    assert job["patches"][-1]["status"] == "error"
    assert "missing" in job["patches"][-1]["error_msg"]


def test_a_non_audio_sample_is_refused(job):
    job["asset"] = {**job["asset"], "kind": "image"}
    with pytest.raises(Exception):
        run(job)
    assert "audio file" in job["patches"][-1]["error_msg"]


def test_a_deleted_clone_is_survivable(job):
    """The job outlived the row. Nothing to register and nothing to fail."""
    job["clone"] = None
    run(job)
    assert job["patches"] == []


def test_the_probe_beats_the_stored_duration(job, monkeypatch):
    """`asset_ingest` fills duration_ms and may not have run yet, so the length
    check probes the file rather than trusting job ordering."""
    job["asset"] = {**job["asset"], "duration_ms": None}
    monkeypatch.setattr(V.media, "probe", lambda p: {"duration_ms": 12_000})
    seen = {}
    monkeypatch.setattr(V.VC, "register",
                        lambda *a, **k: (seen.update(k), ("v", ""))[1])
    run(job)
    assert seen["duration_ms"] == 12_000


# ------------------------------------------------------ elevenlabs ----
# The one whose clone is worth the most: what `/v1/voices/add` returns is an
# ordinary ElevenLabs voice id — the same kind of value `doc.el_voice_id`
# holds — so it needs no synthesis path of its own AND it can be cast onto a
# character for a whole episode. Neither Fish provider can, because
# `dialogue_synth` is ElevenLabs-only.

def el_response(monkeypatch, body):
    class R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return body

    seen = {}

    def urlopen(req, timeout=0):
        seen["url"] = req.full_url
        seen["key"] = req.headers.get("Xi-api-key") or req.headers.get("xi-api-key")
        seen["body"] = req.data.decode("utf-8", "replace")
        return R()

    monkeypatch.setattr(VC.urllib.request, "urlopen", urlopen)
    return seen


def test_an_elevenlabs_clone_registers_and_returns_a_voice_id(monkeypatch, tmp_path):
    sample = tmp_path / "s.mp3"; sample.write_bytes(b"a")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    seen = el_response(monkeypatch, b'{"voice_id":"v-el-1","requires_verification":false}')
    rid, warn = VC.register("elevenlabs", name="Rei", sample_path=str(sample),
                            duration_ms=15_000)
    assert rid == "v-el-1" and warn == ""
    assert seen["url"].endswith("/v1/voices/add")
    assert seen["key"] == "k"
    assert 'name="files"' in seen["body"]
    # Their own noise isolation: what people upload is a phone recording.
    assert 'name="remove_background_noise"' in seen["body"]


def test_a_voice_needing_verification_is_an_error_not_a_ready_voice(monkeypatch, tmp_path):
    """It exists and it cannot speak. Marking it ready would put a voice in the
    picker that fails at synthesis — the exact shape this panel was rebuilt to
    remove."""
    sample = tmp_path / "s.mp3"; sample.write_bytes(b"a")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    el_response(monkeypatch, b'{"voice_id":"v1","requires_verification":true}')
    with pytest.raises(VC.CloneError, match="verification"):
        VC.register("elevenlabs", name="x", sample_path=str(sample), duration_ms=15_000)


def test_an_elevenlabs_clone_speaks_through_the_existing_dialogue_path(monkeypatch):
    """No new synthesis code: the function every dialogue block already uses
    takes a voice id, and a clone's id is one."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    import dialogue_synth as ds
    seen = {}
    monkeypatch.setattr(ds, "_synth", lambda vid, text: seen.update(v=vid, t=text) or b"mp3")
    out = VC.synth({"provider": "elevenlabs", "name": "Rei", "reference_id": "v-el-1"},
                   "hello")
    assert out == b"mp3"
    assert seen["v"] == "v-el-1" and seen["t"] == "hello"


def test_an_elevenlabs_clone_with_no_id_refuses(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    with pytest.raises(VC.CloneError, match="registration"):
        VC.synth({"provider": "elevenlabs", "name": "Rei", "reference_id": None}, "hi")


def test_recast_voice_accepts_a_cloned_voice_id():
    """The guard used to be `voice_id in VOICE_TABLE`, so a clone was rejected
    as 'not a voice' — a voice that renders perfectly in the studio panel and
    can never be cast. Both director twins widen it to the project's clones."""
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2]
    py = (root / "worker" / "director_tools.py").read_text()
    js = (root / "director" / "tools.js").read_text()
    for src, who in ((py, "worker"), (js, "hosted")):
        assert "voice_clones?provider=eq.elevenlabs" in src, who
        # …and in BOTH executors, not just the lookup one.
        assert src.count("voice_clones?provider=eq.elevenlabs") >= 2, (
            f"{who}: list_voices and recast_voice must both see clones — a "
            f"voice the director cannot list is one it can never cast")


def test_a_breeze_clone_writes_its_transcript_back_onto_the_row(monkeypatch):
    """`sb` WAS NEVER IMPORTED in this module, so this write raised NameError
    into an advisory `except` on every line — the transcript was never saved
    and a whole episode re-derived it from ASR, once per line, silently.

    That is exactly what an advisory handler is for and exactly why one hides
    a bug this well: the feature worked, slowly, and said nothing."""
    import voice_clone as VC
    calls = []
    monkeypatch.setattr(VC.sb, "patch", lambda path, row: calls.append((path, row)))
    monkeypatch.setattr("audioqa.transcribe", lambda p: ([], "the words"))

    import breeze_tts as BT
    monkeypatch.setattr(BT, "speak", lambda *a, **k: b"RIFFwav")
    monkeypatch.setattr(BT, "to_mp3", lambda w, **k: b"ID3mp3")

    clone = {"id": "c1", "name": "Nia", "provider": "breeze", "sample_text": ""}
    out = VC._breeze_clone(clone, "hello", "/tmp/ref.wav", None)
    assert out == b"ID3mp3"
    assert calls == [("voice_clones?id=eq.c1", {"sample_text": "the words"})]
    # ...and it is on the dict too, so THIS run does not re-transcribe either.
    assert clone["sample_text"] == "the words"


def test_every_provider_the_worker_offers_is_allowed_by_the_newest_check():
    """THE NEWEST MIGRATION IS THE LIVE CONSTRAINT — `drop constraint if
    exists` then `add`, so the last one to run wins and a scan pinned to a
    filename keeps passing while the database moves on. Same rule
    `test_byok.py`'s own SQL scanner follows.

    Breeze was implemented in this module for its whole life and could not be
    written: an insert is a PostgREST 400 on the one click that matters."""
    import glob
    import re
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    root = os.path.dirname(here)
    newest, allowed = None, None
    for f in sorted(glob.glob(os.path.join(root, "supabase", "migrations", "*.sql"))):
        sql = open(f, encoding="utf-8").read()
        m = re.search(r"voice_clones_provider_check\s*\n?\s*check\s*\(provider in \(([^)]*)\)",
                      sql)
        if m:
            newest, allowed = f, set(re.findall(r"'([^']+)'", m.group(1)))
    assert allowed, "no migration defines voice_clones_provider_check"

    import voice_clone as VC
    # `providers()` is what the UI lists; every one of them has to be a value
    # the row can hold. `fish-local` and `breeze` are zero-shot and store no
    # reference id, which is orthogonal to being writable at all.
    offered = set(VC.providers().keys())
    missing = offered - allowed
    assert not missing, (f"{sorted(missing)} can be offered and not stored "
                         f"({os.path.basename(newest)} allows {sorted(allowed)})")


def test_a_missing_key_names_the_place_it_is_missing_from(monkeypatch):
    """Not the same place twice. On the pod it is `/etc/neon-worker.env`, a
    file the studio's owner edits; on a desktop it is this machine's own
    keychain — so "unset on the pod" names a box the reader does not have."""
    import voice_clone as VC
    monkeypatch.delenv("FISH_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.setattr("breeze_tts.enabled", lambda: False)

    monkeypatch.delenv("MODEL_TIER", raising=False)
    pod = VC.providers()
    assert "unset on the pod" in pod["fish"][1]
    assert "unset on the pod" in pod["elevenlabs"][1]

    monkeypatch.setenv("MODEL_TIER", "desktop")
    desk = VC.providers()
    for p, vendor in (("fish", "Fish Audio"), ("elevenlabs", "ElevenLabs")):
        why = desk[p][1]
        assert "pod" not in why, why
        assert vendor in why and "engine window" in why, why

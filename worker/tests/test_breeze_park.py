"""Breeze is parked off the GPU for every gpu-lane job and comes back on
demand — never beside a render (the measured OOM on NIGHT SHIFT b7)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import breeze_tts as BT  # noqa: E402


@pytest.fixture
def box(tmp_path, monkeypatch):
    monkeypatch.setattr(BT, "GPU_BUSY_PATH", str(tmp_path / "busy"))
    monkeypatch.setenv("BREEZE_TTS_URL", "http://127.0.0.1:7860")
    calls = []
    monkeypatch.setattr(BT, "_systemctl", lambda verb: calls.append(verb) or True)
    return calls


def test_park_stops_a_running_local_unit_and_marks_the_gpu_busy(box, monkeypatch):
    monkeypatch.setattr(BT, "_active", lambda: True)
    assert BT.park(log=lambda *_: None) is True
    assert box == ["stop"] and BT.gpu_busy()
    BT.unpark()
    assert not BT.gpu_busy()


def test_park_is_a_no_op_for_a_remote_server(box, monkeypatch):
    monkeypatch.setenv("BREEZE_TTS_URL", "http://tts.example.com")
    monkeypatch.setattr(BT, "_active", lambda: True)
    assert BT.park(log=lambda *_: None) is False
    assert box == []            # never stops somebody else's unit


def test_ensure_up_waits_for_the_lane_then_starts(box, monkeypatch):
    answers = iter([None, None, {"status": "ok"}])
    monkeypatch.setattr(BT, "health", lambda timeout=5: next(answers))
    BT.park(log=lambda *_: None)          # busy
    slept = []
    def sleep(s):
        slept.append(s)
        BT.unpark()                        # the render leg ends while we wait
    assert BT.ensure_up(wait_s=60, log=lambda *_: None, _sleep=sleep) is True
    assert box[-1] == "start" and slept


def test_ensure_up_gives_up_after_the_wait_rather_than_loading_beside_a_render(box, monkeypatch):
    monkeypatch.setattr(BT, "health", lambda timeout=5: None)
    BT.park(log=lambda *_: None)
    with pytest.raises(RuntimeError, match="parked"):
        BT.ensure_up(wait_s=-1, log=lambda *_: None, _sleep=lambda s: None)
    assert "start" not in box


def test_parking_covers_the_whole_table_rather_than_a_hardcoded_pair():
    """AND EVERY ENGINE, not just the one this was written against.

    The engines share ONE busy flag (one GPU, one flag) but each has its own
    unit and only its own module can stop it — so a machine serving two has to
    be told about both, or the one nobody parked loads its weights beside the
    render and the OOM this exists to prevent comes back through the engine
    nobody was watching.

    THE RUNNER IN THIS BUILD IS `src/lib/localWorker.ts`, not a Python loop:
    one job at a time, parking before a render and bringing back the one
    engine a line needs. That half is pinned where it lives
    (`src/lib/breezeLocal.test.ts`); what is pinned here is the Python API a
    runner calls.
    """
    ve = open(os.path.join(os.path.dirname(__file__), "..", "voice_engines.py")).read()
    j = ve.index("def park_all(")
    assert "for name in ENGINES:" in ve[j:j + 700]
    k = ve.index("def unpark_all(")
    assert "for name in ENGINES:" in ve[k:k + 400]


# ── the desktop, where the service is a CHILD OF THE APP ────────────────────

def test_with_no_unit_nothing_shells_out(monkeypatch):
    """`BREEZE_UNIT=""` is how `planner.rs` says "there is no systemd here".

    Reaching for `sudo -n systemctl` on a laptop is not merely useless — it
    spawns a process, waits on it, and interprets its failure as "the unit
    would not start", which is the wrong sentence for a machine that has no
    units at all. `_systemctl` must refuse before `subprocess` is touched."""
    monkeypatch.setattr(BT, "UNIT", "")
    spy = []
    monkeypatch.setattr("subprocess.run",
                        lambda *a, **k: spy.append(a) or (_ for _ in ()).throw(
                            AssertionError("no subprocess with no unit")))
    assert BT._systemctl("start") is False
    assert BT._active() is False
    assert spy == []


def test_with_no_unit_park_marks_the_gpu_and_stops_nothing(box, monkeypatch):
    # The marker still has to be written: `ensure_up` waits on it, and on the
    # desktop the RUST side is what stops the child. Park's own return says it
    # stopped nothing, which is true.
    monkeypatch.setattr(BT, "UNIT", "")
    assert BT.park(log=lambda *_: None) is False
    assert BT.gpu_busy(), "the lane must still be marked busy"
    BT.unpark()


def test_with_no_unit_ensure_up_names_the_engine_window(box, monkeypatch):
    monkeypatch.setattr(BT, "UNIT", "")
    monkeypatch.setattr(BT, "health", lambda timeout=5: None)
    with pytest.raises(RuntimeError) as e:
        BT.ensure_up(log=lambda *_: None)
    why = str(e.value)
    assert "Speech tab" in why
    assert "systemctl" not in why and "install_breeze.sh" not in why


def test_the_reason_is_one_sentence_naming_a_screen(monkeypatch):
    """One sentence, three callers (`ensure_up`, `handle_tts`,
    `voice_clone.providers`) — so they cannot drift into naming different
    fixes for the same absence. It names a SCREEN rather than a command,
    because this build installs and starts the service itself; "run this bash
    script" would be advice for a terminal the product exists not to need."""
    monkeypatch.setattr(BT, "UNIT", "breeze-tts")
    monkeypatch.delenv("MODEL_TIER", raising=False)
    why = BT.not_serving_reason()
    assert "Speech tab" in why
    assert "bash" not in why and ".sh" not in why
    monkeypatch.setenv("MODEL_TIER", "desktop")
    assert "engine window" in BT.not_serving_reason()


def test_the_lock_is_best_effort_where_fcntl_is_absent(box, monkeypatch):
    """Windows has no `fcntl`. An unguarded import costs the whole module —
    every speech job on that platform — to protect a server the desktop only
    ever calls one job at a time."""
    monkeypatch.setattr(BT, "fcntl", None)
    monkeypatch.setattr(BT, "health", lambda timeout=5: True)
    seen = {}
    monkeypatch.setattr(BT, "_as_ref_wav", lambda p: b"RIFF")

    class R:
        headers = {"X-Sample-Rate": "24000"}
        def read(self): return b"\0" * 48000
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_open(req, timeout=None):
        seen["url"] = req.full_url
        return R()
    monkeypatch.setattr("urllib.request.urlopen", fake_open)
    out = BT.speak("hello", instruction="Speak clearly.")
    assert out[:4] == b"RIFF" and seen["url"].endswith("/v1/audio/speech")


def test_the_temp_paths_are_the_platform_s_own():
    # `/tmp` is not a path on Windows, and both of these are written on every
    # speech job.
    import tempfile
    assert BT.LOCK_PATH.startswith(tempfile.gettempdir())
    assert BT.GPU_BUSY_PATH.startswith(tempfile.gettempdir())

"""One GPU, a render lane and a voice engine — the handover between them.

THE FAILURE THESE ARE WRITTEN AGAINST is a measured second of the pod's own
journal (2026-09-07, job 5a6780c1, a voice ref queued from a bible entry while
a batch of 38 reference-sheet renders drained):

    02:20:41  JOB DONE orbit_sheet             <- unpark(), the gate opens
    02:20:42  claimed 5a6780c1 kind=tts lane=cpu
    02:20:42  sudo systemctl start breeze-tts  <- ensure_up: the gate is clear
    02:20:42  sudo systemctl stop  breeze-tts  <- park(): the next gpu job
    02:22:42  JOB ERROR: breeze-tts started but /health never answered

The service started perfectly and was stopped 200ms later. Everything below
pins one of the three faults that made that possible, plus the two properties
that must survive fixing them: a render is never blocked indefinitely, and a
service that genuinely does not answer still says so.
"""
import contextlib
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import breeze_tts as BT  # noqa: E402
import gpu_park  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.dirname(HERE)


@pytest.fixture
def box(tmp_path, monkeypatch):
    monkeypatch.setattr(BT, "GPU_BUSY_PATH", str(tmp_path / "busy"))
    monkeypatch.setattr(BT, "HOLD_PATH", str(tmp_path / "hold"))
    monkeypatch.setattr(gpu_park, "WANT_PATH", str(tmp_path / "want"))
    monkeypatch.setenv("BREEZE_TTS_URL", "http://127.0.0.1:7860")
    calls = []
    monkeypatch.setattr(BT, "_systemctl", lambda verb: calls.append(verb) or True)
    monkeypatch.setattr(BT, "_active", lambda: True)
    return calls


# ── 1. the health poll could not tell "parked again" from "failed to start" ──

def test_a_park_landing_mid_start_is_not_reported_as_a_dead_service(box, monkeypatch):
    """The measured second, replayed.

    `park` closes the gate BEFORE it touches the unit, so a bring-up that is
    about to lose can see it coming. The old poll could not: it counted down
    its full 120s against a service somebody else had stopped and then named
    the one thing that had not happened. It goes back to the gate now and
    tries again when the lane is genuinely idle.
    """
    ticks = []
    healthy = {"v": False}
    monkeypatch.setattr(BT, "health",
                        lambda timeout=5: {"status": "ok"} if healthy["v"] else None)

    def sleep(_s):
        ticks.append(_s)
        if len(ticks) == 1:
            gpu_park.mark_busy(BT)      # a gpu job is claimed: the gate closes
        elif len(ticks) == 3:
            gpu_park.clear_busy(BT)     # the render leg ends
        elif len(ticks) == 4:
            healthy["v"] = True         # and this time the unit answers

    assert BT.ensure_up(wait_s=60, log=lambda *_: None, _sleep=sleep) is True
    assert box.count("start") == 2, "it has to actually try again, not just wait"


def test_a_service_that_really_does_not_answer_still_says_so(box, monkeypatch):
    """The other half. The message was WRONG in the measured case and it is
    RIGHT in this one, so it has to survive — a bring-up that fails on its own
    terms, with the lane idle throughout, is still 'started but never
    answered'."""
    monkeypatch.setattr(BT, "health", lambda timeout=5: None)
    monkeypatch.setattr(BT, "START_WAIT_S", 4)
    with pytest.raises(RuntimeError, match="never answered"):
        BT.ensure_up(wait_s=60, log=lambda *_: None, _sleep=lambda s: None)


# ── 2. nothing serialised start against stop ────────────────────────────────

def test_park_waits_for_a_synthesis_in_flight(box, monkeypatch):
    """A line already being spoken finishes instead of dying on a closed
    socket. `speak` passes its own stack to `ensure_up`, so the engine stays
    locked from the health check through the request."""
    monkeypatch.setattr(gpu_park, "PARK_WAIT_S", 30)
    monkeypatch.setattr(BT, "health", lambda timeout=5: {"status": "ok"})
    holding, done = threading.Event(), threading.Event()

    def a_voice_job():
        with contextlib.ExitStack() as stack:
            BT.ensure_up(log=lambda *_: None, hold=stack)
            holding.set()
            done.wait(10)               # ...mid-request
    t = threading.Thread(target=a_voice_job)
    t.start()
    try:
        assert holding.wait(10)
        parked = []
        p = threading.Thread(target=lambda: parked.append(BT.park(log=lambda *_: None)))
        p.start()
        p.join(2)
        assert p.is_alive(), "park must wait for the line, not cut it off"
        assert box == [], "and it must not have stopped anything yet"
        done.set()
        p.join(10)
        assert parked == [True] and box == ["stop"]
    finally:
        done.set()
        t.join(10)


def test_park_stops_the_unit_anyway_once_its_wait_is_up(box, monkeypatch):
    """THE RENDER LANE WINS EVERY CONTEST THAT MATTERS. The wait is a
    courtesy; a render must never fail because a voice job would not let go,
    so the unit is stopped whether or not the lock was ever free."""
    monkeypatch.setattr(gpu_park, "PARK_WAIT_S", 1)
    monkeypatch.setattr(BT, "health", lambda timeout=5: {"status": "ok"})
    holding, done = threading.Event(), threading.Event()

    def a_voice_job():
        with contextlib.ExitStack() as stack:
            BT.ensure_up(log=lambda *_: None, hold=stack)
            holding.set()
            done.wait(10)
    t = threading.Thread(target=a_voice_job)
    t.start()
    try:
        assert holding.wait(10)
        t0 = time.time()
        assert BT.park(log=lambda *_: None) is True
        waited = time.time() - t0
        assert waited >= 1.0, "it should have waited its budget out"
        assert waited < 8, "and no longer"
        assert box == ["stop"]
    finally:
        done.set()
        t.join(10)


def test_the_gate_closes_before_park_touches_the_unit(box, monkeypatch):
    """Which is what makes the whole handshake work: no bring-up can begin
    once a gpu job is claimed, however long the stop itself takes."""
    seen = []
    monkeypatch.setattr(BT, "_systemctl",
                        lambda verb: seen.append((verb, BT.gpu_busy())) or True)
    BT.park(log=lambda *_: None)
    assert seen == [("stop", True)]


# ── 3. a voice job could not win the gate at all ────────────────────────────

def test_a_waiting_voice_job_leaves_a_ticket(box, monkeypatch):
    """The gpu lane reads it between jobs. Without it the gate is a lottery a
    voice job cannot win while a queue drains — the window between one job's
    unpark and the next one's park is milliseconds."""
    monkeypatch.setattr(BT, "health", lambda timeout=5: None)
    monkeypatch.setattr(BT, "START_WAIT_S", 2)
    gpu_park.mark_busy(BT)
    seen = []

    def sleep(_s):
        seen.append(gpu_park.wanted())
        gpu_park.clear_busy(BT)          # the render leg ends
    with pytest.raises(RuntimeError, match="never answered"):
        BT.ensure_up(wait_s=60, log=lambda *_: None, _sleep=sleep)
    assert seen and seen[0] is True, "the gpu lane has to be able to see it waiting"
    # ...and it is dropped again on the way out, however the wait ended.
    assert not gpu_park.wanted()


def test_the_ticket_expires_so_a_dead_voice_job_cannot_hold_the_render_lane(
        box, monkeypatch):
    gpu_park.want()
    assert gpu_park.wanted()
    monkeypatch.setattr(gpu_park, "WANT_STALE_S", 0)
    assert not gpu_park.wanted(), "a $3.36/hr lane cannot wait on a stale ticket"


def test_the_gpu_lane_holds_for_a_ticket_and_resumes_when_it_clears(box):
    gpu_park.want()
    ticks = []

    def sleep(s):
        ticks.append(s)
        if len(ticks) == 3:
            gpu_park.drop_want()
    gpu_park.yield_to_voice([], log=lambda *_: None, cap_s=30, _sleep=sleep)
    assert len(ticks) == 3


def test_the_hold_is_capped_and_free_when_nothing_is_waiting(box):
    assert gpu_park.yield_to_voice([], log=lambda *_: None) == 0.0
    gpu_park.want()                      # never dropped
    t0 = time.time()
    gpu_park.yield_to_voice([], log=lambda *_: None, cap_s=0.05, _sleep=time.sleep)
    assert time.time() - t0 < 5, "a stuck voice job cannot stall the render queue"


def test_the_hold_covers_the_synthesis_not_just_the_queueing(box, monkeypatch):
    """The ticket is dropped the moment `ensure_up` returns, but the line has
    not been spoken yet — so the lane also waits on the engine's hold lock, or
    it resumes and parks the service mid-request."""
    monkeypatch.setattr(gpu_park, "WANT_STALE_S", 0)     # ticket already stale
    with contextlib.ExitStack() as stack:
        gpu_park.take(stack, BT.HOLD_PATH)
        assert gpu_park.held(BT.HOLD_PATH)
    assert not gpu_park.held(BT.HOLD_PATH)


def test_the_courtesy_gate_is_available_to_a_runner_that_needs_it():
    """NOTHING CALLS IT IN THIS BUILD, and that is a fact about the runner
    rather than about the rule.

    `yield_to_voice` exists because a POOLED loop drains gpu jobs back to back
    and the window between one job's unpark and the next one's park is
    milliseconds — so a voice job waiting on the gate loses a lottery it can
    never win. `localWorker` takes ONE job at a time in queue order, so a
    voice job is simply next rather than competing, and there is no gap to
    hold open. Kept because it is the engines' own API and a fork running its
    own pooled loop needs it; pinned here so it cannot rot into something a
    caller could not use.
    """
    import voice_engines
    assert voice_engines.yield_to_voice(log=lambda *_: None) == 0.0


# ── one implementation, not one per engine ──────────────────────────────────

def test_both_engines_delegate_rather_than_carrying_a_second_copy():
    """`voice_engines` exists because "a second engine answered by copying is
    the twin drift this repo keeps paying for" — and the copy that mattered
    was this one: `qwen_voice` inherited the race verbatim from `breeze_tts`.
    The rule now lives in exactly one file, and the sentence that named it
    wrongly can only be written from there."""
    for name in ("breeze_tts.py", "qwen_voice.py"):
        src = open(os.path.join(WORKER, name)).read()
        assert "gpu_park.park(" in src, name
        assert "gpu_park.ensure_up(" in src, name
        assert "started but /health never answered" not in src, (
            f"{name} carries its own copy of the rule again")
        # ...and the module has what `gpu_park` reads off it.
        for attr in ("LABEL", "HOLD_PATH", "GPU_BUSY_PATH", "UNIT",
                     "WAIT_FOR_GPU_S", "START_WAIT_S"):
            assert f"\n{attr} = " in src or f"\n{attr} =" in src, f"{name}: {attr}"


def test_speak_holds_the_engine_across_its_own_request():
    """The health check and the socket are two moments, and a park between
    them is the measured failure one step later — the line dies on a closed
    connection instead of a dead poll."""
    for name in ("breeze_tts.py", "qwen_voice.py"):
        src = open(os.path.join(WORKER, name)).read()
        body = src[src.index("def speak("):]
        assert "hold=stack" in body[:body.index("urlopen")], name


def test_the_hold_lock_is_not_the_request_lock():
    """`LOCK_PATH` serialises requests and is held ACROSS the gate wait, which
    can be fifteen minutes. `park` waits on the hold lock, so pointing it at
    that one would block a render for the whole wait."""
    for mod in (BT,):
        assert mod.HOLD_PATH != mod.LOCK_PATH
    import tempfile
    assert BT.HOLD_PATH.startswith(tempfile.gettempdir())
    assert gpu_park.WANT_PATH.startswith(tempfile.gettempdir())


# ── /tmp is shared, and whoever touches a lock first owns it ────────────────

def test_a_lock_file_is_usable_by_every_uid_that_runs_the_worker(box):
    """MEASURED ON THE POD, and I caused it: one root-run diagnostic left
    /tmp/breeze-tts-hold.lock owned by uid 0 at 0644, and the next synthesis
    as `ubuntu` — which is the user the worker actually runs as — died on
    `PermissionError: [Errno 13]` raised straight out of `ensure_up`. Not a
    degraded lock: every voice job on the box, until somebody deleted a file
    that nothing in the app names.

    `open(path, "a+")` creates 0644 through the umask, so the mode has to be
    stated. `/tmp` is sticky and shared with `install_breeze.sh`, every
    `sudo` probe and both engines.
    """
    import stat as _stat
    with contextlib.ExitStack() as stack:
        gpu_park.take(stack, BT.HOLD_PATH)
    mode = _stat.S_IMODE(os.stat(BT.HOLD_PATH).st_mode)
    assert mode == 0o666, f"created {oct(mode)}, which locks out another uid"
    # ...and the markers, which are written by whoever parks and read by
    # whoever waits — not always the same user either.
    gpu_park.mark_busy(BT)
    gpu_park.want()
    for p in (BT.GPU_BUSY_PATH, gpu_park.WANT_PATH):
        assert _stat.S_IMODE(os.stat(p).st_mode) == 0o666, p
    gpu_park.clear_busy(BT)
    gpu_park.drop_want()


def test_a_lock_nobody_can_open_degrades_instead_of_killing_the_voice_path(
        box, tmp_path, monkeypatch):
    """The lock closes a race that costs ONE voice job; refusing to open it
    costs every one of them. So it runs unlocked and says so — loudly, since
    the only way here is a file owned by another uid and the fix is `rm`."""
    said = []
    unopenable = str(tmp_path / "nope" / "hold.lock")     # no such directory
    with contextlib.ExitStack() as stack:
        assert gpu_park.take(stack, unopenable, log=said.append) is True
    assert said and "not writable" in said[0] and "delete that file" in said[0]


def test_a_marker_is_truncated_rather_than_overwritten_in_place(box):
    """They hold a pid, and a shorter one written over a longer one would
    leave the tail behind — `wanted()` only reads the mtime, but `park` writes
    its pid for a human reading the box."""
    gpu_park._write_shared(gpu_park.WANT_PATH, "1234567")
    gpu_park._write_shared(gpu_park.WANT_PATH, "42")
    assert open(gpu_park.WANT_PATH).read() == "42"
    gpu_park.drop_want()

"""One GPU, a render lane and a voice engine — who owns the card, and when.

THE RENDER LANE OWNS IT AND THE VOICE ENGINE BORROWS IT. Breeze holds ~9GB
resident beside ComfyUI's ~83GB and that was enough to kill a 311-frame PDD
r2v block on `SamplerCustomAdvanced: torch.OutOfMemoryError`, so `worker.py`
PARKS every configured engine — stops the unit — before each gpu-lane job and
unparks after. Every line is synthesised at PLAN time, so the engine has
nothing to do during a render leg. That much is unchanged.

WHAT IT MISSED, AND WHAT THIS MODULE IS: park and bring-up were two threads
mutating one systemd unit with nothing between them, and the loser could not
tell what had happened to it. Measured on the pod, one second of the journal
(2026-09-07, job 5a6780c1, a voice ref for a bible entry):

    02:20:41  JOB DONE orbit_sheet             <- unpark(), the gate opens
    02:20:42  claimed 5a6780c1 kind=tts lane=cpu
    02:20:42  sudo systemctl start breeze-tts  <- ensure_up: the gate is clear
    02:20:42  sudo systemctl stop  breeze-tts  <- park(): the next gpu job
    02:20:42  breeze: parked for the gpu lane (stopped breeze-tts)
    02:22:42  JOB ERROR: breeze-tts started but /health never answered

The service started perfectly and was stopped 200ms later; the voice job then
polled a dead unit for its full 120s and reported the one thing that had not
happened. `systemctl show` agreed the whole time: `Result=success`,
`NRestarts=0`. Three separate faults, each with its own answer here:

  1. NOTHING SERIALISED start AGAINST stop. -> a HOLD lock (`take`), which
     every mutation takes and `park` waits on — briefly, and boundedly, so a
     synthesis already in flight finishes instead of dying on a closed socket.
     It is deliberately NOT the engine's request lock: that one is held across
     the gate wait, which can be fifteen minutes, and a render must never
     queue behind it.
  2. THE HEALTH POLL COULD NOT TELL "parked again" FROM "failed to start", so
     it reported the wrong one and burned 120s doing it. -> `await_health`
     re-reads the gate every tick and hands the caller back to it.
  3. A VOICE JOB COULD NOT WIN THE GATE ANYWAY. The window between one gpu
     job's unpark and the next one's park is milliseconds, so with a queue of
     renders draining (that batch had 38) a voice job waits out its whole
     deadline and then fails HONESTLY instead of wrongly — no better for the
     person who asked for a voice. -> a job about to wait leaves a TICKET, and
     the gpu lane holds for it once its current job is done.

THE RENDER LANE STILL WINS EVERY CONTEST THAT MATTERS: the gate closes the
instant `park` is called, so no new bring-up can begin; the ticket is bounded
and self-expiring, so a killed voice job cannot hold the lane; and `park`
stops the unit whether or not it ever got the lock.

EVERY FUNCTION TAKES THE ENGINE'S MODULE (`m`) rather than its values, so the
attribute lookups are late: `breeze_tts` and `qwen_voice` keep their own
`GPU_BUSY_PATH`, `UNIT`, `health`, `_systemctl` and `_active`, monkeypatching
them in tests still reaches this code, and the two engines cannot drift into
two answers to one question — which is `voice_engines`' own stated reason for
existing, applied one layer down.
"""
# POSIX-ONLY, and optional — `breeze_tts`'s reasoning, kept here because this
# is now where the locking lives. Windows has no `fcntl` at all and the
# desktop runs one job at a time, so its absence costs nothing that was ever
# at risk there; an unguarded import would cost the whole module.
try:
    import fcntl
except ImportError:  # pragma: no cover — Windows
    fcntl = None
import contextlib
import os
import stat
import tempfile
import time


def _shared(path):
    """Open (creating) a /tmp coordination file ANY uid running the worker can
    use, and repair one somebody else made where we are allowed to.

    `/tmp` IS STICKY AND SHARED, AND WHOEVER TOUCHES ONE OF THESE FIRST OWNS
    IT. `open(path, "a+")` creates 0644 through the umask, so a file made by a
    root process — an `install_*.sh`, a `sudo` diagnostic, anything run to
    look at the box — locks out `ubuntu`, which is the user the worker
    actually runs as. The failure is not a degraded lock: it is a hard
    PermissionError raised out of `ensure_up`, i.e. every voice job on the
    box, until somebody deletes a file that nothing in the app names.
    Measured on the pod 2026-09-07 — one root-run probe was enough, and the
    next synthesis died on it. So the mode is stated rather than left to the
    umask, and it is asserted on a file that already exists.
    """
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o666)
    try:
        if stat.S_IMODE(os.fstat(fd).st_mode) != 0o666:
            os.fchmod(fd, 0o666)
    except OSError:
        pass                # not ours to chmod, and it opened — which is what
    return os.fdopen(fd, "r+")      # this call was for


def _write_shared(path, text):
    """Replace a marker's contents. Truncating matters: these hold a pid, and
    a shorter one written over a longer one would leave the tail behind."""
    try:
        with _shared(path) as f:
            f.truncate(0)
            f.write(text)
        return True
    except OSError:
        return False


def _tmp(name):
    return os.path.join(tempfile.gettempdir(), name)


# A VOICE JOB IS WAITING FOR A SLOT. Shared across engines by design — it is a
# fact about this box, not about which engine is installed — and read by the
# gpu lane between jobs. Self-expiring: a job that was killed mid-wait must
# not hold a $3.36/hr render lane, so the ticket is refreshed while waiting
# and ignored once it goes stale.
WANT_PATH = os.environ.get("QAMBA_VOICE_WANT_PATH") or _tmp("qamba-voice-want")
WANT_STALE_S = int(os.environ.get("QAMBA_VOICE_WANT_STALE_S") or 20)
# How long the gpu lane holds for a ticket before resuming regardless.
YIELD_S = int(os.environ.get("QAMBA_VOICE_YIELD_S") or 180)
# How long `park` waits for an in-flight bring-up or synthesis before stopping
# the unit anyway. A bring-up releases within a tick of the gate closing, so
# this is really the budget for one synthesis (measured 7-26s per line).
PARK_WAIT_S = int(os.environ.get("QAMBA_PARK_WAIT_S") or 60)
# The gate poll. One `os.path.exists` — 5s was the old value and it wasted
# most of a yield window before the waiting job noticed the lane was free.
GATE_POLL_S = float(os.environ.get("QAMBA_GATE_POLL_S") or 1.0)


# ------------------------------------------------------------------ gate --

def busy(m):
    """Is a gpu-lane job holding the card?"""
    return os.path.exists(m.GPU_BUSY_PATH)


def mark_busy(m):
    _write_shared(m.GPU_BUSY_PATH, str(os.getpid()))


def clear_busy(m):
    try:
        os.remove(m.GPU_BUSY_PATH)
    except OSError:
        pass


# ---------------------------------------------------------------- ticket --

def want():
    """Leave (or refresh) a waiting voice job's ticket."""
    _write_shared(WANT_PATH, str(os.getpid()))


def drop_want():
    try:
        os.remove(WANT_PATH)
    except OSError:
        pass


def wanted():
    """Is a voice job waiting for a slot right now?

    Age-checked rather than existence-checked: the ticket is what makes the
    gpu lane pause, so a stale one is a render queue that never resumes.
    """
    try:
        return (time.time() - os.path.getmtime(WANT_PATH)) < WANT_STALE_S
    except OSError:
        return False


# ------------------------------------------------------------------ hold --

def take(stack, path, *, deadline=None, _sleep=time.sleep, log=print):
    """LOCK_EX on `path`, released when `stack` unwinds. Returns whether it
    was taken — False only when a `deadline` was given and passed.

    The unlock is registered as its own callback rather than left to the
    close, because an ExitStack unwinds in reverse: the lock has to be
    released while the descriptor is still open.
    """
    if fcntl is None:                       # pragma: no cover — Windows
        return True
    try:
        f = stack.enter_context(_shared(path))
    except OSError as e:
        # UNLOCKED RATHER THAN DEAD. This lock closes a race that costs one
        # voice job; refusing to open at all costs every one of them. Loud,
        # because the only way to reach here is a file owned by another uid,
        # and the fix is to delete it.
        log(f"gpu_park: {path} is not writable ({e}) — running without the "
            f"start/stop lock; delete that file to restore it")
        return True
    if deadline is None:
        fcntl.flock(f, fcntl.LOCK_EX)
        stack.callback(fcntl.flock, f, fcntl.LOCK_UN)
        return True
    while True:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            stack.callback(fcntl.flock, f, fcntl.LOCK_UN)
            return True
        except OSError:
            if time.time() >= deadline:
                return False
            _sleep(0.2)


def held(path):
    """Is somebody starting, serving or stopping this engine right now?

    `flock` is per open file description, so this answers truthfully even for
    a lock held by another THREAD of this process — which is the case that
    matters: the gpu lane is the main thread and voice jobs run in the pool.
    """
    if fcntl is None:                       # pragma: no cover — Windows
        return False
    try:
        with _shared(path) as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return True
            fcntl.flock(f, fcntl.LOCK_UN)
            return False
    except OSError:
        return False


# ------------------------------------------------------------- park/bring --

def park(m, log=print):
    """Before a gpu-lane job: close the gate, wait briefly for whatever the
    engine is mid-way through, then stop the unit.

    THE GATE CLOSES FIRST and the wait is bounded. A render must never fail
    because a voice job would not let go — so this stops the unit whether or
    not it got the lock. What the wait buys is that a synthesis already in
    flight finishes rather than dying on a closed socket; the engine is
    stopped either way, one line later.
    """
    mark_busy(m)
    if not m._local_service() or not m._active():
        return False
    with contextlib.ExitStack() as stack:
        got = take(stack, m.HOLD_PATH, log=log,
                   deadline=time.time() + PARK_WAIT_S)
        if not got:
            log(f"{m.LABEL}: a voice job still held {m.UNIT} after {PARK_WAIT_S}s — "
                f"stopping it anyway so the gpu lane can run")
        ok = m._systemctl("stop")
    log(f"{m.LABEL}: parked for the gpu lane "
        f"({'stopped' if ok else 'could not stop'} {m.UNIT})")
    return ok


def unpark(m):
    """After the gpu-lane job: the lane is idle again. The unit is NOT
    restarted here — `ensure_up` brings it back the moment a line is asked
    for, so a render leg never pays the load twice."""
    clear_busy(m)


def await_health(m, log=print, _sleep=time.sleep):
    """Poll for the unit to answer. Returns True, or False with the reason
    readable from `busy(m)`.

    RE-READS THE GATE EVERY TICK, which is the whole point: a `park` landing
    mid-start is not a service that failed to start, and reporting it as one
    is what sent people looking at a unit that was working perfectly.
    """
    for _ in range(max(1, m.START_WAIT_S // 2)):
        if m.health():
            return True
        if busy(m):
            return False
        _sleep(2)
    return False


def ensure_up(m, wait_s=None, log=print, _sleep=time.sleep, hold=None):
    """Health, or bring the unit up and wait for it.

    `hold` — an ExitStack. Given one, the engine is left LOCKED in it, so the
    caller's request cannot be parked out from under it; `speak` passes its
    own stack, and that is what lets a voice job survive the next gpu claim.
    Without one this is a bare "is it up" and nothing is reserved.
    """
    # WHOSE UNIT IS IT. With no unit the service is a child of the desktop app
    # and Rust owns start/stop, so there is nothing here for a lock to
    # exclude; a remote URL is somebody else's server and is never touched.
    # Either way a healthy engine is simply up, exactly as before.
    ours = bool(m.UNIT) and m._local_service()
    if m.health() and not (ours and hold is not None):
        return True
    if not m.UNIT:
        raise RuntimeError(m.not_serving_reason())
    if not ours:
        raise RuntimeError(f"{m.LABEL}: {m.base_url()} is not answering and is not "
                           f"this box's unit")
    deadline = time.time() + (m.WAIT_FOR_GPU_S if wait_s is None else wait_s)
    announced = False
    # Only ever withdraw a ticket WE left. Several voice jobs can be waiting
    # at once (the cpu lane's `tts` and the llm lane's plan-time measuring
    # pass), and dropping a neighbour's on the way out would resume the gpu
    # lane while it is still waiting.
    ticketed = False
    try:
        while True:
            # 1. The render lane owns the card. Wait for it TICKET IN HAND —
            #    unlocked, because a gate wait is minutes and `park` must
            #    never queue behind one.
            while busy(m):
                if time.time() > deadline:
                    raise RuntimeError(
                        f"{m.LABEL}: parked while the GPU renders and the render leg "
                        f"did not finish within the wait — retry after it")
                if not announced:
                    log(f"{m.LABEL}: parked while the GPU renders — waiting for the "
                        f"lane to go idle")
                    announced = True
                want()
                ticketed = True
                _sleep(GATE_POLL_S)
            # 2. Take the unit. From here `park` waits on us rather than
            #    stopping the service between our start and our request.
            local = contextlib.ExitStack()
            with local:
                take(local, m.HOLD_PATH, log=log)
                if busy(m):
                    continue            # parked while we queued for the lock
                if not m.health():
                    if not m._systemctl("start"):
                        raise RuntimeError(f"{m.LABEL}: could not start {m.UNIT} "
                                           f"(sudo -n systemctl start)")
                    if not await_health(m, log=log, _sleep=_sleep):
                        if busy(m):
                            continue    # parked mid-start: back to the gate
                        raise RuntimeError(f"{m.LABEL}: {m.UNIT} started but /health "
                                           f"never answered")
                    log(f"{m.LABEL}: back up")
                if hold is not None:
                    # Hand the lock to the caller's stack, so the request it is
                    # about to make is covered by it too.
                    hold.enter_context(local.pop_all())
                return True
    finally:
        if ticketed:
            drop_want()


def yield_to_voice(hold_paths, log=print, cap_s=None, _sleep=time.sleep):
    """Between gpu jobs: hold the lane while a waiting voice job takes a slot.

    Without this a voice job cannot win the gate at all while a render queue
    drains — the gap between one job's `unpark` and the next one's `park` is
    milliseconds — so it waits out its whole deadline and fails. Bounded and
    ticket-driven: no ticket, no wait.

    It waits for the ticket to clear AND for the hold locks to be free, so the
    window covers the bring-up and the synthesis rather than ending the
    instant the job stops queueing.
    """
    if not wanted():
        return 0.0
    cap = YIELD_S if cap_s is None else cap_s
    t0 = time.time()
    log(f"voice: holding the gpu lane for a waiting voice job (up to {int(cap)}s)")
    while time.time() - t0 < cap:
        if not wanted() and not any(held(p) for p in hold_paths):
            break
        _sleep(0.25)
    waited = time.time() - t0
    log(f"voice: gpu lane resumes after {waited:.1f}s")
    return waited

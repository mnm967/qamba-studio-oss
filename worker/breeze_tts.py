"""Breeze TTS 2 — the studio's own voice engine, wherever it is serving.

One small HTTP client over the model's streaming API (`breeze_infer.api`,
`POST /v1/audio/speech`, multipart). TWO PLACES SERVE IT and this module works
against either: the pod, as `breeze-tts.service` (the engine window's Speech tab), and
a DESKTOP, where it is a child of the app itself (src-tauri/src/breeze.rs). The
only difference is start/stop — `BREEZE_UNIT` names a systemd unit on the pod
and is EMPTY on a desktop, where Rust owns the process and `sudo -n systemctl`
would be a fix for a machine the reader does not have.

Three things it can do, and the studio uses all three:

  CLONE      ref_audio + ref_text + text          -> that voice says the text
  DESIGN     text + instruction  (cfg ~4)         -> a NEW voice from prose
  DIRECT     ref + text + instruction (cfg > 1)   -> the cloned voice, steered

plus VOCAL EVENTS inline in the text — `(sigh)`, `(laugh)`, `(cough)`,
`(clears throat)` — which the model performs rather than reads. That is what
"the writer's dialogue should represent events" means at this layer: the
event is in the words, and it comes out as a sound.

The API is SINGLE-CONCURRENCY (it holds one request lock and streams PCM),
so this client serialises across worker threads with a file lock: the cpu
lane's `tts` jobs and the llm lane's plan-time measuring pass run in the same
process and would otherwise queue on the server's lock with the socket open.

Everything returns WAV bytes (24 kHz mono s16le, wrapped here — the wire is
raw PCM with `X-Sample-Rate`), and `to_mp3` is the one conversion the dialogue
path needs: every line clip on B2 is an mp3 under `audio/lines/`, and keeping
that contract means nothing downstream (the exchange cut, the spine, the
reviewer's ASR, the H3 audio-ref staging) learns a second container.

LICENCE: BreezeBlue Research and Non-Commercial for the weights. Said in the
catalog row and in install_breeze.sh; not decided here.
"""
# POSIX-ONLY, and optional. The lock serialises requests against a server
# whose own API is single-concurrency; on Windows there is no `fcntl` at all,
# and the desktop runs one job at a time anyway — so its absence costs
# nothing, where an unguarded import costs the whole module.
try:
    import fcntl
except ImportError:  # pragma: no cover — Windows
    fcntl = None
import contextlib
import io
import os
import sys
import time
import subprocess
import tempfile
import urllib.request
import uuid
import wave

import gpu_park

SAMPLE_RATE = 24000
# THE CACHE KEY DEPENDS ON THIS STRING, so it is not free to change. Every
# line clip on B2 is keyed `sha1(MODEL_ID|voice|text|instruction)` by
# `dialogue_synth.line_key`, and `beats.meta.xchg` pins a run of shots to a
# recording by that key — so a different value here orphans every clip this
# studio has ever recorded AND unpins every exchange, silently, because a
# miss just re-synthesises. It is `dialogue_synth.BREEZE_MODEL_ID`'s value
# verbatim; `test_qwen_tts.py` pins the two together.
MODEL_ID = "breeze-tts-2"
LOCK_PATH = os.path.join(tempfile.gettempdir(), "breeze-tts.lock")
# WHO OWNS THE UNIT right now — a SECOND lock, and it is not `LOCK_PATH`.
# That one serialises REQUESTS against a single-concurrency server and is held
# across `ensure_up`, whose gate wait can be fifteen minutes; `park` waits on
# this one, so it must only ever cover a bring-up or a synthesis. See
# `gpu_park`.
HOLD_PATH = os.path.join(tempfile.gettempdir(), "breeze-tts-hold.lock")
# How this engine names itself in a log line or an error.
LABEL = "breeze"
# The model authors' recommendation for design and direction; 1.0 "preserves
# the reference most faithfully" (the studio UI's own wording).
DESIGN_CFG = 4.0
CLONE_CFG = 1.0
# Direction sits between: the delivery note has to reach the read without the
# instruction branch re-deciding the timbre line to line. Overridable so the
# number can be measured rather than argued about.
DIRECT_CFG = float(os.environ.get("BREEZE_DIRECT_CFG") or 2.0)
DEFAULT_INSTRUCTION = "Speak clearly and naturally."

# THREE MODES, AND THIS IS THE ONE THAT IS NOT UNIVERSAL. Breeze can steer a
# CLONED line from a delivery note (`speak(ref..., instruction=...)` -> DIRECT
# at `DIRECT_CFG`); Qwen3-TTS cannot, because `generate_voice_clone` takes no
# `instruct` at all. `voice_engines.supports_direction` reads this, so a
# caller does not send an instruction an engine would silently drop.
SUPPORTS_DIRECTION = True
# HOW A VOCAL EVENT IS SPELLED for this engine. Breeze PERFORMS the model's own
# parenthesised spelling — "(sigh) It's good to hear your voice" comes out as a
# sigh — so the events stay in the text. `vocal_events.sanitize_events`.
EVENT_STYLE = "native"


def base_url():
    return (os.environ.get("BREEZE_TTS_URL") or "").rstrip("/")


def enabled():
    return bool(base_url())


def health(timeout=5):
    """The server's own /health, or None when it is not answering."""
    if not enabled():
        return None
    try:
        with urllib.request.urlopen(f"{base_url()}/health", timeout=timeout) as r:
            import json
            return json.load(r)
    except Exception:  # noqa: BLE001 — "not up" is an answer
        return None


def _multipart(fields, files):
    """(body, content_type) — stdlib only, the same shape voice_clone uses."""
    boundary = "----qamba" + uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        if v is None:
            continue
        out.write(f"--{boundary}\r\nContent-Disposition: form-data; "
                  f"name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, (name, data, ctype) in files.items():
        out.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                  f"filename=\"{name}\"\r\nContent-Type: {ctype}\r\n\r\n".encode())
        out.write(data)
        out.write(b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def _wav(pcm, rate=SAMPLE_RATE):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _as_ref_wav(path):
    """The reference clip as 24 kHz mono WAV bytes. The server hands the
    upload to its audio tokenizer as a file, and an mp3 there depends on the
    libsndfile build; ffmpeg is on every box this runs on and removes the
    question."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1",
                        "-ar", str(SAMPLE_RATE), "-f", "wav", "pipe:1"],
                       capture_output=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"breeze: could not decode reference clip {os.path.basename(path)}: "
                           f"{(r.stderr or b'')[-200:].decode(errors='replace')}")
    return r.stdout


# ---------------------------------------------------------------- parking --
# BREEZE SHARES THE RENDER GPU. Resident it holds ~9GB (measured 8,970 MiB on
# 2026-09-02) beside ComfyUI's ~83GB, and that was enough to kill a 311-frame
# PDD r2v block with seven pictures, two audio refs and motion context on
# `SamplerCustomAdvanced: torch.OutOfMemoryError`. Every line is synthesised
# at PLAN time — the spine and the line clips exist before a block renders —
# so the service has nothing to do during the render leg. The worker PARKS it
# (stops the unit) before every gpu-lane job and marks the GPU busy; `speak`
# brings it back on demand once the lane is idle. A plan that needs a line
# while a render is in flight WAITS rather than loading 9GB beside it.
GPU_BUSY_PATH = (os.environ.get("BREEZE_GPU_BUSY_PATH")
                 or os.path.join(tempfile.gettempdir(), "qamba-gpu-busy"))
# THE SYSTEMD UNIT, AND AN EMPTY VALUE MEANS THERE IS NONE.
#
# On the pod this names a unit `sudo -n systemctl` starts and stops. On the
# desktop the service is a CHILD OF THE APP — Rust spawned it, Rust stops it —
# and there is no systemd, no sudo and nothing for a unit name to address. The
# empty string is how `planner.rs` says so, and every branch below reads it
# rather than shelling out and interpreting the failure.
UNIT = os.environ.get("BREEZE_UNIT")
if UNIT is None:
    UNIT = "breeze-tts"
WAIT_FOR_GPU_S = int(os.environ.get("BREEZE_WAIT_S") or 900)
START_WAIT_S = int(os.environ.get("BREEZE_START_WAIT_S") or 120)


def not_serving_reason():
    """Why Breeze is not answering, in words the reader can act on.

    ONE SENTENCE, shared by every surface that has to refuse — `handle_tts`,
    `voice_clone.providers()` and `ensure_up` — so the three cannot drift into
    naming different fixes for the same absence. It names a screen rather than
    a command, because the fix really is a screen: this build installs and
    starts the service itself.
    """
    return ("Breeze TTS 2 is not running on this machine — install and start it "
            "from the engine window's Speech tab.")


def _local_service():
    """Only the studio's own box runs the unit — a remote BREEZE_TTS_URL is
    somebody else's server and is never started or stopped from here."""
    b = base_url()
    return bool(b) and ("127.0.0.1" in b or "localhost" in b)


def _systemctl(verb):
    if not UNIT:
        return False
    import subprocess
    try:
        r = subprocess.run(["sudo", "-n", "systemctl", verb, UNIT],
                           capture_output=True, text=True, timeout=60)
        return r.returncode == 0
    except Exception:  # noqa: BLE001 — no sudo, no systemd: reported by the caller
        return False


def _active():
    if not UNIT:
        return False
    import subprocess
    try:
        r = subprocess.run(["systemctl", "is-active", UNIT], capture_output=True,
                           text=True, timeout=15)
        return r.stdout.strip() == "active"
    except Exception:  # noqa: BLE001
        return False


def park(log=print):
    """Before a gpu-lane job: close the gate, then stop the unit if it is up.

    The mechanics are `gpu_park.park` — shared with every other local voice
    engine, because they share one GPU and one busy flag and a second copy of
    the start-against-stop rule is the drift `voice_engines` exists to end.
    Idempotent and never raises: a render must not fail because a TTS unit
    would not stop.
    """
    return gpu_park.park(sys.modules[__name__], log=log)


def unpark():
    """After the gpu-lane job: the lane is idle again. The unit is NOT
    restarted here — `ensure_up` brings it back the moment a line is asked
    for, so an episode's render leg never pays the 9GB twice."""
    gpu_park.unpark(sys.modules[__name__])


def gpu_busy():
    return gpu_park.busy(sys.modules[__name__])


def ensure_up(wait_s=None, log=print, _sleep=time.sleep, hold=None):
    """Health, or start the unit and wait for it. While the GPU is marked busy
    it waits (up to WAIT_FOR_GPU_S) for the lane to go idle first — loading
    the model beside a render is the OOM this exists to prevent.

    `hold` — an ExitStack the unit is left LOCKED in, so the caller's request
    cannot be parked out from under it between the health check and the
    socket. `speak` passes its own; see `gpu_park` for the journal second that
    made it necessary.

    With no unit the service is a child of the desktop app: there is nothing
    here that could start it, and "run this systemctl command" is advice for a
    machine the reader does not have. `breeze_ensure_up` on the Rust side is
    what actually brings it back, and `not_serving_reason` is the message for
    the case where even that did not.
    """
    return gpu_park.ensure_up(sys.modules[__name__], wait_s=wait_s, log=log,
                              _sleep=_sleep, hold=hold)



_warned = set()


def _warn_once(key, msg, log=print):
    if key not in _warned:
        _warned.add(key)
        log(msg)


def _flock(stack, log=print):
    """Take the client-side serialisation lock, BEST EFFORT.

    The server holds its own single request lock, so this one only keeps the
    pod's several lanes from queueing on the socket — losing it costs
    concurrency, never correctness. It must therefore never fail a line.

    IT CAN FAIL, AND ON THIS POD IT FAILS PERMANENTLY. `fs.protected_regular`
    is 2 on Ubuntu: a file in a sticky world-writable directory (/tmp) may not
    be opened for WRITE by anyone who does not own it — **root included**. So
    a lock file created once by the wrong user (an install run over SSM, which
    is root; a root-run probe) makes every later synth by the `ubuntu` worker
    raise EPERM, for good, with a message about permissions rather than about
    the cause. Measured 2026-09-07: root could `stat` the ubuntu-owned lock and
    not open it. Degrading is right — a lock this one cannot take is a lock the
    server does not need.
    """
    if fcntl is None:
        return
    try:
        lk = stack.enter_context(open(LOCK_PATH, "a+"))
        fcntl.flock(lk, fcntl.LOCK_EX)
        stack.callback(fcntl.flock, lk, fcntl.LOCK_UN)
    except OSError as e:
        _warn_once("lock", f"{LOCK_PATH} is not usable ({e.__class__.__name__}: "
                           f"{e}) — continuing without the client-side lock; "
                           f"the server serialises its own requests. Delete it "
                           f"if it is owned by the wrong user.", log)


def speak(text, *, ref_audio_path=None, ref_text=None, instruction=None,
          cfg_scale=None, seed=42, timeout=600):
    """One synthesis -> WAV bytes.

    `ref_audio_path` + `ref_text` together select CLONE (or DIRECT when an
    instruction is given too); neither selects DESIGN from `instruction`.
    `cfg_scale` defaults per mode (CLONE 1.0, DIRECT `DIRECT_CFG`, DESIGN 4.0).
    """
    if not enabled():
        raise RuntimeError("breeze: BREEZE_TTS_URL is unset")
    text = (text or "").strip()
    if not text:
        raise ValueError("breeze: empty text")
    has_ref = bool(ref_audio_path)
    if has_ref != bool((ref_text or "").strip()):
        raise ValueError("breeze: ref_audio and ref_text go together")
    ins = (instruction or "").strip()
    if cfg_scale is None:
        cfg_scale = (DIRECT_CFG if (has_ref and ins) else CLONE_CFG) if has_ref else DESIGN_CFG
    fields = {"text": text, "cfg_scale": f"{float(cfg_scale):g}", "seed": str(int(seed)),
              "instruction": ins or DEFAULT_INSTRUCTION,
              "ref_text": (ref_text or "").strip()}
    files = {}
    if has_ref:
        files["ref_audio"] = ("reference.wav", _as_ref_wav(ref_audio_path), "audio/wav")
    body, ctype = _multipart(fields, files)
    req = urllib.request.Request(f"{base_url()}/v1/audio/speech", data=body, method="POST",
                                 headers={"Content-Type": ctype})
    # BEST EFFORT, because `fcntl` is POSIX-only. The lock exists because the
    # server's own API is single-concurrency and the pod runs several lanes at
    # once; a desktop runs one job at a time, so on Windows the absence costs
    # nothing that was ever at risk there.
    with contextlib.ExitStack() as stack:
        _flock(stack)
        # `hold=stack` is what stops the next gpu-lane claim parking the
        # engine between here and the socket below.
        ensure_up(hold=stack)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            rate = int(r.headers.get("X-Sample-Rate") or SAMPLE_RATE)
            pcm = r.read()
    if len(pcm) < 2 * rate // 10:          # under 100ms is a refusal, not a line
        raise RuntimeError(f"breeze: server returned {len(pcm)} bytes of audio for "
                           f"'{text[:40]}'")
    return _wav(pcm, rate)


def design(instruction, text, *, seed=42):
    """A brand-new voice from a natural-language description."""
    return speak(text, instruction=instruction, cfg_scale=DESIGN_CFG, seed=seed)


def to_mp3(wav_bytes, *, rate=44100, bitrate="128k"):
    """WAV -> mp3 bytes (44.1 kHz, the ElevenLabs clips' own rate, so a mixed
    cast concatenates without a resample step)."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "wav", "-i", "pipe:0",
                        "-ar", str(rate), "-ac", "1", "-c:a", "libmp3lame", "-b:a", bitrate,
                        "-f", "mp3", "pipe:1"],
                       input=wav_bytes, capture_output=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"breeze: mp3 encode failed: "
                           f"{(r.stderr or b'')[-200:].decode(errors='replace')}")
    return r.stdout


def wav_duration_ms(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return int(round(w.getnframes() * 1000 / w.getframerate()))


def concat_wavs(parts, *, gap_ms=350, lead_ms=0):
    """Several WAVs (all 24 kHz mono s16le) -> one, `gap_ms` of silence
    between, `lead_ms` before the first. Returns (wav_bytes, [t0_ms…] per
    part) so an exchange assembled here knows EXACTLY where every line sits
    — no ASR alignment needed to cut shots to it."""
    pcm, starts, t = bytearray(), [], 0
    rate = SAMPLE_RATE
    if lead_ms:
        pcm += b"\x00" * (2 * int(rate * lead_ms / 1000))
        t += lead_ms
    for i, w in enumerate(parts):
        if i:
            pcm += b"\x00" * (2 * int(rate * gap_ms / 1000))
            t += gap_ms
        with wave.open(io.BytesIO(w), "rb") as f:
            rate = f.getframerate()
            data = f.readframes(f.getnframes())
        starts.append(t)
        pcm += data
        t += int(round(len(data) / 2 * 1000 / rate))
    return _wav(bytes(pcm), rate), starts


def write_temp(data, suffix=".wav"):
    """Bytes -> a temp path (caller removes it)."""
    fd, path = tempfile.mkstemp(prefix="breeze_", suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path

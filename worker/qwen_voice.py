"""Qwen3-TTS — a SECOND local voice engine, deliberately shaped like the first.

NAMED `qwen_voice` AND NOT `qwen_tts`, WHICH IS NOT COSMETIC: `qwen_tts` is the
pip package this engine's own server imports (`from qwen_tts import
Qwen3TTSModel`), and `qwen_tts_serve.py` runs as a SCRIPT from this directory —
so sys.path[0] is `worker/`, and a module of ours called `qwen_tts` would
shadow the real package and fail the load with an ImportError naming a symbol
nobody can find. `test_qwen_tts.py` pins the two apart.

Every public name here matches `breeze_tts`, because `voice_engines` dispatches
on a TABLE rather than on a second `is_breeze`-style branch at each of the
thirty call sites in `dialogue_synth`. Two engines with one surface is what
makes a third one a table row.

WHAT IT IS: Qwen/Qwen3-TTS, **Apache 2.0** — which is the whole reason it is
here. Breeze's weights are BreezeBlue Research and NON-COMMERCIAL, stated in
its own installer and in the catalog row; this studio's dialogue path has had
no commercially-usable local engine until now.

TWO CHECKPOINTS, AND THAT IS NOT A PACKAGING DETAIL — it is the shape of the
model family. `qwen_tts.Qwen3TTSModel` hard-gates each method on the
checkpoint's own `tts_model_type`:

    generate_voice_design   requires  "voice_design"   (VoiceDesign, 4.52 GB)
    generate_voice_clone    requires  "base"           (Base,        4.54 GB)
    generate_custom_voice   requires  "custom_voice"

so the VoiceDesign checkpoint RAISES on a clone. Design-only cannot carry this
studio's dialogue: a character's voice is designed ONCE and every line is then
cloned from that clip, and re-designing per line would re-roll the timbre on
every line of a scene (`generation_config.json` is `do_sample: true,
temperature: 0.9`, and neither method takes a seed). So the pair is the unit,
and the server holds both — see `qwen_tts_serve`.

THREE THINGS BREEZE DOES AND THIS DOES TWO OF:

  CLONE      ref_audio + ref_text + text   -> that voice says the text   ✅
  DESIGN     text + instruct               -> a NEW voice from prose     ✅
  DIRECT     ref + text + instruction      -> the cloned voice, steered  ❌

`generate_voice_clone` takes no `instruct` at all. The underlying
`Qwen3TTSForConditionalGeneration.generate` does accept `instruct_ids`
alongside `voice_clone_prompt` — the two are separate, non-exclusive branches —
so it is PLUMBED; but the Base checkpoint is not trained for it and the library
never offers it, so it is out of distribution rather than supported.
`SUPPORTS_DIRECTION` is False and `dialogue_synth` reads that instead of
sending an instruction this engine would drop. A delivery note that reaches no
engine is the silent downgrade this codebase keeps naming — so where Breeze
DIRECTS a line, Qwen gets the delivery only through the writer's punctuation
and the vocal events already in the text.

24 kHz mono, the same as Breeze (`speech_tokenizer/config.json`:
`output_sample_rate: 24000`; the "12Hz" in the model name is the CODEC's token
rate, 24000/1920, not a sample rate). That is why the exchange assembler, the
concat and the mp3 contract need no second path.

LICENCE: Apache 2.0, weights and code. Not gated, no token needed.
"""
# POSIX-ONLY, and optional — `breeze_tts`'s reasoning verbatim: the lock
# serialises against a single-concurrency server, Windows has no `fcntl`, and
# the desktop runs one job at a time.
try:
    import fcntl
except ImportError:  # pragma: no cover — Windows
    fcntl = None
import contextlib
import io
import os
import sys
import subprocess
import tempfile
import time
import urllib.request
import uuid
import wave

import gpu_park

SAMPLE_RATE = 24000
LOCK_PATH = os.path.join(tempfile.gettempdir(), "qwen-tts.lock")
# WHO OWNS THE UNIT right now — a SECOND lock, and it is not `LOCK_PATH`.
# That one serialises REQUESTS and is held across `ensure_up`, whose gate wait
# can be fifteen minutes; `park` waits on this one, so it must only ever cover
# a bring-up or a synthesis. `breeze_tts`'s reasoning; see `gpu_park`.
HOLD_PATH = os.path.join(tempfile.gettempdir(), "qwen-tts-hold.lock")
# How this engine names itself in a log line or an error.
LABEL = "qwen-tts"
MODEL_ID = "qwen3-tts-12hz-1.7b"
# The two halves of the pair, by their HuggingFace ids. Named here rather than
# only in the installer because `not_serving_reason` quotes them and because a
# reader asking "which checkpoints is this" should not have to open a shell
# script on a box they may not have.
DESIGN_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
CLONE_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"

# This engine designs a voice and clones from the clip; it cannot steer a
# cloned line. `dialogue_synth` reads this rather than discovering it as a
# dropped instruction. See the module docstring.
SUPPORTS_DIRECTION = False
# HOW A VOCAL EVENT IS SPELLED for this engine: it is NOT. Nothing in the model
# card, the package or the config documents a parenthesised event vocabulary,
# and an undocumented "(sigh)" left in the text is read ALOUD as the word —
# which is worse than losing the sigh. So the events are stripped to the words
# to lip-sync (`vocal_events.strip_events`) until someone measures otherwise,
# and `event_prose` still puts the action in the H3 envelope either way.
EVENT_STYLE = "none"

# `generate_voice_clone(x_vector_only_mode=False)` is ICL mode: the model
# conditions on the reference TEXT plus the reference speech codes, and the
# library requires ref_text for it. We always have one — `design_voice` stores
# the designed clip's transcript on the asset as `meta.speech_text` — so the
# richer mode is the default and the x-vector-only fallback is for a reference
# clip that arrived without a transcript (an uploaded sample).
DEFAULT_LANGUAGE = os.environ.get("QWEN_TTS_LANGUAGE") or "English"


def base_url():
    return (os.environ.get("QWEN_TTS_URL") or "").rstrip("/")


def enabled():
    return bool(base_url())


def health(timeout=5):
    """The server's own /health, or None when it is not answering."""
    if not enabled():
        return None
    try:
        with urllib.request.urlopen(f"{base_url()}/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001 — "not answering" is the answer
        return None


def _multipart(fields, files):
    """(body, content_type) — stdlib only, the same shape `breeze_tts` and
    `voice_clone` both use."""
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
    """The reference clip as 24 kHz mono WAV bytes.

    Decoded HERE rather than server-side for `breeze_tts`'s reason: an mp3
    handed to the audio tokenizer depends on the libsndfile build, and ffmpeg
    is on every box this runs on."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1",
                        "-ar", str(SAMPLE_RATE), "-f", "wav", "pipe:1"],
                       capture_output=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"qwen-tts: could not decode reference clip "
                           f"{os.path.basename(path)}: "
                           f"{(r.stderr or b'')[-200:].decode(errors='replace')}")
    return r.stdout


# ---------------------------------------------------------------- parking --
# QWEN SHARES THE RENDER GPU, and holds MORE than Breeze does: the pair is
# 4.52 + 4.54 GB of weights, so a server with both checkpoints resident sits
# around 10-11 GB beside ComfyUI's ~83 GB — past the headroom that already
# killed a 311-frame PDD r2v block on `SamplerCustomAdvanced:
# torch.OutOfMemoryError` with Breeze's 9 GB resident. So the same rule, for
# the same reason: every line is synthesised at PLAN time, the service has
# nothing to do during a render leg, and the worker parks it before every
# gpu-lane job.
#
# THE BUSY FLAG IS SHARED WITH BREEZE ON PURPOSE — one GPU, one flag. Both
# default to `qamba-gpu-busy`, so `park()` from either engine holds off the
# other, and a box serving both cannot load one beside a render because the
# other happened to be the one the worker knew about.
GPU_BUSY_PATH = (os.environ.get("QWEN_GPU_BUSY_PATH")
                 or os.environ.get("BREEZE_GPU_BUSY_PATH")
                 or os.path.join(tempfile.gettempdir(), "qamba-gpu-busy"))
# THE SYSTEMD UNIT, AND AN EMPTY VALUE MEANS THERE IS NONE — `breeze_tts`'s
# rule, which the desktop already relies on: on the pod this names a unit
# `sudo -n systemctl` drives, and on a desktop the process is a child of the
# app, where a unit name addresses nothing.
UNIT = os.environ.get("QWEN_UNIT")
if UNIT is None:
    UNIT = "qwen-tts"
WAIT_FOR_GPU_S = int(os.environ.get("QWEN_WAIT_S") or 900)
# Longer than Breeze's 120s: this server loads TWO checkpoints (~9 GB) off
# disk before it answers /health, and on the pod's gp3 baseline (125 MB/s,
# measured) that is over a minute of reading alone on a cold page cache.
START_WAIT_S = int(os.environ.get("QWEN_START_WAIT_S") or 300)


def not_serving_reason():
    """Why Qwen3-TTS is not answering, in words the reader can act on.

    THE SAME ABSENCE HAS TWO REMEDIES, and `breeze_tts.not_serving_reason`
    exists for exactly this: a shell script on a box the desktop user does not
    have, or the engine window. Shared by every surface that has to refuse, so
    the three cannot name different fixes for one absence."""
    if enabled():
        return (f"Qwen3-TTS is configured at {base_url()} but is not answering "
                f"— start it, or check its log")
    if UNIT:
        return ("Qwen3-TTS is not serving on this box — "
                "run the engine window's Speech tab, then set QWEN_TTS_URL")
    return ("Qwen3-TTS is not installed here — add it from the engine window's "
            "Speech tab")


def _local_service():
    """Is the URL this box's own service, i.e. something a unit could start."""
    u = base_url()
    return bool(UNIT) and ("127.0.0.1" in u or "localhost" in u)


def _systemctl(verb):
    try:
        r = subprocess.run(["sudo", "-n", "systemctl", verb, UNIT],
                           capture_output=True, timeout=60)
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _active():
    try:
        r = subprocess.run(["systemctl", "is-active", UNIT],
                           capture_output=True, text=True, timeout=15)
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
    for, so a render leg never pays the load twice."""
    gpu_park.unpark(sys.modules[__name__])


def gpu_busy():
    return gpu_park.busy(sys.modules[__name__])


def ensure_up(wait_s=None, log=print, _sleep=time.sleep, hold=None):
    """Health, or start the unit and wait for it. While the GPU is marked busy
    it waits for the lane to go idle first — loading the pair beside a render
    is the OOM this exists to prevent.

    `hold` — an ExitStack the unit is left LOCKED in, so the caller's request
    cannot be parked out from under it between the health check and the
    socket. `speak` passes its own; see `gpu_park`.
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
          language=None, seed=42, timeout=600, log=print):
    """One synthesis -> WAV bytes. `breeze_tts.speak`'s contract, minus DIRECT.

    `ref_audio_path` (+ `ref_text` when there is one) selects CLONE on the
    Base checkpoint; neither selects DESIGN from `instruction` on the
    VoiceDesign one. There is no third mode: an instruction handed in
    ALONGSIDE a reference is dropped, with one line saying so, because
    `generate_voice_clone` has no `instruct` argument — see the module
    docstring. Callers that can avoid asking should read `SUPPORTS_DIRECTION`
    and not ask; this is the backstop for the ones that do.

    Unlike Breeze there is no `cfg_scale`: the family's knobs are the sampling
    ones (`temperature`, `top_p`, `top_k`), which live on the server as its
    generation defaults so a line is one round trip and not a parameter sweep.
    """
    if not enabled():
        raise RuntimeError("qwen-tts: QWEN_TTS_URL is unset")
    text = (text or "").strip()
    if not text:
        raise ValueError("qwen-tts: empty text")
    has_ref = bool(ref_audio_path)
    ins = (instruction or "").strip()
    if has_ref and ins:
        _warn_once("direct", "qwen-tts: this engine cannot steer a cloned line — the "
                             "delivery note is carried by the text alone "
                             "(generate_voice_clone takes no instruct)", log)
        ins = ""
    if not has_ref and not ins:
        raise ValueError("qwen-tts: a reference clip or an instruction is required")
    fields = {"text": text, "seed": str(int(seed)),
              "language": (language or DEFAULT_LANGUAGE),
              "instruction": ins,
              "ref_text": (ref_text or "").strip()}
    files = {}
    if has_ref:
        files["ref_audio"] = ("reference.wav", _as_ref_wav(ref_audio_path), "audio/wav")
    body, ctype = _multipart(fields, files)
    req = urllib.request.Request(f"{base_url()}/v1/audio/speech", data=body,
                                 method="POST", headers={"Content-Type": ctype})
    # BEST EFFORT, `breeze_tts`'s reasoning: the server holds one request lock
    # and the pod runs several lanes at once; Windows has no `fcntl` and the
    # desktop runs one job at a time, so its absence costs nothing there.
    with contextlib.ExitStack() as stack:
        _flock(stack, log)
        # `hold=stack` is what stops the next gpu-lane claim parking the
        # engine between here and the socket below.
        ensure_up(log=log, hold=stack)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            rate = int(r.headers.get("X-Sample-Rate") or SAMPLE_RATE)
            pcm = r.read()
    if len(pcm) < 2 * rate // 10:          # under 100ms is a refusal, not a line
        raise RuntimeError(f"qwen-tts: server returned {len(pcm)} bytes of audio "
                           f"for '{text[:40]}'")
    return _wav(pcm, rate)


def design(instruction, text, *, seed=42, language=None, log=print):
    """A brand-new voice from a natural-language description.

    Runs on the VoiceDesign checkpoint. The description is `instruct`; the
    text is what that voice says, and the clip it produces is what every later
    line CLONES from, so it is the character's timbre reference rather than a
    preview to be thrown away."""
    return speak(text, instruction=instruction, seed=seed, language=language, log=log)


def to_mp3(wav_bytes, *, rate=44100, bitrate="128k"):
    """WAV -> mp3 bytes at 44.1 kHz — the ElevenLabs clips' own rate, so a
    mixed cast concatenates without a resample step. `breeze_tts.to_mp3`'s
    contract exactly; every line clip on B2 is an mp3 under `audio/lines/`."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "wav", "-i", "pipe:0",
                        "-ar", str(rate), "-ac", "1", "-c:a", "libmp3lame",
                        "-b:a", bitrate, "-f", "mp3", "pipe:1"],
                       input=wav_bytes, capture_output=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"qwen-tts: mp3 encode failed: "
                           f"{(r.stderr or b'')[-200:].decode(errors='replace')}")
    return r.stdout


def wav_duration_ms(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return int(round(w.getnframes() * 1000 / w.getframerate()))


def concat_wavs(parts, *, gap_ms=350, lead_ms=0):
    """Several WAVs -> one, with the per-part start times. Byte-for-byte
    `breeze_tts.concat_wavs`: both engines are 24 kHz mono s16le, so an
    exchange with lines from either assembles in one pass and the spans are
    EXACT by construction — no ASR alignment to cut shots to."""
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
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path

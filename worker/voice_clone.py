"""Cloned voices — one reference recording, three providers, one interface.

A clone is a `voice_clones` row: a name, a provider, the reference clip as an
ordinary `assets` row, and whatever that provider calls the voice it made.
Everything downstream (the studio panel, `handle_tts`) names a clone by id and
never learns which provider is behind it.

The three mean genuinely different things by "clone", which is why the row
has BOTH a `reference_id` and a `sample_asset_id` and why this module has a
`register` step at all:

* **fish** (Fish Audio's hosted API) REGISTERS a voice: the sample is POSTed to
  `/model` once, the service keeps it, and every later request cites the id it
  returns. Registration can fail, costs a round trip, and is worth doing once —
  hence a job, hence `status`.
* **fish-local** (s2-pro on the pod) is ZERO-SHOT: there is nothing to
  register, the clip IS the voice, and it is read again at every synthesis.
  Its `register` therefore only validates the sample — and validating is not
  ceremony, because a sample outside the model's 10-30s window is the single
  most common reason a clone sounds nothing like the speaker.
* **elevenlabs** registers too, and is the one that matters most here: what it
  hands back is an ordinary ElevenLabs `voice_id`, which is the SAME kind of
  value as `bible_entries.doc.el_voice_id`. So an ElevenLabs clone needs no
  synthesis code at all (`dialogue_synth._synth` already speaks one), and —
  unlike either Fish provider — it can be CAST ONTO A CHARACTER and carry a
  whole episode's dialogue. `dialogue_synth` is ElevenLabs-only, so a Fish
  clone can never be more than a one-off line in the studio panel.

Every path fails LOUDLY. A cloned voice that quietly renders as a stock voice is
indistinguishable from a clone that worked badly, and the user has no way to
tell which they are hearing.
"""
import json
import mimetypes
import os
import subprocess
import urllib.request
import uuid

import sb
from status import log

FISH_API = "https://api.fish.audio"
EL_API = "https://api.elevenlabs.io/v1"

# The model's own window. Fish's docs and s2-pro's both put a good reference at
# 10-30s: under ~5s there is not enough timbre to copy, and a long clip mostly
# adds room tone and whatever else was happening in it.
MIN_SAMPLE_MS = 4_000
MAX_SAMPLE_MS = 120_000
IDEAL_MS = (10_000, 30_000)

# Where the pod keeps s2-pro. the engine window's model list s2-pro writes here, and the
# repo is laid out exactly as fish-speech's own docs assume.
S2_ROOT = os.environ.get("S2_ROOT", "/data/models/s2-pro")
S2_REPO = os.environ.get("FISH_SPEECH_REPO", "/home/ubuntu/fish-speech")


class CloneError(Exception):
    """Raised with a message a user can act on."""


def _no_key(var, provider):
    """Where a missing key is missing FROM, which is not the same place twice.

    On the pod it is `/etc/neon-worker.env`, a file the studio's owner edits.
    On a desktop it is this machine's own keychain, and Rust puts it in the
    child's environment per job — so "unset on the pod" names a box the reader
    does not have and a file they cannot open. Same shape as
    `breeze_tts.not_serving_reason`."""
    if os.environ.get("MODEL_TIER") == "desktop":
        return (f"add your {provider} key under API keys in the engine window "
                f"to make voices here")
    return f"{var} is unset on the pod"


def providers():
    """Which providers this machine can actually run, and why not when it cannot.

    Returned rather than logged because the studio panel asks: offering a
    provider that has no key is how you get a queue full of failed jobs."""
    out = {}
    out["fish"] = (bool(os.environ.get("FISH_API_KEY")),
                   _no_key("FISH_API_KEY", "Fish Audio"))
    out["elevenlabs"] = (bool(os.environ.get("ELEVENLABS_API_KEY")),
                         _no_key("ELEVENLABS_API_KEY", "ElevenLabs"))
    have = os.path.isdir(S2_ROOT) and os.path.exists(os.path.join(S2_ROOT, "codec.pth"))
    out["fish-local"] = (have and os.path.isdir(S2_REPO),
                         f"s2-pro is not installed (expected weights in {S2_ROOT} "
                         f"and the fish-speech tree in {S2_REPO}) — "
                         f"run the engine window's model list s2-pro on the pod")
    # Breeze is zero-shot like s2-pro (the clip IS the voice, read at every
    # line) and served rather than shelled out to, so "installed" means the
    # service answers — an unreachable server is reported, not assumed.
    import breeze_tts as BT
    out["breeze"] = (bool(BT.enabled() and BT.health()), BT.not_serving_reason())
    return out


def _require(provider):
    ok, why = providers().get(provider, (False, f"unknown provider {provider!r}"))
    if not ok:
        raise CloneError(why)


def check_sample(duration_ms):
    """Return a warning string for a usable-but-poor sample, or raise for an
    unusable one. Never silently accepts a clip that cannot work."""
    if not duration_ms:
        raise CloneError("the reference clip has no measurable duration — "
                         "is it a real audio file?")
    if duration_ms < MIN_SAMPLE_MS:
        raise CloneError(
            f"the reference clip is {duration_ms / 1000:.1f}s; a voice needs at "
            f"least {MIN_SAMPLE_MS / 1000:.0f}s of clean speech to copy "
            f"({IDEAL_MS[0] / 1000:.0f}-{IDEAL_MS[1] / 1000:.0f}s is ideal)")
    if duration_ms > MAX_SAMPLE_MS:
        raise CloneError(
            f"the reference clip is {duration_ms / 1000:.0f}s; trim it to "
            f"{IDEAL_MS[0] / 1000:.0f}-{IDEAL_MS[1] / 1000:.0f}s of one speaker")
    lo, hi = IDEAL_MS
    if duration_ms < lo:
        return (f"{duration_ms / 1000:.1f}s is short — {lo / 1000:.0f}-"
                f"{hi / 1000:.0f}s copies a voice more reliably")
    if duration_ms > hi:
        return (f"{duration_ms / 1000:.0f}s is longer than the {lo / 1000:.0f}-"
                f"{hi / 1000:.0f}s these models are tuned for; the extra mostly "
                f"adds room tone")
    return ""


def _multipart(fields, files):
    """Build a multipart/form-data body.

    Hand-rolled rather than through `fish_audio_sdk`, for the same reason
    `dialogue_synth` hand-rolls its ElevenLabs call: this is one request, the
    SDK's surface changes between releases, and a `create_model` signature that
    moved would break cloning on a pod nobody had re-pip-installed.
    `fields` may repeat a key (Fish takes several `voices`).
    """
    boundary = f"----neon{uuid.uuid4().hex}"
    out = bytearray()
    for key, value in fields:
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n"
                f"{value}\r\n").encode()
    for key, filename, blob in files:
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; "
                f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
        out += blob + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def register(provider, *, name, sample_path, sample_text="", duration_ms=0):
    """Make the provider ready to speak in this voice.

    Returns (reference_id_or_None, warning). A None reference id is correct and
    expected for the zero-shot provider — the caller stores it as-is rather
    than treating it as a failure.
    """
    _require(provider)
    warning = check_sample(duration_ms)

    if provider in ("fish-local", "breeze"):
        # Nothing to register: s2-pro and Breeze read the clip at synthesis
        # time. The sample has already been validated above, which is the
        # whole job here. (Breeze also needs the clip's TRANSCRIPT — `synth`
        # transcribes it once with the reviewer's ASR when none was typed.)
        return None, warning

    with open(sample_path, "rb") as f:
        blob = f.read()

    if provider == "elevenlabs":
        return _register_el(name, sample_path, blob, warning)
    fields = [("type", "tts"), ("title", name[:100]),
              # `private`, always. These are someone's recorded voice and the
              # default on this endpoint puts a model on a public discovery
              # page. `fast` makes it usable immediately.
              ("visibility", "private"), ("train_mode", "fast")]
    if sample_text.strip():
        fields.append(("texts", sample_text.strip()))
    body, ctype = _multipart(fields, [("voices", os.path.basename(sample_path), blob)])
    req = urllib.request.Request(
        f"{FISH_API}/model", data=body, method="POST",
        headers={"Authorization": f"Bearer {os.environ['FISH_API_KEY']}",
                 "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read().decode() or "{}")
    except Exception as e:  # noqa: BLE001 — the message is the whole point
        raise CloneError(f"Fish Audio refused the voice: {e}") from e
    # The API has answered with both spellings across versions.
    rid = data.get("_id") or data.get("id")
    if not rid:
        raise CloneError(f"Fish Audio returned no model id: {str(data)[:200]}")
    log(f"voice_clone: registered '{name}' with Fish Audio as {rid}")
    return rid, warning


def _register_el(name, sample_path, blob, warning):
    """ElevenLabs Instant Voice Cloning — POST /v1/voices/add.

    `requires_verification` in the response is not decoration. Unverified
    accounts get a voice that EXISTS and cannot speak, so it resolves the row
    to `error` with the step that fixes it rather than to `ready` — a picker
    offering a voice that will fail at synthesis is the exact shape this whole
    panel was rebuilt to remove.
    """
    body, ctype = _multipart(
        [("name", name[:100]),
         # Their own noise isolation, because a phone recording of someone
         # talking is what people actually upload.
         ("remove_background_noise", "true")],
        [("files", os.path.basename(sample_path), blob)])
    req = urllib.request.Request(
        f"{EL_API}/voices/add", data=body, method="POST",
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"],
                 "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read().decode() or "{}")
    except Exception as e:  # noqa: BLE001 — the message is the whole point
        raise CloneError(f"ElevenLabs refused the voice: {e}") from e
    vid = data.get("voice_id")
    if not vid:
        raise CloneError(f"ElevenLabs returned no voice id: {str(data)[:200]}")
    if data.get("requires_verification"):
        raise CloneError(
            "ElevenLabs made the voice but needs your account verified before "
            "it can speak — complete voice verification at elevenlabs.io, then "
            "clone again")
    log(f"voice_clone: registered '{name}' with ElevenLabs as {vid}")
    return vid, warning


def synth(clone, text, *, sample_path=None, instruction=None):
    """Speak `text` in a cloned voice. Returns mp3/wav bytes.

    `clone` is the `voice_clones` row. `sample_path` is only read by the
    zero-shot providers, and is required there — a local clone whose sample
    has been deleted cannot speak, and saying so beats rendering a stranger.
    `instruction` is a delivery note; only Breeze reads one (as voice
    DIRECTION), the others take tags or nothing.
    """
    provider = clone.get("provider")
    _require(provider)
    if provider == "breeze":
        if not sample_path:
            raise CloneError(f"'{clone.get('name')}' is a zero-shot clone and its "
                             f"reference clip is gone — re-upload it to use it")
        return _breeze_clone(clone, text, sample_path, instruction)
    rid = clone.get("reference_id")
    if provider in ("fish", "elevenlabs") and not rid:
        raise CloneError(f"'{clone.get('name')}' has no voice id yet — "
                         f"its registration has not finished")
    if provider == "elevenlabs":
        # No new synthesis path: a cloned voice id is the same kind of value
        # as a cast one, so the function every dialogue block already uses
        # speaks it unchanged.
        import dialogue_synth as ds
        return ds._synth(rid, text)
    if provider == "fish":
        import genmedia
        return genmedia.generate_audio(text, fish_reference_id=rid)[0]
    if not sample_path:
        raise CloneError(f"'{clone.get('name')}' is a zero-shot clone and its "
                         f"reference clip is gone — re-upload it to use it")
    return _s2_local(text, sample_path, clone.get("sample_text") or "")


def _breeze_clone(clone, text, sample_path, instruction=None):
    """Zero-shot Breeze clone: the sample and its transcript ARE the voice.

    The transcript is required by the model ("ref_audio and ref_text go
    together"), and a clone made from a dragged-in recording rarely has one
    typed. So it is transcribed ONCE with the reviewer's own faster-whisper —
    the same ASR that measures dialogue — and written back onto the row, the
    "re-perform from audio" idea from the Breeze studio UI. On a box without
    the reviewer (the desktop) a missing transcript is a refusal that names
    the fix, not a guess."""
    import breeze_tts as BT
    import dialogue_synth as ds
    import vocal_events as VE
    ref_text = (clone.get("sample_text") or "").strip()
    if not ref_text:
        try:
            import audioqa
            _words, ref_text = audioqa.transcribe(sample_path)
            ref_text = (ref_text or "").strip()
        except Exception as e:  # noqa: BLE001 — the message is the point
            raise CloneError(f"'{clone.get('name')}' has no transcript and this box "
                             f"cannot transcribe it ({e}) — type what the clip "
                             f"says into the clone's sample text") from e
        if not ref_text:
            raise CloneError(f"'{clone.get('name')}': nothing intelligible was heard in "
                             f"its reference clip — type its transcript by hand")
        try:
            sb.patch(f"voice_clones?id=eq.{clone['id']}", {"sample_text": ref_text})
            clone["sample_text"] = ref_text
        except Exception as e:  # noqa: BLE001 — advisory
            log(f"voice_clone: transcript not saved on {clone.get('id')}: {e}")
    ins = ds._instruction(instruction) if instruction else None
    wav = BT.speak(VE.sanitize_events(text), ref_audio_path=sample_path,
                   ref_text=ref_text, instruction=ins)
    return BT.to_mp3(wav)


def _s2_local(text, sample_path, sample_text):
    """s2-pro's own three-step CLI (speech.fish.audio/inference).

    Three subprocesses rather than an import, and deliberately so: fish-speech
    pins its own torch and pulls a 4B model into memory, and doing that INSIDE
    the worker process would put it beside a live ComfyUI render — the same
    mistake `inspect_take` avoids by holding the GPU semaphore. A subprocess
    exits and gives the memory back.

    Not a server (`tools/api_server.py`) yet, which would be faster per line:
    that is a second systemd unit and a second venv to keep alive, and this
    path is for one-off lines from the studio panel. Revisit if it ever has to
    render a whole episode's dialogue.
    """
    work = f"/tmp/s2_{uuid.uuid4().hex[:8]}"
    os.makedirs(work, exist_ok=True)
    py = os.environ.get("S2_PYTHON", "python3")

    def run(args, note):
        r = subprocess.run(args, cwd=S2_REPO, capture_output=True, text=True,
                           timeout=900)
        if r.returncode != 0:
            raise CloneError(f"s2-pro {note} failed: {(r.stderr or r.stdout)[-400:]}")

    # 1. reference audio -> VQ tokens
    run([py, "fish_speech/models/dac/inference.py", "-i", sample_path,
         "--checkpoint-path", os.path.join(S2_ROOT, "codec.pth"),
         "-o", os.path.join(work, "prompt.npy")], "reference encode")
    # 2. text (+ the reference prompt) -> semantic tokens
    run([py, "fish_speech/models/text2semantic/inference.py",
         "--text", text, "--prompt-text", sample_text,
         "--prompt-tokens", os.path.join(work, "prompt.npy"),
         "--checkpoint-path", S2_ROOT,
         "--output-dir", work], "semantic generation")
    # 3. semantic tokens -> audio
    out = os.path.join(work, "out.wav")
    run([py, "fish_speech/models/dac/inference.py",
         "-i", os.path.join(work, "codes_0.npy"),
         "--checkpoint-path", os.path.join(S2_ROOT, "codec.pth"),
         "-o", out], "vocoder")
    with open(out, "rb") as f:
        return f.read()

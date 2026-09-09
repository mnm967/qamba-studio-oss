"""
genmedia.py — storyboard stills (OpenAI gpt-image-1.5) and dialogue audio
(Fish Audio primary, OpenAI TTS fallback) for the worker.

Keys come from the environment (OPENAI_API_KEY, FISH_API_KEY) — the pod's
own env, or, on the desktop, the key Rust places into the child from the
keychain. Fish is used first per
project preference; if it errors (e.g. 402 no-credit) or the voice has no Fish
reference, we fall back to OpenAI TTS so the pipeline still produces audio.
"""
import os, subprocess, tempfile

IMG_STYLE = ("dark sci-fi cyberpunk anime style, Ghost-in-the-Shell mood, "
             "cinematic lighting, atmospheric, highly detailed, 16:9 film still")

#: OpenAI's own product endpoint, HARDCODED rather than read from
#: `OPENAI_BASE_URL`. That variable points the CHAT backend at whichever
#: OpenAI-compatible provider a deployment uses, and most of those serve no
#: `/audio/speech` at all — borrowing it here would post a character's voice
#: reference to a chat proxy and fail somewhere that names neither. Same
#: convention as `providers/openai_image.py`'s `API`.
OPENAI_API = "https://api.openai.com/v1"


def _openai():
    from openai import OpenAI
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def generate_image(prompt, ref_image_paths=None, size="1536x1024", quality="medium",
                   style=IMG_STYLE):
    """
    Return PNG bytes for a storyboard still. When the shot has linked reference
    images, use the OpenAI image-EDIT endpoint with those references as visual
    inputs so the character + environment are carried into the still; otherwise
    fall back to plain text-to-image.

    `style` is appended to the prompt — pass a different one (or "") for
    reference art, which shouldn't inherit the storyboard's cyberpunk look.
    """
    import base64
    oai = _openai()
    suffix = f". {style}" if style else ""
    if ref_image_paths:
        full = (f"{prompt}. Keep the main character's appearance and the environment "
                f"consistent with the provided reference images{suffix}")
        files = [open(p, "rb") for p in ref_image_paths]
        try:
            r = oai.images.edit(model="gpt-image-1.5", image=files, prompt=full,
                                size=size, quality=quality)
        finally:
            for f in files:
                try: f.close()
                except Exception: pass
    else:
        full = f"{prompt}{suffix}"
        r = oai.images.generate(model="gpt-image-1.5", prompt=full,
                                size=size, quality=quality)
    return base64.b64decode(r.data[0].b64_json)


def _mp3_duration(data):
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(data); path = f.name
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                              "format=duration", "-of", "default=nw=1:nk=1", path],
                             capture_output=True, text=True)
        return round(float(out.stdout.strip() or 0), 2)
    except Exception:
        return 0.0
    finally:
        try: os.remove(path)
        except OSError: pass


def _fish_tts(text, reference_id):
    from fish_audio_sdk import Session, TTSRequest
    s = Session(os.environ["FISH_API_KEY"])
    req = TTSRequest(text=text, reference_id=reference_id, format="mp3")
    return b"".join(s.tts(req))


def _openai_tts(text, voice, instructions):
    """One `/v1/audio/speech` call -> mp3 bytes, over plain urllib.

    DELIBERATELY NOT THE `openai` PACKAGE, and that is the whole point of this
    function. That package is in `worker/requirements.txt`, i.e. THE POD ONLY:
    the desktop ships this same tree to the engine's own bundled Python, which
    has `requests` and nothing else — pinned by
    `test_the_planner_needs_ONLY_requests`, which passes because `_openai`'s
    import is inside a function. So the import was legal and the CALL was
    impossible, and every local voice-reference job died on `No module named
    'openai'` MINUTES AFTER a one-shot plan had already written its
    storyboard. Nothing about the failure named a package the user had never
    been asked to install.

    The shape is `handlers/tts._voxtral_synth`'s, one endpoint over: this API
    is OpenAI-shaped by definition, so a JSON POST is the entire client.
    """
    import json
    import urllib.error
    import urllib.request
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        # Named as the missing SETTING rather than the missing variable: on the
        # desktop this is a key the user pastes into the engine window, and on
        # this path there are four other engines that would have worked.
        raise RuntimeError(
            "OpenAI text-to-speech needs an OpenAI key — add one under API "
            "keys in the engine window, or pick a different voice engine")
    body = {"model": "gpt-4o-mini-tts", "voice": voice or "alloy",
            "input": text, "response_format": "mp3"}
    # Omitted rather than sent empty: `instructions` is what carries a
    # delivery note, and a blank one is not the same request as none.
    if instructions:
        body["instructions"] = instructions
    req = urllib.request.Request(
        f"{OPENAI_API}/audio/speech", data=json.dumps(body).encode(),
        method="POST", headers={"Content-Type": "application/json",
                                "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        # The provider's own sentence, because on this endpoint it is the one
        # that names the fix — out of credit, a revoked key, an unknown voice.
        try:
            detail = (e.read() or b"")[:300].decode("utf-8", "replace")
        except Exception:                       # noqa: BLE001 — best effort
            detail = ""
        raise RuntimeError(f"openai tts failed ({e.code}) {detail}".strip()) from None


def generate_audio(text, *, emotion=None, fish_reference_id=None, openai_voice="alloy"):
    """
    Return (mp3_bytes, duration_sec, provider). Tries Fish Audio first (per
    project preference) when a key + reference exist, else falls back to OpenAI.
    """
    line = text.strip() or "..."
    provider = None
    data = None
    if os.environ.get("FISH_API_KEY") and fish_reference_id:
        try:
            tagged = f"[{emotion}] {line}" if emotion else line
            data = _fish_tts(tagged, fish_reference_id)
            provider = "fish"
        except Exception as e:
            print(f"[genmedia] Fish TTS failed ({e}); falling back to OpenAI", flush=True)
    if data is None:
        instr = "natural, expressive delivery for a cyberpunk anime character"
        if emotion:
            instr = f"{emotion} delivery; cyberpunk anime character"
        data = _openai_tts(line, openai_voice, instr)
        provider = "openai"
    return data, _mp3_duration(data), provider

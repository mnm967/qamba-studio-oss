"""Serve Qwen3-TTS over the same wire Breeze already speaks.

WHY THIS EXISTS AT ALL. The `qwen-tts` package ships exactly one entry point —
`qwen-tts-demo`, a GRADIO app — and nothing else. There is no HTTP API to
point `QWEN_TTS_URL` at, and vLLM's day-0 support is offline inference only.
So the server is ours, and the cheapest correct thing is to speak the wire
`breeze_tts` already speaks: multipart in, raw PCM s16le out with
`X-Sample-Rate`. That is what lets `qwen_tts.py` be `breeze_tts.py` with the
mode table changed instead of a second transport.

BOTH CHECKPOINTS LIVE HERE, and that is the reason this is a server rather
than a subprocess per line. `Qwen3TTSModel` gates each method on the
checkpoint's own `tts_model_type` — VoiceDesign RAISES on a clone, Base RAISES
on a design — so the pair is the unit, and loading ~9 GB per line is not a
thing anyone can pay. They load LAZILY and independently: a box that only ever
designs never pays for Base.

DELIBERATELY OUTSIDE `plan_cli`'s IMPORT CLOSURE, exactly as `breeze_serve` is.
It runs as its own process in the Qwen venv — a different interpreter with a
different transformers (`qwen-tts` pins `transformers==4.57.3` against the
ComfyUI venv's 5.x) — so the bundle tests neither reach it nor should.

STDLIB HTTP, on purpose. The venv has gradio (a `qwen-tts` dependency) and so
has fastapi and uvicorn in it, but depending on them here would pin this
server to whatever gradio drags in next. `http.server` moves when Python does
and not otherwise. `cgi` is NOT used — it was removed in 3.13 — so the
multipart is parsed with `email`, which is not going anywhere.

SINGLE CONCURRENCY, matching the client's file lock: one request at a time,
because two generations on one GPU is how a box that fits one model OOMs.
"""
import io
import os
import sys
import threading
import wave
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DESIGN_REPO = os.environ.get("QWEN_TTS_DESIGN_MODEL") or "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
CLONE_REPO = os.environ.get("QWEN_TTS_CLONE_MODEL") or "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
DEFAULT_LANGUAGE = os.environ.get("QWEN_TTS_LANGUAGE") or "English"

_LOCK = threading.Lock()
_MODELS = {}


def _device():
    """cuda, mps or cpu — `breeze_serve._device`'s ladder, and for its reason.

    Upstream's own quickstart hardcodes `device_map="cuda:0"` and
    `attn_implementation="flash_attention_2"`, neither of which exists on the
    Mac this desktop build mostly runs on. `QWEN_TTS_DEVICE` overrides,
    because the ladder below is a preference and somebody measuring one should
    not have to edit code."""
    want = (os.environ.get("QWEN_TTS_DEVICE") or "").strip()
    if want:
        return want
    try:
        import torch
    except ImportError:  # pragma: no cover — the venv is built with it
        return "cpu"
    if torch.cuda.is_available():
        return "cuda:0"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def _attn(device):
    """flash_attention_2 only where it can exist. The model card's quickstart
    asks for it unconditionally; on mps or cpu that is an import error at load
    time, which reads as the model being broken."""
    if not str(device).startswith("cuda"):
        return "sdpa"
    try:
        import flash_attn  # noqa: F401
        return "flash_attention_2"
    except ImportError:
        return "sdpa"


def _model(kind):
    """The VoiceDesign or Base checkpoint, loaded once. `kind` is "design" or
    "clone" — the two `tts_model_type`s this studio uses."""
    if kind in _MODELS:
        return _MODELS[kind]
    import torch
    from qwen_tts import Qwen3TTSModel
    repo = DESIGN_REPO if kind == "design" else CLONE_REPO
    device = _device()
    print(f"qwen-tts: loading {kind} checkpoint {repo} on {device}", flush=True)
    _MODELS[kind] = Qwen3TTSModel.from_pretrained(
        repo, device_map=device, dtype=torch.bfloat16,
        attn_implementation=_attn(device))
    print(f"qwen-tts: {kind} ready", flush=True)
    return _MODELS[kind]


def _pcm16(wav):
    """A generated waveform -> s16le bytes.

    The library returns float32 in [-1, 1]; anything that clips is the model's
    own level and is CLAMPED rather than rescaled, because rescaling one line
    of a scene and not the next is a level change nothing downstream would
    explain."""
    import numpy as np
    a = np.asarray(wav, dtype=np.float32).reshape(-1)
    return (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def _synthesize(fields, files):
    """One request -> (pcm bytes, sample rate). Mode is decided by whether a
    reference clip came with it, the same test the client makes."""
    import torch
    text = (fields.get("text") or "").strip()
    if not text:
        raise ValueError("empty text")
    language = (fields.get("language") or DEFAULT_LANGUAGE).strip() or "Auto"
    seed = int(fields.get("seed") or 42)
    ref = files.get("ref_audio")
    # REPRODUCIBILITY IS OURS TO PROVIDE. Neither generate method takes a
    # seed and `generation_config.json` is `do_sample: true, temperature:
    # 0.9`, so without this a re-synth of a cached miss returns a different
    # read — and for a DESIGN, a different voice. `design_voice` caches by
    # (name, instruction) precisely so a returning character sounds like
    # themself; that promise is kept here or nowhere.
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    if ref:
        model = _model("clone")
        ref_text = (fields.get("ref_text") or "").strip()
        path = _write_temp(ref)
        try:
            wavs, sr = model.generate_voice_clone(
                text=text, language=language, ref_audio=path,
                ref_text=ref_text or None,
                # ICL mode when we have the transcript — the model conditions
                # on the reference text AND its speech codes, which is the
                # better clone; x-vector-only is the fallback for a reference
                # that arrived without one.
                x_vector_only_mode=not ref_text)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
    else:
        instruct = (fields.get("instruction") or "").strip()
        if not instruct:
            raise ValueError("a reference clip or an instruction is required")
        model = _model("design")
        wavs, sr = model.generate_voice_design(
            text=text, language=language, instruct=instruct)
    return _pcm16(wavs[0]), int(sr)


def _write_temp(data, suffix=".wav"):
    import tempfile
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def parse_multipart(body, content_type):
    """(fields, files) from a multipart body. Pure, and tested — `cgi` is gone
    in 3.13 and a hand-rolled scanner is where an off-by-one silently drops
    the last field."""
    head = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
    msg = BytesParser(policy=HTTP).parsebytes(head + body)
    fields, files = {}, {}
    for part in msg.iter_parts() if msg.is_multipart() else []:
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        if part.get_filename():
            files[name] = payload
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


def wav_bytes(pcm, rate):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter than the default access log
        pass

    def _send(self, code, body=b"", ctype="text/plain", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            loaded = ",".join(sorted(_MODELS)) or "none"
            return self._send(200, f"ok loaded={loaded}\n".encode())
        self._send(404, b"not found\n")

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/audio/speech":
            return self._send(404, b"not found\n")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n)
            fields, files = parse_multipart(body, self.headers.get("Content-Type") or "")
            with _LOCK:
                pcm, rate = _synthesize(fields, files)
        except Exception as e:  # noqa: BLE001 — the client reads the status
            msg = f"{type(e).__name__}: {e}"
            print(f"qwen-tts: {msg}", flush=True)
            return self._send(500, msg.encode()[:2000])
        self._send(200, pcm, "application/octet-stream",
                   {"X-Sample-Rate": str(rate)})


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    host = os.environ.get("QWEN_TTS_HOST") or "127.0.0.1"
    port = int(os.environ.get("QWEN_TTS_PORT") or 7870)
    if "--preload" in argv:
        # The unit preloads so the FIRST line does not pay the load inside a
        # request timeout. Optional: without it the models load on demand.
        _model("design")
        _model("clone")
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"qwen-tts: serving on http://{host}:{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

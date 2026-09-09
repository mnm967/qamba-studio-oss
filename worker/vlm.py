"""Look at a rendered clip with a vision model on this machine.

Two callers, and both exist because every other surface in this studio can
only report what was ASKED FOR rather than what came out:

  * `llm.vlm_query`, behind the director's `inspect_take` — "is she wearing
    the hat in b5" is a question about pixels;
  * `llm.describe_ref_sheet`, which reads a reference sheet the user attached
    so the identity line can be made to agree with the picture.

IT RUNS ON THE LOCAL OLLAMA AND NOWHERE ELSE, deliberately. Routing this
through `llm.complete` would hand the frames to that function's fallback
chain, which walks text-only backends — and a text model answers confidently
about a video it never saw, so a missing capability would arrive looking like
a bad answer.

FRAMES, NOT VIDEO, and that is a TRANSPORT limit rather than a model one:
Ollama's API carries `images` only, so `sample_frames` is how a clip reaches
the model whatever the model can natively read. Swapping in a "better video
model" buys nothing until that changes.
"""
import base64
import json
import os
import subprocess

from status import log



# How densely a clip is sampled. Twelve rather than the four this started at,
# because most of what anyone asks about a shot is a defect BETWEEN frames —
# a freeze, a repeated action, a hand that changes what it is holding — and a
# three-second gap hides a frozen second completely. Density is also the
# closest thing to native video reachable over a transport that carries
# images only.
FRAMES_PER_TAKE = int(os.environ.get("QAMBA_VLM_FRAMES", "12"))


def sample_frames(mp4, n=None, width=640):
    """N frames, evenly spaced, as (media_type, b64, t_seconds).

    The timestamp rides WITH its frame rather than in a parallel list: the
    model is told how far apart the pictures are, and a label that can drift
    off the picture it describes would make every temporal answer wrong in a
    way nothing downstream could detect.
    """
    out = []
    n = FRAMES_PER_TAKE if n is None else n
    dur = _duration_s(mp4)
    if not dur:
        return out
    for i in range(n):
        at = dur * (i + 0.5) / n
        r = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{at:.2f}", "-i", mp4,
             "-frames:v", "1", "-vf", f"scale={width}:-1", "-f", "image2",
             "-c:v", "mjpeg", "-q:v", "5", "pipe:1"],
            capture_output=True)
        if r.returncode == 0 and r.stdout:
            out.append(("image/jpeg", base64.b64encode(r.stdout).decode(), at))
    return out


def _frame_manifest(frames):
    """One line per frame naming the second it was taken from.

    Without it the model is told only "N frames in order", which gives it no
    SPACING — it cannot distinguish a held pose from a frozen render without
    knowing whether two pictures are 0.4s or 4s apart. A frame with no
    timestamp is labelled as such rather than given a fake time.
    """
    rows = []
    for i, f in enumerate(frames, 1):
        t = f[2] if len(f) > 2 else None
        rows.append(f"frame {i}: t={t:.2f}s" if t is not None
                    else f"frame {i}: no timestamp (context frame)")
    return rows


def _duration_s(mp4):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", mp4], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


# ONE MODEL, NO SMALLER FALLBACK. The 8b/4b rungs existed so a judgement could
# ride beside a render on a busy card, and their answers are why defects kept
# sailing through: a 4b model confidently reports a clean take it cannot
# actually parse. Answering "the vision model is not installed" beats
# answering wrongly, so there is no rung below this one.
#
# qwen3.8:27b is Apache 2.0, 18GB at Q4_K_M, vision + tools + thinking. It is
# installable from the engine window's Local LLM tab; a machine without it
# gets a refusal naming it rather than a guess. `QAMBA_VLM_MODEL` names
# another — no code change.
VLM_MODEL = os.environ.get("QAMBA_VLM_MODEL", "qwen3.8:27b")
VLM_TIMEOUT_S = int(os.environ.get("QAMBA_VLM_TIMEOUT_S", "600"))
VLM_NUM_CTX = int(os.environ.get("QAMBA_VLM_NUM_CTX", "32768"))

def _ollama_vision(system, user_text, frames, model=None):
    """One vision turn through the local Ollama — free, private, never rate
    limited. It runs ON the GPU: measured on this box, CPU inference took 5
    minutes for a one-word text reply (8 vCPUs; the 8b build took 28 minutes
    per review), which no cadence survives. It borrows the card beside H3's
    steady ~56/96GB for the seconds a judgment takes, and `keep_alive`
    releases it immediately after — a render keeps owning the VRAM between
    questions."""
    import requests
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    # NUM_CTX MATTERS MORE THAN MODEL SIZE HERE. These models ship a 256K+
    # default context and Ollama PRE-ALLOCATES the KV cache for it — measured
    # at 42GB of VRAM for a 4B model, which is why an unpinned context could
    # not share a card with ComfyUI at all. Too SMALL is the opposite failure
    # and it is silent: image tokens leave no room to generate, and Ollama
    # returns an empty `content` that surfaces as "no JSON object in ''".
    # 32K is sized for FRAMES_PER_TAKE=12; raising the frame count without
    # raising this walks straight back into that, and it does not announce
    # itself.
    # think=False + format=json: Qwen3 under Ollama otherwise reasons into a
    # separate `thinking` field — sometimes leaving `content` empty ('' → "no
    # JSON object") or spilling prose that no repair can parse ("unparseable
    # JSON", both observed live). Constrained JSON decoding ends the class.
    # More load-bearing on qwen3.8, not less: it ships thinking ON by default
    # (Ollama's `think` maps to the card's `enable_thinking`), so dropping
    # this flag reopens the empty-`content` class rather than merely costing
    # latency. The `thinking` fallback below stays for exactly that reason.
    body = {"model": model or VLM_MODEL, "stream": False, "keep_alive": "5m",
            "think": False, "format": "json",
            "options": {"temperature": 0.1, "num_ctx": VLM_NUM_CTX},
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user_text,
                          # f[1], not tuple-unpacking: sample_frames yields
                          # (type, b64, t) while the prev-tail and
                          # one-per-block frames are still (type, b64).
                          "images": [f[1] for f in frames]}]}
    r = requests.post(f"{url}/api/chat", json=body, timeout=(10, VLM_TIMEOUT_S))
    if r.status_code != 200:
        raise RuntimeError(f"ollama {r.status_code}: {r.text[:200]}")
    msg = (r.json().get("message") or {})
    out = msg.get("content") or ""
    if not out.strip():
        # Qwen3 models under Ollama sometimes route the entire reply into the
        # separate `thinking` field and leave `content` empty — which reads as
        # "no JSON object in LLM output: ''" if only content is checked.
        out = msg.get("thinking") or ""
    return out


ASK_SYSTEM = """You are a film continuity supervisor looking at frames sampled \
from ONE video clip, in order. Answer the question you are asked about what is \
ACTUALLY VISIBLE in these frames.

Rules:
- Answer only from the frames. If they cannot settle the question, say so —
  "cannot tell from these frames" is a correct and useful answer, and guessing
  is not.
- The frame manifest gives the second each frame was taken from. Use it when
  the question is about timing, or about something changing during the clip.
- Cite the frames that carry your answer, by number.

Reply as JSON: {"answer": "<one or two sentences>", "frames": [<numbers>], \
"confidence": "high"|"medium"|"low"}"""


def ask(mp4, question, n=None, model=None):
    """Answer a free-form question about a clip from sampled frames.

    Frames rather than the mp4 for the transport reason in the module
    docstring: Ollama carries `images` only, so a model's native video
    support buys nothing here until that changes.

    Deliberately NOT routed through `llm.complete`: its fallback chain would
    land frames on a text-only backend, and the failure would look like a bad
    answer rather than a missing capability.
    """
    frames = sample_frames(mp4, n=n)
    if not frames:
        raise RuntimeError("no frames could be sampled from the clip")
    manifest = "\n".join(_frame_manifest(frames))
    user = (f"Frames sampled from the clip:\n{manifest}\n\n"
            f"Question: {question.strip()}")
    raw = _ollama_vision(ASK_SYSTEM, user, frames, model=model)
    try:
        out = json.loads(raw)
    except Exception:                      # noqa: BLE001 — prose instead of JSON
        out = {"answer": (raw or "").strip()[:1200], "frames": [],
               "confidence": "low"}
    out["frames_sampled"] = len(frames)
    out["frame_times"] = [round(f[2], 2) for f in frames if len(f) > 2]
    return out


SHEET_SYSTEM = """You are a character designer reading a REFERENCE SHEET — one \
image, often several views of the same subject side by side.

Write down only what is VISIBLE. This description becomes the identity line \
repeated into every shot of an episode, so an invented detail is repeated a \
hundred times and a missing one is never drawn.

Cover, in this order and only where the sheet shows it: hair (length, colour, \
any streak or marking), eyes, build, distinguishing marks, then the OUTFIT \
garment by garment with its colours, then held or worn props.

Rules:
- Never name a garment the sheet does not show. If it shows a brown coat, it is
  a brown coat, whatever anyone has called it.
- Ignore the backdrop, the pose grid, any labels or text on the sheet, and any
  colour swatches — they are sheet furniture, not the character.
- No mood, no story, no adjectives about personality. Countable and visual only.
- One sentence, under 60 words.

Also say WHAT KIND of sheet this is, because it decides what still has to be
drawn. Pick exactly one `kind`:
- "turnaround" — the same subject from SEVERAL angles (front/side/back, a view
  grid, or panels labelled with view names). Two views is already a turnaround.
- "full_body"  — ONE figure, head to feet, single view.
- "face"       — head and shoulders only.
- "master"     — a place, shown wide enough to establish it.
- "detail"     — a close view of part of a place, or one object.

Reply as JSON: {"identity": "<the sentence>", "kind": "<one of the above>", \
"confidence": "high"|"medium"|"low"}"""


def describe_sheet(images, model=None):
    """What a reference sheet ACTUALLY shows, as an identity line.

    `images` is a list of (media_type, b64) — the same shape `_ollama_vision`
    takes, so a sheet is just a frame that did not come from a video.

    This exists because a description written WITHOUT the picture is confidently
    wrong and nothing downstream can tell. Measured: a director agreed to treat
    an attached sheet as "the visual authority", then restated its own earlier
    invention verbatim; two turns later it collapsed two characters into one
    costume ("Guide Rei and flashback Astronaut Rei … including the orange
    astronaut suits") because it had one picture and two names. The sheet showed
    a brown coat.

    Deliberately NOT routed through `llm.complete`, for the same reason `ask` is
    not: its fallback chain would land the picture on a text-only backend and
    the failure would look like a bad description rather than a missing
    capability.
    """
    if not images:
        raise RuntimeError("no image to describe")
    raw = _ollama_vision(SHEET_SYSTEM,
                        "Describe the subject of this reference sheet.",
                        images, model=model)
    try:
        out = json.loads(raw)
    except Exception:                      # noqa: BLE001 — prose instead of JSON
        out = {"identity": (raw or "").strip()[:400], "confidence": "low"}
    out["identity"] = " ".join(str(out.get("identity") or "").split())[:400]
    out["kind"] = str(out.get("kind") or "").strip().lower() or None
    return out


def unload():
    """Evict the vision model from VRAM immediately — the next render wants
    the whole card back, and this one borrowed it for a few seconds."""
    import requests
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    requests.post(f"{url}/api/generate",
                  json={"model": VLM_MODEL, "keep_alive": 0}, timeout=(10, 30))

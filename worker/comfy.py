"""ComfyUI driving: submit, wait with progress + cancellation, interrupt,
output download, pretty log tail. Progress comes from ComfyUI's own log
(tqdm sampler ticks) — no extra dependency, same source the pod_status feed
already parses.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import os

COMFY_URL = os.environ.get("COMFY_URL", "http://localhost:8188").rstrip("/")

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_TQDM = re.compile(r"(\d+)%\|.*?\|\s*(\d+)/(\d+)\s*\[([\d:]+)<([\d:?]+)")
_KEEP = re.compile(r"Requested to load|loaded completely|Prompt executed|got prompt|"
                   r"ERROR|OOM|Traceback|error", re.I)


class ComfyError(RuntimeError):
    pass


class Canceled(RuntimeError):
    pass


# -------------------------------------------------------------- readiness ----
# systemd starts neon-worker and comfyui together and ComfyUI listens MINUTES
# later (weights, custom nodes), so "connection refused on localhost:8188" is
# the normal state of a freshly booted pod, not a failure. It used to be
# terminal anyway: the worker claimed a job into that window, urlopen raised,
# run_job filed `unreachable`, and fail_dependents took the rest of the plan
# down with it. A refusal by a service on this box is the one error that is
# always worth waiting out.
_READY_TTL = 20.0
_ready_at = [0.0]

# How long an already-claimed job waits for ComfyUI before giving up. Short on
# purpose: the worker's claim gate is what rides out a boot (it re-polls every
# 3s and costs nothing), so this only ever covers a restart landing between the
# gate saying yes and the job reaching ComfyUI. Waiting here instead blocks the
# main loop, which is also where the cpu/api/llm pool gets refilled.
WAIT_S = float(os.environ.get("COMFY_WAIT", "120"))


def ready(cached=True):
    """Is ComfyUI listening?

    Only the POSITIVE answer is cached (20s). While it is down this is asked on
    the worker's 3s poll, and a refused connection to a local port costs
    nothing — so the pod starts working the moment ComfyUI does, rather than
    waiting out a negative TTL. Pass `cached=False` where a stale yes would be
    the wrong answer (deciding whether a job that just died hit a restart).
    """
    if cached and time.time() - _ready_at[0] < _READY_TTL:
        return True
    try:
        with urllib.request.urlopen(f"{COMFY_URL}/system_stats", timeout=5):
            pass
    except Exception:
        return False
    _ready_at[0] = time.time()
    return True


def wait_ready(timeout=None, poll=5, on_wait=None):
    """Block until ComfyUI answers. Raises ComfyError if it never does.

    Called once per gpu job rather than inside submit(): a handler consults
    /object_info for its capability checks BEFORE it submits anything, and an
    unreachable ComfyUI there is a silent downgrade (a chained block drops to
    the last-frame anchor, a Krea 2 reference job renders on Klein) instead of
    a loud failure.
    """
    if ready():
        return
    t0 = last_note = time.time()
    limit = WAIT_S if timeout is None else timeout
    first = True
    while time.time() - t0 < limit:
        # Throttled: the caller writes this to a job row the browser polls, and
        # a note that has not changed is not worth a round trip every 5s.
        if on_wait and (first or time.time() - last_note >= 30):
            first, last_note = False, time.time()
            try:
                on_wait(time.time() - t0)
            except Exception:                    # a progress note is a nicety
                pass
        time.sleep(poll)
        if ready(cached=False):
            return
    raise ComfyError(f"ComfyUI is not listening on {COMFY_URL} "
                     f"after {int(limit)}s — is the service up?")


def submit(graph, client_id="neon-worker"):
    payload = json.dumps({"prompt": graph, "client_id": client_id}).encode()
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        res = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        raise ComfyError(f"ComfyUI rejected graph: {e.read().decode()[:400]}")
    if res.get("node_errors"):
        raise ComfyError(f"ComfyUI node_errors: {json.dumps(res['node_errors'])[:400]}")
    return res["prompt_id"]


# --------------------------------------------------------------- previews ----
# Per-step sampler previews are the ONE thing ComfyUI does not expose over HTTP.
# Progress, logs, history and outputs are all polled (see the module docstring);
# preview frames are pushed over the websocket and nowhere else, so this is the
# one socket the worker holds.
#
# Deliberately a module-level tap on the SHARED client id rather than a handle
# threaded through every submit() call site: ComfyUI sends previews to whichever
# client submitted the prompt it is currently executing, GPU work on this box is
# serial, and the alternative was touching a dozen call sites to pass an id that
# would always be the same one.
#
# aiohttp is not a new dependency — ComfyUI itself requires it, and the worker
# runs in the same venv (bootstrap installs both into $PY). Nothing here may
# raise into a render: a preview is a nicety, and a render that dies because a
# decorative socket hiccuped would be a straight downgrade.
_PREVIEW_EVENT = 1          # BinaryEventTypes.PREVIEW_IMAGE
_tap = None


class _PreviewTap:
    def __init__(self, client_id):
        self.url = (COMFY_URL.replace("https://", "wss://").replace("http://", "ws://")
                    + f"/ws?clientId={urllib.parse.quote(client_id)}")
        self.frame = None       # (seq, content_type, bytes)
        self._seq = 0
        threading.Thread(target=self._run, daemon=True).start()

    def _take(self, data):
        # 4-byte big-endian event type, then 4-byte image format, then the image
        if len(data) < 8 or int.from_bytes(data[:4], "big") != _PREVIEW_EVENT:
            return
        fmt = int.from_bytes(data[4:8], "big")
        self._seq += 1
        self.frame = (self._seq,
                      "image/png" if fmt == 2 else "image/jpeg",
                      data[8:])

    def _run(self):
        import asyncio

        async def pump():
            import aiohttp
            async with aiohttp.ClientSession() as s:
                while True:
                    try:
                        async with s.ws_connect(self.url, heartbeat=20) as ws:
                            async for msg in ws:
                                if msg.type == aiohttp.WSMsgType.BINARY:
                                    self._take(msg.data)
                    except Exception:
                        pass
                    # ComfyUI restarts, and this thread outlives one job — keep
                    # trying rather than leaving previews dead until a reboot.
                    await asyncio.sleep(5)

        try:
            asyncio.run(pump())
        except Exception:
            pass


def preview_frame(client_id="neon-worker"):
    """Newest sampler preview as (seq, content_type, bytes), or None.

    `seq` only ever increases, so a caller can tell a new frame from the same
    one held between polls and skip re-uploading a picture nobody has changed.
    """
    global _tap
    if _tap is None:
        try:
            _tap = _PreviewTap(client_id)
        except Exception:
            return None
    return _tap.frame


def free_memory():
    """Ask ComfyUI to unload models and free VRAM (POST /free). Used by the
    batched visual reviewer: the card can't hold H3's ~84GB working set and
    a VLM at once, so the batch frees once, judges everything, and lets the
    next master pass pay one reload — a swap per BATCH, not per block."""
    payload = json.dumps({"unload_models": True, "free_memory": True}).encode()
    req = urllib.request.Request(f"{COMFY_URL}/free", data=payload,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    urllib.request.urlopen(req, timeout=60).read()


def interrupt():
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"{COMFY_URL}/interrupt", data=b"", method="POST"), timeout=10)
    except Exception:
        pass


def sampling_progress():
    """(done_steps, total_steps) from the newest tqdm tick in ComfyUI's log,
    or None when nothing is sampling."""
    try:
        with urllib.request.urlopen(f"{COMFY_URL}/internal/logs/raw", timeout=5) as r:
            entries = json.load(r).get("entries", [])
    except Exception:
        return None
    for e in reversed(entries[-60:]):
        m = _TQDM.search(_ANSI.sub("", e.get("m", "")))
        if m:
            _, n, total, _, _ = m.groups()
            return int(n), int(total)
    return None


def _error_detail(messages):
    """The `execution_error` entry's own exception, never a dump of the whole
    status stream. The stream OPENS with execution_start/execution_cached, so
    dumping it truncated cuts off before the error it exists to report —
    measured on three video_edit OOMs whose stored error_msg was 400 bytes of
    node-cache bookkeeping naming no error at all (2026-08-23)."""
    for m in messages or []:
        try:
            kind, data = m[0], m[1]
        except (TypeError, IndexError, KeyError):
            continue
        if kind == "execution_error" and isinstance(data, dict):
            head = str(data.get("node_type") or "node")
            if data.get("node_id"):
                head += f" #{data['node_id']}"
            exc = ": ".join(str(data[k]) for k in ("exception_type", "exception_message")
                            if data.get(k))
            return f"{head}: {exc}"[:400] if exc else json.dumps(data)[:400]
    return json.dumps(messages)[:400]


def wait(pid, *, timeout=1800, poll=2, on_tick=None):
    """Wait for a prompt to finish. on_tick(progress_or_None) fires every poll;
    raise Canceled from it to interrupt ComfyUI and abort."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(poll)
        if on_tick:
            try:
                on_tick(sampling_progress())
            except Canceled:
                interrupt()
                raise
        try:
            h = json.load(urllib.request.urlopen(f"{COMFY_URL}/history/{pid}", timeout=30))
        except Exception:
            continue
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                raise ComfyError(f"ComfyUI execution error: {_error_detail(st.get('messages'))}")
            if st.get("completed") or st.get("status_str") == "success":
                return h[pid]["outputs"]
    raise ComfyError("ComfyUI timed out")


def fetch_output(outputs, out_nodes, dest):
    """Download the media file among the save nodes' outputs."""
    for nid in out_nodes:
        node_out = outputs.get(nid, {})
        for items in node_out.values():
            if not isinstance(items, list):
                continue
            for it in items:
                if not isinstance(it, dict) or "filename" not in it:
                    continue
                fn = it["filename"]
                sub = it.get("subfolder", "")
                typ = it.get("type", "output")
                url = (f"{COMFY_URL}/view?filename={urllib.parse.quote(fn)}"
                       f"&subfolder={urllib.parse.quote(sub)}&type={typ}")
                data = urllib.request.urlopen(url, timeout=300).read()
                with open(dest, "wb") as f:
                    f.write(data)
                return fn
    raise ComfyError("no output file in ComfyUI history")


def object_info():
    try:
        return json.load(urllib.request.urlopen(f"{COMFY_URL}/object_info", timeout=30))
    except Exception:
        return {}


def free_memory(unload_models=True):
    """Ask ComfyUI to drop cached models — called between model families so
    H3 + SeedVR2 + friends never co-reside on the card."""
    try:
        body = json.dumps({"unload_models": unload_models, "free_memory": True}).encode()
        urllib.request.urlopen(urllib.request.Request(
            f"{COMFY_URL}/free", data=body,
            headers={"Content-Type": "application/json"}), timeout=30)
    except Exception:
        pass


def _pretty(line):
    s = _ANSI.sub("", line).replace("\r", "").strip()
    if not s:
        return None
    m = _TQDM.search(s)
    if m:
        pct, n, total, _elapsed, left = m.groups()
        return f"sampling {n}/{total} ({pct}%) · {left} left"
    if not _KEEP.search(s):
        return None
    s = s.replace("[INFO]", "").replace("[ERROR]", "!").strip()
    if s.startswith("Requested to load"):
        return "loading " + s[len("Requested to load"):].strip()
    if s.startswith("loaded completely"):
        mb = re.search(r"([\d.]+) MB loaded", s)
        return f"loaded ({float(mb.group(1)) / 1024:.1f} GB)" if mb else "loaded"
    return s[:110]


def log_tail(worker_rows, n=5):
    """Merge worker milestones with ComfyUI's log, newest last."""
    rows = list(worker_rows)
    try:
        with urllib.request.urlopen(f"{COMFY_URL}/internal/logs/raw", timeout=5) as r:
            entries = json.load(r).get("entries", [])
        seen = None
        for e in entries[-120:]:
            txt = _pretty(e.get("m", ""))
            if not txt:
                continue
            if txt.startswith("sampling") and seen == "sampling":
                rows.pop()
            seen = "sampling" if txt.startswith("sampling") else None
            rows.append((str(e.get("t", ""))[11:19], txt))
    except Exception:
        pass
    rows.sort(key=lambda r: r[0])
    return [f"{t}  {m}" for t, m in rows[-n:]]

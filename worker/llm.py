"""Director LLM: pipeline tasks + local chat on the worker.

Backends (selected by jobs.model_id, payload.backend, or env availability):
  claude-oauth   Claude subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN)
  claude-api     Anthropic API key (ANTHROPIC_API_KEY)
  ollama-local   a model on this machine, through Ollama. The worker loop
                 holds the GPU semaphore for llm-lane jobs whose model_id
                 starts with "ollama", so a 20GB model never loads mid-render
  openai-compat  any OpenAI-compatible endpoint (OPENAI_API_KEY)

Tasks (jobs.kind='llm_task', payload.task):
  plan_storyboard  brief -> scenes/beats + draft bible entries; tier-1 runs
                   also enqueue ref-sheet image_gen jobs and a launch_render
                   chained behind them (the "one-shot" DAG)
  lore_update      observations -> bible_revisions draft (user confirms in UI)
  flf_prompt       frame pair -> transition prompt (vision on Claude backends,
                   template fallback everywhere else)
  enhance_prompt   one generation prompt -> rewritten against that model's
                   prompt guide; the local twin of api/director/enhance.js
                   (result lands on payload.result.prompt)
  chat             local-model chat: pseudo-streams into chat_messages (the
                   hosted backends stream from api/director/chat instead)
  redraw_panels    re-draw a scene's storyboard panels from the beats as they
                   stand now — the director chat's reach into the one
                   generator tier 1 and the browser button already share
jobs.kind='embed'  rag_chunks embedding backfill

Invariant #6: the LLM fills structured scenes/beats — it never emits the H3
prompt format. h3_prompt.py compiles deterministically at master_pass time.
"""
import base64
import hashlib
import json
import os
import re
import time

import requests

import image_prompt
import byok
import sb
import score_prompt
from status import log

# `or` rather than a get() default: /etc/neon-worker.env is generated from a
# template, so an unset key arrives as KEY= — present but empty. A get()
# default would not fire and we would post model="" to the API.
def _env(key, default):
    return (os.environ.get(key) or "").strip() or default


ANTHROPIC_URL = _env("ANTHROPIC_URL", "https://api.anthropic.com/v1/messages")
ANTHROPIC_MODEL = _env("ANTHROPIC_MODEL", "claude-opus-5")
OPENAI_BASE = _env("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_MODEL = _env("OPENAI_MODEL", "gpt-5.6-terra")
OLLAMA_URL = _env("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
# The default local director. 27.3B Q4_K_M, ~18GB, 256K context, Apache 2.0 —
# and it declares TOOLS, which the director loop below needs: a model without
# them can describe an edit and cannot make one. `OLLAMA_MODEL` names another,
# and the engine window's Local LLM tab is where one is installed.
#
# CHECK `ollama -v` BEFORE BLAMING A BAD REPLY. Chat formatting and tool-call
# parsing come from a renderer built into the DAEMON rather than from the model
# file, so too old a daemon pulls this happily and then has no qwen3.8 renderer
# — the system prompt and every tool signature are dropped, silently.
OLLAMA_MODEL = _env("OLLAMA_MODEL", "qwen3.8:27b")
EMBED_MODEL = "text-embedding-3-small"

# $/MTok (input, output) for ledger estimates; unknown models book 0.
#
# PREFIX-MATCHED IN INSERTION ORDER (see `_price`), so a shorter id written
# above a longer one captures it — `claude-fable-5-1` must stay ABOVE any
# future `claude-fable-5` row, or the legacy model's rate books the new one's
# tokens. Twin of api/director/_backends.js's PRICES; the two are separate
# because one bills the pod's own turns and the other the functions', and
# they price the same published list.
PRICES = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    # $2/$10, not the (3.0, 15.0) that stood here — re-read off Anthropic's own
    # models table 2026-09-07, same correction as the twin in _backends.js.
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "gpt-4o": (2.5, 10.0),
    "gpt-4.1": (2.0, 8.0),
    "gpt-4o-mini": (0.15, 0.6),
    # Standard short-context rate. Above 272K input tokens OpenAI reprices the
    # WHOLE request at $20/$75, which this table cannot express — a very long
    # turn is under-booked rather than attributed to the wrong model. Reachable
    # here through OPENAI_MODEL / PIPELINE_LLM_MODEL / payload.llm_model, and
    # the openai path below sends NO tools, so the planner can spend it where
    # the director's tool loop cannot (see api/director/_backends.js).
    "gpt-6-astra": (10.0, 50.0),
    "gpt-5.6-luna": (0.20, 1.20),
    # terra: the writing/planning model since 2026-09-01; list price not
    # yet published on the account page, so luna's rate stands in as the
    # ESTIMATE until the ledger sees a real usage block.
    "gpt-5.6-terra": (0.20, 1.20),
}

# What a CACHED input token costs, as a multiple of the model's input rate.
#
# THE TWO PROVIDERS REPORT CACHE USAGE DIFFERENTLY, and getting that backwards
# is a silent accounting error rather than a crash — so the two cost functions
# below are written out separately instead of sharing one:
#
#   * Anthropic reports `input_tokens` EXCLUDING anything cached, alongside
#     `cache_creation_input_tokens` and `cache_read_input_tokens`. Writing a
#     cache entry costs MORE than a plain token (you are paying to store it);
#     reading one costs a tenth.
#   * OpenAI reports `prompt_tokens` INCLUDING the cached part, with
#     `prompt_tokens_details.cached_tokens` as a subset of it. Nothing is
#     charged to write one — its caching is automatic.
#
# Subtract on one and not the other, and a cache hit is booked as more
# expensive than a miss.
ANTHROPIC_CACHE_WRITE = 1.25
ANTHROPIC_CACHE_READ = 0.10
OPENAI_CACHE_READ = 0.50

# …EXCEPT WHERE ANTHROPIC PRICES IT DIFFERENTLY, and Fable 5.1 is the first
# model here that does: its cache reads are 2.5% of the base input rate rather
# than 10% (Anthropic's own models table says so in as many words, alongside
# Mythos 5.1). Booked at the flat rate a Fable cache hit is over-charged FOUR
# TIMES over in the ledger — silently, since the request succeeds and the
# number is only ever compared against itself. Prefix-matched like PRICES.
ANTHROPIC_CACHE_READ_BY_MODEL = {
    "claude-fable-5-1": 0.025,
}


def _cache_read_rate(model):
    for prefix, rate in ANTHROPIC_CACHE_READ_BY_MODEL.items():
        if model.startswith(prefix):
            return rate
    return ANTHROPIC_CACHE_READ

# MEASURED 2026-09-03, against the real API, fresh prefix per arm.
#
# GPT-5.6 CACHES ONLY WITH AN EXPLICIT BREAKPOINT, and finding that out cost a
# wrong conclusion first: a 2,772-token shared prefix repeated with different
# tails reported ZERO cached tokens on gpt-5.6-luna and -terra at every spacing
# tried (0s, 45s, 135s, 270s), which reads exactly like a model that does not
# support caching. It is not. OpenAI's own guide names the case —
#
#   "If requests share a long prefix but have different suffixes, caching the
#    first complete request implicitly-only does not make the shorter shared
#    prefix reusable."
#
# — because IMPLICIT caching stores the whole request, and no request here ever
# ended at the shared boundary. gpt-4o hid this by being an earlier model:
# those cache implicitly at 128-token granularity, so it reused the prefix with
# no help (measured 2,560/2,760 on its second call) while the newer models did
# not. The A/B, three calls per arm:
#
#   | model         | breakpoint | call 0 | call 1 | call 2 |
#   |---------------|------------|--------|--------|--------|
#   | gpt-5.6-terra | off        |     0% |     0% |     0% |
#   | gpt-5.6-terra | ON         |     0% |    99% |      — |
#   | gpt-5.6-luna  | off        |     0% |     0% |     0% |
#   | gpt-5.6-luna  | ON         |     0% |    99% |    99% |
#
# So the breakpoint is the whole feature on this provider, not a refinement.
#
# Anthropic's caching is EXPLICIT (`cache_control` below) and does work — so
# the machinery here is for the Claude path, which is what `pick_backend`
# prefers whenever a Claude credential is present.


class LLMError(RuntimeError):
    pass


# ---------------------------------------------------------------- backends ---
def pick_backend(job=None, payload=None):
    """model_id > payload.backend > first configured (oauth, api key, openai,
    ollama). Raises with a setup hint when nothing is configured."""
    want = None
    if job and job.get("model_id"):
        want = job["model_id"]
    elif payload and payload.get("backend"):
        want = payload["backend"]
    if want in ("claude-oauth", "claude-api"):
        if not (_oauth(job) or _key("ANTHROPIC_API_KEY", "anthropic", job)):
            raise LLMError("Claude backend requested but neither CLAUDE_CODE_OAUTH_TOKEN "
                           "nor ANTHROPIC_API_KEY is set on the worker, and this "
                           "job's owner has not shared an Anthropic key")
        return want
    if want == "openai-compat":
        if not _key("OPENAI_API_KEY", "openai", job):
            raise LLMError("openai-compat requested but OPENAI_API_KEY is not set on the "
                           "worker and this job's owner has not shared an OpenAI key")
        return want
    if want == "ollama-local":
        return want
    if _oauth(job):
        return "claude-oauth"
    if _key("ANTHROPIC_API_KEY", "anthropic", job):
        return "claude-api"
    if _key("OPENAI_API_KEY", "openai", job):
        return "openai-compat"
    return "ollama-local"


def _ollama_reachable():
    """Ollama is only a fallback if it is actually installed on this pod, and
    the check is cheap — it answers over localhost or not at all."""
    try:
        return requests.get(f"{OLLAMA_URL}/api/tags", timeout=2).status_code == 200
    except requests.RequestException:
        return False


def _key(name, provider, job=None):
    """The key to spend: the studio's for an ADMIN, else this owner's shared one.

    `byok.key_for` owns the decision and its docstring owns the reasoning. The
    short version: sign-ups are open, every browser surface that spends the
    studio's provider keys is admin-gated, and an `llm_task` is a row any
    signed-in account can insert on a lane this worker claims — so client
    gating alone would leave the studio's credential one hand-written row away.
    """
    return byok.key_for(job, provider, env_name=name)


def _oauth(job=None):
    """The studio's Claude SUBSCRIPTION token, for an admin's job only.

    It is the one credential with no BYOK counterpart — a subscription is not
    something a member can share a copy of — so for anyone else it simply is
    not there, and `backend_chain` falls to whatever they DID share, or to the
    local model, which is free and runs on this box.
    """
    return os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") if byok.is_admin(job) else None


def _configured(backend, job=None):
    # claude-oauth runs on either credential (_anthropic_headers falls back to
    # the key); claude-api strictly needs the key. Treating them as one test put
    # a backend in the chain that raised "ANTHROPIC_API_KEY not set" the moment
    # it was tried — a hard error that ended the chain before OpenAI got a turn.
    if backend == "claude-oauth":
        return bool(_oauth(job) or _key("ANTHROPIC_API_KEY", "anthropic", job))
    if backend == "claude-api":
        return bool(_key("ANTHROPIC_API_KEY", "anthropic", job))
    if backend == "openai-compat":
        return bool(_key("OPENAI_API_KEY", "openai", job))
    if backend == "ollama-local":
        return _ollama_reachable()
    return False


def backend_chain(requested, job=None):
    """The requested backend first, then every other one this pod can reach.

    Twin of `backendChain` in api/director/_backends.js. A 429 on the
    subscription token is routine, and a storyboard plan is expensive to lose —
    the same reason the hosted director falls forward, except here the local
    model is a legitimate last resort because it runs on this box.
    """
    oauth = bool(_oauth(job))
    chain = [requested]
    for cand in ("claude-oauth", "claude-api", "openai-compat", "ollama-local"):
        # Without an OAuth token the two Claude ids are the same request against
        # the same key, so "falling back" to it would just hit the same limit.
        dupe = cand in chain or (not oauth and cand == "claude-api"
                                 and "claude-oauth" in chain)
        if not dupe and _configured(cand, job):
            chain.append(cand)
    return chain


_TRANSIENT = re.compile(r"\b(408|409|429|5\d\d)\b|rate.?limit|overload|capacity|"
                        r"timed? ?out|timeout|unreachable|connection", re.I)


def is_transient(err):
    """Worth another backend? Rate limits, overloads and transport blips — not
    a 400 or a rejected key, which every provider will refuse the same way.

    A backend that cannot even be attempted (credential missing on this pod)
    counts too: skipping it is the whole point, and letting it end the chain
    would strand jobs behind a provider that was never usable.
    """
    msg = str(err)
    if re.search(r"not set|not configured", msg, re.I):
        return True
    if re.search(r"\b(400|401|403|404)\b", msg):
        return False
    return bool(_TRANSIENT.search(msg))


def explain_error(err):
    """Provider errors are a wall of JSON, and this one lands in `error_msg`
    where the user reads it. Keep the code, drop the envelope."""
    msg = str(err).strip() or err.__class__.__name__
    m = re.search(r"\b(4\d\d|5\d\d)\b", msg)
    status = m.group(1) if m else None
    if re.search(r"rate.?limit", msg, re.I) or status == "429":
        kind = "rate limited"
    elif re.search(r"overload|capacity", msg, re.I) or status == "529":
        kind = "overloaded"
    elif status in ("401", "403"):
        kind = "credentials rejected"
    elif re.search(r"timed? ?out|timeout", msg, re.I):
        kind = "timed out"
    elif re.search(r"unreachable|connection", msg, re.I):
        kind = "unreachable"
    elif status and status.startswith("5"):
        kind = "provider error"
    else:
        return msg[:200]
    return f"{kind} ({status})" if status else kind


def _anthropic_headers(backend, job=None):
    h = {"content-type": "application/json", "anthropic-version": "2023-06-01"}
    tok = _oauth(job)
    if backend == "claude-oauth" and tok:
        h["authorization"] = f"Bearer {tok}"
        h["anthropic-beta"] = "oauth-2025-04-20"
    else:
        key = _key("ANTHROPIC_API_KEY", "anthropic", job)
        if not key:
            raise LLMError("ANTHROPIC_API_KEY not set")
        h["x-api-key"] = key
    return h


def _price(model):
    for prefix, p in PRICES.items():
        if model.startswith(prefix):
            return p
    return (0.0, 0.0)


# The shortest block worth marking cacheable.
#
# Anthropic will not cache a block under ~1024 tokens and says nothing about
# it — the request succeeds and no entry is written. There are only four
# breakpoints per request, so this guard is about not spending one on a block
# that cannot use it; a block that clears this and still falls short is simply
# not cached, at no cost.
CACHE_MIN_CHARS = 2000


def _tally(meta, stage_id, m):
    """Book one completion's tokens against a stage.

    ACCUMULATED, not assigned: a stage runs more than once whenever its
    validator raises a batched re-ask, and `character` runs once per speaker.
    Overwriting would report the last call as the whole stage — and the
    per-character pass, which is the one set a batch API could help, is exactly
    the one that would be understated.
    """
    st = meta["stages"].setdefault(
        stage_id, {"calls": 0, "in": 0, "out": 0, "cached": 0, "cost": 0.0})
    st["calls"] += 1
    st["in"] += m.get("tokens_in", 0) or 0
    st["out"] += m.get("tokens_out", 0) or 0
    st["cached"] += m.get("cache_read", 0) or 0
    st["cost"] += m.get("cost_usd", 0) or 0
    meta["tokens_in"] += m.get("tokens_in", 0) or 0
    meta["tokens_out"] += m.get("tokens_out", 0) or 0
    meta["cache_read"] += m.get("cache_read", 0) or 0
    meta["cache_write"] += m.get("cache_write", 0) or 0
    if m.get("estimated"):
        meta["estimated"] = True


def system_blocks(system):
    """`system` as a list of cache-delimited blocks.

    A caller passes a LIST when it knows which prefix is stable across calls —
    `plan_storyboard` splits the persona and craft references (identical for
    every stage of a plan) from the per-stage task and contract. A plain string
    is one block and behaves exactly as it always did.
    """
    if isinstance(system, str):
        return [system]
    return [b for b in system if b]


def system_text(system):
    """The same thing flattened, for a backend with no cache control.

    Concatenated with NO separator: the blocks are a split of what used to be
    one string, so joining with anything would change the prompt every other
    backend sees.
    """
    return system if isinstance(system, str) else "".join(b for b in system if b)


def _openai_cache_ok():
    """Whether this endpoint can be sent cache-control fields at all.

    GATED ON THE HOST, because `openai-compat` is named for the DIALECT rather
    than the vendor: `OPENAI_BASE_URL` can point at Azure, OpenRouter, a local
    vLLM. `prompt_cache_breakpoint` and `prompt_cache_key` are OpenAI's own,
    and a server that rejects an unknown field answers 400 — which is not
    transient, so it would not fall forward to another backend; it would end
    the plan. This repo has already paid for that shape once, with `max_tokens`
    against a model that wanted `max_completion_tokens`.

    `QAMBA_OPENAI_CACHE=1` forces it on for a proxy that does support it, `0`
    off. Unset is the measured-safe default.
    """
    flag = os.environ.get("QAMBA_OPENAI_CACHE", "").strip()
    if flag:
        return flag not in ("0", "false", "no")
    return OPENAI_BASE.startswith("https://api.openai.com")


def openai_system(system):
    """(content for the system message, prompt_cache_key or None).

    Returns a plain STRING unless there is a stable prefix worth marking, so
    every caller that passes one system string — the director chat, enhance,
    the reviewer — sends exactly the bytes it always did. Only the planner,
    which knows which prefix repeats, gets the content-part form.
    """
    blocks = system_blocks(system)
    if len(blocks) < 2 or not _openai_cache_ok():
        return system_text(system), None

    parts, key = [], None
    for i, blk in enumerate(blocks):
        part = {"type": "text", "text": blk}
        # Same rule as the Anthropic branch: mark every block but the LAST,
        # which is the one that changes per call.
        if i < len(blocks) - 1 and len(blk) >= CACHE_MIN_CHARS:
            part["prompt_cache_breakpoint"] = {"mode": "explicit"}
            # THE ROUTING KEY IS THE PREFIX ITSELF, hashed. A cached prefix
            # lives on one machine and requests are routed by load plus a hash
            # of their opening tokens, so keying on anything else — a job id, a
            # project — would scatter calls that share a prefix across machines
            # and lose the hit this breakpoint just bought.
            key = "qs-" + hashlib.sha256(blk.encode("utf-8")).hexdigest()[:24]
        parts.append(part)
    if key is None:
        # Nothing was long enough to mark; send the string rather than an
        # array, so the request shape only ever changes when it buys something.
        return system_text(system), None
    return parts, key


RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}
RETRY_MAX = 4


def _post_retrying(url, *, headers, body, timeout, cancel_check=None, label="llm",
                   max_retries=RETRY_MAX):
    """POST with bounded backoff on rate limits and transient upstream errors.

    A subscription token hits 429 as a matter of routine, and these calls sit
    at the front of jobs that are expensive to redo — a plan_storyboard lost
    to one rate limit costs the whole storyboard. Honours Retry-After when the
    server sends it, otherwise 2/4/8/16s. Auth and request errors (401/403/
    400) are not retried: those need a human, and hammering them helps nobody.
    """
    delay = 2
    for attempt in range(max_retries + 1):
        r = requests.post(url, headers=headers, data=json.dumps(body),
                          stream=True, timeout=timeout)
        if r.status_code == 200 or r.status_code not in RETRY_STATUS or attempt == max_retries:
            return r
        wait = delay
        try:                                  # server knows better than we do
            wait = max(1, min(60, int(float(r.headers.get("retry-after", delay)))))
        except (TypeError, ValueError):
            pass
        detail = (r.text or "")[:120].replace("\n", " ")
        r.close()
        log(f"{label} {r.status_code} — retry {attempt + 1}/{max_retries} in {wait}s: {detail}")
        # Sleep in slices so a cancel lands promptly instead of after a minute.
        for _ in range(wait):
            if cancel_check and cancel_check():
                raise LLMError(f"{label} canceled while backing off")
            time.sleep(1)
        delay = min(60, delay * 2)
    return r                                   # unreachable; keeps linters calm


def _iter_sse(resp):
    """'data: {...}' lines -> parsed events (Anthropic + OpenAI share this)."""
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        data = raw[5:].strip()
        if data == "[DONE]":
            return
        try:
            yield json.loads(data)
        except json.JSONDecodeError:
            continue


def _throttle(cancel_check, interval=2.0):
    """Stream loops call the cancel check per event; a raw sb.cancel_requested
    would be one DB round trip per token. Gate it to one real check per
    `interval` seconds."""
    if cancel_check is None:
        return None
    last = [0.0]

    def gated():
        now = time.time()
        if now - last[0] < interval:
            return False
        last[0] = now
        return cancel_check()

    return gated


def complete(system, messages, *, backend, max_tokens=8192, on_delta=None,
             cancel_check=None, images=None, model=None, on_fallback=None,
             job=None):
    """One completion, falling forward through the configured backends.

    Every pipeline task funnels through here, so a rate-limited subscription
    token used to kill a whole storyboard plan after four rounds of backoff —
    minutes of work and a red modal — while an OpenAI key sat unused in the
    same env. Only transient failures move on, and only while nothing has been
    streamed: resuming on a second model mid-sentence would splice two replies.

    `on_fallback(from, to, reason)` is called before each hop so callers can say
    so on the job (`plan_storyboard` writes it into progress_note).
    """
    chain = backend_chain(backend, job)
    last = None
    for i, b in enumerate(chain):
        try:
            # Back off hard only on the last hop. Waiting out 2/4/8/16s on a
            # sustained limit while a configured provider sits idle is how a
            # plan took a minute to fail instead of seconds to succeed.
            return _complete_once(system, messages, backend=b, max_tokens=max_tokens,
                                  on_delta=on_delta, cancel_check=cancel_check,
                                  images=images, model=model, job=job,
                                  retries=RETRY_MAX if i == len(chain) - 1 else 1)
        except (InterruptedError, KeyboardInterrupt):
            raise                       # a cancel is not a provider failure
        except Exception as e:          # noqa: BLE001 — re-raised below
            last = e
            nxt = chain[i + 1] if i + 1 < len(chain) else None
            if not nxt or not is_transient(e) or getattr(e, "streamed", False):
                raise
            log(f"{b} failed ({explain_error(e)}) — falling back to {nxt}")
            if on_fallback:
                try:
                    on_fallback(b, nxt, explain_error(e))
                except Exception:       # noqa: BLE001 — a note is not the job
                    pass
    raise last or LLMError("no LLM backend is configured on this worker")


def _complete_once(system, messages, *, backend, max_tokens=8192, on_delta=None,
                   cancel_check=None, images=None, model=None, retries=RETRY_MAX,
                   job=None):
    """One completion against one backend. `messages` = [{role, content:str}].
    `images` = optional [(media_type, b64), ...] attached to the last user
    message (Claude backends only). Returns (text, meta{model,in,out,cost}).
    """
    cancel_check = _throttle(cancel_check)
    streamed = [False]

    def emit(piece):
        streamed[0] = True
        if on_delta:
            on_delta(piece)

    def tag(e):
        """Mark errors raised after output reached the caller — those cannot be
        retried on another backend without duplicating half a reply."""
        if streamed[0]:
            e.streamed = True
        return e

    try:
        return _complete_backend(system, messages, backend=backend, max_tokens=max_tokens,
                                 on_delta=emit, cancel_check=cancel_check,
                                 images=images, model=model, retries=retries, job=job)
    except (InterruptedError, KeyboardInterrupt):
        raise
    except Exception as e:              # noqa: BLE001 — re-raised immediately
        raise tag(e)


def _complete_backend(system, messages, *, backend, max_tokens, on_delta,
                      cancel_check, images, model, retries=RETRY_MAX, job=None):
    # `job` is what byok.key_for reads the owner's shared key off. It rode
    # complete() since the BYOK work and stopped one call short: neither
    # inner function took it, so the first openai-compat plan after that
    # commit died on `NameError: name 'job' is not defined` at the bearer
    # header (2026-09-02, the first NIGHT SHIFT plan). Threaded all the way.

    if backend in ("claude-oauth", "claude-api"):
        content = [{"type": "text", "text": messages[-1]["content"]}]
        for mt, b64 in (images or []):
            content.insert(0, {"type": "image",
                               "source": {"type": "base64", "media_type": mt, "data": b64}})
        # PROMPT CACHING. `cache_control` goes on every block but the LAST,
        # which is the natural reading of the list a caller passes: "the prefix
        # up to here is the same on the next call". A plan sends the persona and
        # the craft references — ~3k tokens, byte-identical across all nine
        # stages — as block one, and the stage's own task and contract as block
        # two, so the shared part is written once and read back at a tenth of
        # the rate eight times.
        sys_blocks = system_blocks(system)
        sys_field = []
        for i, blk in enumerate(sys_blocks):
            b = {"type": "text", "text": blk}
            if i < len(sys_blocks) - 1 and len(blk) >= CACHE_MIN_CHARS:
                b["cache_control"] = {"type": "ephemeral"}
            sys_field.append(b)
        body = {
            # `model` used to be an openai-compat-only knob; the Claude branch
            # honors it now so cheap vision work (the take reviewer) can run on
            # Haiku instead of whatever ANTHROPIC_MODEL is set to.
            "model": model or ANTHROPIC_MODEL, "max_tokens": max_tokens, "stream": True,
            "thinking": {"type": "adaptive"},
            # A single block is still sent as a LIST rather than a bare string.
            # Both are legal and the list is what carries cache_control, so
            # sending one shape always is one code path instead of two.
            "system": sys_field,
            "messages": [*messages[:-1], {"role": messages[-1]["role"], "content": content}],
        }
        r = _post_retrying(ANTHROPIC_URL, headers=_anthropic_headers(backend, job),
                           body=body, timeout=(10, 900), max_retries=retries,
                           cancel_check=cancel_check, label="anthropic")
        if r.status_code != 200:
            raise LLMError(f"anthropic {r.status_code}: {r.text[:300]}")
        text, tin, tout, cwrite, cread = [], 0, 0, 0, 0
        for ev in _iter_sse(r):
            if cancel_check and cancel_check():
                r.close()
                raise InterruptedError("llm canceled")
            t = ev.get("type")
            if t == "message_start":
                u = (ev.get("message", {}).get("usage") or {})
                # `input_tokens` here EXCLUDES both cached figures — see the
                # note on the cache rates. Adding them would double-count.
                tin = u.get("input_tokens", 0)
                cwrite = u.get("cache_creation_input_tokens", 0) or 0
                cread = u.get("cache_read_input_tokens", 0) or 0
            elif t == "content_block_delta":
                d = ev.get("delta", {})
                if d.get("type") == "text_delta":
                    text.append(d["text"])
                    if on_delta:
                        on_delta(d["text"])
            elif t == "message_delta":
                tout = (ev.get("usage") or {}).get("output_tokens", tout)
            elif t == "error":
                raise LLMError(f"anthropic stream error: {ev}")
        mdl = model or ANTHROPIC_MODEL
        pin, pout = _price(mdl)
        cost = 0.0 if backend == "claude-oauth" else (
            (tin * pin
             + cwrite * pin * ANTHROPIC_CACHE_WRITE
             + cread * pin * _cache_read_rate(mdl)
             + tout * pout) / 1e6)
        return "".join(text), {"model": mdl, "backend": backend,
                               # `tokens_in` stays the BILLABLE-AT-FULL-RATE
                               # count so the existing ledger keeps meaning what
                               # it meant; the cached halves are their own
                               # fields rather than folded in.
                               "tokens_in": tin, "tokens_out": tout,
                               "cache_write": cwrite, "cache_read": cread,
                               "cost_usd": cost}

    if backend == "openai-compat":
        # THE SYSTEM PROMPT GOES FIRST because caching keys on the longest
        # stable PREFIX, and the persona plus craft references are identical
        # across a plan's nine stages. On GPT-5.6 that ordering is necessary
        # and NOT sufficient — see the measurement above the cache rates:
        # without an explicit breakpoint a shared prefix with differing tails
        # is never stored, and `openai_system` is what marks it.
        # `usage.prompt_tokens_details.cached_tokens` below is how we see
        # whether it worked.
        sys_content, cache_key = openai_system(system)
        body = {"model": model or OPENAI_MODEL, "stream": True,
                # WITHOUT THIS THE STREAM CARRIES NO USAGE AT ALL, and the
                # counts fall back to the estimate below.
                "stream_options": {"include_usage": True},
                "messages": [{"role": "system", "content": sys_content}, *messages]}
        if cache_key:
            body["prompt_cache_key"] = cache_key
        r = _post_retrying(f"{OPENAI_BASE}/chat/completions",
                           headers={"authorization":
                                        f"Bearer {_key('OPENAI_API_KEY', 'openai', job)}",
                                    "content-type": "application/json"},
                           body=body, timeout=(10, 900), max_retries=retries,
                           cancel_check=cancel_check, label="openai")
        if r.status_code != 200:
            raise LLMError(f"openai {r.status_code}: {r.text[:300]}")
        text, usage = [], None
        for ev in _iter_sse(r):
            if cancel_check and cancel_check():
                r.close()
                raise InterruptedError("llm canceled")
            # The usage chunk arrives LAST and carries an empty `choices`, so it
            # has to be read outside the loop over choices rather than inside.
            if ev.get("usage"):
                usage = ev["usage"]
            for ch in ev.get("choices", []):
                piece = (ch.get("delta") or {}).get("content")
                if piece:
                    text.append(piece)
                    if on_delta:
                        on_delta(piece)
        out = "".join(text)
        mdl = model or OPENAI_MODEL
        pin, pout = _price(mdl)
        if usage:
            # `prompt_tokens` INCLUDES the cached part here (the opposite of
            # Anthropic), so the cached count is subtracted before the full
            # rate is applied.
            tin = usage.get("prompt_tokens", 0)
            tout = usage.get("completion_tokens", 0)
            cread = ((usage.get("prompt_tokens_details") or {})
                     .get("cached_tokens", 0)) or 0
            fresh = max(0, tin - cread)
            cost = (fresh * pin + cread * pin * OPENAI_CACHE_READ + tout * pout) / 1e6
            return out, {"model": mdl, "backend": backend, "tokens_in": tin,
                         "tokens_out": tout, "cache_read": cread, "cost_usd": cost}
        # No usage came back — an endpoint that ignores `stream_options`. Fall
        # back to ~4 chars/token, and COUNT THE SYSTEM PROMPT: it was left out
        # of this estimate for the whole life of the openai path, and it is the
        # single largest input on most stages (the craft references alone are
        # ~3k tokens). Every plan cost in the ledger before this is understated
        # by roughly that much.
        tin = (len(system_text(system))
               + sum(len(m["content"]) for m in messages)) // 4
        tout = len(out) // 4
        return out, {"model": mdl, "backend": backend, "tokens_in": tin,
                     "tokens_out": tout, "estimated": True,
                     "cost_usd": (tin * pin + tout * pout) / 1e6}

    # ollama
    # think=False, the same flag and the same reason as worker/vlm.py: qwen3.8
    # ships thinking ON by default and Ollama then routes the reply into a
    # separate `thinking` field, leaving `content` EMPTY. There it read as "no
    # JSON object in ''"; here it reads as a director that answered with a
    # blank message, which is the failure that does not announce itself.
    body = {"model": OLLAMA_MODEL, "stream": True, "think": False,
            "messages": [{"role": "system", "content": system_text(system)}, *messages]}
    try:
        r = requests.post(f"{OLLAMA_URL}/api/chat", data=json.dumps(body),
                          stream=True, timeout=(10, 1800))
    except requests.ConnectionError as e:
        raise LLMError(f"Ollama unreachable at {OLLAMA_URL} — run the engine window's Local LLM tab "
                       f"on the pod ({e})")
    if r.status_code != 200:
        raise LLMError(f"ollama {r.status_code}: {r.text[:300]}")
    text, thought, tin, tout = [], [], 0, 0
    for raw in r.iter_lines(decode_unicode=True):
        if cancel_check and cancel_check():
            r.close()
            raise InterruptedError("llm canceled")
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            continue
        m = ev.get("message") or {}
        piece = m.get("content")
        if piece:
            text.append(piece)
            if on_delta:
                on_delta(piece)
        elif m.get("thinking"):
            thought.append(m["thinking"])
        if ev.get("done"):
            tin = ev.get("prompt_eval_count", 0)
            tout = ev.get("eval_count", 0)
    out = "".join(text)
    if not out.strip() and thought:
        # The flag above should make this unreachable; a build that ignores it
        # streams the whole reply into `thinking`. The reasoning is a worse
        # answer than the answer and a much better one than nothing.
        out = "".join(thought)
        if on_delta:
            on_delta(out)
    return out, {"model": OLLAMA_MODEL, "backend": "ollama-local",
                 "tokens_in": tin, "tokens_out": tout, "cost_usd": 0.0}


# ------------------------------------------------------------- tool loop ---
def _ollama_text(msg):
    """The reply, wherever this build put it.

    `think: False` should keep it in `content`. A build that ignores the flag
    leaves `content` empty and puts everything in `thinking` instead, so read
    both — a turn that really did answer must not come back blank.
    """
    out = msg.get("content") or ""
    return out if out.strip() else (msg.get("thinking") or "")


def _ollama_turn(system, messages, tools, cancel_check=None):
    """One non-streaming Ollama turn that may return tool calls.

    Non-streaming on purpose: the worker pseudo-streams into chat_messages
    anyway, so there is no browser waiting on tokens, and a whole message is
    far easier to get tool_calls out of reliably than a token stream.
    """
    body = {"model": OLLAMA_MODEL, "stream": False, "think": False,
            "messages": [{"role": "system", "content": system_text(system)}, *messages]}
    if tools:
        body["tools"] = tools
    try:
        r = _post_retrying(f"{OLLAMA_URL}/api/chat", headers={"content-type": "application/json"},
                           body=body, timeout=(10, 1800),
                           cancel_check=cancel_check, label="ollama")
    except requests.ConnectionError as e:
        raise LLMError(f"Ollama unreachable at {OLLAMA_URL} — run the engine window's Local LLM tab "
                       f"on the pod ({e})")
    if r.status_code != 200:
        raise LLMError(f"ollama {r.status_code}: {r.text[:300]}")
    ev = r.json()
    msg = ev.get("message") or {}
    return msg, ev.get("prompt_eval_count", 0), ev.get("eval_count", 0)


def complete_with_tools(system, messages, *, backend, tools, execute, ctx,
                        job=None,
                        on_delta=None, on_tool=None, cancel_check=None,
                        max_rounds=None):
    """Agentic turn: let the model call tools until it answers in prose.

    Only wired for Ollama today — the hosted backends run their loop in
    api/director/chat.js, which streams to the browser directly. Falls back to
    a plain completion for any backend without a loop here, so the caller
    never has to branch on capability.

    Returns (text, meta) like complete(), plus meta['tool_calls'].
    """
    from director_tools import MAX_ROUNDS, truncate

    if backend != "ollama-local" or not tools:
        text, meta = complete(system, messages, backend=backend,
                              on_delta=on_delta, cancel_check=cancel_check, job=job)
        return text, {**meta, "tool_calls": []}

    convo = list(messages)
    called, tin, tout = [], 0, 0
    rounds = max_rounds or MAX_ROUNDS
    for _ in range(rounds):
        if cancel_check and cancel_check():
            raise InterruptedError("llm canceled")
        msg, a, b = _ollama_turn(system, convo, tools, cancel_check)
        tin += a
        tout += b
        calls = msg.get("tool_calls") or []
        if not calls:
            text = _ollama_text(msg)
            if on_delta and text:
                on_delta(text)
            return text, {"model": OLLAMA_MODEL, "backend": backend, "tokens_in": tin,
                          "tokens_out": tout, "cost_usd": 0.0, "tool_calls": called}
        # Keep the assistant's own tool-call message: dropping it leaves the
        # tool results answering a question that is no longer in the history.
        convo.append({"role": "assistant", "content": msg.get("content") or "",
                      "tool_calls": calls})
        for c in calls:
            fn = (c.get("function") or {})
            name = fn.get("name") or ""
            raw = fn.get("arguments")
            # Ollama sends a dict; some builds and every OpenAI-compatible
            # server send a JSON string.
            args = raw if isinstance(raw, dict) else (json_repair(raw or "{}") if raw else {})
            if on_tool:
                on_tool(name, "run", None)
            result = execute(name, args, ctx)
            called.append({"name": name, "input": args, "result": result})
            if on_tool:
                on_tool(name, "err" if isinstance(result, dict) and result.get("error") else "ok", result)
            convo.append({"role": "tool", "content": truncate(result)})

    # Out of rounds: make it answer with what it has rather than looping.
    # Tools are withheld on this turn so a tool call is not even expressible.
    convo.append({"role": "user",
                  "content": "Stop calling tools and answer now with what you have."})
    msg, a, b = _ollama_turn(system, convo, None, cancel_check)
    text = _ollama_text(msg)
    if not text:
        # A small model can still return an empty turn here. Reporting what
        # actually happened beats handing the user a blank message — the work
        # was really done, and these are the receipts.
        did = [c["name"] for c in called] or ["nothing"]
        text = ("I ran out of tool rounds before writing a reply. Completed: "
                + ", ".join(did) + ". Ask me to continue and I'll pick up from there.")
    if on_delta and text:
        on_delta(text)
    return text, {"model": OLLAMA_MODEL, "backend": backend, "tokens_in": tin + a,
                  "tokens_out": tout + b, "cost_usd": 0.0, "tool_calls": called}


# ------------------------------------------------------------- JSON repair ---
def json_repair(text):
    """LLM output -> dict. Strips fences/prose, trims to the outermost object,
    fixes trailing commas. Raises LLMError when unrecoverable."""
    if isinstance(text, dict):
        return text
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    a, b = s.find("{"), s.rfind("}")
    if a == -1 or b <= a:
        raise LLMError(f"no JSON object in LLM output: {s[:200]!r}")
    s = s[a:b + 1]
    for attempt in (s, re.sub(r",(\s*[}\]])", r"\1", s)):
        try:
            return json.loads(attempt)
        except json.JSONDecodeError:
            continue
    # Last resort: cut at the deepest point that still parses.
    depth, best = 0, None
    for i, ch in enumerate(s):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                best = i
    if best is not None:
        try:
            return json.loads(re.sub(r",(\s*[}\]])", r"\1", s[:best + 1]))
        except json.JSONDecodeError:
            pass
    raise LLMError("unparseable JSON from LLM")


# --------------------------------------------------------------------- RAG ---
def embed_texts(texts):
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise LLMError("OPENAI_API_KEY required for embeddings")
    r = requests.post(f"{OPENAI_BASE}/embeddings",
                      headers={"authorization": f"Bearer {key}",
                               "content-type": "application/json"},
                      data=json.dumps({"model": EMBED_MODEL, "input": texts}),
                      timeout=120)
    r.raise_for_status()
    return [d["embedding"] for d in r.json()["data"]]


def rag_search(query, project_id=None, k=6):
    """Top-k guide/lore chunks for a query; empty on any failure (RAG is an
    enhancement, never a dependency)."""
    try:
        emb = embed_texts([query[:6000]])[0]
        rows = sb.rpc("match_rag_chunks",
                      {"query_embedding": emb, "p_project": project_id, "k": k})
        return rows or []
    except Exception as e:
        log(f"rag_search skipped: {e}")
        return []


_KNOWLEDGE_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "director", "knowledge"))

# Doc names arrive in job payloads, which the browser writes. A filename from
# a request body gets validated before it is joined to a path, always.
_SAFE_DOC = re.compile(r"^[\w.-]+\.md$")


def _read_knowledge(name):
    """One guide by filename, "" when it isn't there. A missing doc should
    weaken the turn, not fail the job."""
    if not _SAFE_DOC.match(str(name)):
        return ""
    try:
        with open(os.path.join(_KNOWLEDGE_DIR, name)) as f:
            return f.read()
    except OSError:
        return ""


# Who is in the room, what they decide, and what they bring to read. The ids
# match director/brief.js EXPERTS — the wizard's checkboxes — so ticking one
# changes the planner's grounding, not just a line of prose in the notes.
EXPERTS = {
    "writing": ("Writing", "story logic, want and obstacle per character, the turn, "
                           "dialogue intent", []),
    "directing": ("Directing", "shot grammar, coverage, blocking, where the camera lives",
                  ["directing_craft.md", "camera_grammar.md"]),
    "vfx": ("VFX", "practical vs. impossible imagery, how effects are staged and lit, "
                   "one design grammar for every magical effect",
            ["action_vfx_craft.md", "magic_vfx_craft.md"]),
    "costume": ("Costume & continuity", "wardrobe pieces, wear and damage, what must match "
                                        "shot to shot", []),
    "choreo": ("Fight choreography", "beats of the action, geography, impacts and reactions, "
                                     "tempo — fights play at fight speed, never sparring speed",
               ["action_vfx_craft.md", "magic_vfx_craft.md"]),
    "environment": ("Environment design", "the scale, dressing, light, sound and background "
                                          "life of every location — spaces that feel inhabited "
                                          "and navigable, with named features shots anchor to",
                    ["environment_design_craft.md"]),
}

# Always loaded: the studio's own floor, whoever is in the room.
BASE_KNOWLEDGE = ["h3_prompt_craft.md", "directing_craft.md", "camera_grammar.md"]


def builtin_knowledge(medium, experts=None, genre_docs=None):
    """The repo-shipped craft guides, read straight off disk — the grounding
    layer that works with zero embedding credits. Vector RAG adds user docs
    (scripts, lore) on top when OPENAI_API_KEY has quota.

    `experts` (wizard checkboxes) pulls each specialist's own doc in. With no
    experts named — the director chat, older jobs — everything loads, which is
    the previous behaviour and the safe default.

    `genre_docs` are guides the BRIEF earns rather than a checkbox: a sitcom
    brief gets comedy craft whether or not anyone ticked a box, because the
    thing that decides whether an episode is built like a sitcom is the writer,
    and it has one chance.
    """
    names = list(BASE_KNOWLEDGE)
    picked = [e for e in (experts or []) if e in EXPERTS]
    extra = ([d for e in picked for d in EXPERTS[e][2]] if picked
             else ["action_vfx_craft.md"])
    for d in list(extra) + list(genre_docs or []):
        if d not in names:
            names.append(d)
    if medium == "music_video":
        names.append("music_video_craft.md")
    return "\n\n".join(t for t in (_read_knowledge(n) for n in names) if t)


def the_room(experts):
    """The experts block for the planner's system prompt. Selecting people has
    to change what the treatment is accountable for, or the checkboxes are
    decoration."""
    picked = [e for e in (experts or []) if e in EXPERTS]
    if not picked:
        return ""
    lines = "\n".join(f"- {EXPERTS[e][0]}: {EXPERTS[e][1]}" for e in picked)
    return ("\n\n# The room\n"
            "These specialists are on this brief. Every one of them must leave a "
            "visible decision in the treatment and in the scenes — not a mention, "
            "a decision someone could execute.\n" + lines)


def format_reference():
    """The vendor's own H3 guide, so the planner knows what its beats will be
    compiled into — the camera vocabulary, the timing grid, how dialogue and
    audio are expressed.

    Invariant #6 still holds and is restated in the header below: the compiler
    (h3_prompt.py) writes the format, never the model. Until now the planner saw
    only our hand distillation (h3_prompt_craft.md), and a distillation drifts
    from the thing it distils — which is exactly why prompt_guides.js stopped
    paraphrasing these docs and started shipping them.
    """
    doc = _read_knowledge("h3_official_base_modes.md")
    if not doc:
        return ""
    return ("\n\n# What your beats compile into (MiniMax H3, vendor guide)\n"
            "Read this to understand what the model can actually express. Do NOT "
            "write in this format: you emit structured scenes and beats, and a "
            "deterministic compiler produces the prompt.\n\n" + doc)


# Where a lore entry's prose lives, newest key first. `body` is what the Lore
# form writes now; the rest are what earlier versions of the bible UI used, and
# an entry saved under one of them still holds the only copy of that writing.
LORE_BODY_KEYS = ("body", "notes", "bio", "appearance")

# How much lore prose is inlined into the planner's brief. Two budgets, because
# one long entry must not crowd out five short ones — without the per-entry cap
# a 40KB pasted history would consume the whole allowance and every other piece
# of canon would silently vanish from the prompt.
LORE_TOTAL_CHARS = 12000
LORE_ENTRY_CHARS = 3000


def lore_body(doc):
    """One lore entry's prose, whichever key it was written under."""
    for k in LORE_BODY_KEYS:
        v = (doc or {}).get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def lore_when(doc):
    """One lore entry's place in time: (from, until, revealed) episode ids.

    All None is evergreen — a mechanical rule that does not change. See the
    migration `20260815180000_lore_episode_scope.sql` for the full shape.
    """
    w = (doc or {}).get("when")
    if not isinstance(w, dict):
        return (None, None, None)
    pick = lambda k: (w.get(k) if isinstance(w.get(k), str) and w.get(k) else None)  # noqa: E731
    return (pick("from"), pick("until"), pick("revealed"))


def episode_order(episodes):
    """episode id -> position. `idx` is the story's order and the only thing
    'as of Ep2' can mean."""
    return {e["id"]: int(e.get("idx") or 0) for e in (episodes or []) if e.get("id")}


# How a fact relates to the episode being written.
LORE_IN_FORCE = "in_force"        # true and known: ordinary canon
LORE_UNREVEALED = "unrevealed"    # true and operating, but the audience does not know yet
LORE_NOT_YET = "not_yet"          # does not hold in this episode
LORE_SUPERSEDED = "superseded"    # held once, no longer


def lore_status(doc, order, cur):
    """Where a fact stands in the episode being planned.

    This is the whole reason for tagging. A single tag cannot express a retcon,
    and gets it wrong in BOTH directions: tag "Stabilizing Presence" by when it
    is REVEALED and the Ep1 plan does not know the mechanic is operating, so it
    writes a villain who is fine and manufactures the contradiction; tag it by
    when it is TRUE and the Ep1 plan may have someone state it, spoiling the
    reveal. The two questions are different — may a scene SAY this, and must the
    world BEHAVE this way — so they get two fields.

    `cur` is the position of the episode being planned; None (no episode
    resolved) means every fact is in force, i.e. exactly the old flat behaviour.
    """
    frm, until, revealed = lore_when(doc)
    if cur is None:
        return LORE_IN_FORCE
    # An id that no longer resolves (episode deleted, entry copied between
    # projects) is treated as unbounded rather than dropped: losing canon
    # silently is worse than including it a little early.
    f = order.get(frm) if frm else None
    u = order.get(until) if until else None
    r = order.get(revealed) if revealed else None
    if f is not None and cur < f:
        return LORE_NOT_YET
    if u is not None and cur >= u:
        return LORE_SUPERSEDED
    if r is not None and cur < r:
        return LORE_UNREVEALED
    return LORE_IN_FORCE


def lore_context(bible, episodes=None, episode_id=None):
    """The project's lore, as prose, for the planner's brief.

    Every bible row is flattened to one line in `existing_bible` — right for a
    character (the pictures carry the rest) and wrong for lore, whose entire
    content IS writing. For lore's whole life that flattening dropped every word
    of the body, so a world bible reached the writer as a list of titles.

    Retrieval (`rag_search`, above) covers the long tail, but it needs embedding
    credits and an awake pod. This layer needs neither, which is the point: it is
    the same reasoning as `builtin_knowledge` reading the craft guides off disk
    rather than depending on pgvector. Lore has to work on a project that has
    never embedded anything.

    Facts are sorted into what holds NOW and what is operating but not yet
    known; anything that does not apply to this episode is left out entirely.
    Passing no episode keeps every fact, which is the pre-tagging behaviour and
    what an untagged project still gets.

    Truncation is announced, in the text and in the log — a budget that silently
    drops half the canon looks exactly like a model that ignored it.
    """
    order = episode_order(episodes)
    cur = order.get(episode_id) if episode_id else None

    parts, hidden, spent, dropped = [], [], 0, []
    skipped = {LORE_NOT_YET: [], LORE_SUPERSEDED: []}
    for e in bible:
        if e.get("kind") != "lore":
            continue
        body = lore_body(e.get("doc"))
        if not body:
            continue
        state = lore_status(e.get("doc"), order, cur)
        if state in skipped:
            skipped[state].append(e.get("name") or "?")
            continue
        room = min(LORE_ENTRY_CHARS, LORE_TOTAL_CHARS - spent)
        if room < 400:                      # no useful amount left
            dropped.append(e.get("name") or "?")
            continue
        piece = body[:room]
        block = (f"## {e.get('name')}\n{piece}"
                 + ("\n[…this entry continues; retrieve it if the scene needs more]"
                    if len(piece) < len(body) else ""))
        (hidden if state == LORE_UNREVEALED else parts).append(block)
        spent += len(piece)

    if dropped:
        log(f"lore_context: {LORE_TOTAL_CHARS}-char budget reached — {len(dropped)} "
            f"entr{'y' if len(dropped) == 1 else 'ies'} not inlined "
            f"({', '.join(dropped[:5])}{'…' if len(dropped) > 5 else ''}). "
            f"They stay reachable through retrieval if they have been indexed.")
    for state, names in skipped.items():
        if names:
            log(f"lore_context: {len(names)} entr{'y' if len(names) == 1 else 'ies'} "
                f"{state} for this episode, left out ({', '.join(names[:5])}"
                f"{'…' if len(names) > 5 else ''}).")

    out = "\n\n".join(parts)
    if hidden:
        # The instruction is the point of the whole feature. Without it these
        # would either be absent (and the world contradicts a later reveal) or
        # present as ordinary canon (and a character explains the twist early).
        out += ("\n\n# Operating but NOT yet revealed\n"
                "These are true in this episode and the world must behave "
                "accordingly — events, consequences and behaviour follow them. "
                "The audience does NOT know them yet: no character may state, "
                "explain or discover any of it, and nothing may be framed as a "
                "revelation of it.\n\n" + "\n\n".join(hidden))
    return out


# --------------------------------------------------------- plan_storyboard ---
def plan_medium(brief, project):
    """What is being made, for craft guides and the model's brief.

    The wizard can direct a one-off film inside a music-video project, so its
    choice rides on the brief and wins over the project row. A blank string is
    not a choice — hence the truthiness test rather than a `in brief` check.
    """
    return (brief or {}).get("medium") or (project or {}).get("medium")



# The treatment brief. Section 1 is the only part that differs by medium — and
# it differed by nothing at all until now: a film brief was answered with a
# "SONG MAP" of verses and choruses, because the hint was written for music
# videos and handed to everyone.
_SPINE = {
    "music_video": """1. SONG MAP — each section (timestamps given) with its energy level and what
   the imagery does there: verses carry story and quiet tension, pre-chorus
   tightens, the chorus is the biggest imagery so far, a bridge inverts, the
   final chorus must top everything. Slow beats need stillness and weight —
   not everything is hype.""",
    "film": """1. SHAPE — the sequence of scenes with what each one is FOR: what the
   audience knows or feels entering it and leaving it. Locations change on
   scene boundaries. Name the quiet scene that earns the loud one, and the
   scene you would cut first if it ran long.""",
    "series": """1. SHAPE — the episode's spine: the cold open's hook, the question it raises,
   the act turns, and the closing beat that makes the next episode necessary.
   Say which recurring cast and locations are honoured from the bible and what
   is new. Name the quiet scene that earns the loud one.""",
}


def treatment_hint(medium):
    spine = _SPINE.get(medium) or _SPINE["film"]
    return f"""Before any storyboard exists, write the TREATMENT as prose
(no JSON). Cover, concretely and specifically for THIS brief:
{spine}
2. STORY SPINE — the emotional arc in 4-6 sentences: what each character
   wants, what changes, why the ending lands. Name the exact moment the
   emotion turns.
3. CONTINUITY CHAIN — for each character, their physical path through
   locations scene by scene. A character NEVER teleports: if they change
   location, there is a beat that shows or motivates the transition (or a
   deliberate, readable cut convention such as a portal). State it.
4. WORLDS & VFX — for each world/location: one dominant color, one material,
   one physics rule. For each named visual effect: its material metaphor
   (shattering glass, tearing paper, static), its color and light behavior,
   its direction of travel. These become reference-image prompts.
5. CHOREOGRAPHY — for any fight/dance/chase: the geography (who starts
   where), 3-5 exchanges each with cause -> impact -> consequence, and where
   the wide shots re-establish positions.
Keep it under 500 words. Be specific enough that a stranger could shoot it."""

STORYBOARD_SCHEMA_HINT = """Return ONLY a JSON object, no prose, this shape:
{
  "title": "episode/video title",
  "characters": [
    {"name": "...", "summary": "1-2 sentences",
     "identity_line": "a single sentence, 6-8 concrete visual attributes (hair
      style+color, eyes, distinguishing mark, exact outfit pieces with colors,
      accessories) written so it can be repeated verbatim in every shot",
     "personality": "...", "wardrobe": "..."}
  ],
  "environments": [
    {"name": "...", "summary": "1-2 sentences",
     "identity_line": "one sentence locking the location's look",
     "palette": "3-4 color palette, e.g. 'dusk purple, deep blue, warm amber'"}
  ],
  "scenes": [
    {"slug": "SHORT_SLUG", "environment": "environment name",
     "cast": ["character name", ...],
     "scene_prompt": "what this scene is about, mood, light",
     "vfx_ref": {"name": "effect name",
                 "prompt": "a single still image showing exactly what this
                  scene's key effect/moment looks like — color, material,
                  light, composition (omit the field when the scene has no
                  special effect)"},
     "beats": [
       {"duration_ms": 4000,
        "cast": ["ONLY the characters visibly in frame during this beat"],
        "camera": "official grammar: shot size + motion type + amplitude +
         speed, e.g. 'a medium shot; the camera pushes in with small amplitude
         at slow speed'",
        "action": "what happens, present tense, concrete and visual, physics
         and consequences stated; who/what/how/where-in-frame",
        "dialogue": [{"speaker": "name", "line": "...", "delivery": "tone"}],
        "sfx": "diegetic sounds for this beat"}
     ]}
  ],
  "soundscape": "1-3 sentences: the overall ambient sound of the piece",
  "music": "1-3 sentences: the score / track character"
}
Rules: beats 2000-12000ms each. Scene = one location. Use existing bible
characters by their exact names when they fit. beat.cast is MANDATORY and
minimal — a character not in beat.cast is not in the frame, and characters
must not appear in locations their continuity chain hasn't reached. Camera
uses ONLY the official motion vocabulary (Push In, Pull Out, Pan, Truck,
Tilt, Pedestal, Arc Shot, Tracking Shot, Static Shot, Shake, POV, Roll) with
'with small/large amplitude' and 'at slow/fast speed'. Vary shot sizes hard;
never two identical setups back to back. For music videos: scene/beat
boundaries land on the song's sections; sung lines go in dialogue with
delivery "singing" ONLY where a character visibly performs. Every scene's
final beat ends on a composition the next scene can pick up from — and the
next scene's first beat must acknowledge where its characters came from."""


def _fit_durations(scenes, target_ms):
    """Deterministically scale beat durations so the total lands on target
    (LLMs are sloppy at arithmetic). Rounds to 250ms, clamps 1500..14000."""
    total = sum(b["duration_ms"] for s in scenes for b in s["beats"])
    if not total or not target_ms:
        return scenes
    f = target_ms / total
    for s in scenes:
        for b in s["beats"]:
            b["duration_ms"] = int(min(14000, max(1500, round(b["duration_ms"] * f / 250) * 250)))
        s["duration_ms"] = sum(b["duration_ms"] for b in s["beats"])
    return scenes


def normalize_storyboard(data, target_ms=None):
    """Validate + normalize the LLM's storyboard JSON in place."""
    if not isinstance(data.get("scenes"), list) or not data["scenes"]:
        raise LLMError("storyboard JSON has no scenes")
    data["characters"] = [c for c in (data.get("characters") or []) if c.get("name")]
    known_names = {c["name"] for c in data["characters"]}
    for i, s in enumerate(data["scenes"]):
        s["slug"] = (s.get("slug") or f"SC_{i + 1:02d}").strip()[:24].replace(" ", "_").upper()
        s["cast"] = [c for c in (s.get("cast") or []) if isinstance(c, str)]
        if not isinstance(s.get("vfx_ref"), dict) or not (s.get("vfx_ref") or {}).get("prompt"):
            s["vfx_ref"] = None
        beats = s.get("beats") or []
        if not beats:
            raise LLMError(f"scene {s['slug']} has no beats")
        for b in beats:
            b["duration_ms"] = int(b.get("duration_ms") or 4000)
            b["action"] = (b.get("action") or "").strip()
            if not b["action"]:
                raise LLMError(f"scene {s['slug']} has a beat with no action")
            b["dialogue"] = [d for d in (b.get("dialogue") or [])
                             if isinstance(d, dict) and d.get("line")]
            # beat-level cast: only known characters, subset of the scene cast
            # when the scene declares one (frame discipline — nobody rides
            # along into shots they aren't in)
            cast = [n for n in (b.get("cast") or []) if isinstance(n, str)]
            cast = [n for n in cast if n in known_names or n in s["cast"]]
            if s["cast"]:
                cast = [n for n in cast if n in s["cast"]] or [
                    n for n in s["cast"] if n in b["action"]]
            b["cast"] = cast
    data["environments"] = [e for e in (data.get("environments") or []) if e.get("name")]
    _fit_durations(data["scenes"], target_ms)
    return data


def _name_tokens(name):
    return frozenset(re.sub(r"[^a-z0-9 ]+", "", str(name or "").lower()).split())


#: Token-subset matching is for PEOPLE only, and the distinction is not a
#: patch — it is what the two kinds of name ARE.
#:
#: A person's name is an IDENTIFIER, and identifiers shorten: "Mika" and "Mika
#: Chen" are one person, "Rei" and "Guide Rei" are one person. A prop or
#: location name is a DESCRIPTION, and descriptions COMPOSE — adding a word
#: makes a different object. Measured on the first real re-plan after this
#: shipped: the writer's "Training doorway creature" was bound to the existing
#: prop "Training doorway", so a creature became a reflective rectangle in a
#: chalk circle and no sheet for it was ever queued. "Cloudy Glass Marbles" and
#: "Contained Black Hole Marble" are the same trap one word further apart, and
#: `storyplan`'s own interior/exterior convention deliberately makes
#: "Observatory — INTERIOR" and "— EXTERIOR" two entries that must never merge.
#:
#: Every kind still gets exact and token-equal matching; only the SUBSET step is
#: restricted. Note `duplicate_cast`, the rule this borrows, is named for cast.
SUBSET_MATCH_KINDS = ("character",)


def _ident_tokens(text):
    """Word set of an identity line, for near-verbatim comparison."""
    return set(re.findall(r"[a-z0-9]+", str(text or "").lower()))


def _find_entry(entries, kind, name, identity=None):
    """The bible row this planned name refers to, or None to create one.

    Exact match, then punctuation/case/order, then — for CHARACTERS only — the
    unambiguous token-subset rule `storyplan.duplicate_cast` uses ("Mika" is
    "Mika Chen"); see SUBSET_MATCH_KINDS for why the other kinds are excluded.
    Matching only exactly is how a re-plan produced a second character: the
    writer files her as "Guide Rei" on one run and "Rei" on the next, nothing
    recognises the pair, and the episode gets a second entry with its own face
    sheet — two people on screen who are meant to be one.

    Ambiguity is a MISS, not a guess, and the guard has to hold on both sides —
    exactly the Rei case that rule was written for. In a cast of Rei / Guide Rei
    / Knight Rei / Villian Rei, "Rei" sits inside three others and cannot be
    said to refer to any of them; "Guide Rei" contains only "Rei" and looks
    unambiguous from where it stands. Checking one side would bind the
    protagonist to her own guide.

    Reuse is also much cheaper to be wrong about than `duplicate_cast`'s merge:
    nothing is deleted here, an existing row is simply referenced instead of a
    new one being written. But a wrong bind still costs a face, so a
    non-exact hit is logged with both names.
    """
    mine = [e for e in entries if e.get("kind") == kind]
    n = str(name or "").strip().lower()
    for e in mine:
        if str(e.get("name") or "").strip().lower() == n:
            return e

    t = _name_tokens(name)
    if not t:
        return None

    # Same tokens, different punctuation, case or order ("mrs katagiri" /
    # "Mrs. Katagiri"). That is normalisation, not a guess, so it is still the
    # exact branch — no ambiguity test applies.
    same = next((e for e in mine if _name_tokens(e["name"]) == t), None)
    if same is not None:
        log(f"bible: '{name}' is existing {kind} '{same['name']}'")
        return same

    # IDENTITY binding, all kinds. The name is a LABEL; the identity line is
    # the content — and a new entry whose identity is a near-verbatim copy of
    # an existing same-kind entry's IS that entry wearing a new label.
    # Measured on Rei E4: the writer honoured "Interdimensional Observatory
    # Hideout" by copying its identity line WORD FOR WORD onto a new entry it
    # named "… — INTERIOR" (following the interior/exterior naming rule), the
    # name matcher correctly refused the name, nothing looked at the sentence,
    # and the bible grew a twin with its own four plates. The threshold is
    # deliberately near-copy (token Jaccard ≥ 0.8): a PARAPHRASE stays a
    # near-miss report, because the interior/exterior convention wants
    # genuinely different setups to be different entries — it is the copied
    # description, not the similar name, that proves one place.
    mine_ident = _ident_tokens(identity)
    if len(mine_ident) >= 6:
        for e in mine:
            theirs = _ident_tokens(e.get("identity_line"))
            if not theirs:
                continue
            j = len(mine_ident & theirs) / (len(mine_ident | theirs) or 1)
            if j >= 0.8:
                log(f"bible: '{name}' has {kind} '{e['name']}''s own identity "
                    f"line (overlap {j:.2f}) — same {kind}, reusing it")
                return e

    if kind not in SUBSET_MATCH_KINDS:
        return None

    def relatives(x, over):
        return [e for e in over
                if _name_tokens(e["name"]) != x
                and (x < _name_tokens(e["name"]) or _name_tokens(e["name"]) < x)]

    kin = relatives(t, mine)
    if len(kin) != 1:
        return None
    cand = kin[0]
    # An outfit variant is a castable entry of its own ("Aki Minase — Print-shop
    # uniform"), and its name contains its parent's. Binding a plain "Aki
    # Minase" to it would cast the costume as the character.
    if (cand.get("doc") or {}).get("variant_of"):
        return None
    # The candidate has to be equally unambiguous from ITS side — the guard that
    # stops "Rei" binding to her own guide. The name being resolved counts in
    # that judgement even though it has no row yet: without it, a lone "Mika
    # Chen" has no relatives at all and the one case this exists for is refused.
    if len(relatives(_name_tokens(cand["name"]), mine + [{"name": name}])) != 1:
        return None
    log(f"bible: '{name}' resolved to existing {kind} '{cand['name']}'")
    return cand


def near_duplicate_names(entries, kind, name):
    """Existing rows this name RESEMBLES but is not being bound to.

    The other half of "ambiguity is a miss": refusing to guess is right, and
    silently writing a second entry next to three near-identical ones is how
    a bible fills up with versions of one person. These are reported — on the
    plan's own log and on `storyboards.brief` — so the duplicate that does get
    created is one somebody was told about.
    """
    t = _name_tokens(name)
    if not t:
        return []
    return [e["name"] for e in entries
            if e.get("kind") == kind
            and _name_tokens(e["name"]) != t
            and (t < _name_tokens(e["name"]) or _name_tokens(e["name"]) < t)]


def insert_storyboard(ep_id, fields):
    """A new plan for an episode, numbered rather than silently superseding.

    Planning has always INSERTED here, and every read takes the newest row —
    so a re-plan retired the previous board without deleting it: its scenes,
    beats and blocks stayed on disk and stopped being reachable from anywhere.
    Numbering is what makes that recoverable.

    `(episode_id, version)` is UNIQUE, so two plans racing on one episode
    collide instead of both landing on the same number. That is the right
    outcome and a costly one to hit — this insert happens after every LLM stage
    has run — so a collision re-reads the max and tries again rather than
    throwing away a plan that took minutes to write.
    """
    for attempt in range(4):
        rows = sb.get(f"storyboards?episode_id=eq.{ep_id}&select=version"
                      f"&order=version.desc&limit=1")
        nxt = int((rows[0] or {}).get("version") or 0) + 1 if rows else 1
        try:
            return sb.insert("storyboards",
                             {"episode_id": ep_id, "version": nxt, **fields})
        except requests.HTTPError as e:
            dup = getattr(e.response, "status_code", None) == 409
            if not dup or attempt == 3:
                raise
            log(f"storyboard v{nxt} taken, retrying")


# ------------------------------------------------- the plan being revised ---
def previous_plan_outline(storyboard_id, *, max_scenes=16, max_beats=14):
    """The storyboard a re-plan is revising, as something a writer can read.

    A re-plan is a FULL pass — writer, editor, voice, blocking, cinematographer
    — that inserts a new version rather than editing the old one, so without
    this the planner writes blind and "cut the training scene" means nothing to
    it: it has never seen a training scene. Handing it the outline is what
    turns a re-plan into a revision.

    Deliberately an OUTLINE, not the rows. The writer's job is to restructure,
    and a full dump of every shot's camera and dialogue would (a) crowd out the
    brief in the same window and (b) invite copying — the note asks for a
    rewrite, and the most likely way to fail it is to return the same plan with
    one scene renamed. Slugs, purposes and one line per beat are enough to
    reason about structure and too little to paste back.

    Bounded on both axes, and a long episode says so rather than silently
    showing the writer the front of itself: a truncated list that looks
    complete is how "make the ending land harder" gets applied to a scene that
    is no longer the ending.
    """
    scenes = sb.get(f"scenes?storyboard_id=eq.{storyboard_id}&order=idx"
                    f"&select=id,idx,slug,duration_ms,scene_prompt,meta")
    if not scenes:
        return None
    kept = scenes[:max_scenes]
    beats_by_scene = {}
    if kept:
        ids = ",".join(s["id"] for s in kept)
        for b in sb.get(f"beats?scene_id=in.({ids})&order=idx"
                        f"&select=scene_id,idx,camera,action,dialogue"):
            beats_by_scene.setdefault(b["scene_id"], []).append(b)

    out = []
    for s in kept:
        meta = s.get("meta") or {}
        rows = (beats_by_scene.get(s["id"]) or [])[:max_beats]
        out.append({
            "slug": s.get("slug"),
            "seconds": round(int(s.get("duration_ms") or 0) / 1000, 1),
            **({"purpose": s.get("scene_prompt")} if s.get("scene_prompt") else {}),
            **({k: meta[k] for k in ("type", "time", "conflict") if meta.get(k)}),
            "beats": [{
                "camera": (b.get("camera") or "")[:120],
                "action": (b.get("action") or "")[:200],
                **({"dialogue": [f"{d.get('speaker') or '?'}: {d.get('line')}"[:160]
                                 for d in (b.get("dialogue") or [])[:3]]}
                   if b.get("dialogue") else {}),
            } for b in rows],
            **({"beats_omitted": len(beats_by_scene.get(s["id"]) or []) - len(rows)}
               if len(beats_by_scene.get(s["id"]) or []) > len(rows) else {}),
        })
    return {"scenes": out,
            **({"scenes_omitted": len(scenes) - len(kept)}
               if len(scenes) > len(kept) else {})}

# --------------------------------------------------- user-supplied sheets ---
# A picture the user attached in the wizard interview is the strongest thing
# they can say about a character, and until it reached here it was the weakest:
# the director agreed to treat it as the visual authority, the planner then
# drew a face plate from a paraphrase of it, and every block of the episode
# inherited the drawing rather than the design.
#
# `note_brief` records the attachment against the entry it shows
# (`ref_asset_ids`); this is where that becomes a real `bible_assets` row. The
# slots are filled MOST AUTHORITATIVE FIRST, because the first one is what
# everything else derives from — the face plate for a person, the master plate
# for a place — and whatever the user did not supply is still generated and
# anchors on what they did.
USER_REF_ROLES = {
    "character": ("face", "full_body", "side"),
    "environment": ("master", "alt_angle", "detail"),
    "prop": ("ref",),
}
ARCHIVE_SLOT = 90       # the convention regen_sheets.py uses: superseded, not deleted


# What a READ sheet turns out to be, mapped onto the slot it should occupy.
# Only roles the entry's own kind can hold: a location has no `full_body`, and
# `image_prompt` falls back rather than shooting a harbour head-and-shoulders.
SHEET_KIND_ROLE = {
    "character": {"turnaround": "turnaround", "full_body": "full_body", "face": "face"},
    "environment": {"master": "master", "detail": "detail", "atmosphere": "atmosphere"},
    "prop": {},
}


def user_ref_slots(kind, asset_ids, detected=None):
    """Pair supplied pictures with the roles they should occupy.

    The role comes from WHAT THE PICTURE IS whenever it could be read
    (`detected` maps asset id -> the reader's `kind`), and from position only as
    a fallback. Position alone was wrong in the ordinary case: a user who
    attaches one sheet per character attaches TURNAROUNDS — several views, often
    captioned "SIDE VIEW / BACK VIEW" — and the ladder filed every one of them
    as `face`, so the planner then drew a full body and a turnaround it already
    had. Worse, the turnaround it drew competed with the one it was given.

    Anything past the ladder still lands on the entry as a plain `ref` — visible
    in the bible, staged nowhere, which is the honest outcome for a fourth
    picture. Dropping it would lose a file the user deliberately handed over.
    """
    roles = USER_REF_ROLES.get(kind) or ("ref",)
    allowed = SHEET_KIND_ROLE.get(kind) or {}
    ids = list(dict.fromkeys(x for x in (asset_ids or []) if isinstance(x, str) and x))
    out, taken, spare = [], set(), list(roles)
    for aid in ids:
        role = allowed.get((detected or {}).get(aid) or "")
        if not role or role in taken:
            # unread, a kind this entry cannot hold, or a slot already filled by
            # an earlier sheet — fall back to the next unused ladder rung
            role = next((r for r in spare if r not in taken), "ref")
        taken.add(role)
        out.append((aid, role))
    return out


def redundant_roles(filled):
    """Roles that no longer need drawing because a supplied sheet covers them.

    A turnaround IS the full body — `ref_plan_for` already stages it IN PLACE OF
    `full_body`, and the sheet loop treats them as one identity slot. So a user
    who hands over a turnaround should get the face plate drawn and nothing
    else; drawing a body sheet too spends a render on a view they gave us.
    """
    return {"full_body"} if "turnaround" in filled else set()


def _name_tokens(s):
    return set(re.findall(r"[a-z0-9]+", (s or "").lower()))


def match_brief_name(name, candidates):
    """The user's name for someone, against the names the writer actually used.

    Exact first, then a UNIQUE token-subset match — the same rule
    `merge_duplicate_cast` uses, and for the same reason: the writer routinely
    formalises "Rei" into "Guide Rei", and refusing that would leave the user's
    own sheet unattached with nothing on screen to explain why. Ambiguity is a
    miss rather than a guess: two candidates matching means a coin flip about
    whose identity anchor this picture becomes.
    """
    n = (name or "").strip().lower()
    if not n:
        return None
    for c in candidates:
        if (c or "").strip().lower() == n:
            return c
    toks = _name_tokens(n)
    if not toks:
        return None
    hits = [c for c in candidates
            if toks <= _name_tokens(c) or (_name_tokens(c) and _name_tokens(c) <= toks)]
    return hits[0] if len(hits) == 1 else None


# ------------------------------------------------- reading a ref sheet ---
# A description written WITHOUT the picture is confidently wrong and nothing
# downstream can tell. Measured: a director agreed to treat an attached sheet
# as "the visual authority", then restated its own earlier invention verbatim;
# two turns later it collapsed two characters into one costume ("Guide Rei and
# flashback Astronaut Rei … including the orange astronaut suits") because it
# had one picture and two names in play. The sheet showed a brown coat. The
# identity line is repeated into every shot, so that one sentence then drove
# every generated sheet and every render of the episode.
#
# `VISION_MODEL` picks the hosted reader; unset, the pod's own VLM does it.
# The distinction is deliberate rather than a preference for local: a model
# that CANNOT see does not error, it confabulates — which is the exact failure
# being fixed — so the hosted path is used only when someone has named a model
# they know reads images. Everything falls back to the local VLM, which is
# known to see and costs nothing.
VISION_MODEL = _env("VISION_MODEL", "")
VISION_SYSTEM = None            # set from vlm.SHEET_SYSTEM at call time


def describe_ref_sheet(image_url, *, model=None, timeout=90):
    """What a supplied reference sheet actually shows, as an identity line.

    Returns `{identity, confidence, reader}` or None if nothing could read it —
    None means "leave the writer's line alone", never "write a guess".

    Deliberately NOT `complete()`: its fallback chain walks text-only backends,
    and a picture landing on one of those comes back as a plausible sentence
    about nothing. Only readers that were told to look are tried.
    """
    import vlm

    want = (model or VISION_MODEL or "").strip()
    # 1. A named hosted reader. The bucket is public (invariant #2), so the URL
    #    goes over as a URL and no bytes pass through this process.
    if want and os.environ.get("OPENAI_API_KEY"):
        try:
            r = requests.post(
                f"{OPENAI_BASE}/chat/completions",
                headers={"authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
                         "content-type": "application/json"},
                json={"model": want, "messages": [
                    {"role": "system", "content": vlm.SHEET_SYSTEM},
                    {"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": image_url}},
                        {"type": "text",
                         "text": "Describe the subject of this reference sheet."}]}]},
                timeout=(10, timeout))
            if r.status_code == 200:
                txt = ((r.json().get("choices") or [{}])[0]
                       .get("message", {}).get("content") or "")
                out = _parse_sheet_reply(txt)
                if out:
                    return {**out, "reader": want}
            else:
                log(f"vision read failed on {want}: {r.status_code} {r.text[:120]}")
        except Exception as e:                     # noqa: BLE001
            log(f"vision read failed on {want}: {e}")

    # 2. The pod's own VLM. Known to see, free, and already loaded for reviews.
    try:
        img = requests.get(image_url, timeout=(10, 60))
        img.raise_for_status()
        b64 = base64.b64encode(img.content).decode()
        out = vlm.describe_sheet([(img.headers.get("content-type", "image/png"), b64)])
        if out.get("identity"):
            return {**out, "reader": vlm.VLM_MODEL}
    except Exception as e:                         # noqa: BLE001
        log(f"local vision read failed: {e}")
    return None


def _parse_sheet_reply(txt):
    """The hosted reader's JSON, or its prose if it ignored the format."""
    txt = (txt or "").strip()
    if not txt:
        return None
    try:
        out = json.loads(txt[txt.index("{"):txt.rindex("}") + 1])
    except Exception:                              # noqa: BLE001
        out = {"identity": txt, "confidence": "low"}
    identity = " ".join(str(out.get("identity") or "").split())[:400]
    if not identity:
        return None
    return {"identity": identity, "confidence": out.get("confidence") or "low",
            "kind": (str(out.get("kind") or "").strip().lower() or None)}


def confirm_draft_entries(project_id, session):
    """Promote a wizard session's draft entries to canon.

    Twin of `confirmDraftSession` in src/lib/db/director.ts — tier 1 queues its
    own render so it commits here, tier 2 commits from the wizard. Dropping the
    stamp is half the job: a row that still carries `draft_session` is one a
    discard would delete, so leaving it behind would make committed canon
    destructible by an abandoned session.

    Selected BY THE STAMP rather than from `new_entries`, which is what the JS
    twin does and what makes them equivalent. Outfit variants are the reason:
    they are their own character entries but are collected in `variant_rows`,
    not `new_entries`, so a list-driven commit left every variant permanently
    draft-and-stamped — invisible in the bible, and deletable by a discard of a
    session whose episode had already been queued.
    """
    if not session:
        return 0
    rows = sb.get(f"bible_entries?project_id=eq.{project_id}"
                  f"&doc->>draft_session=eq.{session}&select=id,doc")
    for row in rows:
        doc = dict(row.get("doc") or {})
        doc.pop("draft_session", None)
        sb.patch(f"bible_entries?id=eq.{row['id']}", {"status": "confirmed", "doc": doc})
    if rows:
        log(f"committed {len(rows)} bible entr{'y' if len(rows) == 1 else 'ies'} for this episode")
    return len(rows)


def attach_user_refs(structured, bible, project_id, *, read_sheets=True, vision_model=None):
    """Stage the interview's attachments as sheets. Returns {entry_id: {roles}}.

    Strict about what it accepts, because a wrong id here does not fail loudly:
    it stages someone else's picture as a character's identity anchor and every
    block of the episode inherits it. The asset must exist, be an image, belong
    to this project and not be binned; anything else is logged and skipped.

    `read_sheets` then does the other half: a vision model READS each supplied
    sheet and the entry's identity line is rewritten to match it. Attaching a
    picture and leaving a contradicting sentence in place is what produced a
    bible whose face slot was the user's design and whose body and turnaround
    were something else — see `_reconcile_identity`.
    """
    filled = {}
    wanted = []
    for key, kind in (("cast", "character"), ("world", "environment"), ("props", "prop")):
        for item in (structured.get(key) or []):
            if not isinstance(item, dict):
                continue
            ids = [x for x in (item.get("ref_asset_ids") or []) if isinstance(x, str)]
            if item.get("name") and ids:
                wanted.append((kind, str(item["name"]), ids))
    if not wanted:
        return filled

    all_ids = sorted({i for _, _, ids in wanted for i in ids})
    rows = sb.get(f"assets?id=in.({','.join(all_ids)})"
                  f"&select=id,kind,project_id,deleted_at,b2_key")
    by_id = {r["id"]: r for r in rows}
    usable = {r["id"] for r in rows
              if r.get("kind") in ("image", "frame") and not r.get("deleted_at")
              and str(r.get("project_id")) == str(project_id)}
    for bad in [i for i in all_ids if i not in usable]:
        log(f"user ref {bad} ignored — missing, binned, not an image, or another project's")

    for kind, name, ids in wanted:
        hit = match_brief_name(name, [e["name"] for e in bible if e["kind"] == kind])
        entry = _find_entry(bible, kind, hit) if hit else None
        if not entry:
            log(f"user ref for {kind} '{name}' unattached — no matching bible entry")
            continue
        existing = sb.get(f"bible_assets?entry_id=eq.{entry['id']}&select=asset_id,role,slot")
        mine = [i for i in ids if i in usable]
        # READ FIRST: the role a picture should hold is what the picture IS, and
        # the identity line is what it SHOWS. Both come out of one read, so it
        # happens before anything is written and costs one call per sheet.
        seen = {}
        if read_sheets:
            for aid in mine:
                url = _asset_url(by_id.get(aid))
                if not url:
                    continue
                try:
                    got = describe_ref_sheet(url, model=vision_model)
                except Exception as e:                  # noqa: BLE001 — never cost the plan
                    log(f"sheet read failed for '{entry['name']}': {e}")
                    continue
                if got:
                    seen[aid] = got
        detected = {aid: g.get("kind") for aid, g in seen.items() if g.get("kind")}
        for aid, role in user_ref_slots(kind, mine, detected):
            # A sheet already holding this role loses it: every consumer
            # resolves a role with order=slot&limit=1, so the old plate is
            # archived rather than deleted and stays in the library.
            for old in existing:
                if old["asset_id"] != aid and old["role"] == role and int(old.get("slot") or 0) < ARCHIVE_SLOT:
                    sb.patch(f"bible_assets?entry_id=eq.{entry['id']}"
                             f"&asset_id=eq.{old['asset_id']}", {"slot": ARCHIVE_SLOT})
                    old["slot"] = ARCHIVE_SLOT
            if any(x["asset_id"] == aid for x in existing):
                sb.patch(f"bible_assets?entry_id=eq.{entry['id']}&asset_id=eq.{aid}",
                         {"role": role, "slot": 0})
            else:
                sb.insert("bible_assets", {"entry_id": entry["id"], "asset_id": aid,
                                           "role": role, "slot": 0})
                existing.append({"asset_id": aid, "role": role, "slot": 0})
            filled.setdefault(entry["id"], set()).add(role)
        if filled.get(entry["id"]):
            # The identity line comes from the sheet the reader was most sure
            # of, preferring the one that shows the most: a turnaround states
            # the whole design, a face crop states a third of it.
            best = max(seen.values(),
                       key=lambda g: (("turnaround", "full_body", "master").count(g.get("kind") or ""),
                                      {"high": 2, "medium": 1}.get(g.get("confidence"), 0)),
                       default=None)
            if best:
                _apply_identity(entry, best)
            filled[entry["id"]] |= redundant_roles(filled[entry["id"]])
            log(f"user sheets staged for {kind} '{entry['name']}': "
                f"{', '.join(sorted(filled[entry['id']]))}")
    return filled


def _asset_url(row):
    base = (os.environ.get("B2_CDN_BASE") or os.environ.get("VITE_B2_CDN_BASE") or "").rstrip("/")
    key = (row or {}).get("b2_key")
    return f"{base}/{key}" if base and key else None


def _apply_identity(entry, seen):
    """Write a read description onto the entry as its identity line.

    The written line is kept in `doc.identity_line_written` because it carries
    story detail a picture cannot show — a scar under a sleeve, "hides her fear
    behind precise procedures". Nothing is written when the read came back
    empty: a description nobody could produce is not grounds for erasing one
    somebody wrote.
    """
    if not seen or not seen.get("identity"):
        log(f"sheet unread for '{entry['name']}' — keeping the written line")
        return False
    was = entry.get("identity_line") or ""
    doc = {**(entry.get("doc") or {}), "sheet_identity": seen["identity"],
           "sheet_read_by": seen.get("reader"),
           **({"sheet_kind": seen["kind"]} if seen.get("kind") else {}),
           **({"identity_line_written": was} if was else {})}
    sb.patch(f"bible_entries?id=eq.{entry['id']}",
             {"identity_line": seen["identity"], "doc": doc})
    entry["identity_line"], entry["doc"] = seen["identity"], doc
    log(f"identity read off the sheet for '{entry['name']}' "
        f"({seen.get('reader')}, {seen.get('kind')}, {seen.get('confidence')}): "
        f"{seen['identity'][:90]}")
    return True


def _reconcile_identity(entry, image_url, vision_model):
    """Read one sheet and apply it. Kept for callers that have a URL and want
    the whole operation — `attach_user_refs` reads in bulk instead, because it
    needs the sheet KIND before it can decide which slot the picture fills."""
    try:
        seen = describe_ref_sheet(image_url, model=vision_model)
    except Exception as e:                          # noqa: BLE001 — never cost the plan
        log(f"sheet read skipped for '{entry['name']}': {e}")
        return False
    return _apply_identity(entry, seen)


def attach_user_refs(structured, bible, project_id, *, read_sheets=True, vision_model=None):
    """Stage the interview's attachments as sheets. Returns {entry_id: {roles}}.

    Strict about what it accepts, because a wrong id here does not fail loudly:
    it stages someone else's picture as a character's identity anchor and every
    block of the episode inherits it. The asset must exist, be an image, belong
    to this project and not be binned; anything else is logged and skipped.

    `read_sheets` then does the other half: a vision model READS each supplied
    sheet and the entry's identity line is rewritten to match it. Attaching a
    picture and leaving a contradicting sentence in place is what produced a
    bible whose face slot was the user's design and whose body and turnaround
    were something else — see `_reconcile_identity`.
    """
    filled = {}
    wanted = []
    for key, kind in (("cast", "character"), ("world", "environment"), ("props", "prop")):
        for item in (structured.get(key) or []):
            if not isinstance(item, dict):
                continue
            ids = [x for x in (item.get("ref_asset_ids") or []) if isinstance(x, str)]
            if item.get("name") and ids:
                wanted.append((kind, str(item["name"]), ids))
    if not wanted:
        return filled

    all_ids = sorted({i for _, _, ids in wanted for i in ids})
    rows = sb.get(f"assets?id=in.({','.join(all_ids)})"
                  f"&select=id,kind,project_id,deleted_at,b2_key")
    by_id = {r["id"]: r for r in rows}
    usable = {r["id"] for r in rows
              if r.get("kind") in ("image", "frame") and not r.get("deleted_at")
              and str(r.get("project_id")) == str(project_id)}
    for bad in [i for i in all_ids if i not in usable]:
        log(f"user ref {bad} ignored — missing, binned, not an image, or another project's")

    for kind, name, ids in wanted:
        hit = match_brief_name(name, [e["name"] for e in bible if e["kind"] == kind])
        entry = _find_entry(bible, kind, hit) if hit else None
        if not entry:
            log(f"user ref for {kind} '{name}' unattached — no matching bible entry")
            continue
        existing = sb.get(f"bible_assets?entry_id=eq.{entry['id']}&select=asset_id,role,slot")
        mine = [i for i in ids if i in usable]
        # READ FIRST: the role a picture should hold is what the picture IS, and
        # the identity line is what it SHOWS. Both come out of one read, so it
        # happens before anything is written and costs one call per sheet.
        seen = {}
        if read_sheets:
            for aid in mine:
                url = _asset_url(by_id.get(aid))
                if not url:
                    continue
                try:
                    got = describe_ref_sheet(url, model=vision_model)
                except Exception as e:                  # noqa: BLE001 — never cost the plan
                    log(f"sheet read failed for '{entry['name']}': {e}")
                    continue
                if got:
                    seen[aid] = got
        detected = {aid: g.get("kind") for aid, g in seen.items() if g.get("kind")}
        for aid, role in user_ref_slots(kind, mine, detected):
            # A sheet already holding this role loses it: every consumer
            # resolves a role with order=slot&limit=1, so the old plate is
            # archived rather than deleted and stays in the library.
            for old in existing:
                if old["asset_id"] != aid and old["role"] == role and int(old.get("slot") or 0) < ARCHIVE_SLOT:
                    sb.patch(f"bible_assets?entry_id=eq.{entry['id']}"
                             f"&asset_id=eq.{old['asset_id']}", {"slot": ARCHIVE_SLOT})
                    old["slot"] = ARCHIVE_SLOT
            if any(x["asset_id"] == aid for x in existing):
                sb.patch(f"bible_assets?entry_id=eq.{entry['id']}&asset_id=eq.{aid}",
                         {"role": role, "slot": 0})
            else:
                sb.insert("bible_assets", {"entry_id": entry["id"], "asset_id": aid,
                                           "role": role, "slot": 0})
                existing.append({"asset_id": aid, "role": role, "slot": 0})
            filled.setdefault(entry["id"], set()).add(role)
        if filled.get(entry["id"]):
            # The identity line comes from the sheet the reader was most sure
            # of, preferring the one that shows the most: a turnaround states
            # the whole design, a face crop states a third of it.
            best = max(seen.values(),
                       key=lambda g: (("turnaround", "full_body", "master").count(g.get("kind") or ""),
                                      {"high": 2, "medium": 1}.get(g.get("confidence"), 0)),
                       default=None)
            if best:
                _apply_identity(entry, best)
            filled[entry["id"]] |= redundant_roles(filled[entry["id"]])
            log(f"user sheets staged for {kind} '{entry['name']}': "
                f"{', '.join(sorted(filled[entry['id']]))}")
    return filled


def _asset_url(row):
    base = (os.environ.get("B2_CDN_BASE") or os.environ.get("VITE_B2_CDN_BASE") or "").rstrip("/")
    key = (row or {}).get("b2_key")
    return f"{base}/{key}" if base and key else None


def _apply_identity(entry, seen):
    """Write a read description onto the entry as its identity line.

    The written line is kept in `doc.identity_line_written` because it carries
    story detail a picture cannot show — a scar under a sleeve, "hides her fear
    behind precise procedures". Nothing is written when the read came back
    empty: a description nobody could produce is not grounds for erasing one
    somebody wrote.
    """
    if not seen or not seen.get("identity"):
        log(f"sheet unread for '{entry['name']}' — keeping the written line")
        return False
    was = entry.get("identity_line") or ""
    doc = {**(entry.get("doc") or {}), "sheet_identity": seen["identity"],
           "sheet_read_by": seen.get("reader"),
           **({"sheet_kind": seen["kind"]} if seen.get("kind") else {}),
           **({"identity_line_written": was} if was else {})}
    sb.patch(f"bible_entries?id=eq.{entry['id']}",
             {"identity_line": seen["identity"], "doc": doc})
    entry["identity_line"], entry["doc"] = seen["identity"], doc
    log(f"identity read off the sheet for '{entry['name']}' "
        f"({seen.get('reader')}, {seen.get('kind')}, {seen.get('confidence')}): "
        f"{seen['identity'][:90]}")
    return True


def _reconcile_identity(entry, image_url, vision_model):
    """Rewrite the entry's identity line to match the picture the user gave.

    This is the difference between attaching a sheet and USING one. The line is
    repeated into every shot and it is what composes the derived sheets — the
    full body and the turnaround are drawn FROM it, anchored on the face plate —
    so a line that disagrees with the picture produces a bible where slot 1 is
    your design and slots 2 and 3 are something else wearing its face. Measured
    exactly that way: a supplied brown-coat sheet sat in `face` while the
    generated body and turnaround came back as an orange astronaut, because the
    line said astronaut.

    Runs BEFORE the sheet queue in the same pass, so the corrected line is what
    those renders read. Failure leaves the writer's line alone and says so: a
    description nobody could read is not grounds for erasing one somebody wrote.
    """
    try:
        seen = describe_ref_sheet(image_url, model=vision_model)
    except Exception as e:                          # noqa: BLE001 — never cost the plan
        log(f"sheet read skipped for '{entry['name']}': {e}")
        return
    if not seen or not seen.get("identity"):
        log(f"sheet unread for '{entry['name']}' — keeping the written line")
        return
    was = entry.get("identity_line") or ""
    doc = {**(entry.get("doc") or {}), "sheet_identity": seen["identity"],
           "sheet_read_by": seen.get("reader"), **({"identity_line_written": was} if was else {})}
    sb.patch(f"bible_entries?id=eq.{entry['id']}",
             {"identity_line": seen["identity"], "doc": doc})
    entry["identity_line"], entry["doc"] = seen["identity"], doc
    log(f"identity read off the sheet for '{entry['name']}' "
        f"({seen.get('reader')}, {seen.get('confidence')}): {seen['identity'][:90]}")


def _sheet_spec(entry, style):
    """The facts a reference sheet needs; the image handler turns them into a
    prompt in the target family's own order (worker/image_prompt.py). Composing
    the string here would bake SDXL ordering into a job that may end up running
    on another architecture."""
    return {"kind": entry["kind"],
            "role": "master" if entry["kind"] == "environment" else "full_body",
            "name": entry.get("name"),
            "identity": entry.get("identity_line") or entry.get("summary"),
            # A readable prop's exact text renders ON the sheet — the sheet is
            # the one chance to fix what the document/sign/screen says.
            **({"reads": (entry.get("doc") or {}).get("reads")}
               if (entry.get("doc") or {}).get("reads") else {}),
            # …and an ILLUSTRATED prop's subject: who is on the page is as much
            # the design as what it says, and left unstated the model draws
            # whoever it has seen most of rather than whoever the plot needs.
            **({"depicts": (entry.get("doc") or {}).get("depicts")}
               if (entry.get("doc") or {}).get("depicts") else {}),
            "style": style}


def _sheet_prompt(entry, style):
    """Plain-text fallback for a worker that predates prompt_spec."""
    return image_prompt.compose(_sheet_spec(entry, style))


DEFAULT_PIPELINE_MODEL = _env("PIPELINE_LLM_MODEL", "gpt-5.6-terra")

# The longest a single beat may be: what one H3 master pass can render. A beat
# is indivisible as far as dialogue goes — planner._flatten will cut a longer
# one into equal parts, and every part inherits the WHOLE beat's lines — so a
# beat above this ceiling is not a long shot, it is a broken one.
from h3_timing import MAX_CONTENT_MS as MAX_BEAT_MS  # noqa: E402

# OpenAI TTS voices with the timbre words that select them, for character
# voice references. Deterministic: the writer's voice descriptor picks the
# nearest preset, dedup rotates.
_TTS_VOICES = [
    ("onyx", ("deep", "low", "gravel", "bass", "booming", "rumbl")),
    ("echo", ("crisp", "clipped", "sharp", "cool", "precise")),
    ("fable", ("warm", "storyteller", "lilt", "british", "gentle")),
    ("nova", ("bright", "young", "light", "energetic", "quick")),
    ("shimmer", ("soft", "breathy", "airy", "smoky", "husky")),
    ("alloy", ()),
]


def pick_tts_voice(descriptor, taken):
    """Nearest OpenAI voice for a written voice description; avoids reusing a
    voice already assigned when an alternative exists."""
    d = (descriptor or "").lower()
    ranked = [v for v, keys in _TTS_VOICES if any(k in d for k in keys)]
    ranked += [v for v, _ in _TTS_VOICES if v not in ranked]
    return next((v for v in ranked if v not in taken), ranked[0])


def _character_anchor(entry):
    """The ONE picture that conditions this character in a panel.

    Python twin of `src/lib/panelSpec.ts::characterAnchor`, and it exists in two
    places for the same reason the whole panel spec does: the browser redraws a
    panel and the PLANNER queues the first forty. Only the browser copy was
    fixed first, so a new draft went straight back to face plates — the symptom
    that found this.

    It was `roles: ["face"]`, and for an outfit variant the PARENT's face. A
    face plate is head-and-shoulders on grey, so it says nothing about what the
    character is WEARING and the model dresses them from the prose (measured: an
    invented orange spacesuit). The turnaround is a face plate too — two of its
    six views are face close-ups — and carries the costume from six angles, so
    one slot does both jobs. A variant stages its OWN body sheet, because the
    costume is the entire reason the variant exists.

    `first` is required: `_resolve_anchor` appends EVERY role it finds, so a
    bare preference list would stage four pictures of one person.
    """
    variant = (entry.get("doc") or {}).get("variant_of")
    roles = (["full_body", "outfit", "turnaround", "face"] if variant
             else ["turnaround", "full_body", "outfit", "face"])
    return {"entry_id": entry["id"], "roles": roles, "first": True}


PANEL_PROP_CAP = 2          # a panel is a shot, not a product catalogue


def scene_panel_specs(shots, cast_rows, env_row, *, style, world=None,
                      time_of_day=None, cast_cap=2, max_anchors=None,
                      prop_rows=None, wide_faces=1, plate_turn=0):
    """One scene's panels -> [(anchors, prompt_spec)], in shot order.

    Module-level for the same reason `ref_plan_for` is: it was a closure inside
    `plan_storyboard`, so nothing else could compose a panel the way the planner
    does — a re-draw, a verification, a repair all had to reimplement it and
    then drift. The job INSERT stays in the caller (deps, priority, model and
    label are the planner's business); this is the part that decides what the
    render is told and which pictures it is handed.

    Python twin of `src/lib/panelSpec.ts::panelSpec`. It takes the WHOLE scene
    because the location-plate rotation is a per-scene decision — see
    image_prompt.plate_plan — and a per-beat signature cannot express it.
    """
    world = world or {}
    by_name = {c["name"].split(" — ")[0].lower(): c for c in cast_rows}
    by_full = {c["name"].lower(): c for c in cast_rows}

    def _cast_row(nm):
        """One `cast` name -> its bible row, however the shot spells it.

        A beat names a character by BASE name ("Villian Rei") or by the FULL
        variant name the bible files them under ("Villian Rei — Glitching
        capture coat"), and the cinematographer writes both — sometimes in one
        scene. This was a bare `by_name[n.lower()]`, i.e. a FULL name looked up
        in a BASE-keyed dict, so every full-form beat matched nobody: `named`
        came back empty, `featured_cast` had no roster to match the shot text
        against (it can only ever constrain someone, never introduce them), and
        the panel fell through to `cast_rows[:1]` — the scene's FIRST cast
        member, who is routinely not in the shot.

        Measured on CITY_CAPTURE_2 b1/b2, whose cast is Villian Rei and
        Astronaut Rei: both staged GUIDE REI's sheet, both compiled a spec
        naming her, and both came back with her brown jacket while Villian Rei,
        staged nowhere, was drawn from prose. Nothing errored — the fallback is
        a legal path, and it exists for the beat that casts by pronoun.

        Exact first, so nothing that resolves today changes. The base fallback
        lands on the scene's own row, which is the VARIANT (`cast_rows` is
        fetched from `scene.cast_ids`), so the wardrobe stays right either way.

        Twin of `panelSpec.ts::resolveCast`.
        """
        n = str(nm).lower()
        return by_full.get(n) or by_name.get(n.split(" — ")[0])

    plates = image_prompt.plate_plan([sh.get("camera") or "" for sh in shots],
                                     start_turn=plate_turn)
    out = []
    for sh, proles in zip(shots, plates):
        # Anchor on the people the SHOT'S OWN TEXT puts in frame, not the
        # beat's cast list. `meta.cast` is the cinematographer's roster and
        # its contract already says "ONLY the characters visibly in frame" —
        # which the model agrees to and then ignores: ASTRONAUT_CAPTURE wrote
        # all five names onto every beat, so a close-up on one face staged
        # five references and montaged. `featured_cast` (word-boundary,
        # longest-name-first — this cast is "Rei" plus four "<Something> Rei"
        # variants) decides staging from camera + action + who speaks; the
        # roster survives only as the fallback for a beat that casts by
        # pronoun, where it behaves exactly as before.
        #
        # The order is the matcher's mention order, which is also the fix for
        # slot 1: image1 carries the high token budget in both reference
        # encoders, and `meta.cast` lists the lead first in essentially every
        # beat — measured on AFTERLIGHT, Aki held across 42 panels while Haru
        # drifted. Whoever the camera or action names first gets the
        # conditioning.
        camera = sh.get("camera") or ""
        named = [r for r in (_cast_row(n) for n in (sh.get("cast") or [])) if r]
        row_by_base = {}
        for c in named:
            row_by_base.setdefault(c["name"].split(" — ")[0].lower(), c)
        # …except a line marked `offscreen`, the DP's V.O. cutaway: this
        # beat's panel shows the listener or the insert, and counting the
        # voice would put its speaker's face on it. Twin of panelSpec.ts.
        speakers = " ".join(str((d or {}).get("speaker") or "")
                            for d in (sh.get("dialogue") or [])
                            if not (d or {}).get("offscreen"))
        feat = [row_by_base[n.lower()] for n in image_prompt.featured_cast(
            f"{camera} {sh.get('action') or ''} {speakers}",
            list(row_by_base))]
        # A voice on the far end of a phone is not in the panel either, and it
        # is `speakers` above that drags them in: a speaker counts as featured,
        # which is right for someone in the room and wrong for a caller. Same
        # detector as the block staging, on the shot's own text — with the
        # speaker string deliberately EXCLUDED from it, or the name would be
        # its own evidence of being in frame. Measured on THE LAST SERVICE
        # ARRIVAL b3, which staged Tam Reed alone, closed the cast set around
        # her, and would have handed the block a panel of a woman who is a
        # phone call.
        _remote = set(image_prompt.remote_speakers(
            f"{camera} {sh.get('action') or ''}",
            [c["name"].split(" — ")[0] for c in feat],
            [(d or {}).get("speaker") for d in (sh.get("dialogue") or [])]))
        if _remote:
            feat = [c for c in feat if c["name"].split(" — ")[0] not in _remote]
        # `cast_cap` follows the render family (image_prompt.panel_cast_cap):
        # a name dropped here stays in the ACTION prose with no sheet staged,
        # and the model draws them from words alone — the invented-extra
        # artifact. `cast_complete` records whether that happened, because the
        # envelope's "no other people" close-out is only true when it didn't.
        if (sh.get("meta") or {}).get("breath"):
            # A breath beat is a held pause on the staging just seen. Its
            # action is our own filler ("no one speaks and nothing new enters
            # the frame") and gives the model no composition, so staged
            # identity sheets become the strongest signal in the job and the
            # panel comes back AS a sheet — measured on ASTRONAUT_CAPTURE b7,
            # grey ground and all. What these beats show is the PLACE.
            present = []
        elif feat:
            # ALL the featured, close shots included. A close-up-stages-one
            # rule was tried here and lost the same day it shipped: dropping
            # the action-named second character re-invited the invented-extra
            # artifact (b3's off-model masked "Astronaut Rei", b6's Villian in
            # an invented white shirt — both drawn from prose because their
            # sheets were withheld). The part of that rule that was right —
            # the camera's subject in image1 — falls out of mention order for
            # free, because the camera text leads the matcher's input.
            present = feat[:cast_cap]
        else:
            present = named[:cast_cap] or cast_rows[:1]
        face_pairs = [(_character_anchor(c),
                       f"{c['name'].split(' — ')[0]}'s character sheet",
                       {"kind": "character", "name": c["name"].split(" — ")[0],
                        "identity": c.get("identity_line")})
                      for c in present]

        # PROPS the shot's own text names. `scene_panel_specs` has only ever
        # built face + location anchors, so a plot object with its own drawn
        # reference sheet — Guide Rei's cloudy marble, the photograph, the
        # cracked-world map — was never handed to the render at all, and the
        # model invented one from the prose every time. Measured on Rei E3 v6:
        # the photograph came back as a blank white sheet in two of the three
        # panels that hold it, while the one panel that got it right proves the
        # model can draw it when told.
        #
        # Same matcher as the cast, so the same two rules apply: a prop named
        # only as somebody's possession still counts (it is the OBJECT that is
        # in frame, which is exactly what a possessive says), and a prop the
        # prose calls by its last word is found.
        prop_pairs = []
        if prop_rows:
            by_prop = {p["name"].lower(): p for p in prop_rows}
            for nm in image_prompt.featured_cast(
                    f"{camera} {sh.get('action') or ''}", list(by_prop),
                    possessive_excludes=False):
                p_row = by_prop[nm.lower()]
                prop_pairs.append(({"entry_id": p_row["id"], "roles": ["ref"],
                                    "first": True},
                                   f"{p_row['name']} (prop reference)",
                                   {"kind": "prop", "name": p_row["name"],
                                    "identity": p_row.get("identity_line")}))

        env_pair, plate = None, None
        if env_row:
            _en = env_row["name"]
            # `first`: a preference order, not a set. Without it
            # _resolve_anchor stages every plate it finds and one location eats
            # three of the panel's slots.
            plate = proles[0]
            # The label says WHICH place, never which plate: the plate can
            # still fall back (a location with no reverse angle on file
            # resolves to its master), and a label naming a picture that was
            # not staged is the failure `order_anchors` already warns about.
            # The plate wording is composed from `spec["plate"]`, which
            # handle_image_gen corrects to what actually resolved.
            env_pair = ({"entry_id": env_row["id"], "roles": proles,
                         "first": True},
                        f"{'the ' if not _en.lower().startswith('the ') else ''}"
                        f"{_en} location",
                        {"kind": "location", "name": _en,
                         "identity": env_row.get("identity_line")})
        # On a wide/establishing/full shot the LOCATION takes image1 and at
        # most one face rides along — see image_prompt.location_leads.
        ordered, _ = image_prompt.order_anchors(
            sh.get("camera") or "", face_pairs, env_pair,
            faces_when_wide=wide_faces)
        # A hard ceiling on PICTURES, applied after ordering so slot 1 keeps
        # whatever `order_anchors` decided should hold it. Measured on Rei E3
        # v6's 58 panels: every panel staging 4-5 references came back as a
        # ROW OF CAST FACING CAMERA instead of the shot (CITY_CAPTURE_2 b3/b5/
        # b6, CITY_CAPTURE_3 b4, MEMORY_RETURN b8), while every panel staging 2
        # came back as a composed shot. More sheets is more sheet.
        # Props take what is left. A face or the plate losing its slot to an
        # object is the wrong trade — identity and place are what a panel is
        # anchored on — so they are appended and then cut by the same ceiling.
        ordered = list(ordered) + prop_pairs[:PANEL_PROP_CAP]
        if max_anchors and len(ordered) > max_anchors:
            # The LOCATION PLATE is never what gets cut. Truncating the tail
            # blindly removes it on every non-wide shot (order_anchors puts
            # faces first there), which is the opposite of the fix: the plate
            # is the only reference that is not a person, and dropping it
            # leaves a frame with nothing in it but character sheets — a
            # line-up by construction. Faces yield first, then props.
            keep = [t for t in ordered if (t[2] or {}).get("kind") == "location"]
            rest = [t for t in ordered if (t[2] or {}).get("kind") != "location"]
            room = max(0, max_anchors - len(keep))
            kept = set(id(t) for t in keep) | set(id(t) for t in rest[:room])
            ordered = [t for t in ordered if id(t) in kept]
        # Completeness is judged on what the SHOT CLAIMS to show, against what
        # ordering kept: a wide drops faces to one deliberately, and claiming
        # "no other people" while the action names three tells the model two
        # contradictory things about the same frame. When the text features a
        # subset of the roster, that subset IS the claim — the other roster
        # members are asserted out of frame, which is the point of featuring —
        # and only a shot whose every claimed member has a staged sheet may
        # close the set.
        claim = feat or named
        n_faces = sum(1 for t in ordered
                      if (t[2] or {}).get("kind") == "character")
        cast_complete = bool(claim) and len(claim) <= cast_cap \
            and n_faces == len(claim)
        spec = {"kind": "panel", "style": style,
                # the WHOLE camera line — image_prompt extracts size and angle
                # from it and drops the motion grammar, which means nothing in
                # a still
                "camera": sh.get("camera") or "",
                "action": sh.get("action"),
                "time_of_day": time_of_day or None,
                # What ORDERING KEPT, never `present`. `order_anchors` drops
                # faces on a wide (the location takes image1 and at most one
                # face rides along), and describing a character the render was
                # handed no picture of is worse than either being wrong alone:
                # measured on MEMORY_RETURN b1, where the envelope read
                # "<Subject 2> (Guide Rei) and Miko and Knight Rei" over two
                # references, so two of the three named people had no sheet and
                # H3 invented them. `cast_complete` already followed the
                # ordering; this did not.
                "cast": [{"name": t[2]["name"], "identity": t[2].get("identity")}
                         for t in ordered if (t[2] or {}).get("kind") == "character"],
                "location": ({"name": env_row["name"],
                              "identity": env_row.get("identity_line")}
                             if env_row else None),
                # Which plate is staged. Present ONLY when one is, because it
                # is what switches the framing from a description into a
                # camera-move imperative — the difference between a new vantage
                # and a copy of the plate (image_prompt.PLATE_MOVE).
                **({"plate": plate} if plate else {}),
                **({"cast_complete": True} if cast_complete else {}),
                "refs": [t[1] for t in ordered],
                # What the H3 envelope binds <Subject N> to. Rides with `refs`,
                # which rides with `anchors`, so <Picture N> cannot drift from
                # the staged order.
                "ref_subjects": [t[2] for t in ordered],
                **({"world": {k: world[k] for k in ("era", "palette")
                              if world.get(k)}} if world else {})}
        out.append(([t[0] for t in ordered], spec))
    return out


# The four angles a location's bible carries. Order matters: it is the draw
# order for a location that is missing everything, and the master has to land
# first because every other plate is anchored on it.
ENV_PLATE_ROLES = ("master", "alt_angle", "detail", "atmosphere")


def backfill_env_plates(envs, *, name_to_id, skip_ids, have_roles, fetch_entry,
                        sheet_job):
    """Queue the plates a RETURNING location is missing -> {entry_id: last job}.

    The turnaround backfill's twin, and it exists for the same reason: plates
    are drawn in the new-entries loop only, so a location reused from an
    earlier plan keeps whatever subset it happens to have. Rei E3's Observatory
    came back with master+detail, and the plate rotation that varies the camera
    (image_prompt.plate_plan) resolved every ring shot back to the master —
    the one-camera lock, reintroduced by absence rather than by code, across
    28 of the episode's 48 beats. Nothing errored; the anchor's preference
    order is DESIGNED to fall back quietly.

    The missing plates are chained (each deps on the previous) so that a
    consumer waiting on the LAST job has waited for the whole set — the caller
    files that job id where the panel dep-wiring already looks. Plates anchor
    on the master; when the master itself is missing it is drawn first and the
    late-bound anchor finds it exactly as it finds a stored one.

    Collaborators are injected (`have_roles`, `fetch_entry`, `sheet_job`) so
    the decision is testable off-pod; the caller passes sb-backed closures.
    """
    out = {}
    for e in envs or []:
        eid = name_to_id.get(("environment", (e.get("name") or "").lower()))
        if not eid or eid in skip_ids:
            continue
        missing = [r for r in ENV_PLATE_ROLES if r not in have_roles(eid)]
        if not missing:
            continue
        row = fetch_entry(eid)
        if not row:
            continue
        prev = None
        for role in missing:
            kw = ({} if role == "master" else
                  {"spec_extra": {"from_ref": True},
                   "extra": {"anchor_entry_id": eid, "anchor_roles": ["master"]}})
            prev = sheet_job(row, role, deps=[prev] if prev else None,
                             size=(1280, 704), **kw)
        out[eid] = prev
    return out


def speakers_needing_voice_refs(data, *, name_to_id, new_ids, fetch_entry):
    """Every character who SPEAKS in this episode and has no timbre clip.

    `backfill_env_plates`' twin, for the same reason and with the same failure
    mode. Voice refs were queued in the new-entries loop only, so a character
    who is not NEW to this plan never got one however many episodes went by —
    and a plan is the only thing that ever queued them in bulk.

    Who that actually catches: returning cast who predate the feature, entries
    added by hand in the bible, and anyone whose `tts` job failed or was
    cancelled. NOT a recast — `director_tools.recast_voice` nulls
    `voice_ref_asset_id` and queues its own replacement in the same call, so
    that path looks after itself; what it leaves behind if ITS job dies is
    exactly the residue this loop now picks up.

    Nothing errors in any of those cases: the block stages one fewer audio ref,
    on the timbre fallback path only, so it surfaces as a quality wobble rather
    than a failure — which is why it survived being written down as a known gap.

    Returns `(need, have)` — `need` is `[(entry_row, character_dict, line)]` in
    the writer's cast order, `have` the `voice_ref_asset_id`s of this episode's
    other speakers. A row that already HAS a clip is not re-synthesized: a
    voice ref is a fact about the CHARACTER, not about the episode, and
    remaking one per episode would re-baseline the reviewer's speaker verifier
    every time. `have` is returned rather than discarded because the voice
    PICKER needs it — two characters on one preset voice is the collision
    `pick_tts_voice`'s `taken` set exists to prevent, and seeding that set from
    new entries alone lets a returning lead and a new supporting character be
    handed the same voice.
    """
    lines_by_speaker = {}
    for s in data.get("scenes") or []:
        for b in s.get("beats") or []:
            for d in b.get("dialogue") or []:
                nm = (d.get("speaker") or "").strip().lower()
                if nm and nm not in lines_by_speaker and (d.get("line") or "").strip():
                    lines_by_speaker[nm] = d["line"].strip()
    out, have = [], []
    for c in data.get("characters") or []:
        nm = (c.get("name") or "").strip()
        key = nm.lower()
        if not nm or key not in lines_by_speaker:
            continue
        eid = name_to_id.get(("character", key))
        if not eid:
            continue
        row = fetch_entry(eid)
        if not row:
            continue
        # A brand-new entry cannot have a clip — it was created seconds ago —
        # so the check is skipped rather than trusted: a stale read there would
        # silently drop the one character who definitely needs one.
        if eid not in new_ids and row.get("voice_ref_asset_id"):
            have.append(row["voice_ref_asset_id"])
            continue
        out.append((row, c, lines_by_speaker[key]))
    return out, have


def _prop_sheet_extra(row, data, name_to_id, master_job_by_entry):
    """Anchors for a prop sheet, so the object is drawn where and as it belongs.

    A prop sheet used to be a bare product shot on studio grey with no
    references at all. Two things went wrong with that, both seen on screen:

    * A SITED prop — the scaffold KEEP-OUT sign — carries no information about
      where it hangs, so H3 put it wherever it liked, once filling half the
      frame. Anchoring on the location master and shooting it in place is what
      makes position part of the reference instead of a guess.
    * A prop that DEPICTS someone gets the wrong someone. AFTERLIGHT's
      sketchbook is the plot: Aki has been drawing Haru. Composed from prose
      alone it came back full of sketches of Aki, because her sheets are what
      the model had seen most of. The person a prop depicts has to be an
      anchor, not an adjective.

    Both are late-bound `{entry_id, roles}` anchors, resolved after the sheets
    they point at have rendered, so ordering is a dependency and not a race.
    """
    doc = row.get("doc") or {}
    anchors, deps = [], []
    text = " ".join(str(x) for x in (row.get("identity_line"), doc.get("reads"),
                                     doc.get("depicts")) if x)

    # Who does it depict? An explicit `depicts` wins; otherwise a character
    # named in its own description. Matched on the base name, longest first,
    # so "Aki Minase" beats a stray "Aki" inside another name.
    for c in sorted((data.get("characters") or []),
                    key=lambda c: -len(str(c.get("name") or ""))):
        base = str(c.get("name") or "").split(" — ")[0].strip()
        if not base:
            continue
        if re.search(rf"\b{re.escape(base)}\b", text, re.I):
            cid = name_to_id.get(("character", (c.get("name") or "").lower()))
            if cid:
                anchors.append({"entry_id": cid, "roles": ["face", "full_body"]})
            break

    # Where does it live? ONLY an explicit `fixed_to` counts. Inferring it from
    # "this prop appears in one scene" was tried and over-fires: a notebook the
    # Other Reader carries appears in exactly one scene and is not mounted to
    # anything, so it got photographed as a fixture of the room. Being carried
    # is the common case; a fixture is the exception the writer states.
    eid = (name_to_id.get(("environment", str(doc["fixed_to"]).lower()))
           if doc.get("fixed_to") else None)
    sited = eid is not None
    envs = {eid} if sited else set()
    if sited:
        eid = next(iter(envs))
        anchors.append({"entry_id": eid, "roles": ["master"]})
        if master_job_by_entry.get(eid):
            deps.append(master_job_by_entry[eid])

    if not anchors:
        return {}
    out = {"extra": {"anchors": anchors}}
    if sited:
        # image_prompt reads this to shoot the object in place rather than as a
        # catalogue photograph on grey.
        out["spec_extra"] = {"sited": True}
    if deps:
        out["deps"] = deps
    return out



#: The DAG a plan emits used to be pinned to the POD's lanes — `image_gen` on
#: gpu, `tts` on cpu, `launch_render` on cpu — whatever machine was planning
#: and whatever models were picked. That is the pod being mandatory: a desktop
#: user with a local engine and no pod got a storyboard whose every reference
#: sheet then sat `queued` forever, because the only worker that claims `gpu`
#: is the box they were trying not to wake.
#:
#: `payload.lanes` is what the caller says instead: `{"image_gen": "local"}`
#: routes exactly that kind to the queue only the desktop claims. Absent, every
#: default below is what it always was, so a pod plan is byte-identical.
#:
#: DELIBERATELY PER KIND, not one flag. A machine that can render its own
#: sheets still cannot synthesize an ElevenLabs voice reference or run
#: `launch_render` (which is pod Python), so "everything local" would be a
#: promise three of the five kinds cannot keep. The caller routes what it can
#: actually serve and leaves the rest.
LANE_DEFAULTS = {"image_gen": "gpu", "tts": "cpu", "music_gen": "gpu",
                 "launch_render": "cpu",
                 # Queued by `handle_launch_render` rather than by anything in
                 # this module, and routable for the same reason: with a
                 # desktop model map the same `resolve()` builds the same graph
                 # against files the engine window downloaded, so a block can
                 # render on the machine that planned it.
                 "master_pass": "gpu", "audio_slice": "cpu"}


def job_lane(payload, kind):
    """Which queue a job this plan emits should land in."""
    want = ((payload or {}).get("lanes") or {}).get(kind)
    return want or LANE_DEFAULTS[kind]


def plan_storyboard(job):
    """The staged studio: writer → story editor → cinematographer (see
    worker/storyplan.py), then deterministic packing and the one-shot DAG."""
    import storyplan

    jid = job["id"]
    payload = job.get("payload") or {}
    brief = payload.get("brief") or {}
    project = sb.get(f"projects?id=eq.{payload['project_id']}")[0]
    ep_id = payload.get("episode_id")
    if not ep_id:
        eps = sb.get(f"episodes?project_id=eq.{project['id']}&order=idx&limit=1")
        if not eps:
            raise LLMError("project has no episode")
        ep_id = eps[0]["id"]
    tier = int(payload.get("tier") or 2)
    backend = pick_backend(job, payload)
    target_ms = int(brief.get("duration_target_ms") or 60000)

    sb.job_progress(jid, 0.05, note="gathering context")
    bible = sb.get(f"bible_entries?project_id=eq.{project['id']}"
                   f"&select=id,kind,name,summary,identity_line,doc,status")
    bible_txt = "\n".join(
        f"- [{e['kind']}] {e['name']}: {e.get('identity_line') or e.get('summary') or ''}"
        for e in bible) or "(empty — invent what the brief needs)"
    # Lore is filtered to the episode being written: what holds now, and what is
    # operating but not yet revealed. Without the episode list every fact reads
    # as timeless, which is how an Ep2 twist ends up explained in Ep1.
    all_eps = sb.get(f"episodes?project_id=eq.{project['id']}&order=idx&select=id,idx,code,title")
    lore_txt = lore_context(bible, episodes=all_eps, episode_id=ep_id)

    medium = plan_medium(brief, project)
    experts = brief.get("experts") or []
    # A sitcom brief earns comedy craft with no checkbox: the writer decides
    # whether the episode has a cold open, an escalating small want and a tag,
    # and it only gets one pass at that.
    guide_txt = builtin_knowledge(
        medium, experts,
        genre_docs=["comedy_craft.md"] if storyplan.is_comedy(brief) else None)
    for g in rag_search(  # user-added docs (scripts, lore) layer on top
            f"{medium} directing: {brief.get('logline') or project.get('logline') or ''}",
            project_id=project["id"], k=4):
        guide_txt += f"\n\n[{g['title']}] {g['content']}"

    lyrics = (brief.get("audio_meta") or {}).get("lyrics") or []
    lyric_txt = "\n".join(
        f"  {int(l.get('t0', 0)) / 1000:.1f}-{int(l.get('t1', 0)) / 1000:.1f}s: {l.get('text', '')}"
        for l in lyrics)
    # Words for a track that does not exist yet (`brief.music.generate`).
    untimed_lyrics = ((brief.get("music") or {}).get("lyrics") or "").strip()[:4000]

    # A REVISION of an existing plan, not a first draft. `revise_of` names the
    # board on screen when the user pressed Re-plan; the note is what they
    # asked to change. Both ride the WRITER's brief and nowhere else — the
    # editor and the cinematographer receive the story object, and structure is
    # decided in the writers' room, so a note applied later would be arguing
    # with a plan that had already ignored it.
    revision_note = str(payload.get("revision_note") or "").strip()[:4000]
    prev_plan = None
    # `revise_blind` keeps the provenance (`revise_of` is still recorded on the
    # new board) while withholding the outline — for a note like "same brief,
    # completely different structure", where showing the writer what it wrote
    # last time is the surest way to get it back.
    if payload.get("revise_of") and not payload.get("revise_blind"):
        try:
            prev_plan = previous_plan_outline(payload["revise_of"])
        except Exception as e:  # noqa: BLE001 — context is an enrichment
            log(f"re-plan: could not read previous storyboard: {e}")
        if prev_plan is None:
            # Said out loud, because a revision written blind reads as the
            # model ignoring the note rather than as never having seen the
            # thing the note is about.
            log(f"re-plan: storyboard {payload['revise_of']} has no scenes "
                f"— writing from the brief alone")

    persona = (payload.get("persona") or
               "You are a seasoned creative director planning an AI-generated video.")
    craft = ("\n\n# Craft references\n" + guide_txt[:16000]) if guide_txt else ""
    # Separate budgets on purpose: the vendor guide is long, and slicing one
    # combined blob dropped whichever came last.
    fmt_ref = format_reference()[:20000]
    room = the_room(experts)

    # Which department reads which grounding. The writer never needs the H3
    # camera vendor guide; the cinematographer needs nothing about story craft
    # as much as it needs the camera grammar it will be judged against.
    stage_system = {
        "writer": persona + craft + room +
                  "\n\n# Task\nYou are running the WRITERS' ROOM pass. Story only — no cameras.",
        "editor": persona + room +
                  "\n\n# Task\nYou are the STORY EDITOR. Drama only — no new lore, no cameras.",
        "voice": persona + room +
                 "\n\n# Task\nYou are the DIALOGUE POLISH. Voice only — same events, "
                 "same speakers, same intent per line; you change how it is SAID.",
        # One pass voicing everyone averages toward one voice in four hats
        # (measured: E2 differentiated only on line LENGTH). This stage sees
        # ONE character. Registering it matters as much as writing it — an
        # unknown stage id used to KeyError inside an advisory try/except and
        # log "skipped", which is how the voice pass never ran before E1.
        "character": persona + room +
                     "\n\n# Task\nYou are voicing ONE character. Every other "
                     "line in the script is immutable context. Make this one "
                     "person unmistakable on the page.",
        # The comedy specialist, and the LAST dialogue stage. Gets `craft` the
        # way the choreographer does — comedy timing is a camera-adjacent
        # craft ("set up in a wide, pay off in a cut") — but rewrites lines
        # only. Registering it is not optional: see the note on
        # "choreographer" below, and the parity test that enforces it.
        "punchup": persona + craft + room +
                   "\n\n# Task\nYou are the PUNCH-UP. The story, the scenes and "
                   "who speaks are locked. You rewrite LINES so they play: the "
                   "joke lands at the end, every scene ends on its hardest "
                   "line, and no line could have been said by anyone else.",
        "blocking": persona + room +
                    "\n\n# Task\nYou are the CONTINUITY DIRECTOR. Geography only — "
                    "where every body is and faces, every beat. No story, no cameras.",
        # The fight specialist. Gets `craft` (it is a camera-adjacent craft
        # question) but NOT fmt_ref — it writes beat prose, never the H3
        # envelope, and showing it the vendor format is how `[Shot N]` leaks
        # into an action line. Registering it is not optional: an id
        # storyplan asks for that is missing here KeyErrors inside an advisory
        # try/except and logs "skipped", which is how the dialogue polish
        # silently never ran for its whole life.
        "choreographer": persona + craft + room +
                  "\n\n# Task\nYou are the FIGHT CHOREOGRAPHER. The story, the "
                  "shots and the camera are locked. You rewrite ONE field — "
                  "each action shot's action prose — into a chain of physical "
                  "cause and effect.",
        "cinematographer": persona + craft + fmt_ref + room +
                  "\n\n# Task\nYou are the CINEMATOGRAPHER. The story is locked; you decide "
                  "how each beat is SHOWN.",
        # The COMPOSER. `craft` is deliberately absent — those guides are about
        # pictures, and a composer handed shot-composition doctrine writes a
        # caption full of framing and light, which is how a score prompt turns
        # into a description of a photograph.
        "composer": persona + room +
                    "\n\n# Task\nYou are the COMPOSER. The film is locked; you decide "
                    "what it SOUNDS like underneath. Music only — no pictures, no "
                    "cameras, no lyrics.",
    }

    brief_json = json.dumps({
        "medium": medium, "style": project.get("style"),
        "genre": project.get("genre"), "aspect": project.get("aspect"),
        "title": project.get("title"), "logline": brief.get("logline") or project.get("logline"),
        "notes": brief.get("notes"), "duration_target_ms": target_ms,
        "scene_count_guidance": max(3, round(target_ms / 30000)),
        # HOW MANY LINES THE RUNTIME CAN ACTUALLY HOLD, and it has to be said
        # because nothing downstream can shorten dialogue. `_fit_durations`
        # scales beats onto the target, and then the measured-dialogue pass
        # GROWS every dialogue shot to its recorded lines plus handoff room
        # (`shot_floor_from_measured`) — a floor, never a ceiling, because a
        # line squeezed below speaking time is the DIALOGUE_CUTOFF this
        # pipeline spent months removing. So a writer who overwrites the
        # target does not get a tighter episode, it gets a LONGER one.
        # MEASURED on CLOSING TIME EP01: asked for 300000ms, the writer
        # delivered 92 lines, and the floors took the storyboard to 468327ms —
        # 56% over, i.e. 5.1s of finished runtime per line once the action
        # beats between them are counted. The guidance is that ratio.
        "dialogue_line_budget": max(6, round(target_ms / 5100)),
        "dialogue_line_budget_note":
            "Roughly the most spoken lines this runtime can hold at natural "
            "speaking pace. Dialogue is never compressed later — shots are "
            "GROWN to fit their recorded lines — so writing past this makes "
            "the episode longer than asked for rather than denser.",
        **({"experts_in_the_room": [EXPERTS[e][0] for e in experts if e in EXPERTS]}
           if experts else {}),
        "existing_bible": bible_txt,
        # Lore in full, not just its titles. Separate from `existing_bible`
        # because it is a different instruction: the bible list is a cast and
        # location manifest to draw FROM, this is canon the story must not
        # contradict.
        **({"project_lore": lore_txt,
            "project_lore_note": "Established canon. Do not contradict it; you may "
                                 "leave any of it unused."} if lore_txt else {}),
        **({"lyrics_timed": lyric_txt} if lyric_txt else {}),
        # A track this run is about to GENERATE has words but no timings — the
        # clock only exists once the audio does. Kept a separate key from
        # `lyrics_timed` rather than faked with zeros, because the writer is
        # told those timings are where things happen; the same distinction
        # `_attach` makes when it refuses to write untimed lines into
        # `audio_meta.lyrics`.
        **({"lyrics_untimed": untimed_lyrics,
            "lyrics_untimed_note": "The song being written for this piece. Its "
                                   "timings are not known yet — structure the "
                                   "video around the words and the sections, "
                                   "not around a clock."} if untimed_lyrics else {}),
        **({"sections": (brief.get("audio_meta") or {}).get("sections")}
           if (brief.get("audio_meta") or {}).get("sections") else {}),
        # The plan being revised, and the one instruction that outranks
        # everything else here. Order matters: the note comes AFTER the
        # outline, so the last thing the writer reads is what to change rather
        # than what already exists.
        **({"previous_version": prev_plan,
            "previous_version_note":
                "The plan you are revising. It is NOT a template to copy: you "
                "are writing a new version, free to merge, cut, re-order and "
                "re-purpose scenes. Keep what the director did not ask you to "
                "change."} if prev_plan else {}),
        **({"revision_request": revision_note,
            "revision_request_note":
                "The director's instruction for THIS revision. It outranks "
                "your own structural preferences; everything it does not "
                "touch should survive recognisably. Where it enumerates a run "
                "of distinct actions, EACH is its own beat and the scene's "
                "duration_ms must be large enough to hold them all at 2-4s "
                "each — take the seconds from scenes the note does not "
                "mention. Camera wording in the note ('a POV shot', 'past "
                "camera', 'zooms in') is not yours to act on, but keep the "
                "action it describes so the cinematographer can shoot it."}
           if revision_note else {}),
    }, ensure_ascii=False, indent=1)

    cancel = lambda: sb.cancel_requested(jid)  # noqa: E731
    # `stages` is per-stage token accounting, and it exists to answer a
    # question that was previously argued rather than measured: WHERE do a
    # plan's tokens go. It decides whether the Batch API is worth an async
    # polling path — batching only helps INDEPENDENT calls, and the only
    # independent set here is the per-character voice pass, so the answer is
    # "yes" exactly if that pass is a large share and "no" otherwise.
    # `estimated` is true when any stage fell back to a character count.
    meta = {"cost_usd": 0.0, "backend": backend, "model": "?",
            "tokens_in": 0, "tokens_out": 0, "cache_read": 0, "cache_write": 0,
            "estimated": False, "stages": {}}
    stage = ["planning"]
    progress = {"writer": 0.16, "editor": 0.30, "voice": 0.36,
                "character": 0.38, "blocking": 0.40, "cinematographer": 0.44}

    def note_fallback(frm, to, why):
        """Say it on the job: the wizard shows progress_note while it waits, and
        "claude was rate limited, continuing on openai" beats a stalled bar."""
        meta["backend"] = to
        sb.job_progress(jid, None, note=f"{frm} was {why} — {stage[0]} on {to}")

    # WHERE THE CACHE BREAKPOINT GOES. Every stage's system prompt is built as
    # a shared head plus a stage-specific tail, and `persona + craft` is the
    # longest head FOUR of them share — writer, punch-up, choreographer and
    # cinematographer, the last of which continues with the vendor format
    # reference rather than `room`. Splitting after the craft references means
    # ~3k tokens are written to the cache by the writer and read back by the
    # other three at a tenth of the rate.
    #
    # Derived by matching rather than by restructuring `stage_system`: the dict
    # is read elsewhere as a whole string (the treatment call below), and a
    # second copy of "which stages get craft" is a list that would drift from
    # the one above it.
    #
    # The five stages with no craft fall to `persona`, which is ~17 characters
    # and under CACHE_MIN_CHARS — so no breakpoint is emitted and they behave
    # exactly as they did. Nothing here is worse for them.
    cache_heads = [h for h in (persona + craft, persona) if h]

    def split_system(full):
        """(cacheable head, the rest) for a stage's system prompt."""
        for h in cache_heads:
            if full.startswith(h):
                return [h, full[len(h):]]
        return [full]

    def ask(stage_id, contract, messages, max_tokens):
        stage[0] = stage_id
        # .get with a fallback: an unknown stage id must degrade to a generic
        # persona, not KeyError inside the stage's try/except — that is how
        # the dialogue-polish pass silently never ran (its 'voice' id was
        # missing here and every run logged "skipped ('voice')").
        text, m = complete(
            split_system((stage_system.get(stage_id) or (persona + room))
                         + "\n\n# Output contract\n" + contract),
            messages, backend=backend, max_tokens=max_tokens, cancel_check=cancel,
            model=payload.get("llm_model") or DEFAULT_PIPELINE_MODEL,
            on_fallback=note_fallback, job=job)
        meta.update(model=m["model"])
        meta["cost_usd"] += m.get("cost_usd", 0)
        _tally(meta, stage_id, m)
        return text

    # ---- stage 0: the treatment (prose, the writer thinking out loud) -------
    treatment = ""
    if payload.get("two_stage", True):
        stage[0] = "treatment"
        sb.job_progress(jid, 0.08, note=f"Writer: treatment via {backend}")
        treatment, m1 = complete(
            split_system(stage_system["writer"] + "\n\n# Task\n" + treatment_hint(medium)),
            [{"role": "user", "content": brief_json}],
            backend=backend, max_tokens=4000, cancel_check=cancel,
            model=payload.get("llm_model") or DEFAULT_PIPELINE_MODEL,
            on_fallback=note_fallback, job=job)
        meta.update(model=m1["model"])
        meta["cost_usd"] += m1.get("cost_usd", 0)
        # The treatment does not go through `ask` (it has no output contract),
        # so its tokens have to be booked by hand or the plan's totals silently
        # omit the writer's first and longest call.
        _tally(meta, "treatment", m1)

    # ---- stages 1-3: writer → editor → cinematographer ----------------------
    data, shots_by_slug, editor_notes = storyplan.run_pipeline(
        brief_json=brief_json, treatment=treatment, ask=ask,
        note=lambda label: sb.job_progress(
            jid, progress.get(stage[0]), note=label),
        target_ms=target_ms,
        skip_editor=not payload.get("two_stage", True) or bool(payload.get("skip_editor")),
        # The DP needs it too — see cine_messages. The writer gets it in
        # brief_json and is forbidden camera language, so a note's shot
        # instructions die there unless they also reach this stage.
        revision_note=revision_note,
        medium=medium,
        # No score being generated means no caption to compile, so the stage
        # is a paid call whose only output nothing reads. It still runs for a
        # music video: `brief.music.generate` is false there when the user
        # brought their own track, and a score bible for a track that exists
        # is writing nobody reads either — hence the `generate` test and not
        # merely "is this a film".
        want_score=bool((brief.get("music") or {}).get("generate")),
        # Comedy gets a punch-up stage. Decided from the BRIEF rather than the
        # delivered script: the writer has to have been told it is a comedy
        # for there to be anything to sharpen.
        comedy=storyplan.is_comedy(brief))
    world = data.get("world") or {}

    sb.job_progress(jid, 0.58, note="Continuity: writing storyboard")
    # ---- bible entries -----------------------------------------------------
    #
    # Everything a plan invents starts as a DRAFT STAMPED WITH ITS SESSION, and
    # becomes canon only when the episode is queued (tier 1 does that itself,
    # below; tier 2 when the user presses "Queue episode"). The stamp is what
    # makes the draft reversible: a `bible_entries` row is shared by every
    # episode of the series — AFTERLIGHT is three episodes over 22 entries — so
    # a wizard run that came back wrong used to leave its phantom cast in the
    # bible permanently, with no way to tell its rows apart from canon. With
    # `doc.draft_session` set, "discard this draft" removes exactly what this
    # run added and nothing else, and every shared surface can leave an
    # in-flight session's guesses alone.
    #
    # Entries that already EXISTED are never stamped or restatused — a returning
    # character is canon that this plan merely referenced.
    session = str((brief.get("thread_id") or payload.get("thread_id") or "")).strip()
    name_to_id, new_entries, near_misses = {}, [], []
    prop_items = [{"name": p["name"], "summary": p.get("why"),
                   "identity_line": p.get("look"),
                   "doc_extra": {"scenes": p.get("scenes") or [],
                                 **({"reads": p["reads"]} if p.get("reads") else {})}}
                  for p in (world.get("props") or [])][:8]
    for kind, items in (("character", data["characters"]),
                        ("environment", data["environments"]),
                        ("prop", prop_items)):
        for c in items:
            hit = _find_entry(bible, kind, c["name"], identity=c.get("identity_line"))
            if hit:
                name_to_id[(kind, c["name"].lower())] = hit["id"]
                continue
            # About to write a NEW row next to names it resembles. That is the
            # right call — ambiguity is a miss — but it is also exactly how a
            # bible fills with versions of one person, so it is said out loud
            # rather than discovered later as two faces in one episode.
            close = near_duplicate_names(bible, kind, c["name"])
            if close:
                near_misses.append({"kind": kind, "name": c["name"], "near": close})
                log(f"bible: new {kind} '{c['name']}' sits beside {close} "
                    f"— too ambiguous to reuse, creating a separate entry")
            doc = {k: c.get(k) for k in ("summary", "personality", "wardrobe", "palette",
                                         "voice", "speech_pattern", "want", "role", "singer",
                                         "scale", "features", "background_life",
                                         "light_sources", "sound") if c.get(k)}
            doc.update(c.get("doc_extra") or {})
            if world.get("era"):
                doc["era"] = world["era"]
            if session:
                doc["draft_session"] = session
            row = sb.insert("bible_entries", {
                "project_id": project["id"], "kind": kind, "name": c["name"][:80],
                "summary": c.get("summary"), "doc": doc,
                "identity_line": c.get("identity_line"), "status": "draft"})
            bible.append(row)
            new_entries.append(row)
            name_to_id[(kind, c["name"].lower())] = row["id"]

    # ---- the user's own reference sheets ------------------------------------
    # Outside the `plan_refs` gate on purpose: attaching a picture the user
    # already handed over costs nothing, and it is the whole point of having
    # accepted it. The returned roles are what the sheet queue below skips.
    try:
        user_refs = attach_user_refs(
            brief.get("structured") or {}, bible, project["id"],
            # The read happens HERE rather than in a job of its own, because
            # the sheet queue below composes from the identity line and runs in
            # the same pass — a job would have to be depended on by every
            # derived sheet to be worth anything. `read_sheets=false` opts out.
            read_sheets=payload.get("read_sheets", True),
            vision_model=payload.get("vision_model"))
    except Exception as e:  # noqa: BLE001 — a bad id must not cost the plan
        log(f"user ref staging skipped: {e}")
        user_refs = {}

    # ---- ElevenLabs voice casting, before any beat is written ---------------
    # A deterministic descriptor->voice table lookup per character (costs
    # nothing, cast even without the API key). It has to happen HERE, not in
    # the tts loop below: the measured-timing pass sizes shots from each
    # line's synthesized duration, which needs every speaker's voice_id
    # before the beats are inserted.
    # WHICH ENGINE records the dialogue is decided here too, once per plan:
    # `payload.dialogue_provider` (the wizard's Dialogue voice card), else the
    # box's `DIALOGUE_PROVIDER`, else whichever engine is up. On a LOCAL engine
    # (breeze, qwen) a character's voice is DESIGNED from the writer's
    # `doc.voice` prose — one
    # synthesis per character, cached forever by (name, description) — and
    # the designed clip becomes the timbre reference every line clones from
    # and every Ref2VA block stages. A character already cast (either engine)
    # keeps their voice: recasting is `recast_voice`'s job, deliberately.
    try:
        import dialogue_synth as DS
        want = payload.get("dialogue_provider")
        provider, why = DS.resolve_provider(want)
        if why:
            log(f"dialogue provider: {why}")
        if provider:
            sb.job_progress(jid, 0.74, note=f"Casting voices on {provider}")
        el_taken = set()
        n_designed = 0
        for row in bible:
            doc = row.get("doc") or {}
            # ALREADY CAST ON ANY ENGINE IS ALREADY CAST. `_voice_of_doc`
            # answers for all of them, so a second local engine needed no
            # second key here — and a character carried over from a plan that
            # used the other one keeps their voice, which is the rule this
            # loop has always followed.
            if row.get("kind") != "character" or DS._voice_of_doc(doc):
                continue
            if provider in DS.ENG.ENGINES:
                DS.cast_local_voice(row, project["id"], engine=provider)
                n_designed += 1
                continue
            if provider != "elevenlabs":
                continue
            evid = DS.cast_voice(doc.get("voice"), el_taken,
                                 hint=row.get("identity_line") or "")
            el_taken.add(evid)
            row["doc"] = {**doc, "el_voice_id": evid, "voice_provider": "elevenlabs"}
            sb.patch(f"bible_entries?id=eq.{row['id']}", {"doc": row["doc"]})
        if n_designed:
            log(f"{provider}: designed {n_designed} character voice(s) from the "
                f"writer's descriptions")
    except Exception as e:  # noqa: BLE001 — casting is an enrichment
        log(f"voice casting skipped: {e}")

    # ---- costume: outfit variants (same face and body, new wardrobe) --------
    # A variant is its own character entry so a scene can cast it; the face
    # anchor stays the PARENT's face sheet (blocks.py follows doc.variant_of).
    variant_by_scene = {}          # (slug, parent name.lower()) -> variant id
    variant_rows = []
    for c in data["characters"]:
        parent_id = name_to_id.get(("character", c["name"].lower()))
        if not parent_id:
            continue
        for outfit in (c.get("outfits") or [])[:4]:
            if not outfit.get("name") or not outfit.get("look"):
                continue
            vname = f"{c['name']} — {outfit['name']}"[:80]
            hit = _find_entry(bible, "character", vname)
            if hit:
                vid = hit["id"]
            else:
                base_line = (c.get("identity_line") or c["name"]).rstrip(".")
                row = sb.insert("bible_entries", {
                    "project_id": project["id"], "kind": "character", "name": vname,
                    "summary": f"{c['name']} in {outfit['name']}",
                    "identity_line": f"{base_line}; now wearing {outfit['look']}",
                    "doc": {"variant_of": parent_id, "outfit": outfit["look"],
                            **({"voice": c.get("voice")} if c.get("voice") else {}),
                            **({"draft_session": session} if session else {})},
                    "status": "draft"})
                bible.append(row)
                variant_rows.append((row, parent_id, outfit))
                vid = row["id"]
            for slug in outfit.get("scenes") or []:
                variant_by_scene[(str(slug).upper(), c["name"].lower())] = vid

    # The composer's artifact rides `audio_meta`, next to the bpm and the beat
    # grid, because it is a fact about this storyboard's AUDIO and because
    # `handlers/music._attach` merges that column rather than replacing it —
    # so the score bible written here survives the track landing on it later.
    # It is not decoration: `assemble_cut` reads `score.cues` to build the
    # per-scene gain envelope it mixes the finished track under.
    score_plan = data.get("score") or {}
    story = insert_storyboard(ep_id, {
        "status": "approved" if tier == 1 else "review",
        "audio_asset_id": brief.get("audio_asset_id"),
        "audio_meta": {**(brief.get("audio_meta") or {}),
                       **({"score": score_plan} if score_plan else {})},
        "brief": {**brief, "title": data.get("title"), "tier": tier,
                  "soundscape": data.get("soundscape"), "music": data.get("music"),
                  "world": {k: v for k, v in world.items() if k != "props"},
                  **({"editor_notes": editor_notes[:8]} if editor_notes else {}),
                  # Durable, because the log scrolls away and the duplicate does
                  # not: these are the entries this plan created next to ones it
                  # could not safely reuse.
                  **({"bible_near_misses": near_misses[:12]} if near_misses else {}),
                  # What this version was asked to be, kept next to the plan
                  # itself: the version picker lists boards by title and date,
                  # and "why is v3 different from v2" is otherwise answerable
                  # only by reading both.
                  **({"revise_of": payload["revise_of"]} if payload.get("revise_of") else {}),
                  **({"revision_note": revision_note} if revision_note else {}),
                  **({"treatment": treatment[:6000]} if treatment else {})}})
    log(f"storyboard v{story.get('version')} for episode {ep_id}"
        + (f" (revision of {payload['revise_of']})" if payload.get("revise_of") else ""))

    # ---- measured dialogue timing: shots sized from the recorded lines ------
    # Every line is synthesized ONCE here (content-hash cached — the master
    # pass later stages these exact clips, so nothing is wasted) and each
    # dialogue shot's duration is floored at its lines' real lengths plus
    # handoff room, replacing the words-per-second guess that kept producing
    # DIALOGUE_CUTOFF. A speaker without a voice (or no API key) just keeps
    # the heuristic floor.
    try:
        import dialogue_synth as DS
        if DS.enabled():
            cast_rows = [r for r in bible if r.get("kind") == "character"]
            grown, pinned = 0, 0
            for s in data["scenes"]:
                shots = shots_by_slug.get(s["slug"]) or []
                changed = False
                # Runs of consecutive dialogue shots: a dense exchange is
                # synthesized as ONE conversation (text-to-dialogue) and the
                # shots are CUT TO THE RECORDING — each boundary lands in a
                # performed pause. Dialogue-first: the audio is the clock.
                runs, cur = [], []
                for sh in shots:
                    if sh.get("dialogue"):
                        cur.append(sh)
                    elif cur:
                        runs.append(cur)
                        cur = []
                if cur:
                    runs.append(cur)
                for run in runs:
                    n_lines = sum(len(sh["dialogue"]) for sh in run)
                    if n_lines > DS.MAX_AUDIO_SLOTS:
                        items = DS.plan_lines(
                            [{"dialogue": sh["dialogue"]} for sh in run], cast_rows)
                        if items:
                            try:
                                x = DS.ensure_exchange_asset(items, project["id"])
                                spans = {}
                                for it, xl in zip(items, x["lines"]):
                                    spans.setdefault(it["shot_idx"], []).append(
                                        (xl["t0_ms"], xl["t1_ms"]))
                                if any((i + 1) not in spans for i in range(len(run))):
                                    raise RuntimeError("a run shot has no alignable lines")
                                durs = DS.pin_run_durations(
                                    [spans[i + 1] for i in range(len(run))])
                                for sh, dms in zip(run, durs):
                                    # A shot may never outgrow what ONE H3 pass
                                    # can render. fit_shot_durations caps at
                                    # SHOT_MAX_MS, but this pin overrode it, and
                                    # planner._flatten then SPLIT the oversized
                                    # beat into halves that each inherited the
                                    # whole beat's lines — measured on STATIC b0
                                    # (15.1s, 19 words -> two 7.5s blocks, 13%
                                    # and 9% of the lines spoken). Clamping here
                                    # is what keeps a beat renderable; the
                                    # exchange path then either still fits or
                                    # falls back to timbre refs on its own.
                                    dms = min(int(dms), MAX_BEAT_MS)
                                    grown += dms - int(sh.get("duration_ms") or 0)
                                    sh["duration_ms"] = int(dms)
                                    sh["_xchg"] = {"asset_id": x["asset_id"]}
                                pinned += 1
                                changed = True
                                continue
                            except Exception as e:  # noqa: BLE001 — floors still hold
                                log(f"exchange pinning failed ({e}) — "
                                    f"per-line floors instead")
                    # ≤3 lines (or pinning fell through): per-shot floors from
                    # the per-line measured clips, growth only.
                    for sh in run:
                        items = DS.plan_lines([{"dialogue": sh["dialogue"]}], cast_rows)
                        if not items:
                            continue
                        durs = DS.measure_lines(items, project["id"])
                        floor = DS.shot_floor_from_measured(
                            [durs.get(it["order"]) for it in items])
                        if floor > int(sh.get("duration_ms") or 0):
                            grown += floor - int(sh.get("duration_ms") or 0)
                            sh["duration_ms"] = floor
                            changed = True
                if changed:
                    s["duration_ms"] = sum(int(x["duration_ms"]) for x in shots)
            if grown or pinned:
                log(f"measured dialogue timing: {grown:+d}ms across shots"
                    + (f", {pinned} exchange run(s) cut to the recording"
                       if pinned else ""))
                sb.job_progress(jid, 0.8,
                                note=f"Timing: cut to recorded dialogue "
                                     f"({grown / 1000:+.1f}s"
                                     + (f", {pinned} conversation(s) pinned)"
                                        if pinned else ")"))
    except Exception as e:  # noqa: BLE001 — the heuristic floors still hold
        log(f"measured timing skipped: {e}")

    scene_rows = []
    beat_rows_by_scene = {}
    for i, s in enumerate(data["scenes"]):
        env_id = name_to_id.get(("environment", (s.get("environment") or "").lower()))
        if (s.get("environment") or "").strip() and not env_id:
            # Location completeness upstream (storyplan.missing_locations)
            # should make this unreachable. If it fires anyway, the scene's
            # panels and blocks render with NO location reference — the place
            # re-invents itself shot to shot — and the silence was the bug.
            log(f"scene {s.get('slug')}: environment "
                f"'{s.get('environment')}' resolved to no bible entry — "
                f"panels will stage no location reference")
        cast_ids = []
        for cname in s["cast"]:
            cid = (variant_by_scene.get((s["slug"], cname.lower()))
                   or name_to_id.get(("character", cname.lower())))
            if cid and cid not in cast_ids:
                cast_ids.append(cid)
        shots = shots_by_slug.get(s["slug"]) or []
        scene = sb.insert("scenes", {
            "storyboard_id": story["id"], "idx": i, "slug": s["slug"],
            "duration_ms": s.get("duration_ms") or sum(sh["duration_ms"] for sh in shots),
            "environment_id": env_id, "cast_ids": cast_ids,
            "scene_prompt": s.get("purpose") or s.get("scene_prompt"),
            "meta": {k: v for k, v in (
                ("purpose", s.get("purpose")), ("conflict", s.get("conflict")),
                ("emotion_in", s.get("emotion_in")), ("emotion_out", s.get("emotion_out")),
                ("type", s.get("type")), ("time", s.get("time")),
                ("entrances", s.get("entrances")),
                ("ending", s.get("ending")), ("beats", s.get("beats")),
                ("blocking", s.get("blocking")),
                ("vfx", s.get("vfx_ref"))) if v},
            "status": "approved" if tier == 1 else "draft"})
        scene_rows.append((scene, s))
        for j, sh in enumerate(shots):
            dialogue = []
            for d in sh.get("dialogue") or []:
                sid_ = name_to_id.get(("character", (d.get("speaker") or "").lower()))
                dialogue.append({"speaker_id": sid_, "speaker": d.get("speaker"),
                                 "line": d["line"], "delivery": d.get("delivery"),
                                 # Another whitelist: the DP's V.O.-cutaway
                                 # flag dies at the row unless it is named.
                                 **({"offscreen": True} if d.get("offscreen") else {})})
            brow = sb.insert("beats", {
                "scene_id": scene["id"], "idx": j, "duration_ms": sh["duration_ms"],
                "camera": sh.get("camera"), "action": sh["action"],
                "dialogue": dialogue, "sfx": sh.get("sfx"),
                "meta": {"cast": sh.get("cast") or [],
                         **({"positions": sh["positions"]} if sh.get("positions") else {}),
                         **({"xchg": sh["_xchg"]} if sh.get("_xchg") else {}),
                         # This meta is a whitelist, so a flag set on the SHOT
                         # vanishes here unless it is named. `breath` marks the
                         # wordless hold added before a location cut — the shot
                         # renders either way, but nothing downstream can tell
                         # a deliberate pause from a beat that lost its lines.
                         **({"breath": True}
                            if (sh.get("meta") or {}).get("breath") else {}),
                         "beat": {"idx": sh.get("beat_idx", 0),
                                  "label": sh.get("beat_label")}}})
            beat_rows_by_scene.setdefault(scene["id"], []).append((brow, sh))

    # WHERE THE TOKENS WENT, on the job's own log. The per-stage split is not
    # derivable afterwards from anything stored, and it is the input to every
    # decision about what to cache, what to batch and which model each stage
    # deserves. One line per plan.
    if meta.get("stages"):
        parts = ", ".join(
            f"{k} {v['in'] // 1000}k/{v['out'] // 1000}k"
            + (f" ({v['cached'] // 1000}k cached)" if v["cached"] else "")
            + (f" x{v['calls']}" if v["calls"] > 1 else "")
            for k, v in sorted(meta["stages"].items(),
                               key=lambda kv: -kv[1]["cost"]))
        log(f"plan tokens: {meta['tokens_in']:,} in "
            f"({meta['cache_read']:,} cached, {meta['cache_write']:,} written) / "
            f"{meta['tokens_out']:,} out"
            f"{' [ESTIMATED]' if meta['estimated'] else ''} — {parts}")

    if meta.get("cost_usd"):
        cached_note = (f", {meta['cache_read']:,} cached"
                       if meta.get("cache_read") else "")
        sb.record_cost(job, meta["cost_usd"], "llm", provider=meta["backend"],
                       quantity=meta.get("tokens_out"), unit="tokens",
                       # `estimate` was hardcoded False, which claimed every
                       # figure here was measured — and until the usage block
                       # above, NONE of them were on the openai path.
                       estimate=bool(meta.get("estimated")),
                       note=f"plan_storyboard {meta['model']} — "
                            f"{meta['tokens_in']:,} in{cached_note} / "
                            f"{meta['tokens_out']:,} out")

    # ---- references (both tiers) then, for one-shot only, the launch --------
    #
    # This whole block used to be gated on `auto_launch or tier == 1`, so tier
    # 2 — the wizard's DEFAULT "review first" mode — planned the episode and
    # generated nothing: no sheets, no panels, no voices. You reviewed a
    # storyboard of prose and approved it blind, which is the weakest possible
    # version of a review step now that the panels ARE the storyboard.
    #
    # The gate belongs on spending the EXPENSIVE thing (the render), not on
    # the cheap thing you are reviewing: tier 1's sheets+panels measured under
    # a dollar against ~$20 for the episode. So references are generated for
    # both tiers and only `launch_render` stays behind the one-shot check.
    # `payload.plan_refs=false` opts out for a caller that really wants a
    # text-only plan.
    ref_jobs = []
    if payload.get("plan_refs", True):
        prio = int(payload.get("priority") or 50)
        style = project.get("style") or "anime"

        # WHICH OF THE THREE THIS PLAN DRAWS FOR YOU, and why they are not
        # three independent switches.
        #
        # `plan_refs` is the outer gate and has always been all-or-nothing:
        # sheets, panels and voice references were queued together the moment
        # a plan finished. That is the right default for someone who wants an
        # episode out of one prompt and the wrong one for someone who wants to
        # READ the storyboard before anything is spent — and a one-shot with a
        # bad model pick spends it all before the first sheet has been looked
        # at. `ref_sheets` splits the cheapest-to-decide thing out of that
        # bundle so the wizard can offer them one at a time.
        #
        # PANELS DEPEND ON SHEETS, which is why this is a ladder rather than a
        # row of independent toggles: a panel is composed OVER the cast's face
        # plates and the location's master, and one drawn with no anchors is
        # the invented-faces failure `scene_panels` was given anchors to end.
        # So sheets off forces panels off, here as well as in the browser —
        # the UI disables the combination and a hand-written payload gets the
        # same answer with a line saying so.
        #
        # Voices are genuinely independent: a timbre clip is synthesized from
        # the writer's own prose and anchors nothing visual.
        want_sheets = bool(payload.get("ref_sheets", True))
        want_panels = bool(payload.get("scene_panels", True))
        if want_panels and not want_sheets:
            log("plan: panels need the reference sheets they are composed over "
                "— skipping them too")
            want_panels = False
        sb.job_progress(jid, 0.85, note="Production: queueing "
                        + (", ".join(w for w, on in (("sheets", want_sheets),
                                                     ("panels", want_panels),
                                                     ("voices", brief.get("voice_refs", True)))
                                     if on) or "nothing"))

        def sheet_job(entry, role, *, deps=None, extra=None, spec_extra=None,
                      size=(1024, 1024)):
            # NOT DRAWN means no row, and None rather than a dangling id: every
            # dep list here is built with `[j for j in (...) if j]` and every
            # `*_job_by_entry` map is read the same way, so an un-queued sheet
            # simply leaves its dependents with nothing to wait for — which is
            # exactly what the late-bound `{entry_id, roles}` anchors already
            # do for a role the USER filled.
            if not want_sheets:
                return None
            # spec_extra goes into prompt_spec, NOT the payload: the prompt is
            # re-composed on the pod from prompt_spec (that is where the image
            # family is finally known), so anything that changes the wording
            # has to travel in the spec or it is silently dropped.
            spec = {**_sheet_spec(entry, style), "role": role,
                    **(spec_extra or {}),
                    **({"world": {k: world[k] for k in ("era", "palette", "style_notes")
                                  if world.get(k)}} if world else {})}
            # A location's physicality rides its sheets: scale, anchor features
            # and its own light are what make four angles read as ONE place.
            # (background_life stays out — people in a reference plate leak
            # into scenes as those exact people.)
            if entry["kind"] == "environment":
                d = entry.get("doc") or {}
                bits = [d.get("scale"),
                        ", ".join(d.get("features") or []) or None,
                        d.get("light_sources")]
                env_note = "; ".join(str(b) for b in bits if b)
                if env_note:
                    spec["note"] = env_note[:220]
            # A DERIVED location plate never renders on H3, whatever the
            # wizard picked. The plate's whole job is a NEW camera on the same
            # place, and the move imperative that produces one
            # (ENVIRONMENT_MOVE) was measured on the Krea 2 reference path —
            # on H3's, the anchored master wins over the sentence ("H3 obeys a
            # picture") and all four plates come back as near-copies of one
            # frontal view, which quietly re-installs the one-camera lock the
            # rotation exists to break. Measured on Rei E4's Portal Clearing:
            # master/alt/detail/atmosphere rendered on h3-image-turbo were
            # four crops of the same vantage. Masters stay on the wizard's
            # model (t2i — nothing to copy); the derived plates inherit the
            # master's look through the anchor, which is what keeps one
            # bible's plates one look even across two render families.
            #
            # It is a redirect off H3 SPECIFICALLY, not a hard pin to Krea 2.
            # Applied to every family it silently discards the wizard's choice
            # for three of a location's four plates and splits one bible's
            # plates across two render families — the internal inconsistency
            # the reference encoder then resolves in favour of whatever holds
            # image1. SenseNova is the case that forced the distinction: it was
            # measured doing the exact move H3 cannot (a genuine three-quarter
            # reverse revealing the kerb and the neighbouring frontage, same
            # shop), so redirecting it would be a downgrade sold as a guard.
            # Any future family gets the same treatment — name it here only
            # once it has been measured collapsing onto its anchor.
            derived_plate = (entry["kind"] == "environment"
                             and role in ("alt_angle", "detail", "atmosphere")
                             and bool(spec.get("from_ref"))
                             and str(payload.get("image_model") or "")
                             .startswith("h3-image"))
            j2 = sb.insert("jobs", {
                "kind": "image_gen", "status": "queued", "lane": job_lane(payload, "image_gen"),
                "priority": prio, "project_id": project["id"], "episode_id": ep_id,
                **({"depends_on": deps} if deps else {}),
                "payload": {"prompt": image_prompt.compose(spec),
                            "prompt_spec": spec,
                            "label": f"{entry['name'].split(' — ')[0][:28]} · {role} sheet",
                            "width": size[0], "height": size[1],
                            "target": {"bible_entry_id": entry["id"], "role": role, "slot": 0},
                            "auto_accept": True,
                            "model_key": ("krea2" if derived_plate
                                          else payload.get("image_model")),
                            **(extra or {})}})
            ref_jobs.append(j2["id"])
            return j2["id"]

        # Characters: a tight face plate (the identity anchor every later ref
        # derives from) plus the full-body turnaround — rendered AS AN
        # IDENTITY-PRESERVING COMPOSITION over that face plate. A body sheet
        # composed from prose alone gets a face that merely resembles the
        # anchor, and every downstream ref inherits the disagreement.
        # Deliberately NO identity LoRA here: on a fresh composition it
        # transfers "the person as photographed" and NORMALIZES the wardrobe —
        # armor, rigs and prosthetics were erased at 1.0 AND at 0.9 (measured,
        # NEONFALL tier 1: the lead's armored kit collapsed to a plain jacket
        # twice), while the face-ref conditioning alone held identity with the
        # prompt keeping its authority over hardware. The LoRA's place is the
        # outfit-variant EDIT below, where low denoise preserves the parent's
        # pixels and the LoRA protects the face THROUGH the edit.
        # Locations: the master, then three more angles of the SAME place,
        # each anchored on the master — an unanchored "reverse angle" is a
        # different room wearing the same name.
        # A role the USER filled is not drawn. The dependents are unaffected:
        # their anchors are late-bound `{entry_id, roles}`, resolved when the
        # job runs, so a body sheet anchored on "face" finds the user's picture
        # exactly as it would have found a generated plate — it simply has
        # nothing to wait for. `deps` therefore drops to None rather than
        # naming a job that was never queued.
        face_job_by_entry = {}
        master_job_by_entry = {}
        for row in new_entries:
            mine = user_refs.get(row["id"]) or set()
            if row["kind"] == "character":
                # A face plate derived from a sheet the user GAVE us is a
                # reframe, not an invention: the design exists, and the job is
                # to look at it from the front and crop in. Without an anchor
                # the face job had none of that — a user who attached a
                # turnaround got their design filed and a portrait invented from
                # prose beside it.
                #
                # It renders on H3, and that is MEASURED, not assumed. Three
                # characters, same anchors, same prompt, three configurations:
                # krea2 ignored the `face` framing outright and returned a FULL
                # BODY every time — with and without the identity LoRA — because
                # its reference path follows the reference's framing over the
                # role's instruction. h3-image-turbo returned an actual head-and-
                # shoulders plate for all three, holding the hair, the streak and
                # the eyes. It costs ~50s against krea2's ~12s, which is the
                # right trade for the one picture every other sheet derives from.
                #
                # The identity LoRA is NOT used, and the same test is why: it was
                # tried here on the theory that a face crop has no wardrobe to
                # normalize, so the NEONFALL measurement that keeps it off base
                # sheets would not apply. The renders disagreed — Guide Rei came
                # back with a duplicated torso, a floating jacket and half-teal
                # hair, while the identical job without it was clean. The theory
                # was wrong because the crop never happened: on a composition
                # this adapter damages the picture whatever is in frame.
                derive_from = [r for r in ("turnaround", "full_body", "side") if r in mine]
                if "face" in mine:
                    face_j = None
                elif derive_from:
                    face_j = sheet_job(row, "face",
                                       extra={"anchor_entry_id": row["id"],
                                              "anchor_roles": derive_from,
                                              "model_key": "h3-image-turbo"})
                else:
                    face_j = sheet_job(row, "face")
                face_job_by_entry[row["id"]] = face_j
                body_j = None if "full_body" in mine else sheet_job(
                    row, "full_body",
                    deps=[face_j] if face_j else None,
                    extra={"anchor_entry_id": row["id"], "anchor_roles": ["face"]})
                # The turnaround grid: six views rendered TOGETHER, anchored
                # on the face plate and the body sheet, so the views agree
                # with each other and with the anchors. It replaces full_body
                # as the second staged identity slot (blocks.py picks) — same
                # slot cost, four more angles of signal.
                if payload.get("turnarounds", True) and "turnaround" not in mine:
                    sheet_job(row, "turnaround",
                              deps=[j for j in (face_j, body_j) if j] or None,
                              size=(1536, 1280),
                              extra={"anchor_entry_id": row["id"],
                                     "anchor_roles": ["face", "full_body"]})
            elif row["kind"] == "environment":
                mj = None if "master" in mine else sheet_job(row, "master", size=(1280, 704))
                master_job_by_entry[row["id"]] = mj
                for angle in ("alt_angle", "detail", "atmosphere"):
                    if angle in mine:
                        continue
                    # `from_ref` swaps the descriptive framing for an
                    # instruction to MOVE the camera — see ENVIRONMENT_MOVE in
                    # image_prompt. It only applies because these plates are
                    # anchored on the master; an unanchored one has nothing to
                    # move away from.
                    sheet_job(row, angle, deps=[mj] if mj else None, size=(1280, 704),
                              spec_extra={"from_ref": True},
                              extra={"anchor_entry_id": row["id"],
                                     "anchor_roles": ["master"]})
            elif row["kind"] == "prop":
                if "ref" not in mine:
                    sheet_job(row, "ref", **_prop_sheet_extra(row, data, name_to_id,
                                                              master_job_by_entry))

        # Returning cast (a later episode in the same project) already has
        # face/body sheets and skips the loop above — but a character from
        # before the turnaround slot existed still deserves one. Backfill:
        # anchors resolve to the sheets already on file, so these need no dep.
        if payload.get("turnarounds", True):
            for c in data.get("characters") or []:
                cid = name_to_id.get(("character", (c.get("name") or "").lower()))
                if not cid or cid in face_job_by_entry:
                    continue
                if sb.get(f"bible_assets?entry_id=eq.{cid}&role=eq.turnaround"
                          f"&limit=1&select=asset_id"):
                    continue
                rows_ = sb.get(f"bible_entries?id=eq.{cid}&select=*")
                if rows_ and rows_[0]["kind"] == "character" \
                        and not (rows_[0].get("doc") or {}).get("variant_of"):
                    sheet_job(rows_[0], "turnaround", size=(1536, 1280),
                              extra={"anchor_entry_id": cid,
                                     "anchor_roles": ["face", "full_body"]})

        # Returning locations: draw the plates they are missing (see
        # backfill_env_plates). Filing the chain's last job under the entry id
        # is what makes the panels below wait for the full plate set — the
        # panel dep-wiring reads master_job_by_entry per anchor entry.
        backfilled = backfill_env_plates(
            data.get("environments"), name_to_id=name_to_id,
            skip_ids=set(master_job_by_entry),
            have_roles=lambda eid: {r["role"] for r in sb.get(
                f"bible_assets?entry_id=eq.{eid}&slot=lt.90&select=role")},
            fetch_entry=lambda eid: (sb.get(f"bible_entries?id=eq.{eid}"
                                            f"&select=*") or [None])[0],
            sheet_job=sheet_job)
        for _eid, _pj in backfilled.items():
            master_job_by_entry[_eid] = _pj
        if backfilled:
            log(f"env plates: backfilled {len(backfilled)} returning "
                f"location(s)")

        # Outfit variants render as an identity-preserving EDIT of the parent's
        # full body sheet (Krea 2 Identity Edit LoRA when installed; the key is
        # dropped harmlessly when not), anchored late to the parent's face.
        # Recorded per VARIANT id so the panels below can wait on it: a scene
        # that casts the variant anchors panels on the VARIANT's entry, and
        # until this map existed those panels dep'd on nothing of the
        # variant's — a panel could render before the variant's only sheet
        # did, resolve no picture, and draw the character from prose (the
        # _resolve_anchor parent fallback now softens that race; the dep
        # removes it).
        variant_job_by_entry = {}
        for row, parent_id, outfit in variant_rows:
            face_dep = face_job_by_entry.get(parent_id)
            variant_job_by_entry[row["id"]] = sheet_job(
                row, "full_body",
                deps=[face_dep] if face_dep else None,
                extra={"mode": "edit", "denoise": 0.75,
                       "anchor_entry_id": parent_id,
                       "anchor_roles": ["full_body", "face"],
                       "loras": [{"key": "identity", "strength": 1.0}],
                       "prompt": f"Change only the clothing: now wearing "
                                 f"{outfit['look']}. Keep the face, hair, build "
                                 f"and pose identical."})

        # Storyboard panels: ONE RENDER PER BEAT, anchored on the cast's face
        # sheets and the location's master (anchors resolve late, after the
        # dep'd sheet jobs land) — which is what makes a panel safe where the
        # prose-only scene stills invented faces and got demoted to display.
        #
        # This replaced a per-SCENE grid that got sliced into panels. The grid
        # was the more elegant idea — panels rendered together share grade and
        # staging by construction — and it did not work: measured across E2's
        # ten grids, NINE came back malformed, because qwen-edit is an EDIT
        # model and reproduces its references rather than composing a layout
        # (THE-BOOK returned the location sheet beside one wide scene). 2511
        # behaved identically, so it was never a model-version problem. One
        # render per beat gives up the shared-grade guarantee and buys a panel
        # that is actually the shot; the grade is held instead by every panel
        # carrying the same style clause, world palette and time of day.
        if want_panels:
            d = payload.get("dims") or {}
            pw = int(d.get("width") or d.get("w") or 1280)
            ph = int(d.get("height") or d.get("h") or 704)
            n_panels = 0
            # WHERE THE PLATE RING PICKS UP, PER LOCATION, ACROSS SCENES.
            #
            # It restarted at 0 every scene, which is right when consecutive
            # scenes are in different places and wrong for a BOTTLE EPISODE:
            # twelve scenes in one room then open on twelve master plates,
            # i.e. the one-camera lock this rotation exists to break, back at
            # the scene layer. Keyed by ENVIRONMENT so a genuine new location
            # still establishes itself on its master.
            #
            # STAMPED onto the scene, not recomputed by each consumer: the
            # browser redraws ONE scene and cannot count the scenes before it,
            # and two twins that disagree about which plate a panel staged is
            # worse than a re-establish. Same reasoning as `params.fight`.
            plate_turn_by_env = {}
            for scene, s in scene_rows:
                brs = beat_rows_by_scene.get(scene["id"]) or []
                if not brs:
                    continue
                cast_rows = (sb.get(f"bible_entries?id=in.({','.join(scene['cast_ids'])})"
                                    f"&select=id,name,identity_line,doc")
                             if scene.get("cast_ids") else [])
                env_rows = (sb.get(f"bible_entries?id=eq.{scene['environment_id']}"
                                   f"&select=id,name,identity_line")
                            if scene.get("environment_id") else [])
                env_row = env_rows[0] if env_rows else None
                env_key = scene.get("environment_id") or "-"
                start_turn = plate_turn_by_env.get(env_key, 0)
                built = scene_panel_specs(
                    [sh for _, sh in brs], cast_rows, env_row, style=style,
                    world=world, time_of_day=s.get("time"),
                    cast_cap=image_prompt.panel_cast_cap(payload.get("image_model")),
                    wide_faces=image_prompt.wide_face_cap(payload.get("image_model")),
                    plate_turn=start_turn)
                # Advance by the shots that actually ROTATED, which is what
                # `plate_plan` counts — advancing by beat count instead puts
                # the next scene at an arbitrary point in the ring and the
                # stamped number stops describing what was staged.
                _plates = image_prompt.plate_plan(
                    [sh.get("camera") or "" for _, sh in brs],
                    start_turn=start_turn)
                plate_turn_by_env[env_key] = start_turn + sum(
                    1 for r in _plates if r and r[0] in image_prompt.PLATE_RING)
                try:
                    _sm = dict(s.get("meta") or {})
                    _sm["plate_turn"] = start_turn
                    sb.patch(f"scenes?id=eq.{scene['id']}", {"meta": _sm})
                except Exception as e:      # noqa: BLE001 — advisory
                    log(f"scene {scene['id']}: plate_turn not stamped ({e})")
                for (brow, sh), (anchors, pspec) in zip(brs, built):
                    # A breath beat draws no panel of its own — it is a held
                    # pause on the staging just seen, and a panel composed
                    # from its contentless filler action renders the staged
                    # sheets back (ASTRONAUT_CAPTURE b7 came back as a grey
                    # character sheet). The skip lives HERE, not in
                    # scene_panel_specs, so the specs stay 1:1 with the
                    # scene's beats and the plate-rotation turn counter keeps
                    # agreeing with the browser twin.
                    if (sh.get("meta") or {}).get("breath"):
                        continue
                    # Wait only for the sheets this panel actually stages: a
                    # face dropped by the wide-shot ordering must not hold the
                    # job behind a render it no longer uses.
                    sheet_job_for = {**face_job_by_entry, **master_job_by_entry,
                                     **variant_job_by_entry}
                    deps = [j for j in (sheet_job_for.get(a["entry_id"]) for a in anchors) if j]
                    jp = sb.insert("jobs", {
                        "kind": "image_gen", "status": "queued", "lane": job_lane(payload, "image_gen"),
                        "priority": prio, "project_id": project["id"],
                        "episode_id": ep_id,
                        **({"depends_on": deps} if deps else {}),
                        # A panel renders on the SAME model as the sheets it is
                        # anchored to. The grid deliberately omitted model_key
                        # so the reference routing would land on qwen-edit —
                        # the instruction-following family a multi-panel layout
                        # contract needs — and that reasoning died with the
                        # grid. A panel is one frame; there is no layout to
                        # follow, and the show's look lives in the model the
                        # bible was drawn with. Measured: identical scene, same
                        # prompt, krea2 sheets read as the show while qwen-edit
                        # panels read muddy and lost faces. Krea 2 takes the
                        # references natively (Krea2EditRebalance, 4 max — a
                        # panel stages at most 3).
                        "payload": {"prompt": image_prompt.compose(pspec),
                                    "model_key": payload.get("image_model"),
                                    "prompt_spec": pspec,
                                    "label": f"{(s.get('slug') or 'scene')[:18]} "
                                             f"b{brow['idx'] + 1} · panel",
                                    "width": pw, "height": ph,
                                    "anchors": anchors,
                                    "auto_accept": True,
                                    "target": {"beat_id": brow["id"],
                                               "as": "panel"}}})
                    ref_jobs.append(jp["id"])
                    n_panels += 1
            if n_panels:
                log(f"storyboard: {n_panels} per-beat panel job(s) queued")

        # Voice references: one short line per speaking character, synthesized
        # to a stable preset voice and pinned on the entry. Ref2VA then hears
        # the same timbre in every block (<Audio N> voice-timbre reference).
        # RETURNING and RECAST cast are covered, not just new entries. This
        # loop used to read `new_entries`, so a character carried over from a
        # previous episode never got a timbre clip and a `recast_voice` — which
        # nulls `voice_ref_asset_id` on purpose, so the clip is re-made in the
        # new voice — was never acted on by anything.
        if brief.get("voice_refs", True) and medium != "music_video":
            new_ids = {r["id"] for r in new_entries}
            need, have = speakers_needing_voice_refs(
                data, name_to_id=name_to_id, new_ids=new_ids,
                fetch_entry=lambda eid: (sb.get(
                    f"bible_entries?id=eq.{eid}"
                    f"&select=id,name,doc,voice_ref_asset_id") or [None])[0])
            # `taken` keeps two characters off one preset voice WITHIN an
            # episode, so it is seeded from the clips that already exist —
            # otherwise a returning lead and a new supporting character get
            # handed the same voice, which is the collision the picker is for.
            # The voice lives on the ASSET's meta (handlers/tts writes it
            # there); the entry records only which clip is the anchor.
            taken = set()
            if have:
                ids = ",".join(have[:40])
                for a in sb.get(f"assets?id=in.({ids})&select=meta") or []:
                    v = ((a or {}).get("meta") or {}).get("voice")
                    if v:
                        taken.add(v)
            n_back = 0
            for row, char, line in need:
                voice = pick_tts_voice(char.get("voice"), taken)
                taken.add(voice)
                jv = sb.insert("jobs", {
                    "kind": "tts", "status": "queued", "lane": job_lane(payload, "tts"),
                    "priority": prio, "project_id": project["id"], "episode_id": ep_id,
                    "payload": {"text": (line or
                                         f"This is how {row['name']} sounds "
                                         f"when they speak.")[:220],
                                "voice": voice,
                                "label": f"voice ref · {row['name'].split(' — ')[0][:28]}",
                                "emotion": (char.get("voice") or "")[:80] or None,
                                # WHICH KEY THE DESKTOP MAY SPEND ON THIS JOB.
                                # A plan running here claims its own children,
                                # and Rust forwards a secret only for a
                                # provider the payload NAMES — so a voice ref
                                # queued without this reaches `handle_tts`
                                # with an empty environment and fails for a
                                # key the machine has. Carried from the plan's
                                # own list rather than invented: it is what
                                # the wizard already decided this run may
                                # spend. Absent (the pod) the key is the box's
                                # own env and this is inert.
                                **({"byok_providers": payload["byok_providers"]}
                                   if payload.get("byok_providers") else {}),
                                "bible_entry_id": row["id"]}})
                ref_jobs.append(jv["id"])
                if row["id"] not in new_ids:
                    n_back += 1
            if need:
                log(f"voice refs: {len(need)} queued"
                    + (f" ({n_back} for returning or recast cast)" if n_back else ""))
        elif medium != "music_video":
            # SAID, because the alternative is a cast with no voices and
            # nothing anywhere explaining it — and on Breeze the clips exist
            # anyway (casting designs them), so silence here would read as the
            # switch having done nothing.
            log("voice refs: not queued — record them from the wizard's "
                "cast & world step, or a character's own sheet")

        # The VFX expert's frames: one designed still per flagged scene,
        # auto-accepted as the scene still -> staged into that block's prompt
        # as an official storyboard-reference picture.
        for scene, s in scene_rows:
            if not s.get("vfx_ref"):
                continue
            spec = {"kind": "scene", "role": "still",
                    "identity": s["vfx_ref"]["prompt"], "style": style,
                    **({"world": {k: world[k]
                                  for k in ("era", "palette", "vfx_language")
                                  if world.get(k)}} if world else {})}
            j3 = sb.insert("jobs", {
                "kind": "image_gen", "status": "queued", "lane": job_lane(payload, "image_gen"),
                "priority": prio, "project_id": project["id"], "episode_id": ep_id,
                "payload": {"prompt": image_prompt.compose(spec),
                            "prompt_spec": spec,
                            "width": 1280, "height": 704,
                            "target": {"scene_id": scene["id"]},
                            "auto_accept": True,
                            "model_key": payload.get("image_model")}})
            ref_jobs.append(j3["id"])

        # ---- the score / master track -------------------------------------
        #
        # A reference like any other, and queued into `ref_jobs` for one
        # specific reason: `launch_render` depends on that list, and the music
        # video pipeline reads `storyboards.audio_asset_id` AT LAUNCH to decide
        # whether blocks are locked to the track and cut to its beats. Queue
        # the track outside the dependency and the blocks get planned against
        # silence, then the track arrives and is decoratively attached to an
        # episode that was never timed to it.
        #
        # It runs in the background either way — the storyboard page shows it
        # arriving, and on tier 2 nothing waits for it at all.
        music = brief.get("music") or {}
        if music.get("generate"):
            # The WRITER's own `music` field is the default prompt: it is a
            # score description for this episode, written by the same pass that
            # wrote the scenes, so "generate a track" needs no separate brief
            # from the user and still gets a bespoke one.
            m_key = music.get("model_key") or "minimax-music3"
            m_ace = m_key.startswith("acestep")
            # PRECEDENCE, and the order is the whole point: a prompt the USER
            # typed always wins; otherwise the COMPOSER's compiled caption;
            # and only then the writer's one-line `music` field, which is what
            # every score before this stage existed was built from — a mood
            # where the model's own guide asks for genre, tempo, key, arc,
            # production profile and named instruments.
            m_score = score_prompt.compile_prompt(
                score_plan, family=("acestep" if m_ace else "music3"),
                title=data.get("title"), style=project.get("style"),
                instrumental=not (music.get("lyrics") or "").strip()
                ) if score_plan else ""
            m_prompt = (music.get("prompt") or m_score
                        or (data.get("music") if isinstance(data.get("music"), str) else None)
                        or f"original score for {data.get('title') or 'this episode'}")
            # ACE-Step's tempo/key/time signature are TYPED node inputs, so the
            # composer's choices reach the encoder as controls rather than as
            # words in the tag list. Music 3 declares none of them and the keys
            # are dropped for it below, exactly as they always were.
            m_typed = score_prompt.typed_meta(score_plan) if (m_ace and score_plan) else {}
            m_lyrics = (music.get("lyrics") or "").strip()
            jm = sb.insert("jobs", {
                "kind": "music_gen", "status": "queued", "lane": job_lane(payload, "music_gen"),
                "priority": prio, "project_id": project["id"], "episode_id": ep_id,
                "model_id": f"{m_key}-local",
                "payload": {k: v for k, v in {
                    "prompt": m_prompt,
                    "lyrics": m_lyrics or None,
                    "instrumental": bool(music.get("instrumental")) or not m_lyrics,
                    # The episode's own length, so a music video's track spans
                    # it. The handler clamps to the model's ceiling.
                    "duration_ms": int(music.get("duration_ms") or target_ms),
                    "model_key": m_key,
                    "bpm": (music.get("bpm") or m_typed.get("bpm")) if m_ace else None,
                    "key_scale": (music.get("key_scale")
                                  or m_typed.get("key_scale")) if m_ace else None,
                    "time_signature": (music.get("time_signature")
                                       or m_typed.get("time_signature")) if m_ace else None,
                    "seed": music.get("seed"),
                    # This is what makes it the episode's track rather than a
                    # file in the library.
                    "target": {"storyboard_id": story["id"]},
                    "project_id": project["id"],
                    "label": f"score · {str(m_prompt)[:44]}",
                }.items() if v is not None}})
            ref_jobs.append(jm["id"])
            log(f"tier {tier}: score queued on {m_key} "
                f"({'instrumental' if not m_lyrics else 'with lyrics'}, "
                f"{int(music.get('duration_ms') or target_ms) / 1000:.0f}s, "
                f"{'composer caption' if (m_score and not music.get('prompt')) else 'brief prompt'}) "
                f"-> storyboard {story['id']}")

        # ONE-SHOT ONLY. Tier 2 stops here with its references drawn and waits
        # for a human to approve the storyboard (the wizard's "Queue the
        # episode" enqueues this same job).
        if payload.get("auto_launch") or tier == 1:
            # One rule, both tiers: entries become canon when the EPISODE is
            # queued. Tier 2 does it from the wizard's "Queue episode"; tier 1
            # queues the render itself, so it commits here. Confirming means
            # dropping the stamp as well as flipping the status — a row that
            # still carries `draft_session` is one a discard would delete.
            confirm_draft_entries(project["id"], session)
            launch = sb.insert("jobs", {
                "kind": "launch_render", "status": "queued", "lane": job_lane(payload, "launch_render"),
                "priority": prio,
                "project_id": project["id"], "episode_id": ep_id,
                "depends_on": ref_jobs,
                "payload": {"storyboard_id": story["id"],
                            "dims": payload.get("dims") or {},
                            "model_id": payload.get("video_model") or "h3-local",
                            "params": payload.get("params") or {},
                            # Segment storyboards are composed per BLOCK, and
                            # blocks exist only once launch_render has planned
                            # them — so the flag rides to it (handlers.blocks
                            # queues one sheet_compose per block).
                            **({"block_sheets": True} if payload.get("block_sheets") else {}),
                            "priority": payload.get("priority")}})
            log(f"one-shot DAG: {len(ref_jobs)} sheet/voice/panel job(s) "
                f"-> launch {launch['id']}")
        else:
            log(f"tier {tier}: {len(ref_jobs)} sheet/voice/panel job(s) queued "
                f"— storyboard awaits approval before launch")

    n_shots = sum(len(v) for v in shots_by_slug.values())
    sb.job_patch(jid, {"payload": {**payload, "result": {
        "storyboard_id": story["id"], "scenes": len(data["scenes"]),
        "shots": n_shots, "editor_notes": len(editor_notes),
        "new_entries": [e["id"] for e in new_entries], "ref_jobs": ref_jobs}}})
    sb.job_done(jid)
    log(f"JOB DONE plan_storyboard -> storyboard {story['id']} "
        f"({len(data['scenes'])} scenes, {n_shots} shots, tier {tier}, {meta['backend']})")


# ------------------------------------------------------------ extract_lore ---
# One window's worth of document per call. A world bible does not fit in one
# context, and pretending it does gets the front of it read and the rest
# ignored — with a clean-looking result either way, which is the failure mode
# worth spending a loop to avoid.
EXTRACT_WINDOW_CHARS = 20000
EXTRACT_MAX_WINDOWS = 12
EXTRACT_MAX_ENTRIES = 40

EXTRACT_CONTRACT = """Return ONLY JSON:
{"entries": [{"name": "...", "summary": "...", "body": "..."}]}

You are reading a source document for a screen project and pulling out the
things a writer would need to hold in mind while writing ANY scene in this
world.

- name: what it is called, as the document calls it. 2-5 words.
- summary: ONE sentence, and the most important field you write. It is shown
  to the planner for every scene in the project, so it must carry the
  CONSEQUENCE, not the label. "Nobody speaks the old names aloud since the
  Concordat" is usable; "a treaty that ended the war" is not.
- body: the document's own words on this subject, gathered and lightly tidied.
  Quote and condense; do not invent, extrapolate or embellish. If the document
  does not say it, it does not go in.

Pull out rules, factions, institutions, history, places-as-concepts, customs,
technology and terminology. Do NOT pull out individual characters or physical
locations — those are separate kinds of bible entry with their own reference
art, and creating them here would make a second, picture-less copy of someone
who already exists.

Prefer few and load-bearing over many and trivial: something the story would
break without. If a window of text contains nothing of that weight, return
{"entries": []} — an empty answer is a valid and useful one."""


def extract_lore(job):
    """Read a lore DOCUMENT and propose bible lore entries from it.

    Documents and entries answer the same question at different distances: a
    document is retrieved only when a scene happens to be about it, an entry is
    in front of the planner for every scene. So the point of this pass is
    promotion — deciding which few things in a 60-page bible are load-bearing
    enough to be present always.

    Entries arrive as DRAFTS whatever the tier, unlike the planner's own tier-1
    entries. A 60-page import can propose dozens, and the whole reason a human
    is asked to confirm bible changes is that nobody reads what arrives already
    confirmed.
    """
    jid = job["id"]
    payload = job.get("payload") or {}
    doc_id = payload["document_id"]
    docs = sb.get(f"rag_documents?id=eq.{doc_id}&select=id,project_id,kind,title,episode_id")
    if not docs:
        raise LLMError(f"lore document {doc_id} not found")
    doc = docs[0]
    project_id = payload.get("project_id") or doc.get("project_id")
    if not project_id:
        raise LLMError("lore document has no project")
    backend = pick_backend(job, payload)

    chunks = sb.get(f"rag_chunks?document_id=eq.{doc_id}&select=idx,content&order=idx")
    if not chunks:
        raise LLMError(f"lore document '{doc['title']}' has no text")

    # Pack chunks into windows on their own boundaries — chunks are already
    # paragraph-aligned, so this never cuts mid-sentence.
    windows, cur = [], []
    for c in chunks:
        if cur and sum(len(x) for x in cur) + len(c["content"]) > EXTRACT_WINDOW_CHARS:
            windows.append("\n\n".join(cur))
            cur = []
        cur.append(c["content"])
    if cur:
        windows.append("\n\n".join(cur))
    if len(windows) > EXTRACT_MAX_WINDOWS:
        log(f"extract_lore: '{doc['title']}' is {len(windows)} windows — reading the "
            f"first {EXTRACT_MAX_WINDOWS}. The rest stays retrievable; re-run on a "
            f"split document to cover it.")
        windows = windows[:EXTRACT_MAX_WINDOWS]

    # Existing names, so a second run over the same document proposes what is
    # missing instead of a duplicate set. Matched case-insensitively on name —
    # two bible entries for one concept is two versions of the canon.
    existing = {(e.get("name") or "").strip().lower()
                for e in sb.get(f"bible_entries?project_id=eq.{project_id}"
                                f"&select=name") or []}

    found, cost, seen = [], 0.0, set()
    for i, window in enumerate(windows):
        sb.job_progress(jid, 0.1 + 0.8 * i / len(windows),
                        note=f"reading {doc['title']} ({i + 1}/{len(windows)})")
        user = json.dumps({
            "document_title": doc["title"], "document_kind": doc.get("kind"),
            "window": f"{i + 1} of {len(windows)}",
            "already_in_the_bible": sorted(existing | seen)[:200],
            "text": window,
        }, ensure_ascii=False)
        try:
            text, meta = complete(
                "You maintain a story bible.\n\n# Output contract\n" + EXTRACT_CONTRACT,
                [{"role": "user", "content": user}],
                backend=backend, max_tokens=6000,
                model=payload.get("llm_model") or DEFAULT_PIPELINE_MODEL,
                cancel_check=lambda: sb.cancel_requested(jid), job=job)
        except Exception as e:                       # noqa: BLE001
            # One bad window must not cost the other eleven — same reasoning as
            # parsing blocking scene-by-scene rather than all-or-nothing.
            log(f"extract_lore: window {i + 1} failed ({e}); continuing")
            continue
        cost += meta.get("cost_usd", 0) or 0
        try:
            parsed = json_repair(text) or {}
        except Exception as e:                       # noqa: BLE001
            log(f"extract_lore: window {i + 1} returned unparseable JSON ({e}); continuing")
            continue
        for ent in (parsed.get("entries") or []):
            name = str(ent.get("name") or "").strip()[:80]
            key = name.lower()
            if not name or key in existing or key in seen:
                continue
            seen.add(key)
            found.append({
                "name": name,
                "summary": str(ent.get("summary") or "").strip()[:400] or None,
                "body": str(ent.get("body") or "").strip(),
            })

    if len(found) > EXTRACT_MAX_ENTRIES:
        log(f"extract_lore: {len(found)} entries proposed for '{doc['title']}' — "
            f"keeping the first {EXTRACT_MAX_ENTRIES}.")
        found = found[:EXTRACT_MAX_ENTRIES]

    # Inherit the document's episode. A fact pulled out of "the Ep1-2 lore
    # sheet" is about those episodes, and defaulting it here is what makes
    # tagging cheap enough to actually happen — the alternative is a review
    # queue where every entry needs its episode set by hand, which is how a
    # feature like this ends up unused. `revealed` matches `from` by default:
    # an ordinary fact is established when it is shown, and a RETCON (revealed
    # later than it was true) is the case a human has to mark, because only a
    # reader who knows the story can tell one from the other.
    ep = doc.get("episode_id")
    when = {"from": ep, "until": None, "revealed": ep} if ep else None

    rows = []
    for ent in found:
        rows.append(sb.insert("bible_entries", {
            "project_id": project_id, "kind": "lore", "name": ent["name"],
            "summary": ent["summary"],
            "doc": {"body": ent["body"], "from_document": doc["id"],
                    "from_document_title": doc["title"],
                    **({"when": when} if when else {})},
            "status": "draft"}))

    if cost:
        sb.record_cost(job, cost, "llm", provider=backend,
                       note=f"extract_lore {doc['title']}")
    sb.job_patch(jid, {"payload": {**payload, "result": {
        "document_id": doc["id"], "entries": [r["id"] for r in rows],
        "proposed": len(rows), "windows": len(windows)}}})
    sb.job_done(jid)
    log(f"JOB DONE extract_lore '{doc['title']}': {len(rows)} draft entries "
        f"from {len(windows)} window(s)")


# ------------------------------------------------------------- lore_update ---
def lore_update(job):
    """Propose a bible revision from observations; the user confirms in the
    Bible UI (bible_revisions.confirmed_at stays null until then)."""
    jid = job["id"]
    payload = job.get("payload") or {}
    entry = sb.get(f"bible_entries?id=eq.{payload['entry_id']}")[0]
    backend = pick_backend(job, payload)
    system = ("You maintain a story bible. Given an entry and new observations, "
              "return ONLY JSON: {\"doc\": {updated doc object}, \"identity_line\": "
              "\"updated or same\", \"change_note\": \"1 sentence on what changed\"}. "
              "Keep everything not contradicted by the observations; merge, don't rewrite.")
    user = json.dumps({"entry": {"kind": entry["kind"], "name": entry["name"],
                                 "doc": entry.get("doc"), "identity_line": entry.get("identity_line")},
                       "observations": payload.get("observations")}, ensure_ascii=False)
    text, meta = complete(system, [{"role": "user", "content": user}],
                          backend=backend, max_tokens=4000,
                          cancel_check=lambda: sb.cancel_requested(jid), job=job)
    data = json_repair(text)
    ver = int(entry.get("version") or 1) + 1
    rev = sb.insert("bible_revisions", {
        "entry_id": entry["id"], "version": ver,
        "doc": data.get("doc") or entry.get("doc"),
        "identity_line": data.get("identity_line") or entry.get("identity_line"),
        "change_note": data.get("change_note") or "director update",
        "proposed_by": "director"})
    if meta.get("cost_usd"):
        sb.record_cost(job, meta["cost_usd"], "llm", provider=meta["backend"],
                       note=f"lore_update {entry['name']}")
    sb.job_patch(jid, {"payload": {**payload, "result": {"revision_id": rev["id"], "version": ver}}})
    sb.job_done(jid)
    log(f"JOB DONE lore_update {entry['name']} -> rev v{ver} (awaiting confirm)")


# -------------------------------------------------------------- flf_prompt ---
_FLF_TEMPLATE = ("A smooth cinematic transition: the scene flows continuously from "
                 "the first frame's composition into the last frame's composition "
                 "with camera motion carrying the change; no flashes, no text.")


def flf_prompt(from_ref, to_ref, style=None, backend=None):
    """Describe a transition between two frames (`from_ref`/`to_ref` are asset
    ids or local paths). Vision path on Claude backends; deterministic
    template anywhere else. Never raises."""
    try:
        backend = backend or pick_backend()
        if backend not in ("claude-oauth", "claude-api"):
            return _FLF_TEMPLATE
        import base64
        import media
        images = []
        for ref in (from_ref, to_ref):
            if os.path.exists(str(ref)):
                local, cleanup = str(ref), False
            else:
                a = sb.asset_by_id(ref)
                local, cleanup = f"/tmp/flf_{ref}.png", True
                media.b2_get(a["b2_key"], local)
            with open(local, "rb") as f:
                images.append(("image/png", base64.b64encode(f.read()).decode()))
            if cleanup:
                os.remove(local)
        text, _ = complete(
            "You write MiniMax H3 first-last-frame transition prompts. One short "
            "paragraph of plain prose: how the first image's composition evolves "
            "into the second's over ~1 second — camera motion (type, amplitude, "
            "speed), what transforms, lighting. No lists, no timestamps, no text overlays.",
            [{"role": "user", "content":
                f"Style: {style or 'cinematic'}. First image = start frame, "
                f"second = end frame. Write the transition prompt."}],
            backend=backend, max_tokens=400, images=images, job=job)
        return text.strip() or _FLF_TEMPLATE
    except Exception as e:
        log(f"flf_prompt fell back to template: {e}")
        return _FLF_TEMPLATE


# ---------------------------------------------------------- enhance_prompt ---
_ENHANCE_LEAD = re.compile(
    r"^(here(?:'s| is)[^\n:]*:|enhanced prompt:|rewritten prompt:|prompt:)\s*",
    re.I)


def _clean_prompt(text):
    """Strip the manners a chat model wraps a rewrite in."""
    t = (text or "").strip()
    fence = re.match(r"^```[a-z]*\n([\s\S]*?)\n```$", t, re.I)
    if fence:
        t = fence.group(1).strip()
    t = _ENHANCE_LEAD.sub("", t)
    if len(t) > 1 and t[0] in "\"“'" and t[-1] in "\"”'":
        t = t[1:-1].strip()
    return t


def enhance_prompt(job):
    """Rewrite one generation prompt against the model's prompt guide.

    Queued by the browser and answered here, so a rewrite on a local model
    costs no provider money. The guide arrives built in the payload
    (director/prompt_guides.js is JS; personas travel the same way).

    Result lands on payload.result.prompt, like flf_prompt: the browser is
    already watching this job row over realtime.
    """
    jid = job["id"]
    p = job.get("payload") or {}
    prompt = (p.get("prompt") or "").strip()
    if not prompt:
        raise LLMError("enhance_prompt needs a prompt")
    system = p.get("system") or ("You rewrite one generation prompt. Return only "
                                 "the rewritten prompt, no preamble.")
    # The vendor guides live on disk here, as they do for pipeline grounding.
    # The browser sends their names rather than their contents: MiniMax's two
    # writing guides are 39KB together, which has no business in the bundle
    # when the machine running the turn already has them.
    docs = [d for d in (p.get("guide_docs") or []) if _SAFE_DOC.match(str(d))]
    if docs:
        text = "\n\n".join(t for t in (_read_knowledge(d) for d in docs) if t)
        if text:
            system += (f"\n\n--- {p.get('guide_label') or 'model'} prompt writing "
                       f"guide (vendor documentation) ---\n{text}\n--- end of guide ---")
    backend = pick_backend(job, p)
    label = p.get("model_label") or "this model"
    kind = p.get("kind") or "image"
    # NOT EVERY TURN ON THIS TASK IS A PROMPT REWRITE. The retake modal's edit
    # brief comes through here too, and asking for "this video prompt" would be
    # asking for the wrong artifact — the studio compiles the envelope around
    # those words rather than expecting them to BE one. The caller states the
    # request line; absent, this is the prompt rewrite it always was, so a
    # payload written before the field behaves identically.
    line = (p.get("user_line") or "").strip() \
        or f"Rewrite this {kind} prompt for {label}:"
    text, meta = complete(
        system,
        [{"role": "user", "content": f"{line}\n\n{prompt}"}],
        backend=backend, max_tokens=900,
        cancel_check=lambda: sb.cancel_requested(jid), job=job)
    out = _clean_prompt(text)
    if not out:
        raise LLMError("the model returned nothing to use")
    sb.job_patch(jid, {"payload": {**p, "result": {
        "prompt": out, "backend": backend, "tokens_out": meta.get("tokens_out")}}})
    sb.job_done(jid)
    log(f"JOB DONE enhance_prompt ({backend}, {len(out)} chars)")


# ---------------------------------------------------------- revise a block ---
def _drop_block_beats(block, beats, drop_ids):
    """Remove merged-away shots from the storyboard.

    FOUR WRITES, and leaving any one out is a silent inconsistency rather than
    an error:

      * the `beats` rows go;
      * `generation_blocks.beat_ids` follows, or the next compile loads a beat
        that no longer exists and every shot number after it slides;
      * `ref_plan` loses any entry bound to a dropped beat - a panel staged for
        [Shot 3] of a block that now has two shots is a picture the envelope
        describes and the render cannot place. The pictures are re-slotted
        because `<Picture N>` is positional;
      * the scene's remaining beats are RESEQUENCED to close the gap, because
        `director_tools._resolve_beat` addresses a beat by its `idx` inside the
        scene ("b3" is the beat whose idx is 2), so a hole makes a ref name
        nothing. `delete_beat` shifts siblings by one for exactly this reason;
        this is the several-at-once form.

    The scene's own `duration_ms` is deliberately NOT touched: the survivors
    were refit to the block's window, so the sum across the scene is what it
    already was. Nor is the rest of the storyboard marked stale - the caller is
    a retake of this ONE block, and `delete_beat`'s blanket sweep would put
    every other block of the episode into a state nobody asked for.
    """
    drop = set(drop_ids)
    for bid in drop_ids:
        sb.delete(f"beats?id=eq.{bid}")

    upd = {"beat_ids": [b for b in (block.get("beat_ids") or []) if b not in drop]}
    plan = [e for e in (block.get("ref_plan") or [])
            if not (isinstance(e, dict) and e.get("beat_id") in drop)]
    if len(plan) != len(block.get("ref_plan") or []):
        fresh, pic = [], 0
        for e in plan:
            if isinstance(e, dict) and e.get("purpose") != "voice":
                pic += 1
                fresh.append({**e, "slot": pic})
            else:
                fresh.append(e)          # audio numbers independently (§2.5)
        upd["ref_plan"] = fresh
    sb.patch(f"generation_blocks?id=eq.{block['id']}", upd)

    for sid in {b.get("scene_id") for b in beats
                if b["id"] in drop and b.get("scene_id")}:
        # Ascending, assigning 0..n-1. Every new idx is <= the old one (rows
        # were only removed), and everything below has already been moved
        # down, so the slot being written to is always free - which matters,
        # because `beats` is `unique (scene_id, idx)`.
        rows = sb.get(f"beats?scene_id=eq.{sid}&order=idx&select=id,idx")
        for i, r in enumerate(rows):
            if r.get("idx") != i:
                sb.patch(f"beats?id=eq.{r['id']}", {"idx": i})


def revise_block(job):
    """Apply a retake's plain-language brief to the block's BEATS, so the
    regenerate renders a genuinely different shot.

    THE BUG THIS FIXES. The brief used to land in `params.prompt_extra`, and
    `handle_master_pass` appended it to the already-composed description as
    "Director's adjustment for this take:". Everything else was compiled from
    the same unchanged beats, so a brief asking for different blocking, a
    different camera or different DIALOGUE came back as the same shot with a
    sentence stapled to the end of it. Dialogue could not change at all: the
    lines are recorded at plan time from `beats.dialogue`, staged as reference
    AUDIO, and bound in the envelope as "precisely lip-synced to <Audio N>" —
    so the recording still said the old words no matter what the prose asked
    for, and the take came back word-for-word identical.

    Invariant #6 is intact and is exactly why this works: the model rewrites
    the STRUCTURED beats and the deterministic compiler builds the envelope
    from them. It is the batched, whole-block form of the director chat's
    `update_beat`, and it shares that tool's two non-obvious duties — clearing
    the `meta.xchg` recording pin when the words change, and refitting shot
    durations so a longer line still fits inside the block's own window.

    Queued by the prompt & references modal as an `llm_task` that the
    `master_pass` then depends on, so the render compiles from the revised
    beats rather than racing them.
    """
    import storyplan as SP          # local, like plan_storyboard's — storyplan
    jid = job["id"]                   # imports nothing back and stays cheap
    p = job.get("payload") or {}
    block_id = p["block_id"]
    brief = (p.get("brief") or "").strip()
    if not brief:
        raise LLMError("revise_block needs a brief")

    blocks = sb.get(f"generation_blocks?id=eq.{block_id}&limit=1")
    if not blocks:
        raise LLMError("block not found")
    block = blocks[0]
    beat_ids = block.get("beat_ids") or []
    if not beat_ids:
        raise LLMError("this block has no beats to revise")
    rows = sb.get(f"beats?id=in.({','.join(beat_ids)})")
    # ORDERED THE WAY THE COMPILER ORDERS THEM — `(scene idx, beat idx)`, the
    # same sort `_load_context` does — and deliberately not by the `beat_ids`
    # array. The two can disagree (a block may span two scenes of one location,
    # only an environment cut splits it), and then "shot 2" in the contract
    # names a different beat from `[Shot 2]` in the compiled envelope: the
    # revision lands, cleanly, on the wrong shot.
    scene_ids = sorted({b["scene_id"] for b in rows})
    scene_rows = (sb.get(f"scenes?id=in.({','.join(scene_ids)})"
                         f"&select=id,idx,slug,scene_prompt") if scene_ids else [])
    scene_idx = {s["id"]: s.get("idx", 0) for s in scene_rows}
    beats = sorted(rows, key=lambda b: (scene_idx.get(b["scene_id"], 0), b.get("idx", 0)))

    # Context the reviser needs to stay inside the story: the scene it serves,
    # and who is castable. Without the cast list a rewrite invents a name, and
    # a name with no bible entry renders as a different face every block.
    scene = next((s for s in scene_rows if s["id"] == beats[0]["scene_id"]), {})
    project_id = p.get("project_id")
    if not project_id:
        boards = sb.get(f"storyboards?id=eq.{block['storyboard_id']}&select=episode_id&limit=1")
        eps = (sb.get(f"episodes?id=eq.{boards[0]['episode_id']}&select=project_id&limit=1")
               if boards else [])
        project_id = eps[0]["project_id"] if eps else None
    cast = (sb.get(f"bible_entries?project_id=eq.{project_id}&kind=eq.character"
                   f"&select=id,name,summary&limit=60") if project_id else [])

    shots = [{"n": i + 1,
              "action": b.get("action"),
              "camera": b.get("camera"),
              "sfx": b.get("sfx"),
              "duration_ms": b.get("duration_ms"),
              "cast": (b.get("meta") or {}).get("cast") or [],
              "dialogue": [{"speaker": d.get("speaker"), "line": d.get("line"),
                            **({"delivery": d["delivery"]} if d.get("delivery") else {})}
                           for d in (b.get("dialogue") or [])]}
             for i, b in enumerate(beats)]
    block_ms = int(block["t_end_ms"]) - int(block["t_start_ms"])

    # WHAT THE RENDER IS ACTUALLY HANDED. The reviser writes `cast`, and `cast`
    # is what decides whose reference sheet gets staged - so without the
    # picture list it has been making that decision blind. Measured on Rei EP04
    # b45: the note asked it to "use correct ref for miko" and the rewritten
    # action still read "Miko in her memory keeper outfit" while the staged
    # sheet is base Miko's turnaround, because nothing in the request said
    # which pictures exist.
    #
    # Context, never an instruction on its own. `ref_plan` is POST-budget
    # (`blocks.budget_refs` evicts past the picture cap), so "has no picture"
    # does not by itself mean "is not in this block" - the note decides, and
    # this is what lets the note be answered accurately.
    staged = [{"picture": i,
               "shows": e.get("label") or e.get("name") or "(unlabelled)",
               "kind": e.get("purpose")}
              for i, e in enumerate(
                  [e for e in (block.get("ref_plan") or [])
                   if isinstance(e, dict) and e.get("purpose") != "voice"], 1)]

    backend = pick_backend(job, p)
    # `_block_ref` rather than the raw idx: every ref in this studio counts
    # from one (director/refs.js REF_BASE), and a progress note that says b13
    # while the director says b14 is two names for one shot.
    from director_tools import _block_ref
    sb.job_progress(jid, 0.15,
                    note=f"Director: revising {_block_ref(block.get('idx') or 0)} via {backend}")
    text, meta = complete(
        (p.get("persona") or "You are a candid, experienced creative director.")
        + "\n\n# Output contract\n" + SP.REVISE_CONTRACT,
        [{"role": "user", "content": json.dumps({
            "director_note": brief,
            "scene": {"slug": scene.get("slug"), "prompt": scene.get("scene_prompt")},
            "block_duration_ms": block_ms,
            "castable_characters": [c["name"] for c in cast],
            "staged_references": staged,
            "shots": shots,
        }, ensure_ascii=False)}],
        backend=backend, max_tokens=3000,
        # Deliberately NOT `or DEFAULT_PIPELINE_MODEL`: that constant is an
        # OPENAI name, `pick_backend` independently prefers claude-oauth
        # whenever the token is set, and pairing those asks Anthropic for
        # `gpt-5.6-luna` — a 404, which is not transient and so gets no
        # fallback. Left None, each backend uses its own default
        # (ANTHROPIC_MODEL / OPENAI_MODEL / OLLAMA_MODEL) and a caller who
        # wants a specific one sends `backend` and `llm_model` together.
        model=p.get("llm_model"),
        cancel_check=lambda: sb.cancel_requested(jid), job=job)
    revision = json_repair(text)
    if not isinstance(revision, dict):
        raise LLMError("the reviser returned nothing usable")

    # Shots the revision MERGES AWAY, resolved before the patches so the
    # survivors are the ones that absorb the block's window.
    drop_ids, drop_warnings = SP.dropped_beats(beats, revision)
    patches, warnings = SP.revise_beats(beats, revision, block_ms, dropped=drop_ids)
    warnings = drop_warnings + warnings
    if not patches and not drop_ids:
        # NOT an error: "nothing needed changing" is a legitimate answer, and
        # failing the job would take the master_pass down with it (its dep).
        # Say so on the row instead — the render still runs, unchanged.
        log(f"revise_block {_block_ref(block.get('idx') or 0)}: no beat changed")

    by_name = {c["name"].split(" — ")[0].strip().lower(): c["id"] for c in cast}
    changed_lines = False
    for beat_id, patch in patches:
        if "dialogue" in patch:
            changed_lines = True
            patch["dialogue"] = [
                {"speaker_id": by_name.get(str(l["speaker"]).split(" — ")[0].strip().lower()),
                 "speaker": l["speaker"], "line": l["line"],
                 **({"delivery": l["delivery"]} if l.get("delivery") else {}),
                 **({"offscreen": True} if l.get("offscreen") else {})}
                for l in patch["dialogue"]]
        sb.patch(f"beats?id=eq.{beat_id}", patch)

    if changed_lines and project_id:
        # The recording pin, which does NOT look after itself. Clip caches are
        # content-hash keyed on the words and the voice, so edited text misses
        # the cache and re-synthesizes; `beats.meta.xchg` pins a beat to ONE
        # recording and its duration was cut to that performance. Left in
        # place, the master pass keeps routing to a clip that no longer holds
        # these words and `place_exchange` mis-times them or silently falls
        # back to timbre refs.
        import director_tools as DT
        for beat_id, patch in patches:
            if "dialogue" not in patch:
                continue
            beat = next((b for b in beats if b["id"] == beat_id), None)
            if beat:
                DT._invalidate_dialogue({**beat, **patch}, patch["dialogue"])

    if drop_ids:
        # LAST, and after the patches have landed: the survivors carry the
        # merged prose and the whole window, so a failure here leaves a block
        # that renders the right thing with too many cuts, rather than one
        # whose beats no longer add up to its own length.
        _drop_block_beats(block, beats, drop_ids)

    summary = str(revision.get("summary") or "").strip()
    sb.job_patch(jid, {"payload": {**p, "result": {
        "changed_beats": len(patches), "dropped_shots": len(drop_ids),
        "summary": summary,
        "warnings": warnings, "backend": backend,
        "tokens_out": meta.get("tokens_out")}}})
    sb.job_done(jid)
    log(f"JOB DONE revise_block {_block_ref(block.get('idx') or 0)}: "
        f"{len(patches)} beat(s) changed"
        + (f", {len(drop_ids)} shot(s) merged away" if drop_ids else "")
        + (f", dialogue rewritten" if changed_lines else "")
        + (f" — {'; '.join(warnings)}" if warnings else ""))


# ----------------------------------------------------------- redraw panels ---
def redraw_panels(job):
    """Re-draw a scene's storyboard panels from the beats AS THEY STAND NOW.

    THE GAP THIS CLOSES. Panels were drawn in exactly two places — tier 1 (the
    loop in `plan_storyboard`) and the "Re-draw panels" button
    (`src/lib/panels.ts`) — and the director chat could reach neither. So
    "rewrite these beats and redraw the panels" did half of what was asked:
    `update_beat` landed the prose, the panels went on describing the shots the
    scene used to have, and nothing anywhere marks a panel stale. The model
    reported the beat edit accurately and never said the other half was
    impossible, because from inside the toolset it did not look impossible —
    there was simply no tool. Measured on Rei EP03 CITY_CAPTURE_2: six beats
    rewritten, six panels untouched, and the reply named only the stale blocks.

    Composition is `scene_panel_specs`, whose own docstring names this caller —
    "a re-draw, a verification, a repair all had to reimplement it and then
    drift". Nothing about it is duplicated here. What lives here is the job
    INSERT the planner keeps to itself, and it is deliberately the SAME insert
    (same spec, same anchors, same `as: "panel"` slot, same label shape), so a
    panel redrawn from the chat is the same picture as one drawn by the planner
    or by the button.

    Two deliberate matches with the BROWSER rather than with tier 1, because
    the button is the same user-facing action and two surfaces answering
    "redraw the panels" with different pictures is the drift `panels.ts` exists
    to prevent:

      * **style is `projects.style`**, never the settings style guide. A panel's
        job is to look like the sheets it is anchored to and those were drawn
        off this field; the guide genuinely disagrees in the wild, so reading it
        would redraw one panel photoreal in the middle of an animated board.
      * **no `world`.** Tier 1 has the plan's `{era, palette}` in hand; a redraw
        has only the rows, and the browser passes none. Recovering it here would
        make a chat redraw a different picture than the button's.

    A user's own `still_asset_id` is untouched and keeps outranking what this
    writes — that is the whole reason the auto slot is a separate key.

    Payload: `scene_ids` (uuids — the tool resolves "S7"/slug against the open
    board, which the worker cannot do), optional `beat_ids` to redraw a subset,
    optional `image_model` (a model_map key) / `quality` / `dims` / `priority`.
    """
    jid = job["id"]
    p = job.get("payload") or {}
    scene_ids = [s for s in (p.get("scene_ids") or []) if s]
    if not scene_ids:
        raise LLMError("redraw_panels needs at least one scene")
    # Filters the INSERT, never the composition — see the `shots` comment.
    only = set(p.get("beat_ids") or [])

    prows = sb.get(f"projects?id=eq.{p['project_id']}&select=id,style,settings")
    if not prows:
        raise LLMError("project not found")
    project = prows[0]
    settings = project.get("settings") or {}

    # The catalog-id -> model_map-key table lives in director_tools (which
    # imports nothing back), the same local-import shape revise_block already
    # uses for `_invalidate_dialogue`. `settings.image_model` is a CATALOG id
    # and `payload.image_model` is already a key, exactly as plan_storyboard
    # receives it — mapping the wrong one lands `h3-local` in model_map and
    # the job dies on "model not available".
    import director_tools as DT
    import hosted_image
    from handlers import images as HI
    model_key = p.get("image_model") or DT._model_key(settings.get("image_model"))
    quality = p.get("quality") or settings.get("image_quality")
    d = p.get("dims") or {}
    pw = int(d.get("width") or d.get("w") or 1280)
    ph = int(d.get("height") or d.get("h") or 704)
    # A human asked for this in the chat, so it outruns the queue — the
    # priority `queueBeatPanel` sends from the button (USER_PRIORITY).
    prio = int(p.get("priority") or 5)

    # A HOSTED PANEL LEAVES THE POD'S LANE, and this is the one decision that
    # makes that possible. A panel job normally carries `prompt_spec` plus
    # late-bound `anchors`, and both are resolved in Python inside
    # `handle_image_gen` — which is why `enqueueJob` excludes such payloads
    # from its studio-hosted reroute and `runHostedImageJob` refuses them. So
    # the whole panel path has been pod-only whatever the model, including the
    # "Re-draw panels" button, and with a hosted model the pod's contribution
    # is an HTTPS call, a B2 upload and a row insert: $3.36/hr to run a curl.
    #
    # The composition can move HERE for a hosted row specifically, because the
    # stated reason for deferring it does not apply to one. `handle_image_gen`
    # composes late "because the family is only final after the reference
    # fallback" — and that fallback is gated on `fam in ("krea2","flux",
    # "flux2","anima")`, all LOCAL families. A hosted row never enters it, so
    # its family IS final at queue time. What remains (anchor resolution, the
    # plate correction, pruning the envelope to what resolved) is done below
    # with the pod's own functions rather than a second reading of them.
    hosted_row = sb.model_catalog().get(model_key) or {}
    hosted = hosted_image.studio_hosted(hosted_row)
    fam = model_key
    if hosted:
        try:
            fam = HI._family((HI._load_map_tier() or {}).get("image_models") or {},
                             model_key)
        except Exception as e:      # noqa: BLE001 — a missing map is not fatal
            # `_family` falls back to the key itself anyway; say so rather than
            # composing for a family nobody chose and never mentioning it.
            log(f"redraw_panels: model map unreadable ({e}) — composing for '{fam}'")
        # …and a hosted row composes for its PROVIDER. Without this the family
        # is the catalog id, which SHAPES does not name, so the panel takes the
        # "stack" default — the bracketed SDXL contract — on the instruction
        # followers it suits least. Same call the pod makes.
        fam = image_prompt.compose_family(fam, hosted_row.get("provider"))
        log(f"redraw_panels: {model_key} is studio-hosted — composing here and "
            f"queueing on the local lane (no pod)")

    scenes = sb.get(f"scenes?id=in.({','.join(scene_ids)})&order=idx"
                    f"&select=id,idx,slug,cast_ids,environment_id,meta")
    if not scenes:
        raise LLMError("none of those scenes exist any more")

    queued, per_scene = 0, []
    for scene in scenes:
        beats = sb.get(f"beats?scene_id=eq.{scene['id']}&order=idx"
                       f"&select=id,idx,camera,action,dialogue,meta")
        if not beats:
            continue
        cast_rows = (sb.get(f"bible_entries?id=in.({','.join(scene['cast_ids'])})"
                            f"&select=id,name,identity_line,doc")
                     if scene.get("cast_ids") else [])
        env_rows = (sb.get(f"bible_entries?id=eq.{scene['environment_id']}"
                           f"&select=id,name,identity_line")
                    if scene.get("environment_id") else [])
        # THE WHOLE SCENE IS COMPOSED, always, even when one shot is being
        # redrawn: the location-plate rotation is a per-scene decision
        # (image_prompt.plate_plan), so a spec built from a subset picks a
        # different plate than the batch did and the redrawn shot stops
        # matching its neighbours. Same reason `queueBeatPanel` takes
        # `sceneBeats` for a single-beat redraw.
        #
        # A beat ROW carries its cast under `meta.cast` where a planner SHOT
        # carries it at the top level; `scene_panel_specs` reads the shot
        # shape, so it is lifted here rather than branched for there.
        shots = [{"camera": b.get("camera"), "action": b.get("action"),
                  "dialogue": b.get("dialogue") or [],
                  "cast": (b.get("meta") or {}).get("cast") or [],
                  "meta": b.get("meta") or {}} for b in beats]
        built = scene_panel_specs(
            shots, cast_rows, env_rows[0] if env_rows else None,
            # The literal tier 1 substitutes, and the twin of the browser's
            # PLANNER_STYLE_FALLBACK: an unset style must resolve the same way
            # on every surface or a redraw regrades the scene.
            style=project.get("style") or "anime",
            time_of_day=(scene.get("meta") or {}).get("time"),
            cast_cap=image_prompt.panel_cast_cap(model_key),
            wide_faces=image_prompt.wide_face_cap(model_key),
            # WHERE THE PLATE RING PICKED UP for this scene, read back off the
            # stamp tier 1 wrote. Recomputing it is not available here — the
            # count is over the scenes BEFORE this one in the same location —
            # and defaulting to 0 on a stamped board would re-establish on the
            # master and undo the rotation. Absent (a board planned before the
            # stamp) it is 0, which is exactly what that board was drawn with.
            plate_turn=int((scene.get("meta") or {}).get("plate_turn") or 0))
        n = 0
        for b, (anchors, pspec) in zip(beats, built):
            # A breath beat draws no panel — same skip as tier 1, and it lives
            # at the INSERT so the specs stay 1:1 with the scene's beats and
            # the plate rotation keeps agreeing with the browser twin.
            if (b.get("meta") or {}).get("breath"):
                continue
            if only and b["id"] not in only:
                continue
            label = (f"{(scene.get('slug') or 'scene')[:18]} "
                     f"b{b['idx'] + 1} · panel")
            common = {"kind": "image_gen", "status": "queued",
                      "priority": prio, "project_id": project["id"],
                      "episode_id": p.get("episode_id")}
            base = {**({"model_key": model_key} if model_key else {}),
                    **({"quality": quality} if quality else {}),
                    "label": label, "width": pw, "height": ph,
                    "auto_accept": True,
                    "target": {"beat_id": b["id"], "as": "panel"}}
            if hosted:
                # LITERAL: no prompt_spec, no anchors, nothing left to compose.
                # That is exactly what `runHostedImageJob` requires and what
                # `enqueueJob`'s reroute tests for — the payload has to be
                # finished, not merely hosted.
                taken = []
                ref_ids = HI._resolve_anchor({"anchors": anchors}, taken)
                spec = HI.finalize_spec(pspec, anchors, taken, bool(ref_ids))
                sb.insert("jobs", {**common, "lane": "local",
                                   # `isStudioHostedJob` reads model_id first,
                                   # and it is the claim filter on the web —
                                   # a tab that cannot resolve the row leaves
                                   # the job for a machine that can.
                                   "model_id": model_key,
                                   "payload": {**base,
                                               "prompt": image_prompt.compose(spec, fam),
                                               **({"ref_asset_ids": ref_ids}
                                                  if ref_ids else {})}})
            else:
                sb.insert("jobs", {**common, "lane": job_lane(p, "image_gen"),
                                   "payload": {**base,
                                               "prompt": image_prompt.compose(pspec),
                                               "prompt_spec": pspec,
                                               "anchors": anchors}})
            n += 1
        queued += n
        per_scene.append({"scene": scene.get("slug"), "panels": n})
        sb.job_progress(jid, len(per_scene) / max(1, len(scenes)),
                        note=f"{queued} panel(s) queued")

    sb.job_patch(jid, {"payload": {**p, "result": {"queued": queued,
                                                   "scenes": per_scene}}})
    sb.job_done(jid)
    log(f"JOB DONE redraw_panels: {queued} panel(s) across "
        f"{len(per_scene)} scene(s)")


# -------------------------------------------------------------------- chat ---
def chat(job):
    """Local-model chat turn: streams into the assistant chat_messages row so
    the UI renders it live over realtime (updates throttled to ~2/s)."""
    jid = job["id"]
    payload = job.get("payload") or {}
    thread_id = payload["thread_id"]
    backend = pick_backend(job, payload)

    msgs = sb.get(f"chat_messages?thread_id=eq.{thread_id}&order=created_at"
                  f"&select=role,content&limit=40")
    import director_tools
    history = []
    for m in msgs:
        if m["role"] not in ("user", "assistant"):
            continue
        txt = " ".join(b.get("text", "") for b in m["content"]
                       if isinstance(b, dict) and b.get("type") == "text")
        # Attachments were dropped here entirely — a picture the user dragged
        # in was invisible AND unmentioned, so the local director answered as
        # though nothing had been attached. It still cannot see the image, but
        # the id is what note_brief and every tool actually take.
        full = "\n\n".join(x for x in [txt.strip(),
                                       *director_tools.attachment_lines(m["content"])] if x)
        if full:
            history.append({"role": m["role"], "content": full})
    if not history or history[-1]["role"] != "user":
        raise LLMError("thread has no trailing user message")

    system = payload.get("persona") or "You are a candid, experienced creative director."
    # Tools need a project to act on; the thread carries it when the caller
    # queued the turn straight from the browser.
    thread_rows = sb.get(f"chat_threads?id=eq.{thread_id}&select=project_id,episode_id")
    thread_project = (thread_rows[0].get("project_id") if thread_rows else None)
    thread_episode = (thread_rows[0].get("episode_id") if thread_rows else None)
    row = sb.insert("chat_messages", {
        "thread_id": thread_id, "role": "assistant",
        "content": [{"type": "text", "text": ""}], "streaming": True, "job_id": jid})

    acc, last_push = [], [0.0]

    def on_delta(piece):
        acc.append(piece)
        if time.time() - last_push[0] > 0.5:
            last_push[0] = time.time()
            sb.patch(f"chat_messages?id=eq.{row['id']}",
                     {"content": [{"type": "text", "text": "".join(acc)}]})

    try:
        # Give the local model the same tools the hosted director has, so
        # "add a redhead character" creates a bible entry instead of only
        # describing one. Falls back to a plain completion on any backend
        # without a worker-side loop. (director_tools is imported above, for
        # the history builder.)
        tool_blocks = []

        def on_tool(name, status, result):
            tool_blocks.append({"type": "tool_use", "name": name} if status == "run"
                               else {"type": "tool_result", "name": name,
                                     "result": result if isinstance(result, dict) else {}})
            sb.patch(f"chat_messages?id=eq.{row['id']}",
                     {"content": [*tool_blocks, {"type": "text", "text": "".join(acc)}]})

        # Every write the tools make is journaled (sb.journal_*) and persisted
        # beside the text as a `changes` block — the same record the hosted
        # handler writes — so the dock's Revert reads one shape whichever
        # director answered. The chat_messages row above and the patches
        # below are NOT the turn's edits, so the journal opens after the row
        # exists and closes before the final patch.
        sb.journal_begin()
        try:
            text, meta = complete_with_tools(
                system, history, backend=backend,
                tools=director_tools.SCHEMAS if payload.get("project_id") or thread_project else None,
                execute=director_tools.execute,
                ctx={"project_id": payload.get("project_id") or thread_project,
                     "episode_id": payload.get("episode_id") or thread_episode,
                     "thread_id": thread_id,
                     "backend": backend, "persona": system},
                on_delta=on_delta, on_tool=on_tool,
                cancel_check=lambda: sb.cancel_requested(jid))
        finally:
            journal = sb.journal_end()
    except BaseException as e:
        # The reason lives on the job row, which nobody reading the chat can
        # see. A bare "(generation failed)" sent people asking what broke when
        # the worker knew exactly — "Ollama unreachable, run install_ollama.sh"
        # is actionable; a shrug is not.
        why = str(e).strip() or e.__class__.__name__
        partial = "".join(acc)
        sb.patch(f"chat_messages?id=eq.{row['id']}", {
            "streaming": False,
            "content": [{"type": "text",
                         "text": (partial + "\n\n" if partial else "") + f"⚠ {why[:400]}"}],
        })
        raise
    changed = [op for op in journal if op.get("op") in ("insert", "update", "delete")]
    sb.patch(f"chat_messages?id=eq.{row['id']}", {
        "content": [*tool_blocks,
                    *([{"type": "changes", "ops": changed}] if changed else []),
                    {"type": "text", "text": text}],
        "streaming": False,
        "tokens_in": meta.get("tokens_in"), "tokens_out": meta.get("tokens_out"),
        "cost_usd": meta.get("cost_usd") or None})
    sb.job_done(jid)
    log(f"JOB DONE chat ({backend}, {meta.get('tokens_out')} tok)")


# ---------------------------------------------------------------- handlers ---
def vlm_query(job):
    """Answer a question about a rendered clip from its own frames.

    This is what lets the director chat CHECK its work instead of trusting the
    storyboard — "is she wearing the hat in b5" is a question about pixels, and
    every other surface here can only report what was asked for, not what came
    out. The answer lands on `payload.result` for the tool to read back.
    """
    import media
    import vlm

    jid = job["id"]
    p = job.get("payload") or {}
    asset_id = p.get("asset_id")
    if not asset_id and p.get("take_id"):
        rows = sb.get(f"block_takes?id=eq.{p['take_id']}&select=asset_id")
        if not rows:
            raise LLMError(f"take {p['take_id']} not found")
        asset_id = rows[0]["asset_id"]
    if not asset_id:
        raise LLMError("vlm_query needs a take_id or an asset_id")
    asset = sb.asset_by_id(asset_id)
    if not asset:
        raise LLMError(f"asset {asset_id} not found")

    local = os.path.join("/tmp", f"vlm_{jid}{os.path.splitext(asset['b2_key'])[1] or '.mp4'}")
    media.b2_get(asset["b2_key"], local)
    try:
        out = vlm.ask(local, p["question"], n=p.get("frames"))
    finally:
        try:
            os.remove(local)
        except OSError:
            pass
        # The judge borrows the card beside a render; hand it straight back.
        try:
            vlm.unload()
        except Exception:  # noqa: BLE001 — eviction is best effort
            pass
    sb.job_patch(jid, {"payload": {**p, "result": out}})
    log(f"vlm_query: {out.get('confidence')} — {str(out.get('answer'))[:120]}")


def handle_llm_task(job):
    task = (job.get("payload") or {}).get("task")
    fn = {"plan_storyboard": plan_storyboard, "lore_update": lore_update,
          "extract_lore": extract_lore,
          "chat": chat, "enhance_prompt": enhance_prompt,
          "revise_block": revise_block, "redraw_panels": redraw_panels,
          "vlm_query": vlm_query}.get(task)
    if fn is None:
        if task == "flf_prompt":
            p = job["payload"]
            text = flf_prompt(p["from_asset_id"], p["to_asset_id"], p.get("style"))
            sb.job_patch(job["id"], {"payload": {**p, "result": {"prompt": text}}})
            sb.job_done(job["id"])
            return
        raise ValueError(f"unknown llm task '{task}'")
    fn(job)


def handle_embed(job):
    """Backfill embeddings for one rag_document's chunks (batched)."""
    jid = job["id"]
    doc_id = (job.get("payload") or {})["document_id"]
    rows = sb.get(f"rag_chunks?document_id=eq.{doc_id}&embedding=is.null"
                  f"&select=id,content&order=idx")
    done = 0
    for i in range(0, len(rows), 64):
        batch = rows[i:i + 64]
        embs = embed_texts([r["content"] for r in batch])
        for r, e in zip(batch, embs):
            sb.patch(f"rag_chunks?id=eq.{r['id']}", {"embedding": e})
        done += len(batch)
        sb.job_progress(jid, done / max(1, len(rows)), note=f"embedded {done}/{len(rows)}")
    sb.job_done(jid)
    log(f"JOB DONE embed {doc_id}: {done} chunks")


def resolve(kind):
    return {"llm_task": handle_llm_task, "embed": handle_embed}[kind]

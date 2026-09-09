"""Prompt caching and token accounting.

Every number in `cost_ledger` and every projection built on it comes out of
this code, and each failure here is silent: a miscounted token is a plausible
figure, a missing `cache_control` is a request that succeeds at full price, and
a cached token billed at the wrong rate makes a cache HIT look more expensive
than a miss. None of that raises.

No network. `_post_retrying` is replaced with something that records the body
it was handed and replays a canned SSE stream, so what is asserted is the exact
JSON that would have gone to the provider.
"""
import json

import pytest

import llm


# --------------------------------------------------------------- helpers ----
class FakeResp:
    """Just enough of `requests.Response` for `_iter_sse`."""

    def __init__(self, events, status=200):
        self.status_code = status
        self._lines = [f"data: {json.dumps(e)}" for e in events] + ["data: [DONE]"]

    def iter_lines(self, decode_unicode=True):
        return iter(self._lines)

    def close(self):
        pass


@pytest.fixture
def capture(monkeypatch):
    """Swap the transport; hand back the list of bodies it saw."""
    seen = []

    def fake(url, *, headers, body, timeout, cancel_check=None, label="llm",
             max_retries=4):
        seen.append(body)
        return FakeResp(fake.events)

    fake.events = []
    monkeypatch.setattr(llm, "_post_retrying", fake)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "key")
    monkeypatch.setenv("OPENAI_API_KEY", "key")
    return seen, fake


def anthropic_stream(*, tin=0, cwrite=0, cread=0, tout=0, text="ok"):
    return [
        {"type": "message_start", "message": {"usage": {
            "input_tokens": tin,
            "cache_creation_input_tokens": cwrite,
            "cache_read_input_tokens": cread,
        }}},
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}},
        {"type": "message_delta", "usage": {"output_tokens": tout}},
    ]


def openai_stream(*, text="ok", usage=None):
    evs = [{"choices": [{"delta": {"content": text}}]}]
    if usage is not None:
        # The usage chunk arrives last and carries NO choices — which is why it
        # cannot be read from inside the loop over `choices`.
        evs.append({"choices": [], "usage": usage})
    return evs


LONG = "L" * 6000     # comfortably over CACHE_MIN_CHARS
SHORT = "s" * 40


# ------------------------------------------------------- system as blocks ---
def test_a_block_list_flattens_to_exactly_the_string_it_replaced():
    """The blocks are a SPLIT of what used to be one string, so joining them
    with any separator would change the prompt every non-Anthropic backend
    sees — silently, and only in the wording."""
    whole = "AAA" + "BBB" + "CCC"
    assert llm.system_text(["AAA", "BBB", "CCC"]) == whole
    assert llm.system_text(whole) == whole
    assert llm.system_blocks(whole) == [whole]
    assert llm.system_blocks(["AAA", "BBB"]) == ["AAA", "BBB"]


def test_empty_blocks_are_dropped_rather_than_sent():
    # `room` is the empty string when no experts are picked, so an empty block
    # is the NORMAL case rather than a corner one. Anthropic rejects a text
    # block with empty content.
    assert llm.system_blocks(["A", "", "B"]) == ["A", "B"]
    assert llm.system_text(["A", "", "B"]) == "AB"


# ------------------------------------------------------- anthropic caching --
def test_the_shared_prefix_is_marked_cacheable_and_the_tail_is_not(capture):
    seen, fake = capture
    fake.events = anthropic_stream()
    llm.complete([LONG, SHORT], [{"role": "user", "content": "hi"}],
                 backend="claude-api")
    sysf = seen[0]["system"]
    assert [b["text"] for b in sysf] == [LONG, SHORT]
    assert sysf[0]["cache_control"] == {"type": "ephemeral"}
    # The LAST block is what changes per call — marking it would write a new
    # cache entry every request and never read one back.
    assert "cache_control" not in sysf[1]


def test_a_short_head_is_not_marked_and_does_not_spend_a_breakpoint(capture):
    # Anthropic will not cache a block under ~1024 tokens and says nothing
    # about it. There are only four breakpoints per request, so marking one
    # that cannot be used is a slot spent for nothing. Five of the nine plan
    # stages are in exactly this state (`persona` alone is ~17 characters).
    seen, fake = capture
    fake.events = anthropic_stream()
    llm.complete([SHORT, LONG], [{"role": "user", "content": "hi"}],
                 backend="claude-api")
    assert all("cache_control" not in b for b in seen[0]["system"])


def test_a_plain_string_system_still_goes_as_one_uncached_block(capture):
    # Every caller that has not been taught about blocks — the director chat,
    # enhance, the reviewer — must be byte-identical to what it sent before.
    seen, fake = capture
    fake.events = anthropic_stream()
    llm.complete("just a system prompt", [{"role": "user", "content": "hi"}],
                 backend="claude-api")
    assert seen[0]["system"] == [{"type": "text", "text": "just a system prompt"}]


def test_cached_anthropic_tokens_are_billed_at_their_own_rates(capture):
    """`input_tokens` EXCLUDES both cached figures on this provider.

    Adding them in would double-count; leaving the cached ones out entirely
    would report a cache read as free. Either way the ledger is wrong in a
    direction nothing else would reveal.
    """
    seen, fake = capture
    fake.events = anthropic_stream(tin=1000, cwrite=2000, cread=8000, tout=500)
    _, meta = llm.complete("s", [{"role": "user", "content": "hi"}],
                           backend="claude-api", model="claude-opus-5")
    pin, pout = 5.0, 25.0
    want = (1000 * pin
            + 2000 * pin * llm.ANTHROPIC_CACHE_WRITE
            + 8000 * pin * llm.ANTHROPIC_CACHE_READ
            + 500 * pout) / 1e6
    assert meta["cost_usd"] == pytest.approx(want)
    assert meta["cache_write"] == 2000
    assert meta["cache_read"] == 8000
    # `tokens_in` keeps meaning "billed at the full input rate", so the ledger
    # column it feeds means what it always meant.
    assert meta["tokens_in"] == 1000


def test_reading_a_cache_is_cheaper_than_not_having_one(capture):
    """The property the whole feature exists for, stated as arithmetic.

    A version that added the cached counts into `tin` before pricing would
    pass every other test here and fail this one.
    """
    seen, fake = capture
    fake.events = anthropic_stream(tin=9000, tout=100)
    _, cold = llm.complete("s", [{"role": "user", "content": "hi"}],
                           backend="claude-api", model="claude-opus-5")
    fake.events = anthropic_stream(tin=1000, cread=8000, tout=100)
    _, warm = llm.complete("s", [{"role": "user", "content": "hi"}],
                           backend="claude-api", model="claude-opus-5")
    assert warm["cost_usd"] < cold["cost_usd"]


def test_an_oauth_completion_is_still_free_however_it_cached(capture):
    # The subscription token is not metered, so a cache write must not start
    # booking a cost against it.
    seen, fake = capture
    fake.events = anthropic_stream(tin=1000, cwrite=9000, tout=100)
    _, meta = llm.complete("s", [{"role": "user", "content": "hi"}],
                           backend="claude-oauth")
    assert meta["cost_usd"] == 0.0


# ---------------------------------------------------------- openai usage ----
def test_the_openai_request_asks_for_usage(capture):
    # Without this the stream carries none at all and every figure falls back
    # to a character-count estimate.
    seen, fake = capture
    fake.events = openai_stream()
    llm.complete("s", [{"role": "user", "content": "hi"}], backend="openai-compat")
    assert seen[0]["stream_options"] == {"include_usage": True}


def test_the_system_prompt_leads_the_openai_messages(capture):
    # Caching keys on the longest stable PREFIX, so the order is load-bearing.
    seen, fake = capture
    fake.events = openai_stream()
    llm.complete([LONG, SHORT], [{"role": "user", "content": "hi"}],
                 backend="openai-compat")
    msgs = seen[0]["messages"]
    assert msgs[0]["role"] == "system"
    assert [p["text"] for p in msgs[0]["content"]] == [LONG, SHORT]


def test_the_stable_prefix_carries_an_explicit_breakpoint(capture):
    """THE WHOLE FEATURE ON THIS PROVIDER, measured rather than assumed.

    Without it, a shared prefix followed by differing tails reports zero cached
    tokens forever — implicit caching stores the complete request, and no
    request ends at the shared boundary. With it, 99% of the prefix comes back
    cached on the second call.
    """
    seen, fake = capture
    fake.events = openai_stream()
    llm.complete([LONG, SHORT], [{"role": "user", "content": "hi"}],
                 backend="openai-compat")
    parts = seen[0]["messages"][0]["content"]
    assert parts[0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    # The LAST block changes per call; marking it would write a new entry every
    # request and never read one back.
    assert "prompt_cache_breakpoint" not in parts[1]


def test_the_routing_key_is_the_prefix_and_nothing_else(capture):
    """A cached prefix lives on ONE machine, and requests are routed by load
    plus a hash of their opening tokens. Keying on a job or a project would
    scatter calls that share a prefix and lose the hit the breakpoint bought —
    so two different tails under one head must send the SAME key, and a
    different head a different one."""
    seen, fake = capture
    fake.events = openai_stream()
    llm.complete([LONG, "tail one"], [{"role": "user", "content": "hi"}],
                 backend="openai-compat")
    llm.complete([LONG, "a completely different tail"],
                 [{"role": "user", "content": "hi"}], backend="openai-compat")
    llm.complete([LONG + "x", "tail one"], [{"role": "user", "content": "hi"}],
                 backend="openai-compat")
    assert seen[0]["prompt_cache_key"] == seen[1]["prompt_cache_key"]
    assert seen[2]["prompt_cache_key"] != seen[0]["prompt_cache_key"]


def test_one_system_string_is_sent_exactly_as_it_always_was(capture):
    """Only the planner passes blocks. Every other caller — the director chat,
    enhance, the reviewer — must send a plain string with no new fields: an
    endpoint that rejects an unknown key answers 400, which is NOT transient,
    so it would end the call rather than falling forward."""
    seen, fake = capture
    fake.events = openai_stream()
    llm.complete("one plain system prompt", [{"role": "user", "content": "hi"}],
                 backend="openai-compat")
    assert seen[0]["messages"][0]["content"] == "one plain system prompt"
    assert "prompt_cache_key" not in seen[0]


def test_a_short_prefix_sends_the_plain_string_rather_than_an_array(capture):
    # Below the minimum there is nothing to cache, so the request shape must
    # not change — it would be a new failure mode bought for nothing.
    seen, fake = capture
    fake.events = openai_stream()
    llm.complete([SHORT, LONG], [{"role": "user", "content": "hi"}],
                 backend="openai-compat")
    assert seen[0]["messages"][0]["content"] == SHORT + LONG
    assert "prompt_cache_key" not in seen[0]


def test_a_non_openai_endpoint_is_never_sent_these_fields(capture, monkeypatch):
    """`openai-compat` is named for the DIALECT, not the vendor. Azure,
    OpenRouter and a local vLLM all answer here, and `prompt_cache_breakpoint`
    is OpenAI's own — a 400 from an unknown field is not transient, so it would
    end a plan rather than fall forward to another backend."""
    seen, fake = capture
    fake.events = openai_stream()
    monkeypatch.setattr(llm, "OPENAI_BASE", "http://127.0.0.1:8000/v1")
    llm.complete([LONG, SHORT], [{"role": "user", "content": "hi"}],
                 backend="openai-compat")
    assert seen[0]["messages"][0]["content"] == LONG + SHORT
    assert "prompt_cache_key" not in seen[0]
    # ...and the override is what turns it back on for a proxy that does
    # support it, without a code change.
    monkeypatch.setenv("QAMBA_OPENAI_CACHE", "1")
    llm.complete([LONG, SHORT], [{"role": "user", "content": "hi"}],
                 backend="openai-compat")
    assert "prompt_cache_key" in seen[1]


def test_real_usage_is_preferred_to_the_estimate(capture):
    seen, fake = capture
    fake.events = openai_stream(usage={"prompt_tokens": 4000, "completion_tokens": 700})
    _, meta = llm.complete("s", [{"role": "user", "content": "hi"}],
                           backend="openai-compat", model="gpt-5.6-luna")
    assert meta["tokens_in"] == 4000
    assert meta["tokens_out"] == 700
    assert not meta.get("estimated")
    assert meta["cost_usd"] == pytest.approx((4000 * 0.20 + 700 * 1.20) / 1e6)


def test_openai_cached_tokens_are_a_SUBSET_of_the_prompt_count(capture):
    """The opposite convention to Anthropic, and the reason the two cost paths
    are written out separately instead of sharing one helper."""
    seen, fake = capture
    fake.events = openai_stream(usage={
        "prompt_tokens": 10000, "completion_tokens": 100,
        "prompt_tokens_details": {"cached_tokens": 8000}})
    _, meta = llm.complete("s", [{"role": "user", "content": "hi"}],
                           backend="openai-compat", model="gpt-5.6-luna")
    want = (2000 * 0.20 + 8000 * 0.20 * llm.OPENAI_CACHE_READ + 100 * 1.20) / 1e6
    assert meta["cost_usd"] == pytest.approx(want)
    assert meta["cache_read"] == 8000
    # ...and the full prompt count is still reported, not the uncached remainder.
    assert meta["tokens_in"] == 10000


def test_the_fallback_estimate_counts_the_system_prompt(capture):
    """THE BUG THIS REPLACES. The estimate summed `messages` only — and the
    system prompt is a separate field, holding the craft references (~3k
    tokens) and the stage contract. So the largest input on most stages was
    excluded, and every plan cost recorded before this is understated by
    roughly that much.

    Reached whenever an endpoint ignores `stream_options`.
    """
    seen, fake = capture
    fake.events = openai_stream(text="out")     # no usage chunk at all
    _, meta = llm.complete(LONG, [{"role": "user", "content": "hi"}],
                           backend="openai-compat", model="gpt-5.6-luna")
    assert meta["estimated"] is True
    assert meta["tokens_in"] == (len(LONG) + len("hi")) // 4
    # The old arithmetic — messages alone — would have been 0.
    assert meta["tokens_in"] > 1000


def test_an_estimate_says_that_it_is_one(capture):
    """`estimated` is what separates a measured figure from a guessed one in
    the ledger. Without it a projection built on these rows cannot tell which
    of its inputs is real."""
    seen, fake = capture
    fake.events = openai_stream(usage={"prompt_tokens": 10, "completion_tokens": 2})
    _, real = llm.complete("s", [{"role": "user", "content": "hi"}],
                           backend="openai-compat")
    fake.events = openai_stream()
    _, est = llm.complete("s", [{"role": "user", "content": "hi"}],
                          backend="openai-compat")
    assert "estimated" not in real
    assert est["estimated"] is True


# ------------------------------------------------------- per-stage tally ----
def _meta():
    return {"cost_usd": 0.0, "tokens_in": 0, "tokens_out": 0,
            "cache_read": 0, "cache_write": 0, "estimated": False, "stages": {}}


def test_a_stage_that_runs_twice_is_added_up_not_overwritten():
    """Every validator in the planner may raise ONE batched re-ask, and the
    character voice pass runs once per speaker. Assigning instead of adding
    would report the last call as the whole stage — and it would understate
    exactly the per-character pass, which is the only set of calls a batch API
    could help. The measurement would then argue against the thing it was
    taken to evaluate."""
    meta = _meta()
    for _ in range(6):
        llm._tally(meta, "character",
                   {"tokens_in": 1000, "tokens_out": 200, "cost_usd": 0.001})
    st = meta["stages"]["character"]
    assert st["calls"] == 6
    assert st["in"] == 6000
    assert st["out"] == 1200
    assert meta["tokens_in"] == 6000


def test_one_estimated_call_marks_the_whole_plan_estimated():
    # A total that is part measured and part guessed is a guessed total, and a
    # projection built on it needs to know which it has.
    meta = _meta()
    llm._tally(meta, "writer", {"tokens_in": 9000, "tokens_out": 900})
    assert meta["estimated"] is False
    llm._tally(meta, "editor", {"tokens_in": 100, "tokens_out": 10, "estimated": True})
    assert meta["estimated"] is True


def test_missing_counts_do_not_poison_the_totals():
    # A backend that reports nothing (ollama on an old build) must contribute
    # zero rather than making the sum `None` — the totals go into a log line
    # and a ledger note, both of which would then fail at format time, inside
    # the try/except that wraps a finished plan.
    meta = _meta()
    llm._tally(meta, "voice", {"model": "x"})
    llm._tally(meta, "voice", {"tokens_in": None, "tokens_out": None})
    assert meta["tokens_in"] == 0 and meta["tokens_out"] == 0
    assert meta["stages"]["voice"]["calls"] == 2

"""Pipeline LLM fallback: a rate-limited backend must not cost a storyboard.

Every pipeline task funnels through llm.complete, so these cases are what
stands between a 429 on the subscription token and a red "Planning failed" in
the wizard. Mirrors api/director/_backends.test.mjs on the hosted side.
"""
import pytest

import llm


@pytest.fixture
def env(monkeypatch):
    """Everything configured, and Ollama's reachability probe answered without
    a socket (the real one is an HTTP call to the pod)."""
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "oauth")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "key")
    monkeypatch.setenv("OPENAI_API_KEY", "openai")
    monkeypatch.setattr(llm, "_ollama_reachable", lambda: False)
    return monkeypatch


def test_unconfigured_backends_are_skipped(monkeypatch):
    for k in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "openai")
    monkeypatch.setattr(llm, "_ollama_reachable", lambda: False)
    # Leading with the requested backend is deliberate: pick_backend already
    # validated it. What must not happen is queueing a Claude call with no key.
    assert llm.backend_chain("openai-compat") == ["openai-compat"]


def test_chain_leads_with_the_requested_backend(env):
    assert llm.backend_chain("claude-oauth") == ["claude-oauth", "claude-api", "openai-compat"]
    assert llm.backend_chain("openai-compat") == ["openai-compat", "claude-oauth", "claude-api"]


def test_claude_api_needs_its_own_key(monkeypatch):
    """With an OAuth token and no API key, claude-api is not a backend at all.

    It used to look configured (the check was "either credential"), joined the
    chain, and then raised "ANTHROPIC_API_KEY not set" the moment it was tried —
    a hard error that ended the chain before OpenAI ever got a turn.
    """
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "oauth")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "openai")
    monkeypatch.setattr(llm, "_ollama_reachable", lambda: False)
    assert llm.backend_chain("claude-oauth") == ["claude-oauth", "openai-compat"]


def test_a_backend_that_cannot_be_attempted_is_skipped_not_fatal(env, monkeypatch):
    """Belt and braces for the above: a credential error must not strand the
    job behind a provider that was never usable."""
    _mock_backends(monkeypatch, {
        "claude-oauth": llm.LLMError("ANTHROPIC_API_KEY not set"),
        "claude-api": llm.LLMError("ANTHROPIC_API_KEY not set"),
        "openai-compat": "planned anyway",
    })
    text, meta = llm.complete("sys", [{"role": "user", "content": "hi"}], backend="claude-oauth")
    assert (text, meta["backend"]) == ("planned anyway", "openai-compat")


def test_without_oauth_the_two_claude_ids_are_one_backend(env, monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    chain = llm.backend_chain("claude-oauth")
    assert chain.count("claude-api") == 0, "same key, same limit — not a fallback"
    assert "openai-compat" in chain


def test_ollama_joins_only_when_it_answers(env, monkeypatch):
    assert "ollama-local" not in llm.backend_chain("claude-oauth")
    monkeypatch.setattr(llm, "_ollama_reachable", lambda: True)
    assert llm.backend_chain("claude-oauth")[-1] == "ollama-local"


@pytest.mark.parametrize("msg", [
    "anthropic 429: {\"type\":\"rate_limit_error\"}", "openai 500: upstream",
    "anthropic 529: overloaded", "Ollama unreachable at http://127.0.0.1:11434",
    "read timed out",
])
def test_transient_failures_move_on(msg):
    assert llm.is_transient(llm.LLMError(msg)) is True


@pytest.mark.parametrize("msg", [
    "anthropic 400: messages: invalid role", "anthropic 401: invalid x-api-key",
    "openai 403: forbidden",
])
def test_permanent_failures_do_not(msg):
    assert llm.is_transient(llm.LLMError(msg)) is False


def test_error_text_becomes_a_sentence():
    assert llm.explain_error(llm.LLMError(
        'anthropic 429: {"type":"error","error":{"type":"rate_limit_error",'
        '"message":"Error"},"request_id":"req_011Cd"}')) == "rate limited (429)"
    assert llm.explain_error(llm.LLMError("anthropic 529: overloaded_error")) == "overloaded (529)"
    assert llm.explain_error(llm.LLMError("no episode on this project")) == "no episode on this project"


def _mock_backends(monkeypatch, outcomes, seen=None):
    """Each backend either raises its scripted error or returns text."""
    def fake(system, messages, *, backend, **kw):
        if seen is not None:
            seen.append(backend)
        out = outcomes[backend]
        if isinstance(out, Exception):
            raise out
        if kw.get("on_delta"):
            kw["on_delta"](out)
        return out, {"model": "m", "backend": backend, "tokens_in": 1,
                     "tokens_out": 1, "cost_usd": 0.0}
    monkeypatch.setattr(llm, "_complete_backend", fake)


def test_a_rate_limit_moves_to_the_next_backend(env, monkeypatch):
    seen, hops = [], []
    _mock_backends(monkeypatch, {
        "claude-oauth": llm.LLMError("anthropic 429: rate_limit_error"),
        "claude-api": llm.LLMError("anthropic 429: rate_limit_error"),
        "openai-compat": "the storyboard",
    }, seen)
    text, meta = llm.complete("sys", [{"role": "user", "content": "hi"}],
                              backend="claude-oauth",
                              on_fallback=lambda f, t, why: hops.append((f, t, why)))
    assert text == "the storyboard"
    assert meta["backend"] == "openai-compat"
    assert seen == ["claude-oauth", "claude-api", "openai-compat"]
    assert hops == [("claude-oauth", "claude-api", "rate limited (429)"),
                    ("claude-api", "openai-compat", "rate limited (429)")]


def test_a_bad_request_fails_immediately(env, monkeypatch):
    seen = []
    _mock_backends(monkeypatch, {
        "claude-oauth": llm.LLMError("anthropic 400: messages: invalid role"),
    }, seen)
    with pytest.raises(llm.LLMError):
        llm.complete("sys", [{"role": "user", "content": "hi"}], backend="claude-oauth")
    assert seen == ["claude-oauth"], "every provider would refuse this the same way"


def test_output_already_streamed_is_never_retried(env, monkeypatch):
    """Half a treatment has reached the caller; a second backend would append
    a different one to it."""
    seen, pieces = [], []

    def fake(system, messages, *, backend, **kw):
        seen.append(backend)
        kw["on_delta"]("half a sentence")
        raise llm.LLMError("anthropic 429: rate_limit_error")

    monkeypatch.setattr(llm, "_complete_backend", fake)
    with pytest.raises(llm.LLMError):
        llm.complete("sys", [{"role": "user", "content": "hi"}], backend="claude-oauth",
                     on_delta=pieces.append)
    assert seen == ["claude-oauth"]
    assert pieces == ["half a sentence"]


def test_a_cancel_is_not_a_provider_failure(env, monkeypatch):
    seen = []

    def fake(system, messages, *, backend, **kw):
        seen.append(backend)
        raise InterruptedError("llm canceled")

    monkeypatch.setattr(llm, "_complete_backend", fake)
    with pytest.raises(InterruptedError):
        llm.complete("sys", [{"role": "user", "content": "hi"}], backend="claude-oauth")
    assert seen == ["claude-oauth"], "a cancel must not spend another backend"


def test_a_failing_fallback_note_does_not_kill_the_job(env, monkeypatch):
    _mock_backends(monkeypatch, {
        "claude-oauth": llm.LLMError("anthropic 429: rate_limit_error"),
        "claude-api": "planned",
    })

    def boom(*_):
        raise RuntimeError("supabase down")

    text, _ = llm.complete("sys", [{"role": "user", "content": "hi"}],
                           backend="claude-oauth", on_fallback=boom)
    assert text == "planned"

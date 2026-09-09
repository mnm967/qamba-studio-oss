"""Pure-function tests for the director LLM module (no network, no DB)."""
import pytest

import llm


# ------------------------------------------------------------- json_repair ---
def test_repair_clean():
    assert llm.json_repair('{"a": 1}') == {"a": 1}


def test_repair_fenced_with_prose():
    text = 'Here is the plan:\n```json\n{"scenes": [1, 2]}\n```\nHope this helps!'
    assert llm.json_repair(text) == {"scenes": [1, 2]}


def test_repair_trailing_commas():
    assert llm.json_repair('{"a": [1, 2,], "b": {"c": 3,},}') == {"a": [1, 2], "b": {"c": 3}}


def test_repair_leading_junk_and_suffix():
    assert llm.json_repair('blah {"x": {"y": 2}} trailing words') == {"x": {"y": 2}}


def test_repair_hopeless_raises():
    with pytest.raises(llm.LLMError):
        llm.json_repair("no json here at all")


def test_repair_passthrough_dict():
    assert llm.json_repair({"k": 1}) == {"k": 1}


# ------------------------------------------------------- normalize + fit -----
def _plan(durations_by_scene):
    return {
        "title": "T",
        "characters": [{"name": "Rei", "identity_line": "x"}],
        "environments": [{"name": "Rooftop", "palette": "p"}],
        "scenes": [
            {"slug": f"s{i}", "environment": "Rooftop", "cast": ["Rei"],
             "beats": [{"duration_ms": d, "action": f"beat {j}", "camera": "wide"}
                       for j, d in enumerate(ds)]}
            for i, ds in enumerate(durations_by_scene)
        ],
    }


def test_normalize_fits_target():
    data = llm.normalize_storyboard(_plan([[4000, 4000], [4000, 4000]]), target_ms=32000)
    total = sum(b["duration_ms"] for s in data["scenes"] for b in s["beats"])
    assert abs(total - 32000) <= 1000  # 250ms rounding per beat
    for s in data["scenes"]:
        for b in s["beats"]:
            assert 1500 <= b["duration_ms"] <= 14000
            assert b["duration_ms"] % 250 == 0


def test_normalize_slug_and_dialogue_cleanup():
    p = _plan([[4000]])
    p["scenes"][0]["slug"] = "my cool scene name that is way too long"
    p["scenes"][0]["beats"][0]["dialogue"] = [
        {"speaker": "Rei", "line": "hi"}, {"bogus": True}, "junk"]
    data = llm.normalize_storyboard(p, target_ms=None)
    s = data["scenes"][0]
    assert " " not in s["slug"] and len(s["slug"]) <= 24 and s["slug"].isupper()
    assert s["beats"][0]["dialogue"] == [{"speaker": "Rei", "line": "hi"}]


def test_normalize_rejects_empty_scenes():
    with pytest.raises(llm.LLMError):
        llm.normalize_storyboard({"scenes": []})
    with pytest.raises(llm.LLMError):
        llm.normalize_storyboard({"scenes": [{"slug": "a", "beats": []}]})
    with pytest.raises(llm.LLMError):
        llm.normalize_storyboard(
            {"scenes": [{"slug": "a", "beats": [{"duration_ms": 4000, "action": " "}]}]})


def test_fit_scales_down_and_clamps():
    data = llm.normalize_storyboard(_plan([[14000, 14000, 14000]]), target_ms=15000)
    total = sum(b["duration_ms"] for s in data["scenes"] for b in s["beats"])
    assert total <= 16500
    assert all(b["duration_ms"] >= 1500 for s in data["scenes"] for b in s["beats"])


# ------------------------------------------------------------ backend pick ---
def test_pick_backend_env_order(monkeypatch):
    for var in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    assert llm.pick_backend() == "ollama-local"
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    assert llm.pick_backend() == "openai-compat"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    assert llm.pick_backend() == "claude-api"
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "t")
    assert llm.pick_backend() == "claude-oauth"


def test_pick_backend_explicit_requires_config(monkeypatch):
    for var in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(llm.LLMError):
        llm.pick_backend(payload={"backend": "claude-oauth"})
    with pytest.raises(llm.LLMError):
        llm.pick_backend(payload={"backend": "openai-compat"})
    assert llm.pick_backend(payload={"backend": "ollama-local"}) == "ollama-local"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    assert llm.pick_backend(job={"model_id": "claude-api"}) == "claude-api"


# ------------------------------------------------------- builtin knowledge ---
def test_builtin_knowledge_reads_repo_docs():
    txt = llm.builtin_knowledge("music_video")
    assert "beat-writing craft" in txt
    assert "Music video craft" in txt
    assert "Music video craft" not in llm.builtin_knowledge("film")


# --- rate-limit retry ---------------------------------------------------------
# A subscription token 429s routinely and these calls front jobs that are
# expensive to redo, so a single rate limit must not lose the job.
class _Resp:
    def __init__(self, code, headers=None, text=""):
        self.status_code, self.headers, self.text = code, headers or {}, text

    def close(self):
        pass


def _patch(monkeypatch, codes, sleeps):
    import llm
    seen = iter(codes)
    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: next(seen))
    monkeypatch.setattr(llm.time, "sleep", lambda s: sleeps.append(s))
    return llm


def test_retries_429_then_succeeds(monkeypatch):
    sleeps = []
    llm = _patch(monkeypatch, [_Resp(429), _Resp(429), _Resp(200)], sleeps)
    r = llm._post_retrying("u", headers={}, body={}, timeout=1)
    assert r.status_code == 200
    assert sum(sleeps) == 2 + 4          # backoff doubled, one second at a time


def test_honours_retry_after(monkeypatch):
    sleeps = []
    llm = _patch(monkeypatch, [_Resp(429, {"retry-after": "7"}), _Resp(200)], sleeps)
    assert llm._post_retrying("u", headers={}, body={}, timeout=1).status_code == 200
    assert sum(sleeps) == 7              # server's number wins over our backoff


def test_does_not_retry_auth_errors(monkeypatch):
    sleeps = []
    llm = _patch(monkeypatch, [_Resp(401, text="revoked")], sleeps)
    r = llm._post_retrying("u", headers={}, body={}, timeout=1)
    assert r.status_code == 401 and sleeps == []   # a human has to fix this


def test_gives_up_and_returns_last_response(monkeypatch):
    sleeps = []
    llm = _patch(monkeypatch, [_Resp(429)] * (5), sleeps)
    r = llm._post_retrying("u", headers={}, body={}, timeout=1)
    assert r.status_code == 429          # caller raises with the real status


def test_cancel_interrupts_backoff(monkeypatch):
    import pytest
    sleeps = []
    llm = _patch(monkeypatch, [_Resp(429), _Resp(200)], sleeps)
    with pytest.raises(llm.LLMError, match="canceled"):
        llm._post_retrying("u", headers={}, body={}, timeout=1, cancel_check=lambda: True)

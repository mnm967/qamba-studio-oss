"""Tool loop for the local director.

Ollama is not reachable from CI, so the transport is faked and the loop is
what gets tested: does a tool call actually execute, do results go back into
the conversation, does it stop.
"""
import json
import sys

import pytest


@pytest.fixture
def llm(monkeypatch):
    import llm as mod
    return mod


class _R:
    def __init__(self, payload): self.status_code, self._p = 200, payload
    def json(self): return self._p
    @property
    def text(self): return json.dumps(self._p)
    def close(self): pass


def _turns(monkeypatch, llm, seq):
    """Feed the loop a scripted list of Ollama /api/chat responses."""
    it = iter(seq)
    monkeypatch.setattr(llm, "_post_retrying", lambda *a, **k: _R({"message": next(it),
                                                                  "prompt_eval_count": 3,
                                                                  "eval_count": 5}))


def test_executes_a_tool_then_answers(monkeypatch, llm):
    _turns(monkeypatch, llm, [
        {"role": "assistant", "content": "",
         "tool_calls": [{"function": {"name": "update_bible_entry",
                                      "arguments": {"kind": "character", "name": "Scarlet Vale"}}}]},
        {"role": "assistant", "content": "Added Scarlet Vale as a draft."},
    ])
    ran = []
    text, meta = llm.complete_with_tools(
        "sys", [{"role": "user", "content": "add a redhead"}],
        backend="ollama-local", tools=[{"x": 1}],
        execute=lambda n, a, c: ran.append((n, a)) or {"created_entry_id": "e1"},
        ctx={"project_id": "p1"})
    assert ran == [("update_bible_entry", {"kind": "character", "name": "Scarlet Vale"})]
    assert text == "Added Scarlet Vale as a draft."
    assert [c["name"] for c in meta["tool_calls"]] == ["update_bible_entry"]


def test_tool_result_reaches_the_next_turn(monkeypatch, llm):
    seen = {}
    calls = iter([
        {"role": "assistant", "content": "",
         "tool_calls": [{"function": {"name": "get_project_state", "arguments": {}}}]},
        {"role": "assistant", "content": "done"},
    ])

    def fake(url, *, headers, body, timeout, cancel_check=None, label=""):
        seen["last"] = body["messages"]
        return _R({"message": next(calls), "prompt_eval_count": 1, "eval_count": 1})

    monkeypatch.setattr(llm, "_post_retrying", fake)
    llm.complete_with_tools("sys", [{"role": "user", "content": "hi"}],
                            backend="ollama-local", tools=[{"x": 1}],
                            execute=lambda n, a, c: {"project": {"title": "Shattered Skies"}},
                            ctx={})
    roles = [m["role"] for m in seen["last"]]
    assert "tool" in roles                       # the result was fed back
    assert any("Shattered Skies" in (m.get("content") or "") for m in seen["last"])


def test_string_arguments_are_parsed(monkeypatch, llm):
    # OpenAI-compatible servers send arguments as a JSON string, not a dict.
    _turns(monkeypatch, llm, [
        {"role": "assistant", "content": "",
         "tool_calls": [{"function": {"name": "search_assets", "arguments": '{"kind":"image"}'}}]},
        {"role": "assistant", "content": "ok"},
    ])
    got = []
    llm.complete_with_tools("s", [{"role": "user", "content": "x"}],
                            backend="ollama-local", tools=[{"x": 1}],
                            execute=lambda n, a, c: got.append(a) or {}, ctx={})
    assert got == [{"kind": "image"}]


def test_stops_after_max_rounds(monkeypatch, llm):
    forever = {"role": "assistant", "content": "",
               "tool_calls": [{"function": {"name": "get_project_state", "arguments": {}}}]}
    seq = [forever] * 3 + [{"role": "assistant", "content": "forced answer"}] + [forever] * 5
    _turns(monkeypatch, llm, seq)
    n = []
    text, meta = llm.complete_with_tools("s", [{"role": "user", "content": "x"}],
                                         backend="ollama-local", tools=[{"x": 1}],
                                         execute=lambda a, b, c: n.append(1) or {}, ctx={},
                                         max_rounds=3)
    assert len(n) == 3                 # bounded, not infinite
    assert text == "forced answer"     # and it still produced prose


def test_empty_forced_turn_still_reports_what_ran(monkeypatch, llm):
    """A small model can return a blank final turn. The work really happened,
    so say what it was instead of showing an empty message."""
    forever = {"role": "assistant", "content": "",
               "tool_calls": [{"function": {"name": "retake_block", "arguments": {}}}]}
    _turns(monkeypatch, llm, [forever] * 8)
    text, meta = llm.complete_with_tools("s", [{"role": "user", "content": "x"}],
                                         backend="ollama-local", tools=[{"x": 1}],
                                         execute=lambda *a: {"job_id": "j1"}, ctx={},
                                         max_rounds=2)
    assert "retake_block" in text and text.strip()
    assert len(meta["tool_calls"]) == 2


def test_non_ollama_backend_falls_back_to_plain_completion(monkeypatch, llm):
    monkeypatch.setattr(llm, "complete", lambda *a, **k: ("plain", {"model": "m"}))
    text, meta = llm.complete_with_tools("s", [{"role": "user", "content": "x"}],
                                         backend="claude-oauth", tools=[{"x": 1}],
                                         execute=lambda *a: {}, ctx={})
    assert text == "plain" and meta["tool_calls"] == []


def test_tool_errors_do_not_kill_the_turn():
    import director_tools
    # sb is unconfigured in tests, so this raises inside and must come back as
    # data the model can read rather than an exception.
    out = director_tools.execute("get_project_state", {}, {"project_id": "p1"})
    assert isinstance(out, dict)
    assert "error" in out or "project" in out


def test_unknown_tool_is_reported():
    import director_tools
    assert "unknown tool" in director_tools.execute("nope", {}, {})["error"]


def test_truncate_caps_context():
    import director_tools
    big = director_tools.truncate({"x": "y" * 20000}, limit=500)
    assert len(big) < 600 and "truncated" in big


def test_schemas_are_wellformed():
    import director_tools
    for s in director_tools.SCHEMAS:
        f = s["function"]
        assert f["name"] and f["description"]
        assert f["parameters"]["type"] == "object"
        for r in f["parameters"]["required"]:
            assert r in f["parameters"]["properties"], f"{f['name']}: {r} not declared"

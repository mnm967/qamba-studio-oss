"""The write journal in sb.py — the Python twin of director/changes.js.

A director turn's edits are recorded so the dock can put them back. Every
failure here is quiet: an update journaled AFTER the write restores the value
it just set, the chat row's own paints journaled would put the transcript on
the revert list, and a journal that stays open leaks one turn's writes into
the next.
"""
import json

import pytest

import sb


class _Resp:
    def __init__(self, body):
        self._body = body
        self.status_code = 200

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


@pytest.fixture
def wire(monkeypatch):
    """A fake `requests` that answers reads from a table and records writes."""
    calls = {"get": [], "patch": [], "post": [], "delete": []}
    rows = {"beats": [{"id": "bt1", "idx": 0, "meta": {"cast": ["A"]}, "action": "old"}]}

    def get(url, headers=None, timeout=None):
        path = url.split("/rest/v1/")[1]
        calls["get"].append(path)
        table = path.split("?")[0]
        return _Resp(list(rows.get(table, [])))

    def patch(url, headers=None, data=None, timeout=None):
        calls["patch"].append((url.split("/rest/v1/")[1], json.loads(data)))
        return _Resp([])

    def post(url, headers=None, data=None, timeout=None):
        path = url.split("/rest/v1/")[1]
        body = json.loads(data)
        calls["post"].append((path, body))
        return _Resp([{"id": "new-1", **body}])

    def delete(url, headers=None, timeout=None):
        calls["delete"].append(url.split("/rest/v1/")[1])
        return _Resp(None)

    monkeypatch.setattr(sb.requests, "get", get)
    monkeypatch.setattr(sb.requests, "patch", patch)
    monkeypatch.setattr(sb.requests, "post", post)
    monkeypatch.setattr(sb.requests, "delete", delete)
    sb.journal_end()                      # never inherit a journal from another test
    return calls


def test_an_update_is_journaled_by_reading_the_touched_columns_first(wire):
    sb.journal_begin()
    sb.patch("beats?id=eq.bt1", {"meta": {"cast": ["B"]}})
    ops = sb.journal_end()
    assert ops == [{"op": "update", "table": "beats", "keys": ["meta"],
                    "before": [{"id": "bt1", "idx": 0, "meta": {"cast": ["A"]}, "action": "old"}]}]
    # the read carried the touched column and came BEFORE the write
    assert wire["get"] == ["beats?id=eq.bt1&select=id,entry_id,asset_id,collection_id,meta"]
    assert wire["patch"] == [("beats?id=eq.bt1", {"meta": {"cast": ["B"]}})]


def test_inserts_and_deletes_are_journaled_with_what_a_revert_needs(wire):
    sb.journal_begin()
    sb.insert("jobs", {"kind": "master_pass"})
    sb.delete("beats?id=eq.bt1")
    ops = sb.journal_end()
    assert ops[0] == {"op": "insert", "table": "jobs", "id": "new-1"}
    assert ops[1]["op"] == "delete" and ops[1]["rows"][0]["id"] == "bt1"


def test_the_chat_row_is_never_journaled(wire):
    """The turn paints its own row on every delta; journaling that would cost
    a read per paint and put the transcript itself on the revert list."""
    sb.journal_begin()
    sb.patch("chat_messages?id=eq.m1", {"content": []})
    assert sb.journal_end() == []
    assert wire["get"] == [], "no pre-read either"


def test_nothing_is_recorded_or_read_extra_without_an_open_journal(wire):
    sb.patch("beats?id=eq.bt1", {"meta": {}})
    assert wire["get"] == []
    assert sb.journal_end() == []


def test_an_unbounded_write_is_recorded_as_such_rather_than_reading_a_table(wire):
    sb.journal_begin()
    sb.patch("beats", {"meta": {}})
    ops = sb.journal_end()
    assert ops == [{"op": "update", "table": "beats", "unbounded": True}]
    assert wire["get"] == []


def test_the_journal_closes_even_when_the_turn_dies():
    """llm.chat wraps the tool loop in try/finally; a journal left open would
    leak this turn's writes into the next one on the same worker."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1] / "llm.py").read_text()
    at = src.index("sb.journal_begin()")
    assert "finally:" in src[at:at + 900] and "sb.journal_end()" in src[at:at + 900]

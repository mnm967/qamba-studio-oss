"""Re-planning an episode numbers the new plan instead of retiring the old one.

`plan_storyboard` has always INSERTED a storyboards row, and every reader takes
the newest — so the previous plan kept its scenes, beats and generation_blocks
and simply became unreachable from the UI. Measured before the fix: four
episodes carried more than one board, one of them with 20 scenes and 31 blocks
split across two.

`(episode_id, version)` is unique, which turns a race into a loud 409 rather
than two boards claiming the same number. The insert happens after every LLM
stage has run, so that 409 has to be retried, not raised.
"""
import requests

import llm


class FakeSB:
    """Just enough of worker/sb.py: a version list and a conflict-aware insert."""

    def __init__(self, versions=(), fail_first=0):
        self.versions = list(versions)
        self.fail_first = fail_first
        self.inserted = []
        self.gets = 0

    def get(self, path):
        self.gets += 1
        assert "storyboards?episode_id=eq." in path, path
        assert "order=version.desc" in path, "must read the MAX, not an arbitrary row"
        return [{"version": max(self.versions)}] if self.versions else []

    def insert(self, table, body):
        assert table == "storyboards"
        if self.fail_first > 0:
            self.fail_first -= 1
            # Whatever the caller computed is "already taken": model the race by
            # letting someone else win that number.
            self.versions.append(body["version"])
            resp = requests.Response()
            resp.status_code = 409
            raise requests.HTTPError("duplicate key", response=resp)
        self.versions.append(body["version"])
        self.inserted.append(body)
        return {"id": f"sb-{body['version']}", **body}


def _with_sb(monkeypatch, fake):
    monkeypatch.setattr(llm, "sb", fake)
    monkeypatch.setattr(llm, "log", lambda *a, **k: None)
    return fake


def test_the_first_plan_for_an_episode_is_v1(monkeypatch):
    fake = _with_sb(monkeypatch, FakeSB())
    row = llm.insert_storyboard("ep-1", {"status": "review"})
    assert row["version"] == 1
    assert fake.inserted[0]["episode_id"] == "ep-1"


def test_a_replan_takes_the_next_number_and_deletes_nothing(monkeypatch):
    fake = _with_sb(monkeypatch, FakeSB(versions=[1, 2]))
    row = llm.insert_storyboard("ep-1", {"status": "review"})
    assert row["version"] == 3
    # The point of the whole change: the earlier plans are still there.
    assert fake.versions == [1, 2, 3]


def test_a_collision_retries_rather_than_losing_a_plan(monkeypatch):
    """The insert lands after writer, editor, voice, blocking and
    cinematographer have all run. Raising on a unique-index conflict would
    throw away minutes of generation over a number."""
    fake = _with_sb(monkeypatch, FakeSB(versions=[1], fail_first=1))
    row = llm.insert_storyboard("ep-1", {"status": "review"})
    assert row["version"] == 3          # 2 was taken mid-flight
    assert fake.gets == 2               # it re-read the max instead of guessing


def test_a_non_conflict_error_is_not_swallowed(monkeypatch):
    class Broken(FakeSB):
        def insert(self, table, body):
            resp = requests.Response()
            resp.status_code = 500
            raise requests.HTTPError("boom", response=resp)

    _with_sb(monkeypatch, Broken())
    try:
        llm.insert_storyboard("ep-1", {})
    except requests.HTTPError as e:
        assert e.response.status_code == 500
    else:                                # pragma: no cover
        raise AssertionError("a 500 must reach the caller")


def test_fields_the_caller_passes_survive(monkeypatch):
    fake = _with_sb(monkeypatch, FakeSB())
    llm.insert_storyboard("ep-9", {"status": "approved", "brief": {"title": "X"},
                                   "audio_meta": {"bpm": 92}})
    body = fake.inserted[0]
    assert body["status"] == "approved" and body["brief"] == {"title": "X"}
    assert body["audio_meta"] == {"bpm": 92} and body["version"] == 1

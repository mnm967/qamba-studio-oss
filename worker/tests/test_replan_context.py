"""A re-plan is a REVISION, so the planner has to be shown what it is revising.

`plan_storyboard` inserts a new storyboard version rather than editing the one
on screen (test_storyboard_versions.py), and it had no idea a previous version
existed — so "cut the training scene" reached a writer that had never seen a
training scene, and the note could only ever be applied by accident.

Two halves, and the second is the one that fails silently: the outline has to
be READ (bounded, and honest about what it dropped), and it has to reach the
WRITER's brief. Everything downstream of the writer receives the story object,
not the brief, so a note wired into the wrong stage argues with a plan that has
already ignored it.
"""
import inspect
import json

import llm


class FakeSB:
    """Just the two reads previous_plan_outline makes."""

    def __init__(self, scenes, beats):
        self.scenes, self.beats = scenes, beats
        self.paths = []

    def get(self, path):
        self.paths.append(path)
        if path.startswith("scenes?"):
            return self.scenes
        if path.startswith("beats?"):
            ids = path.split("scene_id=in.(", 1)[1].split(")", 1)[0].split(",")
            return [b for b in self.beats if b["scene_id"] in ids]
        raise AssertionError(path)


def _scene(i, slug, **kw):
    return {"id": f"s{i}", "idx": i, "slug": slug, "duration_ms": 16500,
            "scene_prompt": f"purpose of {slug}", "meta": {"type": "dialogue"}, **kw}


def _beat(scene_id, i, **kw):
    return {"scene_id": scene_id, "idx": i, "camera": "medium push-in",
            "action": f"action {i}", "dialogue": None, **kw}


def _outline(monkeypatch, scenes, beats, **kw):
    fake = FakeSB(scenes, beats)
    monkeypatch.setattr(llm, "sb", fake)
    monkeypatch.setattr(llm, "log", lambda *a, **k: None)
    return llm.previous_plan_outline("sb-1", **kw), fake


def test_the_outline_carries_every_scene_and_its_beats(monkeypatch):
    out, fake = _outline(
        monkeypatch,
        [_scene(0, "BORROWED_SKY"), _scene(1, "PORTAL_WAIT")],
        [_beat("s0", 0), _beat("s0", 1), _beat("s1", 0)])
    assert [s["slug"] for s in out["scenes"]] == ["BORROWED_SKY", "PORTAL_WAIT"]
    assert len(out["scenes"][0]["beats"]) == 2
    assert out["scenes"][0]["purpose"] == "purpose of BORROWED_SKY"
    assert out["scenes"][0]["seconds"] == 16.5
    # One batched read for the beats, not one per scene: a 16-scene episode
    # would otherwise open the plan with 17 round trips.
    assert sum(p.startswith("beats?") for p in fake.paths) == 1


def test_scenes_are_read_in_order(monkeypatch):
    _, fake = _outline(monkeypatch, [_scene(0, "A")], [])
    assert "order=idx" in fake.paths[0], "an out-of-order outline misnames the ending"


def test_dialogue_rides_along_but_bounded(monkeypatch):
    lines = [{"speaker": "REI", "line": f"line {i}"} for i in range(6)]
    out, _ = _outline(monkeypatch, [_scene(0, "A")],
                      [_beat("s0", 0, dialogue=lines)])
    assert out["scenes"][0]["beats"][0]["dialogue"] == [
        "REI: line 0", "REI: line 1", "REI: line 2"]


def test_a_truncated_outline_says_so(monkeypatch):
    """A list that looks complete is how "make the ending land harder" gets
    applied to a scene that is no longer the ending."""
    scenes = [_scene(i, f"S{i}") for i in range(5)]
    beats = [_beat("s0", i) for i in range(5)]
    out, _ = _outline(monkeypatch, scenes, beats, max_scenes=2, max_beats=2)
    assert len(out["scenes"]) == 2
    assert out["scenes_omitted"] == 3
    assert out["scenes"][0]["beats_omitted"] == 3


def test_a_board_with_no_scenes_is_none_not_an_empty_plan(monkeypatch):
    """An empty outline shown to the writer claims the previous version had
    nothing in it — worse than showing none at all."""
    out, _ = _outline(monkeypatch, [], [])
    assert out is None


# --- the wiring ------------------------------------------------------------
# plan_storyboard needs a database, an LLM and a pod, so it is read rather than
# run — the same treatment test_draft_session.py and test_planner_grounding.py
# give it.
SRC = inspect.getsource(llm.plan_storyboard)


def test_the_revision_reaches_the_writers_brief():
    head = SRC.split("brief_json = json.dumps(", 1)[0]
    assert "previous_plan_outline(payload[\"revise_of\"])" in head, \
        "the outline must be read BEFORE the brief it goes into"
    body = SRC.split("brief_json = json.dumps(", 1)[1].split("ensure_ascii", 1)[0]
    assert "previous_version" in body and "revision_request" in body


def test_a_missing_previous_board_does_not_fail_the_plan():
    """Writing from the brief alone is a worse plan; raising is no plan."""
    assert "except Exception as e:  # noqa: BLE001 — context is an enrichment" in SRC


def test_the_new_version_records_what_it_was_asked_to_be():
    tail = SRC.split("insert_storyboard(ep_id, {", 1)[1].split("log(", 1)[0]
    assert "revise_of" in tail and "revision_note" in tail


# --- the note has to reach the CINEMATOGRAPHER too ---------------------------
# The first real re-plan is the evidence: the note asked for "(pov shot)" and
# "fly past camera", and both came back as ordinary coverage — because the
# writer, who is forbidden camera language, was the only stage ever shown one.
import storyplan  # noqa: E402


STORY = {"world": {"era": "now"},
         "characters": [{"name": "Miko", "identity_line": "…", "role": "lead"}],
         "scenes": [{"slug": "MEMORY_OPENING", "beats": []},
                    {"slug": "PORTAL_WAIT", "beats": []}]}


def test_the_dp_is_shown_the_note_and_told_it_owns_the_camera_words():
    msgs = storyplan.cine_messages(STORY, {"MEMORY_OPENING"},
                                   "miko looks at astronaut (pov shot)")
    assert len(msgs) == 2, "the note is its own message, not spliced into the story JSON"
    body = msgs[1]["content"]
    assert "pov shot" in body
    assert "camera instruction addressed to you" in body
    # The story is locked at this stage — the DP must not start writing events.
    assert "do not add or remove" in body


def test_no_note_means_no_extra_message():
    """Every non-revision plan must reach the DP exactly as it did before."""
    assert len(storyplan.cine_messages(STORY, {"MEMORY_OPENING"})) == 1
    assert len(storyplan.cine_messages(STORY, {"MEMORY_OPENING"}, "   ")) == 1


def test_the_dp_only_sees_the_scenes_in_its_batch():
    """The note rides along per batch; it must not widen the scene slice."""
    doc = json.loads(storyplan.cine_messages(STORY, {"MEMORY_OPENING"}, "note")[0]["content"])
    assert [s["slug"] for s in doc["scenes"]] == ["MEMORY_OPENING"]


def test_run_pipeline_threads_the_note_to_both_dp_calls():
    src = inspect.getsource(storyplan.run_pipeline)
    # The first pass AND the coverage re-ask: fixing only one leaves the
    # repair silently reverting the shots the note asked for.
    assert src.count("cine_messages(story, set(batch), revision_note)") == 1
    assert src.count("cine_messages(story, set(issues), revision_note)") == 1


def test_plan_storyboard_passes_it_in():
    assert "revision_note=revision_note" in SRC

"""Editing the storyboard by chat, on the worker side.

The wizard's storyboard step is now a chat, so "cut S3 to 20 seconds" has to
become a row change — and the blocks planned from the old scene have to stop
claiming they are current, or a render reproduces the version the user just
changed. Twin of the update_scene / update_beat handlers in
api/director/chat.js.
"""
import pytest

import director_tools as dt


S1 = "11111111-1111-4111-8111-111111111111"      # uuid-shaped: the tools take ids
SA = "22222222-2222-4222-8222-222222222222"
S0 = "33333333-3333-4333-8333-333333333333"
B1 = "44444444-4444-4444-8444-444444444444"
B2 = "55555555-5555-4555-8555-555555555555"


@pytest.fixture
def db(monkeypatch):
    """A tiny fake Supabase: records writes, answers the lookups the tools do."""
    state = {
        "patches": [], "inserts": [], "deletes": [],
        "scenes": [{"id": S1, "storyboard_id": "sb1", "idx": 2}],
        "beats": [{"id": B1, "scene_id": S1, "idx": 0}],
        "entries": {("character", "leon"): "leon-id", ("environment", "the bar"): "bar-id"},
        # the storyboard's full scene list: resequencing *and* label lookup
        "siblings": [{"id": S0, "storyboard_id": "sb1", "idx": 0, "slug": "OPEN"},
                     {"id": SA, "storyboard_id": "sb1", "idx": 1, "slug": "MIDDLE"},
                     {"id": S1, "storyboard_id": "sb1", "idx": 2, "slug": "FIGHT_IN_ALLEY"}],
        # scene_id included because the real query selects it — the handler
        # needs it to find the storyboard whose blocks go stale.
        "beat_siblings": [{"id": B1, "scene_id": S1, "idx": 0},
                          {"id": B2, "scene_id": S1, "idx": 1}],
    }

    def fake_get(path):
        if path.startswith("scenes?storyboard_id="):
            if "idx=gt." in path:
                cut = int(path.split("idx=gt.")[1].split("&")[0])
                return [x for x in state["siblings"] if x["idx"] > cut]
            return state["siblings"]
        if path.startswith("beats?scene_id="):
            return state["beat_siblings"]
        if path.startswith(f"scenes?id=eq.{S1}"):
            return state["scenes"]
        if path.startswith(f"beats?id=eq.{B1}"):
            return state["beats"]
        if path.startswith("scenes?id=eq.") or path.startswith("beats?id=eq."):
            return []
        if path.startswith("episodes?"):
            return [{"id": "ep1"}]
        if path.startswith("storyboards?"):
            return [{"id": "sb1"}]
        if path.startswith("bible_entries?"):
            kind = "character" if "kind=eq.character" in path else "environment"
            name = path.split("name=ilike.")[1].split("&")[0].lower()
            hit = state["entries"].get((kind, name))
            return [{"id": hit}] if hit else []
        return []

    def fake_insert(table, body):
        state["inserts"].append((table, body))
        return {"id": f"new-{table}-{len(state['inserts'])}", **body}

    monkeypatch.setattr(dt.sb, "get", fake_get)
    monkeypatch.setattr(dt.sb, "patch", lambda path, body: state["patches"].append((path, body)))
    monkeypatch.setattr(dt.sb, "insert", fake_insert)
    monkeypatch.setattr(dt.sb, "delete", lambda path: state["deletes"].append(path))
    return state


def test_a_scene_edit_lands_and_marks_its_blocks_stale(db):
    out = dt.execute("update_scene", {"scene_id": S1, "slug": "FIGHT_IN_ALLEY",
                                      "duration_ms": 20000}, {"project_id": "p"})
    assert out["updated_scene_id"] == S1
    assert out["changed"] == ["duration_ms", "slug"]
    scene_patch = next(b for p, b in db["patches"] if p.startswith(f"scenes?id=eq.{S1}"))
    assert scene_patch == {"slug": "FIGHT_IN_ALLEY", "duration_ms": 20000}
    # The blocks were planned from the old scene.
    blocks = next((p, b) for p, b in db["patches"] if p.startswith("generation_blocks?"))
    assert f"scene_ids=cs.{{{S1}}}" in blocks[0] and blocks[1] == {"status": "stale"}
    assert "stale" in out["note"]


def test_cast_is_addressed_by_name_and_unknown_names_are_reported(db):
    out = dt.execute("update_scene", {"scene_id": S1, "cast_names": ["Leon", "Ghost"],
                                      "environment_name": "The bar"}, {"project_id": "p"})
    patch = next(b for p, b in db["patches"] if p.startswith(f"scenes?id=eq.{S1}"))
    assert patch["cast_ids"] == ["leon-id"]          # Ghost is not in the bible
    assert patch["environment_id"] == "bar-id"
    assert out["not_in_bible"] == ["Ghost"]          # said, not silently dropped


def test_a_scene_cannot_be_cut_below_its_own_shots(db):
    """The floor is the SHOTS, not a flat 1000ms.

    It was a flat second while the scene's duration was a free-standing number
    — and that was the bug: `planner.plan_blocks` reads beat durations only, so
    the clamp guarded a field the render path never sees. Now the request
    retimes the beats, so the smallest a scene can be is its beat count times
    the shot floor (two beats here).
    """
    dt.execute("update_scene", {"scene_id": S1, "duration_ms": 10}, {"project_id": "p"})
    patch = next(b for p, b in db["patches"] if p.startswith(f"scenes?id=eq.{S1}"))
    assert patch["duration_ms"] == 2 * dt.BEAT_MIN_MS
    # …and the beats really were rewritten, not just the scene row.
    beats = [b for p, b in db["patches"] if p.startswith("beats?id=eq.")]
    assert [b["duration_ms"] for b in beats] == [dt.BEAT_MIN_MS, dt.BEAT_MIN_MS]


def test_dialogue_is_stored_with_the_speaker_resolved(db):
    dt.execute("update_beat", {"beat_id": B1, "action": "Leon sets the glass down",
                               "dialogue": [{"speaker": "Leon", "line": "It always lurks.",
                                             "delivery": "flat"}]},
               {"project_id": "p"})
    patch = next(b for p, b in db["patches"] if p.startswith(f"beats?id=eq.{B1}"))
    assert patch["action"] == "Leon sets the glass down"
    assert patch["dialogue"] == [{"speaker_id": "leon-id", "speaker": "Leon",
                                  "line": "It always lurks.", "delivery": "flat"}]


def test_an_empty_edit_is_refused_rather_than_written(db):
    assert "error" in dt.execute("update_scene", {"scene_id": S1}, {"project_id": "p"})
    assert "error" in dt.execute("update_beat", {"beat_id": B1}, {"project_id": "p"})
    assert not db["patches"]


def test_a_missing_row_is_an_error_not_a_crash(db):
    assert dt.execute("update_scene", {"scene_id": "nope"}, {"project_id": "p"})["error"]
    assert dt.execute("update_beat", {"beat_id": "nope"}, {"project_id": "p"})["error"]


@pytest.mark.parametrize("name", ["update_scene", "update_beat"])
def test_the_tools_are_offered_to_the_model(name):
    assert name in dt.TOOL_NAMES


def test_a_new_scene_shifts_the_ones_after_it(db):
    """(storyboard_id, idx) has to stay unique, so the shift runs back to front —
    doing it forwards collides with the row it is about to move."""
    out = dt.execute("add_scene", {
        "after_scene_id": S1, "slug": "NEW_SCENE",
        "cast_names": ["Leon"], "environment_name": "The bar",
        "beats": [{"action": "Leon steps into the rain", "duration_ms": 5000}],
    }, {"project_id": "p"})
    assert out["idx"] == 3 and out["beats"] == 1
    scene = next(b for t, b in db["inserts"] if t == "scenes")
    assert scene["idx"] == 3 and scene["cast_ids"] == ["leon-id"]
    assert scene["environment_id"] == "bar-id"
    assert scene["duration_ms"] == 5000            # summed from the beats
    beat = next(b for t, b in db["inserts"] if t == "beats")
    assert beat["idx"] == 0 and beat["action"] == "Leon steps into the rain"
    # ...and the whole block plan is stale, since blocks span scenes.
    assert any("generation_blocks" in p and b == {"status": "stale"} for p, b in db["patches"])


def test_a_scene_without_beats_is_refused(db):
    assert "error" in dt.execute("add_scene", {"slug": "EMPTY", "beats": []}, {"project_id": "p"})
    assert not db["inserts"]


def test_deleting_a_scene_closes_the_gap(db):
    out = dt.execute("delete_scene", {"scene_id": S1}, {"project_id": "p"})
    assert out["deleted_scene_id"] == S1
    assert db["deletes"] == [f"scenes?id=eq.{S1}"]
    # s1 was idx 2 and nothing followed it here, so nothing to resequence.
    assert out["resequenced"] == 0


def test_the_last_beat_of_a_scene_cannot_be_deleted(db):
    db["beat_siblings"] = [{"id": B1, "scene_id": S1, "idx": 0}]
    out = dt.execute("delete_beat", {"beat_id": B1}, {"project_id": "p"})
    assert "at least one beat" in out["error"]
    assert not db["deletes"]


def test_a_beat_can_be_inserted_mid_scene(db):
    out = dt.execute("add_beat", {"scene_id": S1, "after_beat_id": B1,
                                  "action": "the door closes"}, {"project_id": "p"})
    assert out["idx"] == 1
    # b2 was at 1 and has to move out of the way.
    assert (f"beats?id=eq.{B2}", {"idx": 2}) in db["patches"]


def test_a_scene_can_be_named_the_way_it_is_on_screen(db):
    """The model reads "S3" and "FIGHT_IN_ALLEY" off the same screen the user is
    looking at. Sending those where a uuid was expected produced
    `22P02 invalid input syntax for type uuid`, three retries, and an offer to
    queue a re-plan instead of editing."""
    for ref in ["S3", "s3", "3", "FIGHT_IN_ALLEY", "fight_in_alley"]:
        db["patches"].clear()
        out = dt.execute("update_scene", {"scene_id": ref, "slug": "RENAMED"},
                         {"project_id": "p"})
        assert out.get("updated_scene_id") == S1, f"{ref} did not resolve"


def test_an_unknown_scene_comes_back_with_the_list_to_choose_from(db):
    out = dt.execute("update_scene", {"scene_id": "S9", "slug": "X"}, {"project_id": "p"})
    assert "no scene matches" in out["error"]
    # Enough to get it right on the next call rather than guess again.
    assert [x["ref"] for x in out["scenes"]] == ["S1", "S2", "S3"]
    assert out["scenes"][2]["scene_id"] == S1
    assert not db["patches"]


def test_a_beat_can_be_named_by_position_within_a_scene(db):
    out = dt.execute("update_beat", {"beat_id": "b2", "scene_id": "S3", "action": "he looks up"},
                     {"project_id": "p"})
    assert out.get("updated_beat_id") == B2


def test_a_beat_label_without_a_scene_says_what_is_missing(db):
    out = dt.execute("update_beat", {"beat_id": "b2", "action": "x"}, {"project_id": "p"})
    assert "pass scene_id too" in out["error"]

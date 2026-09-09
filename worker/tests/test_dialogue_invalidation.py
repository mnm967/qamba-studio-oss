"""What a dialogue edit has to throw away.

Half of this looks after itself: line and exchange clips are content-hash keyed
on the words and the voice, so edited text simply misses the cache and is
re-synthesized. `beats.meta.xchg` does not — it pins a beat to ONE recording,
and the beat's duration was CUT to that recording at plan time. Left in place,
the master pass keeps routing to the exchange path against a clip that no
longer contains these words, and `place_exchange` either mis-times the lines or
gives up and falls back to timbre refs. Nothing on screen explains either.
"""
import pytest

import director_tools as dt


SCENE = "11111111-1111-4111-8111-111111111111"
B1 = "22222222-2222-4222-8222-222222222222"
B2 = "33333333-3333-4333-8333-333333333333"
B3 = "44444444-4444-4444-8444-444444444444"
XCHG = "aaaa0000-0000-4000-8000-000000000001"
OTHER = "bbbb0000-0000-4000-8000-000000000002"


@pytest.fixture
def db(monkeypatch):
    state = {"patches": [], "beats": [
        # b1 and b2 share one recorded conversation; b3 has its own.
        {"id": B1, "scene_id": SCENE, "idx": 0, "duration_ms": 4000,
         "meta": {"xchg": {"asset_id": XCHG}, "cast": ["Aki"]},
         "dialogue": [{"speaker": "Aki", "line": "you came"}]},
        {"id": B2, "scene_id": SCENE, "idx": 1, "duration_ms": 4000,
         "meta": {"xchg": {"asset_id": XCHG}},
         "dialogue": [{"speaker": "Haru", "line": "I said I would"}]},
        {"id": B3, "scene_id": SCENE, "idx": 2, "duration_ms": 4000,
         "meta": {"xchg": {"asset_id": OTHER}},
         "dialogue": [{"speaker": "Aki", "line": "late, though"}]},
    ]}

    def fake_get(path):
        if path.startswith(f"beats?scene_id=eq.{SCENE}"):
            return state["beats"]
        return []

    monkeypatch.setattr(dt.sb, "get", fake_get)
    monkeypatch.setattr(dt.sb, "patch",
                        lambda p, b, want_rows=False: state["patches"].append((p, b)))
    return state


def _beat(state, bid):
    return next(b for b in state["beats"] if b["id"] == bid)


def _patched_meta(state, bid):
    return next(b["meta"] for p, b in state["patches"] if bid in p and "meta" in b)


def test_the_whole_run_is_unpinned_not_just_the_edited_beat(db):
    """One recording covers the run. Unpinning only the edited beat leaves its
    neighbours pointing into a clip that is about to be re-cut."""
    dt._invalidate_dialogue(_beat(db, B1), [{"line": "you actually came"}])
    assert "xchg" not in _patched_meta(db, B1)
    assert "xchg" not in _patched_meta(db, B2)


def test_a_different_recording_in_the_same_scene_is_left_alone(db):
    """Unpinning more than the run would throw away work that still matches."""
    dt._invalidate_dialogue(_beat(db, B1), [{"line": "you actually came"}])
    assert not [p for p, _b in db["patches"] if B3 in p]


def test_unpinning_keeps_the_rest_of_the_beats_meta(db):
    """meta also carries the cast list, start frames and panel ids — replacing
    the whole object would silently drop them."""
    dt._invalidate_dialogue(_beat(db, B1), [{"line": "hi"}])
    assert _patched_meta(db, B1)["cast"] == ["Aki"]


def test_it_says_what_it_did(db):
    warnings = dt._invalidate_dialogue(_beat(db, B1), [{"line": "hi"}])
    assert any("unpinned" in w for w in warnings)


def test_an_unpinned_beat_needs_no_clearing(db):
    beat = {"id": B1, "scene_id": SCENE, "duration_ms": 4000, "meta": {}}
    assert dt._invalidate_dialogue(beat, [{"line": "hi"}]) == []
    assert not db["patches"]


def test_lines_too_long_for_the_shot_are_called_out(db):
    """The floor DIALOGUE_CUTOFF is a measurement of. A 2-second shot cannot
    hold a 12-word line however it is staged."""
    beat = {"id": B1, "scene_id": SCENE, "duration_ms": 2000, "meta": {}}
    warnings = dt._invalidate_dialogue(beat, [
        {"line": "I have been standing out here in the rain for twenty minutes"}])
    assert any("cut off" in w and "duration_ms" in w for w in warnings)


def test_lines_that_fit_raise_nothing(db):
    beat = {"id": B1, "scene_id": SCENE, "duration_ms": 8000, "meta": {}}
    assert dt._invalidate_dialogue(beat, [{"line": "you came"}]) == []

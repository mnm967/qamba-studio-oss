"""The launch-time re-measure: grow every dialogue beat to fit its RECORDED
lines before the planner packs blocks.

The bug this closes: `plan_storyboard` sizes a dialogue shot from a
words-per-second GUESS and then grows it to the measured clips — but that
growth only happens if the plan could reach a TTS engine, and when it cannot
the failure is one log line. Measured on NIGHT SHIFT, whose plan ran with one
half-cast character: a 7.71s line was planned into a 7.00s shot, the planner
packed blocks around it, and nothing downstream said the timing was a guess.
"""
import ast
import io
import os

import pytest

import handlers.blocks as B
import dialogue_synth as DS


def _scene(sid, beats):
    return {"id": sid, "slug": f"SCENE_{sid.upper()}"}


def _beat(bid, idx, dur, lines=1):
    return {"id": bid, "idx": idx, "duration_ms": dur,
            "dialogue": [{"speaker": "Lucy Voss", "line": "..."}] * lines}


@pytest.fixture
def fx(monkeypatch):
    patches = []
    monkeypatch.setattr(B.sb, "get", lambda path: [{"id": "c1", "name": "Lucy Voss",
                                                    "identity_line": "", "doc": {}}])
    monkeypatch.setattr(B.sb, "patch",
                        lambda path, body, **k: patches.append((path, body)))
    monkeypatch.setattr(B.sb, "job_progress", lambda *a, **k: None)
    return patches


def _measure(durs):
    """Stub DS so each beat's lines measure `durs` ms, in order."""
    def plan_lines(beats, cast):
        n = len(((beats[0] or {}).get("dialogue")) or [])
        return [{"order": i, "speaker": "Lucy Voss"} for i in range(n)] or None

    def measure_lines(items, project_id):
        return {it["order"]: durs[i] for i, it in enumerate(items)}
    return plan_lines, measure_lines


def test_a_shot_too_short_for_its_recorded_line_is_grown(monkeypatch, fx):
    pl, ml = _measure([7706])                       # NIGHT SHIFT b8's real line
    monkeypatch.setattr(DS, "plan_lines", pl)
    monkeypatch.setattr(DS, "measure_lines", ml)
    scenes = [_scene("s1", None)]
    beats = {"s1": [_beat("b1", 0, 7000)]}          # ...in its real 7.00s shot

    grown, touched, unmeasured = B._refit_measured_beats(scenes, beats, "p1")

    assert touched == 1 and not unmeasured
    assert beats["s1"][0]["duration_ms"] == DS.shot_floor_from_measured([7706])
    assert beats["s1"][0]["duration_ms"] > 7000
    assert grown == beats["s1"][0]["duration_ms"] - 7000
    # persisted, and the scene re-summed off the new numbers
    assert (f"beats?id=eq.b1", {"duration_ms": beats["s1"][0]["duration_ms"]}) in fx
    assert (f"scenes?id=eq.s1",
            {"duration_ms": beats["s1"][0]["duration_ms"]}) in fx


def test_the_planner_SEES_the_new_numbers(monkeypatch, fx):
    # The whole point of moving this ahead of plan_blocks: the beat dicts the
    # caller hands to the planner are the ones mutated. Passing copies would
    # write correct rows and pack blocks around the guess anyway — which is
    # the shipped bug, one function later.
    pl, ml = _measure([7706])
    monkeypatch.setattr(DS, "plan_lines", pl)
    monkeypatch.setattr(DS, "measure_lines", ml)
    beats = {"s1": [_beat("b1", 0, 7000)]}
    handed_to_planner = beats["s1"]                 # same list object

    B._refit_measured_beats([_scene("s1", None)], beats, "p1")

    assert handed_to_planner[0]["duration_ms"] > 7000


def test_a_shot_that_already_fits_is_untouched(monkeypatch, fx):
    # Growth only, so re-launching an episode is a no-op the second time —
    # launch_render deletes and re-plans every block, so it re-runs routinely.
    # Sized off the floor itself rather than off a real block: b9's own shot
    # (a 3.40s line in 6.75s) READ as generous under the old arithmetic and
    # is below the floor once the late-start allowance is in it, which is the
    # whole point of that allowance.
    pl, ml = _measure([3395])
    monkeypatch.setattr(DS, "plan_lines", pl)
    monkeypatch.setattr(DS, "measure_lines", ml)
    already = DS.shot_floor_from_measured([3395]) + 1
    beats = {"s1": [_beat("b1", 0, already)]}

    grown, touched, unmeasured = B._refit_measured_beats(
        [_scene("s1", None)], beats, "p1")

    assert (grown, touched, unmeasured) == (0, 0, [])
    assert beats["s1"][0]["duration_ms"] == already
    assert fx == []


def test_re_running_the_refit_changes_nothing_the_second_time(monkeypatch, fx):
    # The idempotence that makes it safe at launch: `launch_render` deletes
    # and re-plans every block, so this runs on every re-launch of an episode.
    pl, ml = _measure([7706])
    monkeypatch.setattr(DS, "plan_lines", pl)
    monkeypatch.setattr(DS, "measure_lines", ml)
    beats = {"s1": [_beat("b1", 0, 7000)]}

    first = B._refit_measured_beats([_scene("s1", None)], beats, "p1")
    second = B._refit_measured_beats([_scene("s1", None)], beats, "p1")

    assert first[1] == 1 and second == (0, 0, [])


def test_an_uncast_speaker_is_REPORTED_not_skipped_in_silence(monkeypatch, fx):
    # This is the exact state that took NIGHT SHIFT's timing down: `plan_lines`
    # returns nothing for an uncast speaker, and the old path had no way to
    # say so. One half-cast character must not cost a storyboard its timing
    # without leaving a name behind.
    monkeypatch.setattr(DS, "plan_lines", lambda beats, cast: None)
    monkeypatch.setattr(DS, "measure_lines",
                        lambda *a, **k: pytest.fail("must not measure"))
    beats = {"s1": [_beat("b1", 0, 7000)]}

    grown, touched, unmeasured = B._refit_measured_beats(
        [_scene("s1", None)], beats, "p1")

    assert (grown, touched) == (0, 0)
    assert len(unmeasured) == 1
    assert "SCENE_S1 b1" in unmeasured[0] and "uncast" in unmeasured[0]
    # ...and it must not ASSERT that cause: plan_lines also returns nothing
    # when one shot has more speakers than MAX_AUDIO_SLOTS carries, and
    # naming the wrong one sends someone to the bible for a slot budget.
    assert "too many speakers" in unmeasured[0]
    assert beats["s1"][0]["duration_ms"] == 7000     # left as planned


def test_a_dead_tts_engine_reports_and_does_NOT_kill_the_render(monkeypatch, fx):
    # An outage must not block an episode: the ref path synthesizes each line
    # at render time regardless, so only the FIT is lost. But it is named.
    pl, _ = _measure([1])
    monkeypatch.setattr(DS, "plan_lines", pl)

    def boom(items, project_id):
        raise RuntimeError("breeze is not serving")
    monkeypatch.setattr(DS, "measure_lines", boom)
    beats = {"s1": [_beat("b1", 0, 7000), _beat("b2", 1, 4000)]}

    grown, touched, unmeasured = B._refit_measured_beats(
        [_scene("s1", None)], beats, "p1")

    assert (grown, touched) == (0, 0)
    assert len(unmeasured) == 2
    assert all("breeze is not serving" in u for u in unmeasured)


def test_a_beat_with_no_dialogue_is_never_measured(monkeypatch, fx):
    monkeypatch.setattr(DS, "plan_lines",
                        lambda *a, **k: pytest.fail("must not plan"))
    beats = {"s1": [{"id": "b1", "idx": 0, "duration_ms": 1750, "dialogue": []}]}

    assert B._refit_measured_beats([_scene("s1", None)], beats, "p1") == (0, 0, [])


def test_a_cut_locked_to_a_track_skips_the_refit():
    """A music video's block boundaries snap to the track's beat grid and its
    <Audio 1> is a fixed-length master, so growing a dialogue shot walks the
    picture off the music. Parsed rather than exercised: `handle_launch_render`
    is a whole-episode handler, and what matters is that the guard is on the
    call, not that some branch exists somewhere."""
    src = io.open(os.path.join(os.path.dirname(__file__), "..",
                               "handlers", "blocks.py"), encoding="utf-8").read()
    fn = next(n for n in ast.walk(ast.parse(src))
              if isinstance(n, ast.FunctionDef) and n.name == "handle_launch_render")
    call = next(n for n in ast.walk(fn) if isinstance(n, ast.Call)
                and getattr(n.func, "id", "") == "_refit_measured_beats")
    guard = next(n for n in ast.walk(fn) if isinstance(n, ast.If)
                 and any(c is call for c in ast.walk(n)))
    names = {x.id for x in ast.walk(guard.test) if isinstance(x, ast.Name)}
    assert {"beats_ms", "locked"} <= names, names
    # ...and the call must come BEFORE plan_blocks, which is the bug it fixes.
    packs = next(n for n in ast.walk(fn) if isinstance(n, ast.Call)
                 and getattr(n.func, "attr", "") == "plan_blocks")
    assert call.lineno < packs.lineno

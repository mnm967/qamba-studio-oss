"""A scene's duration IS the sum of its beats, and nothing enforced it.

`planner.plan_blocks` reads beat durations only — it never looks at
`scenes.duration_ms` — so a scene duration edited on its own is a number the
render path cannot see, while the wizard total, the storyboard ruler and the
cost/ETA estimates all start quoting it.

Measured on Rei E3 v6 through the real director chat: "MEMORY_RETURN is too
long, bring it to about 48s" set the scene to 48000 and left its 21 beats
summing to 58000. The tool reported success. The same turn's HIDEOUT_ARRIVAL
fix was correct ONLY because the model volunteered six update_beat calls and
did the arithmetic itself — correctness depended on the model choosing to keep
the books.
"""
import director_tools as DT


def test_it_hits_the_target_exactly():
    out = DT.refit_beats([4800, 1500, 3000, 4800, 3000], 20000)
    assert sum(out) == 20000


def test_the_shape_of_the_scene_survives():
    """Proportional, so the 5s hold is still the longest shot afterwards."""
    old = [4800, 1500, 3000]
    out = DT.refit_beats(old, 18600)          # x2
    assert out.index(max(out)) == old.index(max(old))
    assert out[0] > out[2] > out[1]
    assert sum(out) == 18600


def test_no_beat_is_shortened_below_the_shot_floor():
    out = DT.refit_beats([3000, 3000, 3000, 3000], 4000)
    assert min(out) >= DT.BEAT_MIN_MS
    # A scene cannot be shorter than its shots: the floor total wins over the
    # request, rather than the request winning over renderable shots.
    assert sum(out) == DT.BEAT_MIN_MS * 4


def test_growing_lands_exactly_too():
    out = DT.refit_beats([1500, 1500, 1500], 58000)
    assert sum(out) == 58000
    assert min(out) >= DT.BEAT_MIN_MS


def test_the_real_case_that_produced_this():
    """21 beats summing to 58000, asked for 48000."""
    # MEMORY_RETURN's real durations, read off the row.
    beats = [2500, 2500, 2250, 1500, 2500, 2750, 3750, 2750, 2750, 3750, 1500,
             2500, 4000, 2750, 2500, 3750, 1750, 3750, 2250, 2750, 3500]
    assert sum(beats) == 58000
    out = DT.refit_beats(beats, 48000)
    assert sum(out) == 48000
    assert min(out) >= DT.BEAT_MIN_MS
    assert len(out) == len(beats)


def test_degenerate_inputs_do_not_raise():
    assert DT.refit_beats([], 10000) == []
    even = DT.refit_beats([0, 0, 0], 9000)
    assert sum(even) == 9000


def test_both_directions_are_wired():
    import inspect
    src = inspect.getsource(DT.run_tool) if hasattr(DT, "run_tool") else open(
        DT.__file__).read()
    # update_scene retimes the beats; update_beat/add/delete push the sum back
    # onto the scene. Fixing one direction only lets the pair drift anyway.
    assert "refit_beats(" in src
    assert src.count("_sync_scene_duration(") >= 4


# --- a label ref resolves silently, so the result has to SAY where it landed --
# Measured on Rei E3 v6: the model meant CITY_CAPTURE_2 (S7) and sent
# scene_id "S3", so update_beat retimed HIDEOUT_ARRIVAL's shot instead, replied
# with a bare uuid and "ok", and neither the model nor the transcript could tell.
def test_update_beat_names_the_scene_and_shot_it_actually_hit():
    import inspect
    src = open(DT.__file__).read()
    body = src.split('if name == "update_beat"', 1)[1].split('if name == "add_beat"', 1)[0]
    assert '"scene":' in body and '"beat_ref":' in body, \
        "a uuid is not something a mis-reference can be spotted from"

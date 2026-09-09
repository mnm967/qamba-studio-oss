"""worker/mix.py against the same cases as src/lib/mix.test.ts.

Two implementations of one mix (the preview player's and the renderer's) is a
place drift is invisible: the browser would keep sounding right while the
finished file quietly differed. These are the shared cases; the automation
expression is additionally read back with `eval_volume_expr`, because a filter
string nobody can evaluate is a filter string nobody can check.
"""
import mix


def track(**over):
    t = {"id": "t1", "kind": "audio", "muted": False, "solo": False,
         "gain_db": 0, "automation": []}
    t.update(over)
    return t


def test_no_points_leaves_the_fader_in_charge():
    assert mix.gain_at_ms([], 5000, -6) == -6
    assert mix.track_gain_db_at(track(gain_db=-6), 5000) == -6


def test_automation_replaces_the_fader():
    t = track(gain_db=-12, automation=[{"t_ms": 0, "gain_db": 0}])
    assert mix.track_gain_db_at(t, 1234) == 0


def test_curve_is_flat_outside_its_points():
    pts = [{"t_ms": 1000, "gain_db": -6}, {"t_ms": 3000, "gain_db": 0}]
    assert mix.gain_at_ms(pts, 0) == -6
    assert mix.gain_at_ms(pts, 9999) == 0


def test_curve_interpolates_between_points():
    pts = [{"t_ms": 0, "gain_db": -12}, {"t_ms": 1000, "gain_db": 0}]
    assert mix.gain_at_ms(pts, 500) == -6
    assert mix.gain_at_ms(pts, 250) == -9


def test_points_out_of_order_describe_the_same_curve():
    pts = [{"t_ms": 2000, "gain_db": 0}, {"t_ms": 0, "gain_db": -12}]
    assert mix.gain_at_ms(pts, 1000) == -6


def test_bottom_of_the_range_is_silence():
    assert mix.linear_gain(mix.AUTO_MIN_DB) == 0.0
    assert mix.linear_gain(0) == 1.0
    assert abs(mix.linear_gain(-6) - 0.501) < 0.002


def test_mute_and_solo():
    a, b = track(id="a"), track(id="b")
    assert mix.is_audible(a, [a, b])
    assert not mix.solo_active([a, b])

    b_solo = track(id="b", solo=True)
    assert not mix.is_audible(a, [a, b_solo])
    assert mix.is_audible(b_solo, [a, b_solo])


def test_mute_wins_over_the_lanes_own_solo():
    muted = track(id="a", solo=True, muted=True)
    other = track(id="b")
    assert not mix.is_audible(muted, [muted, other])
    assert not mix.is_audible(other, [muted, other])   # something IS soloed


def test_solo_on_audio_silences_a_video_lanes_baked_audio():
    v = track(id="v", kind="video")
    a = track(id="a", solo=True)
    assert not mix.is_audible(v, [v, a])
    assert mix.audible_tracks([v, a], kind="video") == []
    assert mix.audible_tracks([v, a], kind="audio") == [a]


def test_no_automation_is_the_constant_the_renderer_always_used():
    assert mix.volume_filter(track(gain_db=-6), 0) == "volume=-6.0000dB"
    assert mix.volume_filter(track(gain_db=-6), 2) == "volume=-4.0000dB"


def test_automation_compiles_to_an_expression_ffmpeg_evaluates_per_frame():
    t = track(automation=[{"t_ms": 0, "gain_db": 0}, {"t_ms": 1000, "gain_db": -30}])
    f = mix.volume_filter(t, 0)
    assert f.startswith("volume=volume='") and f.endswith("':eval=frame")
    expr = f[len("volume=volume='"):-len("':eval=frame")]
    # the endpoints, and a linear ramp between them in LINEAR gain
    assert abs(mix.eval_volume_expr(expr, 0.0) - 1.0) < 1e-6
    assert abs(mix.eval_volume_expr(expr, 1.0) - 0.0) < 1e-6
    assert abs(mix.eval_volume_expr(expr, 0.5) - 0.5) < 1e-6
    # flat outside
    assert abs(mix.eval_volume_expr(expr, -3.0) - 1.0) < 1e-6
    assert abs(mix.eval_volume_expr(expr, 99.0) - 0.0) < 1e-6


def test_the_clips_own_gain_rides_on_the_automation():
    t = track(automation=[{"t_ms": 0, "gain_db": -6}, {"t_ms": 1000, "gain_db": -6}])
    expr = mix.volume_filter(t, 6)[len("volume=volume='"):-len("':eval=frame")]
    assert abs(mix.eval_volume_expr(expr, 0.5) - 1.0) < 1e-3


def test_one_point_is_a_constant_expression():
    t = track(automation=[{"t_ms": 5000, "gain_db": -6}])
    expr = mix.volume_filter(t, 0)[len("volume=volume='"):-len("':eval=frame")]
    assert abs(mix.eval_volume_expr(expr, 0.0) - mix.linear_gain(-6)) < 1e-6
    assert abs(mix.eval_volume_expr(expr, 900.0) - mix.linear_gain(-6)) < 1e-6


def test_two_points_at_one_instant_are_a_step_not_a_divide_by_zero():
    t = track(automation=[{"t_ms": 1000, "gain_db": 0}, {"t_ms": 1000, "gain_db": -30}])
    expr = mix.volume_filter(t, 0)[len("volume=volume='"):-len("':eval=frame")]
    assert mix.eval_volume_expr(expr, 2.0) == 0.0


def test_the_expression_carries_no_character_the_filtergraph_would_eat():
    # commas and colons inside a quoted filter value are fine; a stray quote
    # would end the value early and ffmpeg would reject the whole graph.
    t = track(automation=[{"t_ms": 0, "gain_db": 0}, {"t_ms": 2500, "gain_db": -12}])
    f = mix.volume_filter(t, 0)
    assert f.count("'") == 2
    assert "[" not in f and "]" not in f and ";" not in f


def test_garbage_points_are_ignored_rather_than_raising():
    t = track(automation=[{"t_ms": "x"}, None, {"t_ms": 0, "gain_db": -6}])
    assert mix.track_gain_db_at(t, 10) == -6

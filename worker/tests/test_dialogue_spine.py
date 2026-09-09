"""The dialogue spine's pure half, and the compile path it turns on.

The spine is the answer to two measured failures — a line cut at a chain join,
and a line re-placed differently by the block that inherits it. Both come from
the audio being RE-DECIDED at a boundary; a spine makes the boundary land
inside one continuous recording that both sides slice from.

What is exercised here is everything that does not touch ElevenLabs, B2 or
ffmpeg: which beats group into a run, which blocks lock, and what the compiler
says once they do.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dialogue_spine as DSP  # noqa: E402
import h3_prompt as H  # noqa: E402


def _beat(bid, ms, *speakers):
    return {"id": bid, "duration_ms": ms,
            "dialogue": [{"speaker": s, "line": f"{s} says a thing."}
                         for s in speakers],
            "cast_names": list(speakers) or ["Reg"]}


# ------------------------------------------------------------------ runs ----
def test_a_run_is_consecutive_dialogue_beats_on_an_absolute_clock():
    scenes = [{"id": "s1"}, {"id": "s2"}]
    sb = {"s1": [_beat("a", 4000, "Reg"), _beat("b", 4000, "Mo"),
                 _beat("c", 4000)],                       # silent: ends the run
          "s2": [_beat("d", 4000, "Reg")]}
    runs = DSP._runs(scenes, sb)
    assert [[r["beat"]["id"] for r in run] for run in runs] == [["a", "b"], ["d"]]
    # the clock accumulates across every beat, silent ones included
    assert [r["abs_ms"] for r in runs[0]] == [0, 4000]
    assert runs[1][0]["abs_ms"] == 12000


def test_a_run_never_crosses_a_scene_boundary():
    """A location cut is a hard block boundary, so a recording spanning one
    would be locked into two blocks that do not adjoin in the finished cut."""
    scenes = [{"id": "s1"}, {"id": "s2"}]
    sb = {"s1": [_beat("a", 4000, "Reg")], "s2": [_beat("b", 4000, "Mo")]}
    runs = DSP._runs(scenes, sb)
    assert len(runs) == 2


def test_run_indices_match_the_shot_numbers_plan_lines_will_use():
    """`plan_lines` numbers the beats it is handed 1..n, and placement solves
    against windows keyed the same way. If these disagreed, every line would
    be placed against the wrong shot's window."""
    scenes = [{"id": "s1"}]
    sb = {"s1": [_beat("a", 4000, "Reg"), _beat("b", 4000, "Mo"),
                 _beat("c", 4000, "Reg")]}
    run = DSP._runs(scenes, sb)[0]
    assert [r["idx_in_run"] for r in run] == [1, 2, 3]


# ----------------------------------------------------------------- locks ----
def test_a_block_locks_when_it_holds_a_dialogue_beat():
    beats = {"a": _beat("a", 4000, "Reg"), "b": _beat("b", 4000)}
    assert DSP.locks(["a", "b"], beats)
    assert not DSP.locks(["b"], beats)
    assert not DSP.locks([], beats)
    assert not DSP.locks(None, beats)


def test_locking_is_decided_by_dialogue_not_by_a_recordings_span():
    """The span test was the first version and it is wrong: a recording can
    run shorter than the beats it was cut against, and a block whose last beat
    fell outside every span would then render its own speech OVER a track that
    already contains it."""
    beats = {"z": _beat("z", 9000, "Reg")}
    assert DSP.locks(["z"], beats)          # no spans consulted at all


# --------------------------------------------------- a run's recording ------
def _pinned_world(monkeypatch, beat_ms):
    """One run of two lines with a pinned recording, and beats whose durations
    the caller chooses — so a test can make the pin agree or disagree."""
    import dialogue_synth as DS
    asset = {"id": "x1", "b2_key": "a.mp3", "duration_ms": 7000,
             "meta": {"lines": [{"line": "One.", "t0_ms": 700, "t1_ms": 2100},
                                {"line": "Two.", "t0_ms": 2600, "t1_ms": 4300}]}}
    monkeypatch.setattr(DSP.sb, "asset_by_id", lambda i: asset, raising=False)
    monkeypatch.setattr(DS, "plan_lines", lambda beats, cast: [
        {"speaker": "Reg", "voice_id": "V1", "shot_idx": 1, "order": 1,
         "line": "One.", "speech_text": "One.", "key": "k1"},
        {"speaker": "Mo", "voice_id": "V2", "shot_idx": 2, "order": 2,
         "line": "Two.", "speech_text": "Two.", "key": "k2"}])
    run = [{"beat": {"id": "b1", "duration_ms": beat_ms[0],
                     "dialogue": [{"speaker": "Reg", "line": "One."}],
                     "meta": {"xchg": {"asset_id": "x1"}}},
            "abs_ms": 0, "dur_ms": beat_ms[0], "idx_in_run": 1},
           {"beat": {"id": "b2", "duration_ms": beat_ms[1],
                     "dialogue": [{"speaker": "Mo", "line": "Two."}],
                     "meta": {"xchg": {"asset_id": "x1"}}},
            "abs_ms": beat_ms[0], "dur_ms": beat_ms[1], "idx_in_run": 2}]
    return run, asset


def test_a_pin_whose_beats_still_match_is_used_as_cut(monkeypatch):
    """`pin_run_durations` cut these beats TO the recording, so the offset is
    exact by construction and nothing needs solving."""
    # beat 1 runs to the middle of the recorded pause (2100..2600 -> 2350)
    run, asset = _pinned_world(monkeypatch, [2350, 2850])
    got_asset, lines, off = DSP._run_recording(run, [], "p1")
    assert got_asset is asset
    assert off == 0                      # 0 - (700 - SHOT_LEAD_MS 700)
    assert [l["t0_ms"] for l in lines] == [700, 2600]


def test_a_STALE_pin_is_detected_and_the_placement_re_solved(monkeypatch):
    """The pin is only exact while the beats are the ones cut to it, and they
    need not be: a re-plan retimes beats and `update_beat` clears the pin only
    when the WORDS change. Trusted blindly, every line lands at the offset the
    OLD durations implied — measured here as line 2 sitting inside line 1's
    shot, which is the cut-off-dialogue failure the spine exists to end."""
    run, asset = _pinned_world(monkeypatch, [5000, 5000])
    _a, lines, off = DSP._run_recording(run, [], "p1")
    windows = {1: (0, 5000), 2: (5000, 10000)}
    for l in lines:
        lo, hi = windows[l["shot_idx"]]
        assert lo <= off + l["t0_ms"] and off + l["t1_ms"] <= hi, \
            f"{l['speaker']} lands outside its own shot"


# --------------------------------------------------------------- compile ----
def _compile(locked_kind, **kw):
    return H.compile_block(
        render_ms=9000, warmup_ms=917, aspect="16:9", style="cinematic",
        medium="series",
        beats=[{"start_ms": 0, "duration_ms": 9000, "action": "Reg holds the rota",
                "camera": "a medium two-shot", "cast_names": ["Reg", "Mo"],
                "dialogue": [{"speaker": "Reg", "line": "Tuesday is a big day."}]}],
        cast=[{"name": "Reg", "identity_line": "a man with a laminator"},
              {"name": "Mo", "identity_line": "a woman who has stopped arguing"}],
        environment={"name": "the shop", "identity_line": "a narrow bakery"},
        ref_slots=[{"slot": 1, "kind": "character", "name": "Reg"},
                   {"slot": 2, "kind": "character", "name": "Mo"}],
        mode="r2v", audio_mode="locked", locked_kind=locked_kind, **kw)


def test_a_dialogue_spine_is_declared_as_speech_and_spoken_not_sung():
    out = _compile("dialogue")
    assert "complete recorded audio track" in out["subject_definitions"]
    assert "says, precisely lip-synced to <Audio 1>" in out["description"]
    assert "sings" not in out["description"]
    # a spine is speech, so claiming it as audience-only music would tell the
    # model the words are non-diegetic
    assert out["music"] == "N/A"
    assert "spoken dialogue" in out["soundscape"]


def test_the_music_video_wording_is_untouched_by_the_new_argument():
    """`locked_kind` defaults to music, and every music video planned before
    it existed must compile byte-identically."""
    out = _compile("music")
    assert "supplied master music track" in out["subject_definitions"]
    assert "sings, precisely lip-synced to <Audio 1>" in out["description"]
    assert "audience-only music" in out["music"]


def test_the_default_locked_kind_is_music():
    """An older block row carries no locked_kind, and a music video that
    started compiling as a dialogue spine would lose its score."""
    explicit = _compile("music")
    default = H.compile_block(
        render_ms=9000, warmup_ms=917, aspect="16:9", style="cinematic",
        medium="series",
        beats=[{"start_ms": 0, "duration_ms": 9000, "action": "Reg holds the rota",
                "camera": "a medium two-shot", "cast_names": ["Reg", "Mo"],
                "dialogue": [{"speaker": "Reg", "line": "Tuesday is a big day."}]}],
        cast=[{"name": "Reg", "identity_line": "a man with a laminator"},
              {"name": "Mo", "identity_line": "a woman who has stopped arguing"}],
        environment={"name": "the shop", "identity_line": "a narrow bakery"},
        ref_slots=[{"slot": 1, "kind": "character", "name": "Reg"},
                   {"slot": 2, "kind": "character", "name": "Mo"}],
        mode="r2v", audio_mode="locked")
    assert default == explicit


def test_listeners_are_named_and_told_to_react_on_the_spine_path():
    """The wrong-speaker guard. With two subjects declared and one recording
    holding every line, nothing else says whose mouth moves."""
    out = _compile("dialogue")
    assert "Mo listens with their mouth closed" in out["description"]


def test_a_silent_shot_on_a_spine_says_mouths_are_closed_affirmatively():
    out = H.compile_block(
        render_ms=9000, warmup_ms=917, aspect="16:9", style="cinematic",
        medium="series",
        beats=[{"start_ms": 0, "duration_ms": 9000, "action": "Reg stares at the rota",
                "camera": "a slow push", "cast_names": ["Reg"], "dialogue": []}],
        cast=[{"name": "Reg", "identity_line": "a man with a laminator"}],
        environment={"name": "the shop", "identity_line": "a narrow bakery"},
        ref_slots=[{"slot": 1, "kind": "character", "name": "Reg"}],
        mode="r2v", audio_mode="locked", locked_kind="dialogue")
    assert "Every mouth on screen stays closed" in out["description"]
    assert "sings" not in out["description"]

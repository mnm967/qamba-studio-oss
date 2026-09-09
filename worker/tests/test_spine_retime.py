"""The recording is the clock: a spine block's shot stamps must agree with
where the audio actually put each line.

Measured on THE LATE SHIFT b1, the first block of the first spine render: the
envelope stamped [Shot 3] at 00:06.864 and bound Dennis's line to it
"precisely lip-synced" — and the spine's audio starts him at 5.69s, 1.17s
earlier, during an insert close-up of a BELL he is not even in. H3, told one
clock and played another, kept his mouth shut. The reviewer scored dialogue
1.0 (the words are all there — the audio is the spine 1:1), so nothing
downstream can catch it; only the picture shows it.
"""
import os
import sys

os.environ.setdefault("SUPABASE_URL", "http://x")
os.environ.setdefault("SUPABASE_ANON_KEY", "local")
os.environ.setdefault("SUPABASE_ACCESS_TOKEN", "x")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dialogue_spine as DSP  # noqa: E402

# b1's REAL numbers: three shots planned 2417 / 4447 / 6333 (sum 13197),
# Priya measured 2930..5690 in shot 2, Dennis 5690..10210 in shot 3.
B1_BEATS = [{"id": "a", "duration_ms": 2417},
            {"id": "b", "duration_ms": 4447},
            {"id": "c", "duration_ms": 6333}]
B1_LINES = [{"beat_id": "b", "t0_ms": 2930, "t1_ms": 5690},
            {"beat_id": "c", "t0_ms": 5690, "t1_ms": 10210}]


def _bounds(durs):
    out = [0]
    for d in durs:
        out.append(out[-1] + d)
    return out


def test_the_measured_failure_is_repaired():
    """Dennis's cut must move to his measured onset — the hand-off at 5690 —
    so the shot that binds his line starts when his voice does."""
    durs = DSP.retime_beats(B1_BEATS, B1_LINES, 13197)
    assert durs is not None
    b = _bounds(durs)
    assert b[2] == 5690, f"the shot-3 cut must land on the hand-off, got {b[2]}"
    assert sum(durs) == 13197, "the render length is fixed; only stamps move"


def test_a_plan_that_agrees_with_its_audio_is_untouched():
    """None means the caller keeps the planned stamps byte-identical — every
    block whose pin held compiles exactly as it always did."""
    lines = [{"beat_id": "b", "t0_ms": 2700, "t1_ms": 5000},
             {"beat_id": "c", "t0_ms": 7400, "t1_ms": 10000}]
    assert DSP.retime_beats(B1_BEATS, lines, 13197) is None


def test_no_lines_no_retime():
    assert DSP.retime_beats(B1_BEATS, [], 13197) is None
    assert DSP.retime_beats([], B1_LINES, 13197) is None


def test_boundaries_stay_monotonic_and_shots_keep_a_floor():
    """A line longer than any window can give must degrade to a legal tiling,
    never to a zero- or negative-length shot."""
    beats = [{"id": "a", "duration_ms": 4000},
             {"id": "b", "duration_ms": 4000},
             {"id": "c", "duration_ms": 4000}]
    lines = [{"beat_id": "a", "t0_ms": 500, "t1_ms": 11000},   # runs over 2 cuts
             {"beat_id": "c", "t0_ms": 11200, "t1_ms": 11900}]
    durs = DSP.retime_beats(beats, lines, 12000)
    if durs is not None:
        assert sum(durs) == 12000
        assert all(d > 0 for d in durs)


def test_a_line_bleeding_across_the_block_boundary_is_clamped():
    """The spine's known graceful case: a tail completing over the cut. The
    clamp keeps the constraint inside this block instead of asking a boundary
    to move past the end of the render."""
    beats = [{"id": "a", "duration_ms": 3000}, {"id": "b", "duration_ms": 4000}]
    lines = [{"beat_id": "b", "t0_ms": 3400, "t1_ms": 9500}]   # tail past 7000
    durs = DSP.retime_beats(beats, lines, 7000)
    assert durs is None or sum(durs) == 7000


def test_block_lines_prefers_beat_id_and_falls_back_to_text():
    meta = {"lines": [
        {"beat_id": "x", "speaker": "P", "line": "Hello there.",
         "t0_ms": 20500, "t1_ms": 21500},
        {"speaker": "D", "line": "General Kenobi.",            # no beat_id
         "t0_ms": 22000, "t1_ms": 23000},
        {"speaker": "P", "line": "Elsewhere.", "t0_ms": 90000, "t1_ms": 91000},
    ]}
    beats = [{"id": "x", "dialogue": [{"line": "Hello there."}]},
             {"id": "y", "dialogue": [{"line": "General Kenobi."}]}]
    got = DSP.block_lines(meta, beats, 20000, 8000)
    assert [(l["beat_id"], l["t0_ms"]) for l in got] == [("x", 500), ("y", 2000)]


def test_block_lines_treats_an_ambiguous_text_as_a_miss():
    """Two beats carrying the same words: matching either is a guess, and a
    guessed retime moves a cut for the wrong shot."""
    meta = {"lines": [{"speaker": "P", "line": "Yes.", "t0_ms": 100, "t1_ms": 600}]}
    beats = [{"id": "x", "dialogue": [{"line": "Yes."}]},
             {"id": "y", "dialogue": [{"line": "Yes."}]}]
    assert DSP.block_lines(meta, beats, 0, 5000) == []


def test_the_spine_records_which_beat_each_line_was_placed_for():
    """`build_for_storyboard` must stamp beat_id onto its placements — the
    text fallback exists for spines built before the field did, not as the
    design."""
    import inspect
    src = inspect.getsource(DSP.build_for_storyboard)
    assert 'l["beat_id"]' in src or '"beat_id"' in src


def test_master_pass_retimes_and_the_clause_says_when():
    """Both halves must ship together: stamps moved in blocks.py, and the
    offset said in h3_prompt only when a line starts well after its cut."""
    import inspect
    import handlers.blocks as B
    import h3_prompt as H
    src = inspect.getsource(B.handle_master_pass)
    assert "retime_beats(" in src and "block_lines(" in src
    assert '"dialogue"' in src.split("retime_beats(")[0].rsplit("locked_kind", 2)[-2] \
        or 'locked_kind' in src, "the retime must be gated on the dialogue spine"
    csrc = inspect.getsource(H._locked_audio_clause)
    assert 'at_ms' in csrc and "beginning about" in csrc
    assert ">= 400" in csrc, "a near-zero offset is a second clock, not a cue"


def test_the_offset_clause_emits_only_past_the_threshold():
    import h3_prompt as H
    beat = {"dialogue": [{"speaker": "Dennis", "line": "Quite.", "at_ms": 2100}],
            "cast_names": ["Dennis", "Priya"]}
    out = H._locked_audio_clause(beat, 1, [], {"Dennis": 1, "Priya": 2},
                                 {"Dennis": "S1", "Priya": "S2"}, [], 0,
                                 True, verb="says")
    assert "beginning about 2.1s into this shot" in out
    beat2 = {"dialogue": [{"speaker": "Dennis", "line": "Quite.", "at_ms": 150}],
             "cast_names": ["Dennis"]}
    out2 = H._locked_audio_clause(beat2, 1, [], {"Dennis": 1},
                                  {"Dennis": "S1"}, [], 0, True, verb="says")
    assert "beginning about" not in out2


# ---------------------------------------------------------------------------
# PLACEMENT: onsets first, tails graceful.
#
# `place_exchange` demands every line wholly inside its window; a conversation
# recording's own rhythm routinely cannot give that (4 of 87 dialogue beats
# were pinned on THE LATE SHIFT — short volleys never take the pinning path),
# and the old fallback aligned only the FIRST word. 19 of 92 onsets drifted
# before their own beats; where such a beat edge was also a BLOCK edge the
# owning slice opened mid-word and the mouth never bound (Dennis, b1 AND b3,
# measured in frames; Priya, onset 250ms inside her window, bound fine).

def test_onset_placement_prefers_all_onsets_inside():
    lines = [{"shot_idx": 1, "t0_ms": 700, "t1_ms": 3400},
             {"shot_idx": 2, "t0_ms": 3500, "t1_ms": 6100}]
    windows = {1: (0, 3000), 2: (3000, 7000)}
    p = DSP.place_onsets(lines, windows)
    for l in lines:
        w = windows[l["shot_idx"]]
        assert w[0] <= l["t0_ms"] + p <= w[1], (p, l)


def test_onsets_win_over_a_tail_that_cannot_fit():
    """The b3 shape: the recording's second line starts before its shot under
    a whole-line fit, so exact placement is infeasible. Onset placement must
    put BOTH onsets inside their windows and let the first tail cross."""
    lines = [{"shot_idx": 1, "t0_ms": 700, "t1_ms": 5300},   # long first line
             {"shot_idx": 2, "t0_ms": 5400, "t1_ms": 6800}]
    windows = {1: (0, 4400), 2: (4400, 8000)}                # tail can't fit
    p = DSP.place_onsets(lines, windows)
    assert windows[1][0] <= lines[0]["t0_ms"] + p
    assert windows[2][0] <= lines[1]["t0_ms"] + p <= windows[2][1]
    # the first line's ONSET is inside shot 1 even though its tail crosses
    assert lines[0]["t0_ms"] + p < windows[1][1]


def test_an_onset_never_lands_before_its_own_window():
    """The beheading case: whatever else gives, no line may start before the
    beat that owns it when a placement satisfying all onsets exists."""
    lines = [{"shot_idx": 1, "t0_ms": 0, "t1_ms": 2000},
             {"shot_idx": 2, "t0_ms": 2100, "t1_ms": 4600}]
    windows = {1: (0, 3000), 2: (3000, 6000)}
    p = DSP.place_onsets(lines, windows)
    assert lines[1]["t0_ms"] + p >= windows[2][0], "second onset beheaded"


def test_impossible_onsets_degrade_to_the_most_satisfied():
    """Two lines whose gap is wildly off any window pairing: satisfy as many
    onsets as possible, deterministically."""
    lines = [{"shot_idx": 1, "t0_ms": 0, "t1_ms": 900},
             {"shot_idx": 2, "t0_ms": 950, "t1_ms": 1900}]
    windows = {1: (0, 5000), 2: (9000, 12000)}   # 8s planned gap, 950ms real
    p = DSP.place_onsets(lines, windows)
    ok = sum(1 for l in lines
             if windows[l["shot_idx"]][0] <= l["t0_ms"] + p
             <= windows[l["shot_idx"]][1] - 200)
    assert ok >= 1


def test_the_fallbacks_route_through_onset_placement():
    import inspect
    src = inspect.getsource(DSP._run_recording)
    assert src.count("place_onsets(") == 2, (
        "both infeasible-fit fallbacks must place by onsets — the first-word "
        "alignment is the drift being removed")
    assert "SHOT_LEAD_MS - lines[0]" not in src.split("if len(items) == 1")[1], (
        "the naive first-word alignment must be gone from the exchange path")


def test_locked_dialogue_numbers_speakers_by_audio_order():
    """On a locked track the S-ids describe voices that already EXIST in
    <Audio 1>, and a model diarizing a recording indexes them by first
    appearance — cast order handed it a labelling it could not reconcile
    (b1: Priya speaks first and was S2). Native blocks keep cast order: there
    the ids tell the model which voices to invent, and any distinct labelling
    is as good as any other."""
    import h3_prompt as H
    cast = [{"name": "Dennis", "identity_line": "a man"},
            {"name": "Priya", "identity_line": "a woman"}]
    beats = [{"duration_ms": 4000, "start_ms": 0,
              "cast_names": ["Dennis", "Priya"],
              "camera": "a two-shot", "action": "They face off.",
              "dialogue": [{"speaker": "Priya", "line": "Three inches left."}]},
             {"duration_ms": 4000, "start_ms": 4000,
              "cast_names": ["Dennis", "Priya"],
              "camera": "a two-shot", "action": "He slides it back.",
              "dialogue": [{"speaker": "Dennis", "line": "Returned."}]}]
    kw = dict(render_ms=9000, warmup_ms=800, aspect="16:9", style="x",
              medium="series", beats=beats, cast=cast, environment=None,
              ref_slots=[], mode="r2v", has_end_frame=False,
              lip_sync=True, lyrics=[])
    spine = H.compile_block(audio_mode="locked", locked_kind="dialogue", **kw)
    txt = str(spine)
    assert "Priya) (S1) says" in txt, "first voice heard must be S1"
    assert "Dennis Okonkwo" not in txt  # sanity: fixture names only
    assert "Dennis) (S2) says" in txt
    native = str(H.compile_block(audio_mode="native", locked_kind="music", **kw))
    assert "Dennis) (S1)" in native or "(S1)" in native.split("Dennis")[1][:30], (
        "the native path must keep cast order — its ids are invented voices")


# ---------------------------------------------------------------------------
# THE REVIEWER MUST KNOW A SPINE LINE MAY CROSS ITS CUT.
#
# Measured on THE LATE SHIFT b4: "Behind the umbrellas. Red case—" spans
# 36574..39034 against a block ending 38784 — the tail completes in b5 and the
# join reconstructs it (the user heard it flow) — and the reviewer scored the
# owning take DIALOGUE_CUTOFF at coverage 0.8 and queued an auto-retake that
# CANNOT win: the audio is the spine, identical in every take.

def test_spine_fractions_reports_a_crossing_tail():
    import shot_contract as C
    lines = [{"line": "Behind the umbrellas. Red case—",
              "t0_ms": 36574, "t1_ms": 39034},
             {"line": "Fully inside.", "t0_ms": 35000, "t1_ms": 36000}]
    fr = C.spine_fractions(lines, 34677, 38784)
    key = " ".join(C._norm("Behind the umbrellas. Red case—"))
    assert 0.85 <= fr[key] <= 0.93          # 2210 of 2460 ms inside
    assert " ".join(C._norm("Fully inside.")) not in fr


def _stream(words, t0=0.4, step=0.3):
    return [{"word": w, "start": t0 + i * step, "end": t0 + i * step + 0.25}
            for i, w in enumerate(words)]


def test_a_crossing_tail_is_a_continuation_not_a_cutoff():
    import shot_contract as C
    ctr = {"content_ms": 4107, "dialogue": [
        {"speaker": "Priya", "line": "Behind the umbrellas. Red case—"}]}
    heard = _stream(["behind", "the", "umbrellas", "red"])   # "case" in b5
    frac = {" ".join(C._norm("Behind the umbrellas. Red case—")): 0.898}
    matches, issues = C.compare_dialogue(ctr, heard, spine_frac=frac)
    assert not any(i["code"].startswith("DIALOGUE") for i in issues), issues
    assert matches[0].get("continues") is True


def test_a_real_shortfall_still_fires_under_a_fraction():
    """frac 0.9 but only a third of the words heard: something genuinely
    failed, and the fraction must not absorb it."""
    import shot_contract as C
    ctr = {"content_ms": 4107, "dialogue": [
        {"speaker": "Priya", "line": "Behind the umbrellas over the racks red case"}]}
    heard = _stream(["behind", "the"])
    frac = {" ".join(C._norm("Behind the umbrellas over the racks red case")): 0.9}
    _, issues = C.compare_dialogue(ctr, heard, spine_frac=frac)
    assert any(i["code"] in ("DIALOGUE_MISSING", "DIALOGUE_PARTIAL",
                             "DIALOGUE_CUTOFF") for i in issues)


def test_a_whole_line_keeps_strict_scoring_even_on_a_spine_block():
    import shot_contract as C
    ctr = {"content_ms": 8000, "dialogue": [
        {"speaker": "D", "line": "For the avoidance of doubt entirely inside"}]}
    heard = _stream(["for", "the", "avoidance"])
    _, strict = C.compare_dialogue(ctr, heard)
    _, spine = C.compare_dialogue(ctr, heard, spine_frac={})
    assert [i["code"] for i in strict] == [i["code"] for i in spine]


def test_the_fractions_are_computed_from_the_spine_and_nothing_else():
    """WHO READS THEM CHANGED, and the arithmetic did not.

    In the cloud build this was consumed by the automatic reviewer, which
    scored a take against its shot contract and could otherwise report a
    line's tail crossing a cut as DIALOGUE_CUTOFF — the spine's own graceful
    case, and an auto-retake that could never win, since every take carries the
    identical audio. That reviewer is not part of this build. The fractions
    stay because they are what `compare_dialogue` needs to judge a crossing
    line at all, and `dialogue_synth._align_lines` still calls it to measure
    where each line landed in a recording.
    """
    import shot_contract as C
    # Keyed by the line's NORMALIZED TEXT, which is what `compare_dialogue`
    # aligns on — a beat id would not survive the journey.
    fr = C.spine_fractions(
        [{"line": "wholly inside", "t0_ms": 1000, "t1_ms": 2000},
         {"line": "over the cut", "t0_ms": 4000, "t1_ms": 6000}], 0, 5000)
    # Only a line meaningfully SHORT of the window is reported: one fully
    # inside keeps ordinary scoring, so an absent key means "score it strict".
    assert "wholly inside" not in fr
    assert 0 < fr["over the cut"] < 1


# ---- ref-mode slot offsets (the b6 A/B fix) --------------------------------
# Measured failure these pin: on the REFERENCE path the offset PLACES the
# line, the naive ladder said "0.7s into the shot", H3 drifted a further
# +0.7..+1.3s late, and a 4519ms recording ran out of a 6250ms block —
# the quoted tail smeared (turbo) or dropped (PDD).

def test_ref_slot_offsets_take_the_spine_onset_on_the_render_clock():
    import dialogue_spine as DSP
    # b6's real numbers: spine line at 330ms block-relative, one 6250ms shot,
    # 833ms warmup. Shot 1 opens at render t=0, so the honest offset is
    # onset + warmup.
    lines = [{"beat_id": "b", "speaker": "Dennis Okonkwo",
              "line": "This records, and I quote, 'metal thing, possibly musical.'",
              "t0_ms": 330, "t1_ms": 5130}]
    beats = [{"id": "b", "duration_ms": 6250}]
    slots = [{"slot": 1, "kind": "line", "shot_idx": 1, "at_ms": 700,
              "text": "This records, and I quote, 'metal thing, possibly musical.'"}]
    ov = DSP.ref_slot_offsets(lines, beats, 833, slots)
    assert ov == {1: {"at_ms": 1163, "shot_idx": 1}}


def test_a_line_in_a_later_shot_stays_shot_relative_with_no_warmup():
    import dialogue_spine as DSP
    # Later shots' stamps already carry the warmup, so offset and stamp move
    # together — adding warmup there would double-count it.
    lines = [{"beat_id": "b2", "speaker": "P", "line": "Second shot line.",
              "t0_ms": 4000, "t1_ms": 5500}]
    beats = [{"id": "b1", "duration_ms": 3000}, {"id": "b2", "duration_ms": 4000}]
    slots = [{"slot": 1, "kind": "line", "shot_idx": 1, "at_ms": 700,
              "text": "Second shot line."}]
    ov = DSP.ref_slot_offsets(lines, beats, 833, slots)
    assert ov == {1: {"at_ms": 1000, "shot_idx": 2}}


def test_an_unmatched_or_ambiguous_slot_is_left_alone():
    import dialogue_spine as DSP
    lines = [{"beat_id": "b", "speaker": "P", "line": "Twice.", "t0_ms": 100,
              "t1_ms": 400},
             {"beat_id": "b", "speaker": "P", "line": "Twice.", "t0_ms": 900,
              "t1_ms": 1200}]
    beats = [{"id": "b", "duration_ms": 6000}]
    slots = [{"slot": 1, "kind": "line", "shot_idx": 1, "text": "Twice."},
             {"slot": 2, "kind": "line", "shot_idx": 1, "text": "Absent."}]
    assert DSP.ref_slot_offsets(lines, beats, 800, slots) == {}

"""The composer's score: caption compilation, the cue envelope, and the mix.

Three things here are silent when wrong, and each has a test that says so.
A caption trimmed to its budget with the underscore clause amputated is a
song. A cue naming a scene that does not exist is a gain change applied
nowhere. And an amix that normalizes drops the film's dialogue 6dB for the
crime of having music under it.
"""
import json

import pytest

import score_mix as SM
import score_prompt as SP
import storyplan as S


PLAN = {
    "idiom": "spare neo-noir chamber orchestral",
    "bpm": 72, "key_scale": "D minor",
    "arc": "opens on one held cello note and thins as certainty goes",
    "production": "dry 1970s analogue mixing, close-miked",
    "instruments": ["solo cello", "felted upright piano", "low clarinet"],
    "evolution": "the clarinet is the only voice allowed under speech",
    "motif": "a falling four-note cello figure on every mention of the ledger",
    "space": "small wooden room, short plate",
}


# ------------------------------------------------------------------ caption --
def test_the_caption_follows_the_guides_three_passes_in_order():
    """`director/prompt_guides.js` says Music 3 reads global metadata, then
    vocal, then arrangement — and that it reads the front hardest."""
    c = SP.caption(PLAN)
    assert c.index("72 BPM") < c.index("Arrangement")
    assert c.index("D minor") < c.index("solo cello")


def test_the_underscore_clause_survives_a_caption_that_blows_its_budget():
    """The style-clause lesson, one media kind over: the sentence saying this
    is UNDERSCORE is what makes it a score rather than a song, so it lives in
    the head and is never what gets trimmed."""
    fat = {**PLAN, **{k: ("word " * 90).strip() for k in
                      ("arc", "production", "evolution", "motif", "space")}}
    c = SP.caption(fat)
    assert SM.__doc__ and "underscore" in c.lower()
    assert c.startswith("Spare neo-noir")
    assert len(c.split()) <= SP.MAX_WORDS + len(SP.UNDERSCORE_CLAUSE.split())


def test_a_caption_never_ends_mid_clause():
    """Whole sentences are dropped, not characters — a caption ending
    '...brushed drums enter at the' is one the model finishes for you."""
    fat = {**PLAN, "arc": "word " * 200}
    assert SP.caption(fat).rstrip().endswith(".")


def test_instrumental_does_not_say_no_vocals_twice():
    """`handlers/music.INSTRUMENTAL_HINT` already appends exactly that; a
    caption that repeats it is the model reading its own production notes."""
    c = SP.caption({**PLAN, "vocal": "a breathy alto"}, instrumental=True)
    assert "alto" not in c


def test_acestep_gets_tags_and_never_the_typed_controls():
    """Tempo, key and time signature are node INPUTS on that encoder — a tag
    saying '72 BPM' reaches the model as words to sing."""
    t = SP.tags(PLAN)
    assert "," in t and "." not in t
    assert "72" not in t and "BPM" not in t and "D minor" not in t
    assert SP.typed_meta(PLAN) == {"bpm": 72, "key_scale": "D minor"}


def test_music3_is_prose_and_acestep_is_tags_off_one_plan():
    """Handing either family the other's shape is the exact failure a
    per-family guide exists to prevent."""
    assert SP.compile_prompt(PLAN, family="music3").endswith(".")
    assert not SP.compile_prompt(PLAN, family="acestep-1.5").endswith(".")


def test_a_bpm_the_model_wrote_as_words_is_dropped_not_crashed_on():
    assert "BPM" not in SP.caption({**PLAN, "bpm": "seventy-two"})


# The first real composer artifact is what found the next three. Its `arc` was
# 32 words and its `production` 30, and each instrument was a name plus a
# performance note — "felted upright piano, close-miked in the low register".
REAL = {
    "idiom": "restrained chamber film score", "bpm": 72, "key_scale": "D minor",
    "arc": ("The score appears only as a faint mechanical promise at the beginning "
            "and returns with slightly greater human weight at the end, withholding "
            "music entirely through the investigation, confrontation, and separation."),
    "production": ("Recorded with close, dry 1970s chamber-music discipline, light "
                   "analog tape saturation, restrained dynamics, and narrow stereo "
                   "mastering that leaves air around every attack."),
    "instruments": [
        "felted upright piano, close-miked in the low register",
        "double bass, distant arco sul ponticello with restrained bow pressure",
        "bass clarinet, breath-toned and held below the dialogue range",
        "muted vibraphone, soft motor off and mallets striking deadened bars",
        "granular tape loop made from isolated piano-string resonance"],
    "evolution": "The opening admits isolated low piano notes, then withdraws completely",
    "motif": "three low piano attacks, a descending minor second then a rising fourth",
    "space": "dry close room, short wooden flutter, narrow stereo",
}


def test_a_verbose_field_can_no_longer_evict_the_arrangement():
    """MEASURED on the real artifact: a 32-word arc and a 30-word production
    consumed everything after the head and the instrument list never reached
    Music 3 — the one pass its guide calls load-bearing."""
    c = SP.caption(REAL)
    assert "Arrangement" in c
    for name in ("felted upright piano", "double bass", "bass clarinet"):
        assert name in c, name


def test_an_instrument_is_its_head_clause_not_its_first_five_words():
    """Counting words cut "granular tape loop made from isolated piano-string
    resonance" to "...made from", which is not the name of anything."""
    c = SP.caption(REAL)
    assert "granular tape loop" in c
    assert "made from" not in c
    assert "close-miked in," not in c and "arco sul," not in c


def test_no_field_may_run_past_its_own_cap():
    c = SP.caption(REAL)
    # the arc is trimmed at a clause boundary, so it never ends mid-phrase
    assert "withholding music entirely" not in c
    assert ", ." not in c and " ." not in c


def test_the_caption_still_fits_the_guides_budget():
    c = SP.caption(REAL)
    assert len(c.split()) <= SP.MAX_WORDS + len(SP.UNDERSCORE_CLAUSE.split())


def test_duplicate_instruments_collapse_once_they_are_trimmed():
    """Two entries whose heads are the same instrument are one instrument."""
    plan = {**REAL, "instruments": ["felted upright piano, close-miked",
                                    "felted upright piano, pedal down",
                                    "double bass, arco"]}
    names = SP.caption(plan).split("Arrangement: ")[1].split(".")[0]
    assert names.count("felted upright piano") == 1


# --------------------------------------------------------------- normalize --
STORY = {"scenes": [{"slug": "OPENING"}, {"slug": "THE_ROOM"}, {"slug": "OUT"}]}


def test_every_scene_gets_a_cue_even_when_the_composer_skipped_it():
    """The mix reads cues by slug. A scene with no cue would silently take
    whatever the envelope's default is; 3 IS the bed, stated once."""
    score = S.normalize_score({"score": {"cues": [
        {"scene": "OPENING", "intensity": 5}]}}, STORY)
    assert [c["scene"] for c in score["cues"]] == ["OPENING", "THE_ROOM", "OUT"]
    assert [c["intensity"] for c in score["cues"]] == [5, 3, 3]


def test_a_cue_naming_a_scene_that_does_not_exist_is_reported_not_silently_dropped():
    score = S.normalize_score({"score": {"cues": [
        {"scene": "A_SCENE_THE_WRITER_CUT", "intensity": 0}]}}, STORY)
    assert score["unmatched_cues"] == ["A_SCENE_THE_WRITER_CUT"]


def test_intensity_is_clamped_to_the_scale_the_contract_states():
    score = S.normalize_score({"score": {"cues": [
        {"scene": "OPENING", "intensity": 99},
        {"scene": "THE_ROOM", "intensity": -4}]}}, STORY)
    assert [c["intensity"] for c in score["cues"][:2]] == [S.MAX_INTENSITY, 0]


def test_instruments_sent_as_prose_still_arrive_as_a_list():
    score = S.normalize_score({"score": {"instruments": "cello, piano"}}, STORY)
    assert score["instruments"] == ["cello", "piano"]


# ---------------------------------------------------------------- envelope --
BLOCKS = [
    {"scene_ids": ["a"], "t_start_ms": 0, "t_end_ms": 4000},
    {"scene_ids": ["a"], "t_start_ms": 4000, "t_end_ms": 9000},
    {"scene_ids": ["b"], "t_start_ms": 9000, "t_end_ms": 15000},
]
SLUGS = {"a": "OPENING", "b": "THE_ROOM"}


def test_a_block_takes_the_cue_of_the_scene_it_opens_on():
    spans = SM.cue_spans(BLOCKS, SLUGS, [{"scene": "OPENING", "intensity": 4},
                                         {"scene": "THE_ROOM", "intensity": 0}])
    assert spans == [(0, 4000, 4), (4000, 9000, 4), (9000, 15000, 0)]


def test_consecutive_blocks_at_one_intensity_are_one_level_not_three_points():
    """A five-block scene is one cue. Points only land where the music was
    actually asked to change."""
    pts = SM.envelope_points(SM.cue_spans(
        BLOCKS, SLUGS, [{"scene": "OPENING", "intensity": 4},
                        {"scene": "THE_ROOM", "intensity": 0}]))
    assert [p["t_ms"] for p in pts] == [0, 7800, 9000, 15000]


def test_a_cue_change_is_a_ramp_and_never_a_step():
    pts = SM.envelope_points(SM.cue_spans(
        BLOCKS, SLUGS, [{"scene": "OPENING", "intensity": 4},
                        {"scene": "THE_ROOM", "intensity": 0}]))
    lead = next(p for p in pts if p["t_ms"] == 9000 - SM.CUE_RAMP_MS)
    assert lead["gain_db"] == SM.INTENSITY_DB[4]
    assert next(p for p in pts if p["t_ms"] == 9000)["gain_db"] == SM.INTENSITY_DB[0]


def test_a_ramp_never_reaches_back_before_the_span_it_leaves():
    """A block shorter than the ramp would otherwise produce points out of
    order, and ffmpeg's nested if() reads them in order."""
    tight = [{"scene_ids": ["a"], "t_start_ms": 0, "t_end_ms": 400},
             {"scene_ids": ["b"], "t_start_ms": 400, "t_end_ms": 5000}]
    pts = SM.envelope_points(SM.cue_spans(
        tight, SLUGS, [{"scene": "OPENING", "intensity": 5},
                       {"scene": "THE_ROOM", "intensity": 1}]))
    assert [p["t_ms"] for p in pts] == sorted(p["t_ms"] for p in pts)


def test_a_film_the_composer_scored_as_unscored_is_not_re_encoded():
    """Mixing a -60dB bed under the whole cut is a pointless re-encode, and
    re-encoding when nothing changes turns a `-c copy` concat into a
    generation loss."""
    pts = SM.envelope_points(SM.cue_spans(
        BLOCKS, SLUGS, [{"scene": "OPENING", "intensity": 0},
                        {"scene": "THE_ROOM", "intensity": 0}]))
    assert SM.all_silent(pts)
    assert not SM.all_silent(SM.envelope_points(SM.cue_spans(
        BLOCKS, SLUGS, [{"scene": "OPENING", "intensity": 1}])))


# -------------------------------------------------------------- bed level ---
def test_the_bed_lands_the_stated_distance_under_the_programme():
    assert SM.bed_gain_db(-12.0, -20.0) == pytest.approx(-20.0 - SM.BED_BELOW_LU + 12.0)


def test_an_unmeasurable_side_declines_to_guess():
    """A score placed by guess is either inaudible or on top of the dialogue,
    and both look like the feature not working."""
    assert SM.bed_gain_db(None, -20.0) is None
    assert SM.bed_gain_db(-12.0, None) is None


def test_amix_never_normalizes():
    """`normalize=1` divides by the input count — the film's dialogue drops
    6dB for the crime of having music under it."""
    fc = SM.filter_complex([{"t_ms": 0, "gain_db": 0}], -9.0,
                           cut_ms=12000, score_ms=12000, has_programme=True)
    assert "normalize=0" in fc


def test_a_short_score_fades_out_and_pads_rather_than_truncating_the_film():
    """`duration=first` would take the SHORTER input and cut the film's own
    audio off with it."""
    fc = SM.filter_complex([{"t_ms": 0, "gain_db": 0}], -9.0,
                           cut_ms=12000, score_ms=8000, has_programme=True)
    assert "afade=t=out:st=6.000" in fc
    assert "apad=whole_dur=12.000" in fc


def test_a_cut_with_no_audio_of_its_own_still_gets_its_score():
    fc = SM.filter_complex([{"t_ms": 0, "gain_db": 0}], -9.0,
                           cut_ms=12000, score_ms=12000, has_programme=False)
    assert "amix" not in fc and fc.endswith("[aout]")

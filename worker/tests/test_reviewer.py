"""Aligning a SCRIPTED line against what a recording actually says.

`shot_contract` is the measurement half of what used to be a whole automatic
reviewer, and it survived that removal because `dialogue_synth._align_lines`
depends on it: an exchange is synthesised as ONE recording, and where each line
landed inside it has to be measured before the shots can be cut to it. Every
case below is a real transcript shape that scored a perfectly spoken line at
0% — a leading space, a digit against a written number, a contraction, a
tokeniser splitting "$200,000" in half.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import shot_contract as C  # noqa: E402


def _contract(dialogue=None, content_ms=13500):
    return {
        "content_ms": content_ms,
        "dialogue": dialogue if dialogue is not None else [
            {"shot": 2, "speaker": "Dez",
             "line": "You were never supposed to see what was on that shard.",
             "window_ms": [4000, 9500], "min_ms": 5000},
        ],
        "shots": [], "characters": [], "environment": None,
    }


def _words(text, start=4.2, per=0.32):
    out, t = [], start
    for w in text.split():
        out.append({"word": w, "start": round(t, 2), "end": round(t + per, 2)})
        t += per + 0.04
    return out


def test_full_line_spoken_passes():
    m, issues = C.compare_dialogue(
        _contract(), _words("You were never supposed to see what was on that shard."))
    assert issues == [] or all(i["severity"] == "low" for i in issues)
    assert m[0]["coverage"] >= 0.9


def test_faster_whisper_leading_spaces_still_match():
    """faster-whisper emits words like ' You' — live block 0 scored a
    perfectly spoken line at 0% coverage because of the leading space."""
    words = [{"word": " You", "start": 2.0, "end": 2.3},
             {"word": " jumped.", "start": 2.35, "end": 2.8}]
    ctr = {"content_ms": 11000, "dialogue": [
        {"shot": 1, "speaker": "Zara Voss", "line": "You jumped.",
         "window_ms": [0, 4000], "min_ms": 2000}]}
    m, issues = C.compare_dialogue(ctr, words)
    assert m[0]["coverage"] == 1.0
    assert not any(i["code"] == "DIALOGUE_MISSING" for i in issues)


def test_cutoff_at_segment_end_is_flagged_hard():
    # Only the first two thirds spoken, and the audio runs to the very end of
    # the content window — the tail was trimmed off.
    m, issues = C.compare_dialogue(
        _contract(content_ms=8000),
        _words("You were never supposed to see", start=6.0))
    codes = {i["code"] for i in issues}
    assert "DIALOGUE_CUTOFF" in codes
    assert any(i["severity"] == "high" for i in issues)


def test_missing_line_is_flagged():
    m, issues = C.compare_dialogue(_contract(), _words("completely different words spoken here"))
    assert any(i["code"] == "DIALOGUE_MISSING" for i in issues)


def test_unscripted_speech_in_silent_block():
    m, issues = C.compare_dialogue(
        _contract(dialogue=[]),
        _words("somebody is talking a lot in this wordless block right now"))
    assert any(i["code"] == "UNSCRIPTED_SPEECH" for i in issues)


def test_ebur128_parse_takes_the_summary_not_the_running_meter():
    """ffmpeg prints a running `I:` line per frame starting at -70 LUFS; the
    real integrated value is the LAST match (the summary). First-match parsing
    scored every live take 'silent' and burned two auto-retakes."""
    import re as _re
    src = open(Path(__file__).parent.parent / "audioqa.py").read()
    ns = {"re": _re}
    exec("def parse_ebur128" + src.split("def parse_ebur128")[1].split("def dsp_metrics")[0], ns)
    stderr = ("[Parsed_ebur128_0] t: 0.1  I: -70.0 LUFS\n"
              "[Parsed_ebur128_0] t: 5.0  I: -24.9 LUFS\n"
              "  Integrated loudness:\n    I:         -20.1 LUFS\n"
              "  True peak:\n    Peak:      -3.5 dBFS\n")
    out = ns["parse_ebur128"](stderr)
    assert out == {"integrated_lufs": -20.1, "true_peak_dbfs": -3.5}


def test_scores_and_verdict_routing():
    hard = [{"code": "DIALOGUE_CUTOFF", "severity": "high", "detail": "x"}]
    soft = [{"code": "DIALOGUE_TIGHT_TAIL", "severity": "low", "detail": "x"}]
    s_hard, s_soft = C.score(hard), C.score(soft)
    assert s_hard["dialogue"] < s_soft["dialogue"] <= 1.0
    v, why = C.verdict(hard, s_hard)
    assert v == "retake" and why
    v2, why2 = C.verdict(soft, s_soft)
    assert v2 == "keep" and not why2


def test_patch_when_damage_is_local_and_ranged():
    ranged = [{"code": "FROZEN_FRAMES", "severity": "high", "detail": "x",
               "range_ms": [9000, 11000]}]
    v, _ = C.verdict(ranged, C.score(ranged))
    assert v == "patch"


def test_build_contract_projects_the_block():
    block = {"idx": 3, "t_start_ms": 10000, "t_end_ms": 22000,
             "chain_from_block_id": "x"}
    beats = [
        {"duration_ms": 5000, "camera": "a wide shot", "action": "They meet.",
         "dialogue": [{"speaker": "Zara Voss — courier rig", "line": "You came."}],
         "meta": {"cast": ["Zara Voss"], "beat": {"label": "greeting"}}},
        {"duration_ms": 7000, "camera": "a close-up", "action": "She answers.",
         "dialogue": [], "meta": {"cast": ["Mara"]}},
    ]
    cast = [{"name": "Zara Voss — courier rig", "identity_line": "short hair"}]
    scenes = [{"meta": {"time": "night, heavy rain", "type": "dialogue"}}]
    ctr = C.build_contract(block=block, beats=beats, cast=cast,
                          environment={"name": "Bar"}, scenes=scenes,
                          world={"vfx_language": "arcs of blue-white lightning"})
    assert ctr["content_ms"] == 12000
    assert ctr["vfx_language"] == "arcs of blue-white lightning"
    assert ctr["time_of_day"] == "night, heavy rain"
    assert ctr["shots"][0]["t1_ms"] == 5000 and ctr["shots"][1]["t0_ms"] == 5000
    # variant names collapse to the character's base name everywhere
    assert ctr["characters"][0]["name"] == "Zara Voss"
    assert ctr["dialogue"][0]["speaker"] == "Zara Voss"
    assert ctr["chained"] is True


def test_planner_moves_talky_boundary_shot():
    import planner
    scenes = [{"id": "s1", "environment_id": "e1", "beats": [
        {"id": "b1", "duration_ms": 9000, "dialogue": []},
        {"id": "b2", "duration_ms": 5000,
         "dialogue": [{"line": "twelve words of dialogue that need every "
                               "millisecond of this shot to finish"}]},
        {"id": "b3", "duration_ms": 6000, "dialogue": []},
        {"id": "b4", "duration_ms": 5000, "dialogue": []},
    ]}]
    blocks = planner.plan_blocks(scenes, medium="film")
    # b2 is dialogue-heavy; wherever the boundary lands it must not land right
    # after b2 (the talky shot must not END a block).
    for blk in blocks[:-1]:
        assert blk["beat_ids"][-1] != "b2", blocks


def _stream(text, t0=0.0):
    words, t = [], t0
    for w in text.split():
        words.append({"word": f" {w}", "start": t, "end": t + 0.3})
        t += 0.35
    return words


def test_dialogue_echo_is_measured_not_vibed():
    ctr = {"content_ms": 10000,
           "dialogue": [{"speaker": "Odessa", "line": "A fire kept is a fire spent."}]}
    prev = [{"speaker": "Saya Vayne", "line": "The Cantor follows the light."}]
    # the take opens by re-speaking the previous block's line — the live 8→9 cascade
    words = _stream("The Cantor follows the light. A fire kept is a", t0=0.5)
    issues = C.echo_issues(ctr, prev, words)
    assert [i["code"] for i in issues] == ["DIALOGUE_ECHO"]
    assert issues[0]["severity"] == "high"
    assert "Cantor follows the light" in issues[0]["detail"]
    # DIALOGUE_ECHO is a hard code -> retake
    v, hard = C.verdict(issues, C.score(issues))
    assert v == "retake" and hard


def test_echo_ignores_lines_this_block_also_expects():
    ctr = {"content_ms": 8000,
           "dialogue": [{"speaker": "Odessa", "line": "Hold the wall."}]}
    prev = [{"speaker": "Odessa", "line": "Hold the wall."}]
    assert C.echo_issues(ctr, prev, _stream("Hold the wall.")) == []


def test_echo_needs_real_coverage():
    ctr = {"content_ms": 8000, "dialogue": []}
    prev = [{"speaker": "Bren", "line": "No one below has seen your way home in twenty years."}]
    # two stray shared words are not an echo
    assert C.echo_issues(ctr, prev, _stream("the way is long")) == []


# ------------------------------------------------- directed retakes + props --
def test_retake_directives_prefer_the_judges_own_phrasing():
    hard = [
        {"code": "GEOGRAPHY_BREAK", "severity": "high",
         "directive": "Keep Bren at the gate tower for the whole segment."},
        {"code": "WRONG_ENVIRONMENT", "severity": "high"},           # fallback
        {"code": "WRONG_ENVIRONMENT", "severity": "high"},           # deduped
        {"code": "DIALOGUE_CUTOFF", "severity": "high"},             # no phrase
    ]
    out = C.retake_directives(hard)
    assert out.startswith("Keep Bren at the gate tower")
    assert out.count("declared") == 1                     # env phrase, once
    assert "DIALOGUE_CUTOFF" not in out
    assert C.retake_directives([]) == ""


def test_contract_carries_props_and_positions():
    block = {"idx": 3, "t_start_ms": 0, "t_end_ms": 8000,
             "chain_from_block_id": None}
    beats = [{"duration_ms": 8000, "camera": "a wide shot", "action": "they clash",
              "dialogue": [],
              "meta": {"cast": ["Ash", "Vex"],
                       "positions": {"Ash": "at the teller cage",
                                     "Vex": "on the catwalk"}}}]
    ctr = C.build_contract(
        block=block, beats=beats,
        cast=[{"name": "Ash"}, {"name": "Vex"}], environment=None,
        scenes=[{"meta": {"type": "action"}}],
        props=[{"name": "the shard drive"}, {"name": ""}])
    assert ctr["props"] == ["the shard drive"]
    assert ctr["shots"][0]["positions"]["Vex"] == "on the catwalk"
    # no props -> the key stays honest (None, not [])
    bare = C.build_contract(block=block, beats=beats, cast=[], environment=None,
                            scenes=[])
    assert bare["props"] is None


def test_speaker_codes_route_by_confidence():
    # WRONG_SPEAKER is a hard retake; SPEAKER_SUSPECT never is.
    hard_scores = C.score([{"code": "WRONG_SPEAKER", "severity": "high"}])
    v, _ = C.verdict([{"code": "WRONG_SPEAKER", "severity": "high"}], hard_scores)
    assert v == "retake"
    soft = [{"code": "SPEAKER_SUSPECT", "severity": "medium"}]
    v2, _ = C.verdict(soft, C.score(soft))
    assert v2 == "keep"
    assert C.CATEGORY["SPEAKER_SUSPECT"] == "dialogue"


# THE SPEAKER VERIFIER IS NOT PART OF THIS BUILD. It compared a take's voices
# against a character's canonical clip with a speaker-embedding model, to catch
# a line delivered by the wrong mouth — one stage of the automatic reviewer,
# and the only one that needed a second neural model resident beside a render.
# What survived is the measurement above, because the dialogue spine needs it.


def test_digit_transcripts_align_with_written_numbers():
    # ASR writes digits; the script writes words. Live: "200,000 keeps her
    # contracted this job pays to" scored 0% against the contracted line and
    # burned a retake on a line that was spoken.
    ctr = _contract([{"shot": 1, "speaker": "Odile",
                      "line": "Two hundred thousand keeps her contracted. "
                              "This job pays two-fifty.",
                      "window_ms": [0, 9000], "min_ms": 6000}])
    words = ([{"word": " 200,000", "start": 1.0, "end": 1.9}]
             + _words("keeps her contracted this job pays", start=2.0)
             + [{"word": " 250.", "start": 4.6, "end": 5.1}])
    matches, issues = C.compare_dialogue(ctr, words)
    assert matches[0]["coverage"] >= 0.9
    assert not [i for i in issues if i["code"] == "DIALOGUE_MISSING"]
    # decimals + plain ints expand too
    assert C._expand_digits("2.5") == ["two", "point", "five"]
    assert C._expand_digits("47") == ["forty", "seven"]
    assert C._expand_digits("word") == ["word"]


def test_split_number_tokens_merge_before_expansion():
    # Whisper word tokens split '$200,000' into '$200' + ',000' (measured
    # live) — the fragments must merge back before digit expansion.
    ctr = _contract([{"shot": 1, "speaker": "Odile",
                      "line": "Two hundred thousand keeps her contracted.",
                      "window_ms": [0, 9000], "min_ms": 4000}])
    words = ([{"word": " $200", "start": 1.0, "end": 1.4},
              {"word": ",000", "start": 1.4, "end": 1.9}]
             + _words("keeps her contracted", start=2.0))
    matches, issues = C.compare_dialogue(ctr, words)
    assert matches[0]["coverage"] == 1.0
    assert not issues


def test_contractions_and_tens_pairs_normalize():
    # "I'm buying" vs ASR "I am buying"; "sixty-forty" vs ASR "4060" —
    # both measured live as false DIALOGUE_MISSING.
    ctr = _contract([
        {"shot": 1, "speaker": "Mara", "line": "I'm buying her name back.",
         "window_ms": [0, 5000], "min_ms": 2500},
        {"shot": 2, "speaker": "Dex", "line": "Sixty-forty it remembers gravity.",
         "window_ms": [5000, 10000], "min_ms": 3000}])
    words = (_words("I am buying her name back", start=1.0)
             + [{"word": " 4060", "start": 5.5, "end": 6.2}]
             + _words("it remembers gravity", start=6.4))
    matches, issues = C.compare_dialogue(ctr, words)
    assert matches[0]["coverage"] == 1.0
    assert matches[1]["coverage"] == 1.0
    assert not issues


def test_hyphenated_digit_pairs_expand():
    # "Fifty-fifty the anchor holds" arrives from the ASR as "50-50 the
    # anchor holds" (measured live on every odds line in NEONFALL E1).
    assert C._expand_digits("50-50") == ["fifty", "fifty"]
    assert C._expand_digits("90-10") == ["ninety", "ten"]
    ctr = _contract([{"shot": 1, "speaker": "Dex",
                      "line": "Fifty-fifty the anchor holds.",
                      "window_ms": [0, 5000], "min_ms": 2500}])
    words = ([{"word": " 50-50", "start": 1.0, "end": 1.6}]
             + _words("the anchor holds", start=1.8))
    matches, issues = C.compare_dialogue(ctr, words)
    assert matches[0]["coverage"] == 1.0 and not issues


def test_asr_contractions_match_expanded_script():
    """The ASR writes "wasn't" where the script's norm says "was"+"not" —
    the stream side expands too, or a verbatim take scores a miss (measured:
    AFTERLIGHT exchange alignment failed 8/8 on a perfect clip)."""
    ctr = {"content_ms": 6000, "dialogue": [
        {"shot": 1, "speaker": "Aki", "line": "This wasn't here yesterday.",
         "window_ms": [0, 4000], "min_ms": 2000}]}
    m, issues = C.compare_dialogue(ctr, _words("This wasn't here yesterday.", start=0.5))
    assert m[0]["coverage"] == 1.0
    assert not any(i["code"] == "DIALOGUE_MISSING" for i in issues)


def test_one_unheard_word_does_not_poison_later_lines():
    """The old scan chased a missing word to the end of the stream and
    dragged the cursor with it, so every line after scored 0%. A miss now
    costs itself only."""
    ctr = {"content_ms": 20000, "dialogue": [
        {"shot": 1, "speaker": "A", "line": "This wasn't here yesterday.",
         "window_ms": [0, 5000], "min_ms": 2000},
        {"shot": 2, "speaker": "B", "line": "You drew him before the sky broke.",
         "window_ms": [5000, 10000], "min_ms": 2000},
        {"shot": 3, "speaker": "A", "line": "Don't trust your memory.",
         "window_ms": [10000, 15000], "min_ms": 2000}]}
    heard = "This here yesterday. You drew him before the sky broke. Don't trust your memory."
    m, issues = C.compare_dialogue(ctr, _words(heard, start=0.5))
    # line 1 lost one word ("wasn't"); lines 2 and 3 are fully heard
    assert m[0]["coverage"] >= 0.6
    assert m[1]["coverage"] == 1.0
    assert m[2]["coverage"] == 1.0
    assert not any(i["code"] == "DIALOGUE_MISSING" for i in issues)

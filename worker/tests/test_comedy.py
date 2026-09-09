"""The PUNCH-UP stage's deterministic half.

Same standard `fight_issues` is held to: every check must fire on the defect
it names AND stay silent on prose that is already right. A check that flags
correct writing is a re-ask every run and a warning nobody reads — the mistake
the action-before-speech check made once.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from storyplan import (FOIL_SHARE_MAX, MIN_LINES_PER_MIN,  # noqa: E402
                       comedy_issues, is_comedy)


def _b(ms, *lines):
    return {"duration_ms": ms,
            "dialogue": [{"speaker": s, "line": l} for s, l in lines]}


def _good():
    """A short sitcom that does everything right: buttons, density, a foil,
    and a runner ('Tuesday is a big day') planted in the cold open and paid
    off in the tag."""
    return {"scenes": [
        {"slug": "COLD_OPEN", "beats": [
            _b(6000, ("Reg", "The rota is a living document."),
                     ("Mo", "It's a laminated threat.")),
            _b(6000, ("Reg", "I laminated it so it would last."),
                     ("Mo", "It'll outlive all of us.")),
            _b(6000, ("Reg", "That's the idea."), ("Mo", "Reg."), ("Reg", "Mm."),
                     ("Mo", "You put yourself down for Tuesday four times.")),
            _b(5000, ("Reg", "Tuesday is a big day."))]},
        {"slug": "MIDDLE", "beats": [
            _b(6000, ("Mo", "Nobody's coming to the meeting."),
                     ("Reg", "They're coming.")),
            _b(6000, ("Mo", "It's been twenty minutes."),
                     ("Reg", "They're respecting the rota.")),
            _b(6000, ("Mo", "The rota says Thursday."), ("Reg", "Then they're early.")),
            _b(5000, ("Mo", "Tuesday is a big day, Reg."), ("Reg", "Don't."))]},
        {"slug": "TAG", "beats": [
            _b(6000, ("Reg", "I've made a second rota."), ("Mo", "For the first rota?")),
            _b(6000, ("Reg", "For the people who ignore the first one."),
                     ("Mo", "Is it laminated?")),
            _b(5000, ("Reg", "It's laminated."), ("Mo", "Tuesday is a big day."))]}]}


def test_well_formed_sitcom_raises_nothing():
    """The calibration half. If this ever starts failing, the check has begun
    firing on correct prose and is worse than no check."""
    assert comedy_issues(_good()) == []


def test_a_scene_that_trails_off_into_action_has_no_button():
    story = _good()
    story["scenes"][0]["beats"].append({"duration_ms": 4000, "dialogue": []})
    issues = comedy_issues(story)
    assert any("no button" in i and "COLD_OPEN" in i for i in issues)


def test_a_two_line_scene_is_not_asked_for_a_button():
    """A scene with almost no dialogue is not what the button rule is about,
    and a visual gag legitimately ends on action."""
    story = {"scenes": [{"slug": "BIT", "beats": [
        _b(4000, ("Reg", "Don't.")),
        {"duration_ms": 4000, "dialogue": []}]}]}
    assert not any("button" in i for i in comedy_issues(story))


def test_a_drama_paced_scene_is_flagged_with_a_target():
    story = {"scenes": [{"slug": "SLOW", "beats": [
        _b(20000, ("Reg", "I have been thinking about the rota.")),
        _b(20000, ("Mo", "Right.")),
        _b(20000, ("Reg", "It is not working for anyone here."))]}]}
    issues = comedy_issues(story)
    hit = next(i for i in issues if "lines a minute" in i)
    assert "SLOW" in hit
    # it names the number to hit, not just the failure
    assert f"about {int(MIN_LINES_PER_MIN * 60000 / 60000.0)}" in hit or "about 8" in hit


def test_a_short_scene_is_not_measured_for_density():
    """Under 20s the ratio is noise — three lines in an 8s runner scene is a
    perfectly good sitcom beat, and 3/0.13min reads as a failure."""
    story = {"scenes": [{"slug": "QUICK", "beats": [
        _b(4000, ("Reg", "No.")), _b(4000, ("Mo", "Yes.")),
        _b(4000, ("Reg", "No."))]}]}
    assert not any("lines a minute" in i for i in comedy_issues(story))


def test_a_monologue_in_company_is_flagged_for_having_no_foil():
    story = {"scenes": [{"slug": "SPEECH", "beats": [
        _b(6000, ("Reg", "One."), ("Reg", "Two."), ("Reg", "Three.")),
        _b(6000, ("Reg", "Four."), ("Reg", "Five."), ("Reg", "Six."),
                 ("Reg", "Seven."), ("Reg", "Eight."), ("Mo", "Mm."))]}]}
    issues = comedy_issues(story)
    assert any("nobody is playing off them" in i for i in issues)
    # the share it reports is the real one
    assert any(f"{8 / 9:.0%}" in i for i in issues)


def test_a_genuine_solo_scene_is_not_asked_for_a_foil():
    """One person alone in a room is not a scene missing its straight man."""
    story = {"scenes": [{"slug": "ALONE", "beats": [
        _b(6000, ("Reg", "Right."), ("Reg", "Fine."), ("Reg", "Good."))]}]}
    assert not any("playing off" in i for i in comedy_issues(story))
    assert FOIL_SHARE_MAX < 1.0


def test_an_episode_with_no_callback_is_flagged_once():
    """Nothing contentful recurs across these three scenes — no shared 2-gram
    and no shared long word — which is the one thing this check is for."""
    story = {"scenes": [
        {"slug": "A", "beats": [_b(9000, ("Reg", "Bring the ladder."),
                                   ("Mo", "It broke."), ("Reg", "Again?"))]},
        {"slug": "B", "beats": [_b(9000, ("Mo", "Somebody parked outside."),
                                   ("Reg", "Whose van?"), ("Mo", "No idea."))]},
        {"slug": "C", "beats": [_b(9000, ("Reg", "Dinner is cancelled."),
                                   ("Mo", "By whom?"), ("Reg", "Weather."))]}]}
    issues = [i for i in comedy_issues(story) if "runner" in i]
    assert len(issues) == 1


def test_the_runner_check_ignores_phrases_that_are_all_filler():
    """'and then i' recurring is not a callback. Without the stopword floor
    every script would 'have a runner' and the check would never fire."""
    story = {"scenes": [
        {"slug": "A", "beats": [_b(9000, ("Reg", "And then I went and then I saw."),
                                   ("Mo", "And then I did."), ("Reg", "Sure."))]},
        {"slug": "B", "beats": [_b(9000, ("Mo", "And then I left and then I came."),
                                   ("Reg", "And then I stayed."), ("Mo", "Fine."))]},
        {"slug": "C", "beats": [_b(9000, ("Reg", "And then I stopped."),
                                   ("Mo", "And then I waited."), ("Reg", "Right."))]}]}
    assert any("runner" in i for i in comedy_issues(story))


def test_a_two_scene_piece_is_not_asked_for_a_runner():
    story = {"scenes": [
        {"slug": "A", "beats": [_b(9000, ("Reg", "One."), ("Mo", "Two."), ("Reg", "Three."))]},
        {"slug": "B", "beats": [_b(9000, ("Mo", "Four."), ("Reg", "Five."), ("Mo", "Six."))]}]}
    assert not any("runner" in i for i in comedy_issues(story))


def test_is_comedy_reads_the_brief_not_the_script():
    assert is_comedy({"genre": "Sitcom"})
    assert is_comedy({"tone": "warm, deadpan comedy"})
    assert is_comedy({"logline": "A workplace comedy about a failing bakery."})
    assert is_comedy({"world": {"premise": "an office farce"}})
    assert not is_comedy({"genre": "thriller", "tone": "bleak"})
    assert not is_comedy({})
    assert not is_comedy(None)


def test_a_comedy_scene_gets_no_breath_shot():
    """A sitcom cuts on the laugh. The breath shot is a drama fix (scenes were
    cutting straight out of a line into the next location and reading as
    rushed) and it is appended AFTER `comedy_issues` runs — so on the first
    sitcom planned here the check passed every scene's button and all eleven
    scenes still ended on a 1.75s wordless hold. Pinned by source, because
    run_pipeline needs an LLM and a database."""
    import inspect
    import storyplan
    src = inspect.getsource(storyplan.run_pipeline)
    assert "if not comedy:" in src and "add_breath_shot" in src
    i_guard = src.index("if not comedy:")
    i_call = src.index("add_breath_shot(scene_by_slug[slug], shots)")
    assert i_guard < i_call, "the breath shot must sit under the comedy guard"


def test_a_one_word_runner_is_seen():
    """The runner check got this WRONG on the first real sitcom it saw.

    That episode's callback was a single adverb — "Operationally", the night
    manager's verbal tic, planted in scene two and paid off as the last line
    of the tag — and a 3-gram scan could not see it, because the words AROUND
    a good callback change every time. It reported "no runner" about an
    episode built on one."""
    story = {"scenes": [
        {"slug": "A", "beats": [_b(9000, ("Reg", "Operationally, that distinction is unhelpful."),
                                   ("Mo", "It is a laundrette."), ("Reg", "One column."))]},
        {"slug": "B", "beats": [_b(9000, ("Mo", "Sign the note."), ("Reg", "Not conventionally."),
                                   ("Mo", "Fine."))]},
        {"slug": "C", "beats": [_b(9000, ("Mo", "He wants it back."), ("Reg", "Documentation."),
                                   ("Reg", "Operationally, I have been abandoned."))]}]}
    assert not any("runner" in i for i in comedy_issues(story))


def test_the_runner_check_is_deliberately_conservative():
    """It cannot tell a callback from the premise: "Tuesday" said in every
    scene and "Operationally" said in two are both cross-scene repetition, and
    separating them needs a notion of distinctiveness this has no corpus for.
    So it is calibrated to fire ONLY on a script with essentially no
    contentful repetition anywhere — the direction that cannot flag correct
    prose, which is the failure mode that actually costs something."""
    premise_only = {"scenes": [
        {"slug": "A", "beats": [_b(9000, ("Reg", "Tuesday."), ("Mo", "Right."), ("Reg", "Yes."))]},
        {"slug": "B", "beats": [_b(9000, ("Mo", "Tuesday?"), ("Reg", "No."), ("Mo", "Fine."))]},
        {"slug": "C", "beats": [_b(9000, ("Reg", "Tuesday!"), ("Mo", "Sure."), ("Reg", "Good."))]}]}
    assert not any("runner" in i for i in comedy_issues(premise_only))


def test_the_writer_is_given_a_line_budget_the_runtime_can_hold():
    """Nothing downstream can shorten dialogue: `_fit_durations` scales beats
    onto the target and then the measured pass GROWS every dialogue shot to
    its recorded lines. So overwriting does not make a denser episode, it
    makes a longer one — measured on CLOSING TIME EP01, which asked for 300s,
    delivered 92 lines and came out at 468s (5.1s of runtime per line)."""
    import inspect
    import llm
    import storyplan
    src = inspect.getsource(llm.plan_storyboard)
    assert "dialogue_line_budget" in src
    assert "dialogue_line_budget" in storyplan.WRITER_CONTRACT
    # the budget tracks the target and never collapses to nothing
    def budget(ms):
        return max(6, round(ms / 5100))
    assert budget(300000) == 59
    assert budget(60000) == 12
    assert budget(1000) == 6

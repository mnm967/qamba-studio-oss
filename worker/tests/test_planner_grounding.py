"""What the planner is actually grounded in.

Two gaps this pins shut. The planner read our hand distillation of the H3 guide
(h3_prompt_craft.md) and never the vendor's own doc, which is the exact drift
prompt_guides.js stopped tolerating on the composer side. And the wizard's
expert checkboxes reached the worker as prose in `notes` while every craft doc
loaded regardless — so ticking "Fight choreography" changed nothing.
"""
import inspect

import llm


def test_the_room_is_empty_until_experts_are_named():
    assert llm.the_room([]) == ""
    assert llm.the_room(None) == ""
    assert llm.the_room(["astrology"]) == "", "an unknown id is not a specialist"


def test_the_room_states_each_expert_and_their_remit():
    block = llm.the_room(["vfx", "costume"])
    assert "# The room" in block
    assert "VFX: practical vs. impossible imagery" in block
    assert "Costume & continuity: wardrobe pieces" in block
    assert "Fight choreography" not in block
    # A list of names is decoration; the ask is what makes it binding.
    assert "visible decision" in block


def test_experts_pull_their_own_craft_docs():
    base = llm.builtin_knowledge("film", ["writing"])
    with_vfx = llm.builtin_knowledge("film", ["writing", "vfx"])
    assert len(with_vfx) > len(base), "VFX should bring action_vfx_craft.md"
    # Choreography reads the same doc, so naming both must not load it twice.
    assert llm.builtin_knowledge("film", ["writing", "vfx", "choreo"]) == with_vfx


def test_the_floor_loads_for_everyone():
    """Nobody selected should not mean an ungrounded planner."""
    thin = llm.builtin_knowledge("film", ["writing"])
    for marker in ("shot", "camera"):
        assert marker in thin.lower()
    # No experts named at all (director chat, older jobs) keeps the old
    # everything-loads behaviour rather than silently narrowing.
    assert len(llm.builtin_knowledge("film", [])) >= len(thin)


def test_music_video_still_gets_its_guide_whoever_is_in_the_room():
    mv = llm.builtin_knowledge("music_video", ["writing"])
    film = llm.builtin_knowledge("film", ["writing"])
    assert len(mv) > len(film), "the medium's own guide is not an expert's to bring"


def test_an_absent_vendor_guide_weakens_the_turn_and_does_not_fail_it(tmp_path,
                                                                      monkeypatch):
    """MINIMAX'S OWN H3 GUIDES ARE NOT SHIPPED. They are several thousand words
    of theirs and this project has no licence to redistribute them, so
    `director/knowledge/` carries the craft notes and not those two files —
    see the README there for how to put them back.

    What has to hold is the degradation: `_read_knowledge` answers "" for a
    file that is not there and `format_reference` answers "" in turn, so a plan
    runs on the craft guides alone rather than dying on a missing document.
    """
    assert llm._read_knowledge("h3_official_base_modes.md") == ""
    assert llm.format_reference() == ""
    # ...and the guardrail is still written down for whoever does add it, or a
    # planner handed the vendor's format starts writing in it (invariant #6).
    monkeypatch.setattr(llm, "_KNOWLEDGE_DIR", str(tmp_path))
    (tmp_path / "h3_official_base_modes.md").write_text("## the envelope\n")
    ref = llm.format_reference()
    assert "vendor guide" in ref and "the envelope" in ref
    assert "Do NOT write in this format" in ref
    assert "deterministic compiler" in ref


def test_the_planner_wires_all_three_in():
    src = inspect.getsource(llm.plan_storyboard)
    assert "builtin_knowledge(" in src
    assert "format_reference()" in src
    assert "the_room(experts)" in src
    assert 'brief.get("experts")' in src


def test_a_comedy_brief_grounds_the_writer_in_comedy_craft():
    """The genre docs are earned by the BRIEF, not by a checkbox.

    The writer decides whether an episode has a cold open, an escalating small
    want and a tag, and it gets one pass at that — so a sitcom brief cannot be
    left waiting for someone to have ticked an expert box in the wizard."""
    src = inspect.getsource(llm.plan_storyboard)
    assert "genre_docs=" in src and "comedy_craft.md" in src
    assert llm._read_knowledge("comedy_craft.md"), "comedy_craft.md must ship"
    got = llm.builtin_knowledge("film", [], genre_docs=["comedy_craft.md"])
    assert "COLD OPEN" in got and "button" in got
    # and it stays out of a non-comedy plan
    assert "COLD OPEN" not in llm.builtin_knowledge("film", [])


def test_the_treatment_asks_the_right_first_question_per_medium():
    """A film brief came back with a "SONG MAP" of verses and choruses: the
    hint was written for music videos and handed to every medium."""
    mv = llm.treatment_hint("music_video")
    film = llm.treatment_hint("film")
    series = llm.treatment_hint("series")
    assert "SONG MAP" in mv and "chorus" in mv
    assert "SONG MAP" not in film and "SHAPE" in film
    assert "cold open" in series and "next episode" in series
    # Everything after section 1 is the same discipline for all of them.
    for shared in ("STORY SPINE", "CONTINUITY CHAIN", "WORLDS & VFX", "CHOREOGRAPHY"):
        assert shared in mv and shared in film and shared in series
    assert llm.treatment_hint(None) == film, "an unknown medium falls back to film"

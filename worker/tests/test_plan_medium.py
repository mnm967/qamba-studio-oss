"""The wizard can direct a one-off film inside a music-video project.

That choice only means anything if it reaches the planner: the craft guides it
loads and the medium it tells the model about both used to come from the
project row, so a film brief was planned with music-video instincts.
"""
import pytest

import llm


@pytest.mark.parametrize("brief,project,expected", [
    ({"medium": "film"}, {"medium": "music_video"}, "film"),   # the wizard's choice wins
    ({}, {"medium": "music_video"}, "music_video"),            # no choice: the project stands
    ({"medium": ""}, {"medium": "series"}, "series"),          # blank is not a choice
    ({"medium": None}, {"medium": "film"}, "film"),
    ({}, {}, None),
])
def test_the_brief_medium_wins_over_the_project_row(brief, project, expected):
    assert llm.plan_medium(brief, project) == expected


def test_medium_selects_the_craft_guides():
    """A music video gets its own guide on top of the general craft; a film
    must not, or the planner starts cutting to a beat that isn't there."""
    mv = llm.builtin_knowledge("music_video")
    film = llm.builtin_knowledge("film")
    assert film, "the general craft guides should load for any medium"
    assert mv.startswith(film), "a music video is the same craft plus its own guide"
    assert len(mv) > len(film)

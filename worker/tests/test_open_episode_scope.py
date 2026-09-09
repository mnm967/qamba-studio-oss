"""THE TOOLS READ THE OPEN EPISODE'S STORYBOARD, and nothing else.

Every storyboard read used to resolve project-wide — the newest board anywhere
under the project — so a series answered about whichever episode was re-planned
most recently and switching episodes changed nothing at all. The situational
context block (src/lib/directorContext.ts) was episode-scoped the whole time,
so the two halves of one turn disagreed.

MEASURED on Rei, 2026-08-30: EP03 open with S7 CITY_CAPTURE_2 on screen,
`list_storyboard` returned EP01's three scenes (THE_SHUTTER / WALK_AWAY /
THE_ESCALATORS) — because EP01 v1 was written on 08-22 and EP03 v6 on 08-18.
Nothing errored; the director reported that the scene the user was pointing at
does not exist, and offered to re-plan.

Every case here is silent when wrong, which is why they are pinned. Twin of the
same tests in api/director/chat.test.mjs.
"""
import pytest

import director_tools as dt

EP3 = "ep3"
EP1 = "ep1"


@pytest.fixture
def db(monkeypatch):
    """Two episodes: EP03 (open, older board) and EP01 (newer board).

    `paths` is the whole point — the assertions are about WHICH rows were read,
    since serving the wrong board returns perfectly well-formed data.
    """
    paths = []

    def fake_get(path):
        paths.append(path)
        if path.startswith(f"storyboards?episode_id=eq.{EP3}"):
            return [{"id": "sb-ep3"}]
        if path.startswith(f"storyboards?episode_id=eq.{EP1}"):
            return [{"id": "sb-ep1"}]
        if path.startswith("episodes?"):
            # newest first, which is how the project-wide fallback walks them
            return [{"id": EP1}, {"id": EP3}]
        if path.startswith("generation_blocks?storyboard_id=eq.sb-ep3"):
            return [{"id": "blk-ep3", "idx": 0, "status": "generated"}]
        if path.startswith("generation_blocks?storyboard_id=eq.sb-ep1"):
            return [{"id": "blk-ep1", "idx": 0, "status": "generated"}]
        if path.startswith("scenes?storyboard_id=eq.sb-ep3"):
            return [{"id": "sc-ep3", "storyboard_id": "sb-ep3", "idx": 0,
                     "slug": "CITY_CAPTURE_2"}]
        if path.startswith("scenes?storyboard_id=eq.sb-ep1"):
            return [{"id": "sc-ep1", "storyboard_id": "sb-ep1", "idx": 0,
                     "slug": "THE_SHUTTER"}]
        return []

    monkeypatch.setattr(dt.sb, "get", fake_get)
    return paths


def test_a_block_label_resolves_against_the_open_episode(db):
    block, err = dt._resolve_block("b1", "p1", eid=EP3)
    assert err is None
    assert block["id"] == "blk-ep3"
    assert not any("episode_id=in." in p for p in db), \
        "a project-wide search answers about whichever episode was re-planned last"


def test_a_scene_label_resolves_against_the_open_episode(db):
    scene, err = dt._resolve_scene("S1", "p1", eid=EP3)
    assert err is None
    assert scene["slug"] == "CITY_CAPTURE_2"


def test_an_episode_with_no_board_refuses_rather_than_serving_a_siblings(db):
    # THE REFUSAL IS THE FIX. Falling through to another episode's storyboard
    # is how a director edits a film nobody has open.
    block, err = dt._resolve_block("b1", "p1", eid="ep-empty")
    assert block is None
    assert "this episode has no storyboard yet" in err["error"]
    assert not any(p.startswith("generation_blocks?storyboard_id=eq.sb-ep1") for p in db)


def test_with_no_episode_open_at_all_it_still_falls_back_project_wide(db):
    # The only case the project-wide search was ever written for.
    block, err = dt._resolve_block("b1", "p1", eid=None)
    assert err is None
    assert block["id"] == "blk-ep1"


def test_the_board_of_one_episode_is_ordered_the_way_the_browser_orders_it(db):
    # db/director.storyboardsForEpisode sorts `version desc, created_at desc`
    # and every screen reads [0]; anything else answers about a board nobody is
    # looking at.
    dt._episode_storyboard_id(EP3)
    q = next(p for p in db if p.startswith(f"storyboards?episode_id=eq.{EP3}"))
    assert "order=version.desc,created_at.desc" in q
    assert "limit=1" in q

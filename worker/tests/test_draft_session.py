"""A wizard run's inventions are a DRAFT until the episode is queued.

A `bible_entries` row is shared by every episode of the series — AFTERLIGHT is
three episodes over 22 entries — so a plan that came back wrong used to leave
its phantom cast in the bible permanently, with nothing to tell its rows apart
from canon. Measured on a real run: one wizard pass added six characters, seven
locations and seven props, of which two locations and two props were the same
thing written down twice and one character had been merged away.

Both halves are silent if they break: an unstamped draft is indistinguishable
from canon (so a discard misses it, and it is offered in every picker forever),
and a committed row that KEEPS its stamp is canon a later discard would delete.
"""
import llm


class FakeSb:
    """Enough PostgREST to record the query and the writes."""

    def __init__(self, rows=None):
        self.rows, self.gets, self.patches = rows or [], [], []

    def get(self, path):
        self.gets.append(path)
        return [dict(r) for r in self.rows]

    def patch(self, path, body, want_rows=False):
        self.patches.append((path, body))
        return []


ROWS = [{"id": "e1", "doc": {"voice": "warm", "draft_session": "thread-1"}},
        {"id": "e2", "doc": {"draft_session": "thread-1"}}]


def test_committing_flips_the_status_and_drops_the_stamp(monkeypatch):
    f = FakeSb(ROWS)
    monkeypatch.setattr(llm, "sb", f)
    assert llm.confirm_draft_entries("p1", "thread-1") == 2
    for _path, body in f.patches:
        assert body["status"] == "confirmed"
        assert "draft_session" not in body["doc"]
    # the rest of the doc survives — this is a promotion, not a reset
    assert f.patches[0][1]["doc"]["voice"] == "warm"


def test_it_selects_by_the_stamp_so_outfit_variants_are_covered(monkeypatch):
    """Variants are their own character entries but live in `variant_rows`,
    not `new_entries`. A list-driven commit left every one of them permanently
    draft-and-stamped — invisible in the bible, and deletable by a discard of a
    session whose episode had already been queued."""
    f = FakeSb(ROWS)
    monkeypatch.setattr(llm, "sb", f)
    llm.confirm_draft_entries("p1", "thread-1")
    assert any("doc->>draft_session=eq.thread-1" in g and "project_id=eq.p1" in g
               for g in f.gets), f.gets


def test_no_session_touches_nothing(monkeypatch):
    """A plan queued without a wizard thread invents nothing reversible, and
    must not sweep up every draft in the project."""
    f = FakeSb(ROWS)
    monkeypatch.setattr(llm, "sb", f)
    assert llm.confirm_draft_entries("p1", "") == 0
    assert llm.confirm_draft_entries("p1", None) == 0
    assert f.gets == [] and f.patches == []


# --------------------------------------------------------------- the plan ---
# Read off the source: running plan_storyboard needs a database and an LLM, and
# what has to hold is a property of the code — every entry it INVENTS is a
# stamped draft, and only the auto-launch path commits.
import pathlib                                                    # noqa: E402

SRC = (pathlib.Path(__file__).resolve().parents[1] / "llm.py").read_text()


def test_every_invented_entry_is_written_as_a_stamped_draft():
    body = SRC.split("# ---- bible entries")[1].split("# ---- the user's own")[0]
    assert '"status": "draft"' in body
    assert 'doc["draft_session"] = session' in body
    # the old two-tier rule is gone: tier 1 no longer writes canon at plan time
    assert "ent_status" not in SRC


def test_the_outfit_variants_are_stamped_too():
    """A variant is its own character entry, so an unstamped one would survive
    a discard as an orphan pointing at a parent that no longer exists."""
    body = SRC.split("variant_by_scene = {}")[1].split("story = sb.insert")[0]
    assert '"draft_session": session' in body
    assert '"status": "draft"' in body


def test_only_the_auto_launch_path_commits():
    """One rule for both tiers: entries become canon when the EPISODE is
    queued. Tier 1 queues its own render, so it commits; tier 2 stops and the
    wizard's Queue episode does it."""
    launch = SRC.split('if payload.get("auto_launch") or tier == 1:')[1].split("else:")[0]
    assert "confirm_draft_entries(project[\"id\"], session)" in launch
    # ...and nowhere else in the planner
    assert SRC.count("confirm_draft_entries(") == 2      # the def, and this call


def test_a_returning_entry_is_never_restatused():
    """A character from a previous episode is canon this plan merely
    referenced. Stamping it would make an unrelated discard delete it."""
    body = SRC.split("# ---- bible entries")[1].split("# ---- the user's own")[0]
    hit = body.split('hit = _find_entry(bible, kind, c["name"], identity=c.get("identity_line"))')[1].split("doc = {")[0]
    assert "continue" in hit
    assert "draft_session" not in hit
    assert "status" not in hit


# ------------------------------------------------- what does NOT commit ---
IMAGES = (pathlib.Path(__file__).resolve().parents[1] / "handlers" / "images.py").read_text()


def test_a_rendered_sheet_does_not_confirm_its_entry():
    """"A picture rendered" is not "a human approved this".

    The sheets are queued by the same plan that drafts the entries, so a tier-2
    run — whose whole point is to be reviewed first — confirmed itself minutes
    later on its own output. Measured on a real run: `auto_launch: false`, and
    all 17 invented entries came back `confirmed`, two of them duplicate
    locations and one a protagonist that had been merged away.
    """
    block = (IMAGES.split('if payload.get("auto_accept") and target.get("bible_entry_id"):')[1]
                   .split('target.get("scene_id")')[0])
    assert '"status": "confirmed"' not in block
    # the sheet itself still attaches — only the promotion is gone
    assert 'sb.upsert("bible_assets"' in block

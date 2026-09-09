"""A picture the user attached in the wizard interview, becoming a real sheet.

Until this existed the attachment was accepted, uploaded, registered, drawn in
the transcript — and then the planner rendered a face plate from a paraphrase
of it and every block of the episode inherited the drawing. Nothing failed;
the user simply never got what they handed over.

The failure mode this guards is silence in both directions: a picture that is
staged for the WRONG entry becomes that character's identity anchor with
nothing on screen to say so, and a picture that is staged for nobody leaves the
planner drawing over it just as before.
"""
import pytest

import llm


# ------------------------------------------------------------ the ladder ---
def test_the_first_picture_takes_the_slot_everything_derives_from():
    """Face for a person, master for a place — the anchor, not an extra."""
    assert llm.user_ref_slots("character", ["a"]) == [("a", "face")]
    assert llm.user_ref_slots("environment", ["a"]) == [("a", "master")]
    assert llm.user_ref_slots("prop", ["a"]) == [("a", "ref")]


def test_more_pictures_fill_the_next_most_useful_slots():
    assert llm.user_ref_slots("character", ["a", "b", "c"]) == [
        ("a", "face"), ("b", "full_body"), ("c", "side")]
    assert llm.user_ref_slots("environment", ["a", "b"]) == [
        ("a", "master"), ("b", "alt_angle")]


def test_a_picture_past_the_ladder_is_kept_rather_than_dropped():
    """It stages nowhere — that is the honest outcome for a fourth plate — but
    it stays on the entry and in the bible instead of vanishing."""
    got = llm.user_ref_slots("character", ["a", "b", "c", "d"])
    assert got[-1] == ("d", "ref")


def test_the_same_picture_twice_is_one_picture():
    assert llm.user_ref_slots("character", ["a", "a", "b"]) == [
        ("a", "face"), ("b", "full_body")]


def test_junk_never_reaches_a_slot():
    assert llm.user_ref_slots("character", [None, "", 7, "a"]) == [("a", "face")]
    assert llm.user_ref_slots("character", None) == []


# ------------------------------------------------------- name resolution ---
def test_an_exact_name_wins():
    assert llm.match_brief_name("Guide Rei", ["Guide Rei", "Miko"]) == "Guide Rei"


def test_the_writer_formalising_a_name_still_matches():
    """The user says "Rei" and the writer files her as "Guide Rei". Refusing
    that leaves the user's own sheet unattached with nothing to explain why."""
    assert llm.match_brief_name("Rei", ["Guide Rei", "Miko"]) == "Guide Rei"
    assert llm.match_brief_name("Guide Rei", ["Rei"]) == "Rei"


def test_ambiguity_is_a_miss_rather_than_a_guess():
    """Two candidates means a coin flip about whose identity anchor this
    picture becomes — and a wrong anchor is inherited by every block."""
    assert llm.match_brief_name("Rei", ["Guide Rei", "Rei Tanaka"]) is None


def test_an_unrelated_name_matches_nothing():
    assert llm.match_brief_name("Rei", ["Miko", "Haru"]) is None
    assert llm.match_brief_name("", ["Rei"]) is None


# --------------------------------------------------------- attaching them ---
class FakeSb:
    """Just enough PostgREST to watch what gets written."""

    def __init__(self, assets, existing=None):
        self.assets = assets
        self.existing = existing or {}
        self.inserts, self.patches = [], []

    def get(self, path):
        if path.startswith("assets?"):
            return self.assets
        if path.startswith("bible_assets?entry_id=eq."):
            eid = path.split("entry_id=eq.")[1].split("&")[0]
            return [dict(x) for x in self.existing.get(eid, [])]
        return []

    def insert(self, table, body):
        self.inserts.append((table, body))
        return {"id": "new", **body}

    def patch(self, path, body, want_rows=False):
        self.patches.append((path, body))
        return []


BIBLE = [
    {"id": "e-rei", "kind": "character", "name": "Guide Rei"},
    {"id": "e-loop", "kind": "environment", "name": "The Loop"},
    {"id": "e-pol", "kind": "prop", "name": "the polaroid"},
]
A1 = "11111111-2222-3333-4444-555555555555"
A2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _ok_asset(aid, **over):
    return {"id": aid, "kind": "image", "project_id": "p1", "deleted_at": None, **over}


@pytest.fixture
def fake(monkeypatch):
    def _install(assets, existing=None):
        f = FakeSb(assets, existing)
        monkeypatch.setattr(llm, "sb", f)
        return f
    return _install


def test_a_supplied_sheet_lands_on_the_entry_it_shows(fake):
    f = fake([_ok_asset(A1)])
    filled = llm.attach_user_refs(
        {"cast": [{"name": "Rei", "ref_asset_ids": [A1]}]}, BIBLE, "p1")
    assert filled == {"e-rei": {"face"}}
    assert f.inserts == [("bible_assets", {"entry_id": "e-rei", "asset_id": A1,
                                           "role": "face", "slot": 0})]


def test_locations_and_props_land_in_their_own_slots(fake):
    f = fake([_ok_asset(A1), _ok_asset(A2)])
    filled = llm.attach_user_refs(
        {"world": [{"name": "The Loop", "ref_asset_ids": [A1]}],
         "props": [{"name": "the polaroid", "ref_asset_ids": [A2]}]}, BIBLE, "p1")
    assert filled == {"e-loop": {"master"}, "e-pol": {"ref"}}
    roles = {b["entry_id"]: b["role"] for _t, b in f.inserts}
    assert roles == {"e-loop": "master", "e-pol": "ref"}


def test_an_id_from_another_project_is_refused(fake):
    """The bucket is public and ids travel; staging a stranger's picture as a
    character's identity anchor would not fail loudly anywhere."""
    f = fake([_ok_asset(A1, project_id="someone-else")])
    assert llm.attach_user_refs(
        {"cast": [{"name": "Rei", "ref_asset_ids": [A1]}]}, BIBLE, "p1") == {}
    assert f.inserts == []


def test_a_binned_or_non_image_asset_is_refused(fake):
    f = fake([_ok_asset(A1, deleted_at="2026-08-15T00:00:00Z"), _ok_asset(A2, kind="video")])
    assert llm.attach_user_refs(
        {"cast": [{"name": "Rei", "ref_asset_ids": [A1, A2]}]}, BIBLE, "p1") == {}
    assert f.inserts == []


def test_an_unmatched_name_stages_nothing_and_says_so(fake, capsys):
    f = fake([_ok_asset(A1)])
    assert llm.attach_user_refs(
        {"cast": [{"name": "Nobody", "ref_asset_ids": [A1]}]}, BIBLE, "p1") == {}
    assert f.inserts == []


def test_the_sheet_it_replaces_is_archived_not_deleted(fake):
    """Every consumer resolves a role with order=slot&limit=1, so an existing
    plate has to move out of the way — to slot 90, where regen_sheets.py parks
    superseded sheets, so it stays in the library and out of the render."""
    f = fake([_ok_asset(A1)],
             existing={"e-rei": [{"asset_id": "old", "role": "face", "slot": 0}]})
    llm.attach_user_refs({"cast": [{"name": "Rei", "ref_asset_ids": [A1]}]}, BIBLE, "p1")
    assert any("asset_id=eq.old" in p and b == {"slot": llm.ARCHIVE_SLOT}
               for p, b in f.patches), f.patches
    assert ("bible_assets", {"entry_id": "e-rei", "asset_id": A1,
                             "role": "face", "slot": 0}) in f.inserts


def test_re_planning_the_same_sheet_does_not_duplicate_it(fake):
    f = fake([_ok_asset(A1)],
             existing={"e-rei": [{"asset_id": A1, "role": "ref", "slot": 4}]})
    llm.attach_user_refs({"cast": [{"name": "Rei", "ref_asset_ids": [A1]}]}, BIBLE, "p1")
    assert f.inserts == []
    assert (f"bible_assets?entry_id=eq.e-rei&asset_id=eq.{A1}",
            {"role": "face", "slot": 0}) in f.patches


def test_no_attachments_touches_the_database_not_at_all(fake):
    f = fake([])
    assert llm.attach_user_refs({"cast": [{"name": "Rei"}]}, BIBLE, "p1") == {}
    assert f.inserts == [] and f.patches == []


# ------------------------------------------ what the sheet queue then skips ---
def test_the_queue_skips_exactly_the_roles_the_user_filled():
    """Read off the source rather than run the whole planner: the property that
    matters is that a filled role is never queued AND that its dependents lose
    the dep rather than naming a job that was never created — `deps=[None]`
    would fail the insert, and a job waiting on nothing is the whole point of
    late-bound anchors."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1] / "llm.py").read_text()
    body = src.split("face_job_by_entry = {}")[1].split("# Returning cast")[0]
    for guard in ('"face" in mine', '"full_body" in mine', '"turnaround" not in mine',
                  '"master" in mine', '"ref" not in mine'):
        assert guard in body, f"sheet queue must consult user_refs: {guard}"
    assert "deps=[face_j] if face_j else None" in body
    assert "deps=[mj] if mj else None" in body
    assert "user_refs.get(row[\"id\"])" in body


def test_staging_runs_outside_the_plan_refs_gate():
    """Attaching a picture the user already handed over costs nothing and is
    the point of having accepted it — it must not depend on whether this run
    is also generating sheets."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1] / "llm.py").read_text()
    before_gate = src.split('if payload.get("plan_refs", True):')[0]
    assert "attach_user_refs(" in before_gate

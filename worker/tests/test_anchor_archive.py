"""`_resolve_anchor` must never stage a sheet that was ARCHIVED.

`slot >= 90` is where a superseded sheet is parked rather than deleted
(regen_sheets.py's convention, which `llm.attach_user_refs` and the orbit
handler both follow). Every consumer resolves a role with
`order=slot&limit=1`, so the replacement wins the moment it lands — but that
ordering alone is NOT enough: a role whose ONLY rows are archived still
returns one.

Measured on CLOSING TIME EP01. A character's face plate came back deformed
from `h3-image-turbo`, so it and every sheet derived from it were archived and
her face plate re-rolled. `ref_plan_for` (blocks.py) filters, so her blocks
correctly fell back to the good full_body — and `_resolve_anchor` did not, so
every panel and every derived sheet went on anchoring the deformed turnaround
because it was the sole row of its role. Nothing errored; the deformation
simply propagated back into the bible from the pictures that had been
withdrawn.
"""
import handlers.images as I


def _stub(monkeypatch, assets, entries=()):
    """Answer the three `bible_assets` shapes `_resolve_anchor` asks for."""
    seen = []

    def get(path):
        seen.append(path)
        if path.startswith("bible_entries?id=eq."):
            eid = path.split("id=eq.")[1].split("&")[0]
            return [e for e in entries if e["id"] == eid]
        if path.startswith("bible_assets?entry_id=eq."):
            eid = path.split("entry_id=eq.")[1].split("&")[0]
            rows = [a for a in assets if a["entry_id"] == eid]
            if "slot=lt.90" in path:
                rows = [a for a in rows if a["slot"] < 90]
            if "role=eq." in path:
                role = path.split("role=eq.")[1].split("&")[0]
                rows = [a for a in rows if a["role"] == role]
            rows.sort(key=lambda a: a["slot"])
            if "limit=1" in path:
                rows = rows[:1]
            return rows
        raise AssertionError(f"unstubbed query: {path}")

    monkeypatch.setattr(I.sb, "get", get)
    return seen


def _a(entry_id, role, slot=0, aid=None):
    return {"entry_id": entry_id, "role": role, "slot": slot,
            "asset_id": aid or f"{entry_id}-{role}-{slot}"}


def test_an_archived_sheet_is_not_staged_when_it_is_the_last_of_its_role(monkeypatch):
    """The bug exactly: the role has one row and it is archived."""
    _stub(monkeypatch, [_a("mo", "turnaround", 90, "deformed")])
    assert I._resolve_anchor({"anchor_entry_id": "mo",
                              "anchor_roles": ["turnaround"]}) == []


def test_the_preference_order_falls_THROUGH_an_archived_role(monkeypatch):
    """A panel asks turnaround > full_body > face and takes the first that
    resolves. An archived turnaround must not satisfy that — it has to fall to
    the live full_body, which is what the block plan does."""
    _stub(monkeypatch, [_a("mo", "turnaround", 90, "deformed"),
                        _a("mo", "full_body", 0, "good")])
    got = I._resolve_anchor({"anchors": [{"entry_id": "mo", "first": True,
                                          "roles": ["turnaround", "full_body",
                                                    "face"]}]})
    assert got == ["good"]


def test_the_any_ref_fallback_excludes_the_archive_too(monkeypatch):
    """The second query is 'no listed role resolved, take anything'. Left
    unfiltered it reaches straight back into the archive and undoes the first
    filter — which is the same bug one line down."""
    _stub(monkeypatch, [_a("mo", "side", 90, "deformed")])
    assert I._resolve_anchor({"anchor_entry_id": "mo",
                              "anchor_roles": ["face"]}) == []


def test_the_variant_walk_excludes_the_archive_too(monkeypatch):
    """A variant with no sheet is anchored on its PARENT. If that walk reads
    the archive, a withdrawn plate reaches every variant of the character as
    well as the character."""
    _stub(monkeypatch,
          [_a("mo", "turnaround", 90, "deformed"), _a("mo", "face", 0, "good")],
          entries=[{"id": "mo-coat", "doc": {"variant_of": "mo"}}])
    got = I._resolve_anchor({"anchor_entry_id": "mo-coat",
                             "anchor_roles": ["full_body"]})
    assert got == ["good"], "the parent walk must skip the archived turnaround"


def test_a_live_sheet_still_resolves_and_still_reports_its_role(monkeypatch):
    """The filter must not cost the normal path. `taken` is what
    `handle_image_gen` uses to correct `spec['plate']`, so an anchor that
    resolves has to keep saying WHICH role answered."""
    _stub(monkeypatch, [_a("obs", "master", 0), _a("obs", "alt_angle", 0),
                        _a("obs", "detail", 90)])
    taken = []
    got = I._resolve_anchor({"anchors": [{"entry_id": "obs", "first": True,
                                          "roles": ["detail", "master"]}]},
                            taken=taken)
    assert got == ["obs-master-0"]
    assert taken == [{"entry_id": "obs", "role": "master"}]


def test_every_bible_assets_query_in_the_function_carries_the_filter(monkeypatch):
    """A fourth lookup added later without it reintroduces the bug in a place
    the cases above do not reach."""
    seen = _stub(monkeypatch, [], entries=[{"id": "v", "doc": {"variant_of": "p"}}])
    I._resolve_anchor({"anchor_entry_id": "v", "anchor_roles": ["face"]})
    asset_qs = [p for p in seen if p.startswith("bible_assets?")]
    assert asset_qs, "the function asked for no sheets at all"
    for q in asset_qs:
        assert f"slot=lt.{I.ARCHIVE_SLOT}" in q, q

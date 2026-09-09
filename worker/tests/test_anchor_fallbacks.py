"""Resolution honesty — the two failures Rei E4 rendered before these existed.

A panel anchored on a variant whose sheets had not landed staged NOTHING for
that character; a panel anchored on a DELETED entry (a discarded draft a
queued job still referenced) did the same — and in both cases the H3 envelope
went on defining subjects over pictures that never arrived, so `<Picture N>`
numbering slid and "Guide Rei must match <Picture 2>" bound her to the
location plate. She rendered as a clone of Rei.
"""
import handlers.images as images


def _tables(assets, entries):
    """Fake sb.get over bible_assets / bible_entries query strings."""
    def get(path):
        if path.startswith("bible_assets?"):
            eid = path.split("entry_id=eq.")[1].split("&")[0]
            role = (path.split("role=eq.")[1].split("&")[0]
                    if "role=eq." in path else None)
            rows = [dict(a) for a in assets
                    if a["entry_id"] == eid and (role is None or a["role"] == role)]
            rows.sort(key=lambda r: r.get("slot", 0))
            return rows[:1]
        if path.startswith("bible_entries?"):
            eid = path.split("id=eq.")[1].split("&")[0]
            return [dict(e) for e in entries if e["id"] == eid]
        return []
    return get


def test_a_sheetless_variant_stages_its_parent(monkeypatch):
    monkeypatch.setattr(images.sb, "get", _tables(
        assets=[{"entry_id": "parent", "role": "turnaround", "slot": 0,
                 "asset_id": "a-turn"}],
        entries=[{"id": "variant", "doc": {"variant_of": "parent"}}]))
    taken = []
    out = images._resolve_anchor(
        {"anchors": [{"entry_id": "variant",
                      "roles": ["full_body", "outfit", "turnaround", "face"],
                      "first": True}]}, taken)
    assert out == ["a-turn"]
    # the anchor still reports the VARIANT's entry — the caller's prune keys
    # on the planned entry id, and the parent was staged on its behalf
    assert taken == [{"entry_id": "variant", "role": "turnaround"}]


def test_a_dangling_entry_resolves_to_nothing_not_an_error(monkeypatch):
    monkeypatch.setattr(images.sb, "get", _tables(assets=[], entries=[]))
    taken = []
    out = images._resolve_anchor(
        {"anchors": [{"entry_id": "gone", "roles": ["face"], "first": True}]},
        taken)
    assert out == [] and taken == []


def test_a_variant_with_its_own_sheet_never_reaches_the_parent(monkeypatch):
    calls = []
    real = _tables(
        assets=[{"entry_id": "variant", "role": "full_body", "slot": 0,
                 "asset_id": "a-body"},
                {"entry_id": "parent", "role": "turnaround", "slot": 0,
                 "asset_id": "a-turn"}],
        entries=[{"id": "variant", "doc": {"variant_of": "parent"}}])

    def spy(path):
        calls.append(path)
        return real(path)
    monkeypatch.setattr(images.sb, "get", spy)
    out = images._resolve_anchor(
        {"anchors": [{"entry_id": "variant",
                      "roles": ["full_body", "outfit", "turnaround", "face"],
                      "first": True}]}, [])
    assert out == ["a-body"]
    assert not any("bible_entries" in c for c in calls), "parent walk not needed"

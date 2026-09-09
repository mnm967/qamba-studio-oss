"""`ref_plan_for` as a reachable function, and what a re-render restages.

It lived as a closure inside `handle_launch_render` for its whole life, which
meant a re-rendered block staged the sheets the EPISODE was planned with. An
outfit variant cast afterwards, a recast voice, a redrawn location — every text
surface showed the change and the picture never did. These pin the behaviour
that made it worth extracting, and the slot budget it has to keep.
"""
import handlers.blocks as B


def _stub_sb(monkeypatch, tables):
    """Answer PostgREST-ish paths out of a dict of fixture rows."""
    def get(path):
        if path.startswith("bible_entries?project_id="):
            if "kind=eq.prop" in path:
                return [e for e in tables["entries"] if e.get("kind") == "prop"]
            return tables["entries"]
        if path.startswith("bible_entries?id=in."):
            ids = path.split("id=in.(")[1].split(")")[0].split(",")
            return [e for e in tables["entries"] if e["id"] in ids]
        if path.startswith("bible_entries?id=eq."):
            eid = path.split("id=eq.")[1].split("&")[0]
            return [e for e in tables["entries"] if e["id"] == eid]
        if path.startswith("bible_assets?entry_id=eq."):
            eid = path.split("entry_id=eq.")[1].split("&")[0]
            rows = [a for a in tables["assets"] if a["entry_id"] == eid]
            if "slot=lt.90" in path:
                rows = [a for a in rows if a["slot"] < 90]
            # GENERIC on the role. It filtered a hard-coded `master` and
            # `face`, so a query for any OTHER role came back UNFILTERED and
            # `limit=1` then handed it the entry's first plate — i.e. the stub
            # answered "yes, it has one" for every role, of every entry, which
            # is the one answer that makes a preference-order test vacuous.
            if "role=eq." in path:
                want = path.split("role=eq.")[1].split("&")[0]
                rows = [a for a in rows if a["role"] == want]
            rows.sort(key=lambda a: a["slot"])
            if "limit=1" in path:
                rows = rows[:1]
            return rows
        raise AssertionError(f"unstubbed query: {path}")
    monkeypatch.setattr(B.sb, "get", get)


def _asset(entry_id, role, slot=0):
    return {"entry_id": entry_id, "role": role, "slot": slot,
            "asset_id": f"{entry_id}-{role}-{slot}"}


def _fixture(monkeypatch, *, cast_ids, entries, assets, beats):
    _stub_sb(monkeypatch, {"entries": entries, "assets": assets})
    scenes = [{"id": "sc1", "idx": 0, "slug": "OBSERVATORY", "cast_ids": cast_ids,
               "environment_id": "env1", "meta": {}, "still_asset_id": None,
               "scene_prompt": "flooded dome"}]
    block = {"id": "b1", "idx": 0, "scene_ids": ["sc1"],
             "beat_ids": [b["id"] for b in beats]}
    ctx = B.ref_plan_ctx(scenes, beats, "proj1")
    return block, ctx


def _beat(bid, cast, dialogue=None, meta=None):
    m = {"cast": cast}
    m.update(meta or {})
    return {"id": bid, "scene_id": "sc1", "idx": 0, "action": "they meet",
            "dialogue": dialogue or [], "meta": m}


def test_variant_cast_by_the_scene_beats_the_beats_base_name(monkeypatch):
    """This is the whole point of the extraction. A beat names "Aki"; the
    scene casts "Aki — Red Raincoat". A re-render must stage the VARIANT's
    wardrobe, which is what a costume change asked for in the chat means."""
    entries = [
        {"id": "aki", "name": "Aki", "kind": "character", "doc": {}},
        {"id": "aki-v", "name": "Aki — Red Raincoat", "kind": "character",
         "doc": {"variant_of": "aki"}},
        {"id": "env1", "name": "Observatory", "kind": "environment", "doc": {}},
    ]
    assets = [_asset("aki", "face"), _asset("aki", "full_body"),
              _asset("aki-v", "full_body"), _asset("env1", "master")]
    block, ctx = _fixture(monkeypatch, cast_ids=["aki-v"], entries=entries,
                          assets=assets, beats=[_beat("bt1", ["Aki"])])
    plan = B.ref_plan_for(block, ctx)
    ids = [e["asset_id"] for e in plan]
    assert "aki-v-full_body-0" in ids, "the scene's variant must supply the body"
    assert "aki-full_body-0" not in ids, "the base entry's body must not ride along"
    # ONE picture, and it is the variant's own: the parent's face plate no
    # longer rides along. It used to, on the grounds that identity lives
    # there — but a variant then cost TWO slots, and an episode casting a
    # variant for nearly everyone spent eight on five people and evicted the
    # location plate and both panels (measured on Rei E4, 5 of 17 blocks).
    assert "aki-face-0" not in ids
    chars = [e for e in plan if e["purpose"] == "character"]
    assert len(chars) == 1, "one identity slot per character"
    # Labels drop the em-dash suffix — beats and the compiler address "Aki".
    assert all(e.get("label") in (None, "Aki") or e["purpose"] != "character"
               for e in plan)


def test_the_environment_ref_is_the_master_not_an_arbitrary_plate(monkeypatch):
    entries = [{"id": "env1", "name": "Observatory", "kind": "environment", "doc": {}}]
    assets = [_asset("env1", "detail"), _asset("env1", "master"),
              _asset("env1", "atmosphere")]
    block, ctx = _fixture(monkeypatch, cast_ids=[], entries=entries,
                          assets=assets, beats=[_beat("bt1", [])])
    env = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "environment"]
    assert env and env[0]["asset_id"] == "env1-master-0"


def test_a_location_stages_its_coverage_sheet_over_its_master(monkeypatch):
    """The environment's half of the one-picture rule.

    A block stages exactly ONE picture of the place, and `<Picture N>` is
    positional — so the choice is between a single frontal plate and a contact
    sheet carrying every placement at the same slot cost. The character side
    has preferred the TURNAROUND for that slot all along; the location kept
    getting the master, because until the coverage take's own sheet was
    registered there was nothing else to prefer.
    """
    entries = [{"id": "env1", "name": "Observatory", "kind": "environment", "doc": {}}]
    assets = [_asset("env1", "master"), _asset("env1", "coverage"),
              _asset("env1", "detail")]
    block, ctx = _fixture(monkeypatch, cast_ids=[], entries=entries,
                          assets=assets, beats=[_beat("bt1", [])])
    monkeypatch.setattr(B.sb, "asset_by_id", lambda aid: {
        "id": aid, "meta": {"views": 8, "columns": 4}})
    env = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "environment"]
    assert env and env[0]["asset_id"] == "env1-coverage-0"
    # The SHAPE travels with it, because the compiler describes the picture and
    # neither number is derivable from anything else in the slot — the same
    # rule `block_sheet`'s `panels` follows.
    assert env[0]["views"] == 8 and env[0]["columns"] == 4


def test_a_location_with_no_coverage_sheet_still_gets_its_master(monkeypatch):
    """Every location planned before the coverage take, and every one whose
    sheet has not landed yet. The preference must degrade to exactly the
    behaviour it replaces, or adding the slot re-breaks every existing bible."""
    entries = [{"id": "env1", "name": "Observatory", "kind": "environment", "doc": {}}]
    assets = [_asset("env1", "detail"), _asset("env1", "master")]
    block, ctx = _fixture(monkeypatch, cast_ids=[], entries=entries,
                          assets=assets, beats=[_beat("bt1", [])])
    env = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "environment"]
    assert env and env[0]["asset_id"] == "env1-master-0"
    assert "views" not in env[0]


def test_env_coverage_false_pins_the_master_back(monkeypatch):
    """The A/B switch. The grid arm is unmeasured on a real block, so the arm
    it replaces has to stay reachable without editing the bible."""
    entries = [{"id": "env1", "name": "Observatory", "kind": "environment", "doc": {}}]
    assets = [_asset("env1", "coverage"), _asset("env1", "master")]
    block, ctx = _fixture(monkeypatch, cast_ids=[], entries=entries,
                          assets=assets, beats=[_beat("bt1", [])])
    plan = B.ref_plan_for(block, ctx, params={"env_coverage": False})
    env = [e for e in plan if e["purpose"] == "environment"]
    assert env and env[0]["asset_id"] == "env1-master-0"


def test_archived_sheets_are_excluded(monkeypatch):
    """`slot >= 90` is regen_sheets.py's archive. A re-render that picked it up
    would stage an older, superseded plate — the exact bug the slot filter was
    added for, now reachable from a second caller."""
    entries = [{"id": "aki", "name": "Aki", "kind": "character", "doc": {}}]
    assets = [_asset("aki", "face", slot=0), _asset("aki", "face", slot=90)]
    block, ctx = _fixture(monkeypatch, cast_ids=["aki"], entries=entries,
                          assets=assets, beats=[_beat("bt1", ["Aki"])])
    ids = [e["asset_id"] for e in B.ref_plan_for(block, ctx)]
    assert "aki-face-0" in ids and "aki-face-90" not in ids


def test_a_turnaround_replaces_the_face_plus_body_pair(monkeypatch):
    """Six agreeing views at one slot's cost — the budget rule that keeps props
    and panels from being squeezed out of plan[:8]."""
    entries = [{"id": "aki", "name": "Aki", "kind": "character", "doc": {}}]
    assets = [_asset("aki", "face"), _asset("aki", "full_body"),
              _asset("aki", "turnaround")]
    block, ctx = _fixture(monkeypatch, cast_ids=["aki"], entries=entries,
                          assets=assets, beats=[_beat("bt1", ["Aki"])])
    chars = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "character"]
    assert [e["role"] for e in chars] == ["turnaround"]


def test_voice_refs_are_audio_and_only_for_actual_speakers(monkeypatch):
    """Voice entries ride PAST the plan[:8] picture cap — pictures and audios
    number independently (official §2.5) — and only for someone who speaks."""
    entries = [
        {"id": "aki", "name": "Aki", "kind": "character", "doc": {},
         "voice_ref_asset_id": "aki-voice"},
        {"id": "haru", "name": "Haru", "kind": "character", "doc": {},
         "voice_ref_asset_id": "haru-voice"},
    ]
    assets = [_asset("aki", "face"), _asset("haru", "face")]
    beats = [_beat("bt1", ["Aki", "Haru"],
                   dialogue=[{"speaker": "Aki", "line": "you came"}])]
    block, ctx = _fixture(monkeypatch, cast_ids=["aki", "haru"], entries=entries,
                          assets=assets, beats=beats)
    voices = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "voice"]
    assert [v["name"] for v in voices] == ["Aki"], "only the speaker gets a timbre ref"


def test_locked_audio_stages_no_voice_refs(monkeypatch):
    """Locked audio owns every audio slot."""
    entries = [{"id": "aki", "name": "Aki", "kind": "character", "doc": {},
                "voice_ref_asset_id": "aki-voice"}]
    assets = [_asset("aki", "face")]
    beats = [_beat("bt1", ["Aki"], dialogue=[{"speaker": "Aki", "line": "hi"}])]
    _stub_sb(monkeypatch, {"entries": entries, "assets": assets})
    scenes = [{"id": "sc1", "idx": 0, "slug": "S", "cast_ids": ["aki"],
               "environment_id": None, "meta": {}}]
    block = {"id": "b1", "idx": 0, "scene_ids": ["sc1"], "beat_ids": ["bt1"]}
    ctx = B.ref_plan_ctx(scenes, beats, "proj1", locked=True)
    assert not [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "voice"]


def test_a_start_frame_takes_slot_one_and_suppresses_that_shots_panel(monkeypatch):
    """Two pictures claiming one shot's composition is a contradiction."""
    entries = [{"id": "env1", "name": "Obs", "kind": "environment", "doc": {}}]
    assets = [_asset("env1", "master")]
    beats = [_beat("bt1", [], meta={"start_frame_asset_id": "opener",
                                    "panel_asset_id": "panel1"})]
    block, ctx = _fixture(monkeypatch, cast_ids=[], entries=entries,
                          assets=assets, beats=beats)
    plan = B.ref_plan_for(block, ctx)
    assert plan[0]["purpose"] == "start_frame" and plan[0]["asset_id"] == "opener"
    assert not [e for e in plan if e["asset_id"] == "panel1"]


def test_panels_are_capped_at_two_per_block(monkeypatch):
    entries = [{"id": "env1", "name": "Obs", "kind": "environment", "doc": {}}]
    assets = [_asset("env1", "master")]
    beats = [_beat(f"bt{i}", [], meta={"panel_asset_id": f"panel{i}"})
             for i in range(4)]
    block, ctx = _fixture(monkeypatch, cast_ids=[], entries=entries,
                          assets=assets, beats=beats)
    panels = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "scene_ref"]
    assert len(panels) == 2


def test_pictures_cap_at_eight_and_voices_ride_past_it(monkeypatch):
    """budget_refs + voice_plan — the cap leaves slot 1 for the chain anchor.

    Ten characters, because identity is ONE picture each now: reaching the
    picture cap takes a genuine crowd rather than five people with two sheets
    apiece."""
    entries, assets, cast = [], [], []
    for i in range(10):
        cid = f"c{i}"
        cast.append(cid)
        entries.append({"id": cid, "name": f"C{i}", "kind": "character", "doc": {},
                        "voice_ref_asset_id": f"{cid}-voice"})
        assets += [_asset(cid, "face"), _asset(cid, "full_body")]
    beats = [_beat("bt1", [f"C{i}" for i in range(10)],
                   dialogue=[{"speaker": "C0", "line": "a"},
                             {"speaker": "C1", "line": "b"}])]
    # The shot has to NAME its crowd, because staging is pruned to who the
    # beats name before the budget is applied — a roster nobody mentions no
    # longer reaches the cap at all.
    beats[0]["action"] = " ".join(f"C{i} arrives." for i in range(10))
    block, ctx = _fixture(monkeypatch, cast_ids=cast, entries=entries,
                          assets=assets, beats=beats)
    plan = B.ref_plan_for(block, ctx)
    pics = [e for e in plan if e["purpose"] != "voice"]
    voices = [e for e in plan if e["purpose"] == "voice"]
    assert len(pics) == 8, "pictures capped at 8"
    assert len(voices) == 2, "two speakers keep their audio slots past the cap"


def test_ctx_reads_the_panel_optouts_off_a_render_payload(monkeypatch):
    """`panel_refs`, its old name `grid_refs`, and `scene_stills` mean the same
    thing on a re-render as on the launch that planned the block."""
    _stub_sb(monkeypatch, {"entries": [], "assets": []})
    assert B.ref_plan_ctx([], [], "p", payload={}).panel_refs is True
    assert B.ref_plan_ctx([], [], "p", payload={"grid_refs": False}).panel_refs is False
    assert B.ref_plan_ctx([], [], "p", payload={"panel_refs": False}).panel_refs is False
    assert B.ref_plan_ctx([], [], "p", payload={}).scene_stills is False
    assert B.ref_plan_ctx([], [], "p", payload={"scene_stills": True}).scene_stills is True


def test_one_identity_picture_per_character_even_without_a_turnaround(monkeypatch):
    """The rule is ONE slot per character, not "one when a turnaround exists".

    Outfit variants never get turnarounds, so the old rule left every variant
    costing two pictures (parent face + own body) — and an episode that casts
    a variant for nearly everyone spent the whole 8-picture budget on five
    people, evicting the location plate and both storyboard panels. Measured
    on Rei E4: 5 of 17 blocks would have rendered with no plate at all."""
    entries = [{"id": "aki", "name": "Aki", "kind": "character", "doc": {}},
               {"id": "haru", "name": "Haru", "kind": "character", "doc": {}}]
    assets = [_asset("aki", "face"), _asset("aki", "full_body"),
              _asset("haru", "face")]
    block, ctx = _fixture(monkeypatch, cast_ids=["aki", "haru"], entries=entries,
                          assets=assets, beats=[_beat("bt1", ["Aki", "Haru"])])
    chars = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "character"]
    assert len(chars) == 2, "one picture each, not face+body"
    # Preference order is the panel path's (`panelSpec.characterAnchor`):
    # wardrobe before a bare face, because a face plate is head-and-shoulders
    # on grey and says nothing about what the character is wearing — so Aki
    # takes her body sheet, and Haru his face, which is all he has.
    by_name = {e["name"]: e["role"] for e in chars}
    assert by_name == {"Aki": "full_body", "Haru": "face"}


def test_a_variant_with_no_sheet_of_its_own_follows_its_parent(monkeypatch):
    """The window between creating a variant and rendering its body is honest;
    staging nothing would un-anchor the character entirely. Same fallback
    `_resolve_anchor` gives panels."""
    entries = [{"id": "aki", "name": "Aki", "kind": "character", "doc": {}},
               {"id": "aki-v", "name": "Aki — Red Raincoat", "kind": "character",
                "doc": {"variant_of": "aki"}}]
    assets = [_asset("aki", "turnaround"), _asset("aki", "face")]
    block, ctx = _fixture(monkeypatch, cast_ids=["aki-v"], entries=entries,
                          assets=assets, beats=[_beat("bt1", ["Aki"])])
    chars = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "character"]
    assert [e["asset_id"] for e in chars] == ["aki-turnaround-0"]


def test_a_crowded_variant_cast_keeps_its_plate_and_panels(monkeypatch):
    """The Rei E4 shape end to end: five people all cast as outfit variants,
    a location, two panels. Before one-slot identity this staged 8 faces and
    nothing else."""
    entries, assets, cast_ids, names = [], [], [], []
    for i in range(5):
        base, var = f"p{i}", f"p{i}-v"
        entries += [{"id": base, "name": f"P{i}", "kind": "character", "doc": {}},
                    {"id": var, "name": f"P{i} — coat", "kind": "character",
                     "doc": {"variant_of": base}}]
        assets += [_asset(base, "face"), _asset(var, "full_body")]
        cast_ids.append(var)
        names.append(f"P{i}")
    entries.append({"id": "env1", "name": "Observatory", "kind": "environment",
                    "doc": {}})
    assets.append(_asset("env1", "master"))
    beats = [_beat("bt1", names, meta={"panel_asset_id": "pan1"}),
             _beat("bt2", names, meta={"panel_asset_id": "pan2"})]
    beats[1]["id"] = "bt2"
    block, ctx = _fixture(monkeypatch, cast_ids=cast_ids, entries=entries,
                          assets=assets, beats=beats)
    block["beat_ids"] = ["bt1", "bt2"]
    plan = B.ref_plan_for(block, ctx)
    assert len([e for e in plan if e["purpose"] == "character"]) == 5
    assert [e for e in plan if e["purpose"] == "environment"], "plate evicted again"
    assert len([e for e in plan if e["purpose"] == "scene_ref"]) == 2
    assert len([e for e in plan if e.get("purpose") != "voice"]) <= B.PICTURE_CAP


def test_a_block_stages_who_its_shots_name_not_the_whole_roster(monkeypatch):
    """`meta.cast` is the cinematographer's roster and its contract says "ONLY
    the characters visibly in frame" — ASTRONAUT_CAPTURE wrote all six names on
    every beat, so a two-beat block staged six identity sheets and H3 drew all
    six (the extras turned up standing behind an extreme close-up)."""
    entries = [{"id": f"c{i}", "name": f"C{i}", "kind": "character", "doc": {}}
               for i in range(4)]
    entries.append({"id": "env1", "name": "Observatory", "kind": "environment",
                    "doc": {}})
    assets = [_asset(f"c{i}", "turnaround") for i in range(4)]
    assets.append(_asset("env1", "master"))
    roster = ["C0", "C1", "C2", "C3"]
    b1 = _beat("bt1", roster)
    b1["action"] = "C1 reaches for the fracture."
    b2 = _beat("bt2", roster)
    b2["action"] = "C0 pulls her back."
    b2["id"] = "bt2"
    block, ctx = _fixture(monkeypatch, cast_ids=[f"c{i}" for i in range(4)],
                          entries=entries, assets=assets, beats=[b1, b2])
    block["beat_ids"] = ["bt1", "bt2"]
    chars = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "character"]
    # union of who the two beats NAME, in first-mention order — C2/C3 are in
    # the roster and in neither shot's text, so they stage nothing
    assert [e["name"] for e in chars] == ["C1", "C0"]


def test_a_beat_that_names_nobody_keeps_its_roster(monkeypatch):
    """The pronoun case: "the two stand in silence" names no one, and staging
    nobody there would un-anchor the shot — so that beat contributes its whole
    roster and the second party keeps its sheet."""
    entries = [{"id": "aki", "name": "Aki", "kind": "character", "doc": {}},
               {"id": "haru", "name": "Haru", "kind": "character", "doc": {}}]
    assets = [_asset("aki", "turnaround"), _asset("haru", "turnaround")]
    b = _beat("bt1", ["Aki", "Haru"])
    b["action"] = "The two of them stand in silence as it passes."
    block, ctx = _fixture(monkeypatch, cast_ids=["aki", "haru"], entries=entries,
                          assets=assets, beats=[b])
    chars = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "character"]
    assert {e["name"] for e in chars} == {"Aki", "Haru"}


def test_a_pronoun_second_party_survives_via_its_own_beat(monkeypatch):
    """One beat names only Aki; a later beat in the same block names nobody, so
    Haru — the party the first beat referred to as "her" — is still staged."""
    entries = [{"id": "aki", "name": "Aki", "kind": "character", "doc": {}},
               {"id": "haru", "name": "Haru", "kind": "character", "doc": {}}]
    assets = [_asset("aki", "turnaround"), _asset("haru", "turnaround")]
    b1 = _beat("bt1", ["Aki", "Haru"])
    b1["action"] = "Aki grips her and drags her backward."
    b2 = _beat("bt2", ["Aki", "Haru"])
    b2["action"] = "They both go still."
    b2["id"] = "bt2"
    block, ctx = _fixture(monkeypatch, cast_ids=["aki", "haru"], entries=entries,
                          assets=assets, beats=[b1, b2])
    block["beat_ids"] = ["bt1", "bt2"]
    chars = [e for e in B.ref_plan_for(block, ctx) if e["purpose"] == "character"]
    assert {e["name"] for e in chars} == {"Aki", "Haru"}

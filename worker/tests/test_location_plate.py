"""Which location plate a panel is actually HANDED, and what it is told it is.

The composition side (`location_plate`, `plate_plan`, the wording) lives in
test_image_prompt. This is the join between them: `roles` is a PREFERENCE order,
so a panel that asks a location for its reverse angle gets the master back when
the location has no reverse angle on file — and if the prompt still says
"reverse-angle plate", the model has been told about a picture nobody staged.
That is the failure `order_anchors` already warns about, arriving from a new
direction, and it is silent: the render is a perfectly good frame composed
against a description of a different photograph.
"""
import pytest

import handlers.images as images

MAP = {"image_models": {"krea2": {"family": "krea2", "unet": "k.safetensors",
                                  "steps": 8}}}

PANEL = {
    "kind": "panel", "style": "Anime (2D)",
    "camera": "a wide establishing shot at eye level",
    "action": "Rei walks the aisle.",
    "cast": [{"name": "Rei", "identity": "teal streak"}],
    "location": {"name": "Glass House", "identity": "humid emerald aisles"},
    "ref_subjects": [{"kind": "character", "name": "Rei", "identity": "teal streak"},
                     {"kind": "location", "name": "Glass House",
                      "identity": "humid emerald aisles"}],
    "refs": ["Rei's character sheet", "the Glass House location"],
}


def _rows(on_file):
    """A fake bible_assets table: {entry_id: {role: asset_id}}."""
    def get(path):
        if not path.startswith("bible_assets?"):
            return []
        eid = path.split("entry_id=eq.")[1].split("&")[0]
        have = on_file.get(eid) or {}
        if "role=eq." in path:
            role = path.split("role=eq.")[1].split("&")[0]
            return ([{"asset_id": have[role], "role": role}] if role in have else [])
        # the roleless fallback: lowest slot wins, and our dicts are ordered
        return [{"asset_id": a, "role": r} for r, a in list(have.items())[:1]]
    return get


def test_an_entry_with_no_sheets_claims_nothing(monkeypatch):
    """`taken` stays parallel to the ids: an anchor that resolves to nothing
    must not leave a role behind for the composer to describe."""
    monkeypatch.setattr(images.sb, "get", _rows({}))
    taken = []
    ids = images._resolve_anchor(
        {"anchors": [{"entry_id": "loc", "roles": ["alt_angle", "master"],
                      "first": True}]}, taken)
    assert ids == [] and taken == []


def test_the_preference_order_stops_at_the_first_plate_on_file(monkeypatch):
    monkeypatch.setattr(images.sb, "get",
                        _rows({"loc": {"master": "m1", "alt_angle": "a1"}}))
    taken = []
    ids = images._resolve_anchor(
        {"anchors": [{"entry_id": "loc", "roles": ["alt_angle", "master"],
                      "first": True}]}, taken)
    assert ids == ["a1"]
    assert taken == [{"entry_id": "loc", "role": "alt_angle"}]


def test_a_missing_plate_falls_through_and_says_so(monkeypatch):
    monkeypatch.setattr(images.sb, "get", _rows({"loc": {"master": "m1"}}))
    taken = []
    ids = images._resolve_anchor(
        {"anchors": [{"entry_id": "loc", "roles": ["atmosphere", "master"],
                      "first": True}]}, taken)
    assert ids == ["m1"]
    assert taken == [{"entry_id": "loc", "role": "master"}]


@pytest.fixture
def run(monkeypatch):
    """handle_image_gen against stubs; returns the prompt it composed."""
    seen = {}
    monkeypatch.setattr(images.graphs, "krea2_ref_graph",
                        lambda *a, **k: {"1": {"class_type": "Stub", "inputs": {}}})
    monkeypatch.setattr(images.graphs, "krea2_graph",
                        lambda *a, **k: {"1": {"class_type": "Stub", "inputs": {}}})
    monkeypatch.setattr(images, "_load_map_tier", lambda: MAP)
    monkeypatch.setattr(images, "_node_spec", lambda name: None)
    monkeypatch.setattr(images, "_has_node", lambda name: True)
    monkeypatch.setattr(images, "make_tick", lambda job: (lambda *a, **k: None))
    monkeypatch.setattr(images, "_stage_refs",
                        lambda ids, jid: ([f"r{i}.png" for i, _ in enumerate(ids)], []))
    monkeypatch.setattr(images.comfy, "submit", lambda g: "pid")
    monkeypatch.setattr(images.comfy, "wait", lambda pid, on_tick=None: {})
    monkeypatch.setattr(images.comfy, "fetch_output", lambda outs, keys, png: None)
    monkeypatch.setattr(images.media, "b2_put", lambda *a, **k: None)
    monkeypatch.setattr(images.sb, "job_patch", lambda *a, **k: None)
    monkeypatch.setattr(images.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(images.sb, "register_asset",
                        lambda *a, **k: seen.update(meta=k.get("meta") or {})
                        or {"id": "asset-1"})

    def go(on_file, plate):
        monkeypatch.setattr(images.sb, "get", _rows(on_file))
        images.handle_image_gen({"id": "job-1", "payload": {
            "model_key": "krea2", "prompt": "fallback",
            "prompt_spec": {**PANEL, "plate": plate},
            "anchors": [{"entry_id": "rei", "roles": ["turnaround", "face"],
                         "first": True},
                        {"entry_id": "loc", "roles": [plate, "master"],
                         "first": True}]}})
        return seen["meta"]["prompt"]
    return go


def test_the_prompt_names_the_plate_that_resolved_not_the_one_requested(run):
    """The Observatory is the live case: two of its four plates exist, so a
    rotation asking for `atmosphere` gets the master. Composing from the request
    would tell the model it is looking at the place in its signature light while
    handing it the flat establishing view."""
    out = run({"rei": {"turnaround": "t1"}, "loc": {"master": "m1"}}, "atmosphere")
    assert "its master plate" in out
    assert "signature light" not in out


def test_the_plate_that_is_on_file_is_described_as_itself(run):
    out = run({"rei": {"turnaround": "t1"},
               "loc": {"master": "m1", "alt_angle": "a1"}}, "alt_angle")
    assert "its reverse-angle plate" in out
    assert "its master plate" not in out


def test_a_panel_with_a_plate_asks_for_a_camera_move(run):
    """The whole point: without this the plate is reproduced and every panel of
    a scene comes back on the same camera."""
    out = run({"rei": {"turnaround": "t1"}, "loc": {"master": "m1"}}, "master")
    assert "[CAMERA]:" in out


# ------------------------------------------------------- the planner's own path
#
# `scene_panel_specs` is module-level for the reason `ref_plan_for` is: it was a
# closure inside plan_storyboard, so nothing else could compose a panel the way
# the planner does, and a redraw had to reimplement it and then drift.

SHOTS = [{"camera": "a wide establishing shot at eye level",
          "action": "Rei walks the aisle.", "cast": ["Rei"]},
         {"camera": "a medium shot at eye level",
          "action": "Guide Rei catches up to Rei.", "cast": ["Rei", "Guide Rei"]},
         {"camera": "an insert at high angle",
          "action": "the marble rolls into the gutter.", "cast": ["Rei"]},
         {"camera": "a wide shot of the whole aisle",
          "action": "they stand apart.", "cast": ["Rei", "Guide Rei"]}]
CAST = [{"id": "e-rei", "name": "Rei", "identity_line": "black bob", "doc": {}},
        {"id": "e-guide", "name": "Guide Rei", "identity_line": "brown coat", "doc": {}}]
ENV = {"id": "e-gh", "name": "Glass House", "identity_line": "humid emerald aisles"}


def _built():
    import llm
    return llm.scene_panel_specs(SHOTS, CAST, ENV, style="Anime (2D)")


def test_the_planner_rotates_the_plate_across_a_scene():
    assert [s["plate"] for _, s in _built()] == ["master", "alt_angle", "detail",
                                                 "atmosphere"]


def test_the_planner_asks_for_ONE_picture_of_the_location():
    """A three-role preference list without `first` stages three plates and one
    location eats the whole slot budget."""
    for anchors, spec in _built():
        env = [a for a in anchors if a["entry_id"] == "e-gh"]
        assert len(env) == 1 and env[0]["first"] is True
        assert env[0]["roles"][0] == spec["plate"]
        assert "master" in env[0]["roles"]


def test_a_wide_still_puts_the_location_in_the_strong_slot():
    """The plate rotation must not disturb `location_leads` — image1 is what
    turned "wide establishing" into a medium two-shot when a face held it."""
    built = _built()
    assert built[0][0][0]["entry_id"] == "e-gh"      # wide
    assert built[3][0][0]["entry_id"] == "e-gh"      # wide
    assert built[1][0][0]["entry_id"] != "e-gh"      # medium: faces first


def test_an_insert_takes_the_detail_plate_but_keeps_its_faces():
    """The plate is right and the ORDER is deliberately left alone.

    Leading with the location on an insert was tried and measurably lost: b3 of
    PLANT-GLASSHOUSE went from a wrong medium three-shot to a generic shot of
    the glasshouse frontage, and its correlation against its neighbours rose
    (0.17 -> 0.37 against b2, 0.18 -> 0.34 against b4). Neither picture a panel
    stages is the subject of an insert, so choosing between them is choosing
    which wrong thing fills the frame; the fix is the prop's own sheet, which
    `panelSpec` does not build."""
    import llm
    anchors, spec = llm.scene_panel_specs(SHOTS, CAST, ENV, style="Anime (2D)")[2]
    assert spec["plate"] == "detail"
    assert anchors[0]["entry_id"] != "e-gh"
    assert anchors[-1]["entry_id"] == "e-gh"


def test_a_scene_with_no_location_composes_without_a_plate():
    import llm
    for _, spec in llm.scene_panel_specs(SHOTS, CAST, None, style="Anime (2D)"):
        assert "plate" not in spec
        assert spec["location"] is None


# ---------------------------------------------------------------- backfill --
# A RETURNING location keeps whatever plate subset it has — the rotation then
# quietly resolves every ring shot back to the master, which is the one-camera
# lock reintroduced by absence (Rei E3's Observatory: master+detail on file,
# 28 of 48 beats). backfill_env_plates is the turnaround backfill's twin.

def _backfill(on_file, envs=None, skip=frozenset()):
    import llm
    calls = []

    def fake_sheet_job(entry, role, *, deps=None, extra=None, spec_extra=None,
                       size=(1024, 1024)):
        calls.append({"entry": entry["id"], "role": role,
                      "deps": list(deps or []), "size": size,
                      "from_ref": (spec_extra or {}).get("from_ref"),
                      "anchor": (extra or {}).get("anchor_roles")})
        return f"job-{entry['id']}-{role}"

    out = llm.backfill_env_plates(
        envs if envs is not None else [{"name": "Observatory"}],
        name_to_id={("environment", "observatory"): "e-obs",
                    ("environment", "glass house"): "e-gh"},
        skip_ids=skip,
        have_roles=lambda eid: on_file.get(eid, set()),
        fetch_entry=lambda eid: {"id": eid, "kind": "environment",
                                 "name": "Observatory", "doc": {}},
        sheet_job=fake_sheet_job)
    return out, calls


def test_backfill_draws_exactly_the_missing_plates_anchored_on_the_master():
    out, calls = _backfill({"e-obs": {"master", "detail"}})
    assert [c["role"] for c in calls] == ["alt_angle", "atmosphere"]
    for c in calls:
        assert c["from_ref"] is True
        assert c["anchor"] == ["master"]
        assert c["size"] == (1280, 704)


def test_backfill_chains_the_jobs_and_returns_the_last():
    """Panels dep on ONE job per entry (master_job_by_entry), so waiting for
    the last plate must mean waiting for all of them."""
    out, calls = _backfill({"e-obs": set()})
    assert [c["role"] for c in calls] == ["master", "alt_angle", "detail",
                                          "atmosphere"]
    assert calls[0]["deps"] == []
    for prev, c in zip(calls, calls[1:]):
        assert c["deps"] == [f"job-e-obs-{prev['role']}"]
    assert out == {"e-obs": "job-e-obs-atmosphere"}


def test_backfill_leaves_a_complete_location_alone():
    out, calls = _backfill(
        {"e-gh": {"master", "alt_angle", "detail", "atmosphere"}},
        envs=[{"name": "Glass House"}])
    assert calls == [] and out == {}


def test_backfill_skips_the_locations_this_plan_just_created():
    """New entries got their plates in the new-entries loop; drawing them again
    here would render every plate twice."""
    out, calls = _backfill({"e-obs": set()}, skip=frozenset({"e-obs"}))
    assert calls == [] and out == {}


def test_a_backfilled_master_is_not_anchored_on_itself():
    _, calls = _backfill({"e-obs": {"alt_angle", "detail", "atmosphere"}})
    assert [c["role"] for c in calls] == ["master"]
    assert calls[0]["from_ref"] is None and calls[0]["anchor"] is None


# ------------------------------------------------------------- cast staging --
# The flat two-face cap is what put invented extras into finished panels:
# MEMORY-RELEASE b4 cast three people, staged two sheets, and H3 drew the
# third from her sentence alone — a different person in the background.

CAST3 = CAST + [{"id": "e-miko", "name": "Miko", "identity_line": "white kimono",
                 "doc": {}}]
SHOT3 = [{"camera": "an overhead close-up", "action": "Miko kneels beside Rei "
          "as Guide Rei watches.", "cast": ["Miko", "Rei", "Guide Rei"]}]


def test_h3_stages_every_cast_member_up_to_four():
    import llm
    import image_prompt
    cap = image_prompt.panel_cast_cap("h3-image-turbo")
    (anchors, spec), = llm.scene_panel_specs(SHOT3, CAST3, ENV,
                                             style="Anime (2D)", cast_cap=cap)
    faces = [a for a in anchors if a["entry_id"] != "e-gh"]
    assert len(faces) == 3
    assert spec["cast_complete"] is True


def test_the_narrow_families_keep_the_old_cap_and_say_so():
    import llm
    import image_prompt
    cap = image_prompt.panel_cast_cap("krea2")
    (anchors, spec), = llm.scene_panel_specs(SHOT3, CAST3, ENV,
                                             style="Anime (2D)", cast_cap=cap)
    faces = [a for a in anchors if a["entry_id"] != "e-gh"]
    assert len(faces) == 2
    # somebody was dropped, so the envelope must NOT claim the set is closed
    assert "cast_complete" not in spec


def test_cap_matching_covers_both_spellings():
    import image_prompt as ip
    assert ip.panel_cast_cap("h3-image-turbo-local") == 4   # catalog id
    assert ip.panel_cast_cap("minimax-h3") == 4             # model_map key
    assert ip.panel_cast_cap("qwen-edit") == 2
    assert ip.panel_cast_cap(None) == 2
    # SenseNova's edit node takes ten images, so the two-face budget Krea 2's
    # four and Qwen's three bought does not apply to it either.
    assert ip.panel_cast_cap("sensenova-u1") == 4


def test_the_envelope_closes_the_set_only_when_complete():
    import image_prompt as ip
    spec = {"kind": "panel", "style": "Anime (2D)",
            "camera": "a medium two-shot at eye level",
            "action": "Miko kneels beside Rei.",
            "cast": [{"name": "Rei", "identity": "blue streak"},
                     {"name": "Miko", "identity": "white kimono"}],
            "location": {"name": "Glass House", "identity": "emerald aisles"},
            "refs": ["Rei's character sheet", "Miko's character sheet"],
            "ref_subjects": [
                {"kind": "character", "name": "Rei", "identity": "blue streak"},
                {"kind": "character", "name": "Miko", "identity": "white kimono"}]}
    closed = ip.compose({**spec, "cast_complete": True}, "h3")
    open_ = ip.compose(spec, "h3")
    assert "no other person" in closed
    assert "no other person" not in open_


def test_a_wide_that_drops_faces_never_claims_the_set_is_closed():
    """Ordering keeps one face on a wide (location_leads); the other two stay
    in the prose. Claiming "no other people" there tells the model two
    contradictory things about the same frame — caught live on v4's
    OBSERVATORY b1 before any pixel rendered."""
    import llm
    shot = [{"camera": "a wide establishing shot at eye level",
             "action": "Miko, Rei and Guide Rei cross the aisle.",
             "cast": ["Miko", "Rei", "Guide Rei"]}]
    (anchors, spec), = llm.scene_panel_specs(shot, CAST3, ENV,
                                             style="Anime (2D)", cast_cap=4)
    faces = [a for a in anchors if a["entry_id"] != "e-gh"]
    assert len(faces) == 1          # wide: location leads, one face rides
    assert "cast_complete" not in spec


def test_derived_plates_never_render_on_h3():
    """The move imperative was measured on the Krea 2 reference path; on H3
    the anchored master wins over the sentence and all four plates come back
    one vantage (measured: Portal Clearing's four h3-rendered plates were
    crops of one frontal view). The rule lives inside sheet_job, a closure a
    test cannot call, so this pins the SOURCE the way test_draft_session
    does: the job insert must pick krea2 for a derived plate and the wizard's
    model otherwise."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parent.parent / "llm.py").read_text()
    body = src.split("def sheet_job(")[1].split("# Characters: a tight face plate")[0]
    assert 'role in ("alt_angle", "detail", "atmosphere")' in body
    assert '"model_key": ("krea2" if derived_plate' in body
    assert 'payload.get("image_model")' in body


def test_the_redirect_is_off_h3_and_not_a_pin_to_krea2():
    """The guard exists because H3 collapses a derived plate onto its anchor.
    Applied to EVERY family it silently discards the wizard's choice for three
    of a location's four plates and splits one bible's plates across two
    render families — the internal inconsistency the reference encoder then
    resolves in favour of whatever holds image1. SenseNova was measured doing
    the exact move H3 cannot, so redirecting it would be a downgrade wearing a
    guard's clothes."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parent.parent / "llm.py").read_text()
    body = src.split("def sheet_job(")[1].split("# Characters: a tight face plate")[0]
    assert 'startswith("h3-image")' in body, (
        "the derived-plate redirect must be conditioned on the chosen family")
    # and it must read the WIZARD's model, not the composed spec — the spec
    # carries no model at all, so a condition written against it is always
    # false and the guard silently stops guarding.
    cond = body.split("derived_plate = ")[1].split("j2 = sb.insert")[0]
    assert 'payload.get("image_model")' in cond


# ------------------------------------------------- featured-cast staging ----
# `beats.meta.cast` is the cinematographer's roster, and its contract already
# says "ONLY the characters visibly in frame" — ASTRONAUT_CAPTURE wrote the
# scene's whole five-name roster onto every beat anyway. Staging follows the
# SHOT'S OWN TEXT (image_prompt.featured_cast); the roster survives only as
# the pronoun fallback. Measured failures these pin: a close-up that staged
# five references and montaged (b3), and the breath beat that staged four
# character sheets and came back AS a grey-ground sheet (b7).


def test_a_roster_beat_stages_only_who_the_shot_names():
    import llm
    shot = [{"camera": "a tracking shot at low angle",
             "action": "Guide Rei catches Rei.",
             "cast": ["Miko", "Rei", "Guide Rei"]}]
    (anchors, spec), = llm.scene_panel_specs(shot, CAST3, ENV,
                                             style="Anime (2D)", cast_cap=4)
    faces = [a for a in anchors if a["entry_id"] != "e-gh"]
    # mention order: Guide Rei is named first, and plain Rei is matched by the
    # standalone word, not by the "Rei" inside "Guide Rei"
    assert [a["entry_id"] for a in faces] == ["e-guide", "e-rei"]
    # the featured pair IS the claim, so the set closes even though the
    # roster lists a third name the shot never says
    assert spec["cast_complete"] is True
    assert [c["name"] for c in spec["cast"]] == ["Guide Rei", "Rei"]


def test_a_close_up_keeps_its_action_named_cast_and_leads_with_its_subject():
    """A close-up-stages-ONE rule was tried here and lost the same day it
    shipped: withholding the action-named second character's sheet re-invited
    the invented-extra artifact (b3 grew a masked off-model Astronaut Rei,
    b6 a Villian in an invented white shirt — both drawn from prose). The
    part of it that was right — the camera's subject in image1 — falls out
    of mention order for free, because the camera text leads the matcher's
    input. This pins the drop staying gone."""
    import llm
    shot = [{"camera": "a close-up at dutch angle; the camera pushes in on "
                       "Rei's tightening face",
             "action": "Guide Rei watches Rei brace against the glass.",
             "cast": ["Miko", "Rei", "Guide Rei"]}]
    (anchors, spec), = llm.scene_panel_specs(shot, CAST3, ENV,
                                             style="Anime (2D)", cast_cap=4)
    faces = [a for a in anchors if a["entry_id"] != "e-gh"]
    assert [a["entry_id"] for a in faces] == ["e-rei", "e-guide"]
    # both featured members staged, so the set closes
    assert spec["cast_complete"] is True


def test_a_medium_close_up_keeps_its_pair():
    """A close size stages everyone the shot names — "arcs around A and B" is
    a two-hander whatever the size word says."""
    import llm
    shot = [{"camera": "a medium close-up at high angle; the camera arcs "
                       "around Rei and Guide Rei",
             "action": "the gravity transfer reverses the space.",
             "cast": ["Rei", "Guide Rei", "Miko"]}]
    (anchors, spec), = llm.scene_panel_specs(shot, CAST3, ENV,
                                             style="Anime (2D)", cast_cap=4)
    faces = [a for a in anchors if a["entry_id"] != "e-gh"]
    assert len(faces) == 2


def test_a_breath_beat_stages_the_place_alone():
    import llm
    shot = [{"camera": "the camera holds a static shot on the space just left",
             "action": "A held, wordless beat: no one speaks and nothing new "
                       "enters the frame; only ambient motion continues.",
             "cast": ["Miko", "Rei", "Guide Rei"],
             "meta": {"breath": True}}]
    (anchors, spec), = llm.scene_panel_specs(shot, CAST3, ENV,
                                             style="Anime (2D)", cast_cap=4)
    assert [a["entry_id"] for a in anchors] == ["e-gh"]
    assert spec["cast"] == []
    assert "cast_complete" not in spec


def test_the_planner_queues_no_panel_for_a_breath_beat():
    """The skip lives in the QUEUE loop, not the spec builder, so the specs
    stay 1:1 with the scene's beats and the plate-rotation turn counter keeps
    agreeing with the browser twin. Source-parsed because the loop is a
    closure inside plan_storyboard — the codebase's own pattern."""
    import pathlib
    import llm
    src = pathlib.Path(llm.__file__).read_text()
    seg = src.split("for (brow, sh), (anchors, pspec) in zip(brs, built):")[1]
    head = seg.split("deps = [")[0]
    assert '"breath"' in head and "continue" in head

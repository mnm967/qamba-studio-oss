"""Re-drawing a scene's panels from the beats as they stand now.

THE BUG THIS CLOSES was an absence, not a defect: panels were drawn in exactly
two places — tier 1 and the storyboard page's button — and the director chat
could reach neither. Asked to "rewrite these beats and redraw the panels" it
did the first half, reported it accurately, and never said the second half was
impossible, because from inside the toolset it did not look impossible. The
panels went on describing the shots the scene used to have, and nothing marks a
panel stale, so nothing on screen said so either.

Everything checked here is a way for the redraw to go quietly wrong. A panel
job that renders the WRONG picture still renders: it lands on the scene card,
it looks like a panel, and only reading it against the beat tells you it is
describing a shot that no longer exists.
"""
import pytest

import llm


SC = "5ce4e000-0000-0000-0000-00000000000{}"
BT = "bea70000-0000-0000-0000-00000000000{}"


def beat(n, camera="a medium shot, holding still", action="Rei crosses the room",
         cast=("Rei",), **meta):
    return {"id": BT.format(n), "idx": n - 1, "camera": camera, "action": action,
            "dialogue": [], "meta": {"cast": list(cast), **meta}}


class FakeSb:
    """Just enough PostgREST to watch what gets queued."""

    def __init__(self, *, scenes, beats, project=None, bible=None,
                 catalog=None, sheets=None):
        self.scenes = scenes
        self.beats = beats                      # {scene_id: [rows]}
        self.project = project or {"id": "p1", "style": "anime", "settings": {}}
        self.bible = bible or {}
        self.catalog = catalog or {}
        # {entry_id: [{role, asset_id}]} — what `_resolve_anchor` walks.
        self.sheets = sheets or {}
        self.inserts, self.notes = [], []
        self.done = False

    def model_catalog(self, max_age=300):
        return self.catalog

    def get(self, path):
        if path.startswith("projects?"):
            return [self.project]
        if path.startswith("scenes?"):
            want = path.split("id=in.(")[1].split(")")[0].split(",")
            return [s for s in self.scenes if s["id"] in want]
        if path.startswith("beats?"):
            return self.beats.get(path.split("scene_id=eq.")[1].split("&")[0], [])
        if path.startswith("bible_assets?"):
            eid = path.split("entry_id=eq.")[1].split("&")[0]
            rows = self.sheets.get(eid, [])
            if "role=eq." in path:
                want = path.split("role=eq.")[1].split("&")[0]
                rows = [r for r in rows if r.get("role") == want]
            return [dict(r) for r in rows[:1]]
        if path.startswith("bible_entries?"):
            frag = path.split("bible_entries?id=")[1].split("&")[0]
            want = (frag[len("in.("):-1].split(",") if frag.startswith("in.(")
                    else [frag[len("eq."):]])
            return [self.bible[w] for w in want if w in self.bible]
        return []

    def insert(self, table, body):
        self.inserts.append((table, body))
        return {"id": f"job-{len(self.inserts)}", **body}

    def job_progress(self, jid, fraction, note=None):
        self.notes.append(note)

    def job_patch(self, jid, body):
        self.result = (body.get("payload") or {}).get("result")

    def job_done(self, jid):
        self.done = True


REI = {"id": "e-rei", "name": "Rei", "identity_line": "short black bob, red jacket"}
MIKO = {"id": "e-miko", "name": "Miko", "identity_line": "cropped silver hair, grey coat"}
PLACE = {"id": "e-street", "name": "Flooded Street",
         "identity_line": "ankle-deep water under sodium light"}


def scene(sid=SC.format(1), slug="CITY_CAPTURE_2", cast_ids=("e-rei",), **meta):
    return {"id": sid, "idx": 6, "slug": slug, "cast_ids": list(cast_ids),
            "environment_id": "e-street", "meta": meta}


def run(fake, monkeypatch, **payload):
    monkeypatch.setattr(llm, "sb", fake)
    # `_resolve_anchor` reads through handlers.images' OWN `sb` reference. In
    # production both names are the same module; here they are two, and
    # patching one leaves the anchor walk talking to the real network.
    from handlers import images as HI
    monkeypatch.setattr(HI, "sb", fake)
    job = {"id": "j1", "payload": {"task": "redraw_panels", "project_id": "p1",
                                   "episode_id": "ep1", **payload}}
    llm.redraw_panels(job)
    return [b for t, b in fake.inserts if t == "jobs"]


def specs(jobs):
    return [j["payload"]["prompt_spec"] for j in jobs]


# ─────────────────────────────────────────────── it queues the right jobs ───

def test_one_panel_job_per_shot_aimed_at_the_auto_slot(monkeypatch):
    """`as: "panel"` is the regenerable slot. A user's own designated still
    lives in `still_asset_id` and outranks it everywhere, which is the whole
    reason the two keys are not one — a redraw must not destroy an upload."""
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1), beat(2)]},
               bible={"e-rei": REI, "e-street": PLACE})
    jobs = run(f, monkeypatch, scene_ids=[SC.format(1)])
    assert [j["kind"] for j in jobs] == ["image_gen", "image_gen"]
    assert [j["payload"]["target"] for j in jobs] == [
        {"beat_id": BT.format(1), "as": "panel"},
        {"beat_id": BT.format(2), "as": "panel"}]
    assert f.done and f.result["queued"] == 2


def test_a_breath_beat_draws_no_panel(monkeypatch):
    """A held pause has no composition of its own, so a panel composed from its
    filler action renders the staged sheets back — measured as a grey character
    sheet. The skip has to match tier 1 and the button or the three surfaces
    disagree about how many panels a scene has."""
    f = FakeSb(scenes=[scene()],
               beats={SC.format(1): [beat(1), beat(2, breath=True), beat(3)]},
               bible={"e-rei": REI, "e-street": PLACE})
    jobs = run(f, monkeypatch, scene_ids=[SC.format(1)])
    assert [j["payload"]["target"]["beat_id"] for j in jobs] == [
        BT.format(1), BT.format(3)]


def test_a_scene_with_no_beats_is_skipped_rather_than_failing(monkeypatch):
    f = FakeSb(scenes=[scene(SC.format(1)), scene(SC.format(2), slug="EMPTY")],
               beats={SC.format(1): [beat(1)], SC.format(2): []},
               bible={"e-rei": REI, "e-street": PLACE})
    jobs = run(f, monkeypatch, scene_ids=[SC.format(1), SC.format(2)])
    assert len(jobs) == 1
    assert f.result["scenes"] == [{"scene": "CITY_CAPTURE_2", "panels": 1}]


def test_no_scenes_raises_rather_than_reporting_success(monkeypatch):
    f = FakeSb(scenes=[], beats={})
    with pytest.raises(llm.LLMError):
        run(f, monkeypatch, scene_ids=[])
    with pytest.raises(llm.LLMError):
        run(f, monkeypatch, scene_ids=[SC.format(9)])


# ─────────────────────────────────── the composition sees the WHOLE scene ───

def test_redrawing_one_shot_still_picks_the_plate_the_batch_picked(monkeypatch):
    """THE REASON `beat_ids` FILTERS THE INSERT AND NOT THE COMPOSITION.

    The location-plate rotation is a per-scene decision (image_prompt.
    plate_plan), so a spec built from a subset walks a different ring position
    and the redrawn shot stops matching the neighbours it sits between — a
    panel that is individually fine and wrong in the row."""
    rows = [beat(1), beat(2), beat(3)]
    whole = FakeSb(scenes=[scene()], beats={SC.format(1): rows},
                   bible={"e-rei": REI, "e-street": PLACE})
    plates = [s["plate"] for s in specs(run(whole, monkeypatch,
                                            scene_ids=[SC.format(1)]))]
    assert plates == ["master", "alt_angle", "atmosphere"]

    one = FakeSb(scenes=[scene()], beats={SC.format(1): rows},
                 bible={"e-rei": REI, "e-street": PLACE})
    jobs = run(one, monkeypatch, scene_ids=[SC.format(1)],
               beat_ids=[BT.format(3)])
    assert len(jobs) == 1
    assert specs(jobs)[0]["plate"] == "atmosphere"


def test_the_ring_picks_up_where_the_scene_stamp_says(monkeypatch):
    """`scenes.meta.plate_turn` is stamped at plan time precisely because a
    single-scene redraw cannot count the scenes before it. Defaulting to 0 on a
    stamped board re-establishes on the master and undoes the rotation — the
    bottle-episode failure, one surface along."""
    f = FakeSb(scenes=[scene(plate_turn=1)], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE})
    assert specs(run(f, monkeypatch, scene_ids=[SC.format(1)]))[0]["plate"] \
        == "alt_angle"


def test_a_board_with_no_stamp_behaves_exactly_as_it_was_drawn(monkeypatch):
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE})
    assert specs(run(f, monkeypatch, scene_ids=[SC.format(1)]))[0]["plate"] \
        == "master"


# ──────────────────────────────────────────── the beat ROW is not a SHOT ───

def test_the_cast_is_lifted_out_of_meta_so_the_RIGHT_face_is_staged(monkeypatch):
    """A beat ROW carries its cast under `meta.cast`; a planner SHOT carries it
    at the top level, and `scene_panel_specs` reads the shot shape. Passing the
    row straight through leaves `named` empty — and that does not fail, it
    FALLS BACK to `cast_rows[:1]`, i.e. whichever character the scene lists
    first. So a two-hander shot of Miko stages Rei's sheet, the panel comes
    back with the wrong face, and nothing anywhere raises.

    Which is why this scene casts two people and the beat casts the SECOND:
    with one character the fallback happens to be right and hides the bug.
    """
    f = FakeSb(scenes=[scene(cast_ids=["e-rei", "e-miko"])],
               beats={SC.format(1): [beat(1, action="Miko backs into the water",
                                          cast=("Miko",))]},
               bible={"e-rei": REI, "e-miko": MIKO, "e-street": PLACE})
    jobs = run(f, monkeypatch, scene_ids=[SC.format(1)])
    spec = specs(jobs)[0]
    assert [c["name"] for c in spec["cast"]] == ["Miko"]
    assert spec["location"]["name"] == "Flooded Street"
    # anchors ride with refs and ref_subjects, in one order
    assert len(jobs[0]["payload"]["anchors"]) == len(spec["refs"])


def test_the_camera_and_action_come_from_the_beat_as_it_stands_now(monkeypatch):
    """The point of the whole tool: the panel describes the edited shot."""
    f = FakeSb(scenes=[scene()],
               beats={SC.format(1): [beat(1, camera="a wide lateral tracking shot at low angle",
                                          action="Villian Rei phases through the spinning car")]},
               bible={"e-rei": REI, "e-street": PLACE})
    spec = specs(run(f, monkeypatch, scene_ids=[SC.format(1)]))[0]
    assert spec["action"] == "Villian Rei phases through the spinning car"
    assert spec["camera"].startswith("a wide lateral tracking shot")


# ───────────────────────────────────────────────── model, style and size ───

def test_the_catalog_id_on_the_project_becomes_a_model_map_key(monkeypatch):
    """`settings.image_model` is a CATALOG id and the worker resolves against
    model_map. Sent unmapped, `h3-image-turbo-local` is not a model_map entry
    and the job dies on "model not available" — after it has queued, waited for
    a GPU and been claimed."""
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE},
               project={"id": "p1", "style": "anime",
                        "settings": {"image_model": "h3-image-turbo-local",
                                     "image_quality": "medium"}})
    p = run(f, monkeypatch, scene_ids=[SC.format(1)])[0]["payload"]
    assert p["model_key"] == "h3-image-turbo"
    assert p["quality"] == "medium"


def test_an_explicit_model_wins_over_the_project_default(monkeypatch):
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE},
               project={"id": "p1", "style": "anime",
                        "settings": {"image_model": "krea2-local"}})
    p = run(f, monkeypatch, scene_ids=[SC.format(1)],
            image_model="gpt-image-2")[0]["payload"]
    assert p["model_key"] == "gpt-image-2"


def test_a_project_with_no_image_model_sends_none_rather_than_empty(monkeypatch):
    """An empty key would override the worker's own pick with nothing."""
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE})
    assert "model_key" not in run(f, monkeypatch,
                                  scene_ids=[SC.format(1)])[0]["payload"]


def test_style_is_the_project_field_and_not_the_settings_guide(monkeypatch):
    """A panel's job is to look like the sheets it is anchored to, and those
    were drawn off `projects.style`. The two genuinely disagree in the wild —
    reading the guide redraws one panel photoreal in the middle of an animated
    board (the browser twin documents the same choice)."""
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE},
               project={"id": "p1", "style": "anime",
                        "settings": {"style_guide": "live-action cinematic photography"}})
    assert specs(run(f, monkeypatch, scene_ids=[SC.format(1)]))[0]["style"] == "anime"


def test_an_unset_style_resolves_the_way_every_other_surface_resolves_it(monkeypatch):
    """Tier 1 substitutes "anime" and the browser's PLANNER_STYLE_FALLBACK is
    the same literal. A third answer here would regrade the scene on redraw."""
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE},
               project={"id": "p1", "style": None, "settings": {}})
    assert specs(run(f, monkeypatch, scene_ids=[SC.format(1)]))[0]["style"] == "anime"


def test_panels_render_at_the_panel_size_and_on_the_pod_lane(monkeypatch):
    """1280x704 is PANEL_W/PANEL_H in the browser twin and tier 1's own
    default. And a `prompt_spec` job composes in Python, so it stays on the
    pod's lane even for a studio-hosted model — the browser's own routing rule
    (enqueueJob rewrites gpu->local for LITERAL payloads only)."""
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE})
    j = run(f, monkeypatch, scene_ids=[SC.format(1)])[0]
    assert (j["payload"]["width"], j["payload"]["height"]) == (1280, 704)
    assert j["lane"] == "gpu" and j["priority"] == 5
    assert j["payload"]["auto_accept"] is True


def test_a_prompt_rides_alongside_the_spec(monkeypatch):
    """Tier 1 sends both, so a pod on an older build renders the same string.
    Composed from the SAME spec, so the two cannot disagree."""
    f = FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
               bible={"e-rei": REI, "e-street": PLACE})
    p = run(f, monkeypatch, scene_ids=[SC.format(1)])[0]["payload"]
    assert p["prompt"] and isinstance(p["prompt"], str)
    assert "CITY_CAPTURE_2" in p["label"] and "b1" in p["label"]


# ─────────────────────────────────────── there is one plane, so one path ───
#
# THE CLOUD BUILD HAD A THIRD RENDER PLANE — the studio's own provider keys,
# spent server-side — and a panel job was the awkward case for it: the payload
# carries `prompt_spec` plus late-bound `anchors`, both resolved in Python at
# render time, so that route refused it and the whole panel path composed
# early for a hosted row instead. None of that exists here. Every render is
# this machine's ComfyUI or this machine's own API key, `hosted_image` says so
# in one place, and every panel therefore takes the one path.
#
# Pinned rather than deleted: a fork that adds a server-side key route has to
# come back through here, and until it does a row that merely LOOKS hosted
# must not start being treated as though it were.

GPT = {"id": "gpt-image-2", "kind": "image", "provider": "openai",
       "enabled": True, "capabilities": {}}
SHEETS = {"e-rei": [{"role": "turnaround", "asset_id": "as-rei"}],
          "e-street": [{"role": "master", "asset_id": "as-street"}]}


def hosted_fake(row=GPT, **over):
    return FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
                  bible={"e-rei": REI, "e-street": PLACE},
                  project={"id": "p1", "style": "anime",
                           "settings": {"image_model": row["id"]}},
                  catalog={row["id"]: row}, sheets=SHEETS, **over)


def test_no_row_is_billed_to_anybody_but_the_person_at_the_keyboard():
    """`studio_hosted` is the whole decision and its answer is No.

    Every shape the old reroute distinguished between — a studio key, the
    user's own key, a row with no key at all, a video row, a provider nothing
    here adapts — is one answer now, because the plane it chose between is
    gone.
    """
    import hosted_image
    for row in (GPT,
                {**GPT, "capabilities": {"byok": True}},
                {**GPT, "enabled": False},
                {**GPT, "id": "h3-api", "kind": "video"},
                {**GPT, "provider": "fal"}):
        assert hosted_image.studio_hosted(row) is False, row["id"]


def test_a_panel_keeps_its_spec_and_composes_at_render_time(monkeypatch):
    """The reason for composing late still holds and has nothing to do with
    planes: the reference fallback can swap Krea 2 for Klein, and each family
    reads a different prompt order — so the family is only final once the
    references have resolved, which is inside `handle_image_gen`."""
    for f in (hosted_fake(),
              FakeSb(scenes=[scene()], beats={SC.format(1): [beat(1)]},
                     bible={"e-rei": REI, "e-street": PLACE}, sheets=SHEETS,
                     project={"id": "p1", "style": "anime",
                              "settings": {"image_model": "krea2-local"}},
                     catalog={"krea2": {"id": "krea2", "kind": "image",
                                        "provider": "local", "enabled": True}})):
        j = run(f, monkeypatch, scene_ids=[SC.format(1)])[0]
        assert j["payload"]["prompt_spec"] and j["payload"]["anchors"]
        assert j["payload"]["target"] == {"beat_id": BT.format(1), "as": "panel"}
        # The LANE is `sb.insert`'s to correct — it rewrites every job of a
        # local project onto the one queue this machine claims, which is why
        # a literal default here is moot rather than wrong.
        assert j["lane"] == llm.LANE_DEFAULTS["image_gen"]

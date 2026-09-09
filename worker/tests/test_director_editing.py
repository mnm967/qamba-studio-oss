"""Editing an episode by chat: re-renders, takes, appended shots, recasts.

The chat could always rewrite a scene. What it could not do was make the
change visible — an edit ended by setting `generation_blocks.status = 'stale'`,
a status nothing in the worker reads, so every conversation finished by telling
the user to go and click something. These pin the tools that close that loop,
and the two guards that stop them being expensive: a re-render must actually
carry the model and the notes it was given, and a fan-out must not queue
without being confirmed.

Twin of the same tools in api/director/chat.js.
"""
import pytest

import director_tools as dt


PID = "aaaaaaaa-1111-4111-8111-111111111111"
SB = "bbbbbbbb-2222-4222-8222-222222222222"
BLK0 = "cccccccc-3333-4333-8333-333333333333"
BLK1 = "dddddddd-4444-4444-8444-444444444444"
TAKE1 = "eeeeeeee-5555-4555-8555-555555555555"
TAKE2 = "ffffffff-6666-4666-8666-666666666666"
BEAT = "99999999-8888-4888-8888-888888888888"
CTX = {"project_id": PID, "episode_id": "ep1", "thread_id": "th1",
       "backend": "ollama-local", "persona": ""}


def _block(bid, idx, *, status="generated", active=None, chain=None, params=None):
    return {"id": bid, "idx": idx, "storyboard_id": SB, "status": status,
            "scene_ids": ["sc1"], "beat_ids": ["bt1"],
            "t_start_ms": idx * 8000, "t_end_ms": (idx + 1) * 8000,
            "mode": "r2v", "active_take_id": active, "chain_from_block_id": chain,
            "params": params or {}, "ref_plan": [], "seed": 1}


@pytest.fixture
def db(monkeypatch):
    """A tiny fake Supabase that records every write."""
    state = {
        "patches": [], "inserts": [], "deletes": [],
        "blocks": [_block(BLK0, 0, active=TAKE1),
                   _block(BLK1, 1, status="stale", chain=BLK0)],
        "takes": [{"id": TAKE1, "block_id": BLK0, "kind": "master", "state": "kept",
                   "asset_id": "as1", "created_at": "2026-08-15T00:00:00Z"},
                  {"id": TAKE2, "block_id": BLK0, "kind": "master", "state": "pending",
                   "asset_id": "as2", "created_at": "2026-08-15T01:00:00Z"}],
        "reviews": [],
    }

    def fake_get(path):
        if path.startswith("episodes?"):
            return [{"id": "ep1"}]
        if path.startswith("storyboards?"):
            return [{"id": SB}]
        if path.startswith("generation_blocks?storyboard_id="):
            rows = state["blocks"]
            if "status=eq.stale" in path:
                rows = [b for b in rows if b["status"] == "stale"]
            return sorted(rows, key=lambda b: b["idx"])
        if path.startswith("generation_blocks?id=eq."):
            bid = path.split("id=eq.")[1].split("&")[0]
            return [b for b in state["blocks"] if b["id"] == bid]
        if path.startswith("generation_blocks?id=in."):
            ids = path.split("id=in.(")[1].split(")")[0].split(",")
            return [b for b in state["blocks"] if b["id"] in ids]
        if path.startswith("block_takes?block_id="):
            bid = path.split("block_id=eq.")[1].split("&")[0]
            return [t for t in state["takes"] if t["block_id"] == bid]
        if path.startswith("block_takes?id=eq."):
            tid = path.split("id=eq.")[1].split("&")[0]
            return [t for t in state["takes"] if t["id"] == tid]
        if path.startswith("take_reviews?"):
            return state["reviews"]
        if path.startswith("scenes?"):
            return [{"id": "sc1", "idx": 0, "slug": "OBSERVATORY", "storyboard_id": SB}]
        if path.startswith("beats?"):
            return [{"id": BEAT, "scene_id": "sc1", "idx": 0, "action": "they meet",
                     "camera": "static", "duration_ms": 8000, "dialogue": [], "meta": {}}]
        if path.startswith("jobs?"):
            return [{"id": "job1", "kind": "llm_task", "status": "done",
                     "payload": {"result": {"answer": "yes, a grey hat"}}}]
        return []

    def fake_patch(path, body, want_rows=False):
        state["patches"].append((path, body))
        return [] if want_rows else None

    def fake_insert(table, body):
        row = {"id": f"new-{table}-{len(state['inserts']) + 1}", **body}
        state["inserts"].append((table, row))
        return row

    monkeypatch.setattr(dt.sb, "get", fake_get)
    monkeypatch.setattr(dt.sb, "patch", fake_patch)
    monkeypatch.setattr(dt.sb, "insert", fake_insert)
    monkeypatch.setattr(dt.sb, "delete", lambda p: state["deletes"].append(p))
    monkeypatch.setattr(dt.sb, "asset_by_id",
                        lambda a: {"id": a, "kind": "video", "b2_key": "k.mp4"})
    return state


def _jobs(state, kind=None):
    return [b for t, b in state["inserts"]
            if t == "jobs" and (kind is None or b["kind"] == kind)]


# ----------------------------------------------------------- addressing ----

def test_a_block_is_addressable_the_way_it_is_on_screen(db):
    """The model reads "BLOCK b1" off the same storyboard the user does.
    Sending that where a uuid was expected used to come back as a raw
    Postgres 22P02, which surfaced as a failed tool call and an apology."""
    blk, err = dt._resolve_block("b2", PID)
    assert err is None and blk["id"] == BLK1
    blk, err = dt._resolve_block(BLK0, PID)
    assert err is None and blk["idx"] == 0


def test_an_unknown_block_ref_answers_with_the_list(db):
    """So the next call is right instead of another guess."""
    blk, err = dt._resolve_block("b10", PID)
    assert blk is None
    assert [b["ref"] for b in err["blocks"]] == ["b1", "b2"]


def test_a_catalog_id_and_a_model_map_key_both_resolve():
    """The user reads catalog ids off the pickers ("h3-turbo-local") while the
    worker renders on model_map keys. A tool may be handed either."""
    assert dt._model_key("h3-turbo-local") == "minimax-h3-turbo"
    assert dt._model_key("minimax-h3-turbo") == "minimax-h3-turbo"
    assert dt._model_key("krea2-local") == "krea2"
    assert dt._model_key(None) is None


# ------------------------------------------------------------ rerender ----

def test_a_rerender_carries_the_model_the_loras_and_the_note(db):
    """The whole point of the payload-override work: before it, master_pass
    read the model only off the block's stored params, so a re-render asked to
    use a different checkpoint silently used the episode's."""
    out = dt.execute("rerender_block", {
        "block": "b1", "notes": "more urgency",
        "model_key": "h3-turbo-local",
        "loras": [{"key": "grit", "strength": 0.8}]}, CTX)
    assert "error" not in out
    p = _jobs(db, "master_pass")[0]["payload"]
    assert p["model_key"] == "minimax-h3-turbo"
    assert p["loras"] == [{"key": "grit", "strength": 0.8}]
    assert p["prompt_extra"] == "more urgency"
    assert p["block_id"] == BLK0


def test_a_rerender_replaces_by_default_and_restages_its_references(db):
    """A content edit means "make the shot different", so the different one is
    what should play. And it must restage sheets, or a costume change never
    reaches the picture."""
    dt.execute("rerender_block", {"block": "b1"}, CTX)
    p = _jobs(db, "master_pass")[0]["payload"]
    assert p["activate"] == "replace"
    assert p["recompute_refs"] is True


def test_asking_for_another_take_leaves_it_side_by_side(db):
    dt.execute("rerender_block", {"block": "b1", "activate": "review"}, CTX)
    assert _jobs(db, "master_pass")[0]["payload"]["activate"] == "review"


def test_a_rerender_runs_at_user_priority(db):
    """Anything a human asked for outruns the machine's own queue."""
    dt.execute("rerender_block", {"block": "b1"}, CTX)
    job = _jobs(db, "master_pass")[0]
    assert job["priority"] == dt.USER_PRIORITY == 5
    assert job["payload"]["label"]


# -------------------------------------------------------------- fan-out ----

def test_rerender_stale_is_a_dry_run_until_it_is_confirmed(db):
    """The one tool that can spend real money at scale. A model told "fix it"
    will otherwise re-render an episode on its own initiative."""
    out = dt.execute("rerender_stale", {"scope": "all"}, CTX)
    assert out["dry_run"] is True
    assert [b["ref"] for b in out["blocks"]] == ["b2"]
    assert not _jobs(db, "master_pass"), "a dry run must queue nothing"


def test_confirming_queues_and_keeps_chained_blocks_in_order(db):
    """A chained block opens on its predecessor's final frame, so re-rendering
    them concurrently would anchor to a frame that is being replaced."""
    db["blocks"].append(_block("gggggggg-7777-4777-8777-777777777777", 2,
                               status="stale", chain=BLK1))
    out = dt.execute("rerender_stale", {"scope": "all", "confirm": True}, CTX)
    assert [q["ref"] for q in out["queued"]] == ["b2", "b3"]
    jobs = _jobs(db, "master_pass")
    assert not jobs[0].get("depends_on"), "the first has nothing to wait for"
    assert jobs[1]["depends_on"] == [jobs[0]["id"]]


def test_nothing_stale_says_so_rather_than_queueing(db):
    db["blocks"] = [_block(BLK0, 0, active=TAKE1)]
    out = dt.execute("rerender_stale", {"confirm": True}, CTX)
    assert out["blocks"] == [] and not _jobs(db, "master_pass")


# --------------------------------------------------------------- takes ----

def test_activating_a_take_stales_the_blocks_chained_after_it(db):
    """The chain anchor just moved: every later chained block now opens on a
    frame that is no longer in the cut."""
    out = dt.execute("activate_take", {"block": "b1", "index": 2}, CTX)
    assert out["active_take_id"] == TAKE2
    assert any("active_take_id" in body and body["active_take_id"] == TAKE2
               for _p, body in db["patches"])
    assert any("idx=gt.0" in p and "chain_from_block_id=not.is.null" in p
               and body == {"status": "stale"} for p, body in db["patches"])


def test_an_out_of_range_take_index_is_refused_by_name(db):
    out = dt.execute("activate_take", {"block": "b1", "index": 7}, CTX)
    assert "out of range" in out["error"] and "2 take(s)" in out["error"]


def test_a_take_must_be_a_video(db, monkeypatch):
    monkeypatch.setattr(dt.sb, "asset_by_id",
                        lambda a: {"id": a, "kind": "image", "b2_key": "k.png"})
    out = dt.execute("add_take", {"block": "b1", "asset_id": "img1"}, CTX)
    assert "video" in out["error"]


# ----------------------------------------------------------- new blocks ----

def test_an_appended_shot_lands_on_the_frame_grid(db):
    """`frames` is NOT NULL and must be a legal 17n+5 count from the start
    (invariant #5)."""
    out = dt.execute("add_block", {"action": "she turns back", "duration_ms": 6000}, CTX)
    row = [b for t, b in db["inserts"] if t == "generation_blocks"][0]
    assert (row["frames"] - 5) % 17 == 0
    assert row["idx"] == 2 and row["t_start_ms"] == 16000
    assert out["job_id"], "it renders by default"


def test_an_appended_shot_inherits_the_episodes_model(db):
    """Switching checkpoint mid-episode is the continuity break _block_model
    exists to prevent."""
    db["blocks"][-1]["params"] = {"model_key": "minimax-h3-turbo",
                                  "loras": [{"key": "handheld"}]}
    dt.execute("add_block", {"action": "x"}, CTX)
    row = [b for t, b in db["inserts"] if t == "generation_blocks"][0]
    assert row["params"]["model_key"] == "minimax-h3-turbo"


def test_chaining_to_an_unrendered_block_is_refused_and_explained(db):
    """Pointing at a block with no take makes a job that cannot run — it dies
    at execution asking for a final frame that does not exist."""
    db["blocks"][-1]["active_take_id"] = None
    out = dt.execute("add_block", {"action": "x", "after_block": "b2"}, CTX)
    row = [b for t, b in db["inserts"] if t == "generation_blocks"][0]
    assert row["chain_from_block_id"] is None
    assert out["chained"] is False and "has not rendered" in out["note"]


def test_inserting_in_the_middle_shifts_the_followers_back_to_front(db):
    """(storyboard_id, idx) is unique and not deferrable, so a forward shift
    collides with the row it is about to move."""
    dt.execute("add_block", {"action": "x", "after_block": "b1"}, CTX)
    shifted = [(p, b) for p, b in db["patches"] if "idx" in b]
    assert shifted and all(b["idx"] == 2 for _p, b in shifted)


# ---------------------------------------------------------------- misc ----

def test_a_beat_image_cannot_be_both_an_opener_and_a_look(db):
    """The two keys compile to opposite instructions — "open on this exact
    frame" and "follow this rendering, ignore its framing"."""
    out = dt.execute("set_beat_image", {"beat_id": BEAT, "asset_id": "a1",
                                        "purpose": "start_frame"}, CTX)
    assert "error" not in out, out
    meta = next(b["meta"] for p, b in db["patches"] if p.startswith("beats?"))
    assert meta["start_frame_asset_id"] == "a1" and "still_asset_id" not in meta


def test_proposing_options_queues_nothing_and_names_real_tools(db):
    out = dt.execute("propose_options", {"question": "which coat?", "options": [
        {"label": "Red", "tool": "add_outfit_variant", "args": {}},
        {"label": "Grey", "tool": "add_outfit_variant", "args": {}}]}, CTX)
    assert len(out["choice"]["options"]) == 2
    assert not db["inserts"], "a proposal is not an action"


def test_proposing_an_invented_tool_is_refused(db):
    out = dt.execute("propose_options", {"question": "?", "options": [
        {"label": "a", "tool": "make_it_good", "args": {}},
        {"label": "b", "tool": "add_beat", "args": {}}]}, CTX)
    assert "not a tool" in out["error"]


def test_inspect_take_asks_about_the_blocks_active_take(db):
    out = dt.execute("inspect_take", {"block": "b1",
                                      "question": "is she wearing a hat?"}, CTX)
    p = _jobs(db, "llm_task")[0]["payload"]
    assert p["task"] == "vlm_query" and p["take_id"] == TAKE1
    assert "get_job" in out["note"]


def test_get_job_hands_back_the_answer(db):
    out = dt.execute("get_job", {"job_id": "job1"}, CTX)
    assert out["result"]["answer"] == "yes, a grey hat"


def test_every_editing_tool_is_registered(db):
    """A schema with no branch is a tool the model will call and get "unknown
    tool" from — and the model has no way to tell that from a real failure."""
    for name in ("list_blocks", "get_block", "list_takes", "rerender_block",
                 "rerender_stale", "activate_take", "add_block", "generate_clip",
                 "edit_video", "add_take", "set_block_params", "set_beat_image",
                 "list_voices", "recast_voice",
                 "inspect_take", "get_job", "delete_bible_entry",
                 "propose_options"):
        assert name in dt.TOOL_NAMES, f"{name} has no schema"
        out = dt.execute(name, {}, CTX)
        assert out.get("error") != f"unknown tool {name}", f"{name} has no branch"


# --------------------------------------------------------------- voices ----

def test_list_voices_offers_real_ids_and_filters_by_gender(db):
    """The model has to name a voice that exists — inventing one would write a
    dead id onto the character and the recast would render silently wrong."""
    out = dt.execute("list_voices", {"gender": "f"}, CTX)
    assert out["voices"] and all(v["gender"] == "f" for v in out["voices"])
    assert all(v["voice_id"] and v["reads_as"] for v in out["voices"])


def test_recasting_drops_the_old_recordings_and_the_old_timbre_anchor(db,
                                                                     monkeypatch):
    """An exchange clip is content-hash keyed on the SPEAKER'S VOICE, so every
    pin points at a recording in the voice that was just replaced — and the
    timbre ref was synthesized in it too."""
    import dialogue_synth as DS
    voice = DS.VOICE_TABLE[0][0]
    entry = {"id": "aki", "name": "Aki", "doc": {"el_voice_id": "old"},
             "identity_line": "a woman of 30"}
    beats = [{"id": "bt9", "scene_id": "sc1", "meta": {"xchg": {"asset_id": "x1"}},
              "dialogue": [{"speaker": "Aki", "line": "hi"}]}]

    def fake_get(path):
        if path.startswith("bible_entries?project_id=") and "name=ilike" in path:
            return [entry]
        if path.startswith("bible_entries?project_id="):
            return [entry]
        if path.startswith("episodes?"):
            return [{"id": "ep1"}]
        if path.startswith("storyboards?"):
            return [{"id": SB}]
        if path.startswith("scenes?"):
            return [{"id": "sc1"}]
        if path.startswith("beats?"):
            return beats
        return []

    monkeypatch.setattr(dt.sb, "get", fake_get)
    out = dt.execute("recast_voice", {"character": "Aki", "voice_id": voice}, CTX)
    assert out["voice_id"] == voice and out["voice_name"]
    assert any(b.get("el_voice_id") == voice or
               (b.get("doc") or {}).get("el_voice_id") == voice
               for _p, b in db["patches"]), "the new voice must be stored"
    assert any(b.get("voice_ref_asset_id", "x") is None for _p, b in db["patches"]), \
        "the timbre anchor was synthesized in the old voice — it has to go"
    metas = [b["meta"] for _p, b in db["patches"] if "meta" in b]
    assert metas and all("xchg" not in m for m in metas), \
        "their recorded conversations are keyed to the old voice"
    assert _jobs(db, "tts"), "a fresh timbre reference has to be made"


def test_an_invented_voice_id_is_refused(db, monkeypatch):
    monkeypatch.setattr(dt.sb, "get", lambda p: (
        [{"id": "aki", "name": "Aki", "doc": {}, "identity_line": ""}]
        if p.startswith("bible_entries?") else []))
    out = dt.execute("recast_voice", {"character": "Aki",
                                      "voice_id": "not-a-voice"}, CTX)
    assert "list_voices" in out["error"]


def test_inspect_take_holds_the_gpu_rather_than_loading_beside_a_render(db):
    """`model_id` here is load-bearing, not decoration. worker.py fills the
    cpu/api/llm pool CONCURRENTLY with the gpu lane, and only holds the GPU
    semaphore for an llm job whose model_id starts with "ollama". Without it
    the 18GB judge loads next to an H3 render — which surfaces as an OOM or a
    thrashing box, nowhere near this line."""
    dt.execute("inspect_take", {"block": "b1", "question": "hat?"}, CTX)
    job = _jobs(db, "llm_task")[0]
    assert str(job.get("model_id") or "").startswith("ollama"), \
        "the vision judge must wait for the card, not race a render for it"
    assert job["lane"] == "llm"


def test_a_recast_unpins_the_whole_conversation_not_just_their_lines(db, monkeypatch):
    """One recording covers a run of shots. Clearing only the recast
    character's beats leaves the other half of the conversation pointing into
    a clip that is about to be re-recorded, with its shot still timed to the
    old performance — the same half-invalidated state _invalidate_dialogue
    exists to prevent."""
    entry = {"id": "aki", "name": "Aki", "doc": {"el_voice_id": "old"},
             "identity_line": "a woman of 30"}
    beats = [
        {"id": "bt1", "scene_id": "sc1", "meta": {"xchg": {"asset_id": "run1"}},
         "dialogue": [{"speaker": "Aki", "line": "you came"}]},
        # Haru's line, SAME recording — must be unpinned too.
        {"id": "bt2", "scene_id": "sc1", "meta": {"xchg": {"asset_id": "run1"}},
         "dialogue": [{"speaker": "Haru", "line": "I said I would"}]},
        # A different conversation Aki is not in — must be left alone.
        {"id": "bt3", "scene_id": "sc1", "meta": {"xchg": {"asset_id": "run2"}},
         "dialogue": [{"speaker": "Haru", "line": "later"}]},
    ]
    monkeypatch.setattr(dt.sb, "get", lambda p: (
        [entry] if p.startswith("bible_entries?") else
        [{"id": "ep1"}] if p.startswith("episodes?") else
        [{"id": SB}] if p.startswith("storyboards?") else
        [{"id": "sc1"}] if p.startswith("scenes?") else
        beats if p.startswith("beats?") else []))

    dt.execute("recast_voice", {"character": "Aki", "voice_id":
                                __import__("dialogue_synth").VOICE_TABLE[0][0]}, CTX)
    unpinned = {p.split("id=eq.")[1] for p, b in db["patches"]
                if p.startswith("beats?") and "xchg" not in (b.get("meta") or {})}
    assert "bt1" in unpinned and "bt2" in unpinned, "the whole run must be unpinned"
    assert "bt3" not in unpinned, "an unrelated conversation must be left alone"


# ------------------------------------------------------------ shot cast ----

def test_a_shot_cast_can_be_emptied_so_nobody_is_staged(db):
    """`meta.cast` is what ref_plan_for reads to decide whose sheets condition
    the render. No tool could touch it, so "replace the two of them with giant
    talking plants" rewrote the words and left four human character sheets in
    the reference plan — and H3 follows the pictures over the sentence. Live:
    with the action rewritten AND the scene cast cleared, the recomputed plan
    still staged both characters twice each plus both of their voices."""
    out = dt.execute("update_beat", {"beat_id": BEAT, "cast": []}, CTX)
    assert "error" not in out and "meta" in out["changed"]
    meta = next(b["meta"] for p, b in db["patches"]
                if p.startswith("beats?") and "meta" in b)
    assert meta["cast"] == []


def test_recasting_a_shot_keeps_the_rest_of_its_meta(db):
    """meta also carries start frames, panels and the narrative beat label —
    replacing the whole object would silently drop them."""
    out = dt.execute("update_beat",
                     {"beat_id": BEAT, "cast": ["Aki Minase", "  ", "Haru"]}, CTX)
    assert "error" not in out
    meta = next(b["meta"] for p, b in db["patches"]
                if p.startswith("beats?") and "meta" in b)
    assert meta["cast"] == ["Aki Minase", "Haru"], "blank names are dropped"


# ---------------------------------------------------------------------------
# A MANUALLY ADDED SHOT HAD NOTHING TO STAGE, so it could never render.
#
# `_add_block` created its scene with `cast_ids: []`, no `environment_id` and
# an empty beat `meta`, then declared mode **r2v** — which raises in resolve()
# without at least one reference. `recompute_refs: True` on the queued job
# could not rescue it: `ref_plan_for` reads exactly those three fields, so
# there was nothing to recompute FROM. Every "add a shot where…" produced a
# job that validated, queued, waited for a GPU and died with
# "reference-to-video needs at least one reference".
# ---------------------------------------------------------------------------

def _twins():
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2]
    return ((root / "worker" / "director_tools.py").read_text(),
            (root / "director" / "tools.js").read_text())


def test_a_new_shot_inherits_the_place_and_people_beside_it():
    """A shot added into an episode is in the same location with the same cast
    as the shot next to it — the reasoning `params` already follows."""
    py, js = _twins()
    for src, who in ((py, "worker"), (js, "hosted")):
        assert "environment_id" in src, who
        assert "cast_ids" in src, who
    assert "inherited_cast" in py
    assert "inheritedCast" in js


def test_the_beats_cast_is_written_not_just_the_scenes():
    """`ref_plan_for` reads the BEAT's cast for video blocks; leaving it empty
    stages nobody however the scene is cast."""
    py, js = _twins()
    assert '"cast": cast_names' in py
    assert "cast: castNames" in js


def test_a_mode_the_block_cannot_satisfy_is_never_declared():
    import os
    os.environ.setdefault("SUPABASE_URL", "http://x")
    os.environ.setdefault("SUPABASE_ANON_KEY", "local")
    os.environ.setdefault("SUPABASE_ACCESS_TOKEN", "x")
    from director_tools import _add_block_mode as m
    # r2v needs a reference; with none it must fall back rather than queue a
    # job that dies at execution.
    assert m("r2v", False, False) == "t2v"
    assert m("r2v", False, True) == "i2v"
    assert m("r2v", True, False) == "r2v"
    # i2v/flf need an opening frame, which only a chain supplies here.
    assert m("flf", True, False) == "r2v"
    assert m("flf", True, True) == "flf"
    assert m("i2v", False, False) == "t2v"
    # …and an unspecified mode picks what the block can actually do.
    assert m(None, True, False) == "r2v"
    assert m(None, False, True) == "i2v"
    assert m(None, False, False) == "t2v"


def test_both_twins_guard_the_mode():
    py, js = _twins()
    assert "_add_block_mode" in py
    assert "addBlockMode" in js


def test_inserting_at_the_start_is_expressible():
    """`after_block` was the ONLY positional argument, and `at_idx` reached 0
    solely on an empty storyboard — so "add a block before block 1" had no
    encoding at all. Asked for one, a real director turn sent
    `after_block: b1`, the closest thing it could say, and the new opening
    landed as b2 after the fight had already started."""
    py, js = _twins()
    for src, who in ((py, "worker"), (js, "hosted")):
        assert "before_block" in src, who
    # …and the two are mutually exclusive rather than silently one-wins.
    assert "not both" in py and "not both" in js


def test_before_block_takes_the_targets_own_slot():
    py, js = _twins()
    assert 'at_idx = before["idx"]' in py
    assert "atIdx = before.idx" in js
    # the new block chains from whatever is now IN FRONT of it, which is
    # nothing at position 0.
    assert 'at_idx - 1' in py
    assert "atIdx - 1" in js


# ------------------------------------------------------ new shots, placed --
# The routes an add_block walks once it has a host scene. `db` above answers
# `scenes?` with one scene of one storyboard and `beats?` with one beat; these
# cases want a scene with several shots and a second scene after it.

@pytest.fixture
def placed(db, monkeypatch):
    scenes = [{"id": "sc1", "idx": 0, "slug": "MEMORY_CAPTURE", "storyboard_id": SB,
               "cast_ids": ["ch-rei"], "environment_id": "env-city"},
              {"id": "sc2", "idx": 1, "slug": "AFTER", "storyboard_id": SB,
               "cast_ids": ["ch-rei"], "environment_id": "env-city"}]
    beats = [{"id": "bt0", "idx": 0, "duration_ms": 4000}, {"id": "bt1", "idx": 1, "duration_ms": 4000},
             {"id": "bt2", "idx": 2, "duration_ms": 4000}]
    # BLK0 covers bt0+bt1 of MEMORY_CAPTURE and has rendered; BLK1 covers bt2.
    db["blocks"][0].update({"scene_ids": ["sc1"], "beat_ids": ["bt0", "bt1"]})
    db["blocks"][1].update({"scene_ids": ["sc1"], "beat_ids": ["bt2"]})
    orig_get = dt.sb.get

    def fake_get(path):
        if path.startswith("scenes?storyboard_id="):
            return scenes
        if path.startswith("beats?scene_id=eq.sc1"):
            return beats
        if path.startswith("bible_entries?project_id=") and "name=ilike.Miko" in path:
            return [{"id": "ch-miko", "name": "Miko"}]
        if path.startswith("bible_entries?project_id=") and "name=ilike.Astronaut" in path:
            return [{"id": "ch-rei", "name": "Astronaut Rei"}]
        if path.startswith("bible_entries?id=in."):
            ids = path.split("id=in.(")[1].split(")")[0].split(",")
            names = {"ch-rei": "Astronaut Rei", "ch-miko": "Miko"}
            return [{"name": names.get(i, i)} for i in ids]
        if path.startswith("assets?id=in."):
            ids = path.split("id=in.(")[1].split(")")[0].split(",")
            return [{"id": i, "kind": "image"} for i in ids if i.startswith("as-")]
        if path.startswith("projects?"):
            return [{"settings": {}}]
        return orig_get(path)

    monkeypatch.setattr(dt.sb, "get", fake_get)
    monkeypatch.setattr(dt.sb, "model_catalog", lambda *a, **k: {})
    return db


def test_a_new_shot_joins_the_anchors_scene_as_its_next_shot(placed):
    """A shot added after b1 is the next shot of b1's SCENE, not a "SHOT 2"
    scene of its own appended at the end of the storyboard — which is what
    made the storyboard and the block order disagree."""
    out = dt.execute("add_block", {"action": "the helmet flies to Miko", "after_block": "b1",
                                   "cast": ["Astronaut Rei", "Miko"], "render": False}, CTX)
    assert not [t for t, _ in placed["inserts"] if t == "scenes"], "no new scene"
    beat = [b for t, b in placed["inserts"] if t == "beats"][0]
    assert beat["scene_id"] == "sc1"
    assert beat["idx"] == 2, "right after the anchor's last shot"
    assert ("beats?id=eq.bt2", {"idx": 3}) in placed["patches"], "the later shot moves up"
    assert beat["meta"]["cast"] == ["Astronaut Rei", "Miko"]
    grew = [b for p, b in placed["patches"] if p == "scenes?id=eq.sc1" and "cast_ids" in b]
    assert grew and grew[0]["cast_ids"] == ["ch-rei", "ch-miko"], "the scene's roster grows"
    assert out["placed"] == "into S1 MEMORY_CAPTURE as its shot b3"
    assert out["kind"] == "shot" and out["label"] == "Block 2"
    blk = [b for t, b in placed["inserts"] if t == "generation_blocks"][0]
    assert blk["scene_ids"] == ["sc1"] and blk["idx"] == 1 and blk["mode"] == "r2v"


def test_new_scene_lands_right_after_the_anchors_scene(placed):
    dt.execute("add_block", {"action": "elsewhere", "new_scene": True, "slug": "The Roof",
                             "after_block": "b1", "render": False}, CTX)
    sc = [b for t, b in placed["inserts"] if t == "scenes"][0]
    assert sc["idx"] == 1 and sc["slug"] == "THE ROOF"
    assert ("scenes?id=eq.sc2", {"idx": 2}) in placed["patches"], "S2 becomes S3, back-to-front"


def test_a_new_shot_never_inherits_a_neighbours_clip_born_recipe(placed):
    """`clip_gen` on a block makes handle_master_pass replay it: a shot added
    after an EXTENSION rendered that extension again under its own name."""
    placed["blocks"][-1]["params"] = {
        "model_key": "minimax-h3-pdd", "loras": [{"key": "combat"}],
        "clip_kind": "extend", "clip_gen": {"prompt": "more", "mode": "i2v"},
        "fight": True, "prompt_extra": "note", "derived_from": {"clip_id": "c1"}}
    dt.execute("add_block", {"action": "x", "render": False}, CTX)
    blk = [b for t, b in placed["inserts"] if t == "generation_blocks"][0]
    assert blk["params"] == {"model_key": "minimax-h3-pdd", "loras": [{"key": "combat"}]}


def test_a_new_shot_renders_on_the_projects_default_video_model(placed, monkeypatch):
    """The dock's VIDEO picker is the project default; a shot whose neighbour
    carries no pick renders on it, and the queue files the job under it."""
    orig = dt.sb.get
    monkeypatch.setattr(dt.sb, "get", lambda p: ([{"settings": {"video_model": "h3-pdd-local"}}]
                                                 if p.startswith("projects?") else orig(p)))
    monkeypatch.setattr(dt.sb, "model_catalog", lambda *a, **k: {
        "h3-pdd-local": {"id": "h3-pdd-local", "kind": "video", "provider": "local"}})
    placed["blocks"][-1]["params"] = {}
    out = dt.execute("add_block", {"action": "x"}, CTX)
    blk = [b for t, b in placed["inserts"] if t == "generation_blocks"][0]
    assert blk["params"]["model_key"] == "minimax-h3-pdd"
    assert _jobs(placed, "master_pass")[0]["model_id"] == "h3-pdd-local"
    assert out["renders_on"] == "minimax-h3-pdd"


def test_a_hosted_default_is_not_handed_to_the_pod(placed, monkeypatch):
    orig = dt.sb.get
    monkeypatch.setattr(dt.sb, "get", lambda p: ([{"settings": {"video_model": "h3-api"}}]
                                                 if p.startswith("projects?") else orig(p)))
    monkeypatch.setattr(dt.sb, "model_catalog", lambda *a, **k: {
        "h3-api": {"id": "h3-api", "kind": "video", "provider": "minimax"}})
    placed["blocks"][-1]["params"] = {}
    dt.execute("add_block", {"action": "x", "render": False}, CTX)
    blk = [b for t, b in placed["inserts"] if t == "generation_blocks"][0]
    assert "model_key" not in blk["params"]


def test_a_new_shot_stages_the_pictures_it_is_handed(placed):
    out = dt.execute("add_block", {
        "action": "x", "render": False,
        "ref_asset_ids": ["as-eye", "as-face", "rei-sheet.png"],
        "start_frame_asset_id": "as-open"}, CTX)
    beat = [b for t, b in placed["inserts"] if t == "beats"][0]
    assert beat["meta"]["still_asset_id"] == "as-eye"
    assert beat["meta"]["start_frame_asset_id"] == "as-open"
    blk = [b for t, b in placed["inserts"] if t == "generation_blocks"][0]
    assert [(e["purpose"], e["asset_id"], e["pinned"]) for e in blk["ref_plan"]] == [
        ("start_frame", "as-open", True), ("look", "as-eye", True), ("look", "as-face", True)]
    assert out["refs_not_found"] == ["rei-sheet.png"]


# ------------------------------------------------------ new shots, spoken --
# `add_block` had no `dialogue` argument at all, so "add a shot where Rei says
# X" had two outcomes and both were wrong. The model wrote the line into
# `action` — where it reaches H3 as description rather than through the
# compiler's vocal grammar, so nothing is recorded, nothing is bound to a mouth
# and nothing measures whether it fits — or it followed up with `update_beat`,
# which lands AFTER this tool has already queued the render and only marks the
# block `stale`, a status nothing in the worker reads.
#
# Twin of the same cases in director/addBlockDialogue.test.mjs. The numbers are
# shared on purpose: the floor is computed by storyplan.dialogue_ms here and by
# `dialogueMs` there, and a disagreement means the two directors write
# different-length shots for the same line.

def _spoken(placed):
    return [b for t, b in placed["inserts"] if t == "beats"][0]


def test_a_new_shot_carries_the_line_that_is_spoken_in_it(placed):
    """The line lands on the BEAT, which is what the H3 compiler reads — and
    with its speaker resolved to a bible row, so `dialogue_synth` can cast a
    voice for it rather than guessing from a name."""
    out = dt.execute("add_block", {
        "action": "Rei turns from the ledge.", "cast": ["Astronaut Rei"],
        "render": False,
        "dialogue": [{"speaker": "Astronaut Rei", "line": "We have to go, now.",
                      "delivery": "urgent"}]}, CTX)
    assert _spoken(placed)["dialogue"] == [
        {"speaker_id": "ch-rei", "speaker": "Astronaut Rei",
         "line": "We have to go, now.", "delivery": "urgent"}]
    assert out["dialogue"] == [{"speaker": "Astronaut Rei", "line": "We have to go, now."}]


def test_a_speaker_the_cast_leaves_out_is_staged_anyway(placed):
    """`ref_plan_for` builds the reference set from the cast, so a character
    who speaks and is not cast is drawn from prose as a stranger — the failure
    `cast` itself exists to prevent, arriving through the dialogue instead."""
    out = dt.execute("add_block", {
        "action": "The door opens.", "cast": ["Miko"], "render": False,
        "dialogue": [{"speaker": "Astronaut Rei", "line": "You're late."}]}, CTX)
    assert _spoken(placed)["meta"]["cast"] == ["Miko", "Astronaut Rei"]
    assert out["cast_added"] == ["Astronaut Rei"]
    assert any("added Astronaut Rei" in w for w in out["warnings"])


def test_an_offscreen_line_does_not_stage_its_speaker(placed):
    """That flag means the camera is elsewhere. Staging them would put a body
    on screen the shot says is not there."""
    dt.execute("add_block", {
        "action": "The empty corridor.", "cast": ["Miko"], "render": False,
        "dialogue": [{"speaker": "Astronaut Rei", "line": "Where are you?",
                      "offscreen": True}]}, CTX)
    beat = _spoken(placed)
    assert beat["meta"]["cast"] == ["Miko"], "a voice-over is not in the frame"
    assert beat["dialogue"][0]["offscreen"] is True


def test_the_shot_is_lengthened_to_fit_its_lines(placed):
    """storyplan.shot_floor_ms's rule, which the planner applies to every
    dialogue shot it writes and nothing applied to one added by hand: the 6s
    default takes a twenty-word line and delivers DIALOGUE_CUTOFF. The floor
    RAISES an explicit duration_ms rather than yielding to it."""
    line = " ".join(["word"] * 20)                     # 20/2.0s + 1200ms pad
    out = dt.execute("add_block", {
        "action": "Rei explains.", "cast": ["Astronaut Rei"],
        "duration_ms": 3000, "render": False,
        "dialogue": [{"speaker": "Astronaut Rei", "line": line}]}, CTX)
    assert _spoken(placed)["duration_ms"] == 11200
    blk = [b for t, b in placed["inserts"] if t == "generation_blocks"][0]
    assert blk["t_end_ms"] - blk["t_start_ms"] == 11200, "the block moved with it"
    assert any("lengthened the shot to 11.2s" in w for w in out["warnings"])


def test_lines_too_long_for_any_block_are_reported_not_silently_cut(placed):
    """A block has a ceiling, so past it the line is cut off however long the
    shot is asked to be. Saying so here beats finding it as DIALOGUE_CUTOFF in
    a review two renders later."""
    import h3_timing
    line = " ".join(["word"] * 30)                     # 16.2s of speech
    out = dt.execute("add_block", {
        "action": "Rei explains at length.", "cast": ["Astronaut Rei"],
        "render": False,
        "dialogue": [{"speaker": "Astronaut Rei", "line": line}]}, CTX)
    assert _spoken(placed)["duration_ms"] == h3_timing.MAX_CONTENT_MS
    assert any("cut off" in w and "two shots" in w for w in out["warnings"])


def test_an_unknown_speaker_is_reported_rather_than_dropped(placed):
    """The line is still written — losing it would be worse — but the name is
    named, the way an uncastable `cast` entry is."""
    out = dt.execute("add_block", {
        "action": "Someone shouts.", "cast": ["Miko"], "render": False,
        "dialogue": [{"speaker": "Nobody", "line": "Hey!"}]}, CTX)
    assert _spoken(placed)["dialogue"][0]["speaker_id"] is None
    assert "Nobody" in out["not_in_bible"]


def test_the_render_is_queued_after_the_lines_are_written(placed):
    """The whole reason the argument belongs on THIS tool rather than in a
    follow-up `update_beat`: that call lands after the job is queued, and
    whether it beats the worker to the row is a race."""
    dt.execute("add_block", {
        "action": "Rei turns.", "cast": ["Astronaut Rei"],
        "dialogue": [{"speaker": "Astronaut Rei", "line": "Now."}]}, CTX)
    tables = [t for t, _ in placed["inserts"]]
    assert tables.index("beats") < tables.index("jobs")
    job = [b for t, b in placed["inserts"] if t == "jobs"][0]
    assert job["kind"] == "master_pass"


def test_a_shot_with_no_lines_writes_the_row_it_always_wrote(placed):
    """The dialogue key is written only when there is dialogue, so nothing
    about a shot added without any changed."""
    dt.execute("add_block", {"action": "A wide of the city.", "render": False}, CTX)
    # `id` is the fake insert's own, not part of what add_block writes.
    assert sorted(k for k in _spoken(placed) if k != "id") == [
        "action", "camera", "duration_ms", "idx", "meta", "scene_id"]


def test_a_rerender_stages_attached_pictures_and_forces_a_recompute(placed, monkeypatch):
    orig = dt.sb.get
    monkeypatch.setattr(dt.sb, "get", lambda p: (
        [{"id": "bt0", "meta": {"cast": ["Rei"]}}] if p.startswith("beats?id=eq.bt0")
        else [{"id": "as-eye", "kind": "image"}] if p.startswith("assets?id=in.")
        else orig(p)))
    out = dt.execute("rerender_block", {"block": "b1", "ref_asset_ids": ["as-eye"],
                                        "recompute_refs": False}, CTX)
    beat_patch = [b for p, b in placed["patches"] if p == "beats?id=eq.bt0"][0]
    assert beat_patch["meta"] == {"cast": ["Rei"], "still_asset_id": "as-eye",
                                  "ref_role": "look", "ref_label": "attached picture"}
    plan = [b for p, b in placed["patches"] if p == f"generation_blocks?id=eq.{BLK0}" and "ref_plan" in b][0]
    assert [e["asset_id"] for e in plan["ref_plan"]] == ["as-eye"]
    assert _jobs(placed, "master_pass")[0]["payload"]["recompute_refs"] is True
    assert out["references"] == [{"asset_id": "as-eye", "purpose": "look"}]
    assert out["kind"] == "plan" and out["label"] == "Block 1"


def test_a_rerender_files_the_job_under_the_checkpoint_it_renders_on(placed, monkeypatch):
    placed["blocks"][0]["params"] = {"model_key": "minimax-h3-pdd"}
    monkeypatch.setattr(dt.sb, "model_catalog", lambda *a, **k: {
        "h3-pdd-local": {"id": "h3-pdd-local"}, "h3-local": {"id": "h3-local"}})
    out = dt.execute("rerender_block", {"block": "b1"}, CTX)
    assert _jobs(placed, "master_pass")[0]["model_id"] == "h3-pdd-local"
    assert out["renders_on"] == "minimax-h3-pdd"


def test_list_blocks_names_the_kind_and_quotes_the_first_shot(placed, monkeypatch):
    placed["blocks"][1].update({"beat_ids": [], "params": {
        "clip_kind": "extend", "clip_gen": {"prompt": "the crowd surges", "mode": "i2v"}}})
    orig = dt.sb.get
    monkeypatch.setattr(dt.sb, "get", lambda p: (
        [{"id": "bt0", "action": "  She   turns\n from the window."}] if p.startswith("beats?id=in.")
        else orig(p)))
    out = dt.execute("list_blocks", {}, CTX)
    assert [(b["ref"], b["label"], b["kind"], b.get("first_shot")) for b in out["blocks"]] == [
        ("b1", "Block 1", "plan", "She turns from the window."),
        ("b2", "Extension 2", "extend", "the crowd surges")]


def test_the_block_kind_rule_matches_the_shared_module():
    """director/block_kind.js is what every browser surface reads; this twin
    has to answer the same for the same params."""
    k = dt._block_kind
    assert k({"params": {}}) == "plan"
    assert k({"params": {"clip_kind": "chain"}}) == "chain"
    assert k({"params": {"clip_gen": {"prompt": "x", "mode": "i2v"}}}) == "extend"
    assert k({"params": {"clip_gen": {"prompt": "x", "mode": "flf"}}}) == "chain"
    assert k({"params": {"clip_gen": {"prompt": "x", "mode": "t2v"}}}) == "shot"
    assert k({"params": {"derived_from": {"clip_id": "c"}}}) == "shot"
    assert k({"params": {"derived_from": {"block_id": "b"}}}) == "trim"
    assert dt._kind_label("extend", 18) == "Extension 19"


# ------------------------------------------------ which checkpoint runs ----

def _pick(monkeypatch, video_model, catalog):
    """The project has PICKED a video model, and the catalog knows the row."""
    orig = dt.sb.get
    monkeypatch.setattr(dt.sb, "get",
                        lambda p: ([{"settings": {"video_model": video_model}}]
                                   if p.startswith("projects?") else orig(p)))
    monkeypatch.setattr(dt.sb, "model_catalog", lambda *a, **k: catalog)


def test_the_picker_beats_the_plan(placed, monkeypatch):
    """Reported: PDD selected in the dock, turbo queued, nothing said. The
    block carries turbo from plan time; `settings.video_model` is only ever
    written by somebody moving a picker, so it is the deliberate one."""
    placed["blocks"][0]["params"] = {"model_key": "minimax-h3-turbo"}
    _pick(monkeypatch, "h3-pdd-local",
          {"h3-pdd-local": {"id": "h3-pdd-local", "kind": "video", "provider": "local"},
           "h3-turbo-local": {"id": "h3-turbo-local", "kind": "video", "provider": "local"}})
    out = dt.execute("rerender_block", {"block": "b1"}, CTX)
    job = _jobs(placed, "master_pass")[0]
    assert job["payload"]["model_key"] == "minimax-h3-pdd", \
        "the render has to be TOLD, or the worker reads the block's own key"
    assert job["model_id"] == "h3-pdd-local"
    assert out["renders_on"] == "minimax-h3-pdd"
    assert out["instead_of"] == "minimax-h3-turbo", "the switch is said, not discovered"
    # …and the block's own params are untouched: this is one render's override.
    assert not [b for _p, b in placed["patches"] if "params" in b]


def test_with_nothing_picked_the_blocks_own_choice_still_stands(placed, monkeypatch):
    placed["blocks"][0]["params"] = {"model_key": "minimax-h3-turbo"}
    monkeypatch.setattr(dt.sb, "model_catalog", lambda *a, **k: {})
    out = dt.execute("rerender_block", {"block": "b1"}, CTX)
    assert "model_key" not in _jobs(placed, "master_pass")[0]["payload"]
    assert out["renders_on"] == "minimax-h3-turbo"
    assert "instead_of" not in out


def test_an_explicit_model_key_still_beats_the_picker(placed, monkeypatch):
    placed["blocks"][0]["params"] = {"model_key": "minimax-h3-turbo"}
    _pick(monkeypatch, "h3-pdd-local",
          {"h3-pdd-local": {"id": "h3-pdd-local", "kind": "video", "provider": "local"}})
    out = dt.execute("rerender_block", {"block": "b1", "model_key": "minimax-h3"}, CTX)
    assert out["renders_on"] == "minimax-h3"


def test_a_new_shot_follows_the_picker_not_the_neighbour(placed, monkeypatch):
    placed["blocks"][-1]["params"] = {"model_key": "minimax-h3-turbo",
                                      "loras": [{"key": "combat"}]}
    _pick(monkeypatch, "h3-pdd-local",
          {"h3-pdd-local": {"id": "h3-pdd-local", "kind": "video", "provider": "local"}})
    dt.execute("add_block", {"action": "x", "render": False}, CTX)
    blk = [b for t, b in placed["inserts"] if t == "generation_blocks"][0]
    assert blk["params"]["model_key"] == "minimax-h3-pdd"
    assert blk["params"]["loras"] == [{"key": "combat"}], \
        "the adapters still come from the neighbour — only the checkpoint is picked"

"""Clip-born blocks: the takes system for the timeline's extend/chain renders.

Three mechanisms, each silent when wrong:

  * `_publish_clip_block` turns a clip_gen render into an ordinary
    generation_blocks row + block_takes take — get the row's shape wrong and
    every downstream surface (strip, assembly, retakes, stale marking) reads
    a block that lies about itself.
  * `handle_master_pass` DELEGATES a clip-born block to the recipe path.
    Without it, every retake surface (the modal, rerender_stale, a chained
    re-render) compiles an empty storyboard: the render succeeds and shows a
    shot nobody asked for.
  * `split_relaunch_blocks` is what keeps a re-queued episode from deleting
    user work — launch_render's wholesale DELETE cascades block_takes and
    take_reviews away with nothing on screen to say so.
"""
import pytest

import handlers.blocks as B


# ------------------------------------------------------------- the recipe ---
def test_the_recipe_is_a_whitelist_not_a_spread():
    # target/make_block/label describe THIS job — replaying them would
    # re-create the block or re-attach a clip that has moved on.
    got = B._clip_recipe({"prompt": "p", "mode": "i2v", "seed": 7,
                          "target": {"clip_id": "c"}, "make_block": {},
                          "label": "x", "activate": "replace",
                          "start_asset_id": "f1", "loras": [{"key": "combat"}]})
    assert got == {"prompt": "p", "mode": "i2v", "seed": 7,
                   "start_asset_id": "f1", "loras": [{"key": "combat"}]}


def test_motion_ctx_false_survives_the_recipe():
    # `payload.get(k) is not None` — a plain truthiness test would drop the
    # explicit opt-out and a retake would silently regain motion context.
    assert B._clip_recipe({"prompt": "p", "motion_ctx": False})["motion_ctx"] is False


# ------------------------------------------------------- relaunch survival ---
def _b(i, bid, params=None, status="generated"):
    return {"id": bid, "idx": i, "status": status, "params": params or {}}


def test_planner_blocks_are_dropped_and_derived_ones_kept():
    old = [_b(0, "p0"), _b(1, "d1", {"clip_gen": {"prompt": "x"}}),
           _b(2, "p2"), _b(3, "d3", {"derived_from": {"block_id": "p2"}})]
    drop, parked = B.split_relaunch_blocks(old)
    assert drop == ["p0", "p2"]
    assert dict(parked) == {"d1": 10000, "d3": 10001}


def test_parked_moves_apply_highest_current_idx_first():
    # (storyboard_id, idx) is unique and PostgREST patches a row at a time —
    # the idx_shift rule: never land on a slot another survivor still holds.
    old = [_b(1, "d1", {"clip_gen": {"prompt": "x"}}),
           _b(10001, "d2", {"clip_gen": {"prompt": "y"}})]
    _, parked = B.split_relaunch_blocks(old)
    # d2 (current 10001 -> 10001) is a no-op and skipped; d1 moves to 10000.
    assert parked == [("d1", 10000)]


def test_a_storyboard_of_only_planner_blocks_parks_nothing():
    drop, parked = B.split_relaunch_blocks([_b(0, "p0"), _b(1, "p1")])
    assert drop == ["p0", "p1"] and parked == []


# ---------------------------------------------------- publishing the block ---
@pytest.fixture
def db(monkeypatch):
    anchor = {"id": "src", "storyboard_id": "sb1", "idx": 4,
              "scene_ids": ["s2"], "t_start_ms": 40000, "t_end_ms": 52000}
    existing = {"id": "cb1", "storyboard_id": "sb1", "idx": 5,
                "active_take_id": None,
                "params": {"clip_gen": {"prompt": "she keeps running",
                                        "mode": "i2v", "seed": 3}}}
    rows = {
        "generation_blocks?id=eq.src": [anchor],
        "generation_blocks?id=eq.cb1": [existing],
        "storyboards?id=eq.sb1&select=episode_id": [{"episode_id": "ep1"}],
        "storyboards?episode_id=eq.ep1&select=id&order=created_at.desc&limit=1":
            [{"id": "sb1"}],
        "episodes?id=eq.ep1&select=id,code,project_id":
            [{"id": "ep1", "code": "EP01", "project_id": "p1"}],
        "generation_blocks?storyboard_id=eq.sb1&select=id,idx&order=idx":
            [{"id": "a", "idx": 3}, {"id": "src", "idx": 4}, {"id": "z", "idx": 5}],
    }
    patches, inserts, published = [], [], []
    monkeypatch.setattr(B.sb, "get", lambda path: rows.get(path, []))
    monkeypatch.setattr(B.sb, "patch", lambda path, body, **k: patches.append((path, body)))

    def _insert(table, body):
        inserts.append((table, body))
        return {"id": f"new-{table}", **body}
    monkeypatch.setattr(B.sb, "insert", _insert)

    def fake_publish(jid, block, ep, path, *, name, kind, meta=None,
                     patch_range=None, activate=True, mark_stale=True):
        published.append({"block": block["id"], "ep": ep["id"], "activate": activate,
                          "mark_stale": mark_stale, "kind": kind, "meta": meta})
        return ({"id": "asset-x", "b2_key": f"blocks/{name}.mp4"}, {"id": "take-x"})
    monkeypatch.setattr(B, "_publish_derived_take", fake_publish)
    monkeypatch.setattr(B, "_relabel_block_clips", lambda *a, **k: None)
    return {"rows": rows, "patches": patches, "inserts": inserts,
            "published": published, "existing": existing}


INFO = {"duration_ms": 4180}


def make(db, payload):
    return B._publish_clip_block({"id": "j1", "episode_id": "ep1"},
                                 payload, "/tmp/x.mp4", INFO)


def test_make_block_lands_after_its_anchor_with_the_shift(db):
    make(db, {"prompt": "p", "mode": "i2v", "seed": 9,
              "make_block": {"after_block_id": "src", "chain_from_block_id": "src"}})
    b = next(b for t, b in db["inserts"] if t == "generation_blocks")
    assert b["idx"] == 5
    assert ("generation_blocks?storyboard_id=eq.sb1&idx=eq.5", {"idx": 6}) in db["patches"]
    # Beatless and recipe-bearing: the whole point. master_pass reads
    # params.clip_gen and replays it instead of compiling nothing.
    assert b["beat_ids"] == [] and b["compiled_prompt"] is None
    assert b["params"]["clip_gen"]["prompt"] == "p"
    assert b["scene_ids"] == ["s2"]              # an extension continues its scene
    assert b["chain_from_block_id"] == "src"     # provenance AND stale marking
    assert b["status"] == "generated"
    assert b["t_start_ms"] == 52000 and b["t_end_ms"] == 56180


def test_a_vanished_anchor_appends_to_the_newest_storyboard(db):
    make(db, {"prompt": "p", "make_block": {"after_block_id": "gone"}})
    b = next(b for t, b in db["inserts"] if t == "generation_blocks")
    assert b["idx"] == 6                         # tail: max(3,4,5) + 1
    assert not [p for p, _ in db["patches"] if "&idx=eq." in p]


def test_an_illegal_mode_falls_back_rather_than_failing_the_insert(db):
    make(db, {"prompt": "p", "mode": "v2v", "make_block": {}})
    b = next(b for t, b in db["inserts"] if t == "generation_blocks")
    assert b["mode"] == "t2v"


def test_the_first_take_of_a_retake_target_activates(db):
    # A block whose render died before its first take landed has nothing on
    # the lane — the first take IS the content.
    make(db, {"prompt": "p", "target": {"block_id": "cb1"}})
    assert db["published"][0]["activate"] is True
    assert db["published"][0]["mark_stale"] is False


def test_a_later_retake_lands_pending_beside_the_others(db):
    db["existing"]["active_take_id"] = "t-old"
    make(db, {"prompt": "p", "target": {"block_id": "cb1"}})
    assert db["published"][0]["activate"] is False


def test_activate_replace_makes_the_retake_canonical_and_marks_downstream(db):
    db["existing"]["active_take_id"] = "t-old"
    make(db, {"prompt": "p", "target": {"block_id": "cb1"}, "activate": "replace"})
    assert db["published"][0]["activate"] is True
    assert db["published"][0]["mark_stale"] is True


def test_a_landed_retake_moves_the_block_back_to_generated(db):
    # queueBlockRender set it `queued`; leaving that would read as a render
    # still waiting on a worker that has already delivered.
    make(db, {"prompt": "p", "target": {"block_id": "cb1"}})
    assert ("generation_blocks?id=eq.cb1", {"status": "generated"}) in db["patches"]


# ------------------------------------------------------ master_pass detour ---
def test_master_pass_delegates_a_clip_born_block_to_its_recipe(db, monkeypatch):
    calls = []
    monkeypatch.setattr(B, "handle_clip_gen", lambda job: calls.append(job) or "done")
    # _load_context expects scenes; a clip-born block has none, so the
    # delegation must fire BEFORE it — raising here is how we prove it.
    monkeypatch.setattr(B, "_load_context",
                        lambda block: (_ for _ in ()).throw(AssertionError(
                            "_load_context ran on a clip-born block")))
    B.handle_master_pass({"id": "j2", "payload": {"block_id": "cb1", "seed": 41,
                                                  "activate": "review"}})
    sub = calls[0]["payload"]
    assert sub["target"] == {"block_id": "cb1"}
    assert sub["prompt"] == "she keeps running"
    assert sub["seed"] == 41                     # the caller pinned one
    assert sub["activate"] == "review"
    assert ("generation_blocks?id=eq.cb1", {"status": "generating"}) in db["patches"]


def test_a_delegated_retake_rolls_a_seed_when_none_was_pinned(db, monkeypatch):
    # Replaying the stored seed is the identical picture — the panel-redraw
    # bug in a new costume.
    calls = []
    monkeypatch.setattr(B, "handle_clip_gen", lambda job: calls.append(job))
    B.handle_master_pass({"id": "j3", "payload": {"block_id": "cb1"}})
    assert calls[0]["payload"]["seed"] not in (0, 3, None)


def test_a_failed_delegation_leaves_an_honest_block_status(db, monkeypatch):
    def boom(job):
        raise RuntimeError("comfy fell over")
    monkeypatch.setattr(B, "handle_clip_gen", boom)
    with pytest.raises(RuntimeError):
        B.handle_master_pass({"id": "j4", "payload": {"block_id": "cb1"}})
    # No takes yet -> failed; with a take it would fall back to generated.
    assert ("generation_blocks?id=eq.cb1", {"status": "failed"}) in db["patches"]
    db["patches"].clear()
    db["existing"]["active_take_id"] = "t-old"
    with pytest.raises(RuntimeError):
        B.handle_master_pass({"id": "j5", "payload": {"block_id": "cb1"}})
    assert ("generation_blocks?id=eq.cb1", {"status": "generated"}) in db["patches"]

from h3_timing import MAX_CONTENT_MS, MIN_CONTENT_MS
from planner import plan_blocks


def mk_scene(sid, env, durs):
    return {"id": sid, "environment_id": env,
            "beats": [{"id": f"{sid}-b{i}", "duration_ms": d} for i, d in enumerate(durs)]}


def total(scenes):
    return sum(b["duration_ms"] for s in scenes for b in s["beats"])


def check_invariants(blocks, scenes):
    assert blocks, "no blocks"
    assert blocks[0]["t_start_ms"] == 0
    for a, b in zip(blocks, blocks[1:]):
        assert a["t_end_ms"] == b["t_start_ms"], "gap/overlap between blocks"
    assert blocks[-1]["t_end_ms"] == total(scenes)
    for blk in blocks:
        dur = blk["t_end_ms"] - blk["t_start_ms"]
        assert dur <= MAX_CONTENT_MS, f"block too long: {dur}"
        assert dur >= MIN_CONTENT_MS or len(blocks) == 1, f"block too short: {dur}"


def test_film_env_change_forces_boundary():
    scenes = [mk_scene("s1", "envA", [5000, 5000]),
              mk_scene("s2", "envB", [6000]),
              mk_scene("s3", "envB", [4000])]
    blocks = plan_blocks(scenes, medium="film")
    check_invariants(blocks, scenes)
    # s1 (envA) must not share a block with s2 (envB)
    for b in blocks:
        envs = {"s1": "envA", "s2": "envB", "s3": "envB"}
        assert len({envs[s] for s in b["scene_ids"]}) == 1
    # chaining only within a location: the first envB block must NOT chain
    first_envB = next(b for b in blocks if "s2" in b["scene_ids"])
    assert first_envB["chain"] is False


def test_mv_packs_across_scenes_and_chains():
    scenes = [mk_scene("s1", "envA", [4000, 4000]),
              mk_scene("s2", "envB", [4000, 4000]),
              mk_scene("s3", "envC", [4000, 4000])]
    blocks = plan_blocks(scenes, medium="music_video")
    check_invariants(blocks, scenes)
    assert any(len(b["scene_ids"]) > 1 for b in blocks), "MV should pack across scenes"
    assert all(b["chain"] for b in blocks[1:]), "MV blocks always chain"


def test_mv_beat_snap():
    # 24s of content, beat grid every 2s. Greedy fill would cut at 14s;
    # a snap can only move a cut that isn't already on the grid — build an
    # off-grid beat layout.
    scenes = [mk_scene("s1", "envA", [4500, 4500, 4500, 4500, 6000])]
    grid = list(range(0, 30000, 2000))
    blocks = plan_blocks(scenes, medium="music_video", beats_ms=grid)
    check_invariants(blocks, scenes)
    # every internal boundary either sits on the grid or could not move
    for a in blocks[:-1]:
        on_grid = a["t_end_ms"] in grid
        beat_edges = [4500, 9000, 13500, 18000]
        assert on_grid or a["t_end_ms"] in beat_edges


def test_oversize_beat_is_split():
    scenes = [mk_scene("s1", "envA", [40000])]  # single 40s beat
    blocks = plan_blocks(scenes, medium="film")
    check_invariants(blocks, scenes)
    assert len(blocks) >= 3


def test_short_tail_merges():
    # 15s + 2s tail: the 2s residual must merge back, not stand alone.
    scenes = [mk_scene("s1", "envA", [7500, 7500, 2000])]
    blocks = plan_blocks(scenes, medium="film")
    check_invariants(blocks, scenes)
    assert all(b["t_end_ms"] - b["t_start_ms"] >= MIN_CONTENT_MS for b in blocks)


def mk_talky(sid, env, durs):
    """Every beat speaks — the common shape once a scene is a conversation."""
    return {"id": sid, "environment_id": env, "beats": [
        {"id": f"{sid}-b{i}", "duration_ms": d,
         "dialogue": [{"line": "a spoken line of roughly ten words to fill the shot"}]}
        for i, d in enumerate(durs)]}


def test_packs_long_rather_than_merely_legal():
    # 6 x 4s in one location = 24s. Every partition into blocks of >= 4s is
    # legal, from six one-beat blocks up; long blocks measure ~35% cleaner per
    # second, so the packer must take the fewest: 12s + 12s.
    scenes = [mk_scene("s1", "envA", [4000] * 6)]
    blocks = plan_blocks(scenes, medium="film")
    check_invariants(blocks, scenes)
    assert [b["t_end_ms"] - b["t_start_ms"] for b in blocks] == [12000, 12000]


def test_all_talky_run_still_packs():
    # Every beat carries dialogue, so "never end a block on a talky beat" has
    # no legal partition. It must degrade to a preference, NOT to one block
    # per beat — that fallback would be the shortest blocks possible, which is
    # the case the length measurements indict hardest.
    scenes = [mk_talky("s1", "envA", [4000] * 7)]
    blocks = plan_blocks(scenes, medium="film")
    check_invariants(blocks, scenes)
    assert len(blocks) <= 3, [b["t_end_ms"] - b["t_start_ms"] for b in blocks]


def test_packing_beats_a_left_to_right_greedy():
    # Greedy fills 6+6=12s, then can't fit the third 6s beat, and strands a
    # 4s tail: 12 / 6 / 4. Choosing cuts globally gives 12 / 10 instead — same
    # content, one fewer render, no block under the floor.
    scenes = [mk_scene("s1", "envA", [6000, 6000, 6000, 4000])]
    blocks = plan_blocks(scenes, medium="film")
    check_invariants(blocks, scenes)
    assert len(blocks) == 2
    assert sorted(b["t_end_ms"] - b["t_start_ms"] for b in blocks) == [10000, 12000]


def test_two_minute_mv_shape():
    # ~2min of 4s beats — the stress-test shape. Max content per block is
    # ~14.7s (365f ceiling minus warmup headroom), so three 4s beats pack per
    # block: 128s -> 11 blocks greedy (9 theoretical minimum).
    scenes = [mk_scene(f"s{i}", f"env{i % 3}", [4000, 4000, 4000, 4000]) for i in range(8)]
    blocks = plan_blocks(scenes, medium="music_video")
    check_invariants(blocks, scenes)
    assert 9 <= len(blocks) <= 11
    assert sum(1 for b in blocks if b["chain"]) == len(blocks) - 1


def test_block_flags_hoist_from_the_top_level_of_a_launch_payload():
    """A render-shaping flag put at the top level of a launch_render payload
    must land on the BLOCK. handle_master_pass reads el_dialogue off
    block.params (or its own payload, which carries only block_id/dims), so a
    top-level flag used to reach nothing at all — measured live: a 29-block
    episode queued with el_dialogue=false staged ElevenLabs clips throughout."""
    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "handlers"))
    from blocks import _block_params
    p = _block_params({"el_dialogue": False, "params": {"model_key": "minimax-h3-turbo"}})
    assert p == {"model_key": "minimax-h3-turbo", "el_dialogue": False}
    # an explicit params entry still wins over the top-level shorthand
    assert _block_params({"el_dialogue": False,
                          "params": {"el_dialogue": True}})["el_dialogue"] is True
    # and nothing unrelated is dragged along
    assert "storyboard_id" not in _block_params({"storyboard_id": "x"})


def test_a_dialogue_beat_is_never_long_enough_to_need_splitting():
    """_flatten splits an oversized beat into equal parts that all keep the
    same beat_id — so each resulting BLOCK loads the beat's whole dialogue and
    is told to speak every line in a fraction of the time. Measured on STATIC
    b0: a 15.1s / 19-word beat became two 7.5s blocks that spoke 13% and 9% of
    their lines. Nothing in the planner can divide the lines (they belong to
    the beat, not the span), so the ceiling has to hold upstream — llm.py
    clamps a pinned shot to MAX_CONTENT_MS. This pins the hazard so a future
    change that lifts the clamp fails here instead of on screen."""
    from planner import _flatten
    over = MAX_CONTENT_MS + 1000
    flat = _flatten([{"id": "s1", "environment_id": "e1", "beats": [
        {"id": "b1", "duration_ms": over,
         "dialogue": [{"line": "nineteen words of dialogue that will not fit"}]}]}])
    assert len(flat) > 1                       # it did split…
    assert all(p["split_dialogue"] for p in flat)   # …and every part is flagged
    # A beat at the ceiling stays whole, which is what the clamp guarantees.
    ok = _flatten([{"id": "s1", "environment_id": "e1", "beats": [
        {"id": "b1", "duration_ms": MAX_CONTENT_MS,
         "dialogue": [{"line": "same line"}]}]}])
    assert len(ok) == 1 and not ok[0]["split_dialogue"]

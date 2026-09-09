"""What a RE-RENDER is allowed to change, and what it must not silently keep.

`handle_master_pass` read the model, the LoRA stack and the step count only off
`block.params` — and `_block_params`, which copies those flags off a payload,
was called from `handle_launch_render` alone. So every per-job override was
accepted and dropped: a retake asked to run on a different checkpoint rendered
on the episode's, and said nothing. These pin the merge, and the three payload
switches the director chat depends on.
"""
import pathlib
import re

import handlers.blocks as B

SRC = (pathlib.Path(__file__).resolve().parents[1] / "handlers" / "blocks.py").read_text()
MASTER = SRC.split("def handle_master_pass(")[1].split("\ndef ")[0]


def test_the_loras_flag_is_copyable_off_a_payload():
    """It was missing from _BLOCK_FLAGS while `model_key` was present, so a
    re-render could change the checkpoint and silently keep the adapters the
    previous one was rendered with."""
    assert "loras" in B._BLOCK_FLAGS
    assert "model_key" in B._BLOCK_FLAGS


def test_a_payload_override_beats_the_blocks_stored_pick():
    payload = {"model_key": "minimax-h3-turbo", "loras": [{"key": "handheld"}]}
    block = {"params": {"model_key": "minimax-h3", "loras": [{"key": "grain"}]}}
    params = {**block["params"], **B._block_params(payload)}
    assert B._block_model(block, params) == "minimax-h3-turbo"
    assert B._block_loras(block, params) == [{"key": "handheld"}]


def test_the_stored_pick_still_stands_when_the_payload_is_silent():
    """An ordinary render must be untouched by all of this."""
    block = {"params": {"model_key": "minimax-h3-hybrid", "loras": [{"key": "handheld"}]}}
    params = {**block["params"], **B._block_params({})}
    assert B._block_model(block, params) == "minimax-h3-hybrid"
    assert B._block_loras(block, params) == [{"key": "handheld"}]


def test_a_block_with_no_pick_falls_back_to_the_default_model():
    assert B._block_model({}, {}) == B.H3_MODEL
    assert B._block_loras({}, {}) is None


def test_nested_params_win_over_a_top_level_flag():
    """`_block_params` only lifts a flag the caller did NOT nest — an explicit
    params block is the more specific statement."""
    out = B._block_params({"params": {"model_key": "a"}, "model_key": "b"})
    assert out["model_key"] == "a"


def test_master_pass_resolves_on_the_merged_params():
    """The two calls that decide what actually renders.

    Both must be handed the MERGED `params`, not the block's stored dict —
    that is what makes a per-job override reach resolve(). `_block_loras` also
    takes the model now (it needs the entry to check that a fight block's
    combat adapter is actually declared), so the assertion is on the leading
    arguments rather than on an exact call string.
    """
    assert "_block_model(block, params)" in MASTER
    assert "_block_loras(block, params" in MASTER
    # …and never on the stored dict alone, which is the bug this pins.
    assert "_block_loras(block)" not in MASTER


def test_a_directors_note_is_no_longer_gated_on_take_of():
    """It used to apply only to side-by-side retakes, so a content re-render
    that replaces the active take — the path the chat uses most — accepted the
    note and dropped it."""
    seg = MASTER.split("Retake creative note")[1][:600]
    assert 'params.get("prompt_extra")' in seg
    assert 'if extra and payload.get("take_of")' not in seg


def test_replace_activates_the_new_take_and_stales_the_chain():
    """Before `activate`, a `take_of` render could never activate itself, so an
    edit made from the chat rendered and then sat invisible."""
    seg = MASTER.split('activate = payload.get("activate")')[1][:800]
    assert 'activate == "replace"' in seg
    assert "_mark_downstream_stale(block)" in seg


def test_recompute_refs_writes_the_new_plan_back_to_the_row():
    """Otherwise the ref panel keeps showing the plan the render did not use."""
    # Bounded by the STRUCTURE, not a character count: a fixed [:700] slice
    # silently stopped covering the sb.patch the moment the block grew a
    # comment, which reads as "the recompute stopped persisting".
    seg = MASTER.split('payload.get("recompute_refs")')[1].split("content_ms =")[0]
    assert "ref_plan_for(" in seg
    assert re.search(r'sb\.patch\(.*ref_plan.*fresh', seg, re.S), \
        "the recomputed plan must be persisted"


def test_recompute_refs_raises_rather_than_rendering_the_old_sheets():
    """A quiet fallback here would render the previous costume and leave one
    journal line to explain it — the silent downgrade this codebase keeps
    getting bitten by."""
    seg = MASTER.split('payload.get("recompute_refs")')[1]
    assert "except" not in seg.split("content_ms =")[0], \
        "the recompute must not swallow its own failure"


def test_launch_render_persists_the_episode_resolution_on_the_block():
    """`handle_master_pass` reads `params.width`/`params.height` as its second
    fallback and for its whole life nothing wrote them, so `dims` reached only
    the master_pass jobs launch_render itself queued. Every other path — the
    director chat's rerender_block/rerender_stale, a retake from the prompt
    modal — fell through to the 1280x720 default. Measured on Rei EP03, planned
    at 864x480: a plain re-render came back 1280x720.
    """
    import ast
    import os
    src = open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "handlers", "blocks.py")).read()
    fn = next(n for n in ast.walk(ast.parse(src))
              if isinstance(n, ast.FunctionDef) and n.name == "handle_launch_render")
    body = ast.get_source_segment(src, fn)
    assert '_bp.setdefault("width"' in body and '_bp.setdefault("height"' in body, \
        "launch_render must copy payload.dims onto generation_blocks.params"
    # The insert builds its params FROM that dict. It is no longer a bare
    # `dict(_bp)` because each block also gets a `fight` stamp derived from its
    # own scenes, so the assertion is that _bp is what the per-block copy is
    # made from and that the copy is what gets inserted.
    assert "_p = dict(_bp)" in body, "the per-block params must start from that dict"
    assert '"params": _p' in body, "the block insert must use the per-block copy"


def test_a_block_with_no_recorded_size_falls_back_to_its_own_last_take():
    """Blocks planned before the above have no `params.width`, so the honest
    fallback is what the block LAST rendered at — a re-render that silently
    changes resolution is not a re-render of the same block. The 1280x720
    constant survives only for a block that has never rendered."""
    import ast
    import os
    src = open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "handlers", "blocks.py")).read()
    fn = next(n for n in ast.walk(ast.parse(src))
              if isinstance(n, ast.FunctionDef) and n.name == "handle_master_pass")
    body = ast.get_source_segment(src, fn)
    assert "block_takes?block_id=eq." in body and "assets(width,height)" in body
    assert "order=created_at.desc&limit=1" in body

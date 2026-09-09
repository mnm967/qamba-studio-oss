"""Landing a `clip_gen` render on the timeline clip that held its place.

The timeline's generate actions (extend a block, chain two, add one after)
place a clip on the lane the instant you press the button, pointing at the
extracted start frame so the edit is visible while the GPU works. Nothing ever
repointed it: the render landed in the library and the lane kept the still
for good — a picture where the shot should be, and a preview stuck on
"buffering…", since a <video> can never finish loading a JPEG.

Every failure here is silent by construction — a clip that was not repointed
looks exactly like one whose render has not finished yet — so the attach is
pinned rather than eyeballed.
"""
import pytest

import handlers.blocks as B


@pytest.fixture
def db(monkeypatch):
    """A one-clip timeline, with every write recorded rather than sent."""
    rows = {
        "clips?id=eq.c1&select=id,track_id,duration_ms,label":
            [{"id": "c1", "track_id": "t1", "duration_ms": 4000, "label": "Extended Block"}],
        "tracks?id=eq.t1&select=timeline_id": [{"id": "t1", "timeline_id": "tl1"}],
    }
    writes = []
    monkeypatch.setattr(B.sb, "get", lambda path: rows.get(path, []))
    monkeypatch.setattr(B.sb, "patch", lambda path, body, **k: writes.append((path, body)))
    return writes


def attach(db, *, target=None, ms=4180):
    B._attach_to_clip(target if target is not None else {"clip_id": "c1"},
                      {"id": "new-asset"}, {"duration_ms": ms})
    return dict(db)


def test_the_clip_is_repointed_at_the_render(db):
    w = attach(db)
    assert w["clips?id=eq.c1"]["asset_id"] == "new-asset"


def test_the_whole_render_is_used(db):
    # in/out are the placeholder's, and the placeholder was a still: `out_ms`
    # left at the frame's null would trim the take to nothing.
    w = attach(db)["clips?id=eq.c1"]
    assert (w["in_ms"], w["out_ms"]) == (0, 4180)


def test_a_render_that_overshoots_keeps_the_slot_it_was_given(db):
    # Every frame grid rounds UP, so this is the normal case: 4180ms of media
    # in a 4000ms slot. Growing the clip would overlap whatever is next on the
    # lane; the extra frames simply sit past `duration_ms`.
    assert "duration_ms" not in attach(db, ms=4180)["clips?id=eq.c1"]


def test_a_short_render_shrinks_the_clip_rather_than_playing_black(db):
    # A clip longer than its own media is the stall this whole function exists
    # to end — the preview sits on "buffering…" for the overhang.
    assert attach(db, ms=3200)["clips?id=eq.c1"]["duration_ms"] == 3200


def test_the_flattened_master_is_marked_stale(db):
    # It was rendered against the placeholder still.
    assert attach(db)["timelines?id=eq.tl1"] == {"render_stale": True}


def test_a_clip_deleted_while_the_gpu_worked_is_survivable(db):
    # The render is a registered library asset either way; failing the job
    # here would throw away several GPU-minutes over a clip nobody wants.
    B._attach_to_clip({"clip_id": "gone"}, {"id": "new-asset"}, {"duration_ms": 4000})
    assert db == []


def test_a_job_with_no_clip_target_touches_no_clip(db):
    # Every clip_gen the composer queues comes through here.
    assert attach(db, target={}) == {}


def test_a_stale_flag_that_cannot_be_written_does_not_fail_the_render(db, monkeypatch):
    # Best effort, deliberately: a repointed lane plus a missing flag beats a
    # failed job whose render already succeeded and is already on the clip.
    def boom(path):
        if path.startswith("tracks"):
            raise RuntimeError("postgrest is having a moment")
        return [{"id": "c1", "track_id": "t1", "duration_ms": 4000, "label": "x"}]
    monkeypatch.setattr(B.sb, "get", boom)
    assert attach(db)["clips?id=eq.c1"]["asset_id"] == "new-asset"


def test_a_render_landing_on_a_clip_clears_its_take_pin(db):
    # `clips.take_id` pins one copy of a block to one of its takes — how a
    # block on the cut twice shows two takes. A render targeted at that clip
    # hands it media that is NOT that take, so a pin left behind is a clip the
    # browser's next `syncBlocksToTimeline` repoints straight back to the
    # pinned take, silently undoing the render that just landed. There is
    # nothing in the output to see: the render succeeded, the library has it,
    # and the lane goes back to the old shot minutes later.
    assert attach(db)["clips?id=eq.c1"]["take_id"] is None


def test_a_caller_repointing_the_BLOCK_still_decides_the_rest(db):
    # `extra` is applied last on purpose, so `block_from_clip` — which moves
    # the clip to a different block entirely — is not fighting a default set
    # for a different caller.
    w = attach(db, target={"clip_id": "c1"})
    B._attach_to_clip({"clip_id": "c1"}, {"id": "a2"}, {"duration_ms": 1000},
                      extra={"block_id": "other", "take_id": "keep-me"})
    assert dict(db)["clips?id=eq.c1"]["take_id"] == "keep-me"
    assert w  # the first attach still ran


# ── claiming the clip BEFORE the take exists ────────────────────────────────
#
# REPORTED: "when a chain or extension is finished rendering and put into
# timeline, instead of just replacing the placeholder it creates duplicates."
#
# `_publish_clip_block` inserts the block and activates its take, and only at
# the very end of the job does `_attach_to_clip` write `block_id` onto the
# placeholder. In between the block is a kept take with no clip, which is
# exactly what `syncBlocksToTimeline`'s insert branch is for — so the browser
# lays a SECOND clip of the block on the cut and the render arrives beside its
# placeholder instead of replacing it.
#
# The window is not a millisecond: `_relabel_block_clips` sits in it, one
# sequential round trip per renumbered block, and every one of those writes is
# a realtime event waking the query that triggers the sync. Measured on the
# live data — all four duplicated chain/extension blocks were inserted with 33+
# blocks after them, against an average of 30 for the ones that came out clean.

def test_the_placeholder_is_claimed_for_the_block(db):
    B._claim_clip_for_block("c1", "blk-1")
    assert dict(db)["clips?id=eq.c1"] == {"block_id": "blk-1"}


def test_a_job_with_no_placeholder_claims_nothing(db):
    # `clip_gen` from the composer targets no clip at all.
    B._claim_clip_for_block(None, "blk-1")
    assert db == []


def test_a_failed_claim_never_fails_a_finished_render(db, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("network")
    monkeypatch.setattr(B.sb, "patch", boom)
    B._claim_clip_for_block("c1", "blk-1")   # the render is already spent


def test_THE_CLAIM_HAPPENS_BEFORE_THE_TAKE_IS_PUBLISHED():
    """Order is the fix. Claimed after, the window it closes is still open."""
    import ast
    import inspect
    src = inspect.getsource(B._publish_clip_block).lstrip()
    lines = src.split("\n")
    # THE make_block BRANCH ONLY. The retake branch above it publishes a take
    # too and returns before any of this — compared against that one, a
    # correctly ordered function reads as broken. (Found exactly that way.)
    start = next(i for i, ln in enumerate(lines, 1)
                 if 'payload.get("make_block")' in ln)
    # SORTED BY LINE: `ast.walk` is breadth-first and its order says nothing
    # about the source, so read straight it also answers at random.
    calls = [n.func.id for n in sorted(
        (n for n in ast.walk(ast.parse(src))
         if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
         and n.lineno > start
         and n.func.id in ("_claim_clip_for_block", "_publish_derived_take")),
        key=lambda n: (n.lineno, n.col_offset))]
    assert "_claim_clip_for_block" in calls, (
        "the placeholder is no longer claimed up front — a landing chain will "
        "get a second clip on the cut before _attach_to_clip repoints it")
    assert calls.index("_claim_clip_for_block") < calls.index("_publish_derived_take"), (
        "the claim moved below the take — the block is briefly a kept take "
        "with no clip again, which is what the browser inserts one for")

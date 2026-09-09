"""Save as new block: a timeline trim promoted to a `generation_blocks` row.

Three things here are silent when wrong, which is why they are pinned rather
than eyeballed:

  * the BEAT WINDOW. `handle_master_pass` compiles from `beat_ids` and
    `h3_prompt` stamps `[Shot N] At HH:MM:SS.mmm` from their durations, so a
    derived block carrying the source's whole list has timestamps past the end
    of its own render — and nothing notices until a retake comes back with
    shots that never play.
  * the IDX SHIFT. `generation_blocks` is `unique (storyboard_id, idx)` and
    PostgREST patches a row at a time; front-to-back the first write collides
    with the row it is about to move, and the insert then fails with the
    storyboard half renumbered.
  * the AUDIO SLICE. A locked-audio block's slice is a window of the episode's
    master track. Copied unchanged onto a trimmed block it cuts the right
    NUMBER of seconds out of the wrong PART of the song.
"""
import pytest

import handlers.blocks as B


# ------------------------------------------------------------ beat window ---
BEATS = {"b1": {"duration_ms": 3000}, "b2": {"duration_ms": 3000},
         "b3": {"duration_ms": 3000}, "b4": {"duration_ms": 3000}}
IDS = ["b1", "b2", "b3", "b4"]


def test_an_untrimmed_window_keeps_every_beat():
    assert B.beats_in_window(IDS, BEATS, 0, 12000) == IDS


def test_a_tail_trim_drops_the_shots_it_cut_off():
    assert B.beats_in_window(IDS, BEATS, 0, 6000) == ["b1", "b2"]


def test_a_head_trim_drops_the_shots_before_it():
    assert B.beats_in_window(IDS, BEATS, 6000, 12000) == ["b3", "b4"]


def test_a_shot_the_trim_cuts_in_half_is_kept():
    # It is still a shot the block plays. Dropping it would leave the compiler
    # with nothing to say about that time.
    assert B.beats_in_window(IDS, BEATS, 2000, 4000) == ["b1", "b2"]


def test_a_window_that_lands_between_beats_still_gets_one():
    # An empty beat list compiles to an empty prompt — a block that cannot
    # describe itself is worse than one that describes itself approximately.
    assert B.beats_in_window(IDS, {}, 500, 900) == ["b1"]


def test_a_block_with_no_beats_stays_empty():
    assert B.beats_in_window([], BEATS, 0, 5000) == []


# -------------------------------------------------------------- idx shift ---
def test_the_slot_after_the_source_is_opened():
    assert B.idx_shift([0, 1, 2, 3], 1) == [(3, 4), (2, 3)]


def test_the_shift_runs_highest_first():
    # The unique constraint is not deferrable and PostgREST writes a row at a
    # time: front to back, the first patch collides with the row after it.
    moves = B.idx_shift(range(6), 0)
    assert [f for f, _ in moves] == [5, 4, 3, 2, 1]


def test_the_last_block_needs_no_renumbering():
    assert B.idx_shift([0, 1, 2], 2) == []


def test_a_gappy_storyboard_shifts_only_what_is_above():
    assert B.idx_shift([0, 4, 9], 4) == [(9, 10)]


# ------------------------------------------------------------ audio slice ---
def test_a_locked_slice_moves_with_the_trim():
    got = B._shift_audio_slice(
        {"asset_id": "track", "offset_ms": 30000, "duration_ms": 12000}, 4000, 9000)
    assert got == {"asset_id": "track", "offset_ms": 34000, "duration_ms": 5000}


def test_a_native_audio_block_has_no_slice_to_move():
    assert B._shift_audio_slice(None, 4000, 9000) is None


# ------------------------------------------------------ the derived block ---
@pytest.fixture
def db(monkeypatch):
    """Every read stubbed, every write recorded rather than sent."""
    src = {"id": "src", "storyboard_id": "sb1", "idx": 2, "scene_ids": ["s1", "s2"],
           "beat_ids": IDS, "t_start_ms": 24000, "t_end_ms": 36000, "frames": 293,
           "trim": {"warmup_f": 22, "cooldown_f": 0, "out_ms": 12000}, "mode": "r2v",
           "compiled_prompt": {"description": "the whole block", "fmt_version": 12},
           "ref_plan": [{"slot": 1}], "audio_mode": "native", "audio_slice": None,
           "chain_from_block_id": "prev", "params": {"model_key": "minimax-h3-turbo"},
           "seed": 42}
    rows = {
        "generation_blocks?id=eq.src": [src],
        "storyboards?id=eq.sb1&select=episode_id": [{"episode_id": "ep1"}],
        "episodes?id=eq.ep1&select=id,code,project_id":
            [{"id": "ep1", "code": "EP01", "project_id": "p1"}],
        "generation_blocks?storyboard_id=eq.sb1&select=id,idx&order=idx":
            [{"id": "a", "idx": 0}, {"id": "b", "idx": 1}, {"id": "src", "idx": 2},
             {"id": "d", "idx": 3}],
        "beats?id=in.(b1,b2,b3,b4)":
            [{"id": i, "scene_id": "s1" if i in ("b1", "b2") else "s2",
              "duration_ms": 3000} for i in IDS],
        "clips?id=eq.c1&select=id,track_id,duration_ms,label":
            [{"id": "c1", "track_id": "t1", "duration_ms": 5000, "label": "Block 3"}],
        "clips?id=eq.c1&select=track_id": [{"track_id": "t1"}],
        # No detached audio by default — the ordinary block clip.
        "clips?id=eq.c1&select=linked_clip_id": [{"linked_clip_id": None}],
        "tracks?id=eq.t1&select=timeline_id": [{"timeline_id": "tl1"}],
        "tracks?timeline_id=eq.tl1&kind=eq.video&select=id": [{"id": "t1"}],
        # The source block's other picture clips, if any. Empty by default:
        # one block, one clip, which is the ordinary case.
        "clips?block_id=eq.src&track_id=in.(t1)&select=id": [],
        # The relabel reads each clip before replacing its label, so a name a
        # PERSON wrote can be left alone.
        "clips?block_id=eq.d&select=id,label": [{"id": "cd", "label": "Block 4"}],
        "clips?id=eq.c1&select=label": [{"id": "c1", "label": "Block 3"}],
        "generation_blocks?id=in.(a,b,src,d)&select=id,params": [
            {"id": "a", "params": {}}, {"id": "b", "params": {}},
            {"id": "src", "params": {}}, {"id": "d", "params": {}}],
        "timelines?id=eq.tl1&select=id,excluded_block_ids":
            [{"id": "tl1", "excluded_block_ids": []}],
    }
    ff, patches, inserts = [], [], []
    monkeypatch.setattr(B.sb, "get", lambda path: rows.get(path, []))
    monkeypatch.setattr(B.sb, "patch", lambda path, body, **k: patches.append((path, body)))
    monkeypatch.setattr(B.sb, "job_progress", lambda *a, **k: None)
    monkeypatch.setattr(B.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(B.sb, "cancel_requested", lambda jid: False)
    monkeypatch.setattr(B.sb, "asset_by_id",
                        lambda aid: {"id": aid, "b2_key": "blocks/EP01/002/master.mp4"})
    monkeypatch.setattr(B.sb, "register_asset",
                        lambda key, kind, **k: {"id": f"asset:{kind}", "b2_key": key})
    monkeypatch.setattr(B.media, "b2_get", lambda key, dest, **k: None)
    monkeypatch.setattr(B.media, "b2_put", lambda local, key, **k: None)
    monkeypatch.setattr(B.media, "has_audio", lambda p: True)
    monkeypatch.setattr(B.media, "extract_frame", lambda *a, **k: None)
    monkeypatch.setattr(B.media, "probe",
                        lambda p: {"width": 1280, "height": 704, "fps": 24,
                                   "bytes": 10, "duration_ms": 5000, "has_audio": True})
    monkeypatch.setattr(B.media, "run_ff", lambda args, label="", **k: ff.append(args))
    monkeypatch.setattr(B.os, "remove", lambda p: None)

    def _insert(table, body):
        inserts.append((table, body))
        return {"id": f"new-{table}", **body}
    monkeypatch.setattr(B.sb, "insert", _insert)
    return {"ff": ff, "patches": patches, "inserts": inserts, "src": src, "rows": rows}


def run(db, *, in_ms=4000, out_ms=9000, clip_id="c1"):
    B.handle_block_from_clip({"id": "job1", "payload": {
        "block_id": "src", "asset_id": "a1", "clip_id": clip_id,
        "in_ms": in_ms, "out_ms": out_ms}})
    return db


def new_block(db):
    return next(b for t, b in db["inserts"] if t == "generation_blocks")


def test_the_window_is_cut_with_trim_filters_not_a_stream_copy(db):
    # `-ss` + `-c copy` snaps to the nearest keyframe — the trim being wrong by
    # up to a second, silently. `trim`/`atrim` take input-timeline seconds.
    fc = run(db)["ff"][0][run(db)["ff"][0].index("-filter_complex") + 1]
    assert "trim=start=4.000:end=9.000" in fc
    assert "atrim=start=4.000:end=9.000" in fc


def test_a_silent_take_produces_a_video_only_block(db, monkeypatch):
    monkeypatch.setattr(B.media, "has_audio", lambda p: False)
    args = run(db)["ff"][0]
    assert "-an" in args and "atrim" not in args[args.index("-filter_complex") + 1]


def test_the_new_block_lands_straight_after_the_source(db):
    assert new_block(run(db))["idx"] == 3


def test_every_block_above_is_renumbered_first(db):
    # Highest first, and BEFORE the insert — the slot has to be free.
    moves = [(p, b) for p, b in run(db)["patches"] if "&idx=eq." in p]
    assert moves == [("generation_blocks?storyboard_id=eq.sb1&idx=eq.3", {"idx": 4})]


def test_the_block_carries_only_the_beats_the_window_covers(db):
    # Beats are 3s each; the window is [4000, 9000), so b1 ends before it and
    # b4 starts at its cut.
    assert new_block(run(db))["beat_ids"] == ["b2", "b3"]


def test_scenes_follow_the_beats_that_survived(db):
    # b1/b2 are in s1 and b3 in s2, so both scenes stay. A window inside one
    # scene must not claim the other's cast and location.
    assert new_block(run(db, in_ms=0, out_ms=5000))["scene_ids"] == ["s1"]


def test_the_block_sits_where_the_window_does_on_the_plan_clock(db):
    b = new_block(run(db))
    assert (b["t_start_ms"], b["t_end_ms"]) == (28000, 33000)


def test_the_compiled_prompt_is_not_copied(db):
    # The source's is stamped with ITS timestamps over ITS whole length.
    # `master_pass` compiles from the beats; null is the honest "not yet".
    assert new_block(run(db))["compiled_prompt"] is None


def test_the_frame_count_is_not_inherited(db):
    # `frames` and `trim` describe a render. This block was cut, not rendered.
    b = new_block(run(db))
    assert b["frames"] == 0 and b["trim"] == {}


def test_the_derived_block_is_not_chained(db):
    # A chain anchor is the previous block's FINAL frame, and a window that
    # opens mid-block does not open on it.
    assert new_block(run(db))["chain_from_block_id"] is None


def test_the_source_window_is_recorded_on_the_block(db):
    assert new_block(run(db))["params"]["derived_from"] == {
        "block_id": "src", "in_ms": 4000, "out_ms": 9000}


def test_the_render_settings_are_inherited(db):
    # A retake of the derived block should look like the block it came from.
    assert new_block(run(db))["params"]["model_key"] == "minimax-h3-turbo"


def test_the_cut_becomes_the_new_block_s_active_take(db):
    got = dict(run(db)["patches"])
    assert got["generation_blocks?id=eq.new-generation_blocks"]["active_take_id"]


def test_inserting_a_block_does_not_stale_the_rest_of_the_episode(db):
    # `_mark_downstream_stale` marks every chained block above this idx —
    # and nothing chains from a block that did not exist a moment ago.
    assert not [p for p, _ in run(db)["patches"] if "idx=gt." in p]


def test_the_lane_clip_repoints_at_the_new_block(db):
    patch = dict(run(db)["patches"])["clips?id=eq.c1"]
    assert patch["block_id"] == "new-generation_blocks"
    assert patch["asset_id"] == "asset:video"
    assert patch["in_ms"] == 0


def test_the_clip_is_renamed_for_its_new_block(db):
    assert dict(run(db)["patches"])["clips?id=eq.c1"]["label"] == "Block 4"


def test_the_renumbered_blocks_clips_are_renamed_too(db):
    # `syncBlocksToTimeline` writes the label once, on the insert, and never
    # again — so a renumber that stopped at the block table leaves every clip
    # after it naming the block below itself. Patched per CLIP now, so a
    # written label can be seen before it is replaced.
    assert dict(run(db)["patches"])["clips?id=eq.cd"] == {"label": "Block 5"}


def test_a_renumber_never_overwrites_a_label_somebody_wrote(db):
    # The bug this fixes: seven unrelated blocks renumbered and a chain the
    # user had named came back as "Block 9".
    db["rows"]["clips?block_id=eq.d&select=id,label"] = [
        {"id": "cd", "label": "Chain: How the reference pi"}]
    assert "clips?id=eq.cd" not in dict(run(db)["patches"])


def test_the_source_block_is_taken_out_of_this_cut(db):
    # Its clip has just been repointed, so it has a kept take and no clip —
    # which `syncBlocksToTimeline` reads as "just rendered, missing from the
    # lane" and would answer by dropping a full-length copy back on.
    assert dict(run(db)["patches"])["timelines?id=eq.tl1"]["excluded_block_ids"] == ["src"]


def test_a_block_split_into_pieces_stays_in_the_cut(db, monkeypatch):
    # `splitAt` copies `block_id` onto both halves, so one block routinely owns
    # several clips — 51 of them on live data. Saving ONE piece as a new block
    # leaves the others playing the source, and excluding it there is a flag
    # the next sync immediately undoes, about a block plainly still in the cut.
    inner = B.sb.get
    monkeypatch.setattr(B.sb, "get", lambda path: (
        [{"id": "c9"}] if path.startswith("clips?block_id=eq.src") else inner(path)))
    # The timeline row IS still patched — `_attach_to_clip` marks the flattened
    # master stale, which is right either way. What must not appear is the
    # exclusion.
    writes = [b for p, b in run(db)["patches"] if p == "timelines?id=eq.tl1"]
    assert writes == [{"render_stale": True}]


def test_a_window_shorter_than_a_shot_is_refused(db):
    with pytest.raises(ValueError, match="too short"):
        run(db, in_ms=4000, out_ms=4100)


# ------------------------------------------------------- the detached pair ---
def test_a_detached_audio_half_moves_onto_the_new_take_too(db, monkeypatch):
    # A pair is two clips over ONE window of one file, and LINK_KEYS mirrors
    # their geometry on every edit. Repointing only the picture leaves the
    # sound on the old asset at the old offset: identical content, so nothing
    # looks wrong — until the first trim mirrors the picture's geometry onto a
    # clip whose media starts somewhere else, and the pair drifts by exactly
    # the head trim.
    inner = B.sb.get
    monkeypatch.setattr(B.sb, "get", lambda path: (
        [{"linked_clip_id": "aud1"}] if path.endswith("select=linked_clip_id") else inner(path)))
    patch = dict(run(db)["patches"])["clips?id=eq.aud1"]
    assert patch["asset_id"] == "asset:video"
    assert (patch["in_ms"], patch["out_ms"]) == (0, 5000)
    assert patch["block_id"] == "new-generation_blocks"
    assert patch["label"] == "Block 4 · audio"


def test_a_clip_with_no_detached_audio_touches_no_second_clip(db):
    assert not [p for p, _ in run(db)["patches"] if p.startswith("clips?id=eq.aud")]


# ------------------------------------------------------------- promotion ----
# `block_id: null` promotes a BLOCKLESS clip — a landed extend/chain from
# before those made blocks of their own, or imported media — into the
# storyboard, which is what puts it in front of the takes strip, assembly and
# retakes at all. Placement is the nearest lane neighbour, else the tail of
# the episode's newest storyboard.
@pytest.fixture
def promo(monkeypatch):
    anchor = {"id": "anchor", "storyboard_id": "sb1", "idx": 1,
              "scene_ids": ["s9"], "t_start_ms": 12000, "t_end_ms": 20000}
    rows = {
        "generation_blocks?id=eq.anchor": [anchor],
        "storyboards?id=eq.sb1&select=episode_id": [{"episode_id": "ep1"}],
        "storyboards?episode_id=eq.ep1&select=id&order=created_at.desc&limit=1":
            [{"id": "sb1"}],
        "episodes?id=eq.ep1&select=id,code,project_id":
            [{"id": "ep1", "code": "EP01", "project_id": "p1"}],
        "generation_blocks?storyboard_id=eq.sb1&select=id,idx&order=idx":
            [{"id": "a", "idx": 0}, {"id": "anchor", "idx": 1}, {"id": "d", "idx": 2}],
        "clips?id=eq.c1&select=id,track_id,duration_ms,label":
            [{"id": "c1", "track_id": "t1", "duration_ms": 4000, "label": "Ext: rooftop"}],
        "clips?id=eq.c1&select=track_id": [{"track_id": "t1"}],
        "clips?id=eq.c1&select=linked_clip_id": [{"linked_clip_id": None}],
        "clips?id=eq.c1&select=label": [{"label": "Ext: rooftop"}],
        "tracks?id=eq.t1&select=timeline_id": [{"timeline_id": "tl1"}],
        "generation_blocks?id=in.(a,anchor,d)&select=id,params": [
            {"id": "a", "params": {}}, {"id": "anchor", "params": {}},
            {"id": "d", "params": {}}],
    }
    ff, patches, inserts = [], [], []
    asset = {"id": "a1", "b2_key": "library/gen/j9.mp4", "duration_ms": 4000,
             "meta": {"clip_gen": {"prompt": "she keeps running", "mode": "i2v",
                                   "model_key": "minimax-h3-turbo",
                                   "loras": [{"key": "combat", "strength": 1}],
                                   "seed": 7}}}
    monkeypatch.setattr(B.sb, "get", lambda path: rows.get(path, []))
    monkeypatch.setattr(B.sb, "patch", lambda path, body, **k: patches.append((path, body)))
    monkeypatch.setattr(B.sb, "job_progress", lambda *a, **k: None)
    monkeypatch.setattr(B.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(B.sb, "cancel_requested", lambda jid: False)
    monkeypatch.setattr(B.sb, "asset_by_id", lambda aid: dict(asset))
    monkeypatch.setattr(B.sb, "register_asset",
                        lambda key, kind, **k: {"id": f"asset:{kind}", "b2_key": key})
    monkeypatch.setattr(B.media, "b2_get", lambda key, dest, **k: None)
    monkeypatch.setattr(B.media, "b2_put", lambda local, key, **k: None)
    monkeypatch.setattr(B.media, "has_audio", lambda p: True)
    monkeypatch.setattr(B.media, "extract_frame", lambda *a, **k: None)
    monkeypatch.setattr(B.media, "probe",
                        lambda p: {"width": 1280, "height": 704, "fps": 24,
                                   "bytes": 10, "duration_ms": 2500, "has_audio": True})
    monkeypatch.setattr(B.media, "run_ff", lambda args, label="", **k: ff.append(args))
    monkeypatch.setattr(B.os, "remove", lambda p: None)

    def _insert(table, body):
        inserts.append((table, body))
        return {"id": f"new-{table}", **body}
    monkeypatch.setattr(B.sb, "insert", _insert)
    return {"ff": ff, "patches": patches, "inserts": inserts,
            "rows": rows, "asset": asset}


def promote(promo, *, in_ms=0, out_ms=4000, after="anchor", episode="ep1"):
    B.handle_block_from_clip({"id": "job9", "episode_id": episode, "payload": {
        "block_id": None, "after_block_id": after, "asset_id": "a1",
        "clip_id": "c1", "in_ms": in_ms, "out_ms": out_ms}})
    return promo


def test_a_promoted_clip_lands_after_its_lane_neighbour(promo):
    promote(promo)
    assert new_block(promo)["idx"] == 2
    # …and the block that held idx 2 was shifted out of the way first.
    assert ("generation_blocks?storyboard_id=eq.sb1&idx=eq.2", {"idx": 3}) \
        in promo["patches"]


def test_a_whole_window_promotion_adopts_the_asset_without_a_cut(promo):
    # Re-encoding the whole file would register a byte-similar second copy of
    # media already in the library; the take points at what the clip plays.
    promote(promo)
    assert promo["ff"] == []
    take = next(b for t, b in promo["inserts"] if t == "block_takes")
    assert take["asset_id"] == "a1" and take["state"] == "kept"


def test_a_trimmed_promotion_still_cuts_its_window(promo):
    promote(promo, in_ms=500, out_ms=3000)
    fc = promo["ff"][0][promo["ff"][0].index("-filter_complex") + 1]
    assert "trim=start=0.500:end=3.000" in fc


def test_the_recipe_travels_only_with_the_whole_render(promo):
    # params.clip_gen is what makes the block RETAKEABLE (master_pass replays
    # it) — and a retake replays the whole recipe, so a trimmed window must
    # not claim it: takes of one block should agree in length.
    promote(promo)
    p = new_block(promo)["params"]
    assert p["clip_gen"]["prompt"] == "she keeps running"
    assert p["model_key"] == "minimax-h3-turbo"     # lifted for the LoRA seeding
    assert p["loras"] == [{"key": "combat", "strength": 1}]


def test_a_trimmed_promotion_carries_no_recipe(promo):
    promote(promo, in_ms=500, out_ms=3000)
    assert "clip_gen" not in new_block(promo)["params"]


def test_promotion_records_the_clip_it_came_from(promo):
    promote(promo)
    assert new_block(promo)["params"]["derived_from"] == {
        "clip_id": "c1", "asset_id": "a1", "in_ms": 0, "out_ms": 4000}


def test_a_promoted_block_has_no_beats_and_its_anchor_s_scenes(promo):
    b = new_block(promote(promo))
    assert b["beat_ids"] == [] and b["scene_ids"] == ["s9"]


def test_promotion_with_no_neighbour_appends_to_the_newest_storyboard(promo):
    promote(promo, after=None)
    b = new_block(promo)
    assert b["idx"] == 3          # tail: max(0,1,2) + 1
    # …and nothing was renumbered to make room.
    assert not [p for p, _ in promo["patches"] if "&idx=eq." in p]


def test_promotion_with_no_storyboard_raises_a_sentence(promo, monkeypatch):
    promo["rows"]["storyboards?episode_id=eq.ep1&select=id&order=created_at.desc&limit=1"] = []
    with pytest.raises(ValueError, match="no storyboard"):
        promote(promo, after=None)


def test_a_whole_window_promotion_relinks_the_clip_without_touching_geometry(promo):
    # `whole` means the clip already plays exactly this window — rewriting
    # in/out would be writing back what is there, and a wrong write here is
    # the trim-erasure bug wearing a new costume. The NAME is kept too: this
    # clip is called "Ext: rooftop" because a person called it that.
    promote(promo)
    patch = dict(promo["patches"])["clips?id=eq.c1"]
    assert patch == {"block_id": "new-generation_blocks", "label": "Ext: rooftop"}


def test_a_promotion_is_named_for_the_ACTION_that_made_it(promo):
    # The recipe says i2v, so this is an Extension — not "Block 3".
    promo["rows"]["clips?id=eq.c1&select=label"] = [{"label": "Block 3"}]
    promote(promo)
    assert dict(promo["patches"])["clips?id=eq.c1"]["label"] == "Extension 3"
    assert new_block(promo)["params"]["clip_kind"] == "extend"


def test_a_chain_is_promoted_as_a_chain(promo):
    promo["asset"]["meta"]["clip_gen"]["mode"] = "flf"
    promo["rows"]["clips?id=eq.c1&select=label"] = [{"label": "Block 3"}]
    promote(promo)
    assert new_block(promo)["params"]["clip_kind"] == "chain"
    assert dict(promo["patches"])["clips?id=eq.c1"]["label"] == "Chain 3"


def test_a_recipeless_clip_recovers_one_from_the_job_that_made_it(promo):
    # Every extend and chain rendered BEFORE the recipe was stamped has none —
    # and those are exactly the clips someone wants to promote. Without this
    # the promotion produces a block that can never be retaken.
    promo["asset"]["meta"] = {}
    promo["asset"]["source_job_id"] = "j-old"
    promo["rows"]["jobs?id=eq.j-old&select=kind,payload"] = [
        {"kind": "clip_gen", "payload": {"prompt": "the bridge", "mode": "flf",
                                         "model_key": "minimax-h3",
                                         "start_asset_id": "f1", "end_asset_id": "f2",
                                         "target": {"clip_id": "c1"}}}]
    promote(promo)
    p = new_block(promo)["params"]
    assert p["clip_kind"] == "chain"
    assert p["clip_gen"]["start_asset_id"] == "f1"      # the anchors survive
    assert "target" not in p["clip_gen"]                 # …but not the transport


def test_a_clip_with_no_job_behind_it_is_still_promotable(promo):
    # Imported media has no recipe anywhere. It becomes a block with takes —
    # it simply cannot be re-rendered, which the retake modal says.
    promo["asset"]["meta"] = {}
    promo["asset"]["source_job_id"] = None
    promote(promo)
    p = new_block(promo)["params"]
    assert "clip_gen" not in p and p["clip_kind"] == "shot"


def test_the_new_block_is_excluded_from_the_episode_s_other_cuts(promo):
    # `syncBlocksToTimeline` lays any block with a kept take and no clip onto
    # whichever cut is open, at the block's planned window — which for a
    # derived block overlaps its neighbour's by construction.
    promo["rows"]["timelines?id=eq.tl1&select=episode_id"] = [{"episode_id": "ep1"}]
    promo["rows"]["timelines?episode_id=eq.ep1&id=neq.tl1&select=id,excluded_block_ids"] = [
        {"id": "tl2", "excluded_block_ids": ["other"]}]
    promote(promo)
    assert dict(promo["patches"])["timelines?id=eq.tl2"] == {
        "excluded_block_ids": ["other", "new-generation_blocks"]}


# ---------------------------------------------------------------------------
# PLACEMENT IS THE USER'S CHOICE at the moment of saving, because neither
# answer is free: inserting keeps story order and renumbers every follower
# (which is what made a save look like it had duplicated a shot — a clip's
# label is a stored snapshot of `idx`, so every follower's went stale at
# once), while appending leaves them alone and costs story order.

def _run_append(db, **kw):
    B.handle_block_from_clip({"id": "job1", "payload": {
        "block_id": "src", "asset_id": "a1", "clip_id": "c1",
        "in_ms": 4000, "out_ms": 9000, "append": True, **kw}})
    return db


def test_append_puts_the_block_at_the_end_and_shifts_nobody(db):
    _run_append(db)
    # src is idx 2 of a,b,src,d — inserting would have made it 3 and pushed d
    # to 4. Appending takes the next free index instead.
    assert new_block(db)["idx"] == 4
    idx_patches = [p for p in db["patches"] if "idx" in (p[1] or {})]
    assert idx_patches == [], f"appending must renumber nothing, got {idx_patches}"


def test_the_default_still_inserts_after_its_anchor(db):
    # Byte-for-byte the behaviour every existing caller gets: `append` absent
    # is not `append: false` by accident, it is the documented default.
    run(db)
    assert new_block(db)["idx"] == 3
    assert [p for p in db["patches"] if "idx" in (p[1] or {})], \
        "inserting must shift the followers"


def test_appending_still_inherits_the_sources_plan(db):
    # Placement ONLY. The source block lends its beats, scenes and params
    # either way — an appended block is the same shot in a different slot.
    _run_append(db)
    b = new_block(db)
    assert b["storyboard_id"] == "sb1"
    assert b.get("params", {}).get("derived_from", {}).get("block_id") == "src"
    assert b["beat_ids"] == ["b2", "b3"], "the window's beats come across either way"

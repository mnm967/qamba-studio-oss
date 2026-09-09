"""A retake's brief has to change the SHOT, not decorate the prompt.

The bug: the brief landed in `params.prompt_extra` and `handle_master_pass`
appended it to the already-composed description as "Director's adjustment for
this take:", compiling everything else from the same unchanged beats. So a
brief asking for different blocking, a different camera or different DIALOGUE
came back as the same shot with a sentence stapled on — and dialogue could not
change at all, because the lines are recorded at plan time and staged as
reference audio bound "precisely lip-synced to <Audio N>".

`revise_beats` is the deterministic half of the fix: the model rewrites the
STRUCTURED beats (invariant #6 intact) and the compiler builds the envelope
from them. Everything checked here is a way for that to go quietly wrong.
"""
import storyplan as SP


def beat(bid, **kw):
    base = {"id": bid, "action": "She walks to the gate", "camera": "medium, push in slowly",
            "duration_ms": 6000, "dialogue": [], "meta": {}, "sfx": None}
    return {**base, **kw}


def patch_of(patches, bid):
    return dict(patches).get(bid)


# ── the change actually lands ───────────────────────────────────────────────

def test_a_rewritten_line_replaces_the_old_one():
    beats = [beat("b1", dialogue=[{"speaker": "Rei", "line": "You're late."}])]
    patches, warns = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [{"speaker": "Rei", "line": "You came back."}]}]},
        6000)
    assert patch_of(patches, "b1")["dialogue"] == [{"speaker": "Rei", "line": "You came back."}]
    assert not warns


def test_camera_and_action_are_rewritten_not_appended():
    # The whole point: the old behaviour left the original prose intact and
    # added a note, which is why the render never changed.
    beats = [beat("b1")]
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "action": "She stops dead at the gate",
                           "camera": "close-up, static"}]}, 6000)
    p = patch_of(patches, "b1")
    assert p["action"] == "She stops dead at the gate"
    assert p["camera"] == "close-up, static"


def test_an_unchanged_field_produces_no_patch():
    beats = [beat("b1")]
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "action": "She walks to the gate"}]}, 6000)
    assert patches == []


def test_emptying_dialogue_makes_the_shot_silent():
    beats = [beat("b1", dialogue=[{"speaker": "Rei", "line": "You're late."}])]
    patches, _ = SP.revise_beats(beats, {"shots": [{"n": 1, "dialogue": []}]}, 6000)
    assert patch_of(patches, "b1")["dialogue"] == []


def test_cast_lands_on_meta_because_that_is_what_stages_the_sheets():
    # Rewriting the action alone leaves their reference pictures in, and the
    # render follows the pictures.
    beats = [beat("b1", meta={"cast": ["Rei", "Haru"]})]
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "cast": ["Rei"]}]}, 6000)
    assert patch_of(patches, "b1")["meta"]["cast"] == ["Rei"]


def test_meta_keys_the_reviser_does_not_own_survive():
    beats = [beat("b1", meta={"cast": ["Rei"], "panel_asset_id": "p1", "beat": {"idx": 2}})]
    patches, _ = SP.revise_beats(beats, {"shots": [{"n": 1, "cast": []}]}, 6000)
    meta = patch_of(patches, "b1")["meta"]
    assert meta["panel_asset_id"] == "p1" and meta["beat"] == {"idx": 2}


# ── the ways a model gets it wrong ──────────────────────────────────────────

def test_an_empty_action_is_ignored_rather_than_erasing_the_shot():
    beats = [beat("b1")]
    patches, warns = SP.revise_beats(beats, {"shots": [{"n": 1, "action": "  "}]}, 6000)
    assert patches == []
    assert any("empty action" in w for w in warns)


def test_a_shot_number_outside_the_block_is_dropped_and_reported():
    beats = [beat("b1")]
    patches, warns = SP.revise_beats(
        beats, {"shots": [{"n": 4, "action": "something else"}]}, 6000)
    assert patches == []
    assert any("not in this block" in w for w in warns)


def test_a_missing_shot_number_is_dropped():
    patches, warns = SP.revise_beats([beat("b1")], {"shots": [{"action": "x"}]}, 6000)
    assert patches == []
    assert any("no shot number" in w for w in warns)


def test_a_line_with_no_speaker_keeps_the_one_it_replaces():
    # A model that rewrites the words and forgets the attribution must not
    # silently reassign the line — an unattributed line compiles to nobody.
    beats = [beat("b1", dialogue=[{"speaker": "Rei", "line": "You're late."}])]
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [{"line": "You came back."}]}]}, 6000)
    assert patch_of(patches, "b1")["dialogue"][0]["speaker"] == "Rei"


def test_a_new_line_with_no_speaker_at_all_is_dropped():
    beats = [beat("b1")]
    patches, warns = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [{"line": "Who said this?"}]}]}, 6000)
    assert patches == []
    assert any("no speaker" in w for w in warns)


def test_garbage_in_the_shots_list_does_not_raise():
    patches, _ = SP.revise_beats([beat("b1")], {"shots": ["nope", None, 7]}, 6000)
    assert patches == []
    assert SP.revise_beats([beat("b1")], {}, 6000) == ([], [])


# ── durations stay the block's ──────────────────────────────────────────────

def test_a_longer_line_takes_time_from_its_neighbour_not_from_the_block():
    # The beats of a block must keep summing to the block's own window: the
    # compiler stamps [Shot N] timestamps from them and the render is exactly
    # that long. A longer line grows its shot out of the neighbours' slack.
    beats = [beat("b1", duration_ms=4000), beat("b2", duration_ms=8000)]
    line = " ".join(["word"] * 10)          # 10 words -> 5s + 1.2s pad = 6.2s floor
    patches, warns = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [{"speaker": "Rei", "line": line}]}]},
        12000)
    d = dict(patches)
    total = sum(d.get(b["id"], {}).get("duration_ms", b["duration_ms"]) for b in beats)
    assert total == 12000, f"the block's window must be preserved, got {total}"
    assert d["b1"]["duration_ms"] >= 6200, "the speaking shot has to clear its floor"
    assert not warns


def test_the_window_is_exact_not_merely_close():
    # fit_shot_durations rounds each shot to 250ms, so its total lands NEAR the
    # target. A 12.0s block whose beats sum to 12.75s stamps [Shot N]
    # timestamps 750ms past the end of the render — which was the first thing
    # this test found.
    for target in (7000, 9750, 11333, 13400):
        beats = [beat("b1", duration_ms=3000), beat("b2", duration_ms=3000),
                 beat("b3", duration_ms=3000)]
        patches, _ = SP.revise_beats(
            beats, {"shots": [{"n": 2, "action": "He turns away"}]}, target)
        d = dict(patches)
        total = sum(d.get(b["id"], {}).get("duration_ms", b["duration_ms"]) for b in beats)
        assert total == target, f"{target} -> {total}"


def test_when_the_lines_cannot_fit_the_durations_are_left_honest():
    # Floors are not negotiable, so the sum is allowed to exceed the window —
    # what must not happen is a line squeezed under its speaking time to make
    # the arithmetic look right. The warning is the deliverable here.
    beats = [beat("b1", duration_ms=4000), beat("b2", duration_ms=8000)]
    line = " ".join(["word"] * 20)          # 11.2s floor, beside a 1.5s minimum
    patches, warns = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [{"speaker": "Rei", "line": line}]}]},
        12000)
    d = dict(patches)
    total = sum(d.get(b["id"], {}).get("duration_ms", b["duration_ms"]) for b in beats)
    assert total > 12000
    assert d["b1"]["duration_ms"] >= 11200, "never below speaking time"
    assert any("cut off" in w for w in warns)


def test_the_reviser_cannot_set_a_duration_itself():
    # LLM arithmetic is unreliable and the window is not negotiable.
    beats = [beat("b1", duration_ms=6000)]
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "duration_ms": 999999, "action": "She turns"}]}, 6000)
    assert patch_of(patches, "b1").get("duration_ms") in (None, 6000)


def test_lines_that_cannot_fit_the_block_are_reported_before_the_render():
    # This is DIALOGUE_CUTOFF, predicted instead of discovered in the take.
    beats = [beat("b1", duration_ms=4000)]
    huge = " ".join(["word"] * 60)          # ~30s of speaking in a 4s block
    _, warns = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [{"speaker": "Rei", "line": huge}]}]}, 4000)
    assert any("cut off" in w for w in warns), warns


def test_no_block_window_means_no_duration_rewrite():
    beats = [beat("b1", duration_ms=6000)]
    patches, _ = SP.revise_beats(beats, {"shots": [{"n": 1, "action": "She turns"}]}, 0)
    assert "duration_ms" not in patch_of(patches, "b1")


# ── the shot numbers must mean what the compiler means ──────────────────────

def _src(name):
    import pathlib as _p
    root = _p.Path(__file__).resolve().parents[1]
    text = (root / name).read_text()
    return text


def test_the_reviser_orders_beats_the_way_the_compiler_does():
    """`revise_block` numbers the shots it shows the model, and the compiler
    numbers `[Shot N]` independently. If the two sorts disagree the revision
    lands cleanly on the WRONG shot — nothing errors, the take just changes
    something nobody asked about.

    `_load_context` sorts by (scene idx, beat idx); the `beat_ids` ARRAY order
    is a different thing and a block may span two scenes of one location
    (only an environment cut splits a block), so they can genuinely differ.
    """
    blocks = _src("handlers/blocks.py")
    assert 'beats.sort(key=lambda b: (scene_order.get(b["scene_id"], 0), b["idx"]))' in blocks, \
        "the compiler's sort moved — revise_block's has to move with it"
    revise = _src("llm.py").split("def revise_block(")[1].split("\ndef ")[0]
    assert 'key=lambda b: (scene_idx.get(b["scene_id"], 0), b.get("idx", 0))' in revise


def test_the_reviser_never_sets_a_duration_from_the_model():
    """The contract must not invite one: the block's window is fixed and its
    frame count already planned."""
    assert "duration_ms" not in SP.REVISE_CONTRACT.split("Rules:")[0].split("Return JSON")[1]


def test_the_contract_forbids_writing_the_compiled_format():
    # Invariant #6: the model produces structured beats, never the envelope.
    low = SP.REVISE_CONTRACT.lower()
    assert "never write the compiled prompt format" in low
    assert "[shot n]" in low and "<subject n>" in low


# ── merging shots away ──────────────────────────────────────────────────────
#
# "one continuous shot, no cuts" was UNSAYABLE. The reviser could rewrite each
# shot and never merge two, so a three-shot block asked for a oner came back as
# three shots whose prose each described one continuous move — measured on Rei
# EP04 b45, twice: both runs reported changing exactly one beat, and the
# compiled envelope still cut at 00:08.655 and 00:10.155. The only fix was to
# open the scene editor and delete beats by hand.
#
# The block's WINDOW is fixed and its SUBDIVISION is not, which is what makes
# this safe: the survivors absorb the dropped shots' time, so the block, its
# scene and every block after it stay the length they were.

def three_shots():
    return [beat("b1", duration_ms=7738), beat("b2", duration_ms=1500),
            beat("b3", duration_ms=1500)]


def test_dropping_shots_names_their_beats():
    ids, warns = SP.dropped_beats(three_shots(), {"drop_shots": [2, 3]})
    assert ids == ["b2", "b3"]
    assert not warns


def test_the_survivors_absorb_the_whole_block_window():
    beats = three_shots()
    ids, _ = SP.dropped_beats(beats, {"drop_shots": [2, 3]})
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "action": "One unbroken move through the door"}]},
        10738, dropped=ids)
    # The block is a slot in the episode's timeline: it is exactly as long
    # after the merge as before it.
    assert patch_of(patches, "b1")["duration_ms"] == 10738
    # …and a dropped beat is never patched, because it is about to not exist.
    assert patch_of(patches, "b2") is None and patch_of(patches, "b3") is None


def test_dropping_every_shot_is_refused():
    # `compile_block` raises on a block with no beats, and a scene can be left
    # with none at all. Which shot survives is a directing decision, so this
    # refuses the whole drop rather than keeping an arbitrary one.
    ids, warns = SP.dropped_beats(three_shots(), {"drop_shots": [1, 2, 3]})
    assert ids == []
    assert any("must keep at least one" in w for w in warns)


def test_a_dropped_line_that_survives_nowhere_is_reported():
    # The lines are recorded at plan time, so a line dropped here is a
    # recording nothing will ever place. Not refused — a note may well mean
    # "cut that" — but never silent.
    beats = [beat("b1"), beat("b2", dialogue=[{"speaker": "Rei", "line": "You came back."}])]
    _, warns = SP.dropped_beats(beats, {"drop_shots": [2]})
    assert any("you came back" in w.lower() for w in warns)


def test_a_line_moved_into_a_surviving_shot_is_not_reported_lost():
    beats = [beat("b1"), beat("b2", dialogue=[{"speaker": "Rei", "line": "You came back."}])]
    _, warns = SP.dropped_beats(beats, {
        "shots": [{"n": 1, "dialogue": [{"speaker": "Rei", "line": "You came back."}]}],
        "drop_shots": [2]})
    assert not warns


def test_a_shot_both_revised_and_dropped_says_so():
    # Legitimate on the model's part — it may rewrite shot 2 before deciding
    # to merge it away — but the rewrite has nowhere to land.
    beats = three_shots()
    patches, warns = SP.revise_beats(
        beats, {"shots": [{"n": 2, "action": "never rendered"}]}, 10738, dropped=["b2"])
    assert patch_of(patches, "b2") is None
    assert any("both revised and dropped" in w for w in warns)


def test_an_out_of_range_drop_is_reported_not_applied():
    ids, warns = SP.dropped_beats(three_shots(), {"drop_shots": [9]})
    assert ids == []
    assert any("not in this block" in w for w in warns)


def test_garbage_in_drop_shots_does_not_raise():
    ids, warns = SP.dropped_beats(three_shots(), {"drop_shots": ["two", None, {}]})
    assert ids == []
    assert len(warns) == 3


def test_dropping_the_shot_that_opens_the_block_is_flagged():
    # `ref_plan_for` reads the opening frame off the block's FIRST beat, so
    # dropping the shot that carries one silently changes what the segment
    # opens on — and on an i2v or flf block it is fatal at render time,
    # several minutes in.
    beats = three_shots()
    beats[0]["meta"] = {"start_frame_asset_id": "a1"}
    _, warns = SP.dropped_beats(beats, {"drop_shots": [1]})
    assert any("opening frame" in w for w in warns)


def test_a_revision_with_no_drops_is_unchanged():
    beats = three_shots()
    rev = {"shots": [{"n": 1, "action": "She stops dead at the gate"}]}
    assert SP.dropped_beats(beats, rev) == ([], [])
    assert SP.revise_beats(beats, rev, 10738) == SP.revise_beats(beats, rev, 10738, dropped=[])


# ── the contract, and the two halves that must ship together ────────────────

def test_the_contract_documents_dropping_and_forbids_adding():
    low = SP.REVISE_CONTRACT.lower()
    assert "drop_shots" in low
    assert "cannot add shots" in low


def test_the_contract_explains_the_picture_list():
    assert "staged_references" in SP.REVISE_CONTRACT


def test_revise_block_sends_the_picture_list_and_applies_the_drops():
    """Both halves are easy to add on one side only, and both fail silently: a
    contract documenting `staged_references` while the request omits it teaches
    the model about a key it never sees, and a `drop_shots` honoured in the
    arithmetic that nobody deletes leaves the block rendering the same cuts."""
    revise = _src("llm.py").split("def revise_block(")[1].split("\ndef ")[0]
    assert '"staged_references": staged' in revise
    assert "SP.dropped_beats(beats, revision)" in revise
    assert "dropped=drop_ids" in revise
    assert "_drop_block_beats(block, beats, drop_ids)" in revise


def test_dropping_beats_keeps_every_reader_of_them_in_step():
    """The four writes. Any one missing is a silent inconsistency rather than
    an error: a `beat_ids` entry pointing at a deleted row, a panel staged for
    a shot that no longer exists, or an idx hole that makes "b3" resolve to
    nothing (`director_tools._resolve_beat` addresses a beat by its idx)."""
    fn = _src("llm.py").split("def _drop_block_beats(")[1].split("\ndef ")[0]
    assert 'sb.delete(f"beats?id=eq.' in fn
    assert '"beat_ids"' in fn
    assert '"ref_plan"' in fn
    assert "order=idx" in fn


# ── the deletion itself, against a recording stub ───────────────────────────

def test_dropping_beats_writes_all_four_things(monkeypatch):
    """Run it. The source-parse test above says the four writes are PRESENT;
    this says they are correct — the block keeps only its surviving beat ids,
    the panel staged for a dropped shot is gone, the pictures are re-slotted
    (`<Picture N>` is positional), and the scene's beat indexes close up so
    "b2" still resolves to the second shot."""
    import llm

    calls = {"deleted": [], "patched": []}

    class FakeSB:
        @staticmethod
        def delete(path):
            calls["deleted"].append(path)

        @staticmethod
        def patch(path, body):
            calls["patched"].append((path, body))

        @staticmethod
        def get(path):
            # the scene's survivors, in idx order, after the deletes
            return [{"id": "b1", "idx": 0}, {"id": "b3", "idx": 2}]

    monkeypatch.setattr(llm, "sb", FakeSB)

    block = {
        "id": "blk", "beat_ids": ["b1", "b2", "b3"],
        "ref_plan": [
            {"slot": 1, "purpose": "character", "label": "Guide Rei", "asset_id": "c1"},
            {"slot": 2, "purpose": "scene_ref", "label": "panel — shot 2",
             "beat_id": "b2", "asset_id": "p2"},
            {"slot": 3, "purpose": "environment", "asset_id": "e1"},
            {"purpose": "voice", "name": "Guide Rei", "asset_id": "v1"},
        ],
    }
    beats = [{"id": "b1", "scene_id": "s1"}, {"id": "b2", "scene_id": "s1"},
             {"id": "b3", "scene_id": "s1"}]

    llm._drop_block_beats(block, beats, ["b2"])

    assert calls["deleted"] == ["beats?id=eq.b2"]
    blk = next(b for p, b in calls["patched"] if p == "generation_blocks?id=eq.blk")
    assert blk["beat_ids"] == ["b1", "b3"]
    # the panel bound to the dropped shot is gone…
    assert [e.get("asset_id") for e in blk["ref_plan"]] == ["c1", "e1", "v1"]
    # …and the pictures are re-slotted, while the audio keeps numbering
    # independently (official §2.5) and so carries no slot at all.
    assert [e.get("slot") for e in blk["ref_plan"]] == [1, 2, None]
    # the hole in the scene's beat indexes is closed
    assert ("beats?id=eq.b3", {"idx": 1}) in calls["patched"]


def test_a_drop_that_touches_no_panel_leaves_the_ref_plan_alone(monkeypatch):
    """`ref_plan` is only rewritten when something in it actually pointed at a
    dropped beat — a needless rewrite would re-slot a plan the modal curated."""
    import llm

    patched = []
    monkeypatch.setattr(llm, "sb", type("S", (), {
        "delete": staticmethod(lambda p: None),
        "patch": staticmethod(lambda p, b: patched.append((p, b))),
        "get": staticmethod(lambda p: []),
    }))
    block = {"id": "blk", "beat_ids": ["b1", "b2"],
             "ref_plan": [{"slot": 1, "purpose": "character", "asset_id": "c1"}]}
    llm._drop_block_beats(block, [{"id": "b1", "scene_id": "s1"},
                                  {"id": "b2", "scene_id": "s1"}], ["b2"])
    blk = next(b for p, b in patched if p == "generation_blocks?id=eq.blk")
    assert "ref_plan" not in blk

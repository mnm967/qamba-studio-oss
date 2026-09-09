"""Fights: the auto-applied combat adapter, and the FIGHT CHOREOGRAPHER stage.

Both exist because of the adapter author's own warning — "this is not a magic
LoRA, and it will not automatically choreograph a complete fight for you". The
adapter enhances HOW a move is performed; something still has to decide WHAT
the moves are.
"""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MODEL_TIER", "full")

import storyplan as SP  # noqa: E402


# --- the adapter is applied to fight blocks automatically -----------------

def _B():
    import handlers.blocks as B
    return B


def test_a_fight_block_gets_the_combat_adapter():
    B = _B()
    out = B._block_loras({"params": {"fight": True}})
    assert out == [{"key": "combat", "strength": 1.0}]


def test_an_ordinary_block_does_not():
    B = _B()
    assert B._block_loras({"params": {}}) is None
    assert B._block_loras({"params": {"fight": False}}) is None


def test_it_rides_on_TOP_of_the_episode_stack_and_never_replaces_it():
    B = _B()
    out = B._block_loras({"params": {"fight": True,
                                     "loras": [{"key": "grain", "strength": 0.8}]}})
    assert [x["key"] for x in out] == ["grain", "combat"]


def test_it_is_never_added_twice():
    """A user who picked it explicitly keeps THEIR strength — loading the same
    file twice would apply it at compounding strength, the exact reason
    minimax-h3-hybrid does not offer the adapter it bakes in."""
    B = _B()
    out = B._block_loras({"params": {"fight": True,
                                     "loras": [{"key": "combat", "strength": 0.5}]}})
    assert out == [{"key": "combat", "strength": 0.5}]


def test_a_bare_string_pick_counts_as_already_picked():
    B = _B()
    out = B._block_loras({"params": {"fight": True, "loras": ["combat"]}})
    assert out == ["combat"]


def test_the_flag_rides_the_block_like_every_other_render_flag():
    B = _B()
    assert "fight" in B._BLOCK_FLAGS
    assert B._block_params({"fight": True})["fight"] is True


def test_a_model_that_does_not_declare_combat_is_left_alone(monkeypatch):
    """Adding an unresolvable key would put a misleading entry in the block's
    stored stack — resolve() would drop it with a log line nobody reads."""
    B = _B()
    monkeypatch.setattr(B.R, "ensure_model", lambda m, mm=None: {"style_loras": {}})
    assert B._block_loras({"params": {"fight": True}}, model="wan2.2") is None


def test_a_lookup_failure_does_not_fail_the_render(monkeypatch):
    B = _B()
    def boom(m, mm=None):
        raise RuntimeError("no map here")
    monkeypatch.setattr(B.R, "ensure_model", boom)
    out = B._block_loras({"params": {"fight": True}}, model="minimax-h3")
    assert out == [{"key": "combat", "strength": 1.0}]


def test_launch_render_stamps_fight_from_the_scene_type():
    """The decision is made ONCE at plan time and stored, not derived per
    render — two takes of one block must not disagree about whether it is a
    fight, and a stored flag is overridable per block where a derived one is
    not."""
    import ast
    src = open(os.path.join(ROOT, "handlers", "blocks.py")).read()
    fn = next(n for n in ast.walk(ast.parse(src))
              if isinstance(n, ast.FunctionDef) and n.name == "handle_launch_render")
    body = ast.get_source_segment(src, fn)
    assert '_fight_scene_ids' in body
    assert '"action"' in body
    assert '_p["fight"] = True' in body
    # an explicit user value wins both ways
    assert 'if "fight" not in _p' in body


def test_the_strength_is_one_and_no_trigger_is_placed():
    """Both measured, not assumed: combat @1.0 with NO trigger scored +85.6%
    sharpness where the author's own `prfight2, prfin1` scored -18.5%."""
    B = _B()
    assert B.FIGHT_STRENGTH == 1.0
    import json
    mm = json.load(open(os.path.join(os.path.dirname(ROOT), "infra",
                                     "model_map.full.json")))["full"]["models"]
    for name, spec in mm.items():
        if B.FIGHT_LORA in (spec.get("style_loras") or {}):
            assert B.FIGHT_LORA not in (spec.get("lora_triggers") or {}), name


# --- the choreographer stage ---------------------------------------------

def _story():
    return {
        "world": {"era": "now", "tone": "hard"},
        "characters": [{"name": "Rei", "identity_line": "lean, braid"},
                       {"name": "Osei", "identity_line": "broad, shaved head"}],
        "scenes": [
            {"slug": "TALK", "type": "dialogue", "cast": ["Rei"]},
            {"slug": "BRAWL", "type": "action", "cast": ["Rei", "Osei"],
             "environment": "CAR-PARK"},
        ],
    }


def test_it_owns_action_scenes_only():
    assert [s["slug"] for s in SP.fight_scenes(_story())] == ["BRAWL"]


def test_it_is_shown_the_fight_and_not_the_rest():
    msgs = SP.choreographer_messages(_story(), {"BRAWL": [{"action": "x", "camera": "wide"}]})
    body = msgs[0]["content"]
    assert "BRAWL" in body and "TALK" not in body


def test_a_summarised_fight_is_reported():
    """"they fight" is the failure the whole stage exists to fix."""
    shots = {"BRAWL": [{"action": "They fight viciously across the floor."},
                       {"action": "Osei staggers back and drops to one knee."}]}
    issues = SP.fight_issues(_story(), shots)
    assert any("SUMMARISE" in i for i in issues)


def test_a_fight_with_no_physical_consequence_is_reported():
    shots = {"BRAWL": [{"action": "Rei moves toward Osei in the dark."},
                       {"action": "Osei watches her approach carefully."}]}
    issues = SP.fight_issues(_story(), shots)
    assert any("no physical consequence" in i for i in issues)


def test_choreographed_prose_passes():
    shots = {"BRAWL": [
        {"action": "Osei drives a right at her face; she slips outside it so "
                   "his weight carries him a step past her, and she hooks his "
                   "trailing elbow to keep him turning."},
        {"action": "Off that turn she drives her knee into his ribs; he folds "
                   "around it, his guard dropping, and staggers back into a "
                   "pillar hard enough to knock grit off it."}]}
    assert SP.fight_issues(_story(), shots) == []


def test_many_against_one_must_state_an_order():
    st = _story()
    st["scenes"][1]["cast"] = ["Rei", "Osei", "Mara", "Tam"]
    shots = {"BRAWL": [{"action": "Rei drops one attacker with an elbow and "
                                  "shoves another into the rail."}]}
    assert any("ORDER" in i for i in SP.fight_issues(st, shots))


def test_a_line_that_INTERRUPTS_a_strike_is_flagged():
    """The author's measured rule: complete the attack before the dialogue or
    the motion reverts to the base model's slower behaviour."""
    shots = {"BRAWL": [{"action":
        "\"Stay down where you are\" she says as she drives her knee into his "
        "ribs and he folds around it and staggers back into the pillar behind "
        "him, his guard dropping as he goes.",
        "dialogue": [{"line": "Stay down where you are"}]}]}
    assert any("before the strike" in i for i in SP.fight_issues(_story(), shots))


def test_a_line_AFTER_the_strike_is_not_flagged():
    """The check is on ORDER, not co-occurrence — found live. Flagging any
    shot that has both a strike and a line fires on the CORRECT prose too, so
    it could never be satisfied: a re-ask every run and a permanently non-zero
    issue count. This is the phrasing a real model produced when it obeyed the
    rule."""
    shots = {"BRAWL": [{"action":
        "Osei clamps both hands onto the back of her jacket and jerks her "
        "backward; her boots skid and his pull drives her shoulder into the "
        "shutter with a metallic bang. Only after pinning her does he demand, "
        "\"Hand it over now\"",
        "dialogue": [{"line": "Hand it over now"}]}]}
    assert SP.fight_issues(_story(), shots) == []


def test_a_shot_whose_action_does_not_quote_the_line_is_left_alone():
    """Nothing about the ordering is knowable there, so guessing would be the
    same false positive one step removed."""
    shots = {"BRAWL": [{"action":
        "She drives her knee into his ribs; he folds around it and staggers "
        "back two steps before his shoulder slams the pillar behind him.",
        "dialogue": [{"line": "Stay down where you are"}]}]}
    assert SP.fight_issues(_story(), shots) == []


def test_merge_applies_only_action_and_only_to_owned_scenes():
    st = _story()
    shots = {"BRAWL": [{"action": "old text here that is long enough", "camera": "wide"}],
             "TALK": [{"action": "untouched", "camera": "close"}]}
    applied, skipped = SP.apply_choreography(st, shots, {"scenes": [
        {"slug": "BRAWL", "shots": [{"idx": 0, "action":
            "Osei swings and misses; the miss carries him past her shoulder."}]},
        {"slug": "TALK", "shots": [{"idx": 0, "action": "rewritten quiet scene"}]},
    ]})
    assert applied == 1 and skipped == 1
    assert shots["BRAWL"][0]["action"].startswith("Osei swings")
    assert shots["BRAWL"][0]["camera"] == "wide", "camera is read-only here"
    assert shots["TALK"][0]["action"] == "untouched"


def test_a_rewrite_that_collapses_the_shot_is_dropped():
    """Halving the word count is a summary, not choreography — the exact
    failure being fixed. Same defensive shape as merge_voice_pass."""
    st = _story()
    long = " ".join(["word"] * 60)
    shots = {"BRAWL": [{"action": long}]}
    applied, skipped = SP.apply_choreography(st, shots, {"scenes": [
        {"slug": "BRAWL", "shots": [{"idx": 0, "action": "They fight and he loses."}]}]})
    assert (applied, skipped) == (0, 1)
    assert shots["BRAWL"][0]["action"] == long


def test_an_out_of_range_shot_index_is_dropped_not_raised():
    st = _story()
    shots = {"BRAWL": [{"action": "something reasonably long to start from"}]}
    applied, skipped = SP.apply_choreography(st, shots, {"scenes": [
        {"slug": "BRAWL", "shots": [{"idx": 9, "action": "x" * 40}]}]})
    assert (applied, skipped) == (0, 1)


def test_the_contract_forbids_the_envelope_and_the_camera():
    """Invariant #6: this rewrites structured beats, and h3_prompt compiles the
    envelope from them. And the camera is already chosen by the DP."""
    c = " ".join(SP.CHOREOGRAPHER_CONTRACT.split())   # the contract is wrapped
    for token in ("[Shot N]", "<Subject N>", "timestamps", "camera direction",
                  "trigger words"):
        assert token in c, token


def test_the_stage_is_registered_in_llm():
    """An id storyplan asks for that llm does not register KeyErrors inside an
    advisory try/except and logs 'skipped' — how the dialogue polish silently
    never ran for its whole life."""
    src = open(os.path.join(ROOT, "llm.py")).read()
    assert '"choreographer":' in src


# --- shots too short for what is written into them -----------------------
# The measured failure, from the first real r2v fight block: 3.3s holding a
# five-phase chain plus a line rendered as a generic clinch AND dropped the
# line. H3 cannot perform what will not fit, so it falls back to grappling.



def test_a_short_shot_cannot_hold_a_strike_AND_a_line():
    """Ordering the prose is necessary and not sufficient — measured: the line
    is what gets dropped (reviewer scored DIALOGUE_MISSING, 0% spoken)."""
    shots = {"BRAWL": [{"duration_ms": 3300, "action":
        "He drives her back into the crates and her shoulder folds. Only then "
        "does he force out, \"Move now\"",
        "dialogue": [{"line": "Move now"}]}]}
    assert any("not carrying an impact" in i for i in SP.fight_issues(_story(), shots))


def test_a_long_enough_shot_may_hold_both():
    shots = {"BRAWL": [{"duration_ms": 6000, "action":
        "He drives her back into the crates and her shoulder folds under it. "
        "Only after she stops moving does he force out, \"Move now\"",
        "dialogue": [{"line": "Move now"}]}]}
    assert SP.fight_issues(_story(), shots) == []


def test_the_dialogue_room_check_is_inert_without_a_duration():
    """A caller that does not carry duration_ms must not be flagged on a
    number that does not exist."""
    shots = {"BRAWL": [{"action":
        "He drives her back into the crates and her shoulder folds under it.",
        "dialogue": [{"line": "Move now"}]}]}
    assert not any("not carrying an impact" in i for i in SP.fight_issues(_story(), shots))


# --- editing a take must not lose the block's adapters -------------------
# `handle_video_edit` RECEIVES block_id and used to ignore it, so every caller
# had to restate the block's render settings and none restated all of them:
# the director chat's edit_video (both twins) sends neither model_key nor
# loras, PromptRefsModal sends model_key and not loras. Editing a FIGHT take
# therefore lost the combat adapter on every path.

def _edit_src():
    import ast, os
    src = open(os.path.join(ROOT, "handlers", "blocks.py")).read()
    fn = next(n for n in ast.walk(ast.parse(src))
              if isinstance(n, ast.FunctionDef) and n.name == "handle_video_edit")
    return ast.get_source_segment(src, fn)


def test_an_edit_of_a_block_inherits_its_model_and_adapters():
    body = _edit_src()
    assert "_load_block(payload[\"block_id\"])" in body
    assert "_block_model(_eblock" in body
    assert "_block_loras(_eblock" in body


def test_the_payload_still_wins_where_it_speaks():
    """Inheriting fills in what the caller left unsaid; it must not override an
    explicit pick, or the modal's model dropdown stops working."""
    body = _edit_src()
    assert 'payload.get("model_key") or _block_model' in body
    assert 'payload.get("loras") or _block_loras' in body


def test_a_bare_asset_edit_keeps_the_default():
    """No block to inherit from — H3_MODEL stays the default rather than
    becoming a required key."""
    body = _edit_src()
    assert 'payload.get("model_key") or H3_MODEL' in body


def test_a_stale_block_id_does_not_kill_the_edit():
    body = _edit_src()
    assert "_eblock = None" in body and "except Exception" in body


def test_both_director_twins_send_the_same_edit_payload():
    """They disagreed silently before: whatever one sends the other must too,
    or an edit behaves differently depending on which backend answered."""
    import re
    js = open(os.path.join(os.path.dirname(ROOT), "director", "tools.js")).read()
    py = open(os.path.join(ROOT, "director_tools.py")).read()
    for key in ("source_asset_id", "prompt", "ref_asset_ids", "seed", "block_id"):
        assert key in js and key in py, key


# --- a closing frame must survive recompute_refs -------------------------

def test_recompute_refs_carries_the_closing_frame_across():
    """`ref_plan_for` derives from the beats, and NOTHING there produces an
    end_frame — it is written straight into the ref_plan by PromptRefsModal.
    So a wholesale replace deleted it, silently, on a block still set to flf,
    and handle_master_pass then raised "needs a closing frame" on a block that
    had one a moment earlier."""
    import ast, os
    src = open(os.path.join(ROOT, "handlers", "blocks.py")).read()
    fn = next(n for n in ast.walk(ast.parse(src))
              if isinstance(n, ast.FunctionDef) and n.name == "handle_master_pass")
    body = ast.get_source_segment(src, fn)
    seg = body.split('recompute_refs')[1].split('content_ms =')[0]
    assert 'purpose") == "end_frame"' in seg
    assert "fresh.append(kept)" in seg
    # and only when the recompute did not produce one itself
    assert "if not any(" in seg


# ---------------------------------------------------------------------------
# ONE ACTION, ONE SHOT. Added after TEMPLE DUEL, where three of the four
# defects the director reported were the same one: a movement written across
# two shots. Each shot compiles to its own timestamped instruction and a
# chained block is told the preceding actions are already finished, so a
# strike thrown in one shot and landed in the next is performed TWICE and a
# movement left travelling at a shot's end is performed by NOBODY.
#
# The prose below is verbatim from that storyboard.
# ---------------------------------------------------------------------------

def _scene(slug, actions, dur=3500, cast=("Lian", "Master Ren")):
    story = {"scenes": [{"slug": slug, "type": "action", "cast": list(cast)}]}
    shots = [{"action": a, "duration_ms": dur, "dialogue": []} for a in actions]
    return story, {slug: shots}


def _codes(story, shots):
    return SP.fight_issues(story, shots)


def test_a_shot_left_in_progress_is_flagged():
    """THE_LESSON ended a shot on "the staff begins to slide free of her grip"
    and opened the next block completing it. On screen the disarm never
    happens — the staff simply appears on the floor between cuts."""
    story, shots = _scene("THE_LESSON", [
        "Lian hauls on the trapped staff with both hands, boots skidding.",
        "Ren hooks two fingers over her forward wrist and rotates his hips "
        "away from the pillar. The turn peels her fingers off the shaft one "
        "at a time and the staff begins to slide free of her grip.",
    ])
    issues = _codes(story, shots)
    assert any("still in progress" in i for i in issues), issues


def test_a_shot_that_completes_the_previous_one_is_flagged():
    story, shots = _scene("THE_LESSON", [
        "Ren rotates his hips and the staff begins to slide free of her grip.",
        "Ren completes the turn and the temple staff comes away in his hands.",
    ])
    assert any("opens by completing" in i for i in _codes(story, shots))


def test_a_strike_landed_in_the_next_shot_is_flagged():
    """THE_PRESS threw a spinning heel at Ren in one shot and opened the next
    with "Lian's heel smashes the pillar instead of Ren" — one kick, written
    as two. The director's report: "why does she kick the pillar? twice"."""
    story, shots = _scene("THE_PRESS", [
        "Lian plants beside the second pillar and whips a spinning heel "
        "toward Ren's ribs. Ren folds beneath the heel and steps clear.",
        "Lian's heel smashes the pillar instead of Ren. The joint sheds pale "
        "dust and the heel skids across the stone.",
    ])
    assert any("opens by completing" in i for i in _codes(story, shots))


def test_three_shots_of_holding_still_are_flagged():
    """The "they just grab each other" complaint, second occurrence. Three
    consecutive shots of a trapped staff = 8.25s of a 13.75s block in which
    nothing travelled."""
    story, shots = _scene("THE_LESSON", [
        "Lian drives the staff in a flat arc at Master Ren's ribs and he "
        "turns his hips off the line.",
        "Ren steps inside its length and presses his forearm along the "
        "shaft, pinning it flat against the timber so she cannot draw it back.",
        "Lian hauls on the trapped staff with both hands. The shaft does not "
        "move; the strain turns her shoulders square to Ren.",
        "Ren keeps his grip on the shaft and holds her there, pressing.",
    ], dur=2750)
    assert any("in a row in which nobody strikes" in i for i in _codes(story, shots))


def test_two_shots_of_holding_are_allowed():
    """A lock is a real beat. MAX_HOLD_RUN exists so the check does not
    forbid one."""
    story, shots = _scene("THE_LESSON", [
        "Ren presses his forearm along the shaft, pinning it against the timber.",
        "Lian hauls on the trapped staff; the shaft does not move.",
        "She drops the staff and whips an elbow into his sternum; he folds.",
    ], dur=2750)
    assert not any("in a row in which nobody strikes" in i
                   for i in _codes(story, shots))


def test_the_scene_that_rendered_cleanly_raises_nothing():
    """THE_MEASURE — verbatim. It reviewed at action 1.0, verdict keep, and
    the director reported no problem with it. A check that fires here is a
    re-ask every run and a warning nobody reads, which is the mistake the
    action-before-speech check already made once."""
    story, shots = _scene("THE_MEASURE", [
        "Lian bows from the waist at the left side of the raised altar "
        "platform, then raises her right palm and settles her weight onto her "
        "front foot. Master Ren returns the salute with two fingers touching "
        "his left palm; his bent knees remain poised.",
        "Both lower their hands. Lian keeps her eyes fixed on Ren, but her "
        "front foot stays planted and her shoulders remain angled forward "
        "from the bow. Ren studies the distance between their feet.",
        "Lian lunges from the left with a straight right palm toward Ren's "
        "chest. Ren turns his ribs aside and guides her wrist past him with "
        "his left forearm; her palm misses, her shoulder twists, and her "
        "weight carries her one step beyond him.",
        "Lian plants her correcting foot and whips a compact backfist toward "
        "Master Ren's cheek. Ren raises his forearm just in time; fist and "
        "forearm collide with a sharp jolt, his sleeve snapping and Lian's "
        "knuckles recoiling.",
        "Master Ren answers immediately: he steps off the pillar line and "
        "throws two measured strikes, a straight palm toward Lian's sternum "
        "followed by a short backfist toward her temple. Lian slips the palm "
        "and catches the backfist on her crossed forearms.",
        "Ren drives a final short palm into Lian's guarded forearms, stopping "
        "just before her chest but forcing her back one step. The blocked "
        "impact compresses her stance and shakes dust from the pillar.",
        "Lian snaps a front kick toward Ren's abdomen. Ren catches her shoe "
        "against his lowered forearm and gives one backward step; Lian's "
        "unsupported leg hangs forward, her torso pitched toward him.",
        "Ren steps into the opening and stops his open hand a finger's "
        "breadth from Lian's throat. She recoils onto her supporting foot, "
        "her extended leg dropping as her balance breaks.",
    ])
    assert _codes(story, shots) == []


def test_a_denied_object_is_flagged():
    """"no spear is visible" was written into a real shot to keep polearms out
    of a temple weapon rack. The render came back with polearms on the rack —
    a denial names the thing, and these models cannot subtract."""
    story, shots = _scene("THE_PRESS", [
        "Her right hand pulls free one long hardwood temple staff with a worn "
        "grip and a carved brass cap; no spear is visible. The staff clears "
        "the frame and settles across her body.",
    ])
    assert any("what is NOT there" in i for i in _codes(story, shots))


def test_describing_the_object_positively_raises_nothing():
    story, shots = _scene("THE_PRESS", [
        "Her right hand pulls free a plain dark hardwood shaft, brass-capped "
        "at both ends with a red cloth tassel, and it settles across her body "
        "as her shoulder drives forward into the rack frame.",
    ])
    assert not any("what is NOT there" in i for i in _codes(story, shots))


def test_a_pasted_identity_line_is_stripped_from_the_action():
    """RIVALS came back with all 29 shots opening on both fighters' full
    wardrobe — ~90 words of hair, build and jewellery inside a 3-second beat.
    `h3_prompt` already declares every subject once in `subject_definitions`
    from these same strings, so the copy is redundant as well as diluting."""
    ident = ("Mara has chin-length black hair tied low at the nape, brown "
             "eyes, a compact muscular build, and a red cord bracelet.")
    act = (ident + " She catches his shin against both forearms; the impact "
           "shoves her half a step backward through standing water.")
    out = SP.strip_identity_lines(act, [ident])
    assert out.startswith("She catches his shin")
    assert "chin-length" not in out


def test_stripping_leaves_prose_that_never_carried_one_alone():
    act = "She catches his shin against both forearms and gives a step."
    assert SP.strip_identity_lines(act, ["Mara has chin-length black hair "
                                         "tied low at the nape, brown eyes."]) == act


def test_a_short_string_is_never_treated_as_an_identity_line():
    """The guard matters: a two-word 'identity' would blank real prose."""
    act = "Mara drives an elbow into his ribs and he folds over it."
    assert SP.strip_identity_lines(act, ["Mara", "his ribs"]) == act


# ---------------------------------------------------------------------------
# RE-RENDERING A RUN OF CHAINED BLOCKS. `rerender_stale` has always chained its
# jobs — "a successor's opening frame is its predecessor's last one" — and
# `rerender_block` did not. Asked to redo b5-b8, the director calls
# rerender_block four times, which left four independent jobs: they claim in
# created_at order today, which is luck, and each block's <Picture 1> is its
# predecessor's ACTIVE take, so one rendering ahead of its predecessor opens on
# the take about to be replaced.
# ---------------------------------------------------------------------------

def _twins():
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2]
    return ((root / "worker" / "director_tools.py").read_text(),
            (root / "director" / "tools.js").read_text())


def test_rerender_block_chains_onto_a_pending_rerender_of_its_predecessor():
    py, js = _twins()
    assert "_pending_rerender_for" in py
    assert "pendingRerenderFor" in js
    for src, who in ((py, "worker"), (js, "hosted")):
        assert "chain_from_block_id" in src, who


def test_rerender_block_returns_the_prose_it_will_render():
    """Asked to strip a motif from four blocks the director rewrote two shots
    of one, missed the other two, and reported the range clean. Nothing here
    makes a model thorough — returning what is about to render at least puts
    the evidence in the transcript."""
    py, js = _twins()
    assert '"shots": _block_shots(block)' in py
    assert "shots: await blockShots(found.block)" in js


def test_both_rerender_paths_still_order_chained_blocks():
    """rerender_stale's own chaining must not regress while fixing the other."""
    py, js = _twins()
    assert 'depends_on=dep' in py
    assert "dependsOn" in js

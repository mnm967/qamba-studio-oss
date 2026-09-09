"""Voice-timbre refs for RETURNING and RECAST cast, not just new entries.

The gap this closes was written down as a known one and survived being
written down. `plan_storyboard` queued a `tts` job per speaking character
inside the new-entries loop — so:

a character carried over from a previous episode never got a timbre clip,
because they were not new — and a plan is the only thing that queues these in
bulk. It catches returning cast who predate the feature, entries added by hand
in the bible, and anyone whose `tts` job failed or was cancelled.

NOT a recast: `director_tools.recast_voice` nulls `voice_ref_asset_id` and
queues its own replacement in the same call, so that path looks after itself.
What it leaves behind if its OWN job dies is the residue this picks up.

The failure never raises. The block simply stages one fewer audio ref, and only
on the timbre fallback path, so it reads as a quality wobble.
"""
import llm


STORY = {
    "characters": [
        {"name": "Ada", "voice": "a low, gravelly voice"},
        {"name": "Ren", "voice": "bright, quick"},
        {"name": "Silent Bob", "voice": "n/a"},
    ],
    "scenes": [{"beats": [
        {"dialogue": [{"speaker": "Ada", "line": "You brought the ledger."},
                      {"speaker": "Ren", "line": "I brought a copy."}]},
        {"dialogue": [{"speaker": "Ada", "line": "Then it is not the ledger."}]},
    ]}],
}
NAME_TO_ID = {("character", "ada"): "e-ada",
              ("character", "ren"): "e-ren",
              ("character", "silent bob"): "e-bob"}


def rows(**over):
    base = {"e-ada": {"id": "e-ada", "name": "Ada", "voice_ref_asset_id": None},
            "e-ren": {"id": "e-ren", "name": "Ren", "voice_ref_asset_id": None},
            "e-bob": {"id": "e-bob", "name": "Silent Bob",
                      "voice_ref_asset_id": None}}
    for k, v in over.items():
        base[k] = {**base[k], **v}
    return lambda eid: base.get(eid)


def call(new_ids, fetch):
    return llm.speakers_needing_voice_refs(
        STORY, name_to_id=NAME_TO_ID, new_ids=new_ids, fetch_entry=fetch)


def test_a_returning_character_with_no_clip_is_queued():
    """The bug, stated: nothing here is new, so the old loop queued nothing."""
    need, have = call(set(), rows())
    assert [r["name"] for r, _c, _l in need] == ["Ada", "Ren"]
    assert have == []


def test_a_character_whose_clip_went_missing_is_re_queued():
    """A recast queues its own replacement; this is the case where that job
    died, or where the clip was never made at all."""
    need, _ = call(set(), rows(**{"e-ren": {"voice_ref_asset_id": None},
                                  "e-ada": {"voice_ref_asset_id": "a1"}}))
    assert [r["name"] for r, _c, _l in need] == ["Ren"]


def test_a_character_who_already_has_a_clip_is_not_re_synthesized():
    """A voice ref is a fact about the CHARACTER, not the episode. Remaking one
    per episode re-baselines the reviewer's speaker verifier every time."""
    need, have = call(set(), rows(**{"e-ada": {"voice_ref_asset_id": "a1"},
                                     "e-ren": {"voice_ref_asset_id": "a2"}}))
    assert need == []
    assert have == ["a1", "a2"]


def test_a_brand_new_entry_is_queued_without_trusting_a_stale_read():
    """It was created seconds ago and cannot have a clip; believing a stale
    row here would silently drop the one character who definitely needs one."""
    need, _ = call({"e-ada"}, rows(**{"e-ada": {"voice_ref_asset_id": "stale"}}))
    assert "Ada" in [r["name"] for r, _c, _l in need]


def test_a_character_who_never_speaks_gets_no_clip():
    need, _ = call(set(), rows())
    assert "Silent Bob" not in [r["name"] for r, _c, _l in need]


def test_the_line_offered_is_one_the_character_actually_says():
    need, _ = call(set(), rows())
    by_name = {r["name"]: line for r, _c, line in need}
    assert by_name["Ada"] == "You brought the ledger."
    assert by_name["Ren"] == "I brought a copy."


def test_an_entry_that_vanished_is_skipped_not_crashed_on():
    need, _ = call(set(), lambda eid: None)
    assert need == []


def test_existing_clips_are_reported_so_the_voice_picker_can_avoid_them():
    """`pick_tts_voice` de-duplicates against `taken`. Seeded from new entries
    alone, a returning lead and a new supporting character get one voice."""
    _need, have = call({"e-ren"}, rows(**{"e-ada": {"voice_ref_asset_id": "a1"}}))
    assert have == ["a1"]

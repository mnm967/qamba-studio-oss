"""A LoRA pick can carry its own trigger token.

The studio's own adapters are declared in `model_map`'s `lora_triggers`, keyed
by the same names as `style_loras`. A user's hub download is in no map at all —
it reaches `lora_stack` as a bare `*.safetensors` filename through the escape
hatch there — so the only place its token can travel is on the pick itself.

That matters because a trigger-less adapter of this kind LOADS CLEANLY AND DOES
NOTHING (CLAUDE.md records `grit` as the first of that shape), which is the
silent downgrade this codebase keeps naming.
"""
import resolve as R


def test_a_pick_carries_its_own_trigger_when_no_table_declares_one():
    # No model_map entry at all — the desktop case.
    got = R.lora_triggers("no-such-model",
                          [{"key": "myLora.safetensors", "trigger": "mytoken"}],
                          mm={R.TIER: {"models": {}}})
    assert got == ["mytoken"]


def test_the_map_wins_over_the_pick_for_a_studio_adapter():
    mm = {R.TIER: {"models": {"m": {"lora_triggers": {"grit": "gritmotion"}}}}}
    got = R.lora_triggers("m", [{"key": "grit", "trigger": "wrong"}], mm=mm)
    assert got == ["gritmotion"]


def test_a_pick_with_no_trigger_still_contributes_nothing():
    mm = {R.TIER: {"models": {"m": {}}}}
    assert R.lora_triggers("m", [{"key": "plain.safetensors"}], mm=mm) == []
    assert R.lora_triggers("m", ["plain.safetensors"], mm=mm) == []


def test_duplicates_are_collapsed_across_both_sources():
    mm = {R.TIER: {"models": {"m": {"lora_triggers": {"a": "tok"}}}}}
    got = R.lora_triggers("m", [{"key": "a"}, {"key": "b.safetensors", "trigger": "TOK"}], mm=mm)
    assert got == ["tok"]

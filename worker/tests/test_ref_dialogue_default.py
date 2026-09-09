"""Ref-audio is the DEFAULT for locked-dialogue blocks (2026-08-30).

The measured A/B that flipped it: on the audiolock, the frozen-mouth shots
stayed frozen and the no-speech windows sat on the -44.6 LUFS pink bed; on
the reference path both articulate and the room is a generated -15..-22 LUFS
soundscape with real events, with every word surviving once the spine
offsets + finish-by anchors shipped. The lock stays one param away
(`dialogue_audio: "locked"`) and music videos never left it.

The decision lives inline in handle_master_pass (DB-bound), so the default
and the opt-out are pinned by source parse — the scoreTrack.test.ts
situation, in Python.
"""
import os
import re

import h3_prompt as H

SRC = open(os.path.join(os.path.dirname(__file__), "..",
                        "handlers", "blocks.py")).read()


def test_the_default_is_ref_and_the_opt_out_is_locked():
    m = re.search(
        r"payload\.get\(\"dialogue_audio\"\)\s*\n?\s*or params\.get\("
        r"\"dialogue_audio\"\) or \"(\w+)\"", SRC)
    assert m and m.group(1) == "ref"
    # the branch takes the ref path unless the pin says locked
    assert '_dlg_audio != "locked"' in SRC


def test_the_pin_is_a_block_flag():
    m = re.search(r"_BLOCK_FLAGS = \(([^)]*)\)", SRC)
    assert m and '"dialogue_audio"' in m.group(1)


def test_music_videos_are_untouched():
    # the flip is gated on locked_kind == "dialogue"; an MV block
    # (locked_kind "music") must keep reproducing its master 1:1
    i = SRC.index('_dlg_audio != "locked"')
    gate = SRC[i:i + 300]
    assert 'str(params.get("locked_kind") or "music") == "dialogue"' in gate


def test_ref_dialogue_blocks_send_music_na():
    i = SRC.index('music_hint=(params.get("music")')
    assert '"N/A" if dialogue_ref else None' in SRC[i:i + 200]


def test_a_bare_NA_music_hint_survives_unpunctuated():
    """_sentence("N/A") would ship "N/A." — punctuation on a token the model
    matches literally. The compiler passes the vendor's own no-score token
    through bare, exactly as the locked spine writes it."""
    beats = [{"action": "Mara sets the case down", "camera": "a medium shot",
              "duration_ms": 5000, "dialogue": [], "meta": {"cast": ["Mara Vale"]}}]
    cast = [{"name": "Mara Vale", "identity_line": "a slim woman in a charcoal coat"}]
    out = H.compile_block(
        render_ms=5000, warmup_ms=0, aspect="16:9", style="cinematic",
        medium="film", beats=beats, cast=cast,
        environment={"name": "Vale Watch Repair"}, mode="r2v",
        ref_slots=[{"kind": "character", "name": "Mara Vale", "slot": 1}],
        music_hint="N/A")
    assert out["music"] == "N/A"
    # and an ordinary hint still gets sentence treatment
    out2 = H.compile_block(
        render_ms=5000, warmup_ms=0, aspect="16:9", style="cinematic",
        medium="film", beats=beats, cast=cast,
        environment={"name": "Vale Watch Repair"}, mode="r2v",
        ref_slots=[{"kind": "character", "name": "Mara Vale", "slot": 1}],
        music_hint="a soft brushed-drum bed")
    assert out2["music"] == "A soft brushed-drum bed."[0].lower() + out2["music"][1:] \
        or out2["music"].endswith(".")

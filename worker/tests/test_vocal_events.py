"""Vocal events — "(sigh)" in a line — as the three consumers see them.

The synth keeps them (in each engine's spelling), the envelope strips them
from `<d>…</d>` and says them as action, the reviewer strips them from the
expected words. All pure; every case is a line the writer could actually
produce under the contract.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vocal_events as VE  # noqa: E402


def test_the_documented_four_are_recognised_with_their_inflections():
    assert VE.events_in("(sigh) It's good to hear your voice.") == ["sigh"]
    assert VE.events_in("(Sighs) Fine.") == ["sigh"]
    assert VE.events_in("(laughs) You would say that.") == ["laugh"]
    assert VE.events_in("(clears his throat) Right.") == ["clears throat"]
    assert VE.events_in("(cough) Sorry — go on.") == ["cough"]
    assert VE.events_in("(beat) Go on.") == []


def test_strip_leaves_only_the_words():
    assert VE.strip_events("(sigh) It's good to hear your voice.") == "It's good to hear your voice."
    assert VE.strip_events("Fine. (laughs) Fine.") == "Fine. Fine."
    assert VE.strip_events("(beat) Go on.") == "Go on."
    assert VE.strip_events("No events here.") == "No events here."


def test_breeze_spelling_keeps_the_documented_events_and_drops_directions():
    assert VE.sanitize_events("(Sighs) It's late. (beat) Go home.") == "(sigh) It's late. Go home."


def test_elevenlabs_spelling_is_the_v3_tag():
    assert VE.to_elevenlabs("(sigh) It's late.") == "[sighs] It's late."
    assert VE.to_elevenlabs("(clears throat) We need to talk.") == "[clears throat] We need to talk."
    assert VE.to_elevenlabs("(pause) We need to talk.") == "We need to talk."


def test_event_prose_reads_as_an_action():
    assert VE.event_prose(["sigh"]) == "sighs"
    assert VE.event_prose(["laugh", "clears throat"]) == "laughs, then clears their throat"
    assert VE.event_prose([]) == ""

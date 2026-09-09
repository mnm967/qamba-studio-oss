"""A vocal event never reaches `<d>…</d>`; it is said as action instead."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import h3_prompt as H  # noqa: E402


def test_the_spoken_words_and_the_action_lead():
    d = {"speaker": "Mara", "line": "(sigh) It's good to hear your voice again."}
    assert H._spoken(d) == "It's good to hear your voice again."
    assert H._event_lead(d) == " sighs, then"
    assert H._event_lead({"line": "No events."}) == ""


def test_the_compiled_envelope_keeps_events_out_of_the_d_tags():
    beats = [{"start_ms": 0, "duration_ms": 4000, "action": "She turns to him.",
              "camera": "a medium close-up; the camera holds",
              "cast_names": ["Mara"],
              "dialogue": [{"speaker": "Mara",
                            "line": "(sigh) It's good to hear your voice again."}]}]
    import json
    out = H.compile_block(render_ms=4000, warmup_ms=0, aspect="16:9", style="live action",
                          medium="film", beats=beats,
                          cast=[{"name": "Mara", "identity_line": "a woman in a coat"}],
                          environment=None, ref_slots=[], mode="t2v")
    text = json.dumps(out)
    assert "<d>[English] It's good to hear your voice again.</d>" in text
    assert "(sigh)" not in text
    assert "sighs, then says" in text

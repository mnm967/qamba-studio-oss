"""H3's two AUDIO fields, on the path that compiles nothing.

`compile_block` writes all three fields; `handle_clip_gen` sends the prompt
VERBATIM (invariant #6's one documented exception), so an extend or a chain
used to reach H3 with no `overall_soundscape` and no `non_diegetic_music` and
the model invented both. Measured on two renders of a silent fight:
speech-band energy -20.3 / -21.4 dB against the source block's -25.3.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import h3_prompt as H

ENVELOPE = (
    "subject_definitions: S1 is the woman.\n"
    "integrated_multimodal_description: She drives forward. [Shot 1] She steps in.\n"
    "overall_soundscape: Cloth snaps and feet scuff on stone.\n"
    "non_diegetic_music: Low strings."
)


def test_bare_prose_gets_the_music_channel_closed():
    out = H.with_audio_defaults("A fight continues in a temple.")
    assert "non_diegetic_music: N/A" in out


def test_the_no_speech_clause_lands_in_the_PROSE_not_in_the_music_value():
    # The trap: append the field first and the clause goes after it, i.e.
    # INSIDE the music value — present in the string, absent from the prompt.
    out = H.with_audio_defaults("A fight continues in a temple.")
    assert out.index("No character speaks") < out.index("non_diegetic_music:")


def test_it_never_writes_overall_soundscape():
    # `N/A` there means COMPLETE SILENCE per the vendor guide, and inventing a
    # soundscape is the writer's job. Ambience was never the complaint.
    assert "overall_soundscape" not in H.with_audio_defaults("A quiet room.")


def test_an_envelope_keeps_its_own_music_and_takes_the_clause_in_the_description():
    out = H.with_audio_defaults(ENVELOPE)
    assert "non_diegetic_music: Low strings." in out
    assert "N/A" not in out
    # The clause belongs to the description field, so it must come before the
    # next label — after it, H3 never reads it.
    assert out.index("No character speaks") < out.index("overall_soundscape:")


def test_a_prompt_that_WANTS_speech_is_left_alone():
    for spoken in ('She says: "stop." They face off.',
                   "<d>[English] Enough.</d>",
                   "A narrator describes the scene in voice-over."):
        out = H.with_audio_defaults(spoken)
        assert "No character speaks" not in out, spoken
    # And the explicit opt-in beats the detector.
    assert "No character speaks" not in H.with_audio_defaults("A fight.", allow_speech=True)


def test_it_is_idempotent():
    once = H.with_audio_defaults("A fight.")
    assert H.with_audio_defaults(once) == once
    assert H.with_audio_defaults(H.with_audio_defaults(ENVELOPE)) == H.with_audio_defaults(ENVELOPE)


def test_empty_in_empty_out():
    assert H.with_audio_defaults("") == ""
    assert H.with_audio_defaults("   ") == "   "


def test_the_handler_only_applies_it_to_h3():
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "handlers", "blocks.py")).read()
    body = src[src.index("def handle_clip_gen"):src.index("def handle_transition_gen")]
    # The CALL, not the name — which also appears in the comment above it.
    i = body.index("h3_prompt.with_audio_defaults")
    assert '"h3" in model_key.lower()' in body[i - 120:i]

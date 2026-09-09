"""A voice on a phone must not be given a body.

Nothing in the pipeline distinguished "speaks in this shot" from "is visible
in this shot", so a phone caller was cast by the cinematographer, staged with
a character sheet as `<Picture N>`, given a subject definition, AND given a
physical position by the Continuity Director — which places every name it is
handed.

MEASURED on THE LAST SERVICE (2026-08-21), whose `positions` for b0 shot 2
read, verbatim:

    "Tam Reed": "at the phone in Mara Vale's hand, facing Mara Vale, seated"

Tam has no body in that film; she is a voice on a call in every scene she is
in. Handed her face, her name and that posture, H3 drew her — seated in the
shop in b0, standing in the street in b1 — and both blocks read as broken.
"""
import image_prompt as IP

CAST = ["Mara Vale", "Tam Reed"]


def test_the_shot_that_drew_a_phone_caller_into_the_room():
    txt = ("Mara's black phone vibrates against her palm. She answers without "
           "looking away from the lit shop, rain running from her hair and coat.")
    assert IP.remote_speakers(txt, CAST, ["Tam Reed"]) == ["Tam Reed"]


def test_a_possessive_over_an_abstract_noun_is_still_not_a_body():
    """b1's shot names her — "Tam's careful instruction continues" — and an
    instruction is not a body part, so `featured_cast`'s possessive rule
    already puts her out of frame. Reusing it is what makes this case work."""
    txt = ("The cracked phone remains pressed to Mara's ear as Tam's careful "
           "instruction continues. Mara's thumb tightens against the phone edge.")
    assert IP.remote_speakers(txt, CAST, ["Tam Reed"]) == ["Tam Reed"]


def test_a_speaker_the_text_puts_in_frame_is_never_remote():
    """The expensive mistake in the other direction: deleting a character who
    IS in the room costs the shot its second face, and the model invents one."""
    txt = "Tam sets the contract on the bench and speaks. Mara does not look up."
    assert IP.remote_speakers(txt, CAST, ["Tam Reed"]) == []


def test_no_device_means_no_verdict():
    """Conservative on purpose — an off-screen speaker with nothing to speak
    THROUGH is left alone rather than guessed at."""
    assert IP.remote_speakers("Tam speaks from somewhere unseen.", CAST,
                              ["Tam Reed"]) == []


def test_a_body_part_possessive_keeps_them_in_frame():
    txt = "Tam's hand closes over the phone on the bench."
    assert IP.remote_speakers(txt, CAST, ["Tam Reed"]) == []


def test_someone_who_does_not_speak_is_not_reported():
    """This decides what to do with a VOICE. A silent character's staging is
    `featured_cast`'s business."""
    txt = "Mara's phone lights up on the bench. Nobody answers it."
    assert IP.remote_speakers(txt, CAST, []) == []


def test_the_positions_line_drops_a_remote_speaker():
    """The second half: the sheet is not staged AND the sentence that would
    make H3 invent one is not written."""
    import re
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "h3_prompt.py"
           ).read_text().replace("\r\n", "\n")
    seg = src[src.index("Spatial anchors, restated per shot"):]
    seg = seg[:seg.index("line += (f\" {cam[0]")]
    assert "remote_speakers(" in seg, "positions are no longer gated"
    assert re.search(r"if nm not in remote", seg), "the filter is gone"

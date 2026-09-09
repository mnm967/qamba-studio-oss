"""A video block closes its cast set, the way a panel already did.

`image_prompt` appends "no other person, figure or silhouette appears anywhere
in the frame" whenever every person a beat casts has a staged sheet. The BLOCK
compiler never did — so stills closed their set and the video did not, which
is the worse of the two: an extra in a still is one bad picture, an extra in a
block moves and persists for the whole segment.

MEASURED on THE LAST SERVICE (2026-08-21): a two-hander between Mara and Osei
in the watch shop came back with TWO unnamed men standing in the foreground,
in a film with a cast of three. H3 is the family this repo records as obeying
terminal negations — the panel prompt's "no split screen, no lettering" — so
the sentence works; it was simply never written for video.
"""
import h3_prompt as H

CAST = [{"name": "Mara Vale", "identity_line": "a slim woman in a charcoal coat"},
        {"name": "Osei Kofi", "identity_line": "a broad-shouldered man in a navy cardigan"}]
CLOSE = "no other person, figure, silhouette"


def block(beats, cast=CAST):
    return H.compile_block(
        render_ms=sum(b["duration_ms"] for b in beats), warmup_ms=0,
        aspect="16:9", style="cinematic", medium="film",
        beats=beats, cast=cast, environment={"name": "Vale Watch Repair"},
        mode="r2v", ref_slots=[{"kind": "character", "name": c["name"], "slot": i + 1}
                               for i, c in enumerate(cast)])


def beat(action, roster, dialogue=None):
    return {"action": action, "camera": "a medium two-shot at eye level",
            "duration_ms": 5000, "dialogue": dialogue or [],
            "meta": {"cast": roster}}


def test_a_fully_staged_block_says_nobody_else_is_there():
    out = block([beat("Mara sets the satchel down. Osei does not look up.",
                      ["Mara Vale", "Osei Kofi"])])
    assert CLOSE in out["description"]


def test_a_block_that_dropped_someone_makes_no_such_claim():
    """The slot budget can evict a cast member, and that person stays in the
    ACTION prose — claiming a closed set there contradicts the sentence right
    above it."""
    out = block([beat("Mara, Osei and Tam stand in the shop.",
                      ["Mara Vale", "Osei Kofi", "Tam Reed"])])
    assert CLOSE not in out["description"]


def test_a_voice_on_a_phone_does_not_block_the_claim():
    """A remote speaker is not a person the shot failed to stage, so their
    presence in the roster must not suppress the close."""
    out = block([beat("Mara's phone buzzes against her palm. Osei does not look up.",
                      ["Mara Vale", "Osei Kofi", "Tam Reed"],
                      [{"speaker": "Tam Reed", "line": "Keep nine o'clock free."}])])
    assert CLOSE in out["description"]


def test_a_block_with_no_cast_metadata_claims_nothing():
    """`meta.cast` is absent on hand-made and older beats; inventing a closed
    set from silence would forbid the extras a crowd scene needs."""
    out = block([{"action": "The shop is empty.", "camera": "a wide",
                  "duration_ms": 5000, "dialogue": [], "meta": {}}])
    assert CLOSE not in out["description"]


def test_the_clause_is_TERMINAL():
    """Same placement as the panel's, and as the style clause: H3 obeys a
    terminal negation and buries one written mid-paragraph."""
    out = block([beat("Mara sets the satchel down. Osei does not look up.",
                      ["Mara Vale", "Osei Kofi"])])
    assert out["description"].rstrip().endswith("in any shot.")

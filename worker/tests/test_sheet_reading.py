"""Reading a supplied reference sheet, instead of describing it from memory.

The failure this closes, traced through a real interview: the user attached
Guide Rei's sheet; five seconds later the director said "I'll use the attached
reference as Guide Rei's visual authority" and then restated its own invention
from two minutes earlier, word for word. Two turns on, handed the Astronaut
sheet, it wrote one sentence for two characters — "Guide Rei and flashback
Astronaut Rei will keep their exact visible designs, including the orange
astronaut suits". The sheet showed a brown coat.

The planner then did the right thing with the wrong data: the sheet became her
`face` anchor, while `full_body` and `turnaround` were composed from the
identity line — so slot 1 was the user's design and slots 2 and 3 were an
astronaut wearing her face. Nothing in the UI showed a disagreement.

Every case here guards a way of being quietly wrong: describing a picture
nobody looked at, erasing a written line on a failed read, or reading the sheet
AFTER the sheets that copy from it were queued.
"""
import pathlib

import pytest

import llm


SRC = (pathlib.Path(__file__).resolve().parents[1] / "llm.py").read_text()


class FakeSb:
    def __init__(self):
        self.patches = []

    def patch(self, path, body, want_rows=False):
        self.patches.append((path, body))
        return []


@pytest.fixture
def entry():
    return {"id": "e1", "name": "Guide Rei", "kind": "character",
            "identity_line": "orange astronaut jumpsuit with mission patches",
            "doc": {"voice": "warm"}}


def test_the_picture_replaces_the_written_line(monkeypatch, entry):
    f = FakeSb()
    monkeypatch.setattr(llm, "sb", f)
    monkeypatch.setattr(llm, "describe_ref_sheet",
                        lambda url, model=None: {"identity": "brown utility coat, dark trousers",
                                                 "confidence": "high", "reader": "gpt-5.6-luna"})
    llm._reconcile_identity(entry, "https://cdn/x.png", None)
    assert entry["identity_line"] == "brown utility coat, dark trousers"
    body = f.patches[0][1]
    assert body["identity_line"] == "brown utility coat, dark trousers"
    # what the writer wrote is kept, not destroyed — it carries story detail a
    # picture cannot show, and losing it silently would be its own bug
    assert body["doc"]["identity_line_written"].startswith("orange astronaut")
    assert body["doc"]["sheet_identity"] == "brown utility coat, dark trousers"
    assert body["doc"]["voice"] == "warm"


def test_an_unread_sheet_leaves_the_written_line_alone(monkeypatch, entry):
    """A description nobody could read is not grounds for erasing one somebody
    wrote."""
    f = FakeSb()
    monkeypatch.setattr(llm, "sb", f)
    monkeypatch.setattr(llm, "describe_ref_sheet", lambda url, model=None: None)
    llm._reconcile_identity(entry, "https://cdn/x.png", None)
    assert f.patches == []
    assert entry["identity_line"].startswith("orange astronaut")


def test_a_reader_that_throws_never_costs_the_plan(monkeypatch, entry):
    f = FakeSb()
    monkeypatch.setattr(llm, "sb", f)

    def boom(url, model=None):
        raise RuntimeError("ollama is not up")
    monkeypatch.setattr(llm, "describe_ref_sheet", boom)
    llm._reconcile_identity(entry, "https://cdn/x.png", None)
    assert f.patches == []


def test_an_empty_description_counts_as_unread(monkeypatch, entry):
    f = FakeSb()
    monkeypatch.setattr(llm, "sb", f)
    monkeypatch.setattr(llm, "describe_ref_sheet",
                        lambda url, model=None: {"identity": "", "confidence": "low"})
    llm._reconcile_identity(entry, "https://cdn/x.png", None)
    assert f.patches == []


# ------------------------------------------------------- picking a reader ---
def test_no_named_vision_model_means_the_local_one(monkeypatch):
    """A model that CANNOT see does not error, it confabulates — which is the
    exact failure being fixed. So the hosted path is used only when someone has
    named a model they know reads images."""
    monkeypatch.setattr(llm, "VISION_MODEL", "")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    calls = []
    monkeypatch.setattr(llm.requests, "post",
                        lambda *a, **k: calls.append(a) or pytest.fail("hosted was tried"))
    monkeypatch.setattr(llm.requests, "get",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no net")))
    assert llm.describe_ref_sheet("https://cdn/x.png") is None
    assert calls == []


def test_a_named_model_is_asked_over_the_public_url(monkeypatch):
    """The bucket is public (invariant #2), so the URL goes over as a URL and
    no image bytes pass through the worker."""
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    seen = {}

    class R:
        status_code = 200

        @staticmethod
        def json():
            return {"choices": [{"message": {"content":
                    '{"identity": "brown coat", "confidence": "high"}'}}]}

    def post(url, **kw):
        seen["url"], seen["body"] = url, kw.get("json")
        return R()
    monkeypatch.setattr(llm.requests, "post", post)
    out = llm.describe_ref_sheet("https://cdn/x.png", model="gpt-5.6-luna")
    assert out["identity"] == "brown coat"
    assert out["reader"] == "gpt-5.6-luna"
    parts = seen["body"]["messages"][1]["content"]
    assert any(p.get("type") == "image_url"
               and p["image_url"]["url"] == "https://cdn/x.png" for p in parts)


def test_a_hosted_failure_falls_through_to_the_local_reader(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")

    class Bad:
        status_code = 500
        text = "upstream exploded"
    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: Bad())

    class Img:
        content = b"\x89PNG"
        headers = {"content-type": "image/png"}

        @staticmethod
        def raise_for_status():
            return None
    monkeypatch.setattr(llm.requests, "get", lambda *a, **k: Img())
    import vlm
    monkeypatch.setattr(vlm, "describe_sheet",
                        lambda images, model=None: {"identity": "brown coat", "confidence": "high"})
    out = llm.describe_ref_sheet("https://cdn/x.png", model="gpt-5.6-luna")
    assert out["identity"] == "brown coat"
    assert out["reader"] == vlm.VLM_MODEL


def test_prose_instead_of_json_is_still_a_description(monkeypatch):
    assert llm._parse_sheet_reply("A woman in a brown coat.")["identity"] \
        == "A woman in a brown coat."
    assert llm._parse_sheet_reply("") is None
    assert llm._parse_sheet_reply('{"identity": "  a  b  "}')["identity"] == "a b"


# --------------------------------------------------------------- ordering ---
def test_the_read_happens_before_the_sheets_that_copy_from_it():
    """`full_body` and `turnaround` are composed FROM the identity line. Reading
    the sheet after they are queued corrects a line nothing will read again."""
    attach_at = SRC.index("user_refs = attach_user_refs(")
    queue_at = SRC.index('if payload.get("plan_refs", True):')
    assert attach_at < queue_at


def test_the_reader_is_never_the_text_only_fallback_chain():
    """`complete()` walks text-only backends; a picture landing on one comes
    back as a plausible sentence about nothing."""
    fn = SRC.split("def describe_ref_sheet")[1].split("def _parse_sheet_reply")[0]
    body = fn.split('"""', 2)[2]            # past the docstring, which SAYS "complete()"
    assert "complete(" not in body
    assert "backend_chain" not in body
    # what it does reach for instead
    assert "vlm.SHEET_SYSTEM" in body and "vlm.describe_sheet" in body


# --------------------------------------------------- what the picture IS ---
# Position alone was wrong in the ordinary case. A user attaching one sheet per
# character attaches TURNAROUNDS — several views, often captioned "SIDE VIEW /
# BACK VIEW" — and the ladder filed every one as `face`, so the planner drew a
# full body and a turnaround it had already been given, and the drawn
# turnaround then competed with the supplied one.
def test_a_turnaround_is_filed_as_a_turnaround():
    got = llm.user_ref_slots("character", ["a"], {"a": "turnaround"})
    assert got == [("a", "turnaround")]


def test_the_ladder_still_covers_a_sheet_nobody_could_read():
    assert llm.user_ref_slots("character", ["a"], {}) == [("a", "face")]
    assert llm.user_ref_slots("character", ["a", "b"], {"b": "turnaround"}) == [
        ("a", "face"), ("b", "turnaround")]


def test_two_sheets_never_collide_on_one_slot():
    """Two turnarounds of one character is a real thing to attach; the second
    must not silently overwrite the first."""
    got = llm.user_ref_slots("character", ["a", "b"], {"a": "turnaround", "b": "turnaround"})
    assert got[0] == ("a", "turnaround")
    assert got[1][1] != "turnaround"


def test_a_kind_the_entry_cannot_hold_falls_back():
    """`image_prompt` shoots a location as a location; a `full_body` slot on one
    is a framing it has no use for."""
    assert llm.user_ref_slots("environment", ["a"], {"a": "full_body"}) == [("a", "master")]
    assert llm.user_ref_slots("environment", ["a"], {"a": "detail"}) == [("a", "detail")]


def test_a_prop_is_a_prop_whatever_the_reader_calls_it():
    assert llm.user_ref_slots("prop", ["a"], {"a": "full_body"}) == [("a", "ref")]


def test_a_supplied_turnaround_means_only_the_face_is_drawn():
    """The turnaround IS the full body — `ref_plan_for` stages it in place of
    one — so drawing a body sheet too spends a render on a view we were given."""
    assert llm.redundant_roles({"turnaround"}) == {"full_body"}
    assert llm.redundant_roles({"face"}) == set()
    # and with a turnaround supplied, the queue's own guards then skip both
    covered = {"turnaround"} | llm.redundant_roles({"turnaround"})
    assert "full_body" in covered and "face" not in covered


def test_the_identity_comes_from_the_sheet_that_shows_the_most(monkeypatch):
    """A face crop states a third of a design; a turnaround states all of it."""
    best = max([{"kind": "face", "confidence": "high", "identity": "a face"},
                {"kind": "turnaround", "confidence": "medium", "identity": "the whole design"}],
               key=lambda g: (("turnaround", "full_body", "master").count(g.get("kind") or ""),
                              {"high": 2, "medium": 1}.get(g.get("confidence"), 0)))
    assert best["identity"] == "the whole design"


def test_a_face_derived_from_a_supplied_sheet_renders_on_h3():
    """Measured, not assumed. Three characters, same anchors, same prompt:
    krea2 ignored the `face` framing and returned a FULL BODY every time —
    with and without the identity LoRA — because its reference path follows the
    reference's framing over the role's instruction. h3-image-turbo returned an
    actual head-and-shoulders plate for all three, holding hair, streak and
    eyes."""
    body = SRC.split("face_job_by_entry = {}")[1].split("# Returning cast")[0]
    assert 'derive_from = [r for r in ("turnaround", "full_body", "side") if r in mine]' in body
    assert '"model_key": "h3-image-turbo"' in body
    assert '"anchor_roles": derive_from' in body


def test_the_identity_lora_is_not_used_on_a_derived_face():
    """Tried, and the renders refused it: Guide Rei came back with a duplicated
    torso, a floating jacket and half-teal hair, while the identical job without
    it was clean. On a composition this adapter damages the picture whatever is
    in frame — which is the NEONFALL finding, not an exception to it."""
    body = SRC.split("face_job_by_entry = {}")[1].split("# Returning cast")[0]
    assert '"key": "identity"' not in body


def test_a_character_with_no_supplied_sheet_keeps_the_plain_face_plate():
    """The base rule is unchanged where it was measured: no anchor, no LoRA."""
    body = SRC.split("face_job_by_entry = {}")[1].split("# Returning cast")[0]
    assert 'else:\n                    face_j = sheet_job(row, "face")' in body

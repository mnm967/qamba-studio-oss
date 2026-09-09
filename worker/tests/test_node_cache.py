"""What the worker believes about ComfyUI's installed nodes, and for how long.

Every capability check in the worker goes through `_has_node`, and every one of
them degrades silently when the answer is wrong: a chained block drops to the
last-frame anchor, a Krea 2 reference job renders on Klein. The dangerous case
is not a stale answer but a NON-answer — systemd starts neon-worker and comfyui
together and ComfyUI listens minutes later, so "connection refused" is the
normal state at the start of every boot and it must not be filed as "absent"
for the next five minutes.
"""
import pytest

import handlers.images as images


@pytest.fixture(autouse=True)
def clean_cache():
    images._NODES.clear()
    yield
    images._NODES.clear()


def test_unreachable_comfyui_is_re_asked_in_seconds(monkeypatch):
    def refused():
        raise OSError("[Errno 111] Connection refused")

    monkeypatch.setattr(images.comfy, "object_info", refused)
    assert images._has_node("MiniMaxH3MotionContext") is False
    assert images._NODES["ttl"] == images._NODE_TTL_UNREACHABLE

    # ComfyUI finishes booting a few seconds later — the very next job must see
    # it, not wait out the full negative TTL.
    images._NODES["at"] -= images._NODE_TTL_UNREACHABLE + 1
    monkeypatch.setattr(images.comfy, "object_info",
                        lambda: {"MiniMaxH3MotionContext": {"input": {}}})
    assert images._has_node("MiniMaxH3MotionContext") is True


def test_a_real_absence_still_holds_for_the_full_ttl(monkeypatch):
    """ComfyUI answering "no such node" IS an answer: /object_info is a big
    response, and re-fetching it per job for a pack nobody installed is waste."""
    monkeypatch.setattr(images.comfy, "object_info", lambda: {"SomethingElse": {}})
    assert images._has_node("Krea2EditRebalance") is False
    assert images._NODES["ttl"] == images._NODE_TTL

    asked = []
    monkeypatch.setattr(images.comfy, "object_info",
                        lambda: asked.append(1) or {"Krea2EditRebalance": {}})
    images._NODES["at"] -= images._NODE_TTL_UNREACHABLE + 1   # still inside 300s
    assert images._has_node("Krea2EditRebalance") is False
    assert asked == []

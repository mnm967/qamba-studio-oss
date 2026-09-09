"""ComfyUI's preview frames are the one thing it does not expose over HTTP, so
the worker holds a websocket for them. The socket itself needs a pod; the wire
format does not, and getting it wrong is silent — a misparsed frame publishes a
corrupt JPEG rather than raising.

Layout (comfy/server.py, BinaryEventTypes): 4-byte big-endian event type, then
4-byte big-endian image format, then the encoded image.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import comfy


@pytest.fixture
def tap(monkeypatch):
    """A tap with no thread — _run is what needs a socket, _take is pure."""
    monkeypatch.setattr(comfy.threading, "Thread",
                        lambda *a, **k: type("T", (), {"start": lambda s: None})())
    return comfy._PreviewTap("test-client")


def _frame(event, fmt, body):
    return event.to_bytes(4, "big") + fmt.to_bytes(4, "big") + body


def test_a_preview_frame_is_unwrapped_to_its_image_bytes(tap):
    tap._take(_frame(1, 1, b"\xff\xd8jpegbody"))
    seq, content_type, blob = tap.frame
    assert (content_type, blob) == ("image/jpeg", b"\xff\xd8jpegbody")
    assert seq == 1


def test_png_previews_carry_the_right_content_type(tap):
    tap._take(_frame(1, 2, b"\x89PNGbody"))
    assert tap.frame[1] == "image/png"


def test_seq_increases_so_a_caller_can_skip_a_frame_it_already_sent(tap):
    tap._take(_frame(1, 1, b"a"))
    tap._take(_frame(1, 1, b"b"))
    assert tap.frame[0] == 2 and tap.frame[2] == b"b"


def test_other_binary_events_are_ignored(tap):
    """ComfyUI sends more than previews down this socket. Publishing an
    unencoded-preview or a text event as a .jpg would upload garbage."""
    tap._take(_frame(3, 1, b"not-a-preview"))
    assert tap.frame is None
    tap._take(_frame(1, 1, b"real"))
    tap._take(_frame(2, 1, b"other"))
    assert tap.frame[2] == b"real"          # unchanged by the later event


def test_a_truncated_frame_is_dropped_not_sliced(tap):
    tap._take(b"\x00\x00\x00")
    assert tap.frame is None


def test_an_empty_image_body_is_still_a_frame(tap):
    """Degenerate but legal: the header parsed, so it is a preview with no
    pixels — dropping it silently would look identical to a dead socket."""
    tap._take(_frame(1, 1, b""))
    assert tap.frame == (1, "image/jpeg", b"")

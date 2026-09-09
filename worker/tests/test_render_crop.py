"""The crop op's filter string.

Two things are silent when wrong and neither is caught by rendering the happy
case. A bare comma inside a filter argument SPLITS THE FILTERGRAPH, so
`crop=min(704,iw):...` is not a clamped crop — it is a syntax error naming a
filter called `iw)`, and it kills a timeline render after every block's GPU
time has already been spent. And an UNCLAMPED crop is a filter ffmpeg refuses
outright ("Invalid too big or non positive size"): a take swap patches
`asset_id` and keeps the ops, so a window written on a 1280x704 take routinely
meets a smaller retake.

Verified against the real binary as well as here: unquoted, ffmpeg answers
"No such filter: 'iw):min(100'"; quoted, a 704x704 window on a 320x180 source
clamps to 320x180 and renders.
"""
import re

from handlers import render


def vf(ops, **over):
    kw = {"width": 1280, "height": 704, "fps": 24, "has_audio": False}
    kw.update(over)
    return render.build_clip_filter(ops, **kw)[0]


def crop_arg(chain):
    """The crop filter, found the way ffmpeg finds it: split on the commas that
    are NOT inside quotes. A helper that just split on "," would reproduce the
    bug it is here to catch."""
    parts, buf, quoted = [], "", False
    for ch in chain:
        if ch == "'":
            quoted = not quoted
        if ch == "," and not quoted:
            parts.append(buf)
            buf = ""
        else:
            buf += ch
    parts.append(buf)
    return next(p for p in parts if p.startswith("crop="))


def test_the_window_is_the_one_that_was_asked_for():
    got = crop_arg(vf([{"op": "crop", "x": 288, "y": 0, "w": 704, "h": 704}]))
    assert re.fullmatch(
        r"crop='min\(704,iw\)':'min\(704,ih\)':"
        r"'max\(0,min\(288,iw-ow\)\)':'max\(0,min\(0,ih-oh\)\)'", got), got


def test_every_comma_in_the_crop_is_inside_quotes():
    """The whole filterchain is one -vf string; an unquoted comma ends the
    filter. Asserted structurally rather than on the exact text, so a future
    expression cannot reintroduce it."""
    chain = vf([{"op": "crop", "x": 288, "y": 0, "w": 704, "h": 704}])
    crop = crop_arg(chain)
    assert "," in crop, "the clamp is gone — an oversized rect will error"
    quoted = False
    for ch in crop:
        if ch == "'":
            quoted = not quoted
        elif ch == "," and not quoted:
            raise AssertionError(f"bare comma splits the filtergraph: {crop}")
    assert not quoted, f"unbalanced quote: {crop}"
    # And the chain really does still parse as crop -> ... -> fit -> fps.
    assert chain.split(",")[-1] == "fps=24"


def test_the_crop_precedes_the_fit_that_letterboxes_it():
    """crop -> scale decrease -> pad is what makes a 1:1 window a PILLARBOXED
    square rather than a zoom. src/lib/clipCrop.ts previews exactly this
    order; reversing it here would leave the stage lying."""
    chain = vf([{"op": "crop", "x": 288, "y": 0, "w": 704, "h": 704}])
    i_crop = chain.index("crop='min(704")
    assert i_crop < chain.index("force_original_aspect_ratio=decrease")
    assert chain.index("force_original_aspect_ratio=decrease") < chain.index("pad=1280:704")


def test_a_clip_with_no_crop_gets_no_crop_filter():
    assert "crop=" not in vf([])

"""The window a REVERSED clip mirrors.

Silent when wrong, in the most expensive way this repo has: the render
succeeds, the file plays, and it is a good-looking video of the wrong part of
the shot. `-t slot_ms` caps the FINISHED chain, so on a forward clip it trims
an overlong `[in_ms, out_ms]` down to what the slot plays — and on a reversed
one the reverse has already happened by then, so the same cap keeps the LAST
`slot` of source instead of the first.

The two agree whenever `out_ms == in_ms + slot_ms * rate`, which is every trim
gesture, and disagree after `_attach_to_clip` writes a whole render's length
into `out_ms` while only shrinking `duration_ms` — the normal state of a
generated take that came back longer than its block's slot.

The invariant these pin: TOGGLING REVERSE CHANGES THE ORDER OF THE FRAMES AND
NEVER WHICH FRAMES THEY ARE. Same window, one reversed, one not.
"""
import re

from handlers import render

REV = [{"op": "reverse"}]


def trim(ops, **over):
    kw = {"width": 1280, "height": 704, "fps": 24, "has_audio": True}
    kw.update(over)
    vf, af = render.build_clip_filter(ops, **kw)
    v = re.search(r"trim=start=([\d.]+)(?::end=([\d.]+))?", vf)
    a = re.search(r"atrim=start=([\d.]+)(?::end=([\d.]+))?", af)
    assert v and a, (vf, af)
    assert v.groups() == a.groups(), "picture and sound must cut the same window"
    return float(v.group(1)), (float(v.group(2)) if v.group(2) else None)


def test_an_overlong_out_ms_is_narrowed_to_the_window_the_clip_plays():
    # _attach_to_clip's own shape: the render came back 12s, the block's slot
    # is 3s. The clip plays [2.0, 5.0] and mirroring [2.0, 12.0] would show
    # 9 seconds of footage the slot never reaches.
    assert trim(REV, in_ms=2000, out_ms=12000, slot_ms=3000) == (2.0, 5.0)


def test_the_same_window_is_cut_whether_or_not_it_is_reversed():
    fwd = trim([], in_ms=2000, out_ms=12000, slot_ms=3000)
    # Forward keeps the wide trim because the -t cap lands correctly there;
    # what matters is the SOURCE both actually show, which is [2.0, 5.0].
    assert fwd[0] == 2.0
    assert trim(REV, in_ms=2000, out_ms=12000, slot_ms=3000)[1] == 5.0


def test_a_speed_op_stretches_the_window_the_same_way_the_preview_does():
    # 2x eats two seconds of source per second of timeline, so a 3s slot plays
    # [2.0, 8.0] — clipSourceAt's `in + duration * rate`.
    assert trim(REV + [{"op": "speed", "rate": 2}], in_ms=2000, out_ms=20000,
                slot_ms=3000) == (2.0, 8.0)
    assert trim(REV + [{"op": "speed", "rate": 0.5}], in_ms=0, out_ms=20000,
                slot_ms=4000) == (0.0, 2.0)


def test_an_out_ms_INSIDE_the_played_window_stands():
    # The media genuinely runs out there. Widening to the slot would ask for
    # frames that do not exist; the tpad clone fills the rest, as it does
    # forward.
    assert trim(REV, in_ms=0, out_ms=2000, slot_ms=6000) == (0.0, 2.0)


def test_a_reversed_clip_with_no_out_ms_is_still_bounded():
    # Unbounded, `reverse` buffers to the end of the FILE and the cap then
    # keeps its last seconds — the wrong end of a shot nobody trimmed.
    assert trim(REV, in_ms=1000, out_ms=None, slot_ms=2000) == (1.0, 3.0)


def test_the_post_chained_shape_is_bounded_too():
    # A post-chained clip is cut to `source_window` first and then re-rendered
    # with `{in_ms: 0, out_ms: None}` — the cut is spent, so leaving it on
    # would trim the window against its own zero. Unbounded, a reversed clip
    # there mirrored the whole WINDOW and the cap kept its last seconds; the
    # slot is what bounds it.
    assert trim(REV, in_ms=0, out_ms=None, slot_ms=3000) == (0.0, 3.0)


def test_nothing_changes_for_a_clip_that_is_not_reversed():
    assert trim([], in_ms=2000, out_ms=12000, slot_ms=3000) == (2.0, 12.0)
    assert trim([{"op": "speed", "rate": 2}], in_ms=0, out_ms=9000,
                slot_ms=1000) == (0.0, 9.0)


def test_without_a_slot_the_callers_window_stands():
    # The freeze path splits a clip into pieces whose slot is only their sum,
    # so it passes none — narrowing a piece would cut real content.
    assert trim(REV, in_ms=2000, out_ms=12000) == (2.0, 12.0)
    assert trim(REV, in_ms=2000, out_ms=12000, slot_ms=0) == (2.0, 12.0)


def test_the_rate_is_compounded_and_floored_like_the_filter_chain():
    assert render.speed_rate([]) == 1.0
    assert render.speed_rate([{"op": "speed", "rate": 2}]) == 2.0
    assert render.speed_rate([{"op": "speed", "rate": 2},
                              {"op": "speed", "rate": 3}]) == 6.0
    # max(0.05, …) is the chain's own floor, so a corrupt rate cannot make the
    # window zero-width.
    assert render.speed_rate([{"op": "speed", "rate": 0}]) == 1.0
    assert render.speed_rate([{"op": "speed", "rate": -4}]) == 0.05


def test_the_reversed_clips_whose_window_moved_lose_their_cache_entry():
    """Their cached intermediate is footage from the wrong end of the shot, so
    it has to be re-rendered — and NOTHING else may be, or one fix invalidates
    every clip on every timeline.

    Asserted on the payload rather than on the digest: `fit_ms` alone already
    changes the hash, so comparing two hashes proves nothing about the key
    this is here to pin.
    """
    seen = {}
    real = render.hashlib.sha1

    def spy(blob):
        seen.clear()
        seen.update(render.json.loads(blob.decode()))
        return real(blob)

    render.hashlib.sha1 = spy
    try:
        asset = {"b2_key": "k"}
        kw = {"fps": 24, "width": 1280, "height": 704}
        base = {"in_ms": 2000, "out_ms": 12000, "duration_ms": 3000}

        render.op_hash(asset, {**base, "ops": REV}, fit_ms=3000, **kw)
        assert seen.get("rev") == 2, seen

        # A reversed clip whose trim already agrees with its slot never gets
        # `fit` at all, so it keeps the entry it has.
        render.op_hash(asset, {**base, "ops": REV}, fit_ms=None, **kw)
        assert "rev" not in seen, seen

        # And no forward clip loses one, however its trim and slot disagree.
        render.op_hash(asset, {**base, "ops": []}, fit_ms=3000, **kw)
        assert "rev" not in seen, seen
        render.op_hash(asset, {**base, "ops": [{"op": "speed", "rate": 2}]},
                       fit_ms=3000, **kw)
        assert "rev" not in seen, seen
    finally:
        render.hashlib.sha1 = real

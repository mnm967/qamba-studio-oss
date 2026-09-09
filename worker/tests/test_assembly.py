"""The assembly renderer is one ffmpeg command, and every way it can be wrong
is silent in the output file: a slice trimmed at the wrong timestamps shows the
wrong moment, a missed interleave makes concat pair the wrong audio with the
wrong picture, and a length nobody agrees on comes out however long ffmpeg
makes it. So the filtergraph is built by a pure function and pinned here.

An assembly is an ordered list of SLICES — a take plus a window inside it —
laid end to end. It used to have to tile [0, duration_ms) as well, which is why
several of these read as "still true, for a different reason": the filtergraph
always trimmed each slice at its own timestamps and concatenated them in list
order, so what the freedom changed is `validate` and nothing else.
"""
import pytest

import assembly as A


def seg(t, a, b):
    return {"take_id": t, "in_ms": a, "out_ms": b}


THREE = [seg("t1", 0, 5200), seg("t2", 5200, 8700), seg("t1", 8700, 14000)]


# ---------------------------------------------------------------- validate ---
def test_valid_assemblies_pass():
    assert A.validate(THREE, 14000)                      # a tiling, still legal
    assert A.validate([seg("t1", 0, 14000)], 14000)


def test_slices_need_not_tile_anything():
    # The change: pieces in any order, from anywhere in their takes, with the
    # same moment used twice. The renderer's job is to lay them end to end.
    out_of_order = [seg("t2", 9000, 12000), seg("t1", 0, 3000), seg("t2", 9000, 10500)]
    assert A.validate(out_of_order, 7500)
    assert A.cut_times(out_of_order) == [(0, 3000), (3000, 6000), (6000, 7500)]


def test_a_length_nobody_agrees_on_is_refused():
    # `duration_ms` is written by whoever built the assembly. If it disagrees
    # with the slices, one of the two did the arithmetic wrong — and the mp4
    # would come out at the ffmpeg length either way, with nothing to notice.
    with pytest.raises(A.AssemblyError, match="runs 9000ms, but says it is 14000ms"):
        A.validate([seg("t1", 0, 9000)], 14000)
    with pytest.raises(A.AssemblyError, match="no segments"):
        A.validate([], 14000)


def test_a_slice_that_runs_backwards_or_starts_before_its_take_is_refused():
    with pytest.raises(A.AssemblyError, match="is empty"):
        A.validate([seg("t1", 8000, 5000)], 3000)
    with pytest.raises(A.AssemblyError, match="starts before its take does"):
        A.validate([seg("t1", -500, 5000)], 5500)


def test_a_flicker_span_is_refused_rather_than_rendered():
    # 100ms reads as a decode glitch in the finished file, not as a choice.
    with pytest.raises(A.AssemblyError, match="below the 250ms floor"):
        A.validate([seg("t1", 0, 7000), seg("t2", 7000, 7100), seg("t1", 7100, 14000)], 14000)


def test_a_segment_naming_no_take_is_refused():
    with pytest.raises(A.AssemblyError, match="names no take"):
        A.validate([{"take_id": None, "in_ms": 0, "out_ms": 14000}], 14000)


# ------------------------------------------------------------ plan_inputs ----
def test_a_take_used_twice_is_one_input():
    assert A.plan_inputs(THREE) == ["t1", "t2"]


# --------------------------------------------------------- build_filtergraph -
def test_each_span_trims_its_own_take_at_its_own_timestamps():
    fc, maps, want_audio = A.build_filtergraph(THREE, {"t1": 0, "t2": 1})
    assert want_audio and maps == ["-map", "[v]", "-map", "[a]"]
    assert "[0:v]trim=start=0.000:end=5.200,setpts=PTS-STARTPTS[v0]" in fc
    assert "[1:v]trim=start=5.200:end=8.700,setpts=PTS-STARTPTS[v1]" in fc
    # the third span comes from t1 again — same input, its own window
    assert "[0:v]trim=start=8.700:end=14.000,setpts=PTS-STARTPTS[v2]" in fc


def test_a_reordered_cut_trims_each_take_where_the_piece_came_from():
    # The half of the model the renderer never had to learn: order is the cut,
    # the trim is the source, and concat puts them together in list order.
    segs = [seg("t2", 9000, 12000), seg("t1", 0, 3000)]
    fc, _maps, _a = A.build_filtergraph(segs, {"t1": 0, "t2": 1})
    assert "[1:v]trim=start=9.000:end=12.000,setpts=PTS-STARTPTS[v0]" in fc
    assert "[0:v]trim=start=0.000:end=3.000,setpts=PTS-STARTPTS[v1]" in fc
    assert "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" in fc


def test_concat_interleaves_video_and_audio_per_segment():
    fc, _maps, _a = A.build_filtergraph(THREE, {"t1": 0, "t2": 1})
    assert "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]" in fc


def test_audio_fades_only_at_internal_joins():
    fc, _maps, _a = A.build_filtergraph(THREE, {"t1": 0, "t2": 1}, fade_ms=20)
    a0 = next(p for p in fc.split(";") if p.endswith("[a0]"))
    a1 = next(p for p in fc.split(";") if p.endswith("[a1]"))
    a2 = next(p for p in fc.split(";") if p.endswith("[a2]"))
    # opening span: no fade IN (that would duck the block's first word)
    assert "afade=t=in" not in a0 and "afade=t=out" in a0
    assert "afade=t=in" in a1 and "afade=t=out" in a1
    # closing span: no fade OUT
    assert "afade=t=in" in a2 and "afade=t=out" not in a2


def test_a_fade_never_exceeds_a_third_of_its_span():
    short = [seg("t1", 0, 300), seg("t2", 300, 14000)]
    fc, _m, _a = A.build_filtergraph(short, {"t1": 0, "t2": 1}, fade_ms=200)
    a0 = next(p for p in fc.split(";") if p.endswith("[a0]"))
    assert "afade=t=out:st=0.200:d=0.100" in a0


def test_a_single_span_assembly_needs_no_fades_at_all():
    fc, _m, _a = A.build_filtergraph([seg("t1", 0, 14000)], {"t1": 0})
    assert "afade" not in fc
    assert "concat=n=1:v=1:a=1[v][a]" in fc


def test_silent_takes_draw_from_anullsrc_so_concat_sees_a_ragged_list_never():
    # An uploaded take with no audio next to an H3 take that has some: concat
    # refuses inputs with different stream counts, and the symptom is a hard
    # ffmpeg failure at the very end of a long assemble.
    fc, maps, want_audio = A.build_filtergraph(
        THREE, {"t1": 0, "t2": 1}, audio_of={"t1": True, "t2": False}, silent_index=2)
    assert want_audio and maps == ["-map", "[v]", "-map", "[a]"]
    assert "[2:a]atrim=start=0:end=3.500" in fc
    assert "[1:a]" not in fc
    assert "concat=n=3:v=1:a=1[v][a]" in fc


def test_mixed_audio_without_a_silence_input_is_an_error_not_a_bad_render():
    with pytest.raises(A.AssemblyError, match="silent_index required"):
        A.build_filtergraph(THREE, {"t1": 0, "t2": 1}, audio_of={"t1": True, "t2": False})


def test_all_silent_takes_produce_a_video_only_concat():
    fc, maps, want_audio = A.build_filtergraph(
        THREE, {"t1": 0, "t2": 1}, audio_of={"t1": False, "t2": False})
    assert not want_audio and maps == ["-map", "[v]"]
    assert "concat=n=3:v=1:a=0[v]" in fc
    assert ":a]" not in fc


def test_every_span_is_fitted_to_one_geometry_before_concat():
    # concat rejects inputs whose size / SAR / frame rate disagree, and an
    # uploaded take beside an H3 render is exactly that. The fit is a visual
    # no-op when they already match.
    fc, _m, _a = A.build_filtergraph(THREE, {"t1": 0, "t2": 1},
                                     width=1280, height=720, fps=24)
    for i in range(3):
        v = next(p for p in fc.split(";") if p.endswith(f"[v{i}]"))
        assert "scale=1280:720:force_original_aspect_ratio=decrease" in v
        assert "pad=1280:720:(ow-iw)/2:(oh-ih)/2" in v
        assert "setsar=1" in v and "fps=24" in v
        assert v.index("trim=") < v.index("scale=")     # trim first, then fit
    a0 = next(p for p in fc.split(";") if p.endswith("[a0]"))
    assert "aformat=sample_rates=48000:channel_layouts=stereo" in a0


def test_geometry_is_omitted_when_the_caller_does_not_know_it():
    fc, _m, _a = A.build_filtergraph(THREE, {"t1": 0, "t2": 1})
    assert "scale=" not in fc and "fps=" not in fc


def test_describe_reads_as_the_cut_it_is():
    # The times are the SOURCE windows — where in each take a piece came from,
    # which is what a person diagnosing a cut wants.
    assert A.describe(THREE, {"t1": "take 1", "t2": "take 2"}) == (
        "take 1 0.0-5.2 | take 2 5.2-8.7 | take 1 8.7-14.0")


def test_describe_marks_a_piece_that_does_not_play_where_it_came_from():
    # `@` appears exactly when the cut is something the tiling could not have
    # expressed, so a log line says which kind of assembly this was.
    assert A.describe([seg("t2", 9000, 12000), seg("t1", 0, 3000)],
                      {"t1": "take 1", "t2": "take 2"}) == (
        "take 2 9.0-12.0 @0.0 | take 1 0.0-3.0 @3.0")

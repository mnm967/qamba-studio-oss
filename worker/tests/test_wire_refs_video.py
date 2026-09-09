"""A reference VIDEO is loaded at half the render's linear size, and the rule
exists because of a measurement, not a preference: the H3 ref node scales ref
IMAGES down to the generation's pixel area but encodes ref VIDEOS at their own
resolution, and reference tokens ride through every sampling step — so the
video_edit path (a full-length source staged as <Video 1>) exactly doubled the
DiT sequence and died with `Allocation on device` on the FIRST sampling step,
three times out of three, on the 96GB card (2026-08-23). Half linear is a
quarter of the tokens and keeps the full temporal structure, which is the half
an edit must preserve — temporal subsampling would read as double-speed motion,
since the node takes the batch as frames at 24 fps.

Every assertion here reads the VHS_LoadVideo node out of a real resolve() on
the real model_map, because the failure mode is a graph that validates, submits
and dies minutes later on the pod.
"""
import json
import os

import pytest

import resolve as R

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def mm(monkeypatch):
    with open(os.path.join(ROOT, "infra", "model_map.full.json")) as f:
        full = json.load(f)
    monkeypatch.setattr(R, "ensure_model", lambda model, mm=None: full["full"]["models"][model])
    monkeypatch.setattr(R, "TIER", "full")
    return full


def _edit(mm, videos, frames=328, **kw):
    kw.setdefault("width", 1280)
    kw.setdefault("height", 736)
    return R.resolve("minimax-h3", "r2v", positive="edit", negative="", seed=7,
                     length=frames, exact_frames=frames, ref_videos=videos,
                     mm=mm, **kw)


def _vhs(res):
    nodes = [n for n in res["graph"].values()
             if isinstance(n, dict) and n.get("class_type") == "VHS_LoadVideo"]
    assert nodes, "the ref video must load through VHS_LoadVideo"
    return nodes[0]["inputs"]


def test_a_full_size_ref_video_is_loaded_at_half_the_render_width(mm):
    ins = _vhs(_edit(mm, [{"name": "take.mp4", "width": 1280, "height": 736}]))
    assert ins["custom_width"] == 640, ins
    # Height 0 keeps the source aspect — VHS derives it and rounds to /8, so a
    # mismatched-AR reference is scaled, never stretched.
    assert ins["custom_height"] == 0, ins


def test_the_cap_snaps_to_32_so_the_nodes_canvas_rounding_cannot_move_it(mm):
    ins = _vhs(_edit(mm, ["take.mp4"], width=864, height=480))
    assert ins["custom_width"] == 416          # 864/2=432 -> floor to /32
    assert ins["custom_width"] % 32 == 0


def test_a_source_already_at_or_below_the_cap_keeps_its_native_size(mm):
    # VHS scales UP as readily as down, and an upscaled reference is pure
    # token waste — the guard only fires when the caller states the dims.
    ins = _vhs(_edit(mm, [{"name": "small.mp4", "width": 512, "height": 288}]))
    assert ins["custom_width"] == 0, ins


def test_a_bare_string_entry_still_gets_the_cap(mm):
    # Legacy callers pass filenames; unknown dims take the cap regardless,
    # because larger-than-half-render is the common case and the failure the
    # cap prevents is an instant OOM.
    ins = _vhs(_edit(mm, ["take.mp4"]))
    assert ins["custom_width"] == 640, ins


def test_the_frame_load_cap_is_the_renders_own_count(mm):
    # The node truncates ref frames at the render's frame count anyway —
    # loading past it spends decode time and RAM on frames it will discard.
    assert _vhs(_edit(mm, ["take.mp4"], frames=158))["frame_load_cap"] == 158
    # …and the node's own 15s ceiling still binds when the render is longer.
    assert _vhs(_edit(mm, ["take.mp4"], frames=379))["frame_load_cap"] == 360


def test_ref_images_are_untouched_by_the_video_cap(mm):
    res = _edit(mm, [{"name": "take.mp4", "width": 1280, "height": 736}],
                ref_images=["face.png"])
    loads = [n for n in res["graph"].values()
             if isinstance(n, dict) and n.get("class_type") == "LoadImage"]
    assert loads and loads[0]["inputs"] == {"image": "face.png"}

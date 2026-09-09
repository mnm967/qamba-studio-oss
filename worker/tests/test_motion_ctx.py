"""Motion-context wiring against BOTH live packs.

Two forks of ComfyUI-H3-Motion-Context are in circulation and they disagree
about this node's signature. MultiRef (seitanism — the one the pod installs,
because it lets pinned motion coexist with our Ref2VA identity refs) keeps
`context_length` an INT and keeps encode_mode/anchor_mode/crop/audio_mode as
real widgets; NikoDemon80 0.2.0+ made context_length a COMBO of legal 17n+5
strings ("5"/"22"/"39"/"56") and those four widgets internal constants. Both
carry context_latent (the lossless latent chaining path).

The wiring fits itself to the INSTALLED node's /object_info spec — these tests
pin the fit in both directions, because the failure modes are silent: an
illegal int fails validation on the enum pack, an off-grid int downgrades the
MultiRef pack to per-frame still guides with only a line in ComfyUI's log, and
a pinned window longer than the trim leaks the previous block's tail into the
content as a visible/audible repeat.
"""
import json
import os

import pytest

os.environ.setdefault("MODEL_TIER", "full")
os.environ.setdefault("WORKFLOWS_DIR", os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "workflows"))

import resolve as R

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The v0.2.0 node as /object_info reports it (shape-faithful subset).
MC_SPEC_V020 = {"input": {
    "required": {
        "conditioning": ["CONDITIONING"],
        "vae": ["VAE"],
        "latent": ["LATENT"],
        "context_length": [["22", "5", "39", "56"], {"default": "22"}],
    },
    "optional": {
        "context_frames": ["IMAGE"],
        "context_latent": ["LATENT"],
        "audio_vae": ["VAE"],
        "context_audio": ["AUDIO"],
        "audio_context_length": ["INT", {"default": 22, "min": 0, "max": 240}],
    },
}}


# The MultiRef node as /object_info reports it (shape-faithful subset): the
# original widget set, an INT context_length, plus the latent path.
MC_SPEC_MULTIREF = {"input": {
    "required": {
        "conditioning": ["CONDITIONING"],
        "vae": ["VAE"],
        "latent": ["LATENT"],
        "context_frames": ["IMAGE"],
        "context_length": ["INT", {"default": 39, "min": 1, "max": 9999}],
        "encode_mode": [["video", "frames"], {"default": "video"}],
        "anchor_mode": [["head", "before"], {"default": "head"}],
        "crop": [["disabled", "center"], {"default": "disabled"}],
        "audio_context_length": ["INT", {"default": 0, "min": 0, "max": 9999}],
        "audio_mode": [["timeline", "ref"], {"default": "timeline"}],
    },
    "optional": {
        "context_latent": ["LATENT"],
        "audio_vae": ["VAE"],
        "context_audio": ["AUDIO"],
    },
}}


def _h3_graph():
    """The skeleton every H3 template shares, as far as the wiring reads it."""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "h3.safetensors"}},
        "2": {"class_type": "MiniMaxH3ReferenceToVideo",
              "inputs": {"prompt": "x", "width": 1280, "height": 704, "length": 90}},
        "3": {"class_type": "BasicGuider",
              "inputs": {"model": ["1", 0], "conditioning": ["2", 0]}},
        "4": {"class_type": "SamplerCustomAdvanced",
              "inputs": {"guider": ["3", 0], "latent_image": ["2", 1]}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "h3_vae.safetensors"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": "h3_audio_vae.safetensors"}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["4", 0], "vae": ["5", 0]}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0]}},
    }


def _node(g, cls):
    hits = [n for n in g.values() if n.get("class_type") == cls]
    assert len(hits) == 1, f"expected exactly one {cls}, found {len(hits)}"
    return hits[0]


def _nid(g, cls):
    return next(nid for nid, n in g.items() if n.get("class_type") == cls)


def test_v020_snaps_enum_and_drops_dead_inputs():
    g = _h3_graph()
    R._wire_motion_context(g, {"video": "ctx.mp4", "context_length": 22,
                               "skip_frames": 10, "spec": MC_SPEC_V020})
    mc = _node(g, "MiniMaxH3MotionContext")
    assert mc["inputs"]["context_length"] == "22"          # enum string, not int
    for dead in ("encode_mode", "anchor_mode", "crop", "audio_mode"):
        assert dead not in mc["inputs"]
    assert mc["inputs"]["audio_context_length"] == 22
    # the guider now reads conditioning THROUGH the context node
    assert g["3"]["inputs"]["conditioning"] == [_nid(g, "MiniMaxH3MotionContext"), 0]
    # and the audio VAE was found by name
    assert mc["inputs"]["audio_vae"] == ["6", 0]


def test_v020_snap_rounds_down_never_up():
    """A near-ceiling block sheds warmup below 22; the pinned window must snap
    DOWN (to 5), because pinning more frames than the trim removes replays the
    previous block's tail inside the content window."""
    g = _h3_graph()
    R._wire_motion_context(g, {"video": "ctx.mp4", "context_length": 19,
                               "spec": MC_SPEC_V020})
    mc = _node(g, "MiniMaxH3MotionContext")
    assert mc["inputs"]["context_length"] == "5"
    # pinned audio follows the snapped picture window for the same reason
    assert mc["inputs"]["audio_context_length"] == 5


def test_v020_latent_path_wires_loader():
    g = _h3_graph()
    R._wire_motion_context(g, {"video": "ctx.mp4", "context_length": 22,
                               "latent_file": "/data/out/h3_context/b1/clip_00001_.safetensors",
                               "spec": MC_SPEC_V020})
    ld = _node(g, "MiniMaxH3MotionContextLoadLatent")
    assert ld["inputs"]["latent_path"].endswith("clip_00001_.safetensors")
    mc = _node(g, "MiniMaxH3MotionContext")
    assert mc["inputs"]["context_latent"] == [_nid(g, "MiniMaxH3MotionContextLoadLatent"), 0]
    # frames stay wired as the node's own fallback
    assert "context_frames" in mc["inputs"]


def test_multiref_keeps_widgets_and_snaps_the_int():
    """MultiRef declares the widget set the enum pack dropped, so all four must
    survive the fit — and its INT context_length has to be put on the 17n+5
    grid HERE, because the node only reads a run of frames as one motion guide
    when it is on that grid; off-grid it silently degrades to n still guides."""
    g = _h3_graph()
    R._wire_motion_context(g, {"video": "ctx.mp4", "context_length": 22,
                               "skip_frames": 4, "spec": MC_SPEC_MULTIREF})
    mc = _node(g, "MiniMaxH3MotionContext")
    assert mc["inputs"]["context_length"] == 22       # INT, not "22"
    assert mc["inputs"]["encode_mode"] == "video"
    assert mc["inputs"]["anchor_mode"] == "head"      # 'before' is rejected there
    assert mc["inputs"]["crop"] == "disabled"
    assert mc["inputs"]["audio_mode"] == "timeline"
    # timeline mode refuses audio longer than the picture guide, so they match
    assert mc["inputs"]["audio_context_length"] == 22
    assert mc["inputs"]["context_frames"] == [_nid(g, "VHS_LoadVideo"), 0]
    assert g["3"]["inputs"]["conditioning"] == [_nid(g, "MiniMaxH3MotionContext"), 0]


def test_multiref_off_grid_warmup_snaps_down():
    """A near-ceiling block sheds warmup to 19 frames: pin 5, not 19. Rounding
    UP would replay the previous block's tail inside the delivered content."""
    g = _h3_graph()
    R._wire_motion_context(g, {"video": "ctx.mp4", "context_length": 19,
                               "spec": MC_SPEC_MULTIREF})
    mc = _node(g, "MiniMaxH3MotionContext")
    assert mc["inputs"]["context_length"] == 5
    assert mc["inputs"]["audio_context_length"] == 5


def test_multiref_latent_path_wires_loader():
    g = _h3_graph()
    R._wire_motion_context(g, {"video": "ctx.mp4", "context_length": 39,
                               "latent_file": "/data/out/h3_context/b1/clip_00001_.safetensors",
                               "spec": MC_SPEC_MULTIREF})
    mc = _node(g, "MiniMaxH3MotionContext")
    assert mc["inputs"]["context_length"] == 39
    assert mc["inputs"]["context_latent"] == [_nid(g, "MiniMaxH3MotionContextLoadLatent"), 0]


def test_snap_never_rounds_up():
    assert [R._snap_context_frames(n) for n in (1, 4, 5, 6, 21, 22, 23, 38, 39, 56)] \
        == [1, 1, 5, 5, 5, 22, 22, 22, 39, 56]


def test_no_spec_keeps_legacy_keys_and_still_snaps():
    """spec=None (tests, or /object_info unreachable) keeps the widget shape
    both packs started from. The frame count is still snapped: 12 is off-grid
    for either of them, and nothing downstream would say so."""
    g = _h3_graph()
    R._wire_motion_context(g, {"video": "ctx.mp4", "context_length": 12})
    mc = _node(g, "MiniMaxH3MotionContext")
    assert mc["inputs"]["context_length"] == 5
    assert mc["inputs"]["encode_mode"] == "video"
    assert mc["inputs"]["anchor_mode"] == "head"
    assert "context_latent" not in mc["inputs"]


def test_pre020_spec_never_gets_latent_loader():
    """A latent file on disk + an OLD installed pack must not add a node the
    pack doesn't have."""
    old_spec = {"input": {"required": {
        "conditioning": ["CONDITIONING"], "vae": ["VAE"], "latent": ["LATENT"],
        "context_length": ["INT", {"default": 12}],
        "encode_mode": [["video", "frame"]], "anchor_mode": [["head"]],
        "crop": [["disabled"]], "audio_mode": [["timeline"]],
        "audio_context_length": ["INT", {"default": 22}],
    }, "optional": {"context_frames": ["IMAGE"], "audio_vae": ["VAE"],
                    "context_audio": ["AUDIO"]}}}
    g = _h3_graph()
    R._wire_motion_context(g, {"video": "ctx.mp4", "context_length": 12,
                               "latent_file": "/x/clip.safetensors",
                               "spec": old_spec})
    assert not [n for n in g.values()
                if n.get("class_type") == "MiniMaxH3MotionContextLoadLatent"]
    mc = _node(g, "MiniMaxH3MotionContext")
    assert "context_latent" not in mc["inputs"]
    assert mc["inputs"]["context_length"] == 5      # snapped off the 17n+5 grid


def test_context_save_reads_sampler_latent():
    g = _h3_graph()
    assert R._wire_context_save(g, {"prefix": "h3_context/blk1/clip"}) is True
    sv = _node(g, "MiniMaxH3MotionContextSaveLatent")
    # the SAME link the video decode reads — the sampler's AV latent
    assert sv["inputs"]["latent"] == ["4", 0]
    assert sv["inputs"]["filename_prefix"] == "h3_context/blk1/clip"


def test_context_save_noop_off_h3():
    """A Wan graph has a VAEDecode too, but its latent is not an H3 AV pair —
    the save must refuse rather than write junk the next block would load."""
    g = {
        "1": {"class_type": "KSampler", "inputs": {}},
        "2": {"class_type": "VAEDecode", "inputs": {"samples": ["1", 0]}},
        "3": {"class_type": "SaveVideo", "inputs": {"video": ["2", 0]}},
    }
    before = json.loads(json.dumps(g))
    assert R._wire_context_save(g, {"prefix": "h3_context/blk1/clip"}) is False
    assert g == before

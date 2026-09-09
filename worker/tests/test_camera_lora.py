"""The camera-motion adapter: which shots qualify, and how a block gets it.

Same shape as the fight adapter and pinned the same way — the stamp is what
`launch_render` writes, the auto-apply is `_block_loras`, and neither may
double-add or reach for a key the model does not declare.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import handlers.blocks as B  # noqa: E402


def test_moves_the_adapter_is_for_qualify_and_pans_and_holds_do_not():
    yes = ["a medium close-up; the camera pushes in with small amplitude at slow speed",
           "wide; the camera tracks laterally with large amplitude",
           "the camera arcs around the pair", "a slow orbit around the two",
           "the camera cranes up to reveal the hall", "a dynamic handheld following the action",
           "aerial drone descending over the ridge", "the camera tilts down to his feet",
           "the camera pulls back to a wide"]
    no = ["a medium close-up; the camera holds a static shot on her face",
          "wide, high angle, deep focus", "the camera pans left across the room", ""]
    for c in yes:
        assert B.camera_moves(c), c
    for c in no:
        assert not B.camera_moves(c), c


def test_a_camera_block_gets_the_adapter_where_the_model_declares_it(monkeypatch):
    monkeypatch.setattr(B.R, "ensure_model",
                        lambda m: {"style_loras": {"camera": "cam.safetensors",
                                                   "combat": "c.safetensors"}})
    picks = B._block_loras({"params": {"camera_motion": True}}, model="minimax-h3-pdd")
    assert picks == [{"key": "camera", "strength": B.CAMERA_STRENGTH}]


def test_fight_and_camera_stack_and_a_user_pick_keeps_its_strength(monkeypatch):
    monkeypatch.setattr(B.R, "ensure_model",
                        lambda m: {"style_loras": {"camera": "cam.safetensors",
                                                   "combat": "c.safetensors"}})
    picks = B._block_loras({"params": {"fight": True, "camera_motion": True,
                                       "loras": [{"key": "camera", "strength": 0.7}]}},
                           model="minimax-h3")
    assert picks == [{"key": "camera", "strength": 0.7},
                     {"key": "combat", "strength": B.FIGHT_STRENGTH}]


def test_a_model_without_the_key_is_left_alone(monkeypatch):
    monkeypatch.setattr(B.R, "ensure_model", lambda m: {"style_loras": {"combat": "c"}})
    assert B._block_loras({"params": {"camera_motion": True}}, model="ltx-25") is None


def test_a_lookup_that_raises_fails_open(monkeypatch):
    def boom(m):
        raise RuntimeError("blip")
    monkeypatch.setattr(B.R, "ensure_model", boom)
    picks = B._block_loras({"params": {"camera_motion": True}}, model="minimax-h3")
    assert picks == [{"key": "camera", "strength": B.CAMERA_STRENGTH}]


def test_the_flag_is_a_block_flag():
    assert "camera_motion" in B._BLOCK_FLAGS
    assert "latent_upscale" in B._BLOCK_FLAGS

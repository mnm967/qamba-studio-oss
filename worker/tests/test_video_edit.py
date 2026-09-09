"""`video_edit` is what "Edit a take" queues, and it had three gaps that each
made the modal above it tell a lie.

It pinned H3_MODEL whatever the caller picked, so an edit queued from a modal
whose header reads "MiniMax H3 · Turbo" rendered on the 20-step base with
nothing on screen to say so — the same silent downgrade `handle_clip_gen` had
until `model_key` reached it. It computed its length with H3's own `pad17` and
handed it over as `exact_frames`, which resolve() is documented to TRUST. And
it never wrote a terminal status back onto the block, so a block queued through
`queueBlockRender` (which moves it to `queued` in the same breath) would spin
forever with its finished take sitting right there.

Source-parsed rather than executed: the handler drives ComfyUI and B2, and what
fails here is the decision, not the plumbing.
"""
import json
import os
import pathlib
import re

import pytest

import h3_timing
import resolve as R

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = (ROOT / "worker" / "handlers" / "blocks.py").read_text()
EDIT = SRC.split("def handle_video_edit(")[1].split("\ndef ")[0]
# Comments explain what was REPLACED and name it, so a check for an absent call
# has to read the code. Docstring lines go with them — close enough for this,
# and the alternative (an ast walk) tests less than it looks like it does.
CODE = "\n".join(l for l in EDIT.splitlines() if not l.lstrip().startswith("#"))


@pytest.fixture
def aws(monkeypatch):
    """The real model_map, on the tier the pod runs — the grid keys this checks
    (`fps`, `frame_base`, `frame_rem`) are data, so stubbing them would test
    the stub."""
    with open(ROOT / "infra" / "model_map.full.json") as f:
        full = json.load(f)
    monkeypatch.setattr(R, "TIER", "full")
    monkeypatch.setattr(R, "load_map", lambda: full)
    return full


# ── the model is the caller's ───────────────────────────────────────────────

def test_the_checkpoint_comes_from_the_payload_and_falls_back_to_h3():
    assert 'payload.get("model_key") or H3_MODEL' in EDIT
    # …and is what resolve() is actually handed, not merely computed.
    assert re.search(r"R\.resolve\(\s*\n\s*model, \"r2v\"", EDIT), \
        "resolve must take the resolved model, not H3_MODEL"


def test_the_lora_stack_reaches_the_render():
    # A pick that is resolved, logged and then dropped is how the video side's
    # concept LoRAs were silently absent from every episode for their whole life.
    assert 'loras = payload.get("loras")' in EDIT
    assert "loras=loras" in EDIT


def test_the_dimensions_are_the_callers_before_the_sources():
    assert 'payload.get("width")' in EDIT and 'payload.get("height")' in EDIT
    assert 'src["width"]' in EDIT, "the source is still the fallback"


# ── the frame grid is the model's ───────────────────────────────────────────

def test_the_frame_count_is_invariant_5s_generic_form():
    assert "R.frame_count(model," in CODE
    assert "pad17" not in CODE, "pad17 is H3's grid specifically"


def test_frame_count_matches_pad17_exactly_on_h3(aws):
    """The substitution must be a no-op for the family it replaces, or every
    existing edit changes length."""
    for ms in (1000, 5000, 8360, 13400):
        assert R.frame_count("minimax-h3", ms) == h3_timing.pad17(
            h3_timing.ms_to_frames_ceil(ms)), ms


def test_a_source_at_the_ceiling_stays_legal_and_on_grid(aws):
    """`frame_count` rounds UP, so a clip at the ceiling lands just past it —
    a 15.2s source asks for 379 frames against H3's 365 legal maximum, which
    dies in the sampler rather than in the handler."""
    max_ms = int(h3_timing.MAX_FRAMES / 24 * 1000)
    for src_ms in (15200, 20000, 600000):
        want = min(max_ms, src_ms)
        frames = R.frame_count("minimax-h3", want)
        for _ in range(24):                      # the handler's own walk-back
            if frames <= h3_timing.MAX_FRAMES:
                break
            want -= 250
            frames = R.frame_count("minimax-h3", want)
        assert frames <= h3_timing.MAX_FRAMES, (src_ms, frames)
        assert (frames - 5) % 17 == 0, f"{frames} is off H3's 17n+5 grid"


def test_the_walk_back_is_bounded():
    """An unbounded `while` here would hang the worker on a model whose grid
    step never crosses the ceiling."""
    assert "for _ in range(24):" in EDIT


# ── the block comes out of `queued` ─────────────────────────────────────────

def test_a_block_backed_edit_writes_a_terminal_status():
    assert '"status": "generated"' in EDIT, \
        "queueBlockRender moves the block to `queued`; only master_pass ever wrote back"


def test_activate_follows_master_passs_contract():
    # "replace" has to mean the same thing on both paths, chain marking included.
    assert 'payload.get("activate")' in EDIT
    assert 'activate == "replace"' in EDIT
    assert "_mark_downstream_stale" in EDIT
    assert '"state": "kept" if activate == "replace" else "pending"' in EDIT


def test_the_take_defaults_to_pending():
    """An edit is a proposal until someone has looked at it — the modal queues
    `activate: "review"` and anything unset must behave the same way."""
    assert '"kept" if activate == "replace" else "pending"' in EDIT


def test_the_asset_records_what_rendered_it():
    # Without these a finished edit cannot be reproduced or explained.
    assert '"model_key": model' in EDIT
    assert '"seed"' in EDIT


# ── the prompt is the vendor's edit envelope, and the ref video fits ────────
# Fourth and fifth gaps, found the day the feature was first really used
# (2026-08-23): the prompt was bare prose with one appended declaration —
# not the six-section `[video editing]` envelope the vendor's own guide
# specifies — and the source video was staged as a FULL-RESOLUTION reference,
# which doubled the DiT sequence and OOM'd the 96GB card on the first
# sampling step, three times out of three.

def test_the_prompt_is_the_compiled_edit_envelope_not_stapled_prose():
    assert "compile_video_edit" in CODE
    assert "full_prompt_text" in CODE
    assert "is the source clip being edited" not in CODE, \
        "the appended-sentence form predates the envelope and must not return"


def test_the_edit_places_lora_triggers_like_every_other_lora_call_site():
    assert "with_triggers" in CODE
    assert "lora_triggers(model, loras)" in CODE


def test_the_video_ref_carries_the_sources_dims_for_the_half_res_cap():
    # _wire_refs never upscales, but it can only skip the downscale for a
    # small source when the caller states the dims — and the handler has them.
    assert '"name": vname' in CODE
    assert '"width": src.get("width")' in CODE


# ── the render never outgrows the clip it edits ─────────────────────────────
# Sixth gap (2026-09-04). The dims precedence above is right for everything
# except its own ceiling: a block's stored `params` outlive the take they were
# planned against, so the modal sent 1280x736 for a take rendered 864x480 and
# the "edit" was also a 2.27x upsample — which OOM'd two seconds after the
# model load, on the first sampling step. Executed rather than source-parsed:
# this one is arithmetic, and arithmetic that is only asserted to be CALLED is
# arithmetic nobody checked.

MEASURED = (1280, 736, 864, 480)          # request w,h then the real source


def test_the_measured_case_caps_to_the_sources_own_frame(aws):
    w, h, sw, sh = MEASURED
    assert R.cap_dims_to_source("minimax-h3-pdd", w, h, sw, sh) == (832, 480)


def test_the_cap_never_exceeds_the_source_on_either_axis(aws):
    for w, h in ((1280, 736), (1920, 1088), (736, 1280), (1024, 1024)):
        for sw, sh in ((864, 480), (640, 640), (480, 864), (1280, 736)):
            cw, ch = R.cap_dims_to_source("minimax-h3-pdd", w, h, sw, sh)
            assert cw <= max(sw, 32) and ch <= max(sh, 32), (w, h, sw, sh, cw, ch)


def test_a_source_at_or_above_the_request_is_untouched(aws):
    # The cap is a ceiling, not a resize — it must be inert on every edit that
    # was already asking for something the source can carry.
    for sw, sh in ((1920, 1080), (1280, 736), (2560, 1440)):
        assert R.cap_dims_to_source("minimax-h3-pdd", 1280, 736, sw, sh) == (1280, 736)


def test_an_unknown_source_size_caps_nothing(aws):
    # `assets.width/height` is null on plenty of rows (nothing has probed them
    # yet — see mediaProbe). Inventing a ceiling there is worse than the request.
    for sw, sh in ((None, None), (0, 0), (864, None), (None, 480)):
        assert R.cap_dims_to_source("minimax-h3-pdd", 1280, 736, sw, sh) == (1280, 736)


def test_the_cap_shrinks_the_frame_and_does_not_reshape_it(aws):
    """Per-axis capping against a source of a different aspect would squash the
    picture into a rectangle nobody asked for: min(1280,640) x min(736,640) is
    640x640, a square, from a 1.74 request."""
    cw, ch = R.cap_dims_to_source("minimax-h3-pdd", 1280, 736, 640, 640)
    assert cw != ch, "capped to the source's shape instead of scaling uniformly"
    assert abs((cw / ch) - (1280 / 736)) < 0.12, (cw, ch)


def test_the_result_is_on_the_models_grid_so_resolves_own_snap_is_a_no_op(aws):
    """resolve() rounds to NEAREST dim_step a few hundred lines below. Anything
    off-grid here would be nudged back up, potentially over the ceiling this
    function exists to hold."""
    for model, step in (("minimax-h3-pdd", 32), ("ltx-25", 64)):
        cw, ch = R.cap_dims_to_source(model, 1280, 736, 864, 480)
        for v in (cw, ch):
            assert v % step == 0, (model, v)
            assert max(step, int(round(v / step)) * step) == v, (model, v)


def test_the_cap_is_what_actually_shrank_the_failing_render(aws):
    """The DiT sequence is frames x w x h, and the reference video rides at
    REF_VIDEO_SCALE of the RENDER's width — so the request sizes both halves.
    The job that died was 346M px-frames; capped it is under half that."""
    frames = R.frame_count("minimax-h3-pdd", 12000)
    assert frames == 294

    def px_frames(w, h):
        ref_w = max(32, int(w * R.REF_VIDEO_SCALE / 32) * 32)
        return frames * (w * h + ref_w * round(ref_w * h / w))

    before = px_frames(1280, 736)
    after = px_frames(*R.cap_dims_to_source("minimax-h3-pdd", *MEASURED))
    assert before > 340_000_000, before
    assert after < before / 2, (before, after)


def test_the_handler_caps_and_renders_the_capped_size(aws):
    # A cap that is computed and then not passed to resolve() is the silent
    # downgrade in reverse — and it would report a size it did not render.
    assert "R.cap_dims_to_source(model, width, height," in EDIT
    assert "width, height = capped" in EDIT
    assert re.search(r"width=width, height=height", EDIT)


def test_the_cap_is_reported_when_it_bites(aws):
    # The modal's resolution row still reads 1280x736; a render that quietly
    # disagreed with it is exactly the class of lie this handler had three of.
    assert "video_edit capped" in EDIT


# ── A `Picture N` with no picture behind it ─────────────────────────────────
#
# `compile_video_edit` defines <Picture 1>..<Picture N> for the images that
# actually staged, and NAMING one is what binds the change to it. So the
# instruction "she should be holding the photo in Picture 1" compiles, on an
# edit that staged nothing, into an envelope with no such subject — and H3
# returns the take essentially unchanged, which reads as the edit feature not
# working. That is what it was reported as. It is easy to hit on this path in
# particular: the modal's edit reference grid starts EMPTY and never inherits
# the block's staged set, so the block can carry eight pictures while the edit
# carries none.

def test_a_named_picture_with_nothing_staged_is_refused():
    assert "dangling_picture_refs" in EDIT
    assert "raise ValueError" in EDIT


def test_the_refusal_counts_what_STAGED_rather_than_what_was_asked_for():
    # An id that did not resolve contributes no <Picture N> either, so a stale
    # asset id has to be caught by the same check.
    assert "n_ref_images=len(ref_names)" in EDIT


def test_the_refusal_lands_before_the_sampler():
    # After the sampler it is a take nobody wanted and minutes of GPU time;
    # the whole value of the check is that it is cheap and early.
    assert EDIT.index("dangling_picture_refs") < EDIT.index("R.resolve(")


def test_the_detector_reads_the_label_the_envelope_itself_emits():
    import h3_prompt as H
    assert H.dangling_picture_refs("holding the photo in Picture 1",
                                   n_ref_images=0) == [1]
    assert H.dangling_picture_refs("use <Picture 3>", n_ref_images=2) == [3]
    assert H.dangling_picture_refs("swap picture2 in", n_ref_images=0) == [2]
    # Picture 0 is as dangling as Picture 9 — the envelope numbers from one.
    assert H.dangling_picture_refs("Picture 0", n_ref_images=2) == [0]


def test_a_named_picture_that_IS_staged_passes():
    import h3_prompt as H
    assert H.dangling_picture_refs("holding the photo in Picture 1",
                                   n_ref_images=1) == []
    assert H.dangling_picture_refs("Picture 1 and Picture 2", n_ref_images=2) == []


def test_prose_about_the_shot_is_not_a_label():
    # A FALSE POSITIVE HERE REFUSES A RENDER THAT WOULD HAVE WORKED, so the
    # detector reads only the word the envelope emits, and only with a number.
    # "the picture she is holding" is what an edit brief says about the shot.
    import h3_prompt as H
    for prose in ["the picture she is holding",
                  "make the image warmer",
                  "replace the photograph in her hands with the astronaut sheet",
                  "a picture of a girl beside a robot",
                  "reference 2 of her coat"]:
        assert H.dangling_picture_refs(prose, n_ref_images=0) == [], prose


def test_the_envelope_defines_exactly_the_numbers_the_detector_allows():
    # The two must agree or the check refuses a legal brief, or passes one the
    # compile cannot honour. Read off the compiled text rather than asserted
    # from memory of it.
    import h3_prompt as H
    for n in (0, 1, 3):
        defs = H.compile_video_edit("x", n_ref_images=n)["subject_definitions"]
        for i in range(1, n + 1):
            assert f"<Picture {i}>" in defs
        assert f"<Picture {n + 1}>" not in defs
        assert H.dangling_picture_refs(f"use Picture {n}", n_ref_images=n) \
            == ([] if n >= 1 else [0])
        assert H.dangling_picture_refs(f"use Picture {n + 1}", n_ref_images=n) == [n + 1]

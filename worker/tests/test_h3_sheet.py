"""h3_sheet + graphs.h3_sheet_graph — a reference sheet as ONE ref2va take.

Every assertion here is a trap that fails SILENTLY on the pod. A sheet that
samples the wrong frame is a perfectly good picture of the wrong angle; a
dropped autogrow key is a sheet rendered from one reference instead of five;
a mis-paired PDD file applies cleanly and renders a different model.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import graphs as G          # noqa: E402
import h3_sheet as S        # noqa: E402

H3 = {
    "ref_checkpoint": "minimax_h3_ref2va_int8_convrot.safetensors",
    "frame_checkpoint": "minimax_h3_fl2va_int8_convrot.safetensors",
    "checkpoint": "minimax_h3_ref2va_int8_convrot.safetensors",
    "text_encoder": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    "vae": "minimax_h3_video_vae_fp16.safetensors",
    "audio_vae": "minimax_h3_audio_vae_fp32.safetensors",
}
# The two autogrow templates, verbatim from the pod's live /object_info. The
# prefixes DIFFER (`ref_image_` vs `image`), which is the whole reason the key
# is read from the node instead of being written by hand.
REF_SPEC = {"input": {"required": {}, "optional": {"ref_images": [
    "COMFY_AUTOGROW_V3", {"template": {"prefix": "ref_image_", "max": 9}}]}}}
BATCH_SPEC = {"input": {"required": {"images": [
    "COMFY_AUTOGROW_V3", {"template": {"prefix": "image", "max": 50}}]}}}

# `bible_assets.role`'s CHECK constraint (migration 20260806180000). A role
# outside it is a PostgREST 400 at the END of a render that has already spent
# its GPU time.
LEGAL_ROLES = {"ref", "face", "full_body", "side", "outfit", "turnaround",
               "master", "alt_angle", "detail", "atmosphere"}

# The model_map `pdd` block VERBATIM — both trunks and the trained block count,
# which is the only shape any caller ever has. It was written as a pre-resolved
# `{"file": ...}` once, and since the builder indexed that invented key every
# sheet job died on `KeyError: 'file'` the first time one was queued through the
# worker, with all 35 unit tests green. A fixture is only worth what it shares
# with the real thing; `test_the_real_model_map_block_builds` is the backstop.
PDD = {"fl2va": "MiniMax-H3-FL2VA-Acc-8Step.safetensors",
       "ref2va": "MiniMax-H3-Ref2VA-Acc-8Step.safetensors",
       "nfe": "8"}


def _g(plan, refs=("a.png", "b.png"), **kw):
    w, h = plan["dims"]
    return G.h3_sheet_graph(
        H3, "prompt", 4242, refs=list(refs),
        frames=[v["frame"] for v in plan["views"]], length=plan["length"],
        width=w, height=h, columns=plan["columns"],
        node_spec=REF_SPEC, batch_spec=BATCH_SPEC, **kw)


# ------------------------------------------------------------- the plan ----

def test_the_character_plans_reproduce_the_published_extraction_frames():
    """C_Nugget's frames were TUNED by looking at real output — H3 ramps into a
    prompted move rather than starting at speed, so the geometric quarters
    (0/18/36/54) are not where the angles are. Deriving them instead of
    carrying them is the mistake; these numbers are the evidence."""
    assert [v["frame"] for v in S.plan_character()["views"]] == \
        [2, 21, 42, 63, 84, 113]
    assert [v["frame"] for v in S.plan_character(fast=True)["views"]] == \
        [2, 24, 45, 68]


def test_a_cut_stamp_always_names_an_exact_frame():
    """The stamp goes in the PROMPT and the index goes to the EXTRACTOR, so a
    stamp that lands between frames is a cut the sheet then samples the wrong
    side of. Both come off one number; this is what says so."""
    for plan in (S.plan_location(), S.plan_location(shots=5),
                 S.plan_character()):
        for b in plan["beats"]:
            ms = S.frame_ms(b["start"])
            assert S.stamp(b["start"]) == S.HP._ts(ms)
            assert round(ms * S.FPS / 1000.0) == b["start"]


def test_no_view_is_sampled_on_a_cut_or_past_the_end():
    """H3 blurs through a requested edit point — ethanfel's README says so and
    puts every extraction near the middle of its shot. A view on the boundary
    is a soft frame; a view past the end silently duplicates the last one."""
    for plan in (S.plan_character(), S.plan_character(fast=True),
                 S.plan_location(), S.plan_location(shots=4, length=90)):
        cuts = {b["start"] for b in plan["beats"]}
        for v in plan["views"]:
            assert v["frame"] < plan["length"]
            assert min(abs(v["frame"] - c) for c in cuts) >= S.SETTLE_F


def test_every_view_role_is_one_the_bible_will_accept():
    for plan in (S.plan_character(), S.plan_character(fast=True),
                 S.plan_location()):
        for v in plan["views"]:
            assert v["role"] in LEGAL_ROLES, v


def test_a_location_take_fills_all_four_plate_roles_in_one_pass():
    """The whole point. `plate_plan`'s ring is master -> alt_angle ->
    atmosphere with detail beside it, and 'one plate per location is one camera
    position' is what happens when those four are drawn as four independent
    renders on H3."""
    roles = [v["role"] for v in S.plan_location()["views"]]
    assert {"master", "alt_angle", "atmosphere", "detail"} <= set(roles)
    assert roles[0] == "master"


def test_the_orbit_is_ONE_beat_and_the_faces_are_cuts():
    """Writing a turnaround as a series of stamped cuts is what turns it into
    four unrelated angles — the thing one take is chosen to avoid. C_Nugget's
    README: 'a slow 360 with no hard cuts, so the character stays consistent'."""
    beats = S.plan_character()["beats"]
    assert beats[0]["kind"] == "move" and len(beats) == 3
    assert all(b["kind"] == "cut" for b in beats[1:])
    # four of the six views come out of that single sweep
    assert sum(1 for v in S.plan_character()["views"]
               if v["frame"] < beats[0]["end"]) == 4


def test_a_location_take_is_all_cuts():
    plan = S.plan_location()
    assert all(b["kind"] == "cut" for b in plan["beats"])
    assert len(plan["views"]) == len(plan["beats"]) == 8


# ---------------------------------------------------------- the envelope ----

def _prompt(plan, pics, **kw):
    kw.setdefault("name", "Mara Vale")
    kw.setdefault("identity", "grey hair, olive cardigan")
    return S.sheet_prompt(plan, pictures=pics, **kw)


def test_the_envelope_carries_all_six_official_fields_in_order():
    text = _prompt(S.plan_character(), [{"role": "face"}])
    fields = ["subject_definitions:", "summary:", "retention_analysis:",
              "detailed_description:", "overall_soundscape:",
              "non_diegetic_music:"]
    at = [text.index(f) for f in fields]
    assert at == sorted(at), text[:400]


def test_every_picture_line_says_what_to_IGNORE():
    """C_Nugget's own emphasis: 'Say what to take, and — this bit matters more
    than people expect — say what to IGNORE. If you don't rule things out by
    name, backgrounds and the wrong person's hair sneak through.'"""
    for role in ("face", "full_body", "turnaround", "outfit", "master", "ref"):
        line = S.picture_line(1, role, "Mara Vale")
        assert "gnore" in line or "does not describe" in line, (role, line)


def test_a_face_plate_is_told_not_to_contribute_wardrobe():
    """And a body sheet not to re-decide the face. Getting that backwards is
    how a turnaround comes back wearing the collar from a head-and-shoulders
    crop."""
    assert "no clothing" in S.picture_line(1, "face", "X")
    assert "Ignore the face" in S.picture_line(2, "outfit", "X")


def test_picture_numbering_is_positional_and_the_subject_follows_it():
    """<Picture N> is positional — a caller that prunes a reference and not its
    definition slides every later binding one picture left."""
    text = _prompt(S.plan_location(),
                   [{"role": "master"}, {"role": "alt_angle"}, {"role": "detail"}],
                   name="the street")
    for i in (1, 2, 3):
        assert f"<Picture {i}> =" in text
    assert "<Picture 4> =" not in text
    assert "<Subject 4> is" in text


def test_the_negation_block_is_TERMINAL_in_the_description():
    """H3 is the family measured obeying a negation at the END of the
    description; the same words mid-stack are read as things to draw."""
    text = _prompt(S.plan_character(), [{"role": "face"}])
    desc = text.split("detailed_description:\n")[1].split("\n\noverall_soundscape:")[0]
    assert desc.rstrip().endswith("appear anywhere in the frame.")


def test_a_caller_can_override_one_picture_note():
    """The role cannot know 'use the shield, it is attached to his back'."""
    text = _prompt(S.plan_character(), [{"role": "ref"}],
                   picture_notes={1: "use the shield on {name}'s back"})
    assert "use the shield on Mara Vale's back" in text


def test_the_soundtrack_is_silence_on_both_shapes():
    for plan in (S.plan_character(), S.plan_location()):
        c = S.compile_sheet(plan, name="X", identity="", pictures=[{"role": "face"}])
        assert "complete silence" in c["soundscape"]
        assert c["music"] == "None."


# ------------------------------------------------------------- the graph ----

def test_the_autogrow_keys_use_each_NODES_OWN_prefix():
    """`ref_images.ref_image_0` on the H3 node and `images.image0` on
    BatchImagesNode — same namespacing rule, different prefixes, both read off
    `template.prefix`. A key ComfyUI does not declare is DROPPED, not
    rejected: a sheet rendered from one reference, or a save node that writes
    one view, with nothing in the log."""
    g = _g(S.plan_character(), refs=("a.png", "b.png", "c.png"))
    assert [k for k in g["6"]["inputs"] if k.startswith("ref_images")] == \
        ["ref_images.ref_image_0", "ref_images.ref_image_1", "ref_images.ref_image_2"]
    assert list(g["300"]["inputs"])[:2] == ["images.image0", "images.image1"]
    # never a bare key
    assert not any(k in ("ref_image_0", "image0") for k in
                   list(g["6"]["inputs"]) + list(g["300"]["inputs"]))


def test_the_audio_vae_is_always_wired():
    """It is in the node's REQUIRED set even for a silent take, so omitting it
    fails validation rather than being quietly dropped."""
    g = _g(S.plan_location(), refs=("m.png",))
    assert g["6"]["inputs"]["audio_vae"] == ["4", 0]
    assert g["4"]["inputs"]["vae_name"] == H3["audio_vae"]


def test_it_runs_on_the_ref2va_checkpoint_not_the_frame_one():
    """A sheet conditions on a SET. fl2va is the opening-frame model and would
    be shown one picture where nine were staged."""
    g = _g(S.plan_character())
    assert g["1"]["inputs"]["unet_name"] == H3["ref_checkpoint"]
    assert g["6"]["class_type"] == "MiniMaxH3ReferenceToVideo"


def test_the_seed_reaches_RandomNoise():
    """Both published workflows ship seed 0, which is the seed-0 trap
    `handle_image_gen` already documents: every re-roll returns the identical
    sheet."""
    assert _g(S.plan_character())["10"]["inputs"]["noise_seed"] == 4242


def test_every_view_is_extracted_and_every_one_reaches_both_outputs():
    plan = S.plan_character()
    g = _g(plan)
    picks = [n for n in g.values() if n["class_type"] == "ImageFromBatch"]
    assert len(picks) == len(plan["views"]) == 6
    assert [p["inputs"]["batch_index"] for p in picks] == \
        [v["frame"] for v in plan["views"]]
    assert all(p["inputs"]["length"] == 1 for p in picks)
    assert len(g["300"]["inputs"]) == 6          # every view in the batch save
    stitches = [n for n in g.values() if n["class_type"] == "ImageStitch"]
    assert len(stitches) == 5                    # 3 columns: 2 joins/row + 1 stack


def test_a_frame_past_the_end_is_clamped_rather_than_duplicating_a_view():
    """ImageFromBatch returns the LAST frame for an out-of-range index rather
    than raising, so an off-by-one is a silently repeated view."""
    g = G.h3_sheet_graph(H3, "p", 1, refs=["a.png"], frames=[0, 999],
                         length=124, width=768, height=1344,
                         node_spec=REF_SPEC, batch_spec=BATCH_SPEC)
    assert [n["inputs"]["batch_index"] for n in g.values()
            if n["class_type"] == "ImageFromBatch"] == [0, 123]


def test_references_are_capped_at_the_nodes_own_nine():
    g = _g(S.plan_character(), refs=[f"r{i}.png" for i in range(12)])
    assert len([k for k in g["6"]["inputs"] if k.startswith("ref_images")]) == 9


def test_it_defaults_to_the_published_sampler_recipe():
    """Both workflows ship euler + linear_quadratic at 25 steps. The H3
    templates' res_multistep/simple is tuned for MOTION; this take's product is
    a handful of settled frames."""
    g = _g(S.plan_character())
    assert g["8"]["inputs"]["sampler_name"] == "euler"
    assert g["9"]["inputs"]["scheduler"] == "linear_quadratic"
    assert g["9"]["inputs"]["steps"] == 25


def test_a_sheet_with_no_reference_is_refused():
    try:
        G.h3_sheet_graph(H3, "p", 1, refs=[], frames=[1], length=5,
                         width=8, height=8)
        assert False, "no refs should raise"
    except ValueError as e:
        assert "reference" in str(e)


# ---------------------------------------------------------------- PDD ------

def test_pdd_emits_the_sigmas_and_forces_euler():
    """The apply node emits the TRAINED BLOCK BOUNDARIES, so BasicScheduler
    stops being the schedule. Each step consumes one mean block velocity, so a
    multi-stage sampler evaluates the trunk off the grid."""
    g = _g(S.plan_character(), pdd=PDD)
    assert g["16"]["class_type"] == "MiniMaxH3PDDAccApply"
    assert g["11"]["inputs"]["sigmas"] == ["16", 1]        # SIGMAS output
    assert g["7"]["inputs"]["model"] == ["16", 0]
    assert g["8"]["inputs"]["sampler_name"] == "euler"
    assert g["16"]["inputs"]["nfe"] == "8"                 # combo takes a STRING
    assert g["16"]["inputs"]["on_off_grid"] == "error"
    # The ref2va build, because a sheet always loads the ref2va trunk. The two
    # trunks share a key set, so a crossed pairing applies cleanly and renders
    # silently wrong — this is the assertion that a wrong file is not.
    assert g["16"]["inputs"]["pdd_file"] == PDD["ref2va"]
    # BasicScheduler is still BUILT and is no longer what the sampler reads, so
    # its step count is inert here: `nfe` is the trained grid and the schedule.
    # Asserting a number on node 9 under PDD would be testing a dangling node.
    assert g["11"]["inputs"]["sigmas"] != ["9", 0]


def test_without_pdd_the_scheduler_is_still_what_the_sampler_reads():
    assert _g(S.plan_character())["11"]["inputs"]["sigmas"] == ["9", 0]


def test_the_real_model_map_block_builds():
    """The block as `minimax-h3-pdd` actually declares it, not a fixture.

    This is the test that was missing. The builder indexed `pdd["file"]` — a
    key model_map has never carried — so every sheet job queued through the
    worker died on `KeyError: 'file'` while all 35 unit tests stayed green,
    because the fixture invented exactly the key the builder wanted. A hand
    written fixture is only worth what it shares with the real thing.
    """
    import json
    m = json.load(open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))),
        "infra", "model_map.full.json")))["full"]
    pdd = m["models"]["minimax-h3-pdd"]["pdd"]
    assert "file" not in pdd, ("model_map declares the two TRUNKS, not a "
                               "pre-resolved file — the builder must choose")
    g = _g(S.plan_character(), pdd=pdd)
    # It resolves, and to the reference build rather than the frame one.
    assert g["16"]["inputs"]["pdd_file"] == pdd["ref2va"]
    assert g["16"]["inputs"]["pdd_file"] != pdd["fl2va"]
    assert g["16"]["inputs"]["nfe"] == str(pdd["nfe"])


def test_a_video_entrys_turbo_reaches_a_coverage_sheet(monkeypatch):
    """A video entry's `turbo_lora` is the WHOLE model's, so it must fill both
    slots — `resolve()` applies it with no mode gate.

    `_h3_files` filled `frame_turbo` only, which was right while `orbit` (i2v,
    fl2va) was the only shape. `coverage` loads ref2va and reads `ref_turbo`,
    so a coverage sheet on a turbo model found nothing, applied no adapter and
    rendered the full 25-step schedule — slower and correct, i.e. nothing
    anywhere reported it.
    """
    import handlers.orbit as O
    monkeypatch.setattr(O.R, "ensure_model", lambda m: {
        "modes": {"i2v": {"checkpoint": "fl2va.safetensors"},
                  "r2v": {"checkpoint": "ref2va.safetensors"}},
        "text_encoders": ["te.safetensors"], "vae": "v.safetensors",
        "audio_vae": "av.safetensors",
        "turbo_lora": "h3_turbo_v4.safetensors", "steps": 6})
    h3 = O._h3_files("minimax-h3-turbo")
    assert h3["frame_turbo"] == h3["ref_turbo"], "one adapter, both slots"
    assert h3["ref_turbo"]["lora"] == "h3_turbo_v4.safetensors"

    # …and it actually reaches the render the coverage shape builds.
    plan = S.plan_character()
    w, h = plan["dims"]
    g = G.h3_sheet_graph(h3, "prompt", 7, refs=["a.png"],
                         frames=[v["frame"] for v in plan["views"]],
                         length=plan["length"], width=w, height=h,
                         columns=plan["columns"], node_spec=REF_SPEC,
                         batch_spec=BATCH_SPEC)
    lora = [k for k, v in g.items() if v["class_type"] == "LoraLoaderModelOnly"]
    assert lora, "turbo adapter not spliced into the coverage sheet"
    # BOTH consumers read the patched model — H3's sigmas come off the
    # scheduler, so leaving it on the unpatched one samples 6 steps on the
    # stock schedule.
    assert g["7"]["inputs"]["model"][0] in lora
    assert g["9"]["inputs"]["model"][0] in lora
    assert g["9"]["inputs"]["steps"] == 6, "the distilled step count, not 25"


def test_a_pdd_block_with_no_ref2va_build_is_refused():
    """Rather than KeyError-ing deep in a dict, or silently rendering the
    fl2va build against a ref2va trunk — which applies cleanly and is wrong."""
    try:
        _g(S.plan_character(), pdd={"fl2va": "F.safetensors", "nfe": "8"})
        assert False, "should raise"
    except ValueError as e:
        assert "ref2va" in str(e)


def test_pdd_and_a_sigma_shift_are_refused_together():
    try:
        _g(S.plan_character(), pdd=PDD, sigma_shift=(12.0, 3.0))
        assert False, "should raise"
    except ValueError as e:
        assert "off-grid" in str(e)


def test_a_sigma_shift_alone_patches_the_model_both_consumers_read():
    g = _g(S.plan_location(), sigma_shift=(12.0, 3.0))
    assert g["15"]["class_type"] == "MiniMaxH3SigmaShift"
    assert g["15"]["inputs"]["shift_video"] == 12.0
    assert g["7"]["inputs"]["model"] == ["15", 0]
    assert g["9"]["inputs"]["model"] == ["15", 0]


def test_a_turbo_row_still_applies_when_there_is_no_pdd():
    h3 = dict(H3, ref_turbo={"lora": "t.safetensors", "steps": 4,
                             "strength": 0.75, "sampler": "er_sde"})
    w, h = S.plan_character()["dims"]
    g = G.h3_sheet_graph(h3, "p", 1, refs=["a.png"], frames=[2], length=124,
                         width=w, height=h, node_spec=REF_SPEC,
                         batch_spec=BATCH_SPEC)
    assert any(n["class_type"] == "LoraLoaderModelOnly" for n in g.values())
    assert g["8"]["inputs"]["sampler_name"] == "er_sde"
    assert g["9"]["inputs"]["steps"] == 4


def test_pdd_replaces_the_turbo_adapter_rather_than_stacking_with_it():
    """Distillations don't stack: a turbo adapter under PDD is applied to a
    model that is no longer the one it was distilled from."""
    h3 = dict(H3, ref_turbo={"lora": "t.safetensors", "steps": 4})
    w, h = S.plan_character()["dims"]
    g = G.h3_sheet_graph(h3, "p", 1, refs=["a.png"], frames=[2], length=124,
                         width=w, height=h, pdd=PDD, node_spec=REF_SPEC,
                         batch_spec=BATCH_SPEC)
    assert not any(n["class_type"] == "LoraLoaderModelOnly" for n in g.values())
    assert g["8"]["inputs"]["sampler_name"] == "euler"


# ------------------------------------------- PDD on the plain image path ----

def test_the_image_paths_pdd_file_follows_its_CHECKPOINT():
    """The two trunks ship identical key sets, so a crossed pairing applies
    cleanly and renders silently wrong — the node fingerprints the trunk and
    errors, which is the only reason it is survivable. Refs mean ref2va;
    an edit or a text-to-image means fl2va."""
    pdd = {"fl2va": "FL.safetensors", "ref2va": "REF.safetensors", "nfe": "8"}
    h3 = dict(H3, image_vae=None)
    g = G.h3_image_graph(h3, "p", 1, 1024, 1024, refs=["a.png", "b.png"], pdd=pdd)
    assert g["16"]["inputs"]["pdd_file"] == "REF.safetensors"
    assert g["1"]["inputs"]["unet_name"] == H3["ref_checkpoint"]
    g = G.h3_image_graph(h3, "p", 1, 1024, 1024, source_image="a.png", pdd=pdd)
    assert g["16"]["inputs"]["pdd_file"] == "FL.safetensors"
    assert g["1"]["inputs"]["unet_name"] == H3["frame_checkpoint"]
    g = G.h3_image_graph(h3, "p", 1, 1024, 1024, pdd=pdd)      # text-to-image
    assert g["16"]["inputs"]["pdd_file"] == "FL.safetensors"


def test_the_image_path_rewires_its_sampler_to_the_pdd_sigmas():
    pdd = {"fl2va": "FL.safetensors", "ref2va": "REF.safetensors", "nfe": "8"}
    g = G.h3_image_graph(H3, "p", 1, 1024, 1024, refs=["a.png"], pdd=pdd)
    assert g["11"]["inputs"]["sigmas"] == ["16", 1]
    assert g["7"]["inputs"]["model"] == ["16", 0]
    assert g["8"]["inputs"]["sampler_name"] == "euler"


def test_the_image_path_refuses_pdd_beside_a_turbo_adapter():
    h3 = dict(H3, ref_turbo={"lora": "t.safetensors", "steps": 4})
    try:
        G.h3_image_graph(h3, "p", 1, 1024, 1024, refs=["a.png"],
                         pdd={"ref2va": "REF.safetensors"})
        assert False, "should raise"
    except ValueError as e:
        assert "stack" in str(e)


def test_the_image_path_is_unchanged_when_no_pdd_is_declared():
    """Every H3 image row written before this renders byte-identically."""
    a = G.h3_image_graph(H3, "p", 7, 1024, 1024, refs=["a.png"])
    b = G.h3_image_graph(H3, "p", 7, 1024, 1024, refs=["a.png"], pdd=None)
    assert a == b
    assert "16" not in a and a["11"]["inputs"]["sigmas"] == ["9", 0]


def test_the_pictures_are_declared_to_outrank_the_description():
    """Measured: a take whose identity line described a different person from
    its staged plates followed the PLATES for five views and the PROSE on the
    sixth. Divergence is a real state here — a user-attached sheet can
    contradict a written line — so the ranking is stated, not inferred."""
    text = _prompt(S.plan_character(), [{"role": "face"}])
    assert "the pictures decide" in text
    # ...and there is nothing to rank when nothing is staged
    assert "the pictures decide" not in S.sheet_prompt(
        S.plan_character(), name="X", identity="i", pictures=[])


def test_the_sheet_never_stacks_a_RAGGED_row():
    """`ImageStitch` stacks with match_image_size, so a one-cell row under a
    four-cell row is SCALED UP to the full width — one view four times its
    neighbours' size, aspect intact and scale nonsense. Nobody notices until
    they measure it."""
    assert G._sheet_columns(8, 4) == 4          # divides
    assert G._sheet_columns(6, 3) == 3
    assert G._sheet_columns(6, 4) == 3          # 4 doesn't divide 6
    assert G._sheet_columns(5, 4) == 5          # prime -> one undistorted row
    assert G._sheet_columns(7, 4) == 7
    for plan in (S.plan_character(), S.plan_character(fast=True),
                 S.plan_location(), S.plan_location(shots=5),
                 S.plan_location(shots=6)):
        n, c = len(plan["views"]), plan["columns"]
        assert n % G._sheet_columns(n, c) == 0

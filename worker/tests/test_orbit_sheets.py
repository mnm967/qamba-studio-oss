"""graphs.orbit_sheet_graph — a reference sheet as ONE H3 take.

Every assertion here is a trap that fails SILENTLY on the pod: a graph that
renders a perfectly good sheet of the wrong thing, or one that evicts a
resident H3 mid-render, or one that returns the same picture on every re-roll.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import graphs as G  # noqa: E402

H3 = {
    "frame_checkpoint": "minimax_h3_fl2va_int8_convrot.safetensors",
    "ref_checkpoint": "minimax_h3_ref2va_int8_convrot.safetensors",
    "checkpoint": "minimax_h3_fl2va_int8_convrot.safetensors",
    "text_encoder": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    "vae": "minimax_h3_video_vae_fp16.safetensors",
    "audio_vae": "minimax_h3_audio_vae_fp32.safetensors",
    "frame_turbo": {"lora": "minimax_h3_lightx2v_turbo_8step_v10.safetensors",
                    "steps": 8, "sampler": "sa_solver", "scheduler": "simple"},
}


def _g(**kw):
    kw.setdefault("anchor", "sheet.png")
    kw.setdefault("shots", 5)
    return G.orbit_sheet_graph(H3, "[Shot 1] …", 4242, **kw)


def test_it_opens_on_the_anchor_through_the_fl2va_checkpoint():
    """The sheet is a continuation of a picture we already have, which is i2v
    — and i2v is fl2va's mode. ref2va is trained for reference ROWS and lands
    on a supplied frame measurably worse."""
    g = _g()
    assert g["6"]["class_type"] == "MiniMaxH3ImageToVideo"
    assert g["6"]["inputs"]["first_frame"] == ["5", 0]
    assert g["5"]["inputs"]["image"] == "sheet.png"
    assert g["1"]["inputs"]["unet_name"] == H3["frame_checkpoint"]


def test_the_frame_grid_is_legal_and_native():
    g = _g()
    ins = g["6"]["inputs"]
    assert (ins["length"] - 5) % 17 == 0, "invariant #5: 17n+5"
    assert (ins["width"], ins["height"]) in G.H3_NATIVE_DIMS


def test_count_equals_shots_so_the_vision_judge_never_runs():
    """The picker takes one sharp frame per clustered view and early-returns
    before consulting any model. That is not only cheaper — the judge's own
    path calls unload_all_models(), and evicting a resident H3 in the middle
    of the gpu lane's job is the trap this avoids."""
    g = _g(shots=5)
    sel = g["60"]["inputs"]
    assert sel["count"] == sel["shots"] == 5
    assert sel["free_vram_first"] is False


def test_frame_zero_is_not_kept_because_it_is_the_anchor():
    """keep_first_frame prepends frame 0, which is the view we supplied — it
    spends a slot on a duplicate and pushes the last cluster off the end."""
    assert _g()["60"]["inputs"]["keep_first_frame"] is False


def test_views_are_clustered_by_content_not_by_time():
    """H3 gives its shots wildly different lengths run to run, so any split by
    time lands two groups on one angle and drops a third view entirely."""
    assert _g()["60"]["inputs"]["shot_split"] == "views (by content)"


def test_the_individual_plates_are_saved_not_only_the_sheet():
    """A bible slot wants plates, not a contact sheet. The pack's own example
    graphs save only the sheet, which is the one change that makes this usable
    for `bible_assets` at all."""
    g = _g()
    savers = {k: v for k, v in g.items() if v["class_type"] == "SaveImage"}
    assert len(savers) == 2
    srcs = {tuple(v["inputs"]["images"]) for v in savers.values()}
    assert ("60", 0) in srcs, "selected frames are not saved"
    assert ("61", 0) in srcs, "contact sheet is not saved"


def test_labels_are_off():
    """Burnt-in text sits over the subject and follows the frame into every
    render that later stages it as a reference."""
    assert _g()["61"]["inputs"]["label_frames"] is False


def test_the_seed_is_the_callers_and_reaches_the_noise():
    """Both seeds ship as 0 in the pack's example graphs, which is the seed-0
    trap: every re-roll returns the identical sheet."""
    assert _g()["10"]["inputs"]["noise_seed"] == 4242


def test_the_turbo_adapter_patches_both_the_guider_and_the_scheduler():
    """H3's sigmas come off BasicScheduler, so a distillation left off it
    samples its short step count on the stock schedule."""
    g = _g()
    lora = [k for k, v in g.items() if v["class_type"] == "LoraLoaderModelOnly"]
    assert lora, "turbo adapter not spliced"
    src = g["7"]["inputs"]["model"]
    assert g["9"]["inputs"]["model"] == src
    assert src[0] in lora
    assert g["9"]["inputs"]["steps"] == 8
    assert g["8"]["inputs"]["sampler_name"] == "sa_solver"


def test_a_character_sheet_decodes_a_voice_sample_from_the_same_latent():
    """H3 decodes picture and sound from ONE latent, so having the figure
    speak during the turn costs no extra sampling."""
    g = _g(want_audio=True)
    assert g["52"]["class_type"] == "VAEDecodeAudio"
    assert g["52"]["inputs"]["samples"] == ["11", 0], "audio must come off the same sampler"
    assert g["52"]["inputs"]["vae"] == ["4", 0]
    assert g["4"]["inputs"]["vae_name"] == H3["audio_vae"]
    assert any(v["class_type"] == "SaveAudio" for v in g.values())


def test_the_audio_vae_is_never_an_input_to_the_i2v_builder():
    """`MiniMaxH3ImageToVideo` declares clip/vae/prompt/width/height/length/
    first_frame/last_frame and NOTHING else — unlike the ref2va builder, which
    does take an audio_vae. Passing it here is dropped by `_fit_node_inputs`
    on the way to the pod, so the mistake shows up as the voice sample simply
    not working, with nothing in any log. Caught against the live
    /object_info; H3 carries audio in the same latent regardless, so the audio
    VAE belongs only to the decode."""
    g = _g(want_audio=True)
    assert "audio_vae" not in g["6"]["inputs"]
    assert g["4"]["class_type"] == "VAELoader"          # decode-side only
    assert g["52"]["inputs"]["vae"] == ["4", 0]


def test_the_prompt_may_be_a_link_so_the_packs_own_builder_writes_it():
    """The pack's builders write H3's multi-shot cut grammar and are tested
    upstream against it. Reimplementing that here would be a distillation that
    drifts from the thing it distils."""
    c = G.orbit_character_graph(H3, "Reg", 7, anchor="a.png", style="sitcom",
                                spoken_line="Tuesday is a big day.")
    assert c["6"]["inputs"]["prompt"] == ["30", 0]
    assert c["30"]["class_type"] == "OrbitSheetsCharacterPrompt"
    # visual_style is REQUIRED and the pack's own example graph omits it
    assert c["30"]["inputs"]["visual_style"]
    l = G.orbit_location_graph(H3, "a laundrette", 7, anchor="a.png", style="sitcom")
    assert l["30"]["class_type"] == "OrbitSheetsLocationPrompt"
    assert l["30"]["inputs"]["coverage"] == "cut views"


def test_the_shot_count_follows_what_the_prompt_actually_asks_for():
    """The pack's own location workflow ships shots=6 against a 4-shot prompt,
    so clustering splits 4 views into 6 groups and the sheet repeats two."""
    assert G.orbit_location_graph(H3, "x", 7, anchor="a.png", style="s",
                                  wide=False, detail=False)["60"]["inputs"]["shots"] == 4
    assert G.orbit_location_graph(H3, "x", 7, anchor="a.png", style="s")["60"]["inputs"]["shots"] == 6
    assert G.orbit_character_graph(H3, "x", 7, anchor="a.png", style="s",
                                   scared_shot=False)["60"]["inputs"]["shots"] == 5


def test_a_location_sheet_wires_no_audio_at_all():
    g = _g(want_audio=False)
    assert not any(v["class_type"] in ("VAEDecodeAudio", "SaveAudio")
                   for v in g.values())
    assert "audio_vae" not in g["6"]["inputs"]


def test_every_link_points_at_a_node_that_exists():
    for kind in (True, False):
        g = _g(want_audio=kind)
        for nid, node in g.items():
            for key, val in node["inputs"].items():
                if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str):
                    assert val[0] in g, f"{nid}.{key} -> missing node {val[0]}"


def test_the_handler_uses_the_shared_on_tick_not_a_float_lambda():
    """`comfy.wait`'s on_tick receives `sampling_progress()`, which is
    `(done, total)` or None — NOT a float. A hand-rolled
    `lambda p: 0.1 + 0.7 * p` multiplies a tuple and kills the job on its
    first poll, four seconds in, AFTER the model has loaded. `make_tick` is
    the shared helper and also honours cancellation."""
    import inspect
    from handlers import orbit
    src = inspect.getsource(orbit.handle_orbit_sheet)
    assert "make_tick(job)" in src
    assert "0.7 * p" not in src


def test_every_view_role_is_one_the_database_will_accept():
    """`bible_assets.role` is CHECK-constrained, not free text. A role outside
    that vocabulary is a PostgREST 400 at the END of a render that has already
    spent its GPU time — the same trap `block_takes_kind_check` is documented
    for, and this hit it live with 'side_right', 'back', 'scared' and 'rear'.
    The legal set is parsed from the migration so it cannot drift."""
    import re
    from pathlib import Path
    from handlers import orbit
    root = Path(__file__).resolve().parents[2]
    sql = (root / "supabase/migrations"
           / "20260806180000_bible_asset_env_roles.sql").read_text()
    m = re.search(r"bible_assets_role_check\s*check\s*\(role in \((.*?)\)\)",
                  sql.replace("\n", " "), re.S | re.I)
    assert m, "could not read the role vocabulary out of the migration"
    legal = set(re.findall(r"'([a-z_]+)'", m.group(1)))
    # the turnaround role arrived in a later migration
    legal |= {"turnaround"}
    for role in set(orbit.CHAR_VIEW_ROLES) | set(orbit.ENV_VIEW_ROLES) | {"turnaround"}:
        assert role in legal, f"{role!r} is not an accepted bible_assets.role"


def test_each_view_keeps_a_readable_name_even_where_the_role_is_generic():
    """Three character views and two location views land on `ref` because no
    slot means "right profile". The finer label has to survive somewhere, or
    "which one is the back view" stops being answerable."""
    from handlers import orbit
    assert len(orbit.CHAR_VIEW_ROLES) == len(orbit.CHAR_VIEW_NAMES)
    assert len(orbit.ENV_VIEW_ROLES) == len(orbit.ENV_VIEW_NAMES)
    assert "back" in orbit.CHAR_VIEW_NAMES
    assert "rear wall" in orbit.ENV_VIEW_NAMES

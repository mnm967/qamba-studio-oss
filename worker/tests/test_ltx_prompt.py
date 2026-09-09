"""The LTX 2.5 block compiler.

Its whole reason to exist: `handle_master_pass` compiled H3's
`subject_definitions:` envelope for every video model, so an LTX block was
handed a format the vendor's own guide says the model does not read — which is
why LTX was clip-only. Invariant #6 still holds: this is deterministic Python
over structured beats, and the LLM never writes the format.
"""
import h3_prompt
import ltx_prompt as L

BEAT = {
    "start_ms": 0, "duration_ms": 6140,
    "camera": ("an extreme close-up through the crystallization lattice at eye "
               "level; the camera pushes in with small amplitude at slow speed "
               "toward Astronaut Rei's reaching hand"),
    "action": ("Astronaut Rei reaches toward the narrowing fracture. Villian Rei "
               "grips her and drags her backward ten meters."),
    "dialogue": [{"speaker": "Astronaut Rei", "line": "Here—move.",
                  "delivery": "fading but forceful"}],
    "sfx": "Crystal groans and boots drag across suspended glass",
    "cast_names": ["Astronaut Rei", "Villian Rei"],
    "positions": {"Astronaut Rei": "at the narrowing fracture"},
}
ENV = {"name": "Alternate City", "identity_line": "tilted glass towers over "
       "flooded streets", "palette": "cyan and amber-violet"}
CAST = [{"name": "Astronaut Rei", "identity_line": "orange suit"},
        {"name": "Villian Rei", "identity_line": "black coat"}]


def _compile(**kw):
    base = dict(render_ms=6592, beats=[BEAT], cast=CAST, environment=ENV,
                ref_slots=[], style="Anime (2D)", medium="series")
    base.update(kw)
    return L.compile_block(**base)


def test_it_is_prose_and_carries_none_of_h3s_envelope():
    text = L.full_prompt_text(_compile())
    for label in ("subject_definitions:", "retention_analysis:",
                  "detailed_description:", "overall_soundscape:",
                  "<Subject", "<Picture", "[Shot 1]"):
        assert label not in text, f"{label} is H3's format, not LTX's"


def test_it_opens_with_the_framing_literally():
    """The guide's first element is the SHOT, and our own rules say to open
    with it in words — measured, LTX obeys a stated size."""
    text = L.full_prompt_text(_compile())
    assert text.startswith("The video begins on")
    assert "extreme close-up" in text.lower()
    assert "eye level" in text.lower()


def test_the_camera_move_is_plain_words_not_the_official_jargon():
    text = L.full_prompt_text(_compile())
    assert "amplitude" not in text and "speed" not in text
    assert "pushes in" in text
    assert "slowly" in text


def test_it_says_how_the_shot_looks_once_the_move_is_over():
    """The vendor calls this critical for completing a motion; without it a
    measured extreme close-up dropped the second half of its action."""
    text = L.full_prompt_text(_compile()).lower()
    assert "when the move settles" in text
    assert "played all the way through" in text


def test_the_whole_action_survives_including_the_second_party():
    text = L.full_prompt_text(_compile())
    assert "drags her backward" in text, "the drag is what went missing live"
    assert "Villian Rei" in text


def test_dialogue_is_quoted_and_lip_synced():
    text = L.full_prompt_text(_compile())
    assert '"Here—move."' in text
    assert "lips moving in sync" in text


def test_the_sound_is_a_named_source_inside_the_same_prose():
    """A labelled soundscape section is H3's format. "Faint room tone" measured
    -46 LUFS; named objects land at -24, so the compile carries the beat's own
    sfx text."""
    text = L.full_prompt_text(_compile())
    assert "overall_soundscape" not in text
    assert "Crystal groans" in text


def test_a_second_shot_cuts_chronologically_with_a_new_framing():
    b2 = {**BEAT, "camera": "a wide shot at high angle", "action": "They separate.",
          "dialogue": [], "sfx": None}
    text = L.full_prompt_text(_compile(beats=[BEAT, b2]))
    assert "Then cut to" in text
    assert "00:00" not in text, "timestamps are H3's grammar; LTX cuts by chronology"


def test_r2v_never_restates_wardrobe_the_sheets_already_carry():
    """MSR slots carry learned embeddings — the staged sheet defines the person,
    and re-describing the costume only competes with it."""
    text = L.full_prompt_text(_compile())
    assert "orange suit" not in text and "black coat" not in text


def test_it_is_keyword_compatible_with_the_h3_compiler():
    """`handle_master_pass` picks a module and calls it once, so every keyword
    it passes has to be accepted here — a TypeError would only surface on a
    real LTX block render."""
    import inspect
    h3_kw = {p.name for p in inspect.signature(h3_prompt.compile_block).parameters.values()
             if p.kind is inspect.Parameter.KEYWORD_ONLY}
    call = {k: None for k in h3_kw}
    call.update(render_ms=6592, beats=[BEAT], cast=CAST, environment=ENV,
                ref_slots=[], style="Anime (2D)", medium="series", mode="r2v")
    out = L.compile_block(**call)
    assert out["description"] and out["fmt_version"] == L.FMT_VERSION


def test_the_returned_shape_matches_h3s_so_one_column_stores_either():
    keys = set(_compile())
    assert {"description", "soundscape", "music", "fmt_version"} <= keys


# ---------------------------------------------- routing inside master_pass ---
# Source-parsed for the reason the plate-model test is: the handler drives
# ComfyUI and stages files, and every one of these is SILENT when wrong — an
# H3 envelope renders (badly), an off-grid length dies deep in the sampler, a
# mis-slotted plate just looks worse, and a staged voice ref that the graph
# cannot read is recorded as though it had been used.


def _master_pass_src():
    import pathlib
    import handlers.blocks as B
    src = pathlib.Path(B.__file__).read_text()
    return src.split("def handle_master_pass(")[1].split("\ndef ")[0]


def test_the_compiler_is_chosen_by_family():
    body = _master_pass_src()
    assert 'is_ltx = "ltx" in str(block_model).lower()' in body
    assert "PC = ltx_prompt if is_ltx else h3_prompt" in body
    assert "compiled = PC.compile_block(" in body
    assert "prompt_text = PC.full_prompt_text(compiled)" in body


def test_ltx_gets_the_background_slot_and_four_subjects():
    body = _master_pass_src()
    seg = body.split("if is_ltx and mode == \"r2v\":")[1].split("# Motion-context")[0]
    assert '"kind") == "environment"' in seg
    assert 'ref_background' in seg
    assert "subjects[:4]" in seg


def test_ltx_does_not_spend_a_subject_slot_on_a_storyboard_panel():
    """MSR's four slots are SUBJECT slots; a panel is a composition and there
    is no slot that means that. It is also the crutch LTX does not need — the
    A/B measured H3 opening ON its panel and ignoring the written camera while
    LTX obeyed the written camera with none staged."""
    body = _master_pass_src()
    seg = body.split("if is_ltx and mode == \"r2v\":")[1].split("# Motion-context")[0]
    assert 'kind == "scene_ref"' in seg
    assert "no composition slot" in seg


def test_ltx_length_is_resnapped_off_the_planners_h3_grid():
    body = _master_pass_src()
    assert "R.frame_count(block_model, plan.render_ms) if is_ltx" in body
    assert "length=render_f" in body and "exact_frames=render_f" in body


def test_ltx_does_not_get_h3_only_machinery():
    body = _master_pass_src()
    # motion context is MiniMaxH3MotionContext — the node raises on a graph
    # without H3's builder, so the flag must not reach an LTX render
    assert "and not is_ltx" in body.split("motion_ctx = None")[1]
    # voice-timbre refs: LTX's MSR guide takes pictures only
    assert "LTX r2v takes no audio references" in body
    # locked audio is H3's audiolock template
    assert "has no locked-audio template" in body


def test_the_prompt_names_who_the_shot_names_not_the_roster(monkeypatch):
    """The prompt and the staged sheets must agree. Measured on the first LTX
    block: the prose named Miko, Guide Rei and Knight Rei — none staged, none in
    the action — while the sheet that WAS staged went unnamed. `_beats_for_prompt`
    now applies the same featured rule `ref_plan_for` uses."""
    import handlers.blocks as B
    cast_by_id = {f"c{i}": {"id": f"c{i}", "name": n} for i, n in enumerate(
        ["Astronaut Rei", "Villian Rei", "Miko", "Guide Rei", "Knight Rei"])}
    beat = {"id": "b1", "duration_ms": 4000,
            "camera": "a medium close-up at high angle",
            "action": "Villian Rei pulls gravity ribbons from Astronaut Rei's chest.",
            "dialogue": [], "sfx": None,
            "meta": {"cast": ["Astronaut Rei", "Villian Rei", "Miko", "Guide Rei",
                              "Knight Rei"],
                     "positions": {"Miko": "at the intersection",
                                   "Astronaut Rei": "inside the lattice"}}}
    out = B._beats_for_prompt({"beat_ids": ["b1"]}, [beat], cast_by_id)
    assert out[0]["cast_names"] == ["Villian Rei", "Astronaut Rei"]
    # positions are filtered to who is in the shot, so Miko's drops out with her
    assert set(out[0]["positions"]) == {"Astronaut Rei"}


def test_a_beat_naming_nobody_keeps_its_roster_in_the_prompt():
    import handlers.blocks as B
    cast_by_id = {"c0": {"id": "c0", "name": "Aki"}, "c1": {"id": "c1", "name": "Haru"}}
    beat = {"id": "b1", "duration_ms": 4000, "camera": "a two-shot at eye level",
            "action": "The two of them stand in silence.", "dialogue": [],
            "sfx": None, "meta": {"cast": ["Aki", "Haru"]}}
    out = B._beats_for_prompt({"beat_ids": ["b1"]}, [beat], cast_by_id)
    assert set(out[0]["cast_names"]) == {"Aki", "Haru"}


# ---------------------------------------------------------------------------
# The camera clause. Both bugs below were live in every LTX block render and
# were found by reading the compiled prose, not by a failing test — the suite
# only ever asserted that a move survived, never what it read like.
# ---------------------------------------------------------------------------

REAL_CAMERAS = [
    # verbatim from the live Rei E3 storyboard
    ("an extreme close-up through the crystallization lattice at eye level; the"
     " camera pushes in with small amplitude at slow speed toward Astronaut"
     " Rei's reaching hand",
     "pushes in slowly and slightly toward Astronaut Rei's reaching hand"),
    ("an extreme wide establishing shot at low angle; the camera tracks"
     " laterally with large amplitude at fast speed across the flooded alien"
     " city battlefield, then cranes upward into the suspended traffic",
     "tracks laterally quickly and far across the flooded alien city"
     " battlefield, then cranes upward into the suspended traffic"),
    # no semicolon, but it names the camera: this returned "" before, so every
    # held beat rendered with no camera direction at all (22 of 304 in Rei)
    ("the camera holds a static shot on the space just left",
     "holds a static shot on the space just left"),
]


def test_the_camera_clause_is_plain_english_on_the_real_planner_format():
    import ltx_prompt as L
    for camera, want in REAL_CAMERAS:
        assert L._plain_move(camera) == want


def test_the_move_never_repeats_the_words_the_caller_prepends():
    """`compile_block` writes "The camera " in front of this, and the planner's
    own clause opens by naming the camera — so 275 of Rei's 304 beats read
    "The camera the camera tracks...". """
    import ltx_prompt as L
    for camera, _ in REAL_CAMERAS:
        assert not L._plain_move(camera).lower().startswith("camera")
        assert "camera the camera" not in ("The camera " + L._plain_move(camera)).lower()


def test_speed_jargon_never_survives_as_at_slowly():
    """The mapping has to run BEFORE the connectives are stripped: the `at `
    strip is guarded by a lookahead for `<word> speed`, and substituting first
    destroys the thing it looks ahead for."""
    import ltx_prompt as L
    for camera, _ in REAL_CAMERAS:
        out = L._plain_move(camera)
        assert "at slowly" not in out and "at quickly" not in out
        assert "amplitude" not in out and "speed" not in out


def test_a_camera_line_naming_no_camera_and_no_semicolon_yields_no_move():
    """The terse comma format (7 of Rei's 304). Dropping it is the pre-existing
    behaviour and is preferred over guessing which comma-separated fragment is
    a move — `shot_framing` already takes the size and angle from it."""
    import ltx_prompt as L
    assert L._plain_move("wide, high angle, push in, deep focus") == ""


# ---------------------------------------------------------------------------
# The wrong-speaker guard.
# ---------------------------------------------------------------------------

def _spoken(**over):
    beat = {"camera": "a medium two-shot at eye level; the camera holds still",
            "action": "Rei turns to face Miko.", "cast_names": ["Rei", "Miko"],
            "dialogue": [{"speaker": "Rei", "line": "You knew.",
                          "delivery": "quietly"}]}
    beat.update(over)
    return beat


def test_ltx_names_the_listeners_so_the_wrong_mouth_does_not_move():
    """LTX lip-syncs a quoted line verbatim and a block stages up to four
    subject slots, so this exposure is worse here than on H3 — and the guard
    was missing from this compiler entirely."""
    import ltx_prompt as L
    desc = L.compile_block(render_ms=6000, beats=[_spoken()])["description"]
    assert ("Only Rei's lips move on this line; Miko listens without speaking,"
            " staying visibly in frame and reacting") in desc


def test_a_solo_cast_gets_no_guard_because_there_is_no_one_to_confuse():
    import ltx_prompt as L
    desc = L.compile_block(
        render_ms=6000, beats=[_spoken(cast_names=["Rei"])])["description"]
    assert "lips move on this line" not in desc


def test_the_guard_names_every_other_staged_character():
    import ltx_prompt as L
    beat = _spoken(cast_names=["Rei", "Miko", "Guide Rei"])
    desc = L.compile_block(render_ms=6000, beats=[beat])["description"]
    assert "Miko, Guide Rei listen without speaking" in desc

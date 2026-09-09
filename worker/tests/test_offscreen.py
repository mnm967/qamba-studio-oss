"""V.O. over a cutaway: a line marked `offscreen` plays while the camera is
elsewhere — a listener reaction, an insert — and its speaker stays out of the
shot.

The cinematographer's contract has asked for exactly this cut ("prefer cutting
to the listener DURING a long line") since the coverage rules were written,
and until the `offscreen` flag every layer downstream forced the opposite: a
speaker counted as in-frame in the shot carrying their line, the vocal clause
only ever bound a line to an on-camera mouth ("precisely lip-synced"), and the
finish-by anchors made every line complete inside its own shot. The vendor's
own grammar supports the technique — base modes: the exact phrase "says in an
off-screen voiceover" followed by a statement that on-screen lips remain
closed; ref mode: a subject speaking off-screen keeps its form, marked
off-screen — and the b6 v2 turbo take rendered it correctly by seed luck
(Dennis framed out, the line played as clean V.O. over inserts). This makes it
a decision instead of luck.

Every failure here is silent: a dropped flag compiles the on-camera grammar
and the render still succeeds, wrong.
"""
import pathlib

import h3_prompt as H
import image_prompt as I
import ltx_prompt as LTX
import storyplan as SP
import shot_contract as RC

WORKER = pathlib.Path(__file__).resolve().parents[1]

CAST = [{"name": "Mara Vale", "identity_line": "a slim woman in a charcoal coat"},
        {"name": "Osei Kofi", "identity_line": "a broad-shouldered man in a navy cardigan"}]
CLOSE = "no other person, figure, silhouette"
VO = "says in an off-screen voiceover"


def block(beats, cast=CAST, **kw):
    return H.compile_block(
        render_ms=sum(b["duration_ms"] for b in beats), warmup_ms=0,
        aspect="16:9", style="cinematic", medium="film",
        beats=beats, cast=cast, environment={"name": "Vale Watch Repair"},
        mode="r2v", ref_slots=[{"kind": "character", "name": c["name"], "slot": i + 1}
                               for i, c in enumerate(cast)], **kw)


def beat(action, roster, dialogue=None, positions=None):
    return {"action": action, "camera": "a medium shot at eye level",
            "duration_ms": 5000, "dialogue": dialogue or [],
            "cast_names": list(roster),
            **({"positions": positions} if positions else {}),
            "meta": {"cast": list(roster)}}


# ---------------------------------------------------------------- compiler --
def test_a_native_offscreen_line_uses_the_vendor_phrase():
    """No recording staged: H3 performs the voice itself, off-screen, and the
    lips-closed clause replaces the listener guard."""
    out = block([beat("Osei turns the watch over without looking up.",
                      ["Osei Kofi"],
                      [{"speaker": "Mara Vale", "line": "The mainspring is cracked.",
                        "offscreen": True}])])
    d = out["description"]
    assert VO in d
    assert "precisely lip-synced" not in d
    assert "lips completely closed" in d
    # the on-camera guard's wording must NOT appear for a V.O. line
    assert "Only Mara Vale's lips move" not in d


def test_an_onscreen_line_still_gets_the_listener_guard():
    out = block([beat("Mara sets the satchel down. Osei does not look up.",
                      ["Mara Vale", "Osei Kofi"],
                      [{"speaker": "Mara Vale", "line": "The mainspring is cracked."}])])
    d = out["description"]
    assert VO not in d
    assert "Only Mara Vale's lips move" in d


def test_a_staged_offscreen_line_binds_the_recording_as_voiceover():
    """The ref path: the line is a placed recording, so the V.O. binds to
    <Audio N> — with the offset — instead of asking for a lip-synced mouth."""
    out = block([beat("Osei turns the watch over without looking up.",
                      ["Osei Kofi"],
                      [{"speaker": "Mara Vale", "line": "The mainspring is cracked.",
                        "offscreen": True}])],
                audio_refs=[{"kind": "line", "slot": 1, "order": 1,
                             "name": "Mara Vale", "speaker": "Mara Vale",
                             "text": "The mainspring is cracked.",
                             "at_ms": 700, "dur_ms": 1500, "shot_idx": 1}])
    d = out["description"]
    assert VO in d and "<Audio 1>" in d
    assert "beginning about 0.7 seconds" in d
    assert "precisely lip-synced" not in d


def test_a_fully_offscreen_speakers_line_ref_is_still_declared():
    """Mara is not staged in this block at all (no ref slot, not in cast) —
    the old subject gate dropped her clip's declaration AND its binding, so
    the recording played while the native branch re-performed the words: the
    FMT-12 double-performance from the other end."""
    out = block([beat("Osei turns the watch over without looking up.",
                      ["Osei Kofi"],
                      [{"speaker": "Mara Vale", "line": "The mainspring is cracked.",
                        "offscreen": True}])],
                cast=[CAST[1]],  # Osei only — Mara has no subject
                audio_refs=[{"kind": "line", "slot": 1, "order": 1,
                             "name": "Mara Vale", "speaker": "Mara Vale",
                             "text": "The mainspring is cracked.",
                             "shot_idx": 1}])
    defs = out.get("subject_definitions") or out.get("definitions") or ""
    text = defs if isinstance(defs, str) else str(defs)
    joined = text + " " + out["description"]
    assert "heard as an off-screen voice" in joined
    assert "<Audio 1>" in out["description"]        # bound, not re-performed
    assert out["description"].count("The mainspring is cracked.") == 1


def test_a_bodiless_speaker_gets_their_own_speaker_id():
    """A speaker with no staged body used to fall to the `sid or 'S1'`
    fallback — colliding with the first on-screen character's id, i.e. two
    voices under one label. True for phone callers all along; V.O. makes it
    common."""
    out = block([beat("Osei turns the watch over without looking up.",
                      ["Osei Kofi"],
                      [{"speaker": "Mara Vale", "line": "The mainspring is cracked.",
                        "offscreen": True}])],
                cast=[CAST[1]])  # Osei is S1; Mara is not present
    d = out["description"]
    assert "(S2)" in d
    assert f"(S1) {VO.split(' ', 1)[0]}" not in d   # her line is not labelled S1


def test_an_offscreen_only_speaker_does_not_block_the_cast_close():
    """Same treatment as a phone caller: a V.O. voice is not a person the
    shot failed to stage, so a roster still carrying them (an old storyboard,
    a hand edit) must not hold the close open."""
    out = block([beat("Mara sets the satchel down. Osei does not look up.",
                      ["Mara Vale", "Osei Kofi", "Tam Reed"],
                      [{"speaker": "Tam Reed", "line": "Keep nine o'clock free.",
                        "offscreen": True}])])
    assert CLOSE in out["description"]


def test_an_unmarked_absent_speaker_still_blocks_the_close():
    """The control: without the flag (and without a voice device) the same
    roster keeps the close open — nothing about existing behaviour moved."""
    out = block([beat("Mara sets the satchel down. Osei does not look up.",
                      ["Mara Vale", "Osei Kofi", "Tam Reed"],
                      [{"speaker": "Tam Reed", "line": "Keep nine o'clock free."}])])
    assert CLOSE not in out["description"]


def test_an_offscreen_speakers_position_is_dropped_from_the_shot():
    """A position sentence is an instruction to draw them into the cutaway."""
    out = block([beat("Osei turns the watch over.", ["Osei Kofi"],
                      [{"speaker": "Mara Vale", "line": "The mainspring is cracked.",
                        "offscreen": True}],
                      positions={"Mara Vale": "at the counter",
                                 "Osei Kofi": "at the bench"})])
    d = out["description"]
    assert "Mara Vale is at the counter" not in d
    assert "Osei Kofi is at the bench" in d


def test_the_locked_path_narrates_an_offscreen_line():
    """The audiolock opt-back: the track carries the words either way, so the
    win is diarization — no on-screen mouth belongs to this line."""
    out = block([beat("Osei turns the watch over without looking up.",
                      ["Osei Kofi"],
                      [{"speaker": "Mara Vale", "line": "The mainspring is cracked.",
                        "offscreen": True, "at_ms": 900}])],
                audio_mode="locked", locked_kind="dialogue")
    d = out["description"]
    assert "in an off-screen voiceover heard from <Audio 1>" in d
    assert "No one on screen mouths this line" in d
    assert "precisely lip-synced" not in d


def test_the_cast_close_fires_through_the_real_beat_path():
    """test_cast_close.py's fixtures carry `meta` directly, and the
    production path (`_beats_for_prompt`) stripped it — so the video close
    never fired on a real render while the pin kept passing. The passthrough
    is the fix; this is the pin through the REAL path."""
    import sys
    import types
    sys.modules.setdefault("sb", types.ModuleType("sb"))
    from handlers import blocks as BL
    cast_by_id = {"c1": {"name": "Mara Vale"}, "c2": {"name": "Osei Kofi"}}
    db = [{"id": "b1", "scene_id": "s1", "idx": 0, "duration_ms": 5000,
           "camera": "a medium two-shot", "action": "Mara Vale hands Osei Kofi the watch.",
           "dialogue": [],
           "meta": {"cast": ["Mara Vale", "Osei Kofi"]}}]
    beats = BL._beats_for_prompt({"beat_ids": ["b1"], "idx": 0}, db, cast_by_id)
    out = block(beats)
    assert CLOSE in out["description"]


# ------------------------------------------------------------ image_prompt --
def test_offscreen_speakers_wants_every_line_marked():
    dlg = [{"speaker": "Ann", "line": "One.", "offscreen": True},
           {"speaker": "Ann", "line": "Two."}]
    assert I.offscreen_speakers(None, dlg) == []
    dlg[1]["offscreen"] = True
    assert I.offscreen_speakers(None, dlg) == ["Ann"]


def test_the_action_outranks_the_flag():
    """A speaker the prose puts in frame stays — drawing someone who is there
    beats deleting someone who is. Possessive-only does not count as a body,
    the `featured_cast` rule."""
    dlg = [{"speaker": "Ann Vale", "line": "One.", "offscreen": True}]
    assert I.offscreen_speakers("Ann Vale crosses to the bench.", dlg) == []
    assert I.offscreen_speakers("Ann Vale's letter sits open on the bench.",
                                dlg) == ["Ann Vale"]


def test_the_vo_clause_covers_the_empty_insert():
    """The clause is needed MOST with nobody staged: a bare `says:` beside an
    empty cast is the invented-extra invitation."""
    assert "every mouth in frame stays completely closed" \
        in I.offscreen_vo_clause([]).lower()
    one = I.offscreen_vo_clause(["Osei Kofi"])
    assert "Osei Kofi listens with lips completely closed" in one


# --------------------------------------------------------- blocks plumbing --
def test_beats_for_prompt_carries_the_flag_and_uncounts_the_speaker():
    """The compiler-dict whitelist must name the flag, and the featured text
    must not count a V.O. speaker into the cutaway's cast."""
    import sys
    import types
    sys.modules.setdefault("sb", types.ModuleType("sb"))
    from handlers import blocks as BL
    cast_by_id = {"c1": {"name": "Mara Vale"}, "c2": {"name": "Osei Kofi"}}
    db = [{"id": "b1", "scene_id": "s1", "idx": 0, "duration_ms": 5000,
           "camera": "a close-up", "action": "Osei Kofi does not look up.",
           "dialogue": [{"speaker_id": "c1", "speaker": "Mara Vale",
                         "line": "The mainspring is cracked.", "offscreen": True}],
           "meta": {"cast": ["Mara Vale", "Osei Kofi"]}}]
    b = BL._beats_for_prompt({"beat_ids": ["b1"], "idx": 0}, db, cast_by_id)[0]
    assert b["dialogue"][0].get("offscreen") is True
    assert b["cast_names"] == ["Osei Kofi"]
    # the control: unmarked, the spoken line counts her in
    db[0]["dialogue"][0].pop("offscreen")
    b2 = BL._beats_for_prompt({"beat_ids": ["b1"], "idx": 0}, db, cast_by_id)[0]
    assert "Mara Vale" in b2["cast_names"]


def test_the_staging_beat_text_excludes_offscreen_speakers():
    """`_beat_text` is a closure inside ref_plan_for, so the exclusion is
    pinned by parse — a V.O. line must not stage its speaker's sheet into a
    block that never frames them."""
    src = (WORKER / "handlers" / "blocks.py").read_text()
    tail = src.split("def _beat_text(", 1)[1][:900]
    assert 'not (d or {}).get("offscreen")' in tail


# -------------------------------------------------------------- storyplan --
def _story():
    return {"characters": [{"name": "Ann"}, {"name": "Bob"}],
            "scenes": [{"slug": "S1", "cast": ["Ann", "Bob"], "duration_ms": 4000,
                        "beats": [{"label": "b", "action": "Ann explains the ledger.",
                                   "duration_ms": 4000,
                                   "dialogue": [{"speaker": "Ann",
                                                 "line": "Listen closely."}]}]}]}


def _cine(offscreen):
    return {"scenes": [{"slug": "S1", "shots": [
        {"beat": "b", "duration_ms": 4000,
         "camera": "a close-up on Bob", "action": "Bob listens, jaw tight.",
         "cast": ["Bob"],
         "dialogue": [{"speaker": "Ann", "line": "Listen closely.",
                       "offscreen": offscreen}]}]}]}


def test_normalize_keeps_the_flag_and_the_speaker_out_of_the_cutaway():
    shots = SP.normalize_shots(_cine(True), _story())["S1"]
    assert shots[0]["dialogue"][0].get("offscreen") is True   # survives reconcile
    assert "Ann" not in shots[0]["cast"]                       # not unioned in


def test_a_false_string_is_not_a_mark():
    """Models emit "false" as a STRING; truthiness would read it as marked —
    the quiet inversion."""
    shots = SP.normalize_shots(_cine("false"), _story())["S1"]
    assert "offscreen" not in shots[0]["dialogue"][0]
    assert "Ann" in shots[0]["cast"]                           # her line counts her in


def test_revise_beats_inherits_the_flag_positionally():
    beats = [{"id": "x", "duration_ms": 4000,
              "dialogue": [{"speaker": "Ann", "line": "Old line.",
                            "offscreen": True}], "meta": {}}]
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [
            {"speaker": "Ann", "line": "New line."}]}]}, 4000)
    dlg = dict(patches)["x"]["dialogue"]
    assert dlg[0].get("offscreen") is True


def test_revise_beats_lets_the_model_set_or_clear_it():
    beats = [{"id": "x", "duration_ms": 4000,
              "dialogue": [{"speaker": "Ann", "line": "Same line."}], "meta": {}}]
    # a flag-only change is still a change: the compare must see it
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [
            {"speaker": "Ann", "line": "Same line.", "offscreen": True}]}]}, 4000)
    assert dict(patches)["x"]["dialogue"][0].get("offscreen") is True
    beats[0]["dialogue"][0]["offscreen"] = True
    patches, _ = SP.revise_beats(
        beats, {"shots": [{"n": 1, "dialogue": [
            {"speaker": "Ann", "line": "Same line.", "offscreen": False}]}]}, 4000)
    assert "offscreen" not in dict(patches)["x"]["dialogue"][0]


def test_both_contracts_teach_the_field():
    assert "offscreen" in SP.CINE_CONTRACT
    assert "offscreen" in SP.REVISE_CONTRACT


# -------------------------------------------------------------------- LTX --
def test_ltx_narrates_an_offscreen_line_in_prose():
    b = {"cast_names": ["Osei Kofi"],
         "dialogue": [{"speaker": "Mara Vale", "line": "The mainspring is cracked.",
                       "offscreen": True}]}
    s = LTX._dialogue(b)
    assert "heard from off-screen" in s
    assert "lips moving in sync" not in s
    assert "lips completely closed" in s
    b["dialogue"][0].pop("offscreen")
    assert "lips moving in sync" in LTX._dialogue(b)


# --------------------------------------------------------------- reviewer --
def test_the_contract_carries_the_flag_to_the_judge():
    c = RC.build_contract(
        block={"idx": 0, "t_start_ms": 0, "t_end_ms": 5000},
        beats=[{"duration_ms": 5000, "camera": "a close-up", "action": "Osei listens.",
                "dialogue": [{"speaker": "Mara Vale", "line": "The mainspring is cracked.",
                              "offscreen": True}],
                "meta": {"cast": ["Osei Kofi"]}}],
        cast=[{"name": "Osei Kofi", "identity_line": "a man"}],
        environment=None, scenes=[])
    assert c["dialogue"][0].get("offscreen") is True
    assert "offscreen" in RC.RETAKE_DIRECTIVES["WRONG_SPEAKER"]


# ----------------------------------------------------------------- panels --
def test_a_panel_for_a_cutaway_does_not_stage_the_speaker():
    """The panel path counts a speaker as featured by their line — except a
    V.O. one, whose beat's panel shows the listener or the insert. Twin of
    the panelSpec.ts case."""
    import llm
    shots = [{"camera": "a close-up on Bob", "action": "Bob listens, jaw tight.",
              "cast": ["Ann", "Bob"],
              "dialogue": [{"speaker": "Ann", "line": "Listen closely.",
                            "offscreen": True}]}]
    cast = [{"id": "e-a", "name": "Ann", "identity_line": "red coat", "doc": {}},
            {"id": "e-b", "name": "Bob", "identity_line": "grey coat", "doc": {}}]
    (anchors, _), = llm.scene_panel_specs(shots, cast, None, style="Anime (2D)")
    ids = {a.get("entry_id") for a in anchors}
    assert "e-a" not in ids and "e-b" in ids
    shots[0]["dialogue"][0].pop("offscreen")
    (anchors, _), = llm.scene_panel_specs(shots, cast, None, style="Anime (2D)")
    assert "e-a" in {a.get("entry_id") for a in anchors}

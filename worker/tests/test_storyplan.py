"""storyplan: the staged writer → editor → cinematographer pipeline.

Everything here is the deterministic half — validators, duration fitting,
dialogue reconciliation, the mechanical shot-count floor — plus one full
run_pipeline pass over a scripted LLM. The bugs these pin: one 9-second shot
per scene, dialogue cut off mid-line, every camera "a medium push-in", and
speakers who exist in no character list.
"""
import json

import pytest

import storyplan as sp


# ------------------------------------------------------------------ timing ---
def test_dialogue_floor_scales_with_words():
    short = sp.dialogue_ms([{"line": "Run."}])
    long = sp.dialogue_ms([{"line": "I have to know what happened to her that night."}])
    assert short < long
    # 10 words at 2.4 w/s ≈ 4.2s + pad — a 2s shot cannot hold it
    assert long > 4000


def test_fit_never_squeezes_dialogue_below_its_floor():
    scenes = [{"slug": "A", "shots": [
        {"duration_ms": 8000, "dialogue": [
            {"line": "Twelve words of dialogue need real time to be spoken out loud."}]},
        {"duration_ms": 8000, "dialogue": []},
    ]}]
    sp.fit_shot_durations(scenes, 6000)   # brutal squeeze
    talky, silent = scenes[0]["shots"]
    assert talky["duration_ms"] >= sp.dialogue_ms(talky["dialogue"])
    assert silent["duration_ms"] >= sp.SHOT_MIN_MS


def test_fit_scales_slack_toward_target():
    scenes = [{"slug": "A", "shots": [
        {"duration_ms": 4000, "dialogue": []},
        {"duration_ms": 4000, "dialogue": []},
    ]}]
    total = sp.fit_shot_durations(scenes, 16000)
    assert 14000 <= total <= 16500
    assert scenes[0]["duration_ms"] == sum(s["duration_ms"] for s in scenes[0]["shots"])


def test_min_shots_thresholds():
    assert sp.min_shots(5000) == 1                      # a short scene may be a oner
    assert sp.min_shots(11000) == 2
    assert sp.min_shots(24000) >= 4
    assert sp.min_shots(14000, "action") > sp.min_shots(14000, "dialogue")


# -------------------------------------------------------------- validators ---
def test_camera_monoculture_is_flagged():
    tmpl = "a medium shot; the camera pushes in with small amplitude at slow speed"
    shots = [{"camera": tmpl, "duration_ms": 4000} for _ in range(5)]
    issues = sp.camera_issues(shots)
    assert any("consecutive" in i for i in issues)
    assert any("carrying" in i for i in issues)


def test_varied_coverage_passes():
    shots = [
        {"camera": "a wide establishing shot at eye level; the camera holds a static shot"},
        {"camera": "an over-the-shoulder medium close-up behind Leon"},
        {"camera": "a close-up; the camera pushes in with small amplitude at slow speed"},
        {"camera": "an insert on the photograph; static shot"},
        {"camera": "a low-angle wide; a tracking shot follows him out"},
    ]
    assert sp.camera_issues(shots) == []


def test_scene_shot_issues_wants_decomposition():
    scene = {"slug": "BAR", "duration_ms": 20000, "type": "dialogue", "beats": []}
    shots = [{"camera": "a medium shot", "duration_ms": 20000, "dialogue": []}]
    issues = sp.scene_shot_issues(scene, shots)
    assert any("decompose" in i for i in issues)


def test_missing_cast_finds_speakers_and_walkons():
    story = {
        "characters": [{"name": "Leon"}],
        "scenes": [{"slug": "A", "cast": ["Leon", "The Mentor"],
                    "beats": [{"dialogue": [{"speaker": "Mara", "line": "hi"}]}]}],
    }
    missing = sp.missing_cast(story)
    assert "The Mentor" in missing and "Mara" in missing and "Leon" not in missing


# ----------------------------------------------------- dialogue reconciling ---
def _scene():
    return {
        "slug": "BAR", "type": "dialogue", "duration_ms": 12000,
        "cast": ["Leon", "Mara"],
        "beats": [
            {"label": "greeting", "intent": "warmth", "action": "They meet.",
             "dialogue": [{"speaker": "Leon", "line": "You came."}]},
            {"label": "the reveal", "intent": "doubt", "action": "She tells him.",
             "dialogue": [{"speaker": "Mara", "line": "I never left the city."}]},
        ],
    }


def test_reconcile_restores_dropped_lines_and_cuts_invented_ones():
    scene = _scene()
    shots = [
        {"beat": "greeting", "duration_ms": 4000, "camera": "a wide shot",
         "action": "They meet.", "dialogue": [{"speaker": "Leon", "line": "You came."}]},
        {"beat": "the reveal", "duration_ms": 4000, "camera": "a close-up",
         "action": "She tells him.",
         "dialogue": [{"speaker": "Mara", "line": "This line was never written."}]},
    ]
    sp.reconcile_dialogue(scene, shots)
    all_lines = [d["line"] for sh in shots for d in sh["dialogue"]]
    assert "You came." in all_lines
    assert "I never left the city." in all_lines          # restored
    assert "This line was never written." not in all_lines  # cut


def test_attach_beats_resolves_labels_and_inherits():
    scene = _scene()
    shots = [
        {"beat": "greeting", "action": "a"}, {"beat": None, "action": "b"},
        {"beat": "the reveal", "action": "c"}, {"beat": "b2", "action": "d"},
    ]
    sp.attach_beats(scene, shots)
    assert [s["beat_idx"] for s in shots] == [0, 0, 1, 1]
    assert shots[2]["beat_label"] == "the reveal"


# ------------------------------------------------------------ split fallback --
def test_enforce_min_shots_splits_mechanically():
    scene = {"slug": "A", "type": "dialogue", "duration_ms": 20000, "beats": []}
    shots = [{"beat": None, "duration_ms": 20000, "camera": "a wide shot; static",
              "action": "First thing happens. Then the second thing happens.",
              "dialogue": [], "cast": []}]
    out = sp.enforce_min_shots(scene, shots)
    assert len(out) >= sp.min_shots(20000)
    assert sum(s["duration_ms"] for s in out) == 20000
    # the split halves must not share the identical camera
    assert out[0]["camera"] != out[1]["camera"]


def test_split_keeps_dialogue_where_it_fits():
    shot = {"duration_ms": 6000, "camera": "a medium shot", "action": "One. Two.",
            "dialogue": [{"speaker": "L", "line": "a few words"}]}
    a, b = sp.split_shot(shot)
    assert a["dialogue"] and not b["dialogue"]


# ------------------------------------------------------------- normalizing ---
def test_normalize_story_requires_scenes():
    with pytest.raises(sp.PlanError):
        sp.normalize_story({"scenes": []})


def test_normalize_shots_degrades_to_one_shot_per_beat():
    story = sp.normalize_story({
        "characters": [{"name": "Leon"}],
        "scenes": [{**_scene(), "slug": "BAR"}],
    })
    out = sp.normalize_shots({}, story)      # cinematographer returned nothing
    assert len(out["BAR"]) == 2              # one per narrative beat
    assert out["BAR"][0]["dialogue"][0]["line"] == "You came."


# ---------------------------------------------------------------- pipeline ---
def _writer_json():
    return json.dumps({
        "title": "T", "world": {"era": "2087", "palette": "teal, rust",
                                "props": [{"name": "the locket", "look": "brass",
                                           "why": "her face is inside", "scenes": ["BAR"]}]},
        "characters": [
            {"name": "Leon", "role": "lead", "identity_line": "short black hair",
             "voice": "a low, tired voice", "outfits": []},
        ],
        "environments": [{"name": "Bar", "identity_line": "neon bar", "palette": "teal"}],
        "scenes": [_scene() | {"environment": "Bar"}],
        "soundscape": "hum", "music": "synth",
    })


def _cine_json(n_shots):
    shots = [{"beat": "greeting", "duration_ms": 6000,
              "camera": "a wide shot; the camera holds a static shot",
              "action": "They meet.", "cast": ["Leon"],
              "dialogue": [{"speaker": "Leon", "line": "You came."}]}
             for _ in range(n_shots)]
    return json.dumps({"scenes": [{"slug": "BAR", "shots": shots}]})


def test_run_pipeline_end_to_end_with_scripted_llm():
    calls = []

    def ask(stage, contract, messages, max_tokens):
        calls.append(stage)
        if stage == "writer" and calls.count("writer") == 1:
            return _writer_json()
        if stage == "writer":                 # missing-cast repair
            return json.dumps({"characters": [
                {"name": "Mara", "role": "supporting",
                 "identity_line": "red coat", "voice": "a bright voice"}]})
        if stage == "editor":
            return json.dumps({"notes": [], "revised": json.loads(_writer_json())})
        # cinematographer: first pass under-covers, the repair fixes it
        if calls.count("cinematographer") == 1:
            return _cine_json(1)
        return json.dumps({"scenes": [{"slug": "BAR", "shots": [
            {"beat": "greeting", "duration_ms": 5000,
             "camera": "a wide establishing shot; static",
             "action": "They meet.", "cast": ["Leon"],
             "dialogue": [{"speaker": "Leon", "line": "You came."}]},
            {"beat": "the reveal", "duration_ms": 4000,
             "camera": "a close-up; the camera pushes in with small amplitude",
             "action": "She tells him.", "cast": ["Mara"],
             "dialogue": [{"speaker": "Mara", "line": "I never left the city."}]},
            {"beat": "the reveal", "duration_ms": 3000,
             "camera": "an over-the-shoulder medium on Leon's reaction",
             "action": "He takes it in.", "cast": ["Leon", "Mara"], "dialogue": []},
        ]}]})

    story, shots, notes = sp.run_pipeline(
        brief_json="{}", treatment="", ask=ask, note=lambda s: None,
        target_ms=12000)
    assert {c["name"] for c in story["characters"]} >= {"Leon", "Mara"}
    assert len(shots["BAR"]) >= 2
    # every written line survives placement
    lines = [d["line"] for sh in shots["BAR"] for d in sh["dialogue"]]
    assert "I never left the city." in lines
    # the writer's narrative beats are attached to shots
    assert all("beat_idx" in sh for sh in shots["BAR"])
    # durations were fitted to the target with floors respected
    total = sum(sh["duration_ms"] for sh in shots["BAR"])
    assert total >= 11000


# ----------------------------------------------------- positions + intensity --
def _action_scene(**over):
    sc = {"slug": "VAULT", "type": "action", "duration_ms": 12000,
          "cast": ["Ash", "Vex"],
          "beats": [{"label": "the clash", "action": "Ash and Vex clash",
                     "dialogue": []}]}
    sc.update(over)
    return sc


def test_positions_survive_normalize_only_for_shot_cast():
    cine = {"scenes": [{"slug": "VAULT", "shots": [
        {"beat": "the clash", "duration_ms": 4000,
         "camera": "a wide shot; the camera tracks right at fast speed",
         "action": "Ash drives Vex back against the teller cage",
         "cast": ["Ash", "Vex"],
         "positions": {"Ash": "at the teller cage", "Vex": "at the teller cage",
                       "Moth": "on the catwalk",       # not in this shot
                       "Ash2": ""},                    # empty -> dropped
         "dialogue": []}]}]}
    story = {"characters": [{"name": "Ash"}, {"name": "Vex"}],
             "scenes": [_action_scene()]}
    shots = sp.normalize_shots(cine, story)["VAULT"]
    assert shots[0]["positions"] == {"Ash": "at the teller cage",
                                     "Vex": "at the teller cage"}


def test_action_scene_flags_bare_positions_and_static_monoculture():
    shots = [{"beat": "the clash", "duration_ms": 4000,
              "camera": "a wide shot; the camera holds a static shot",
              "action": "x", "cast": ["Ash", "Vex"], "dialogue": []},
             {"beat": "the clash", "duration_ms": 4000,
              "camera": "a medium shot; the camera holds a static shot",
              "action": "y", "cast": ["Ash", "Vex"], "dialogue": []},
             {"beat": "the clash", "duration_ms": 4000,
              "camera": "a close-up; the camera holds a static shot",
              "action": "z", "cast": ["Ash", "Vex"], "dialogue": []}]
    probs = " ".join(sp.scene_shot_issues(_action_scene(), shots))
    assert "positions" in probs
    assert "static" in probs
    # positioned, kinetic coverage passes both new checks
    good = [{**s, "positions": {"Ash": "left", "Vex": "right"},
             "camera": c} for s, c in zip(shots, (
        "a wide shot; the camera tracks right at fast speed",
        "a medium shot; the camera pushes in at fast speed",
        "a close-up; the camera shakes with small amplitude at fast speed"))]
    probs2 = " ".join(sp.scene_shot_issues(_action_scene(), good))
    assert "positions" not in probs2 and "static" not in probs2


def test_voice_pass_merges_defensively():
    story = {"characters": [{"name": "Ash"}, {"name": "Vex"}],
             "scenes": [{"slug": "VAULT", "beats": [
                 {"label": "b0", "dialogue": [
                     {"speaker": "Ash", "line": "We should go inside now."},
                     {"speaker": "Vex", "line": "I do not think that is wise."}]},
                 {"label": "b1", "dialogue": [
                     {"speaker": "Ash", "line": "Open it."}]}]}]}
    data = {"scenes": [{"slug": "VAULT", "beats": [
        # valid rewrite: same speakers, same order, sane lengths
        {"idx": 0, "dialogue": [
            {"speaker": "Ash", "line": "Inside. Now.", "delivery": "clipped"},
            {"speaker": "Vex", "line": "And walk into their arms? No."}]},
        # invalid: swapped speaker -> rejected whole
        {"idx": 1, "dialogue": [{"speaker": "Vex", "line": "Open it."}]},
    ]}]}
    changed = sp.merge_voice_pass(story, data)
    beats = story["scenes"][0]["beats"]
    assert changed == 2
    assert beats[0]["dialogue"][0]["line"] == "Inside. Now."
    assert beats[0]["dialogue"][0]["delivery"] == "clipped"
    assert beats[1]["dialogue"][0]["speaker"] == "Ash"       # rejected
    assert beats[1]["dialogue"][0]["line"] == "Open it."
    # a rewrite that balloons a line past the ±40% bound is rejected
    data2 = {"scenes": [{"slug": "VAULT", "beats": [
        {"idx": 1, "dialogue": [{"speaker": "Ash",
                                 "line": "Open it right now before the whole "
                                         "grid wakes up and finds us standing "
                                         "here like fools."}]}]}]}
    assert sp.merge_voice_pass(story, data2) == 0


# ------------------------------------------------------ continuity director --
def _blocked_scene():
    return {"slug": "OBS", "type": "dialogue", "duration_ms": 12000,
            "cast": ["Noa", "Iri"],
            "beats": [{"label": "arrival", "action": "Noa enters", "dialogue": []},
                      {"label": "the ask", "action": "they talk",
                       "dialogue": [{"speaker": "Iri", "line": "You came back."}]},
                      {"label": "the turn", "action": "Iri stands",
                       "dialogue": [{"speaker": "Noa", "line": "I always do."}]}]}


def test_blocking_states_apply_changes_and_exits():
    bl = {"map": "the tide pool faces the shattered dome",
          "start": {"Iri": {"at": "the tide pool", "facing": "the doorway",
                            "doing": "seated"}},
          "beats": [{"idx": 0, "changes": {"Noa": {"enters": True,
                     "at": "the doorway", "facing": "Iri"}}},
                    {"idx": 2, "changes": {"Iri": {"doing": "standing",
                     "facing": "Noa"}, "Noa": {"exits": True}}}]}
    states = sp.blocking_states(bl, 3)
    assert states[0]["Noa"]["at"] == "the doorway"
    assert states[1]["Iri"]["doing"] == "seated"
    assert "Noa" not in states[2]
    assert states[2]["Iri"]["facing"] == "Noa"


def test_parse_blocking_recovers_the_stranded_exits_flag():
    """The bug that made the Continuity Director silently do nothing.

    gpt-5.6-luna reaches for the enters/exits flag and collapses it into the
    preceding value — `"doing":"exits":true` — which is a syntax error roughly
    4000 characters into a 15KB artifact. json_repair can strip fences and
    truncation but not a malformation mid-document, so the whole response
    failed to parse and ALL TEN scenes lost their blocking. Observed twice on
    AFTERLIGHT E3, at the first character to leave a scene in both runs.
    """
    from llm import json_repair
    raw = ('{"scenes":[{"slug":"A","map":"the pool faces the dome",'
           '"start":{"Iri":{"at":"the pool","facing":"the dome","doing":"seated"}},'
           '"beats":[{"idx":1,"changes":{"Noa":{"at":"the doorway",'
           '"facing":"Iri","doing":"exits":true}}}]},'
           '{"slug":"B","map":"the rail faces the skyline",'
           '"start":{"Iri":{"at":"the rail","facing":"the skyline","doing":"standing"}},'
           '"beats":[]}]}')
    with pytest.raises(Exception):
        sp.normalize_blocking(json_repair(raw))       # what shipped
    got = sp.parse_blocking(raw, json_repair)
    assert sorted(got) == ["A", "B"], got
    assert got["A"]["map"].startswith("the pool")
    # the flag survives as the key blocking_states actually reads
    assert got["A"]["beats"][0]["changes"]["Noa"]["exits"] is True
    assert "Noa" not in sp.blocking_states(got["A"], 3)[1]


def test_parse_blocking_keeps_the_scenes_it_can_when_one_is_garbage():
    """normalize_blocking promises "garbage in a scene drops that scene's
    blocking, never the pass" — impossible while the parse feeding it is
    all-or-nothing. One unrecoverable scene must cost one scene."""
    from llm import json_repair
    raw = ('{"scenes":[{"slug":"GOOD","map":"m",'
           '"start":{"Iri":{"at":"the pool"}},"beats":[]},'
           '{"slug":"BROKEN","map":"m","start":{"Iri":{"at":}},"beats":[]},'
           '{"slug":"ALSOGOOD","map":"m",'
           '"start":{"Noa":{"at":"the rail"}},"beats":[]}]}')
    got = sp.parse_blocking(raw, json_repair)
    assert sorted(got) == ["ALSOGOOD", "GOOD"], got


def test_blocking_issues_catch_contradictions():
    sc = _blocked_scene()
    # Noa never gets a start or an entrance
    bl = {"start": {"Iri": {"at": "the tide pool"}},
          "beats": [{"idx": 2, "changes": {"Noa": {"exits": True}}}]}
    probs = " ".join(sp.blocking_issues(sc, bl))
    assert "Noa" in probs and "no start" in probs
    # complete blocking passes clean
    good = {"start": {"Iri": {"at": "the tide pool"},
                      "Noa": {"at": "the doorway"}}, "beats": []}
    assert sp.blocking_issues(sc, good) == []
    # a tracked speaker who exited before their line is flagged
    gone = {"start": {"Iri": {"at": "the tide pool"},
                      "Noa": {"at": "the doorway"}},
            "beats": [{"idx": 1, "changes": {"Noa": {"exits": True}}}]}
    probs2 = " ".join(sp.blocking_issues(sc, gone))
    assert "exited" in probs2


def test_apply_blocking_positions_overrides_the_dp():
    sc = _blocked_scene()
    bl = {"start": {"Iri": {"at": "the tide pool", "facing": "the doorway",
                            "doing": "seated"},
                    "Noa": {"at": "the doorway", "facing": "Iri"}},
          "beats": []}
    shots = [{"beat_idx": 0, "cast": ["Iri", "Noa"],
              "positions": {"Iri": "somewhere wrong", "Ghost": "kept"}}]
    sp.apply_blocking_positions(sc, shots, bl)
    assert shots[0]["positions"]["Iri"] == "at the tide pool, facing the doorway, seated"
    assert shots[0]["positions"]["Noa"] == "at the doorway, facing Iri"
    # untracked characters keep the DP's positions
    assert shots[0]["positions"]["Ghost"] == "kept"


def test_duplicate_cast_merges_token_subset_names():
    story = {"characters": [
        {"name": "Mika Chen", "identity_line": "a long full identity line about Mika"},
        {"name": "Mika", "identity_line": "short"},
        {"name": "Rei", "identity_line": "x"},
        {"name": "Reina", "identity_line": "y"}],
        "scenes": [{"slug": "A", "cast": ["Mika", "Rei"], "beats": [
            {"label": "b", "dialogue": [{"speaker": "Mika", "line": "hi"}]}]}]}
    n = sp.merge_duplicate_cast(story)
    assert n == 1
    names = {c["name"] for c in story["characters"]}
    assert names == {"Mika Chen", "Rei", "Reina"}   # Rei/Reina stay distinct
    assert story["scenes"][0]["cast"] == ["Mika Chen", "Rei"]
    assert story["scenes"][0]["beats"][0]["dialogue"][0]["speaker"] == "Mika Chen"


def test_position_text_forms():
    assert sp.position_text({"at": "the teller cage", "facing": "Mika",
                             "doing": "seated"}) \
        == "at the teller cage, facing Mika, seated"
    assert sp.position_text({"at": "behind the console"}) == "behind the console"
    assert sp.position_text({"doing": "standing"}) == ""


# ------------------------------------------------- dialogue validators ------
def _script(lines_by_scene, characters):
    """[(slug, [(speaker, line), ...])] -> a story dict."""
    return {
        "characters": characters,
        "scenes": [{"slug": slug,
                    "beats": [{"label": f"b{i}",
                               "dialogue": [{"speaker": sp, "line": ln}]}
                              for i, (sp, ln) in enumerate(pairs)]}
                   for slug, pairs in lines_by_scene],
    }


def test_dialogue_issues_flags_all_complete_sentences():
    """E2 delivered 91-100% complete grammatical sentences against a contract
    that asks in plain language for trailing off. Only a check catches it."""
    story = _script([("S1", [("Aki", "The pigment did not fade."),
                             ("Haru", "It was removed."),
                             ("Aki", "Then someone removed it."),
                             ("Haru", "Someone did.")])],
                    [{"name": "Aki"}, {"name": "Haru"}])
    probs = sp.dialogue_issues(story)
    assert any("complete grammatical sentences" in p for p in probs)
    assert any("nobody interrupts" in p for p in probs)
    # a scene with real seams passes both
    ok = _script([("S1", [("Aki", "The pigment didn't—"),
                          ("Haru", "Removed. Yes."),
                          ("Aki", "By who?"),
                          ("Haru", "Ask the book")])],
                 [{"name": "Aki"}, {"name": "Haru"}])
    probs2 = sp.dialogue_issues(ok)
    assert not any("complete grammatical sentences" in p for p in probs2)
    assert not any("nobody interrupts" in p for p in probs2)


def test_dialogue_issues_catches_an_unkept_speech_pattern():
    """Aki's pattern promised colours; 0 of her 30 delivered lines had one."""
    story = _script([("S1", [("Aki", "It faded."), ("Aki", "All of it."),
                             ("Aki", "Gone now."), ("Aki", "Just gone")])],
                    [{"name": "Aki",
                      "speech_pattern": "She names colors and counts things."}])
    probs = sp.dialogue_issues(story)
    assert any("a colour word" in p and "Aki" in p for p in probs)
    assert any("a number" in p and "Aki" in p for p in probs)
    # keeping the promise clears it
    kept = _script([("S1", [("Aki", "The indigo faded."), ("Aki", "Three pages."),
                            ("Aki", "Gone now."), ("Aki", "Just gone")])],
                   [{"name": "Aki",
                     "speech_pattern": "She names colors and counts things."}])
    probs2 = sp.dialogue_issues(kept)
    assert not any("a colour word" in p for p in probs2)
    assert not any("a number" in p for p in probs2)


def test_dialogue_issues_flags_stated_emotion_and_thin_parts():
    story = _script([("S1", [("Ren", "I'm scared of what it means."),
                             ("Aki", "Don't be."), ("Aki", "Look at it."),
                             ("Aki", "Count the pages."), ("Aki", "Six"),
                             ("Aki", "Six exactly")])],
                    [{"name": "Ren"}, {"name": "Aki"}])
    probs = sp.dialogue_issues(story)
    assert any("states their own feeling" in p and "Ren" in p for p in probs)
    # Ren speaks once -> too thin to be a person (E2: Ren had 3, Katagiri 2)
    assert any("speaks only 1 time" in p for p in probs)
    # Aki has 5 -> at the floor, not flagged
    assert not any(p.startswith("Aki speaks only") for p in probs)


def test_merge_character_pass_touches_only_that_speaker():
    story = _script([("S1", [("Aki", "The pigment did not fade."),
                             ("Haru", "It was removed.")])],
                    [{"name": "Aki"}, {"name": "Haru"}])
    # rewrite returns BOTH speakers; only Aki's may be applied
    data = {"scenes": [{"slug": "S1", "beats": [
        {"idx": 0, "dialogue": [{"speaker": "Aki", "line": "The indigo didn't fade."}]},
        {"idx": 1, "dialogue": [{"speaker": "Haru", "line": "TAMPERED WITH ENTIRELY"}]}]}]}
    n = sp.merge_character_pass(story, data, "Aki")
    assert n == 1
    beats = story["scenes"][0]["beats"]
    assert beats[0]["dialogue"][0]["line"] == "The indigo didn't fade."
    assert beats[1]["dialogue"][0]["line"] == "It was removed."   # untouched


def test_merge_character_pass_rejects_a_length_blowout():
    story = _script([("S1", [("Aki", "Gone.")])], [{"name": "Aki"}])
    data = {"scenes": [{"slug": "S1", "beats": [{"idx": 0, "dialogue": [
        {"speaker": "Aki", "line": "It is comprehensively and utterly gone "
                                   "from every page I have ever drawn"}]}]}]}
    assert sp.merge_character_pass(story, data, "Aki") == 0
    assert story["scenes"][0]["beats"][0]["dialogue"][0]["line"] == "Gone."


def test_character_messages_marks_only_the_target_mutable():
    story = _script([("S1", [("Aki", "One."), ("Haru", "Two.")]),
                     ("S2", [("Ren", "Three.")])],
                    [{"name": "Aki", "speech_pattern": "counts"},
                     {"name": "Haru"}, {"name": "Ren"}])
    msgs = sp.character_messages(story, "Aki")
    doc = json.loads(msgs[0]["content"])
    assert doc["rewrite_only"] == "Aki"
    assert doc["character"]["speech_pattern"] == "counts"
    # S2 has no Aki line -> omitted entirely
    assert [s["slug"] for s in doc["scenes"]] == ["S1"]
    mine = [d["mine"] for b in doc["scenes"][0]["beats"] for d in b["dialogue"]]
    assert mine == [True]          # only Aki's beat is included


def test_every_stage_storyplan_asks_for_is_registered_in_llm():
    """A stage id missing from llm.stage_system KeyErrors inside each stage's
    advisory try/except and logs 'skipped' — which is how the dialogue polish
    silently never ran on any episode before E1. The failure is invisible
    unless something checks, so this is what checks."""
    import re
    from pathlib import Path
    here = Path(__file__).resolve().parents[1]
    asked = set(re.findall(r'ask\("([a-z_]+)"',
                           (here / "storyplan.py").read_text()))
    registered = set(re.findall(r'^        "([a-z_]+)": persona',
                                (here / "llm.py").read_text(), re.M))
    assert asked, "no stages found — did ask() change shape?"
    assert not (asked - registered), \
        f"unregistered stage(s) will silently skip: {sorted(asked - registered)}"


def test_breath_shot_is_added_before_a_scene_change():
    """Scenes cut straight out of a spoken line into the next location, which
    reads as rushed. A wordless held beat at the end is deterministic; asking
    the writer for 'room to breathe' returns adjectives, not shots."""
    from storyplan import add_breath_shot, shot_floor_ms, BREATH_FLOOR_MS
    shots = [{"camera": "medium", "action": "she turns", "duration_ms": 4000,
              "dialogue": [{"speaker": "Aki", "line": "Don't cross."}]}]
    out = add_breath_shot({"slug": "S1"}, list(shots))
    assert len(out) == 2
    assert out[-1]["dialogue"] == []
    assert out[-1]["meta"]["breath"] is True
    # …and it must survive duration fitting rather than being squeezed flat
    assert shot_floor_ms(out[-1]) == BREATH_FLOOR_MS


def test_breath_shot_not_added_when_the_scene_already_ends_quiet():
    from storyplan import add_breath_shot
    shots = [{"camera": "wide", "action": "rain falls", "duration_ms": 3000,
              "dialogue": []}]
    assert len(add_breath_shot({"slug": "S1"}, list(shots))) == 1


def test_breath_shot_keeps_its_length_through_fitting():
    from storyplan import add_breath_shot, fit_shot_durations, BREATH_FLOOR_MS
    shots = add_breath_shot({"slug": "S1"}, [
        {"camera": "a", "action": "x", "duration_ms": 4000,
         "dialogue": [{"speaker": "Aki", "line": "Don't cross."}]}])
    # squeeze hard: a target far under the natural total
    fit_shot_durations([{"slug": "S1", "shots": shots}], 3000)
    assert shots[-1]["duration_ms"] >= BREATH_FLOOR_MS


def test_a_cast_of_deliberate_variants_is_not_merged_away():
    """Measured on a real episode: the cast was Rei, Guide Rei, Knight Rei,
    Villian Rei and Astronaut — five versions of one person, which is the
    premise of the show. Bare token-subset made `Rei` a duplicate of whichever
    Rei came first, so the PROTAGONIST was silently deleted and her sheet had
    no entry to attach to. This is a mechanical merge, not a hint: nothing on
    screen said it had happened."""
    story = {"characters": [
        {"name": "Rei", "identity_line": "black bob, turquoise streak, zip hoodie"},
        {"name": "Guide Rei", "identity_line": "orange astronaut jumpsuit, helmet"},
        {"name": "Knight Rei", "identity_line": "plate armour, shield, long sword"},
        {"name": "Villian Rei", "identity_line": "high-collar coat, glitching seams"}],
        "scenes": [{"slug": "A", "cast": ["Rei", "Guide Rei"], "beats": [
            {"label": "b", "dialogue": [{"speaker": "Rei", "line": "hi"}]}]}]}
    assert sp.merge_duplicate_cast(story) == 0
    assert {c["name"] for c in story["characters"]} == {
        "Rei", "Guide Rei", "Knight Rei", "Villian Rei"}
    assert story["scenes"][0]["beats"][0]["dialogue"][0]["speaker"] == "Rei"


def test_an_exact_repeat_is_still_merged_however_many_relatives_it_has():
    """Exactness is not ambiguous, so the uniqueness rule must not touch it."""
    story = {"characters": [
        {"name": "Guide Rei", "identity_line": "the long one"},
        {"name": "guide rei", "identity_line": "short"},
        {"name": "Knight Rei", "identity_line": "armour"},
        {"name": "Rei", "identity_line": "hoodie"}],
        "scenes": []}
    assert sp.merge_duplicate_cast(story) == 1
    assert {c["name"] for c in story["characters"]} == {"Guide Rei", "Knight Rei", "Rei"}


# --- a shot's cast must cover the people its own action names ---------------
CANDS = ["Guide Rei — Guide astronaut outfit", "Rei — Travel-worn survivor outfit",
         "Knight Rei", "Fractured Reflection Creature — Reflection creature form"]
ACTION = ("Guide Rei snaps her head toward Rei and raises one gloved hand "
          "between Rei's face and the pane, stopping short of contact.")


def test_a_partial_cast_list_is_completed_from_the_action():
    """Measured: the cinematographer wrote this action and cast ["Guide Rei"].
    `beats.meta.cast` is what panelSpec stages sheets from, so the panel was
    drawn with one face reference and Rei — half the shot — was absent. The
    old code only filled a cast in when the model sent NONE."""
    from storyplan import union_named_cast
    out = union_named_cast(["Guide Rei"], ACTION, CANDS)
    assert "Guide Rei" in out
    assert any(n.startswith("Rei") for n in out), "Rei is named twice and was dropped"


def test_a_longer_name_does_not_drag_in_the_shorter_one():
    """'Guide Rei', 'Knight Rei' and 'Rei' are three people in this project.
    A substring test says every sentence about the guide also mentions Rei —
    consuming the longest match first is what keeps them apart."""
    from storyplan import union_named_cast
    assert union_named_cast(["Guide Rei"], "Guide Rei lowers her hand.", CANDS) == ["Guide Rei"]
    out = union_named_cast([], "Knight Rei raises the shield.", CANDS)
    assert out == ["Knight Rei"]


def test_nobody_named_means_nobody_added():
    from storyplan import union_named_cast
    assert union_named_cast([], "The pane shudders and cracks.", CANDS) == []
    assert union_named_cast([], "", CANDS) == []


def test_the_variant_spelling_and_the_base_name_are_one_person():
    """A scene casts 'Rei — Travel-worn survivor outfit'; the prose says 'Rei'.
    Adding both would stage two sheets for one character."""
    from storyplan import union_named_cast
    out = union_named_cast(["Rei — Travel-worn survivor outfit"], "Rei steps back.", CANDS)
    assert out == ["Rei — Travel-worn survivor outfit"]


# -------------------------------------------------------- location binding --
# Cast completeness's twin. A scene whose environment is unset or unlisted
# binds to no bible entry downstream: no location reference staged, no plate
# rotation, the place re-invents itself panel to panel. Rei E3's
# ASTRONAUT-CAPTURE shipped exactly that way.

def test_missing_locations_flags_unset_and_unlisted_scenes():
    story = {"environments": [{"name": "Glass House"}],
             "scenes": [{"slug": "A", "environment": "Glass House"},
                        {"slug": "B", "environment": "Capture Space"},
                        {"slug": "C"}]}
    got = sp.missing_locations(story)
    assert [(m["slug"], m["environment"]) for m in got] == [
        ("B", "Capture Space"), ("C", None)]


def test_missing_locations_matches_names_case_insensitively():
    story = {"environments": [{"name": "Glass House"}],
             "scenes": [{"slug": "A", "environment": "glass house"}]}
    assert sp.missing_locations(story) == []


def test_fallback_location_keeps_the_name_the_scene_asked_for():
    """The writer meant something by the name; inventing a second one for the
    same place is how bibles fill with duplicates."""
    env = sp.fallback_location({"slug": "ASTRONAUT-CAPTURE",
                                "environment": "Capture Space",
                                "purpose": "Reveal the capture.",
                                "vfx_ref": {"prompt": "A dark fractured capture "
                                            "space of blue-violet crystal planes."}})
    assert env["name"] == "Capture Space"
    assert "crystal planes" in env["identity_line"]


def test_fallback_location_derives_a_name_from_the_slug_when_none_given():
    env = sp.fallback_location({"slug": "ASTRONAUT-CAPTURE",
                                "blocking": {"map": "The suspended avenue runs "
                                             "beneath fractured tower faces."}})
    assert env["name"] == "Astronaut Capture"
    assert "suspended avenue" in env["identity_line"]
    # binding always succeeds, even off an empty scene
    bare = sp.fallback_location({"slug": ""})
    assert bare["name"] and bare["identity_line"]


# ------------------------------------------------------- angle monoculture --
# The camera checks could see repeated setups and missing sizes but not a
# scene shot entirely at flat eye level — and the renderers OBEY stated
# angles now, so an angle never asked for is never shot.

def _cams(cams):
    return [{"camera": c} for c in cams]


def test_an_all_eye_level_scene_is_flagged():
    issues = sp.camera_issues(_cams([
        "a wide shot at eye level; the camera holds",
        "a medium two-shot at eye level; the camera pushes in",
        "a close-up at eye level; the camera holds",
        "a lateral medium shot at eye level; the camera pans left",
        "an insert at eye level; the camera holds",
    ]))
    assert any("flat eye level" in i for i in issues), issues


def test_one_angled_setup_satisfies_it():
    issues = sp.camera_issues(_cams([
        "a wide shot at eye level; the camera holds",
        "a medium two-shot at eye level; the camera pushes in",
        "a low-angle close-up; the camera tracks right",
        "a lateral medium shot at eye level; the camera pans left",
        "an insert at eye level; the camera holds",
    ]))
    assert not any("flat eye level" in i for i in issues), issues


def test_an_over_the_shoulder_counts_as_an_angle():
    issues = sp.camera_issues(_cams([
        "a wide shot at eye level", "a medium shot at eye level",
        "an over-the-shoulder close-up behind Rei",
        "a close-up at eye level", "a full shot at eye level",
    ]))
    assert not any("flat eye level" in i for i in issues), issues


def test_small_scenes_are_left_alone():
    # Four shots is too small a sample to call a monoculture.
    issues = sp.camera_issues(_cams([
        "a wide shot at eye level", "a close-up at eye level",
        "a medium shot at eye level", "an insert at eye level"]))
    assert not any("flat eye level" in i for i in issues), issues

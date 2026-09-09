"""merge_brief is the local backend's half of the wizard brief.

The hosted endpoint merges in JS (director/brief.js) and the worker merges here;
a divergence would mean the panel says one thing and the planner gets another.
These cases are the same ones director/brief.test.mjs asserts.
"""
import pytest

import director_tools as dt


def test_patch_adds_without_erasing():
    a = dt.merge_brief({}, {"logline": "A diver returns to a drowned town.", "tone": "elegiac"})
    b = dt.merge_brief(a, {"turn": "the town is inhabited"})
    assert b["logline"] == "A diver returns to a drowned town."
    assert b["tone"] == "elegiac"
    assert b["turn"] == "the town is inhabited"


def test_blank_never_overwrites():
    b = dt.merge_brief({"logline": "kept"}, {"logline": "   ", "tone": "cold"})
    assert b["logline"] == "kept"
    assert b["tone"] == "cold"


def test_cast_merges_per_name():
    a = dt.merge_brief({}, {"cast": [{"name": "Mara", "role": "the diver"}]})
    b = dt.merge_brief(a, {"cast": [{"name": "mara", "look": "shaved head, burn scar"},
                                    {"name": "Ivo", "role": "harbourmaster"}]})
    assert len(b["cast"]) == 2
    assert b["cast"][0] == {"name": "Mara", "role": "the diver", "look": "shaved head, burn scar"}
    assert b["cast"][1]["name"] == "Ivo"


def test_previous_name_renames_in_place():
    a = dt.merge_brief({}, {"cast": [{"name": "Diver", "role": "protagonist",
                                      "look": "wetsuit, dive knife"}]})
    b = dt.merge_brief(a, {"cast": [{"name": "Mara", "previous_name": "Diver",
                                     "look": "shaved head, burn scar on the jaw"}]})
    assert len(b["cast"]) == 1
    assert b["cast"][0]["name"] == "Mara"
    assert b["cast"][0]["role"] == "protagonist"
    assert b["cast"][0]["look"] == "shaved head, burn scar on the jaw"


def test_remove_drops_vetoed_entries():
    a = dt.merge_brief({}, {"cast": [{"name": "Mara"}, {"name": "Ivo"}],
                            "references": ["Stalker", "Jaws"]})
    b = dt.merge_brief(a, {"remove": {"cast": ["ivo"], "references": ["Jaws"]}})
    assert [c["name"] for c in b["cast"]] == ["Mara"]
    assert b["references"] == ["Stalker"]


def test_lists_union_case_insensitively():
    b = dt.merge_brief({"references": ["Stalker"]}, {"references": ["stalker", "Jaws"]})
    assert b["references"] == ["Stalker", "Jaws"]


def test_resolved_questions_close_open_ones():
    a = dt.merge_brief({}, {"open_questions": ["who owns the boat?", "what season?"]})
    b = dt.merge_brief(a, {"resolved_questions": ["Who owns the boat?"]})
    assert b["open_questions"] == ["what season?"]


def test_open_questions_are_gaps_not_the_question_just_asked():
    b = dt.merge_brief({}, {"open_questions": [
        "tone: action or dread",
        "what season",
        "does the brother speak?",
        "What kind of excitement are you thinking about? Do you want it to feel like "
        "high-paced action, a suspenseful moment, or something emotionally intense?",
        "Who is this story really about, and what do they stand to lose?",
    ]})
    assert b["open_questions"] == ["tone: action or dread", "what season",
                                   "does the brother speak?"]


def test_stale_questions_clear_on_the_next_merge():
    stale = {"open_questions": ["What kind of excitement are you thinking about? Do you want "
                                "high-paced action, or something emotionally intense?"]}
    assert dt.merge_brief(stale, {"open_questions": ["what season"]})["open_questions"] == \
        ["what season"]


def test_shape_and_expert_notes_merge_fieldwise():
    a = dt.merge_brief({}, {"shape": {"length_s": 64}, "expert_notes": {"vfx": "practical smoke"}})
    b = dt.merge_brief(a, {"shape": {"structure": "cold open / turn / tag"},
                           "expert_notes": {"costume": "salt-bleached oilskin", "astrology": "no"}})
    assert b["shape"] == {"length_s": 64, "structure": "cold open / turn / tag"}
    assert b["expert_notes"] == {"vfx": "practical smoke", "costume": "salt-bleached oilskin"}


def test_missing_lists_the_gaps():
    assert "the turn" in dt._brief_missing({"logline": "x"})
    assert dt._brief_missing({
        "logline": "A diver returns.", "turn": "the town is inhabited",
        "cast": [{"name": "Mara", "look": "shaved head"}],
        "world": [{"name": "Halvard Bay"}], "tone": "elegiac"}) == []


def test_note_brief_merges_onto_the_thread_row(monkeypatch):
    """The tool reads the row, merges, writes back — a second call must not
    lose what the first one established."""
    row = {"brief": {}}
    monkeypatch.setattr(dt.sb, "get", lambda path: [row] if "chat_threads" in path else [])
    monkeypatch.setattr(dt.sb, "patch", lambda path, body: row.update(body))

    ctx = {"project_id": "p", "thread_id": "t"}
    first = dt.execute("note_brief", {"logline": "A diver returns.", "tone": "elegiac"}, ctx)
    assert first["noted"] is True
    assert first["ready"] is False
    assert "the turn" in first["still_missing"]

    second = dt.execute("note_brief", {
        "turn": "the town is inhabited",
        "cast": [{"name": "Mara", "look": "shaved head, burn scar"}],
        "world": [{"name": "Halvard Bay"}], "ready": True}, ctx)
    assert row["brief"]["logline"] == "A diver returns."
    assert second["still_missing"] == []
    assert second["ready"] is True


def test_note_brief_without_a_thread_is_an_error_not_a_crash():
    assert "error" in dt.execute("note_brief", {"logline": "x"}, {"project_id": "p"})


@pytest.mark.parametrize("name", ["note_brief"])
def test_schema_is_exposed_to_the_model(name):
    assert name in dt.TOOL_NAMES


# ------------------------------------------- user-supplied reference sheets ---
# Mirrors the ref-sheet cases in director/brief.test.mjs. The local backend is
# the one that CANNOT show the model the picture, so the id is the whole of
# what it has to work with — dropping it here loses the sheet entirely.
A1 = "11111111-2222-3333-4444-555555555555"
A2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def test_a_reference_picture_attaches_to_the_cast_member_it_shows():
    b = dt.merge_brief({}, {"cast": [{"name": "Guide Rei", "look": "silver undercut",
                                      "ref_asset_ids": [A1]}]})
    assert b["cast"][0]["ref_asset_ids"] == [A1]


def test_a_second_picture_is_another_sheet_not_a_correction():
    a = dt.merge_brief({}, {"cast": [{"name": "Rei", "ref_asset_ids": [A1]}]})
    b = dt.merge_brief(a, {"cast": [{"name": "Rei", "ref_asset_ids": [A2]}]})
    assert b["cast"][0]["ref_asset_ids"] == [A1, A2]
    c = dt.merge_brief(b, {"cast": [{"name": "Rei", "ref_asset_ids": [A1]}]})
    assert c["cast"][0]["ref_asset_ids"] == [A1, A2]


def test_a_patch_without_a_picture_keeps_the_pictures():
    a = dt.merge_brief({}, {"cast": [{"name": "Rei", "ref_asset_ids": [A1]}]})
    b = dt.merge_brief(a, {"cast": [{"name": "Rei", "want": "to get out"}]})
    assert b["cast"][0]["ref_asset_ids"] == [A1]
    assert b["cast"][0]["want"] == "to get out"


def test_a_rename_carries_the_pictures_with_it():
    a = dt.merge_brief({}, {"cast": [{"name": "the guide", "ref_asset_ids": [A1]}]})
    b = dt.merge_brief(a, {"cast": [{"name": "Rei", "previous_name": "the guide"}]})
    assert len(b["cast"]) == 1
    assert b["cast"][0]["name"] == "Rei"
    assert b["cast"][0]["ref_asset_ids"] == [A1]


def test_only_real_asset_ids_get_through():
    """A label reaching the planner as an id stages nothing and says nothing —
    the same silence as no sheet at all."""
    b = dt.merge_brief({}, {"cast": [{"name": "Rei",
                                      "ref_asset_ids": ["rei-sheet.png", "",
                                                        f"asset:{A1}", f"<{A2}>"]}]})
    assert b["cast"][0]["ref_asset_ids"] == [A1, A2]


def test_a_bare_string_is_taken_as_one_id():
    b = dt.merge_brief({}, {"world": [{"name": "The Loop", "ref_asset_ids": A1}]})
    assert b["world"][0]["ref_asset_ids"] == [A1]


def test_note_brief_schema_offers_ref_asset_ids_on_every_named_kind():
    schema = next(s for s in dt.SCHEMAS if s["function"]["name"] == "note_brief")
    props = schema["function"]["parameters"]["properties"]
    for key in ("cast", "world", "props"):
        assert "ref_asset_ids" in props[key]["items"]["properties"], key


# --------------------------------------------------------- attachment lines ---
def test_an_attached_picture_is_named_by_its_id_not_its_filename():
    """The local model cannot see it, so the id is the only thing it can act
    on — and note_brief's ref_asset_ids is exactly what takes an id."""
    lines = dt.attachment_lines([
        {"type": "text", "text": "here's the ref sheet"},
        {"type": "asset_ref", "asset_id": A1, "media": "image", "label": "rei.png",
         "width": 1024, "height": 1024},
    ])
    assert len(lines) == 1
    assert A1 in lines[0]
    assert "rei.png" in lines[0] and "1024x1024" in lines[0]
    assert "not viewable" in lines[0]


def test_an_attached_document_arrives_as_its_text():
    lines = dt.attachment_lines([
        {"type": "asset_ref", "asset_id": A1, "media": "file", "label": "lore.md",
         "text_content": "The Loop runs under the city."},
    ])
    assert "The Loop runs under the city." in lines[0]


def test_rows_with_no_attachments_produce_nothing():
    assert dt.attachment_lines([{"type": "text", "text": "hello"}]) == []
    assert dt.attachment_lines(None) == []


# ---------------------------------------------------- one thing, one entry ---
# Measured on a real thread: one marble came back as "Cloudy Glass Marbles",
# "Contained Black Hole Marble" and "Guide Rei's Cloudy Marble", and the planner
# would have rendered a reference sheet for each. Mirrors the JS cases.
MARBLE = "A small cloudy glass marble that unfolds into a thumb-sized perfectly black sphere"


def test_a_plural_or_possessive_is_the_same_entry():
    a = dt.merge_brief({}, {"props": [{"name": "Cloudy Glass Marble", "look": "small, cloudy"}]})
    b = dt.merge_brief(a, {"props": [{"name": "Cloudy Glass Marbles",
                                      "why": "her countermeasure"}]})
    assert len(b["props"]) == 1
    assert b["props"][0]["look"] == "small, cloudy"
    assert b["props"][0]["why"] == "her countermeasure"
    assert len(dt.merge_brief(b, {"props": [{"name": "The Cloudy Glass Marble"}]})["props"]) == 1


def test_two_genuinely_different_things_stay_two():
    b = dt.merge_brief({}, {"props": [{"name": "Portal Machine"},
                                      {"name": "Glass house reflection"}]})
    assert len(b["props"]) == 2
    assert dt.duplicate_groups(b["props"]) == []


def test_names_sharing_no_words_are_caught_by_their_description():
    groups = dt.duplicate_groups([
        {"name": "Contained Black Hole Marble", "look": f"{MARBLE} edged by a thin ring."},
        {"name": "Guide Rei’s Cloudy Marble", "look": f"{MARBLE} edged by a ring of light."},
        {"name": "Portal Machine", "look": "A tall brass frame that hums."},
    ])
    assert len(groups) == 1
    assert groups[0] == ["Contained Black Hole Marble", "Guide Rei’s Cloudy Marble"]


def test_entries_with_no_description_are_not_assumed_the_same():
    assert dt.duplicate_groups([{"name": "a knife"}, {"name": "a letter"}]) == []


def test_note_brief_mirrors_props_and_names_the_duplicates():
    r = dt.note_brief_result({"props": [{"name": "Cloudy Glass Marbles", "look": f"{MARBLE}."},
                                        {"name": "Contained Black Hole Marble",
                                         "look": f"{MARBLE}."}]})
    # props are in the mirror at all — they never used to be
    assert r["props"] == ["Cloudy Glass Marbles", "Contained Black Hole Marble"]
    assert "Cloudy Glass Marbles" in r["hint"]
    assert "separate sheet" in r["hint"]


def test_two_different_cast_names_are_not_reported_as_a_duplicate():
    """The old rule nagged on any second cast name, i.e. on nearly every turn,
    which is how a hint stops being read."""
    assert "hint" not in dt.note_brief_result({"cast": [{"name": "the diver"}, {"name": "Mara"}]})


def test_open_questions_are_a_working_set_not_a_log():
    """The real interview reached seventy, every one of them since answered,
    and brief_to_plan hands the list to the planner as "decide these yourself"."""
    b = dt.merge_brief({}, {"open_questions": [f"gap {i}" for i in range(70)]})
    assert len(b["open_questions"]) == dt.MAX_OPEN_QUESTIONS
    assert b["open_questions"][-1] == "gap 69"
    assert "gap 0" not in b["open_questions"]


def test_a_reworded_question_replaces_its_earlier_phrasing():
    b = dt.merge_brief({}, {"open_questions": ["Rei’s visual identity", "Rei visual identity"]})
    assert b["open_questions"] == ["Rei visual identity"]


def test_a_long_standing_list_is_trimmed_on_the_next_merge():
    stale = {"open_questions": [f"gap {i}" for i in range(40)]}
    assert len(dt.merge_brief(stale, {"open_questions": ["one more"]})["open_questions"]) == 12


# ------------------------------------------------------------------ the song --
# Twin of the `song` tests in director/brief.test.mjs. The interview is told to
# ask about the track on a music video, and `merge_brief` is a whitelist — so
# before this field existed the lyric sheet a director wrote down was dropped
# while the tool call reported success.

def test_a_song_written_down_in_the_interview_is_kept():
    b = dt.merge_brief({"logline": "x"}, {
        "song": {"lyrics": "[Verse]\nrain", "style": "dream pop", "bpm": 76,
                 "length_s": 218}})
    assert b["song"] == {"lyrics": "[Verse]\nrain", "style": "dream pop",
                         "bpm": 76, "length_s": 218}
    assert b["logline"] == "x"


def test_a_later_turn_refines_without_wiping_the_words():
    one = dt.merge_brief({}, {"song": {"lyrics": "[Verse]\nfirst", "style": "folk"}})
    two = dt.merge_brief(one, {"song": {"bpm": 90}})
    assert two["song"]["lyrics"] == "[Verse]\nfirst"
    assert two["song"]["style"] == "folk"
    assert two["song"]["bpm"] == 90


def test_a_rewritten_lyric_replaces_rather_than_accumulating():
    one = dt.merge_brief({}, {"song": {"lyrics": "old chorus"}})
    assert dt.merge_brief(one, {"song": {"lyrics": "new chorus"}})["song"]["lyrics"] \
        == "new chorus"


def test_instrumental_false_is_honoured_not_read_as_absent():
    b = dt.merge_brief({"song": {"instrumental": True}}, {"song": {"instrumental": False}})
    assert b["song"]["instrumental"] is False


def test_an_empty_song_patch_does_not_create_the_field():
    assert "song" not in dt.merge_brief({}, {"song": {}})


def test_a_junk_bpm_is_dropped_rather_than_stored():
    b = dt.merge_brief({}, {"song": {"lyrics": "x", "bpm": "fast"}})
    assert "bpm" not in b["song"]


# The tuning, pinned against the real brief it was measured on. Loosening the
# cast rule to catch the location pairs is the mistake this guards.
REI = "Reference authority: short black bob with one turquoise front streak, pale gray eyes, black"
CAPTURE = "A fractured capture environment where crystallization spreads through the space"


def test_a_stock_opener_across_the_cast_is_not_evidence_of_anything():
    """Models write one description template and fill in the wardrobe. On raw
    text these three score 1.0 against each other."""
    cast = [
        {"name": "Rei", "look": f"{REI} zip hoodie, dark T-shirt, cuffed dark shorts."},
        {"name": "Villian Rei", "look": f"{REI} high-collar layered coat with draped panels."},
        {"name": "Knight Rei", "look": f"{REI} armor, shield and long sword."},
    ]
    assert dt.duplicate_groups(cast, "cast") == []
    assert dt.duplicate_groups(cast, "world") == []


def test_the_boilerplate_filter_never_eats_the_signal():
    """Two of three ARE the same place. Their shared words appear in 2 of 3 —
    which is why "common" needs three entries, not half of them."""
    world = [
        {"name": "Astronaut Capture Site", "look": f"{CAPTURE} as the villain drains the power."},
        {"name": "Astronaut Capture Environment", "look": f"{CAPTURE} and the power is torn away."},
        {"name": "Plant World", "look": "Luminous old-growth forest, towering silver-barked trees."},
    ]
    assert dt.duplicate_groups(world, "world") == [
        ["Astronaut Capture Site", "Astronaut Capture Environment"]]


def test_the_cast_rule_trades_a_missed_duplicate_for_never_merging_two_people():
    """The same person under a descriptive and a proper name. Reported as a
    location, deliberately NOT as cast: at two entries the boilerplate filter
    cannot engage, so this rule is all that stands between a pair of similar
    characters and a hint telling the model they are one. A missed duplicate
    costs a reference sheet; a false one costs a character."""
    pair = [
        {"name": "The Diver", "look": "A tall diver in a patched wetsuit, shaved head, burn scar on the jaw."},
        {"name": "Diver Mara", "look": "A tall diver in a patched wetsuit, shaved head, rope burns on both hands."},
    ]
    assert dt.duplicate_groups(pair, "cast") == []
    assert len(dt.duplicate_groups(pair, "world")) == 1


def test_a_verbatim_duplicate_is_still_caught_in_the_cast():
    look = "A worn orange astronaut jumpsuit with mission patches and a black neck seal."
    assert len(dt.duplicate_groups([{"name": "Astronaut", "look": look},
                                    {"name": "Astro Rei", "look": look}], "cast")) == 1


# --------------------------------------- gaps the brief already answers ---
# resolved_questions was the only way an open question ever closed and the
# model sends it almost never, so the list only grew — and brief_to_plan hands
# it to the planner as "decide these yourself, consistently". Measured on a
# real interview: twelve open, EIGHT of them answered in the same document.

STATION = {
    "logline": "A salvage pilot wakes a mecha to save her sibling.",
    "turn": "the core holds her brother", "tone": "dark cinematic dread",
    "palette": "near-black space, sickly cyan, emergency crimson",
    "cast": [{"name": "Lucy", "look": "blonde with colourful highlights, signature jacket"},
             {"name": "Alien Threat", "look": "tall asymmetrical insectoid, obsidian armour"}],
    "world": [{"name": "Command Deck", "look": "scratched consoles, cyan glow"},
              {"name": "Salvage Bay", "look": "cathedral-scale bay, magnetic cradle arms"}],
    "props": [{"name": "Awakening Mecha", "look": "scarred salvage plating, cyan seams"}],
    "shape": {"length_s": 240,
              "sections": ["awakening", "pursuit", "escalation", "turn", "confrontation"]},
}


def test_a_question_the_brief_answers_retires_itself():
    b = dt.merge_brief(STATION, {"open_questions": [
        "primary location",           # world is filled
        "tone and palette",           # both are filled
        "protagonist name and look",  # a cast member has a look
        "mecha design",               # the named prop has a look
        "alien design",               # the named cast member has a look
        "ending",                     # NOT answered — no `ending` field
        "alien hierarchy: one entity or swarm",   # no look word, no field word
    ]})
    assert b["open_questions"] == ["ending", "alien hierarchy: one entity or swarm"]


def test_a_look_question_about_something_with_no_look_stays_open():
    b = dt.merge_brief({"world": [{"name": "the hideout"}], "tone": "elegiac"},
                       {"open_questions": ["hideout look"]})
    assert b["open_questions"] == ["hideout look"], "tone must not answer a hideout question"


def test_a_question_naming_nobody_on_the_roster_is_not_answered_by_it():
    b = dt.merge_brief({"cast": [{"name": "Mara", "look": "shaved head"}]},
                       {"open_questions": ["who owns the boat?"]})
    assert b["open_questions"] == ["who owns the boat?"]


def test_retirement_runs_on_a_patch_that_never_mentions_open_questions():
    # The old code did this inside the _BRIEF_LIST loop, which `continue`s when
    # the patch carries none — so a stored list survived every turn that did
    # not happen to mention it, which is how one reached seventy.
    stale = {**STATION, "open_questions": ["primary location", "tone and palette", "ending"]}
    assert dt.merge_brief(stale, {"title": "NIGHT SHIFT"})["open_questions"] == ["ending"]


def test_a_stored_list_is_capped_even_by_an_unrelated_patch():
    stale = {"open_questions": [f"gap {i}" for i in range(70)]}
    assert len(dt.merge_brief(stale, {"tone": "elegiac"})["open_questions"]) == 12


def test_resolved_questions_matches_a_paraphrase():
    # The schema asks for exact text and models send what they remember:
    # measured, "tone & palette" left "tone and palette" open for good.
    b = dt.merge_brief({"open_questions": ["tone and palette", "what season"]},
                       {"resolved_questions": ["tone & palette"]})
    assert b["open_questions"] == ["what season"]


def test_resolved_questions_does_not_retire_an_unrelated_gap():
    b = dt.merge_brief({"open_questions": ["what season"]},
                       {"resolved_questions": ["who owns the boat"]})
    assert b["open_questions"] == ["what season"]


def test_answered_questions_is_pure_and_quiet_on_an_empty_brief():
    assert dt.answered_questions({}) == []
    assert dt.answered_questions({"open_questions": ["primary location"]}) == []


# ------------------------------- several things written down as one ---
# Asked for a station with a docking ring, a command deck, a maintenance spine,
# an observation gallery and a salvage bay, the model wrote all five into ONE
# entry's `look` and reported them as added — truthfully, and uselessly: the
# planner draws one master plate, so five sets become one camera position.

def test_one_location_for_a_multi_section_piece_is_reported():
    nested = {**STATION, "world": [{"name": "Orbital Space Station",
                                    "look": "docking rings, a command deck and a salvage bay"}]}
    assert "ONE location for a 5-section piece" in dt.note_brief_result(nested)["hint"]


def test_the_report_goes_quiet_once_the_places_are_their_own_entries():
    assert "ONE location" not in (dt.note_brief_result(STATION).get("hint") or "")


def test_a_bottle_episode_says_so_in_constraints_instead_of_being_nagged():
    bottle = {**STATION, "world": [{"name": "The Late Shift counter", "look": "one room"}],
              "constraints": ["a single location, the whole piece"]}
    assert "ONE location" not in (dt.note_brief_result(bottle).get("hint") or "")


def test_a_short_piece_with_one_location_is_left_alone():
    short = {"world": [{"name": "Halvard Bay", "look": "flooded rooftops"}],
             "shape": {"length_s": 64}}
    assert "ONE location" not in (dt.note_brief_result(short).get("hint") or "")


# ------------------------------------ a patch that lost its entries ---
# _merge_named skips anything without a `name`, and note_brief answered
# {"noted": True} over a list that lost every entry.

def test_a_named_list_sent_as_bare_strings_is_reported():
    patch = {"world": ["Docking Ring", "Command Deck"]}
    assert dt.merge_brief({}, patch)["world"] == [], "the merge still refuses them"
    r = dt.note_brief_result(dt.merge_brief({}, patch), patch)
    assert len(r["dropped"]) == 1
    assert '2 "world" entries had no "name"' in r["dropped"][0]
    assert "Docking Ring" in r["dropped"][0]
    assert "resend them" in r["hint"]


def test_a_named_list_sent_as_one_object_is_reported():
    assert "must be an ARRAY" in dt.brief_patch_problems({"cast": {"name": "Lucy"}})[0]


def test_a_dropped_object_is_shown_the_way_the_js_twin_shows_it():
    # json.dumps spaces after its colons and JSON.stringify does not, so the
    # default would have the two runners describe one drop two ways.
    (msg,) = dt.brief_patch_problems({"world": [{"look": "no name"}]})
    assert '{"look":"no name"}' in msg


def test_the_entries_that_did_have_a_name_still_land():
    patch = {"world": [{"name": "Command Deck", "look": "cyan glow"}, "Salvage Bay"]}
    assert dt.merge_brief({}, patch)["world"] == [{"name": "Command Deck", "look": "cyan glow"}]
    assert '1 "world" entry had no "name" and was dropped' in dt.brief_patch_problems(patch)[0]


def test_a_well_formed_patch_reports_nothing():
    assert dt.brief_patch_problems({"cast": [{"name": "Lucy"}], "tone": "dread"}) == []
    assert dt.brief_patch_problems(None) == []

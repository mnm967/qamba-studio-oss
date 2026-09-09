"""A SEGMENT STORYBOARD: one block's shots as one numbered contact sheet.

The block twin of a per-beat panel, staged whole as a single `<Picture N>`.
Per-beat panels lose on a block two ways at once, both measured on Rei E3
MEMORY_CAPTURE b13 (four shots, minimax-h3-pdd, 2026-09-01):

  * COVERAGE — `budget_refs` allows TWO panels per block, so a four-shot block
    composed shots 1 and 2 and handed shots 3 and 4 nothing.
  * CONSISTENCY — separate renders drift. Those four came back as four
    different cities at three times of day, one in daylight with the wrong
    cast, and two of them rode into the render as "framing intended".

One sheet is one picture, one grade, every shot, for one slot instead of two:

    hue spread   95.6deg -> 4.4deg     (22x tighter)
    saturation   172.1   -> 9.9        (17x tighter)
    luma corr    +0.142  -> +0.086     (still four different shots — the row
                                        that makes the other two honest)

The grammar is adapted from amao2001's published minimax_h3_r2v_story_board
workflow. Everything below pins a sentence that workflow proves load-bearing,
or a way the sheet could silently stop being read as N chronological shots.
"""
import h3_prompt as H
import image_prompt as IP

CAST = [{"name": "Astronaut Rei", "identity_line": "a woman in an orange suit"},
        {"name": "Villian Rei", "identity_line": "a woman in a black coat"}]


def beat(action, camera="a medium shot at eye level", roster=None, i=0):
    return {"action": action, "camera": camera, "duration_ms": 3000,
            "start_ms": i * 3000, "dialogue": [],
            "meta": {"cast": roster or ["Astronaut Rei"]}}


BEATS = [beat("Astronaut Rei stands alone on the wet street.",
              "an extreme wide establishing shot at eye level", i=0),
         beat("Villian Rei steps through the tear.",
              "a low-angle medium-wide shot", ["Astronaut Rei", "Villian Rei"], i=1),
         beat("Astronaut Rei locks her arms wide.",
              "a clean locked medium-wide frontal shot", ["Astronaut Rei", "Villian Rei"], i=2),
         beat("The debris surges into Villian Rei.",
              "a wide side-on shot at waist height", ["Astronaut Rei", "Villian Rei"], i=3)]

SHEET = {"kind": "block_sheet", "slot": 1, "panels": 4,
         "shot_idxs": [1, 2, 3, 4], "role": "storyboard"}


def block(ref_slots, beats=None):
    beats = beats or BEATS
    return H.compile_block(
        render_ms=sum(b["duration_ms"] for b in beats), warmup_ms=0,
        aspect="16:9", style="Anime (2D)", medium="film", beats=beats,
        cast=CAST, environment={"name": "Rain Street"}, mode="r2v",
        ref_slots=ref_slots)


def sheet_block():
    return block([SHEET,
                  {"kind": "character", "name": "Astronaut Rei", "slot": 2},
                  {"kind": "character", "name": "Villian Rei", "slot": 3}])


# ── the definition ───────────────────────────────────────────────────────────

def test_the_sheet_is_declared_as_chronological_shots_not_one_image():
    """THE load-bearing sentence. Without it H3 reads a grid as a composition
    to reproduce and renders a video OF a storyboard — which is the one way
    this feature fails catastrophically rather than merely poorly."""
    defs = sheet_block()["subject_definitions"]
    assert "separate chronological shot beat" in defs
    assert "not as one composite image" in defs
    assert "never a grid" in defs


def test_the_definition_counts_the_panels_it_actually_has():
    defs = sheet_block()["subject_definitions"]
    assert "four-panel storyboard" in defs
    assert "numbered 1 to 4" in defs


def test_the_panel_count_comes_from_the_PICTURE_not_the_block():
    """A block re-planned to fewer shots keeps a sheet drawn for the old ones.
    The compiler describes the picture that is staged, not the plan."""
    out = block([{**SHEET, "panels": 6}])
    assert "six-panel storyboard" in out["subject_definitions"]
    assert "numbered 1 to 6" in out["subject_definitions"]


# ── the binding ──────────────────────────────────────────────────────────────

def test_every_shot_names_its_own_panel():
    """The definition says the sheet holds the shot order; only this says WHICH
    panel is which shot. Without it H3 picks whichever panel it likes to open
    on — the sheet becomes a mood board."""
    d = sheet_block()["description"]
    assert "opens exactly on panel 1 of <Picture 1>" in d
    for k in (2, 3, 4):
        assert f"cuts to panel {k} of <Picture 1>" in d


def test_the_shot_stamps_survive_the_panel_binding():
    """The panel reference REPLACES the cut sentence, so the timestamp has to
    come with it — a shot with no stamp is a shot H3 places wherever it likes."""
    d = sheet_block()["description"]
    assert "At 00:03.000, the shot cuts to panel 2" in d


def test_a_block_with_no_sheet_is_byte_identical():
    """Every storyboard planned before this compiles exactly as it did."""
    plain = block([{"kind": "character", "name": "Astronaut Rei", "slot": 1}])
    assert "panel 1 of" not in plain["description"]
    assert "the shot cuts." in plain["description"]
    assert "storyboard grid" not in plain["description"]


# ── retention ────────────────────────────────────────────────────────────────

def test_the_sheet_is_fully_preserved_where_a_panel_is_only_partially():
    """A panel offers ONE composition and may let its colour defer to the
    scene; a sheet's internal consistency IS the artifact it was made for, so
    telling H3 the rendering may drift would throw that away."""
    ret = sheet_block()["retention_analysis"]
    assert "<Picture 1> (the segment's storyboard): fully_preserved" in ret
    assert "four-stage shot order" in ret
    assert "the time of day do not change" in ret


def test_a_scene_ref_panel_keeps_its_partial_retention():
    ret = block([{"kind": "scene_ref", "slot": 1, "shot_idxs": [1],
                  "desc": "the opening wide"}])["retention_analysis"]
    assert "partially_preserved" in ret
    assert "fully_preserved - retain its" not in ret


# ── the negation ─────────────────────────────────────────────────────────────

def test_the_grid_furniture_is_disclaimed_terminally():
    """The sheet is a picture OF a grid — borders, gutters, printed numbers —
    and H3 obeys a picture over a sentence. Terminal, because that is where
    this repo records H3 obeying a negation."""
    d = sheet_block()["description"]
    assert "No storyboard grid" in d
    assert "no printed panel numbers" in d
    tail = d.rsplit("\n", 1)[-1]
    assert "storyboard grid" in tail, "the disclaimer must be the LAST line"


def test_the_negation_is_absent_without_a_sheet():
    assert "No storyboard grid" not in block(
        [{"kind": "character", "name": "Astronaut Rei", "slot": 1}])["description"]


# ── the prompt that draws it ─────────────────────────────────────────────────

def spec(n=4, **kw):
    return {"kind": "block_sheet", "rows": 2, "cols": 2, "style": "Anime (2D)",
            "cast": [{"name": "Astronaut Rei", "identity": "an orange suit"}],
            "location": {"name": "Rain Street", "identity": "a wet street"},
            "refs": ["Astronaut Rei's character sheet"],
            "panels": [{"camera": b["camera"], "action": b["action"],
                        "cast": ["Astronaut Rei"]} for b in BEATS[:n]], **kw}


def test_the_sheet_prompt_asks_for_numbers():
    """The numbers are not decoration: they are what `panel k` in the video
    prompt refers to. A sheet drawn without them cannot be bound shot by
    shot."""
    p = IP.compose(spec(), family="openai")
    assert "white panel number in a solid black square" in p
    assert "counting from 1" in p


def test_the_sheet_prompt_locks_the_location_across_panels():
    """The half that separates a storyboard from a mood board — and the exact
    failure the four separate panels had (four different cities)."""
    p = IP.compose(spec(), family="openai")
    assert "The same real place in every panel" in p
    assert "4 different camera positions" in p
    assert "the same time of day in all of them" in p


def test_each_panel_leads_with_its_shot_size():
    """A shot size buried in camera prose is not obeyed — measured on a
    42-panel storyboard that came back as 42 medium two-shots. It matters MORE
    here: the sheet is the only place shots 3..N get a composition at all."""
    p = IP.compose(spec(), family="openai")
    assert "[PANEL 1]: EXTREME WIDE" in p
    assert "[PANEL 3]: MEDIUM SHOT" in p


def test_unused_cells_are_filled_black():
    """A 3-shot block on a 2x2 layout has a spare cell, and a model left to
    invent one invents a fifth shot — which then has no `[Shot N]` to bind to."""
    p = IP.compose({**spec(3), "rows": 2, "cols": 2}, family="openai")
    assert "[PANEL 4]: solid matte black, empty." in p


def test_the_grey_backdrop_is_disclaimed_for_the_sheet_too():
    """Character sheets are shot on studio grey and the sheet is drawn FROM
    them — the same leak the block compiler already guards."""
    assert "sheet artifact" in IP.compose(spec(), family="openai")


# ── the slot budget ──────────────────────────────────────────────────────────

def test_the_sheet_never_loses_its_slot_to_identity():
    """`budget_refs` claims in sections and identity is assembled first, so the
    tail it truncates is exactly the composition references — measured on Rei
    E4, where 5 of 17 blocks would have rendered with no location plate and 6
    with no panel. A sheet dropped there is not one reference lost, it is the
    block's whole composition, and it is what the per-beat panels were traded
    away for. So it claims as `deliberate`, beside a user-designated frame."""
    from handlers.blocks import PICTURE_CAP, _ref_section, budget_refs
    plan = ([{"purpose": "block_sheet", "role": "storyboard", "panels": 6}]
            + [{"purpose": "character", "role": "full_body", "name": f"c{i}"}
               for i in range(9)]
            + [{"purpose": "environment", "role": "master"}]
            + [{"purpose": "look", "role": "prop"} for _ in range(3)])
    kept = budget_refs(plan)
    assert _ref_section(plan[0]) == "deliberate"
    assert len(kept) == PICTURE_CAP
    assert kept[0]["purpose"] == "block_sheet", "the sheet must hold <Picture 1>"
    assert any(e["purpose"] == "environment" for e in kept)


def test_sheet_compose_selects_only_real_beats_columns():
    """`still_asset_id` lives in `beats.meta`, not in a column; the first
    live launch asked PostgREST for it and every board 400'd (names only
    real beats columns). Read off the migration rather than hardcoded."""
    import glob, os, re
    src = open(os.path.join(os.path.dirname(__file__), "..", "handlers", "images.py")).read()
    m = re.search(r'f"beats\?id=in\.\(\{[^}]+\}\)&select=([a-z_,]+)"', src)
    assert m, "sheet_compose's beats select moved"
    cols = set(m.group(1).split(","))
    mig = ""
    for f in sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "..", "supabase", "migrations", "*.sql"))):
        mig += open(f).read()
    body = re.search(r"create table (?:if not exists )?(?:public\.)?beats\s*\((.*?)\);", mig, re.S | re.I)
    assert body, "no beats table in the migrations"
    real = {ln.strip().split()[0].strip('"') for ln in body.group(1).splitlines() if ln.strip() and not ln.strip().startswith(("constraint", "primary", "unique", "foreign", "check", "--"))}
    assert cols <= real, f"select names columns beats does not have: {cols - real}"

"""Grid geometry + grid prompt composition — pure, runs anywhere."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import gridsheet  # noqa: E402
import image_prompt  # noqa: E402


def test_layout_ladder():
    assert gridsheet.grid_layout(1) == (1, 1)
    assert gridsheet.grid_layout(2) == (1, 2)
    assert gridsheet.grid_layout(3) == (2, 2)
    assert gridsheet.grid_layout(4) == (2, 2)
    assert gridsheet.grid_layout(5) == (2, 3)
    assert gridsheet.grid_layout(6) == (2, 3)
    assert gridsheet.grid_layout(7) == (3, 3)
    assert gridsheet.grid_layout(9) == (3, 3)
    # over-cap clamps rather than inventing a fourth row
    assert gridsheet.grid_layout(14) == (3, 3)


def test_dims_snap_and_budget():
    for n in (1, 2, 4, 5, 6, 9):
        rows, cols = gridsheet.grid_layout(n)
        w, h, pw, ph = gridsheet.grid_dims(rows, cols, panel_ar=1280 / 704)
        assert w % 32 == 0 and h % 32 == 0
        assert pw % 32 == 0 and ph % 32 == 0
        assert w == pw * cols and h == ph * rows
        assert w * h <= gridsheet.PIXEL_BUDGET
        # cells keep roughly the video's aspect (snap makes it approximate)
        assert abs((pw / ph) - 1280 / 704) < 0.15


def test_slice_boxes_cover_grid_without_overlap():
    w, h, pw, ph = gridsheet.grid_dims(3, 3, panel_ar=1280 / 704)
    boxes = gridsheet.slice_boxes(w, h, 3, 3, 9)
    assert len(boxes) == 9
    for x, y, bw, bh in boxes:
        assert 0 <= x and 0 <= y
        assert x + bw <= w and y + bh <= h
        # inset shaves the gutters: strictly inside its ideal cell
        assert bw < w / 3 and bh < h / 3
    # panel 5 (row 1, col 1) sits in the middle cell
    x, y, bw, bh = boxes[4]
    assert w / 3 < x + bw / 2 < 2 * w / 3
    assert h / 3 < y + bh / 2 < 2 * h / 3


def test_slice_boxes_use_actual_render_size():
    # families snap requested dims — boxes must come from the real image
    boxes_req = gridsheet.slice_boxes(1920, 1056, 3, 3, 9)
    boxes_act = gridsheet.slice_boxes(1888, 1024, 3, 3, 9)
    assert boxes_req != boxes_act


def test_slice_fewer_panels_than_cells():
    boxes = gridsheet.slice_boxes(1200, 800, 2, 3, 5)
    assert len(boxes) == 5


def test_grid_prompt_structure():
    spec = {
        "kind": "scene_grid", "style": "photoreal cinematic", "rows": 2, "cols": 3,
        "time_of_day": "night",
        "world": {"palette": "sodium orange against wet slate", "era": "near-future"},
        "cast": [{"name": "Aki Minase", "identity": "22, storm-grey bob, silver slicker"},
                 {"name": "Ren", "identity": "the boy who appears before disasters"}],
        "location": {"name": "Flooded Observatory",
                     "identity": "brass telescopes rising from black water"},
        "refs": ["Aki Minase's face sheet", "Ren's face sheet",
                 "the Flooded Observatory location, its master plate"],
        "panels": [
            {"size": "a wide shot", "action": "Aki wades between the telescopes", "cast": ["Aki Minase"]},
            {"size": "medium close-up", "action": "Ren surfaces beside the mount", "cast": ["Ren"]},
            {"size": "a two-shot", "action": "they read the star chart together",
             "cast": ["Aki Minase", "Ren"]},
            {"size": "close-up", "action": "the chart's ink runs", "cast": []},
            {"size": "a wide shot", "action": "the water level drops suddenly", "cast": []},
        ],
    }
    p = image_prompt.compose(spec)
    assert p.startswith("[STYLE]:")
    assert "[GRID]: 2x3 storyboard, 5 panels" in p
    assert "[LOCKED CHARACTER — AKI MINASE]" in p
    assert "[LOCKED CHARACTER — REN]" in p
    assert "[LOCKED LOCATION — FLOODED OBSERVATORY]" in p
    assert "[REFERENCES]:" in p and "reference 1 is Aki Minase's face sheet" in p
    # the grey-sheet disclaimer travels with the references
    assert "grey studio backdrop" in p
    for k in range(1, 6):
        assert f"[PANEL {k}]:" in p
    # the empty sixth cell is named, so the model doesn't invent a shot there
    assert "[PANEL 6]: solid matte black, empty." in p
    assert "left-to-right top-to-bottom" in p
    assert "no lettering" in p


def test_grid_prompt_family_invariant():
    spec = {"kind": "scene_grid", "rows": 1, "cols": 2,
            "panels": [{"size": "wide", "action": "a", "cast": []},
                       {"size": "close", "action": "b", "cast": []}]}
    # not an SDXL tag stack: no family reshaping, no 70-word cap
    assert image_prompt.compose(spec, "krea2") == image_prompt.compose(spec, "h3")


def test_turnaround_framing_survives_word_cap():
    spec = {"kind": "character", "role": "turnaround", "name": "Aki Minase",
            "identity": "22, storm-grey bob, silver slicker", "style": "photoreal"}
    p = image_prompt.compose(spec, "krea2")
    # all six views survive — the 70-word cap would amputate view 4 onward
    assert "view 6" in p
    assert "2x3 grid" in p
    # identity-anchor conventions hold: grey ground, studio key
    assert "mid-grey backdrop" in p


def test_style_clause_survives_a_long_identity_line():
    """The style clause is appended last and the cap used to truncate the
    joined string — so the characters with the richest identity lines lost
    "anime" entirely and rendered photoreal, in an anime project. Measured on
    AFTERLIGHT: a 70-word Aki prompt dropped it, short-lined Haru kept it."""
    long_id = ("Aki Minase, a 22-year-old woman with shoulder-length ink-black "
               "hair with a single white streak at her left temple, dark grey "
               "eyes, a faded denim jacket covered in enamel pins over a "
               "mustard-yellow scarf, black fingerless gloves, and a "
               "kraft-paper sketchbook on a shoulder strap")
    for role in ("face", "full_body", "turnaround"):
        p = image_prompt.compose(
            {"kind": "character", "role": role, "name": "Aki", "identity": long_id,
             "style": "2D-animated anime",
             "world": {"era": "near-future Japan", "palette": "rain-grey blue"}},
            "krea2")
        assert "anime" in p.lower(), f"style truncated on role={role}: …{p[-70:]}"
    # environments and props keep it too — a photoreal set behind anime cast
    # is the same bug wearing a different hat
    for kind, role in (("environment", "master"), ("prop", "ref"), ("scene", "still")):
        p = image_prompt.compose(
            {"kind": kind, "role": role, "name": "X", "identity": long_id,
             "style": "2D-animated anime"}, "krea2")
        assert "anime" in p.lower(), f"style truncated on {kind}/{role}"


def test_body_is_still_capped_even_though_style_is_not():
    long_id = " ".join(["extremely"] * 200)
    p = image_prompt.compose({"kind": "character", "role": "full_body",
                              "name": "X", "identity": long_id,
                              "style": "anime"}, "krea2")
    assert "anime" in p.lower()
    assert len(p.split()) < 120, "body should still be capped"


def _fake_grid(width, height, rows, cols, gutter=6):
    """Greyscale pixels for a grid with black gutters drawn at each interior
    boundary and noisy 'picture' inside the cells."""
    px = [0] * (width * height)
    for y in range(height):
        for x in range(width):
            px[y * width + x] = 40 + ((x * 7 + y * 13) % 160)
    for i in range(1, rows):
        c = int(height * i / rows)
        for y in range(max(0, c - gutter), min(height, c + gutter)):
            for x in range(width):
                px[y * width + x] = 0
    for i in range(1, cols):
        c = int(width * i / cols)
        for x in range(max(0, c - gutter), min(width, c + gutter)):
            for y in range(height):
                px[y * width + x] = 0
    return px


def test_verify_grid_accepts_a_properly_drawn_grid():
    for rows, cols in ((2, 2), (2, 3), (3, 3), (1, 2)):
        px = _fake_grid(600, 400, rows, cols)
        ok, why = gridsheet.verify_grid(px, 600, 400, rows, cols)
        assert ok, f"{rows}x{cols} rejected: {why}"


def test_verify_grid_rejects_a_missing_row_of_seams():
    """The live failure: a requested 2x3 came back as ONE row of three
    portraits, so slicing produced 'panels' that were the bottom halves of
    other panels — and staged them into the render as storyboard references.
    Measured on the real image, the absent row seam scored 1.32 against 0.00
    for the two column seams that were genuinely drawn."""
    px = _fake_grid(600, 400, 1, 3)          # model drew 1x3 …
    ok, why = gridsheet.verify_grid(px, 600, 400, 2, 3)   # … we asked for 2x3
    assert not ok
    assert "row boundary [1]" in why
    # the columns it DID draw are recognised, so the message names the real fault
    assert "column boundary" not in why


def test_verify_grid_rejects_a_grid_drawn_as_one_picture():
    px = _fake_grid(600, 400, 1, 1)          # no seams at all
    ok, why = gridsheet.verify_grid(px, 600, 400, 2, 2)
    assert not ok
    assert "row boundary" in why and "column boundary" in why


# ------------------------------------------------------- per-beat panels ----
def _panel_spec(**over):
    spec = {
        "kind": "panel", "style": "2D-animated anime",
        "size": "a wide shot", "action": "Aki wades between the telescopes",
        "time_of_day": "night",
        "world": {"palette": "rain-grey blue and sodium amber", "era": "near-future"},
        "cast": [{"name": "Aki Minase", "identity": "22, ink-black hair, white streak"}],
        "location": {"name": "Hoshimi Observatory", "identity": "a flooded dome"},
        "refs": ["Aki Minase's face sheet", "the Hoshimi Observatory master plate"],
    }
    spec.update(over)
    return spec


def test_panel_prompt_is_one_frame_not_a_layout():
    """The grid asked for a layout and got reproduced references instead. A
    panel asks for ONE frame, so there is no layout to be ignored — and it
    says so explicitly, because the model that renders it is the same one
    that liked drawing triptychs."""
    p = image_prompt.compose(_panel_spec())
    assert p.startswith("[STYLE]:")
    assert "[SHOT]:" in p
    assert "[GRID]" not in p and "[PANEL" not in p
    for banned in ("split screen", "no panels", "no borders"):
        assert banned in p
    assert "[LOCKED CHARACTER — AKI MINASE]" in p
    assert "[LOCKED LOCATION — HOSHIMI OBSERVATORY]" in p
    # identity from the refs, framing from the shot — the thing the grid lost
    assert "never their framing" in p
    assert "grey studio backdrop" in p


def test_panels_of_one_scene_share_their_grade_clause():
    """A grid held the grade by rendering panels together. Separate renders
    hold it by repetition: same style, palette, era and time of day, in the
    same order, on every panel of the scene.

    The STYLE block is what must match — [FRAMING] deliberately differs per
    shot, which is the whole point of stating it."""
    a = image_prompt.compose(_panel_spec(action="Aki wades in", size="a wide shot"))
    b = image_prompt.compose(_panel_spec(action="Ren surfaces", size="close-up"))
    style_a = a.split("[FRAMING]:")[0]
    style_b = b.split("[FRAMING]:")[0]
    assert style_a == style_b, "style block must be identical across a scene's panels"
    assert "rain-grey blue" in style_a and "night" in style_a
    # and the framing must NOT be identical — that was the bug
    assert a.split("[SHOT]:")[0] != b.split("[SHOT]:")[0]


def test_panel_prompt_is_not_word_capped_or_family_reshaped():
    spec = _panel_spec()
    assert image_prompt.compose(spec, "krea2") == image_prompt.compose(spec, "qwen")
    assert len(image_prompt.compose(spec).split()) > image_prompt.WORD_CAP


def test_panel_caps_locked_characters_at_three():
    spec = _panel_spec(cast=[{"name": f"P{i}", "identity": f"person {i}"}
                             for i in range(6)])
    p = image_prompt.compose(spec)
    assert p.count("[LOCKED CHARACTER") == 3


# ------------------------------------------------------ framing directives ---
def test_shot_framing_extracts_size_and_angle_and_drops_motion():
    """The planner writes size + angle + the official motion grammar in one
    line. Motion means nothing in a still and dilutes what doesn't, so only
    size and angle survive — each expanded into what it means for the frame,
    because 'a wide shot' as prose was measurably ignored."""
    cam = ("a wide establishing shot at high angle from the south maintenance "
           "stairwell; the camera Tilts Down with small amplitude at slow speed")
    frame, angle = image_prompt.shot_framing(cam)
    assert "WIDE ESTABLISHING" in frame and "third of the frame height" in frame
    assert "above the subject" in angle
    for motion in ("Tilts", "amplitude", "slow speed"):
        assert motion.lower() not in (frame + angle).lower()


def test_shot_framing_prefers_the_longer_key():
    assert "MEDIUM CLOSE-UP" in image_prompt.shot_framing("a medium close-up on Haru")[0]
    assert "MEDIUM SHOT" in image_prompt.shot_framing("a medium shot")[0]
    assert "EXTREME WIDE" in image_prompt.shot_framing("an extreme wide of the dome")[0]
    assert "WIDE:" in image_prompt.shot_framing("a wide of the dome")[0]
    assert "EXTREME CLOSE-UP" in image_prompt.shot_framing("extreme close-up on the page")[0]
    # nothing recognisable -> no invented framing
    assert image_prompt.shot_framing("the camera holds") == ("", "")
    assert image_prompt.shot_framing(None) == ("", "")


def test_panel_prompt_leads_with_framing_before_action():
    p = image_prompt.compose(_panel_spec(
        camera="a low-angle shot along the platform; a Tracking Shot follows Aki",
        size=None))
    assert "[FRAMING]:" in p
    assert p.index("[FRAMING]:") < p.index("[SHOT]:")
    assert "below the subject" in p


def test_panel_prompt_forbids_rendered_text():
    """A panel came back with a character's NAME typeset onto a sketchbook
    page and invented pseudo-Japanese on the signage."""
    p = image_prompt.compose(_panel_spec())
    for banned in ("lettering", "captions", "signage text", "handwriting",
                   "character\nnames" if False else "character names"):
        assert banned in p

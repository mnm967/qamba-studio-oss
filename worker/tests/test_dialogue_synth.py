"""dialogue_synth: the pure halves — tag mapping, casting, planning/fallback
logic. Network and DB stay untouched (sb is stubbed before import)."""
import re
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
# Stub sb/status only long enough to import the module under test, then put
# the real modules back — a lingering stub poisons every later-collected test
# that imports them for real.
_saved = {k: sys.modules.get(k) for k in ("sb", "status")}
sys.modules["sb"] = types.SimpleNamespace(get=lambda *a, **k: [],
                                          asset_by_id=lambda *a: None)
sys.modules["status"] = types.SimpleNamespace(log=lambda *a, **k: None)
import dialogue_synth as DS  # noqa: E402
for _k, _v in _saved.items():
    if _v is None:
        sys.modules.pop(_k, None)
    else:
        sys.modules[_k] = _v


def _cast():
    return [
        {"id": "m1", "name": "Mara Voss",
         "doc": {"el_voice_id": "EXAVITQu4vr4xnSDxMaL"}},
        {"id": "m2", "name": "Mara Voss — Sable extraction kit",
         "doc": {"variant_of": "m1"}},
        {"id": "o1", "name": 'Odile "the Broker"',
         "doc": {"el_voice_id": "pFZP5JQG7iQjIQuC4Bku"}},
    ]


def _beats(dialogue):
    return [{"dialogue": dialogue}]


def test_tag_map_is_deterministic_and_optional():
    assert DS.tag_for("satisfied, unhurried") == "[pleased]"
    assert DS.tag_for("a low whisper") == "[whispers]"
    assert DS.tag_for("decisive") == "[firm]"
    assert DS.tag_for("controlled") == ""          # the voice carries it
    assert DS.tag_for(None) == ""


def test_plan_lines_resolves_variants_to_parent_voice():
    items = DS.plan_lines(_beats([
        {"speaker": "Mara Voss — Sable extraction kit", "line": "Terms.",
         "delivery": "controlled"},
        {"speaker": 'Odile "the Broker"', "line": "You take the tower.",
         "delivery": "satisfied"},
    ]), _cast())
    assert [i["voice_id"] for i in items] == ["EXAVITQu4vr4xnSDxMaL",
                                              "pFZP5JQG7iQjIQuC4Bku"]
    assert items[0]["shot_idx"] == 1 and items[0]["order"] == 1
    assert items[1]["speech_text"].startswith("[pleased] ")


def test_plan_lines_falls_back_loudly_when_uncast_or_crowded():
    # an uncast speaker -> None (timbre refs render instead)
    cast = _cast()
    cast[2]["doc"] = {}
    assert DS.plan_lines(_beats([
        {"speaker": 'Odile "the Broker"', "line": "hi", "delivery": ""}]),
        cast) is None
    # 4 speakers used to exceed the 3 timbre slots — an exchange clip is ONE
    # slot, so the only ceiling left is text-to-dialogue's 10 voices.
    many = [{"id": f"c{i}", "name": f"P{i}",
             "doc": {"el_voice_id": f"v{i}"}} for i in range(11)]
    dlg4 = [{"speaker": f"P{i}", "line": f"line {i}", "delivery": ""}
            for i in range(4)]
    assert len(DS.plan_lines(_beats(dlg4), many)) == 4
    dlg11 = [{"speaker": f"P{i}", "line": f"line {i}", "delivery": ""}
             for i in range(11)]
    assert DS.plan_lines(_beats(dlg11), many) is None
    # no dialogue -> None
    assert DS.plan_lines([{"dialogue": []}], _cast()) is None


def test_cast_voice_avoids_reuse():
    a = DS.cast_voice("a low, gravelly voice, slow deliberate pace", set())
    b = DS.cast_voice("a low, gravelly voice, slow deliberate pace", {a})
    assert a != b
    assert DS.cast_voice("clipped, precise, professional woman", set()) \
        == "EXAVITQu4vr4xnSDxMaL"


def test_cast_voice_respects_gender():
    # Mrs. Katagiri's bug: "warm low mezzo-soprano" matched George (m) via
    # "warm" because no axis said she was a woman. The register term IS the
    # axis — mezzo-soprano filters to the female pool even with the obvious
    # female voices taken.
    fem = {r[0] for r in DS.VOICE_TABLE if r[2] == "f"}
    got = DS.cast_voice("A warm low mezzo-soprano with a textured timbre, "
                        "slow pace", {"EXAVITQu4vr4xnSDxMaL"})
    assert got in fem
    # the identity-line hint carries gender when the voice prose doesn't
    got2 = DS.cast_voice("a warm unhurried voice", set(),
                         hint="a 60-year-old woman with a silver bun")
    assert got2 in fem
    # masculine register keeps the male pool
    masc = {r[0] for r in DS.VOICE_TABLE if r[2] == "m"}
    assert DS.cast_voice("a soft, breathy baritone", set()) in masc


def test_the_ui_voice_list_mirrors_the_casting_table():
    """`src/lib/elVoices.ts` says "keep the two in step" and nothing checked it.

    The worker CASTS from VOICE_TABLE; the bible modal NAMES a cast voice and
    offers a recast from EL_VOICES. Drift is silent in the worst direction: a
    voice the worker can cast but the UI can't name renders as "not cast yet"
    on a character who has a voice, and a voice the UI offers but the worker
    doesn't know is fine until something asks the table about it. Same shape as
    realtimeTables.test.ts — the file pair IS the invariant.
    """
    ts = Path(__file__).parent.parent.parent / "src" / "lib" / "elVoices.ts"
    ui = re.findall(r'\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*gender:\s*"([fm])"',
                    ts.read_text())
    worker = [(r[0], r[1], r[2]) for r in DS.VOICE_TABLE]
    assert ui, "no voices parsed out of elVoices.ts — did its shape change?"
    assert worker == ui, (
        f"voice tables disagree\n  worker-only: {set(v[0] for v in worker) - set(v[0] for v in ui)}"
        f"\n  ui-only:     {set(v[0] for v in ui) - set(v[0] for v in worker)}"
        f"\n  (order matters too: casting falls back to table order)")


def test_a_soft_young_man_does_not_cast_as_the_heavy_middle_aged_voice():
    """Haru's bug, and the male half of the Katagiri one.

    Gender filtering was in place and still put "a soft, breathy baritone …
    restrained volume" (23 years old) on Brian — deep, resonant, middle-aged —
    because every male row in the table WAS middle-aged and heavy, so the
    filter had nothing else to hand back. A register the writer can ask for
    has to exist in the pool; this pins that the soft/young one does, and that
    it beats the heavy one on a descriptor written for it.
    """
    got = DS.cast_voice("A soft, breathy baritone with a muted Kansai lilt, "
                        "slow pauses, and restrained volume", set(),
                        hint="a 23-year-old young man, quiet and careful")
    assert got == "bIHbv24MWmeRgasZH58o", f"cast {got}, expected Will"
    # and the heavy voice still wins the descriptor written for IT
    assert DS.cast_voice("a deep, gravelly bass, heavy and resonant", set()) \
        == "nPczCjzI2devNBz1zQrb"


def test_line_key_is_content_addressed():
    k1 = DS.line_key("v1", "[firm] Send the route.")
    assert k1 == DS.line_key("v1", "[firm] Send the route.")
    assert k1 != DS.line_key("v2", "[firm] Send the route.")
    assert len(k1) == 16


def test_measured_timing_math_is_pure():
    # 2 lines of 1120ms and 5440ms: lead 700 + 1120 + gap 500 + 5440
    #                             + tail 900 + late-start allowance 2800
    assert DS.shot_floor_from_measured([1120, 5440]) == 11460
    assert DS.shot_floor_from_measured([]) == 0
    assert DS.line_offsets_ms([1120, 5440]) == [700, 2320]


def test_the_late_start_allowance_is_the_only_thing_that_moved():
    # It sits on top of the landing beat rather than inside it, so a caller
    # placing audio EXACTLY (a spine slice — nothing is re-performed, so
    # nothing can start late) opts out and gets the pre-2026-09-07 floor.
    assert DS.shot_floor_from_measured([1120, 5440], late_ms=0) == 8660
    # ...and the offsets do NOT move: the allowance is room AFTER the line,
    # never an instruction to start it earlier. A line told to begin sooner
    # would only be re-placed by a model that already ignores the offset.
    assert DS.line_offsets_ms([1120, 5440]) == [700, 2320]


def test_the_measured_floor_covers_both_shots_that_were_cut():
    # NIGHT SHIFT b8, the ARITHMETIC failure: a 7.71s line planned into a
    # 7.00s shot, because the plan never reached a TTS engine and kept the
    # 2.0-words/sec guess.
    assert DS.shot_floor_from_measured([7706]) > 7000
    # ...and b9, the PLACEMENT failure: a 3.40s line in a 6.75s shot that was
    # already well above its old floor, cut anyway because H3 opened the line
    # 2.79s late. Only the allowance reaches this one — the shot has to hold
    # the lateness, since a seed re-roll was measured not to move it.
    assert DS.shot_floor_from_measured([3395]) > 6750


def test_pin_run_durations_cuts_shots_in_recorded_pauses():
    # Three shots over one clip: lines at [300-1500], [2100-4000 + 4600-5200],
    # [6000-7800] (clip ms). Boundaries land mid-pause: (1500+2100)/2 = 1800,
    # (5200+6000)/2 = 5600. Shot 1 opens lead(700) before word 1.
    spans = [[(300, 1500)], [(2100, 4000), (4600, 5200)], [(6000, 7800)]]
    durs = DS.pin_run_durations(spans)
    # shot1: -400 .. 1800 = 2200; shot2: 1800 .. 5600 = 3800;
    # shot3: 5600 .. 7800+900 = 3100
    assert durs == [2200, 3800, 3100]
    assert DS.pin_run_durations([]) == []
    assert DS.pin_run_durations([[]]) == []


def test_place_exchange_solves_or_refuses():
    # Shots (block time): 1 -> 0..2200, 2 -> 2200..6000. Clip lines at
    # 300-1500 (shot 1) and 2600-4400 (shot 2).
    lines = [{"t0_ms": 300, "t1_ms": 1500, "shot_idx": 1},
             {"t0_ms": 2600, "t1_ms": 4400, "shot_idx": 2}]
    windows = {1: (0, 2200), 2: (2200, 6000)}
    p = DS.place_exchange(lines, windows)
    assert p is not None
    # every line inside its shot with the placement applied
    for l in lines:
        s0, s1 = windows[l["shot_idx"]]
        assert s0 <= p + l["t0_ms"] and p + l["t1_ms"] <= s1
    # infeasible: the recorded pause is too short for the planned gap
    tight = [{"t0_ms": 300, "t1_ms": 1500, "shot_idx": 1},
             {"t0_ms": 1700, "t1_ms": 3200, "shot_idx": 2}]
    far = {1: (0, 5000), 2: (9000, 12000)}
    assert DS.place_exchange(tight, far) is None
    # a line for a shot with no window -> refuse, never guess
    assert DS.place_exchange([{"t0_ms": 0, "t1_ms": 500, "shot_idx": 9}],
                             windows) is None


def test_place_exchange_refuses_a_clip_longer_than_the_block():
    """E2 staged three clips that overhung their block (b12 +441ms, b15
    +290ms, b18 +441ms) and every one lost its tail. The per-line windows
    cannot see it — only the whole clip against the whole block can."""
    lines = [{"t0_ms": 300, "t1_ms": 1500, "shot_idx": 1}]
    windows = {1: (0, 5000)}
    # fits: 4800ms of audio inside a 5000ms block
    assert DS.place_exchange(lines, windows, clip_ms=4800, block_ms=5000) is not None
    # overhangs: 5300ms of audio can never fit 5000ms, whatever the window says
    assert DS.place_exchange(lines, windows, clip_ms=5300, block_ms=5000) is None
    # and the tail after the last line still counts as audio: a 4800ms clip
    # whose last line ends at 1500 must still start early enough to END inside
    assert DS.place_exchange(lines, windows, clip_ms=4800, block_ms=5000) <= 200


def test_place_exchange_centres_rather_than_hugging_an_edge():
    """Prefer-late fixed head-loss into the warmup trim and created tails
    landing 0.08-0.15s before the cut (measured, E2). The midpoint spends the
    slack on both ends so drift either way has somewhere to go."""
    lines = [{"t0_ms": 1000, "t1_ms": 2000, "shot_idx": 1}]
    windows = {1: (0, 10000)}
    p = DS.place_exchange(lines, windows)
    # feasible window here is lo=0 .. hi=10000-60-2000=7940; midpoint ~3970
    assert p is not None
    assert 3000 < p < 5000, f"expected a centred placement, got {p}"
    # strictly inside both extremes — that is the whole point
    assert p > 0 and p < 7940


def test_exchange_key_is_content_addressed():
    items = [{"voice_id": "v1", "speech_text": "[firm] Go."},
             {"voice_id": "v2", "speech_text": "No."}]
    k = DS.exchange_key(items)
    assert k == DS.exchange_key([dict(i) for i in items])
    assert k != DS.exchange_key(list(reversed(items)))
    assert len(k) == 16

import os
import re

import pytest

import h3_prompt as hp

from h3_prompt import (
    FMT_VERSION, CompileError, compile_block, flf_alignment_line, full_prompt_text,
    with_triggers,
)

GOLDEN = os.path.join(os.path.dirname(__file__), "golden", "mv_block.txt")

KIRA = {
    "name": "Kira",
    "identity_line": ("a 24-year-old woman with chin-length silver hair with a blue "
                      "streak, sharp amber eyes, a small scar over her left eyebrow, "
                      "a black choker and a cropped neon-blue bomber jacket over a "
                      "white tank top"),
}
JUNO = {"name": "Juno", "identity_line": "a tall man with short black hair and a grey coat"}
ROOFTOP = {
    "name": "rain-slick rooftop",
    "identity_line": "a rain-slick rooftop with holographic billboards",
    "palette": "deep blue, magenta and amber neon-noir",
}
REF_SLOTS = [
    {"slot": 1, "kind": "chain"},
    {"slot": 2, "kind": "character", "name": "Kira", "role": "face"},
    {"slot": 3, "kind": "character", "name": "Kira", "role": "full_body"},
    {"slot": 4, "kind": "environment"},
    {"slot": 5, "kind": "scene_ref", "name": "billboard glitch burst",
     "desc": "the cyan glitch burst that fractures the billboard light",
     "shot_idxs": [2]},
]
BEATS = [
    {"start_ms": 0, "duration_ms": 3500,
     "action": "Kira stands at the rooftop edge, singing directly to camera",
     "camera": "the camera pushes in with small amplitude at slow speed from medium shot to medium close-up",
     "dialogue": [{"speaker": "Kira", "line": "I burned the map that led me home"}],
     "sfx": "steady rain patter and distant city hum", "cast_names": ["Kira"]},
    {"start_ms": 3500, "duration_ms": 4000,
     "action": "Kira walks along the rooftop edge, holographic billboards flaring behind her",
     "camera": "a low-angle wide shot; the camera trucks right at fast speed",
     "dialogue": [{"speaker": "Kira", "line": "followed sparks into the smoke"}],
     "sfx": "a faint electric buzz from the billboards", "cast_names": ["Kira"]},
    {"start_ms": 7500, "duration_ms": 2000,
     "action": "an extreme close-up of her amber eyes, rain droplets on her lashes",
     "camera": "the camera holds a static shot", "dialogue": [], "sfx": None,
     "cast_names": []},
    {"start_ms": 9500, "duration_ms": 5500,
     "action": "Kira faces the skyline and raises her right hand toward a distant tower",
     "camera": "a medium shot from behind; the camera pedestals up with small amplitude at slow speed",
     "dialogue": [{"speaker": "Kira", "line": "and I glow — I glow"}],
     "sfx": None, "cast_names": ["Kira"]},
]
LYRICS = [
    {"t0_ms": 500, "t1_ms": 3400, "text": "I burned the map that led me home"},
    {"t0_ms": 4000, "t1_ms": 7400, "text": "followed sparks into the smoke"},
    {"t0_ms": 10000, "t1_ms": 14500, "text": "and I glow — I glow"},
]


def compile_fixture(**over):
    kw = dict(
        render_ms=15792, warmup_ms=500,
        aspect="16:9", style="anime", medium="music_video",
        beats=BEATS, cast=[KIRA, JUNO], environment=ROOFTOP, ref_slots=REF_SLOTS,
        audio_mode="locked", lyrics=LYRICS,
        next_opening="Kira from behind with her right hand raised toward the tower",
    )
    kw.update(over)
    return compile_block(**kw)


def test_golden_file():
    got = full_prompt_text(compile_fixture())
    if not os.path.exists(GOLDEN):
        os.makedirs(os.path.dirname(GOLDEN), exist_ok=True)
        with open(GOLDEN, "w") as f:
            f.write(got)
        pytest.skip("golden file created — rerun to compare")
    with open(GOLDEN) as f:
        want = f.read()
    assert got == want, "compiled prompt changed — bump FMT_VERSION and refresh golden"


def test_six_section_envelope():
    txt = full_prompt_text(compile_fixture())
    order = ["subject_definitions:", "summary:", "retention_analysis:",
             "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]
    idxs = [txt.index(s) for s in order]
    assert idxs == sorted(idxs) and idxs[0] == 0


def test_subject_definitions_and_beat_level_cast():
    c = compile_fixture()
    defs = c["subject_definitions"]
    # Juno is in the block cast but appears in no beat — not declared at all.
    assert "Juno" not in defs and "Juno" not in c["description"]
    assert "<Picture 1> is the first frame of [Shot 1]" in defs
    assert "<Subject 1> is Kira, shown in <Picture 2> and <Picture 3>" in defs
    assert "environment, shown in <Picture 4>" in defs
    assert "<Picture 5> is a storyboard reference for [Shot 2]" in defs
    assert "<Audio 1> is the supplied master music track" in defs


def test_summary_task_types_and_retention():
    c = compile_fixture()
    assert c["summary"].startswith(
        "[keyframe completion + reference generation + audio reuse]")
    ret = c["retention_analysis"]
    assert "<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 4]): fully_preserved" in ret
    assert "<Audio 1>: fully_copy" in ret
    assert "partially_preserved - its composition, staging" in ret


def test_shots_official_timestamps_and_lip_sync_on():
    d = compile_fixture()["description"]
    assert d.splitlines()[0].startswith("The target video is in a 2D-animated anime music video style")
    first = d.split("[Shot 2]")[0].split("[Shot 1]")[1]
    assert " At " not in first
    assert "[Shot 2] At 00:04.000," in d
    assert "[Shot 3] At 00:08.000," in d
    assert "[Shot 4] At 00:10.000," in d
    assert "<Subject 1> (Kira — a 24-year-old woman" in d  # identity at first appearance
    assert "(S1) sings, precisely lip-synced to <Audio 1>: <d>[English] I burned the map" in d
    shot3 = d.split("[Shot 3]")[1].split("[Shot 4]")[0]
    assert "every mouth stays closed" in shot3
    assert "the next segment opens on this composition" in d


def test_lip_sync_off_uses_reaches_phrase():
    c = compile_fixture(lip_sync=False)
    d = c["description"]
    assert "sings, precisely lip-synced" not in d
    assert "(S1)" not in d
    assert "When <Audio 1> reaches the phrase <d>[English] I burned the map" in d
    assert d.count("every mouth stays closed") >= 3


def test_locked_audio_sections():
    c = compile_fixture()
    assert c["soundscape"].startswith("<Audio 1> provides the complete final audio")
    assert c["music"] == "<Audio 1> is directly reused as the complete audience-only music."


def test_timestamps_strictly_increase():
    d = compile_fixture()["description"]
    times = re.findall(r"At (\d\d:\d\d\.\d\d\d)", d)
    assert times == sorted(times) and len(set(times)) == len(times)


def test_native_mode_dialogue_and_no_audio_labels():
    c = compile_block(
        render_ms=8000, warmup_ms=500, aspect="16:9", style="anime", medium="film",
        beats=[{"start_ms": 0, "duration_ms": 7500,
                "action": "Kira reads a letter at a dim desk",
                "camera": "the camera pushes in with small amplitude at slow speed",
                "dialogue": [{"speaker": "Kira", "line": "It's over.", "delivery": "quietly"}],
                "sfx": "a clock ticking", "cast_names": ["Kira"]}],
        cast=[KIRA], environment=None,
        ref_slots=[{"slot": 1, "kind": "character", "name": "Kira", "role": "face"}],
        audio_mode="native")
    assert "<Audio 1>" not in full_prompt_text(c)
    # The one beat is also the FINAL beat, so the line is pinned to the front
    # of its shot — a late line in the last shot runs into the trim.
    assert ("(S1) says quietly, speaking immediately as the shot begins and "
            "completing the line within the first half of the shot: "
            "<d>[English] It's over.</d>") in c["description"]
    assert "anime film style" in c["description"].splitlines()[0]
    assert "[reference generation]" in c["summary"]


def test_flf_alignment_line():
    assert flf_alignment_line(4500) == (
        "How the reference pictures align with the target video — Picture 1 "
        "(from Shot 1) aligns with the 0.00-second mark of the target video; "
        "Picture 2 (from Shot 1) aligns with the 4.50-second mark of the target video.")


def test_empty_beats_raise():
    with pytest.raises(CompileError):
        compile_block(render_ms=5000, warmup_ms=0, aspect="16:9", style="", medium="film",
                      beats=[], cast=[], environment=None, ref_slots=[])


# --- reference roles ---------------------------------------------------------
# An image can be "open the video on this frame" or "make it look like this".
# H3 needs to be told which, and the wrong one silently overrides the shot we
# planned, so both directions are pinned here.

def _roles_fixture(ref_slots):
    return compile_block(
        render_ms=8000, warmup_ms=500, aspect="16:9", style="anime",
        medium="music_video",
        beats=[{"start_ms": 0, "duration_ms": 8000, "action": "Kai and Rei clash",
                "camera": "wide", "cast_names": ["Kai"], "dialogue": [], "sfx": "impact"}],
        cast=[{"name": "Kai", "identity_line": "Kai, black jacket"}],
        environment=None, ref_slots=ref_slots, audio_mode="native")


def test_look_ref_disclaims_framing():
    out = _roles_fixture([{"slot": 1, "kind": "look", "role": "vfx",
                           "shot_idxs": [1], "desc": "a white-hot prismatic burst"}])
    text = full_prompt_text(out)
    assert "effect reference" in text
    assert "its framing, camera angle and the placement of anything in it are not copied" in text
    assert "framing, camera angle and subject placement are not" in text
    # A look reference must never claim the opening frame.
    assert "first frame of [Shot 1]" not in text


def test_start_frame_claims_the_opening():
    out = _roles_fixture([{"slot": 1, "kind": "start_frame"}])
    text = full_prompt_text(out)
    assert "the target video opens on this exact image" in text
    assert "fully_preserved" in text
    assert "not copied" not in text


def test_storyboard_ref_keeps_framing():
    out = _roles_fixture([{"slot": 1, "kind": "scene_ref", "role": "storyboard",
                           "shot_idxs": [1], "desc": "the clash staged wide"}])
    text = full_prompt_text(out)
    assert "storyboard reference" in text and "its framing is intended" in text
    assert "not copied" not in text
    # A storyboard panel contains no "effect" — that word reached this branch
    # by copy-paste from the look/vfx one, so the retention rule (the channel
    # H3 weighs hardest) named a referent the prompt never introduces.
    assert "the effect's" not in text
    assert "its composition, staging" in text


def test_chain_and_start_frame_are_worded_differently():
    chain = full_prompt_text(_roles_fixture([{"slot": 1, "kind": "chain"}]))
    start = full_prompt_text(_roles_fixture([{"slot": 1, "kind": "start_frame"}]))
    assert "final frame of the preceding segment" in chain
    assert "final frame of the preceding segment" not in start


def test_vfx_language_weaves_once_up_front():
    out = compile_fixture(vfx_language="ribbons of violet emberlight that "
                                       "cast hard purple rim light")
    text = full_prompt_text(out)
    assert text.count("one design language: ribbons of violet emberlight") == 1
    # it rides the opening style sentence, before [Shot 1]
    body = out.get("detailed_description") or out.get("description") or text
    assert body.index("one design language") < body.index("[Shot 1]")
    # and absent, the compile is unchanged (no stray clause)
    assert "design language" not in full_prompt_text(compile_fixture())


def test_chained_block_forbids_dialogue_echo():
    out = compile_fixture(audio_mode="native",
                          prev_closing="Bren lowers the crossbow — with Bren's "
                                       "final line already spoken there in full")
    text = full_prompt_text(out)
    assert "No words spoken in the preceding segment are spoken again" in text
    # names the first new speaker and their shot
    assert "the first dialogue in this segment is Kira's line in [Shot 1]" in text
    # no verbatim previous line anywhere for the model to perform
    assert "having just said" not in text
    # unchained compile carries none of it
    plain = full_prompt_text(compile_fixture(
        audio_mode="native",
        ref_slots=[s for s in REF_SLOTS if s.get("kind") != "chain"]))
    assert "No words spoken in the preceding segment" not in plain
    # locked audio reuses the track 1:1 — the clause would be nonsense there
    locked = full_prompt_text(compile_fixture(prev_closing="the beat ends"))
    assert "No words spoken in the preceding segment" not in locked


def test_positions_restated_per_shot():
    beats = [dict(BEATS[0]), dict(BEATS[1])]
    beats[0]["positions"] = {"Kira": "at the rooftop edge"}
    beats[1]["positions"] = {"Kira": "on the catwalk above the billboards"}
    text = full_prompt_text(compile_fixture(beats=beats, audio_mode="native",
                                            lyrics=None))
    assert "In this shot Kira is at the rooftop edge." in text
    assert "In this shot Kira is on the catwalk above the billboards." in text
    # a beat without positions gets no clause
    assert "In this shot" not in full_prompt_text(compile_fixture())


def test_equipment_discipline_only_arms_on_action_scenes():
    props = [{"name": "the Ember Lantern", "look": "a brass storm lantern"}]
    out = full_prompt_text(compile_fixture(scene_type="action", props=props,
                                           audio_mode="native", lyrics=None))
    assert "the Ember Lantern (a brass storm lantern)" in out
    assert "nobody produces new equipment mid-action" in out
    # props without an action scene: named, but the set stays open
    quiet = full_prompt_text(compile_fixture(scene_type="dialogue", props=props,
                                             audio_mode="native", lyrics=None))
    assert "the Ember Lantern" in quiet
    assert "nobody produces new equipment" not in quiet
    # no props, no action: neither clause (the golden compile is unchanged)
    assert "hand props" not in full_prompt_text(compile_fixture())


def test_background_life_rides_the_environment_definition():
    env = {**ROOFTOP, "background_life": "a distant maintenance drone sweeping "
                                         "its search light, steam from rooftop vents"}
    out = compile_fixture(environment=env)
    assert ("Background life of the space, present in every shot: a distant "
            "maintenance drone" in out["subject_definitions"])
    # absent -> absent
    assert "Background life" not in compile_fixture()["subject_definitions"]


def test_line_refs_compile_as_partially_copy():
    # The measured A-path (block-5 A/B): a recorded line staged as reference
    # audio is DEFINED as that speaker's spoken line and RETAINED as
    # partially_copy — placed verbatim, lips synced, everything else generated.
    out = compile_fixture(
        audio_mode="native", lyrics=None,
        audio_refs=[
            {"slot": 1, "kind": "line", "name": "Kira",
             "text": "I burned the map that led me home", "shot_idx": 1,
             "order": 1},
        ])
    defs, ret = out["subject_definitions"], out["retention_analysis"]
    assert "spoken line \"I burned the map that led me home\"" in defs
    assert "first line of dialogue, spoken in [Shot 1]" in defs
    assert ret.count("partially_copy") == 1
    assert "placed on the target video's timeline verbatim" in ret
    assert "lips are precisely synced" in ret
    # timbre language appears nowhere — line refs replace it
    assert "voice-timbre reference" not in defs
    # a line ref for someone not in the block is dropped, same as voice refs
    ghost = compile_fixture(audio_mode="native", lyrics=None,
                            audio_refs=[{"slot": 1, "kind": "line",
                                         "name": "Nobody", "text": "hi",
                                         "shot_idx": 1, "order": 1}])
    assert "partially_copy" not in ghost["retention_analysis"]


def test_exchange_ref_binds_every_speaker_to_one_clip():
    # >3 lines become ONE recorded conversation (text-to-dialogue). The clip
    # is defined with every line in order, retained partially_copy ONCE with
    # its placement, and each present speaker's lines bind to it with their
    # measured shot-relative offsets. Listeners are named as listeners — the
    # wrong-speaker guard.
    beats = [dict(b) for b in BEATS]
    beats[1] = {**beats[1],
                "dialogue": [{"speaker": "Juno",
                              "line": "followed sparks into the smoke"}],
                "cast_names": ["Kira", "Juno"]}
    out = compile_fixture(
        beats=beats, audio_mode="native", lyrics=None,
        audio_refs=[{
            "slot": 1, "kind": "exchange",
            "start": {"shot_idx": 1, "at_ms": 300},
            "lines": [
                {"speaker": "Kira", "line": "I burned the map that led me home",
                 "shot_idx": 1, "order": 1, "at_ms": 700},
                {"speaker": "Juno", "line": "followed sparks into the smoke",
                 "shot_idx": 2, "order": 2, "at_ms": 450},
                {"speaker": "Kira", "line": "and I glow — I glow",
                 "shot_idx": 4, "order": 3, "at_ms": 800},
            ]}])
    defs, ret, desc = (out["subject_definitions"], out["retention_analysis"],
                       out["description"])
    assert "recorded conversation between" in defs
    assert "<Subject 1> (Kira) (S1)" in defs and "(Juno) (S2)" in defs
    assert "every spoken line of this segment, in order" in defs
    assert ret.count("partially_copy") == 1
    assert "beginning about 0.3 seconds into [Shot 1]" in ret
    assert "their own lines within it, and to no one else's" in ret
    # every line binds to the ONE slot; measured offsets stated per shot
    assert desc.count("lip-synced to <Audio 1>") == 3
    assert "beginning about 0.7 seconds into the shot" in desc
    assert "beginning about 0.5 seconds into the shot" in desc
    # the wrong-speaker guard names the listener
    assert ("Only Juno's lips move on this line; Kira listens without "
            "speaking, staying visibly in frame and reacting.") in desc
    # an exchange whose speakers are all absent is dropped whole
    ghost = compile_fixture(
        audio_mode="native", lyrics=None,
        audio_refs=[{"slot": 1, "kind": "exchange", "lines": [
            {"speaker": "Nobody", "line": "hi", "shot_idx": 1, "order": 1}]}])
    assert "partially_copy" not in ghost["retention_analysis"]


def test_grey_backdrop_disclaimed_in_defs_and_retention():
    out = compile_fixture()
    defs, ret = out["subject_definitions"], out["retention_analysis"]
    assert "grey studio backdrop" in defs
    assert "<Picture 2>, <Picture 3>" in defs and "reference-sheet artifact" in defs
    # retention restates it, naming the same pictures — the channel H3 weighs
    # for what carries over is where the exclusion has to live too
    assert "<Picture 2>, <Picture 3> (reference sheets): partially_preserved" in ret
    assert "appears in no shot of the target video" in ret
    # a prop-role look plate is shot on the same grey and joins the list
    slots = REF_SLOTS + [{"slot": 6, "kind": "look", "role": "prop",
                          "name": "the ember letter",
                          "desc": "a scorched letter", "shot_idxs": [1]}]
    out2 = compile_fixture(ref_slots=slots)
    assert "<Picture 2>, <Picture 3>, <Picture 6>" in out2["subject_definitions"]


def test_voice_refs_still_compile_as_timbre():
    """A voice ref binds a TIMBRE to one subject, and says so affirmatively.

    The wording used to end "…and applies to Kira's voice only, never to any
    other speaker" / "the original signal is not copied". Both are negations,
    and at cfg 1.0 a negation is rendered rather than obeyed — the multishot
    pack measured exactly this shape backfiring ("is never blended with
    <Subject 1>" CAUSED the blending) and their verified no-cross-speaker-bleed
    recipe is one plain possessive claim per anchor. So the binding must still
    be unambiguous about WHOSE voice it is, with no prohibition carrying it."""
    out = compile_fixture(audio_mode="native", lyrics=None,
                          audio_refs=[{"slot": 1, "kind": "voice", "name": "Kira"}])
    defs, ret = out["subject_definitions"], out["retention_analysis"]
    assert "<Audio 1> is a recording of <Subject 1>'s (Kira) (S1) speaking voice." in defs
    assert "references the voice timbre in <Audio 1> so Kira speaks with the same voice" in ret
    # the negations that used to carry the binding are gone from both channels
    for bad in ("never to any other speaker", "is not copied", "never blended"):
        assert bad not in defs and bad not in ret


def test_bound_line_speaks_once_not_twice():
    # With a line ref staged, the vocal clause BINDS to the recording — a
    # plain "says:" beside "placed verbatim" made H3 perform every line
    # twice (block-4 rerun, measured live).
    out = compile_fixture(
        audio_mode="native", lyrics=None,
        audio_refs=[{"slot": 1, "kind": "line", "name": "Kira",
                     "text": "I burned the map that led me home",
                     "shot_idx": 1, "order": 1}])
    desc = out["description"]
    assert "speaks, precisely lip-synced to <Audio 1>" in desc
    # the first line is bound; no bare "says" remains for it
    first_shot = desc.split("[Shot 2]")[0]
    assert "says" not in first_shot
    # unbound lines (no ref) keep the classic clause
    assert "says" in desc.split("[Shot 2]")[1]


def test_bound_line_carries_measured_offset():
    out = compile_fixture(
        audio_mode="native", lyrics=None,
        audio_refs=[{"slot": 1, "kind": "line", "name": "Kira",
                     "text": "I burned the map that led me home",
                     "shot_idx": 1, "order": 1, "at_ms": 2320}])
    assert ("lip-synced to <Audio 1>, beginning about 2.3 seconds into the "
            "shot:") in out["description"]


# --- LoRA trigger placement -------------------------------------------------
# A trigger is a token its author prepended at TRAINING time and kept out of
# the captions, so the adapter contributes nothing unless the prompt carries it
# (grit / `gritmotion`). The whole risk is placement: in front of the compiled
# envelope it sits above `subject_definitions:`, outside every field H3 reads,
# which is present-in-the-string and absent-from-the-prompt.

def test_no_triggers_leaves_the_description_untouched():
    # the golden's guarantee, stated directly: nothing changes for the models
    # that need no trigger, which is almost all of them.
    assert compile_fixture()["description"] == \
        compile_fixture(lora_triggers=[])["description"] == \
        compile_fixture(lora_triggers=None)["description"]


def test_trigger_opens_the_description_not_the_envelope():
    out = compile_fixture(lora_triggers=["gritmotion"])
    assert out["description"].startswith("gritmotion, The target video is in a")
    txt = full_prompt_text(out)
    # inside the field, and the envelope still opens on its first section
    assert txt.startswith("subject_definitions:")
    assert "detailed_description:\ngritmotion, " in txt


def test_triggers_are_deduped_and_ordered():
    out = compile_fixture(lora_triggers=["gritmotion", "gritmotion", " other ", ""])
    assert out["description"].startswith("gritmotion, other, The target video")


def test_a_trigger_already_in_the_prose_is_not_repeated():
    beats = [{**BEATS[0], "action": "gritmotion, Kira stands at the rooftop edge"}]
    out = compile_fixture(beats=beats, lora_triggers=["gritmotion"],
                          audio_mode="native", lyrics=None)
    assert out["description"].count("gritmotion") == 1


def test_with_triggers_targets_the_description_field_of_each_envelope():
    six = full_prompt_text(compile_fixture())
    got = with_triggers(six, ["gritmotion"])
    assert "detailed_description:\ngritmotion, The target video" in got
    assert got.startswith("subject_definitions:")

    # the three-field form full_prompt_text emits for a legacy compiled row
    # (no subject_definitions key) — a space after the label, not a newline
    three = full_prompt_text({"description": "A woman stands at the window.",
                              "soundscape": "Rain.", "music": "N/A"})
    got3 = with_triggers(three, ["gritmotion"])
    assert got3.startswith("integrated_multimodal_description: gritmotion, A woman")


def test_with_triggers_prefixes_plain_prose():
    # the composer's own register — the author's example prompt is exactly this
    assert with_triggers("A woman stands at the window.", ["gritmotion"]) == \
        "gritmotion, A woman stands at the window."
    assert with_triggers("gritmotion, already here.", ["gritmotion"]) == \
        "gritmotion, already here."
    assert with_triggers("untouched.", []) == "untouched."
    # an empty prompt is an upstream error; don't manufacture one from a token
    assert with_triggers("", ["gritmotion"]) == ""
    assert with_triggers("  ", ["gritmotion"]) == "  "


@pytest.mark.parametrize("src,want", [
    ("08:14. 881 megahertz—same spike, same interval.",
     "oh eight fourteen. eight hundred eighty-one megahertz—same spike, same interval."),
    ("Next spike—tonight. 21:00.", "Next spike—tonight. twenty-one hundred."),
    ("March third. March eighteen.", "March third. March eighteen."),   # already words
    ("Off the track. Now.", "Off the track. Now."),                     # no digits
    ("Platform 3, car 12.", "Platform three, car twelve."),
])
def test_speakable_rewrites_only_digit_forms(src, want):
    assert hp.speakable(src) == want


def test_dialogue_is_made_speakable_at_compile_time_without_mutating_the_caller():
    """H3 mispronounces digits and says spelled-out numbers correctly.

    Measured on AFTERLIGHT STATIC — same scene, same window, only the digits
    changed: "08:14. 881 megahertz" was heard as "Lotto at C-Tore, 880 on
    megahertz"; spelled out, the ASR read back "Oh, 814, 881 megahertz", which
    it can only do if the audio said those words.

    The rows belong to the caller and the ElevenLabs path reads the same ones,
    so this must copy rather than mutate.
    """
    beats = [{"start_ms": 0, "duration_ms": 6000, "action": "Ren reads the strip",
              "camera": "a medium shot at eye level", "cast_names": ["Ren"],
              "dialogue": [{"speaker": "Ren", "line": "08:14. 881 megahertz."}]}]
    out = hp.compile_block(
        render_ms=6000, warmup_ms=0, aspect="16:9", style="anime", medium="series",
        beats=beats, cast=[{"name": "Ren", "identity": "a bleached-blond intern"}],
        environment={"name": "The rooftops", "identity": "a low concrete roof"},
        ref_slots=[{"slot": 1, "kind": "character", "name": "Ren"}], mode="r2v")
    text = hp.full_prompt_text(out)
    assert "eight hundred eighty-one" in text and "oh eight fourteen" in text
    assert "881" not in text and "08:14" not in text
    # the caller's row is untouched — dialogue_synth reads the same dict
    assert beats[0]["dialogue"][0]["line"] == "08:14. 881 megahertz."


# ------------------------------------------- chained r2v continuity (fmt 17) ---
def _chained_kw(**over):
    kw = dict(render_ms=8000, warmup_ms=0, aspect="16:9", style="anime", medium="film",
              beats=[{"idx": 1, "action": "Aki holds the polaroid",
                      "camera": "medium close-up", "cast": ["Aki Minase"], "dialogue": []}],
              cast=[{"name": "Aki Minase", "identity": "black hair, one white streak"}],
              environment={"name": "the observatory", "identity": "a flooded dome"},
              ref_slots=[{"slot": 1, "kind": "character", "name": "Aki Minase"}],
              mode="r2v")
    kw.update(over)
    return kw


def test_chained_r2v_is_told_it_continues():
    """A storyboard scene is a run of CHAINED r2v blocks, and r2v carries no
    opening frame — so `continuing` used to be False for every one of them and
    the continuation sentence was compiled for nobody. Measured: OBSERVATORY's
    blocks 18/19 are chained, neither mentioned a past, and the reviewer's
    complaint about both was GEOGRAPHY_BREAK — the cast restaged from scratch."""
    d = compile_block(**_chained_kw(prev_closing="Aki peeled the polaroid free"))
    assert "preceding segment ended as" in d["subject_definitions"]


def test_unchained_r2v_is_unchanged():
    d = compile_block(**_chained_kw())
    assert "preceding segment" not in d["subject_definitions"]
    assert "<Video" not in d["subject_definitions"]


def test_video_reference_is_described_and_numbered_independently():
    """ref2va takes 3 videos beside its 9 pictures and 3 audios, and videos
    number in their own family (§2.5, as audio does). This channel went unused
    for the pipeline's whole life."""
    d = compile_block(**_chained_kw(
        prev_closing="Aki peeled the polaroid free",
        video_refs=[{"slot": 1, "kind": "prev_segment", "block_idx": 17}]))
    defs = d["subject_definitions"]
    assert "<Video 1>" in defs
    # <Picture 1> is still the character — pictures do not renumber around it
    assert "<Picture 1>" in defs


def test_the_video_definition_carries_no_prohibition():
    """`do not replay it` is the shape that produced two signs when one was
    asked for. State what the shot DOES: it begins after the final frame."""
    d = compile_block(**_chained_kw(
        prev_closing="x", video_refs=[{"slot": 1, "kind": "prev_segment"}]))
    tail = d["subject_definitions"].split("<Video 1>")[1][:420].lower()
    assert " not " not in tail and "never" not in tail
    assert "begins after" in tail


def test_the_wrong_speaker_guard_also_covers_the_branch_h3_performs_itself():
    """The guard shipped only on the branch where a RECORDING is placed. This
    is the other one — reached whenever a line was not staged as audio, which
    is the documented loud fallback when `place_exchange` cannot fit a run or
    ElevenLabs is down. A block with several faces and no recording had nothing
    telling H3 whose mouth to move."""
    beats = [{"start_ms": 0, "duration_ms": 4000,
              "action": "Kira and Juno face each other across the roof",
              "camera": "a medium two-shot at eye level",
              "dialogue": [{"speaker": "Kira", "line": "You knew."}],
              "sfx": None, "cast_names": ["Kira", "Juno"]}]
    desc = compile_fixture(beats=beats, audio_mode="native", lyrics=None,
                           audio_refs=[])["description"]
    # the line is performed, not bound to a slot ...
    assert "says" in desc and "lip-synced to <Audio" not in desc
    # ... and the guard is there anyway
    assert ("Only Kira's lips move on this line; Juno listens without "
            "speaking, staying visibly in frame and reacting.") in desc


def test_the_guard_never_names_a_character_the_envelope_does_not_declare():
    """A guard sentence is prose, and undeclared names in prose are exactly
    what H3 draws extra people out of. `_staged_others` intersects the beat's
    own cast with the subjects this envelope declares, so the clause can only
    ever constrain someone the prompt had already put in the shot — it can
    never introduce one. "A Stranger" is in `cast_names` and not in `cast`."""
    beats = [{"start_ms": 0, "duration_ms": 4000,
              "action": "Kira speaks to the empty roof",
              "camera": "a close-up at eye level",
              "dialogue": [{"speaker": "Kira", "line": "You knew."}],
              "sfx": None, "cast_names": ["Kira", "Juno", "A Stranger"]}]
    desc = compile_fixture(beats=beats, audio_mode="native", lyrics=None,
                           audio_refs=[], ref_slots=[
                               {"slot": 1, "kind": "character", "name": "Kira",
                                "role": "turnaround"}])["description"]
    assert "A Stranger" not in desc
    # Juno IS named: he is declared and the beat casts him, so constraining him
    # to listening is the whole point. Note a declared subject need not hold a
    # picture — `ref_slots` here has only Kira's.
    assert ("Only Kira's lips move on this line; Juno listens without "
            "speaking, staying visibly in frame and reacting.") in desc


# ── compile_video_edit: the edit path's envelope ────────────────────────────
# `handle_video_edit` sent bare prose plus one appended declaration for its
# whole life; the vendor's full-reference guide says an edit is a six-section
# rewrite whose summary opens `[video editing]`. The envelope is compiled
# deterministically — invariant #6 — with the user's instruction VERBATIM.

def test_video_edit_compiles_the_vendors_six_section_envelope():
    text = full_prompt_text(hp.compile_video_edit(
        "remove the pillar next to the girl on the floor, change nothing else"))
    assert text.startswith("subject_definitions:\n")
    assert "[video editing + audio reuse]" in text
    assert "The target video is an edited version of <Video 1>." in text
    assert "<Video 1> is the source video for the target video edit." in text
    assert ("<Audio 1> is the synchronized audio track of <Video 1> and is "
            "reused in the target video.") in text
    # The instruction rides verbatim (trailing punctuation normalised).
    assert "remove the pillar next to the girl on the floor" in text
    # Retention says everything unnamed is held, and no NEW music is invented.
    assert "fully preserved" in text
    assert text.rstrip().endswith("non_diegetic_music:\nN/A")


def test_video_edit_labels_follow_the_nodes_presentation_order():
    """Images come first in the node's presentation, then the soundtrack's
    <Audio j> right before its <Video k> — so with pictures staged the source
    is still <Video 1> and its soundtrack still <Audio 1>, and each picture
    line disclaims its framing (a `look` ref, not a storyboard panel)."""
    c = hp.compile_video_edit("swap the jacket for the one shown", n_ref_images=2)
    defs = c["subject_definitions"]
    assert "<Picture 1>" in defs and "<Picture 2>" in defs
    assert defs.index("<Picture 2>") < defs.index("<Video 1>")
    assert "not its framing" in defs
    assert "<Video 1> is the source video for the target video edit." in defs


def test_video_edit_survives_an_empty_instruction():
    # The modal requires a brief, but the payload key is still optional — a
    # blank one degrades to a faithful re-render, never a KeyError.
    c = hp.compile_video_edit("")
    assert "recreate the source video faithfully" in c["summary"]


def test_video_edit_composes_with_trigger_placement():
    # The edit path places lora triggers like the other three call sites; the
    # envelope form takes them right after the description label.
    text = with_triggers(full_prompt_text(hp.compile_video_edit("darken the sky")),
                         ["gritmotion"])
    assert "detailed_description:\ngritmotion" in text


# ── subject labels on a cast whose names contain one another ────────────────
#
# "Rei", "Guide Rei", "Knight Rei" and "Astronaut Rei" are four people in one
# project, and the binding was `action.replace(name, rep, 1)` over the cast in
# order — so the SHORT name substituted into the LONG one and the render was
# told something false about who is who. Measured on Rei EP04 b45, whose stored
# prompt reads `Guide <Subject 1> (Rei — black zip hoodie …)` in all three
# shots: Guide Rei's own identity line and her <Picture 1> binding never
# reached the description, so H3 drew the leader as a black-hoodie Rei with no
# reference picture. Nothing errored.

REI = {"name": "Rei", "identity_line": "a black zip hoodie and dark shorts"}
GUIDE_REI = {"name": "Guide Rei", "identity_line": "a brown hooded jacket"}
KNIGHT_REI = {"name": "Knight Rei", "identity_line": "silver plate armor"}


def _overlap(action, cast=(REI, GUIDE_REI, KNIGHT_REI), **over):
    """One shot of a cast with overlapping names -> its description."""
    kw = dict(
        render_ms=8000, warmup_ms=916, aspect="16:9", style="anime", medium="series",
        beats=[{"start_ms": 0, "duration_ms": 8000, "action": action,
                "camera": "a static shot", "dialogue": [], "sfx": None,
                "cast_names": [c["name"] for c in cast]}],
        cast=list(cast), environment=None,
        ref_slots=[{"slot": 1, "kind": "character", "name": "Guide Rei"},
                   {"slot": 2, "kind": "character", "name": "Knight Rei"}],
        audio_mode="native")
    kw.update(over)
    return compile_block(**kw)["description"]


def test_a_shorter_name_never_binds_inside_a_longer_one():
    # The measured b45 prose, near enough to be the same sentence.
    d = _overlap("Guide Rei leads injured Knight Rei out through the opening.")
    assert "Guide <Subject" not in d, "the short name bound inside the long one again"
    assert "Knight <Subject" not in d
    assert "<Subject 2> (Guide Rei — a brown hooded jacket)" in d
    assert "<Subject 3> (Knight Rei — silver plate armor)" in d
    # Rei is in the block's cast but this shot never names her on her own, so
    # she is not labelled here at all.
    assert "<Subject 1>" not in d


def test_a_bare_name_still_binds_once_the_longer_one_is_consumed():
    d = _overlap("Guide Rei leads Knight Rei out, then steadies Knight Rei "
                 "as Rei takes the photograph.")
    assert "<Subject 1> (Rei — a black zip hoodie and dark shorts)" in d
    assert "<Subject 2> (Guide Rei — a brown hooded jacket)" in d
    assert "Guide <Subject" not in d and "Knight <Subject" not in d
    # EVERY occurrence of the longer name is consumed even though only the
    # first is labelled — consuming just the first (which is all `count=1`
    # did) leaves the second "Knight Rei" standing for "Rei" to match into,
    # one sentence later.
    assert d.count("<Subject 3>") == 1
    assert "steadies Knight Rei as" in d


def test_the_identity_line_rides_only_the_first_mention():
    # Official §5.3: the tag binds on first use and the rest of the sentence
    # stays readable prose.
    d = _overlap("Rei watches the portal. Rei steps back.")
    assert d.count("a black zip hoodie and dark shorts") == 1
    assert "Rei steps back" in d


def test_the_untagged_modes_keep_their_inline_form():
    # FL2VA has no reference set to number, so the identity goes inline —
    # and the same overlap rule has to hold there.
    d = _overlap("Guide Rei leads Knight Rei out.", mode="i2v")
    assert "<Subject" not in d
    assert "Guide Rei — a brown hooded jacket —" in d
    assert "Knight Rei — silver plate armor —" in d

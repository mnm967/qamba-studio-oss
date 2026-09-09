"""What `music_gen` does with a payload before it reaches a graph builder.

The routing and the graphs are covered elsewhere; this file is about the
NORMALISATION, which is where the silent failures live. A duration past the
model's ceiling, a key signature the encoder's enum does not contain, or an
"instrumental" that only clears a field and never says so in the caption all
produce a perfectly good track that is not the one that was asked for.
"""
import pytest

import handlers.music as M

MUSIC3 = {"family": "music3", "unet": "m3.safetensors",
          "text_encoder": "m3_te.safetensors", "clip_type": "minimax",
          "vae": "m3_dav.safetensors", "steps": 30, "cfg": 1.7,
          "sampler": "euler", "scheduler": "simple", "max_seconds": 360}
ACE = {"family": "acestep", "unet": "ace.safetensors",
       "text_encoders": ["q06.safetensors", "q17.safetensors"], "clip_type": "ace",
       "vae": "ace_vae.safetensors", "steps": 8, "cfg": 1.0, "shift": 3.0,
       "sampler": "euler", "scheduler": "simple", "max_seconds": 300}
ENTRIES = {"minimax-music3": MUSIC3, "acestep-1.5": ACE}


@pytest.fixture
def rec(monkeypatch):
    """Run the handler with the pod replaced by recorders."""
    calls = {}
    monkeypatch.setattr(M.R, "music_model", lambda key: ENTRIES[key])
    monkeypatch.setattr(M, "_node_spec", lambda *n: {})
    monkeypatch.setattr(M.comfy, "submit", lambda g: "pid-1")
    monkeypatch.setattr(M.comfy, "wait", lambda pid, **kw: {"10": {}})
    monkeypatch.setattr(M.comfy, "fetch_output", lambda o, n, dest: "x.mp3")
    monkeypatch.setattr(M, "make_tick", lambda job: None)
    monkeypatch.setattr(M.media, "b2_put", lambda *a, **k: None)
    monkeypatch.setattr(M.media, "probe", lambda p: {"bytes": 1, "duration_ms": 1000})
    monkeypatch.setattr(M.sb, "job_patch", lambda *a, **k: None)
    monkeypatch.setattr(M.sb, "job_progress", lambda *a, **k: None)
    monkeypatch.setattr(M.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(M.sb, "insert", lambda *a, **k: None)

    def register(*a, **k):
        calls["asset"] = k
        return {"id": "a1"}

    monkeypatch.setattr(M.sb, "register_asset", register)
    monkeypatch.setattr(M.os, "remove", lambda p: None)

    def m3(entry, **kw):
        calls["fam"], calls["kw"] = "music3", kw
        return {"graph": {}, "outputs": ["10"]}

    def ace(entry, **kw):
        calls["fam"], calls["kw"] = "acestep", kw
        return {"graph": {}, "outputs": ["10"]}

    monkeypatch.setattr(M.graphs, "music3_graph", m3)
    monkeypatch.setattr(M.graphs, "acestep_graph", ace)
    return calls


def run(rec, **payload):
    payload.setdefault("prompt", "dream pop, reverbed guitar")
    M.handle_music_gen({"id": "j1", "payload": payload})
    return rec


# ------------------------------------------------------------- dispatch ----

def test_the_family_chooses_the_builder(rec):
    assert run(rec, model_key="acestep-1.5")["fam"] == "acestep"


def test_music3_is_the_default_model(rec):
    assert run(rec)["fam"] == "music3"


def test_each_family_gets_the_prompt_under_its_own_name(rec):
    assert "caption" in run(rec, model_key="minimax-music3")["kw"]
    assert "tags" in run(rec, model_key="acestep-1.5")["kw"]


def test_an_empty_prompt_is_refused(rec):
    with pytest.raises(ValueError, match="prompt"):
        M.handle_music_gen({"id": "j1", "payload": {"prompt": "  "}})


def test_an_unknown_family_is_refused_rather_than_guessed(rec, monkeypatch):
    monkeypatch.setattr(M.R, "music_model", lambda key: {"family": "riffusion"})
    with pytest.raises(ValueError, match="riffusion"):
        M.handle_music_gen({"id": "j1", "payload": {"prompt": "x"}})


# ------------------------------------------------------------- duration ----

def test_milliseconds_in_seconds_out(rec):
    """Invariant #3 on the wire; the ComfyUI nodes take seconds."""
    assert run(rec, duration_ms=90_000)["kw"]["seconds"] == 90.0


def test_the_entrys_ceiling_binds(rec):
    assert run(rec, model_key="acestep-1.5", duration_ms=9_999_000)["kw"]["seconds"] == 300.0
    assert run(rec, model_key="minimax-music3", duration_ms=9_999_000)["kw"]["seconds"] == 360.0


def test_a_silly_short_request_is_floored(rec):
    assert run(rec, duration_ms=200)["kw"]["seconds"] == M.MIN_S


# --------------------------------------------------------- instrumental ----

def test_instrumental_is_said_in_the_caption_not_just_the_empty_field(rec):
    """Both models sing whatever is in `lyrics`, and an empty field is an
    absence rather than an instruction — the caption still describes a song,
    so vocals come back anyway. It has to be stated."""
    kw = run(rec, instrumental=True)["kw"]
    assert kw["lyrics"] == ""
    assert "no vocals" in kw["caption"]


def test_ace_gets_its_own_sections_grammar_for_instrumental(rec):
    kw = run(rec, model_key="acestep-1.5", instrumental=True)["kw"]
    assert kw["lyrics"] == M.ACE_INSTRUMENTAL


def test_no_lyrics_means_instrumental(rec):
    """The UI can leave the field blank; the handler must not then produce a
    song with invented words."""
    kw = run(rec, lyrics="")["kw"]
    assert "no vocals" in kw["caption"]


def test_lyrics_are_passed_through_verbatim(rec):
    words = "[Verse]\nthe rain on the window\n\n[Chorus]\nstay"
    kw = run(rec, lyrics=words)["kw"]
    assert kw["lyrics"] == words
    assert "no vocals" not in kw["caption"]


# -------------------------------------------------- ace musical metadata ----

def test_musical_metadata_reaches_the_ace_builder(rec):
    kw = run(rec, model_key="acestep-1.5", bpm=142, key_scale="F# minor",
             time_signature="3", language="ja")["kw"]
    assert (kw["bpm"], kw["key_scale"], kw["time_signature"], kw["language"]) \
        == (142, "F# minor", "3", "ja")


@pytest.mark.parametrize("field,bad,fallback", [
    ("key_scale", "H♯ lydian", "C major"),
    ("time_signature", "7", "4"),
    ("language", "elvish", "en"),
])
def test_a_value_outside_the_nodes_enum_snaps_to_the_default(rec, field, bad, fallback):
    """These are typed encoder inputs — an unknown string is a ComfyUI
    validation failure, i.e. a dead job, not a stylistic miss."""
    assert run(rec, model_key="acestep-1.5", **{field: bad})["kw"][field] == fallback


def test_enum_matching_is_case_insensitive(rec):
    assert run(rec, model_key="acestep-1.5", key_scale="f# MINOR")["kw"]["key_scale"] == "F# minor"


def test_music3_is_not_handed_musical_metadata(rec):
    """It has no such inputs; passing them would be a payload key nothing
    reads, and the builder would reject the kwarg outright."""
    kw = run(rec, model_key="minimax-music3", bpm=142)["kw"]
    assert "bpm" not in kw


# ---------------------------------------------------------------- asset ----

def test_the_track_is_registered_as_an_audio_asset(rec):
    calls = run(rec, project_id="p1", seed=5)
    a = calls["asset"]
    assert a["tags"] == ["library", "generated", "music"]
    assert a["content_type"] == "audio/mpeg"
    assert a["project_id"] == "p1"
    assert a["meta"]["model"] == "minimax-music3" and a["meta"]["seed"] == 5


# ------------------------------------------------- attaching to a storyboard --
# `target: {storyboard_id}` is what turns a track in the library into the thing
# a music video renders against — `handle_launch_render` reads
# `storyboards.audio_asset_id` to decide whether blocks are locked and cut to
# `audio_meta.beats_ms`. Every failure here is silent: the render succeeds and
# is simply not timed to the music.

class _SB:
    """Enough of sb to watch what `_attach` writes."""

    def __init__(self, story=None, blocks=()):
        self.story = story if story is not None else {
            "id": "sb1", "audio_asset_id": None, "audio_meta": {}}
        self.blocks = list(blocks)
        self.patches = []

    def get(self, q):
        if q.startswith("storyboards?"):
            return [self.story] if self.story else []
        if q.startswith("generation_blocks?"):
            return self.blocks
        return []

    def patch(self, q, body):
        self.patches.append((q, body))
        return body


@pytest.fixture
def fake_sb(monkeypatch):
    s = _SB()
    monkeypatch.setattr(M.sb, "get", s.get)
    monkeypatch.setattr(M.sb, "patch", s.patch)
    return s


ASSET = {"id": "a-new"}
INFO = {"duration_ms": 120_000}


def test_no_target_touches_nothing(fake_sb):
    M._attach({}, ASSET, INFO, bpm=120)
    assert fake_sb.patches == []


def test_the_track_becomes_the_storyboards_audio(fake_sb):
    M._attach({"storyboard_id": "sb1"}, ASSET, INFO)
    q, body = fake_sb.patches[0]
    assert q == "storyboards?id=eq.sb1"
    assert body["audio_asset_id"] == "a-new"
    assert body["audio_meta"]["source"] == "generated"


def test_a_bpm_becomes_the_beat_grid_the_planner_snaps_to(fake_sb):
    M._attach({"storyboard_id": "sb1"}, ASSET, INFO, bpm=120)
    meta = fake_sb.patches[0][1]["audio_meta"]
    assert meta["bpm"] == 120
    # 120 BPM = one beat every 500ms; 120s inclusive of both ends.
    assert meta["beats_ms"][:4] == [0, 500, 1000, 1500]
    assert meta["beats_ms"][-1] == 120_000
    assert len(meta["beats_ms"]) == 241


def test_no_bpm_means_no_grid_rather_than_a_wrong_one(fake_sb):
    """Music 3 has no BPM input, so a track from it has no trustworthy tempo —
    and a made-up grid would silently retime every block boundary."""
    M._attach({"storyboard_id": "sb1"}, ASSET, INFO)
    assert "beats_ms" not in fake_sb.patches[0][1]["audio_meta"]


def test_lyrics_do_not_go_into_the_TIMED_field(fake_sb):
    """`audio_meta.lyrics` is [{t0,t1,text,singer}] and every consumer indexes
    into it — `_lyrics_in_window` shifts them into a block's window, the
    planner prints them as "12.4-15.1s: …". We know the words, not the clock."""
    M._attach({"storyboard_id": "sb1"}, ASSET, INFO, lyrics="[Verse]\nrain")
    meta = fake_sb.patches[0][1]["audio_meta"]
    assert "lyrics" not in meta
    assert meta["lyrics_text"] == "[Verse]\nrain"


def test_an_instrumental_writes_no_lyric_text(fake_sb):
    M._attach({"storyboard_id": "sb1"}, ASSET, INFO,
              lyrics=M.ACE_INSTRUMENTAL, instrumental=True)
    assert "lyrics_text" not in fake_sb.patches[0][1]["audio_meta"]


def test_existing_audio_meta_survives(fake_sb):
    """An uploaded track's sections, or a hand-typed lyric sheet, must not be
    dropped just because a new track landed."""
    fake_sb.story["audio_meta"] = {"sections": ["verse", "chorus"], "bpm": 90}
    M._attach({"storyboard_id": "sb1"}, ASSET, INFO, bpm=120)
    meta = fake_sb.patches[0][1]["audio_meta"]
    assert meta["sections"] == ["verse", "chorus"]
    assert meta["bpm"] == 120          # the new track's tempo wins


def test_replacing_a_track_marks_the_blocks_stale(fake_sb):
    """Those blocks carry `audio_slice.asset_id` pointing at the OLD file, so
    left alone they read as current while being cut against a track that is no
    longer the episode's."""
    fake_sb.story["audio_asset_id"] = "a-old"
    fake_sb.blocks = [{"id": "b1"}, {"id": "b2"}]
    M._attach({"storyboard_id": "sb1"}, ASSET, INFO)
    stale = [p for p in fake_sb.patches if p[1].get("status") == "stale"]
    assert stale and stale[0][0].startswith("generation_blocks?storyboard_id=eq.sb1")


def test_the_first_track_marks_nothing_stale(fake_sb):
    fake_sb.blocks = [{"id": "b1"}]
    M._attach({"storyboard_id": "sb1"}, ASSET, INFO)
    assert not [p for p in fake_sb.patches if p[1].get("status") == "stale"]


def test_a_deleted_storyboard_is_survivable(fake_sb):
    """The track still exists as a library asset — losing the attach must not
    lose the render."""
    fake_sb.story = None
    M._attach({"storyboard_id": "gone"}, ASSET, INFO)
    assert fake_sb.patches == []


@pytest.mark.parametrize("bpm,expect", [
    (0, []), (None, []), (10, []), (400, []),          # outside the node's range
    (60, [0, 1000, 2000]),
])
def test_beats_grid_matches_the_browsers_copy(bpm, expect):
    """The Python twin of `beatsGrid` in WizardPage.tsx — an uploaded track's
    grid comes from there, a generated one from here, and the planner cannot
    tell which it got."""
    got = M.beats_grid(bpm, 2000)
    assert got == expect


# ------------------------------------------------------------- recipe ----
# A finished track has to be able to say what it was made from. Until it did,
# the words and the style brief existed only in a jobs row that scrolls out of
# the queue — so a track you liked could be played and never varied.

def test_the_asset_carries_the_words_and_the_style_brief(rec):
    meta = run(rec, prompt="dream pop, tape hiss", lyrics="[Verse]\nlow tide",
               instrumental=False)["asset"]["meta"]
    assert meta["prompt"].startswith("dream pop")
    assert meta["lyrics"] == "[Verse]\nlow tide"
    assert meta["instrumental"] is False
    # What the library filters on, and what tells a track from a sound effect.
    assert meta["kind_hint"] == "music"


def test_the_typed_musical_controls_are_recorded_as_the_encoder_got_them(rec):
    """Snapped to the node enums, not copied raw off the payload — otherwise
    the stored recipe says "H flat" while the render heard "C major"."""
    meta = run(rec, model_key="acestep-1.5", bpm=96, key_scale="f# MINOR",
               time_signature="9", language="jp")["asset"]["meta"]
    assert meta["bpm"] == 96
    assert meta["key_scale"] == "F# minor"
    assert meta["time_signature"] == "4"     # 9 is not one of the node's four
    assert meta["language"] == "en"          # nor is "jp"


def test_music3_records_no_musical_metadata_it_never_had(rec):
    """Music 3 has no BPM/key inputs at all. Writing a default onto the asset
    would make the library claim a tempo the render never conditioned on."""
    meta = run(rec, model_key="minimax-music3", bpm=140)["asset"]["meta"]
    assert "bpm" not in meta and "key_scale" not in meta


def test_an_instrumental_records_itself_as_one(rec):
    meta = run(rec, model_key="acestep-1.5", instrumental=True)["asset"]["meta"]
    assert meta["instrumental"] is True
    assert meta["lyrics"] == M.ACE_INSTRUMENTAL

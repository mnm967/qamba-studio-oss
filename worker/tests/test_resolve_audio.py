"""`resolve.music_model` / `resolve.sfx_model` — the audio half of what
`ensure_model` does for video: look the entry up, and guarantee its files are
on disk before a graph is built.

The two share a body (`_audio_entry`) and differ only in which files they
demand, which is the whole point of the split: a music entry is a UNET + VAE +
one or two text encoders under `diffusion_models/`, `vae/` and
`text_encoders/`, while Stable Audio 3 ships MODEL and VAE in ONE file under
`checkpoints/`. Check the wrong directory and a present model looks missing —
which triggers a multi-GB re-download on every job and then fails anyway.
"""
import os

import pytest

import resolve as R

MUSIC = {"family": "music3", "unet": "m3.safetensors", "vae": "m3_vae.safetensors",
         "text_encoder": "m3_te.safetensors"}
ACE = {"family": "acestep", "unet": "ace.safetensors", "vae": "ace_vae.safetensors",
       "text_encoders": ["q06.safetensors", "q17.safetensors"]}
SFX = {"family": "stable_audio", "checkpoint": "sa3.safetensors",
       "text_encoder": "t5gemma.safetensors"}

MAP = {"test": {"music_models": {"minimax-music3": MUSIC, "acestep-1.5": ACE},
                "sfx_models": {"stable-audio-3-medium": SFX}}}


@pytest.fixture
def pod(monkeypatch, tmp_path):
    """A model tree with nothing in it, and a `fetchmodel` that records."""
    monkeypatch.setattr(R, "TIER", "test")
    monkeypatch.setattr(R, "load_map", lambda: MAP)
    monkeypatch.setattr(R, "COMFY_ROOT", str(tmp_path))
    monkeypatch.setattr(R, "_log", lambda *a, **k: None)
    calls = {"fetched": []}

    class Done:
        returncode, stdout, stderr = 0, "", ""

    def run(cmd, **kw):
        calls["fetched"].append(cmd)
        for sub, fn in calls.get("creates", []):
            d = tmp_path / "models" / sub
            d.mkdir(parents=True, exist_ok=True)
            (d / fn).write_text("x")
        return Done()

    monkeypatch.setattr(R.subprocess, "run", run)
    # THE FIXTURE IS THE POD, and the pod has a `fetchmodel` on its PATH —
    # `bootstrap.sh` installs it. `_has_fetcher` asks the PATH rather than
    # reading a tier name, so a machine without one (this laptop, and every
    # desktop build) refuses by name instead of dying on
    # `FileNotFoundError: 'fetchmodel'` out of subprocess. Saying so here is
    # what keeps these cases about the fetch rather than about the runner.
    monkeypatch.setattr(R, "_has_fetcher", lambda: True)
    calls["place"] = lambda sub, fn: (
        (tmp_path / "models" / sub).mkdir(parents=True, exist_ok=True),
        (tmp_path / "models" / sub / fn).write_text("x"))
    return calls


def place(pod, *pairs):
    for sub, fn in pairs:
        pod["place"](sub, fn)


# ------------------------------------------------------------- lookup ----

def test_an_unknown_music_key_names_what_is_available(pod):
    with pytest.raises(R.ResolveError) as e:
        R.music_model("suno-v4")
    msg = str(e.value)
    assert "suno-v4" in msg and "minimax-music3" in msg


def test_an_unknown_sfx_key_says_sfx_not_music(pod):
    """The two sections have separate namespaces, so the error has to say
    which one it looked in or it reads as a code bug."""
    with pytest.raises(R.ResolveError) as e:
        R.sfx_model("minimax-music3")
    assert "sfx model" in str(e.value)


# ------------------------------------------------------- file checking ----

def test_music_looks_in_the_three_music_directories(pod):
    place(pod, ("diffusion_models", "m3.safetensors"), ("vae", "m3_vae.safetensors"),
          ("text_encoders", "m3_te.safetensors"))
    assert R.music_model("minimax-music3") is MUSIC
    assert not pod["fetched"], "nothing was missing, so nothing should be fetched"


def test_a_dual_encoder_entry_needs_both_files(pod):
    place(pod, ("diffusion_models", "ace.safetensors"), ("vae", "ace_vae.safetensors"),
          ("text_encoders", "q06.safetensors"))
    with pytest.raises(R.ResolveError):
        R.acestep = R.music_model("acestep-1.5")
    assert pod["fetched"], "the missing 1.7B planner should have triggered a fetch"


def test_sfx_looks_in_checkpoints_not_diffusion_models(pod):
    """Placing the checkpoint where a music UNET goes must NOT satisfy it —
    that mistake is a silent multi-GB re-download on every single job."""
    place(pod, ("diffusion_models", "sa3.safetensors"),
          ("text_encoders", "t5gemma.safetensors"))
    with pytest.raises(R.ResolveError):
        R.sfx_model("stable-audio-3-medium")


def test_sfx_demands_no_vae_of_its_own(pod):
    """MODEL and VAE ride in the one checkpoint. Demanding a `vae` row would
    make every SFX entry unsatisfiable."""
    place(pod, ("checkpoints", "sa3.safetensors"),
          ("text_encoders", "t5gemma.safetensors"))
    assert R.sfx_model("stable-audio-3-medium") is SFX
    assert not pod["fetched"]


def test_a_symlinked_file_counts_as_present(pod, tmp_path):
    """/data is symlinked into ComfyUI's model tree — `os.path.exists` follows
    a link, but a dangling one during a fetch would otherwise re-download."""
    real = tmp_path / "real.safetensors"
    real.write_text("x")
    d = tmp_path / "models" / "checkpoints"
    d.mkdir(parents=True, exist_ok=True)
    os.symlink(real, d / "sa3.safetensors")
    place(pod, ("text_encoders", "t5gemma.safetensors"))
    assert R.sfx_model("stable-audio-3-medium") is SFX


# ------------------------------------------------------------- fetching ----

def test_a_missing_file_shells_out_to_fetchmodel_with_the_map_key(pod):
    pod["creates"] = [("checkpoints", "sa3.safetensors"),
                      ("text_encoders", "t5gemma.safetensors")]
    assert R.sfx_model("stable-audio-3-medium") is SFX
    assert pod["fetched"] == [["fetchmodel", "stable-audio-3-medium"]]


def test_a_fetch_that_does_not_produce_the_files_raises(pod):
    with pytest.raises(R.ResolveError, match="still missing"):
        R.sfx_model("stable-audio-3-medium")

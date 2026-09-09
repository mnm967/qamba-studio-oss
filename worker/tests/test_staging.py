"""ComfyUI's `input/` is on the pod's ROOT volume, and almost nothing cleaned it.

Measured 2026-08-24 on the live pod: 4,701 files / 6.0 GB, 4,693 of them older
than an hour, some with `neon_*` prefixes that predate the Yeuka rename — on a
58G volume that was 91% full. The volume is in `handlers/blocks.py`
(neon_ref 3279, neon_chain 388, neon_ctx 303, neon_voice 206, neon_line 187),
not in the post chain where the first `_unstage` was written.

`worker/staging.py` cleans at the JOB BOUNDARY instead of in each of the dozen
stagers, which only works because every staged name embeds the job id. That
invariant is the load-bearing part and nothing else enforces it, so the first
test parses every staging site and checks it. The rest pin the sweeps, whose
failure mode is either "deletes nothing" (silent) or "deletes a file a render
is still reading" (a failed render nowhere near the line that caused it).
"""
import os
import pathlib
import re
import time

import pytest

import staging

WORKER = pathlib.Path(__file__).resolve().parents[1]

JID_A = "8f2c1a90-0000-4000-8000-000000000001"
JID_B = "8f2c1a90-0000-4000-8000-000000000002"


@pytest.fixture
def inp(tmp_path, monkeypatch):
    monkeypatch.setenv("COMFY_ROOT", str(tmp_path))
    d = tmp_path / "input"
    d.mkdir()
    return d


def _touch(d, name, *, size=1, age_h=0.0):
    p = d / name
    p.write_bytes(b"x" * size)
    if age_h:
        t = time.time() - age_h * 3600
        os.utime(p, (t, t))
    return p


# ------------------------------------------------------------- invariant ----
JID = "id"           # the local name every stager uses for the job id

# Every line in the worker that writes into `$COMFY_ROOT/input`, with the
# expression that produces the basename. Kept as source assertions because the
# functions around them are several Supabase round trips deep, and because a
# new stager that invents its own naming is exactly what this must catch.
STAGERS = [
    ("handlers/post.py", "_stage_for_comfy"),
    ("handlers/blocks.py", "_stage_asset"),
    ("handlers/blocks.py", "_stage_with_ops"),
    ("handlers/images.py", "_stage_refs"),
    ("handlers/v2a.py", "_stage"),
]


def _fn(rel, name):
    src = (WORKER / rel).read_text()
    body = src.split(f"\ndef {name}(")[1]
    return body.split("\ndef ")[0]


@pytest.mark.parametrize("rel,name", STAGERS)
def test_every_staging_helper_puts_the_job_id_in_the_name(rel, name):
    """`staging.sweep_job` finds a file by matching the job id in its basename.

    A helper that names its copy anything else leaks forever and says nothing:
    the render works, the file is simply never collected.
    """
    body = _fn(rel, name)
    made = [l for l in body.splitlines() if re.search(r'name\s*=\s*f"', l)]
    assert made, f"{rel}:{name} builds no f-string name — did the shape change?"
    for line in made:
        assert "{jid" in line or "{job['id']" in line or '{job["id"]' in line, \
            f"{rel}:{name} stages {line.strip()!r} with no job id in it"


def test_the_raw_copies_outside_a_helper_carry_the_job_id_too():
    """Three handlers copy into `input/` directly rather than through a helper —
    patch_flf's two frames, video_edit's source, transition_gen's two ends."""
    src = (WORKER / "handlers" / "blocks.py").read_text()
    for pat in (r'fname = f"qamba_pf_\{jid\}', r'lname = f"qamba_pl_\{jid\}',
                r'vname = f"qamba_edit_\{jid\}',
                r'na, nb = f"qamba_ta_\{jid\}\.png", f"qamba_tb_\{jid\}\.png"'):
        assert re.search(pat, src), f"missing or renamed: {pat}"


# ---------------------------------------------------------------- sweeps ----
def test_sweep_job_takes_this_jobs_files_and_leaves_everyone_elses(inp):
    jid, other = JID_A, JID_B
    _touch(inp, f"neon_ref_{jid}_0.png", size=100)
    _touch(inp, f"neon_chain_{jid}_0.mp4", size=200)
    _touch(inp, f"qamba_up_{jid}window0.mp4", size=300)
    _touch(inp, f"neon_ref_{other}_0.png")
    _touch(inp, "a-users-own-file.png")

    n, size = staging.sweep_job(jid)

    assert (n, size) == (3, 600)
    assert sorted(p.name for p in inp.iterdir()) == [
        "a-users-own-file.png", f"neon_ref_{other}_0.png"]


def test_sweep_job_refuses_an_id_too_short_to_match_safely(inp):
    """`"" in name` is true for every name there is, so an empty or stub id
    would take the whole directory with it — including a file another job is
    reading right now."""
    _touch(inp, f"neon_ref_{JID_A}_0.png")
    for bad in ("", None, "x", "abc"):
        assert staging.sweep_job(bad) == (0, 0)
    assert len(list(inp.iterdir())) == 1


def test_sweep_job_is_quiet_when_there_is_no_input_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("COMFY_ROOT", str(tmp_path / "nope"))
    assert staging.sweep_job(JID_A) == (0, 0)
    assert staging.sweep_stale() == (0, 0)


def test_sweep_stale_spares_anything_a_running_prompt_could_still_be_reading(inp):
    """The backstop for a worker killed mid-job. Age-gated because ComfyUI may
    still be executing a prompt staged by the process that just died — the
    longest observed is ~6 min against a 6h default."""
    _touch(inp, f"neon_ref_{JID_A}_old.png", size=10, age_h=48)
    _touch(inp, f"neon_ref_{JID_A}_borderline.png", size=10, age_h=5)
    _touch(inp, f"neon_ref_{JID_A}_fresh.png", size=10)

    n, size = staging.sweep_stale()

    assert (n, size) == (1, 10)
    assert sorted(p.name for p in inp.iterdir()) == [
        f"neon_ref_{JID_A}_borderline.png", f"neon_ref_{JID_A}_fresh.png"]


def test_sweep_stale_takes_an_explicit_window(inp):
    _touch(inp, f"neon_ref_{JID_A}_0.png", age_h=2)
    assert staging.sweep_stale(hours=1)[0] == 1


def test_sweep_stale_leaves_alone_anything_it_cannot_attribute_to_a_job(inp):
    """`input/` is not ours alone — ComfyUI ships an `example.png` there (still
    on the pod from 2026-07-26) and it is the obvious place to drop a file by
    hand. Age is not evidence of being garbage; a job id in the name is."""
    _touch(inp, "example.png", age_h=24 * 30)
    _touch(inp, "my-own-reference.jpg", age_h=24 * 30)
    _touch(inp, "ls_a1b2c3d4.mp4", age_h=24 * 30)   # run_lipsync's own scheme
    _touch(inp, f"neon_ref_{JID_A}_0.png", age_h=24 * 30)

    assert staging.sweep_stale()[0] == 1
    assert sorted(p.name for p in inp.iterdir()) == [
        "example.png", "ls_a1b2c3d4.mp4", "my-own-reference.jpg"]


def test_unstage_only_ever_touches_the_input_dir(inp, tmp_path):
    """The name reaches this from a graph and from job payloads. `basename`
    is what stops `../../etc/whatever` resolving out of the directory."""
    outside = tmp_path / "precious.mp4"
    outside.write_bytes(b"x")
    _touch(inp, "precious.mp4")

    assert staging.unstage("../precious.mp4") == 1
    assert outside.exists()
    assert not (inp / "precious.mp4").exists()
    assert staging.unstage("not-there.png") == 0
    assert staging.unstage(None) == 0


# ------------------------------------------------------------- the wiring ---
def test_the_runner_sweeps_in_its_finally():
    """The single place. Source-parsed: `plan_cli.main` reads argv and exits,
    so there is nothing to call in a test that would not also run a job."""
    src = (WORKER / "plan_cli.py").read_text()
    fn = src.split("\ndef main(")[1].split("\ndef ")[0]
    tail = fn.split("finally:")[-1]
    assert "staging.sweep_job(jid)" in tail, \
        "main must sweep in its finally — on error and cancel too"


def test_the_runner_sweeps_crash_residue_before_it_starts():
    """One job per process here, so there is no worker start to hang this on —
    it goes before the job, which is the same thing at this cadence. A process
    killed between staging and its `finally` is otherwise a leak that never
    converges."""
    src = (WORKER / "plan_cli.py").read_text()
    fn = src.split("\ndef main(")[1].split("\ndef ")[0]
    assert "staging.sweep_stale()" in fn
    # BEFORE the handler runs, not after: this job's own files are fresh and
    # age-gated out, so a sweep at the end would be dead code.
    assert fn.index("staging.sweep_stale()") < fn.index("fn(job)")


@pytest.mark.parametrize("fn", ["apply_upscale", "apply_interpolate", "apply_facefix",
                                "apply_color_match", "apply_ltx_refine",
                                "handle_image_upscale"])
def test_every_post_pass_drops_its_own_copy_before_the_job_ends(fn):
    """The job-boundary sweep covers the TOTAL; these cover the PEAK. `upscale`
    and `ltx_refine` stage once per WINDOW, so a long clip would otherwise hold
    several copies of itself at once."""
    body = _fn("handlers/post.py", fn)
    assert "_unstage(" in body, f"{fn} stages and never unstages"
    assert "finally:" in body, f"{fn} must unstage in a finally, not on the happy path"


def test_color_match_unstages_both_of_its_files():
    """It stages two — the clip and the reference frame — and dropping one is
    the shape of bug that halves a fix and looks done."""
    body = _fn("handlers/post.py", "apply_color_match")
    tail = body.split("finally:")[-1]
    assert tail.count("_unstage(") == 2

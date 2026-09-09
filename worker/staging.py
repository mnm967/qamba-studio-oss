"""Lifetime of the files we copy into ComfyUI's `input/` directory.

A graph names its inputs by BASENAME, so every source a render reads has to be
copied into `$COMFY_ROOT/input` first — a reference sheet, a chain frame, a
voice clip, the take a post pass is refining. Almost nothing removed the copy
afterwards, and that directory is on the pod's ROOT volume (58G, shared with
the OS and the ComfyUI tree) rather than on `/data` where the models live. So
the leak fills the one volume that has nothing to do with models: measured
2026-08-24, 4,701 files / 6.0 GB, of which 4,693 were older than an hour, some
of them months old (their `neon_*` prefixes predate the Yeuka rename).

THE INVARIANT THIS MODULE RESTS ON: **every name staged into `input/` embeds
the job id**. That is true at every staging site in the worker — `post.py`'s
`_stage_for_comfy`, `blocks.py`'s `_stage_asset`/`_stage_with_ops` and the raw
copies in `handle_patch_flf`/`handle_video_edit`/`handle_transition_gen`,
`images.py`'s `_stage_refs` and `v2a.py`'s `_stage` — because a name has to be
unique across concurrent jobs and the job id is what every one of them reached
for. `test_staging.py` pins it by parsing the source, since the whole design
below is void the day a stager invents its own scheme.

Given that, cleanup does NOT belong in each stager. There are a dozen of them
across five modules, they hand a NAME back to a caller that submits the graph
much later, and several stage from inside `ref_plan_for` — so a per-call
`finally` is not even expressible where the volume actually is. It belongs at
the JOB BOUNDARY, which `plan_cli.main` already has: one `finally`, covering
every stager that exists and every one added later, whatever the outcome
(done, error, cancel). This file keeps the "a recorder called from N places is
forgotten in the N+1th" rule by having exactly one place, and by that place not
being in any stager.

The per-pass `_unstage` in `handlers/post.py` is a different concern and stays:
the post chain stages once per WINDOW, so a long clip holds several copies of
itself at once, and end-of-job is too late for the PEAK even though it is soon
enough for the total.

`sweep_stale` is the backstop for the case neither of those can reach — a
runner killed mid-job never reaches its own `finally` — and runs once per
process, before the job does. One job per process here, so that is once per
job: a single `scandir`, age-gated, against a render measured in minutes.
"""
import os
import re
import time

# Beyond any single prompt by a wide margin: the longest observed is ~6 min.
# A worker restart while ComfyUI is still executing a prior prompt is the case
# this margin exists for — deleting an input mid-read fails the render.
TTL_HOURS = float(os.environ.get("COMFY_INPUT_TTL_H", "6"))

# A substring match on a short id would take the whole directory with it, and
# `sweep_job("")` matches every name there is. Job ids are uuids (36 chars).
MIN_ID = 8

# `input/` is not ours alone: ComfyUI ships an `example.png` there (still on the
# pod from 2026-07-26), and it is the obvious place for someone to drop a file
# by hand. So the age-based sweep only removes what it can ATTRIBUTE to a job —
# a name carrying a uuid. Anything else is left alone however old it is, which
# costs us only `run_lipsync`'s two `ls_<8hex>` files per crash, and those it
# already deletes in its own `finally`.
JOB_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                       re.IGNORECASE)


def input_dir():
    return os.path.join(os.environ.get("COMFY_ROOT", "/kaggle/working/ComfyUI"), "input")


def unstage(name):
    """Drop one staged input by basename. Never raises."""
    if not name:
        return 0
    try:
        os.remove(os.path.join(input_dir(), os.path.basename(name)))
        return 1
    except OSError:
        return 0


def _entries():
    try:
        with os.scandir(input_dir()) as it:
            return [e for e in it if e.is_file()]
    except OSError:
        return []


def sweep_job(jid):
    """Remove everything this job staged, whoever staged it.

    Called from `plan_cli.main`'s `finally`, so it runs on success, on error
    and on cancel alike — a retried attempt re-stages from the store, so
    dropping the copy is right there too.

    Returns (files, bytes) for the log line; never raises into the job loop.
    """
    jid = str(jid or "")
    if len(jid) < MIN_ID:
        return (0, 0)
    n = size = 0
    for e in _entries():
        if jid not in e.name:
            continue
        try:
            b = e.stat().st_size
        except OSError:
            b = 0
        if unstage(e.name):
            n += 1
            size += b
    return (n, size)


def sweep_stale(hours=None):
    """Remove staged inputs older than `hours` — crash residue.

    A runner killed between staging and its `finally` (an OOM, a quit, the
    machine going to sleep) leaves its copies behind for good, so the
    job-boundary sweep alone cannot converge. Age-gated because ComfyUI may
    still be executing a prompt staged by the process that just died, and
    limited to names carrying a job id so it can never take a file the runner
    did not put there.
    """
    cutoff = time.time() - float(TTL_HOURS if hours is None else hours) * 3600
    n = size = 0
    for e in _entries():
        if not JOB_ID_RE.search(e.name):
            continue
        try:
            st = e.stat()
        except OSError:
            continue
        if st.st_mtime >= cutoff:
            continue
        if unstage(e.name):
            n += 1
            size += st.st_size
    return (n, size)

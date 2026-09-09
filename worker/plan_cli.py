"""Run ONE job on THIS MACHINE. The app's only entry into the pipeline.

WHY IT IS A SEPARATE PROCESS AND NOT A PORT. The studio's pipeline is Python —
`plan_storyboard` alone is ~3,000 lines of `storyplan.py` plus its
orchestration, and the block pipeline behind it is larger still — and a
TypeScript reimplementation would be a twin of the most rule-dense modules in
this repo, which this codebase has enough of to know how they end. The
dependencies do not stand in the way either: `storyplan.py` imports `json`,
`math` and `re`, `llm.py` needs `requests`, `sb` and `status`, and `media`
reaches for nothing until something actually asks for a bucket. The app
already installs a private CPython for ComfyUI, so the same source runs on it
unchanged.

THE THREE THINGS THE APP ARRANGES BEFORE SPAWNING IT (`src-tauri/planner.rs`):

  PLANE       A project's rows are a JSON file the webview owns, so
              `SUPABASE_URL` points at a loopback PostgREST proxy the app
              itself answers (`dbproxy.rs` + `localRest.ts`) and the bearer is
              a random token good for that one run and that one project.
              `QAMBA_MEDIA_ROOT` names the project's media folder, which turns
              every `media.b2_put`/`b2_get` into a file operation. Neither
              `sb` nor `media` knows the difference — which is the whole
              reason this was affordable. Nothing here reaches a network
              except the provider a job was told to call.
  LANES       `payload.lanes` routes the jobs a plan emits. There is one queue
              in this build and `sb.insert` corrects onto it, so the defaults
              in `llm.LANE_DEFAULTS` are moot rather than wrong.
  KEYS        Provider keys arrive in the ENVIRONMENT, put there by the Rust
              side from the OS keychain — `llm._key`, `dialogue_synth` and
              `genmedia` all read `os.environ` first, so nothing in the
              pipeline changes. Only the providers the caller named, and only
              the ones a pipeline job can spend. They are visible to `ps` for
              this user, on this user's own machine, which is the same
              exposure every CLI tool with an API key has; the alternative is
              the webview holding them, which is the one thing `secrets.rs` is
              built to prevent.
"""
import json
import os
import sys


#: Which `llm_task` payloads the desktop may run.
#:
#: DELIBERATELY A LIST rather than "anything `llm` exposes". `payload` is a row
#: this process's own user can write, so the task name is attacker-adjacent in
#: the narrow sense that matters: an unchecked lookup would reach any callable
#: in a module that holds credentials.
TASKS = {
    "plan_storyboard",   # the staged studio
    "revise_block",      # a retake's brief, rewriting the beats
    "enhance_prompt",    # the composer's rewrite
    # A subset of what plan_storyboard already queues here: it composes panel
    # specs and inserts image_gen rows, both of which a tier-1 plan does on
    # this machine today. No new capability, so no new requirement.
    "redraw_panels",
    "lore_update",
    "extract_lore",
    # "LOOK AT WHAT YOU JUST RENDERED" — `llm.vlm_query`, behind the director's
    # `inspect_take`. ffmpeg samples the frames and the local Ollama answers,
    # so it needs nothing this machine does not already have for a render, and
    # it is the one tool in the whole studio that reports what CAME OUT rather
    # than what was asked for. `TASK_NEEDS` below carries the ffmpeg
    # requirement, which the KIND (`llm_task`) does not.
    "vlm_query",
}

#: What a TASK needs beyond its kind. `llm_task` is `None` in `KINDS` because
#: almost every task is one HTTPS call; `vlm_query` is the exception, and
#: without this it would be claimed on a machine with no ffmpeg and die inside
#: `subprocess` after the clip had already been fetched.
TASK_NEEDS = {
    "vlm_query": "ffmpeg",
}

#: Job kinds this build can execute here, and WHAT EACH ONE NEEDS beyond the
#: Python itself. The value is shown to the user, so it says the requirement
#: rather than naming a module.
#:
#: WHAT IS ABSENT IS AS DELIBERATE AS WHAT IS PRESENT.
#:  * `clip_gen` is absent because the local worker already runs it in
#:    TypeScript (`localRender.graphForJob`) against the desktop's own recipe
#:    table. A second implementation of one kind is two places for it to be
#:    wrong.
#:  * `take_review`, `visual_review_batch` and `sequence_review` are absent
#:    because THE AUTOMATIC QA REVIEWER IS NOT PART OF THIS BUILD. It wanted
#:    faster-whisper for word-level ASR and a resident 18GB vision model to
#:    judge every take, and nothing queues one any more — see the note in
#:    `handlers/blocks.py` where those jobs used to be written. What survived
#:    is the half that answers a question you asked: `vlm_query`, in TASKS.
#:  * Everything else that drives ComfyUI is here BECAUSE the desktop now has
#:    a model map of its own — see `model_map.desktop.json`, generated from
#:    the pod's and pruned to what the engine window can actually download.
#:    Before it, `resolve.py` would have parameterised pod templates by pod
#:    filenames and the job would have died inside ComfyUI on an enum.
KINDS = {
    "llm_task": None,
    # One call to an embeddings endpoint on the user's own key — no GPU, no
    # ComfyUI, nothing to shell out to. The cloud build drained this queue from
    # a serverless function; here the desktop's own worker claims it like
    # anything else.
    "embed": None,
    "launch_render": None,
    "tts": "ffprobe",
    "voice_clone": None,
    "asset_ingest": "ffprobe",
    "sheet_compose": "pillow",
    "audio_slice": "ffmpeg",
    "assemble_take": "ffmpeg",
    "assemble_cut": "ffmpeg",
    "patch_splice": "ffmpeg",
    "clip_render": "ffmpeg",
    "tl_render": "ffmpeg",
    "frame_extract": "ffmpeg",
    "block_from_clip": "ffmpeg",
    # ── the ones that drive ComfyUI ──────────────────────────────────────
    # A REFERENCE SHEET IS NOT ONE PICTURE, WHICH IS WHY THIS IS HERE AND
    # `clip_gen` IS NOT. `localRender` renders a prompt; `handlers/images.py`
    # composes one (`image_prompt` picks the dialect off the family that is
    # FINALLY chosen, which the reference fallback can still change), resolves
    # the late-bound `anchors` a plan's own sheets hang on — a body sheet is
    # composed over the face plate that has not rendered yet when the job is
    # written — and then attaches the result to a bible role. None of that has
    # a TypeScript twin, and writing one would be the drift this file keeps
    # naming: a sheet that renders perfectly well and is not the sheet the pod
    # would have drawn, after which a character's identity anchor depends on
    # which machine drew it.
    #
    # A `local:` id still goes to the TypeScript runner — that id space is
    # `engineCatalog`'s and `resolve.py` has never heard of one. `localWorker`
    # makes that split, and it is the same one it already makes for the music
    # kinds below.
    # "comfy" rather than "render": it drives ComfyUI and needs the model map,
    # and it is the one graph-driving kind that never shells out to ffmpeg —
    # `handlers/images` is b2_get, a graph, b2_put. Demanding ffmpeg would be
    # a false refusal on a machine that could draw the sheet.
    "image_gen": "comfy",
    "master_pass": "render",
    "patch_flf": "render",
    "music_gen": "render",
    "sfx_gen": "render",
    # Video -> audio. Needs ffmpeg as well as ComfyUI (`media.replace_audio`
    # muxes the new track onto the take with `-c:v copy`), which "render"
    # already demands, and the two node packs `install_engine` adds.
    "v2a_gen": "render",
    # A whole reference SHEET as one H3 take — the coverage/turnaround shape.
    # "comfy" rather than "render" for `image_gen`'s reason: it is b2_get, a
    # graph, b2_put, and the one ffprobe it can reach (the `orbit` shape's
    # voice sample) is guarded rather than demanded, because requiring ffmpeg
    # would be a false refusal on a machine that could draw the sheet.
    #
    # It resolves a VIDEO key (`minimax-h3-pdd` by default, whose r2v mode is
    # what a coverage take conditions on), so `renderableHere` is asked about
    # the video map rather than the image one before anything routes here.
    "orbit_sheet": "comfy",
}

#: Of those, the ones that submit a graph to ComfyUI. The caller pings the
#: engine before claiming one; `preflight` refuses when there is no desktop
#: model map to resolve against.
RENDER_KINDS = {k for k, need in KINDS.items() if need in ("render", "comfy")}

#: The kinds that WRITE a file somewhere the rest of the app can read it.
#:
#: Every one of them ends in `media.b2_put`, and that is the step where a
#: laptop and the pod genuinely differ: a local project writes to its own
#: folder, a cloud project presigns through the studio's route with the
#: session, and a process with neither has nowhere to put the render. Checked
#: UP FRONT because the alternative is discovering it after the sampling.
MEDIA_KINDS = set(KINDS) - {"llm_task", "embed", "launch_render", "voice_clone"}

def _fail(msg, code=2):
    # stdout is the RESULT channel and stderr is the log — the caller parses
    # one and shows the other, so a diagnostic on stdout would be read as a
    # result and a result on stderr would be lost.
    print(json.dumps({"ok": False, "error": msg}))
    sys.stderr.write(msg + "\n")
    raise SystemExit(code)


def _have(mod):
    try:
        __import__(mod)
        return True
    except ImportError:
        return False


def _have_binary(name):
    from shutil import which
    return which(name) is not None


def preflight(kind="llm_task", have=_have, have_binary=_have_binary, task=None):
    """What is missing, in words, before anything expensive is attempted.

    A plan is minutes of model time and a render is more; discovering halfway
    through that `requests` is absent from the engine's Python wastes all of
    it and reports as an import traceback nobody can act on.

    `have`/`have_binary` are injected so the ENVIRONMENT half of this is
    testable off a machine that has the dependencies — the alternative is a
    test that patches `builtins.__import__`, which fights every other import
    in the process.
    """
    # `requests` AND NOTHING ELSE for the Python half — verified by importing
    # `llm` on a venv with no aiohttp, no boto3 and no torch. `comfy.py`
    # imports aiohttp inside the sampler-preview websocket tap, which none of
    # these kinds reaches, and `media` builds its bucket client on first use.
    # Requiring more here is a false refusal on a Python that could have run
    # the job.
    if not have("requests"):
        return ("the engine's Python is missing requests — "
                "reinstall the local engine, which installs it")
    need = KINDS.get(kind)
    # A task can need more than its kind — see TASK_NEEDS.
    if kind == "llm_task" and task in TASK_NEEDS:
        need = TASK_NEEDS[task]
    # A render needs ffmpeg TOO — it trims the warmup off every take — so the
    # ffmpeg check runs for both and the render check adds to it.
    # THE FIX IS IN THE APP NOW, so the message names it rather than a
    # terminal: the engine window's "Utilities only" fetches a static ffmpeg
    # into the app's own folder. It is also worth knowing that this check
    # failing does NOT mean the machine has no ffmpeg — a GUI-launched macOS
    # app inherits the launchd PATH, which has no `/opt/homebrew/bin`, so a
    # working Homebrew install was invisible here until `engine::child_path`
    # put those directories back.
    _GET_FFMPEG = ("open the engine window and take Utilities only, "
                   "or install ffmpeg yourself and restart the app")
    if need in ("ffmpeg", "render") and not (have_binary("ffmpeg") and have_binary("ffprobe")):
        return f"this needs ffmpeg — {_GET_FFMPEG}"
    if need == "ffprobe" and not have_binary("ffprobe"):
        return f"this needs ffprobe, which comes with ffmpeg — {_GET_FFMPEG}"
    # A segment storyboard is laid out with Pillow. The FULL engine install
    # carries it (ComfyUI's own requirement); the Planning-only install is
    # requests and nothing else, so the kind is refused there by name rather
    # than dying on an ImportError after the panels were fetched.
    if need == "pillow" and not have("PIL"):
        return ("this needs Pillow — install the full local engine (Planning "
                "only does not carry it)")
    if need in ("render", "comfy"):
        # THE MAP IS THE WHOLE DIFFERENCE between resolving a graph against
        # files this machine has and one against filenames nobody here has
        # ever had. Without it `resolve.py` falls back to its packaged
        # defaults and the job dies deep inside ComfyUI naming a checkpoint
        # that does not exist.
        if os.environ.get("MODEL_TIER") != "desktop" or not os.environ.get("MODEL_MAP"):
            return ("this build carries no model map, so it cannot resolve a "
                    "render — reinstall the app")
        if not os.path.exists(os.environ["MODEL_MAP"]):
            return f"the model map is missing: {os.environ['MODEL_MAP']}"
    if kind in MEDIA_KINDS:
        import media
        if media.store_mode() == "none":
            return ("this job has nowhere to put its result — it was started "
                    "without a project media folder")
    # The app sets all three when it spawns this (`planner.rs`): the loopback
    # address, and the per-run token that admits this process to exactly one
    # project. Run by hand with none of them, say so rather than failing on
    # the first query with a connection error.
    if not os.environ.get("SUPABASE_URL"):
        return "SUPABASE_URL is not set for this process"
    if not (os.environ.get("SUPABASE_ACCESS_TOKEN") and os.environ.get("SUPABASE_ANON_KEY")):
        return "this process was started without a session token"
    return None


def _dispatch(job):
    """The handler for this job, or a refusal naming the kind.

    `handlers.resolve_handler` is the pipeline's own dispatch table, reused
    rather than copied: a second mapping of kind -> handler is a second place
    for a new kind to be forgotten. The allow-list above is what keeps this
    narrow.
    """
    kind = job.get("kind") or "llm_task"
    if kind not in KINDS:
        # BY NAME, never silently. A kind that is not here is either one the
        # app's own TypeScript runner claims (`clip_gen`, `byok_gen`) or one
        # this build does not carry at all — and a job that simply never moves
        # is the failure mode this whole allow-list exists to avoid.
        return None, (f"'{kind}' is not a kind this build's pipeline runs — see "
                      "plan_cli.KINDS for what does")
    if kind == "llm_task":
        task = (job.get("payload") or {}).get("task") or "plan_storyboard"
        # CHECKED BEFORE THE LOOKUP, not after.
        if task not in TASKS:
            return None, f"'{task}' is not a task this build can run on the desktop"

    import handlers
    fn = handlers.resolve_handler(job)
    if fn is None:
        return None, f"this build's worker has no handler for '{kind}'"
    return fn, None


def main(argv):
    if len(argv) < 2:
        _fail("usage: plan_cli.py <job.json | ->")

    raw = sys.stdin.read() if argv[1] == "-" else open(argv[1], encoding="utf-8").read()
    try:
        job = json.loads(raw)
    except ValueError as e:
        _fail(f"the job payload is not JSON: {e}")
    if not job.get("id"):
        _fail("the job has no id — progress and cancellation both key on it")

    why = preflight(job.get("kind") or "llm_task",
                    task=(job.get("payload") or {}).get("task"))
    if why:
        _fail(why)

    # Imported AFTER preflight so a missing dependency is the message above
    # rather than a traceback, and after the env is read so `sb` picks up the
    # session credential it was started with.
    import sb
    from status import log

    fn, refusal = _dispatch(job)
    if refusal:
        _fail(refusal)

    jid = job["id"]
    log(f"desktop job {jid} kind={job.get('kind')} "
        f"plane={'local' if os.environ.get('QAMBA_MEDIA_ROOT') else 'cloud'}")

    # CRASH RESIDUE, before the job rather than after it. The `finally` below
    # covers this process; nothing covers the one that was killed between
    # staging a file and reaching it (a quit, an OOM, the machine sleeping),
    # so without this the leak never converges. One job per process here, so
    # this is one age-gated `scandir` per render.
    try:
        import staging
        n, size = staging.sweep_stale()
        if n:
            log(f"swept {n} stale staged input(s), {size // 1024}KB")
    except Exception:  # noqa: BLE001 — housekeeping never fails a job
        pass

    try:
        if sb.cancel_requested(jid):
            sb.job_canceled(jid, "canceled before start")
            return 0
        fn(job)
    except Exception as e:  # noqa: BLE001 — the message is the product here
        # A READABLE `error_msg`, and the dependents taken down so the DAG
        # cannot deadlock on a dead dependency. Every queue surface in the app
        # is written against those rows, and doing less here would leave one
        # failure stranding every job queued behind it.
        import llm
        try:
            msg = llm.explain_error(e)
        except Exception:  # noqa: BLE001
            msg = str(e)
        try:
            sb.job_patch(jid, {"status": "error", "error_msg": msg[:400]})
            sb.fail_dependents(jid)
        except Exception as e2:  # noqa: BLE001
            sys.stderr.write(f"could not record the failure: {e2}\n")
        print(json.dumps({"ok": False, "error": msg[:400]}))
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        return 1
    finally:
        # Every source a graph reads is copied into ComfyUI's `input/` first.
        # Runs on error and cancel too — the same reason it is a `finally`
        # here rather than something each of a dozen stagers remembers.
        try:
            import staging
            staging.sweep_job(jid)
        except Exception:  # noqa: BLE001 — housekeeping never fails a job
            pass

    print(json.dumps({"ok": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

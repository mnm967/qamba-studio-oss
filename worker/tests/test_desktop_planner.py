"""The pipeline running on the machine that asked for it.

Two things make that possible and both are silent when wrong: a credential
that quietly reached for something wider than the per-run token would be a
bypass waiting to be configured into an installer, and a lane that quietly
keeps a name nothing claims queues work that never moves — which looks exactly
like a plan that worked and then stalled forever.
"""
import importlib
import json
import os

import pytest


def reload_sb(monkeypatch, **env):
    for k in ("SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY", "SUPABASE_ACCESS_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SUPABASE_URL", "http://127.0.0.1:54321")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import sb
    return importlib.reload(sb)


def test_the_per_run_token_goes_in_the_bearer_slot(monkeypatch):
    # PostgREST needs BOTH headers and they mean different things: `apikey`
    # admits the request, `Authorization` decides who is asking — which here is
    # `dbproxy`'s question, since the token is what maps this process to ONE
    # project. Swap them and every request is a 401 from the loopback proxy.
    sb = reload_sb(monkeypatch, SUPABASE_ANON_KEY="local", SUPABASE_ACCESS_TOKEN="tok")
    assert sb.HEADERS["apikey"] == "local"
    assert sb.HEADERS["Authorization"] == "Bearer tok"


def test_an_inherited_service_key_is_not_a_credential_here(monkeypatch):
    """THE PATH IS GONE, not merely outranked.

    A developer's shell exports `SUPABASE_SERVICE_KEY`; the cloud build would
    have picked one up and run unscoped against a real project, and nothing
    about the result would have looked different. There is nothing in this
    build for such a key to mean, so it is neither read nor accepted — which
    is also what stops one being configured into an installer.
    """
    with pytest.raises(RuntimeError):
        reload_sb(monkeypatch, SUPABASE_SERVICE_KEY="svc")
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "sb.py"), encoding="utf-8").read()
    code = "\n".join(l for l in src.split("\n") if not l.lstrip().startswith("#"))
    body = code.split('"""', 2)[-1]          # past the module docstring
    assert "SUPABASE_SERVICE_KEY" not in body, "sb still reads a service key"


def test_a_missing_pair_is_a_named_refusal_not_a_keyerror(monkeypatch):
    with pytest.raises(RuntimeError) as e:
        reload_sb(monkeypatch)
    assert "SUPABASE_ANON_KEY" in str(e.value)
    assert "SUPABASE_ACCESS_TOKEN" in str(e.value)


def test_half_a_session_is_not_a_session(monkeypatch):
    # A token with no apikey cannot reach PostgREST at all, so it must not be
    # accepted and then fail later with a confusing 401.
    with pytest.raises(RuntimeError):
        reload_sb(monkeypatch, SUPABASE_ACCESS_TOKEN="tok")


@pytest.fixture(autouse=True)
def restore_sb():
    yield
    # Leave sb as the rest of the suite expects — see tests/conftest.py.
    os.environ.setdefault("SUPABASE_ANON_KEY", "local")
    os.environ.setdefault("SUPABASE_ACCESS_TOKEN", "test-token")
    os.environ.pop("SUPABASE_SERVICE_KEY", None)
    import sb
    importlib.reload(sb)


# ── the lanes a plan emits ───────────────────────────────────────────────────

def test_no_lanes_in_the_payload_is_byte_identical_to_the_old_behaviour():
    import llm
    for kind, lane in [("image_gen", "gpu"), ("tts", "cpu"),
                       ("music_gen", "gpu"), ("launch_render", "cpu")]:
        assert llm.job_lane({}, kind) == lane
        assert llm.job_lane(None, kind) == lane
        assert llm.job_lane({"lanes": {}}, kind) == lane


def test_a_caller_routes_ONE_kind_without_moving_the_others():
    # PER KIND on purpose. A machine that renders its own sheets still cannot
    # synthesize an ElevenLabs voice reference or run `launch_render`, so a
    # single "everything local" flag would be a promise three of the four kinds
    # cannot keep — and the jobs would sit queued with nothing to claim them.
    import llm
    p = {"lanes": {"image_gen": "local"}}
    assert llm.job_lane(p, "image_gen") == "local"
    assert llm.job_lane(p, "tts") == "cpu"
    assert llm.job_lane(p, "launch_render") == "cpu"


def test_every_kind_the_planner_queues_has_a_default():
    # A KeyError here would raise mid-plan, after the model time is spent.
    import llm
    import re
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "llm.py"), encoding="utf-8").read()
    used = set(re.findall(r'job_lane\(payload, "([a-z_]+)"\)', src))
    assert used, "the scanner found no lane sites — it is broken"
    assert used <= set(llm.LANE_DEFAULTS), f"no default for {used - set(llm.LANE_DEFAULTS)}"


def test_no_lane_is_hardcoded_in_the_jobs_the_planner_inserts():
    import re
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "llm.py")
    src = open(path, encoding="utf-8").read()
    stray = re.findall(r'"kind": "(\w+)", "status": "queued", "lane": "(\w+)"', src)
    assert stray == [], f"still pinned to a pod lane: {stray}"


# ── the desktop entry point ──────────────────────────────────────────────────

def test_the_cli_only_runs_tasks_on_its_allow_list():
    # `payload.task` comes off a row this process's own user can write, so an
    # unchecked lookup would reach any callable in a module that holds
    # credentials.
    import plan_cli
    assert "plan_storyboard" in plan_cli.TASKS
    assert "chat" not in plan_cli.TASKS, "the director chat runs in the browser"
    # `vlm_query` IS here, and it is the one task with a requirement of its
    # own. It is not the automatic judge — that wanted faster-whisper and a
    # resident vision model and is not part of this build — it is "look at what
    # you just rendered": ffmpeg samples the frames and the local Ollama
    # answers. `TASK_NEEDS` carries the ffmpeg half, which the KIND does not.
    assert plan_cli.TASK_NEEDS["vlm_query"] == "ffmpeg"
    assert plan_cli.preflight("llm_task", have_binary=lambda b: False,
                              task="vlm_query"), "an absent ffmpeg must refuse it"
    # CODE ONLY. The comments around the check quote the mechanism to explain
    # why the order matters, so a raw substring search finds the prose first
    # and reports the correct order as wrong.
    src = "\n".join(
        l for l in open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                     "plan_cli.py"), encoding="utf-8").read().split("\n")
        if not l.lstrip().startswith("#"))
    assert src.index("task not in TASKS") < src.index("resolve_handler(job)"), \
        "the allow-list must be checked BEFORE the dispatch"
    assert src.index("kind not in KINDS") < src.index("resolve_handler(job)"), \
        "the kind allow-list must be checked BEFORE the dispatch"


def test_a_kind_this_build_cannot_run_is_refused_by_name():
    # Not silently. `clip_gen` and `byok_gen` are absent because the app's own
    # TypeScript runner already claims them — a second implementation of one
    # kind is two places for it to be wrong — and the review kinds because the
    # automatic QA reviewer is not part of this build at all.
    import plan_cli
    for kind in ("clip_gen", "byok_gen", "take_review", "sequence_review",
                 "api_generate"):
        assert kind not in plan_cli.KINDS
        fn, why = plan_cli._dispatch({"id": "j", "kind": kind})
        assert fn is None and kind in why and "plan_cli.KINDS" in why


def test_a_sheet_is_claimed_here_because_a_sheet_is_not_one_picture():
    """`image_gen` is the one graph-driving kind the TypeScript runner does NOT
    keep, and the reason is what a sheet is: `handlers/images` composes the
    prompt for the family finally chosen and resolves the late-bound `anchors`
    a plan's own sheets hang on (a body sheet composes over a face plate that
    has not rendered when the job is written). `localRender` renders a prompt
    and has neither, so a sheet drawn there is not the sheet the pod would
    have drawn — after which a character's identity anchor depends on which
    machine drew it."""
    import plan_cli
    assert plan_cli.KINDS["image_gen"] == "comfy"
    assert "image_gen" in plan_cli.RENDER_KINDS
    # "comfy" and not "render": it is the one that never shells out —
    # `handlers/images` is b2_get, a graph, b2_put — so demanding ffmpeg would
    # refuse a machine that could draw the sheet.
    kw = dict(have=lambda _m: True, have_binary=lambda _b: False)
    assert plan_cli.preflight("master_pass", **kw)
    assert "ffmpeg" not in (plan_cli.preflight("image_gen", **kw) or "")


def test_a_coverage_sheet_is_a_python_kind_and_needs_no_ffmpeg():
    """A whole reference sheet as ONE H3 take — every view of a character or a
    location from one pass, which `image_gen` structurally cannot do: four
    independent renders of a location come back as four crops of one frontal
    view, and a six-view turnaround grid is a composition the image models
    refuse.

    "comfy" for `image_gen`'s reason — b2_get, a graph, b2_put. The one
    ffprobe it can reach is the `orbit` shape's voice sample, and that is
    GUARDED (`handlers.orbit._probe_ms`) rather than demanded: it runs after
    the take has been sampled, so an unguarded probe would fail a render that
    had already succeeded, over a number `asset_ingest` fills in anyway.
    """
    import plan_cli
    assert plan_cli.KINDS["orbit_sheet"] == "comfy"
    assert "orbit_sheet" in plan_cli.RENDER_KINDS
    kw = dict(have=lambda _m: True, have_binary=lambda _b: False)
    assert "ffmpeg" not in (plan_cli.preflight("orbit_sheet", **kw) or "")


def test_the_render_kinds_are_gated_on_a_desktop_model_map(monkeypatch, tmp_path):
    """THE MAP IS THE WHOLE DIFFERENCE between resolving a graph against files
    this machine has and one against the pod's. Without it `resolve.py` falls
    back to its kaggle-era defaults and the job dies deep inside ComfyUI naming
    a checkpoint nobody here has ever had."""
    import plan_cli
    assert plan_cli.RENDER_KINDS == {"master_pass", "patch_flf", "music_gen",
                                     "sfx_gen", "v2a_gen", "image_gen",
                                     "orbit_sheet"}
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon")
    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", "tok")
    monkeypatch.setenv("QAMBA_MEDIA_ROOT", str(tmp_path))
    kw = dict(have=lambda _m: True, have_binary=lambda _b: True)

    monkeypatch.delenv("MODEL_TIER", raising=False)
    why = plan_cli.preflight("master_pass", **kw)
    assert why and "model map" in why

    monkeypatch.setenv("MODEL_TIER", "desktop")
    monkeypatch.setenv("MODEL_MAP", "/nope/model_map.desktop.json")
    why = plan_cli.preflight("master_pass", **kw)
    assert why and "missing" in why

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    real = os.path.join(os.path.dirname(here), "infra", "model_map.desktop.json")
    monkeypatch.setenv("MODEL_MAP", real)
    assert plan_cli.preflight("master_pass", **kw) is None
    # The map gate covers the sheet kind too — it resolves against the very
    # same table, through the very same `resolve.py`.
    assert plan_cli.preflight("image_gen", **kw) is None
    monkeypatch.setenv("MODEL_MAP", "/nope/model_map.desktop.json")
    assert "missing" in (plan_cli.preflight("image_gen", **kw) or "")
    monkeypatch.setenv("MODEL_MAP", real)
    # ...and a render needs ffmpeg too: it trims the warmup off every take.
    assert plan_cli.preflight("master_pass", have=lambda _m: True,
                              have_binary=lambda _b: False)


def test_the_kinds_it_does_claim_all_resolve_to_a_real_handler():
    # A kind on the allow-list that `handlers.resolve_handler` answers None for
    # is a job the desktop takes and then cannot run — worse than not claiming
    # it, because the pod would have.
    import handlers
    import plan_cli
    for kind in plan_cli.KINDS:
        assert handlers.resolve_handler({"kind": kind}) is not None, kind


def test_preflight_names_what_is_missing_rather_than_raising(monkeypatch):
    """A plan is minutes of model time; discovering the environment is wrong
    halfway through wastes all of it and reports as a traceback."""
    import plan_cli
    # The DEPENDENCY check comes first and this test venv genuinely has no
    # aiohttp — which is the check working. Injecting the probe is what makes
    # the ENVIRONMENT half reachable here.
    def env_only():
        return plan_cli.preflight("llm_task", have=lambda _m: True)

    monkeypatch.delenv("SUPABASE_URL", raising=False)
    why = env_only()
    assert why and "SUPABASE_URL" in why

    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.delenv("SUPABASE_ACCESS_TOKEN", raising=False)
    why = env_only()
    assert why and "session token" in why

    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", "tok")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon")
    assert env_only() is None


def test_preflight_reports_a_missing_dependency_before_anything_expensive():
    import plan_cli
    why = plan_cli.preflight("llm_task", have=lambda _m: False)
    assert why and "requests" in why
    assert "reinstall the local engine" in why


def test_the_planner_needs_ONLY_requests(monkeypatch):
    """Measured, not assumed: `import llm` succeeds on a venv with no aiohttp,
    no boto3 and no torch — this repo's own worker venv.

    It matters because preflight REFUSES on a missing dependency, and a
    dependency the planner does not actually use is a plan refused on a Python
    that could have run it. `comfy.py` imports aiohttp inside the
    sampler-preview websocket tap, which a plan never reaches.
    """
    import plan_cli
    seen = []

    def probe(m):
        seen.append(m)
        return True
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon")
    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", "tok")
    assert plan_cli.preflight("llm_task", have=probe) is None
    assert seen == ["requests"], f"preflight also demands {seen[1:]}"


def test_a_kind_that_shells_out_to_ffmpeg_checks_for_it_first(monkeypatch, tmp_path):
    """The engine installer does not put an ffmpeg on the machine, so a cut
    render on a laptop without one dies inside `subprocess` with
    `FileNotFoundError: 'ffmpeg'` — after the job has been claimed, the block
    marked generating, and (for an assemble) every take already fetched."""
    import plan_cli
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon")
    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", "tok")
    # A render has to have somewhere to PUT the result; that check is a
    # different one and has its own case.
    monkeypatch.setenv("QAMBA_MEDIA_ROOT", str(tmp_path))
    kw = dict(have=lambda _m: True, have_binary=lambda _b: False)
    why = plan_cli.preflight("tl_render", **kw)
    assert why and "ffmpeg" in why
    # ...and a kind that needs no binary is unaffected by its absence.
    assert plan_cli.preflight("llm_task", **kw) is None
    assert plan_cli.preflight("tl_render", have=lambda _m: True,
                              have_binary=lambda _b: True) is None


# ── what the desktop build has to carry ──────────────────────────────────────

#: Modules the runner's import graph reaches that are NOT bundled.
#:
#: EMPTY, and that is the point: with `media` no longer building a bucket
#: client at import, the whole worker tree is importable on a Python that has
#: only `requests` — so the desktop ships all of it rather than a subset that
#: has to be kept in step with which handler runs where. Listed rather than
#: deleted because leaving something out has to stay a decision someone wrote
#: down, the same rule `ownership.test.ts`'s SHARED follows.
UNBUNDLED: set = set()

#: Third-party modules the bundled tree may import AT MODULE LEVEL.
#:
#: This is the property that makes shipping everything safe, and it is the one
#: that regresses silently: a module-level `import boto3` or `import torch`
#: anywhere in this closure makes `import handlers` — and therefore every
#: desktop job — fail with a traceback naming a package the engine's Python
#: has never had. Function-level imports are fine and deliberate; they fail
#: only where the pod-only feature is actually used.
MODULE_LEVEL_THIRD_PARTY = {"requests"}


def _closure(root, entry):
    """Every worker module `entry` can reach, at any nesting level.

    A PACKAGE contributes every file in it, not just its `__init__`: the whole
    reason `handlers` is reachable is `resolve_handler`'s lazy imports, which
    live in the modules beside it.
    """
    import ast, collections, os
    local = {f[:-3] for f in os.listdir(root) if f.endswith(".py")}
    local |= {d for d in os.listdir(root)
              if os.path.isdir(os.path.join(root, d))
              and os.path.exists(os.path.join(root, d, "__init__.py"))}

    def files_of(mod):
        path = os.path.join(root, mod + ".py")
        if os.path.exists(path):
            return [path]
        d = os.path.join(root, mod)
        if os.path.isdir(d):
            return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".py")]
        return []

    def imports_of(mod):
        out = set()
        for path in files_of(mod):
            for n in ast.walk(ast.parse(open(path, encoding="utf-8").read())):
                if isinstance(n, ast.Import):
                    out |= {a.name.split(".")[0] for a in n.names}
                elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
                    out.add(n.module.split(".")[0])
        return out

    seen, q = set(), collections.deque([entry])
    while q:
        m = q.popleft()
        if m in seen:
            continue
        seen.add(m)
        q.extend(i for i in imports_of(m) if i in local)
    return seen


def test_the_desktop_bundle_carries_every_module_the_runner_can_reach():
    """A module the runner imports and the installer does not ship is an
    ImportError minutes into a job — or, worse, inside one of the `try:`
    blocks, a feature that silently never runs on the desktop and does on the
    pod.
    """
    import json
    import os
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    repo = os.path.dirname(here)
    reached = _closure(here, "plan_cli")
    assert {"llm", "storyplan", "handlers", "media"} <= reached, reached

    conf = json.load(open(os.path.join(repo, "src-tauri", "tauri.conf.json"),
                          encoding="utf-8"))
    globs = conf["bundle"]["resources"]
    # `../worker/*.py` covers a top-level module; `../worker/<pkg>/*.py` a package.
    top = "../worker/*.py" in globs
    pkgs = {g.split("/")[2] for g in globs if g.startswith("../worker/") and g.count("/") == 3}

    missing = []
    for mod in sorted(reached):
        if mod in UNBUNDLED:
            continue
        if os.path.exists(os.path.join(here, mod + ".py")):
            if not top:
                missing.append(mod)
        elif mod not in pkgs:
            missing.append(f"{mod}/ (package)")
    assert missing == [], (
        f"the runner reaches {missing}, which this build does not ship — "
        f"add it to tauri.conf.json's bundle.resources or to UNBUNDLED with a reason")


def test_nothing_shipped_imports_a_heavyweight_dependency_at_MODULE_level():
    """THE PROPERTY THAT MAKES SHIPPING THE WHOLE TREE SAFE.

    The engine's Python has `requests` and nothing else — no boto3, no torch,
    no aiohttp, no faster-whisper. A module-level import of one of those
    anywhere in this closure fails at `import handlers`, before a single job
    runs, and every desktop kind dies with a traceback naming a package the
    user was never asked to install. A FUNCTION-level import of the same thing
    is fine and is what the pod-only paths already use: it fails only where
    that feature is actually reached.

    `media` is the case this was written for. It built a live boto3 S3 client
    at import for its whole life, which made `import handlers.blocks` — the
    entire block pipeline — unreachable on a machine that could have run it.
    """
    import ast, os, sys
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    reached = _closure(here, "plan_cli")
    std = set(sys.stdlib_module_names)
    bad = []
    for mod in sorted(reached):
        path = os.path.join(here, mod + ".py")
        paths = [path] if os.path.exists(path) else [
            os.path.join(here, mod, f) for f in sorted(os.listdir(os.path.join(here, mod)))
            if f.endswith(".py")]
        for p in paths:
            for n in ast.parse(open(p, encoding="utf-8").read()).body:  # TOP LEVEL only
                names = ({a.name.split(".")[0] for a in n.names}
                         if isinstance(n, ast.Import)
                         else {n.module.split(".")[0]}
                         if isinstance(n, ast.ImportFrom) and n.level == 0 and n.module
                         else set())
                for hit in names - reached - std - MODULE_LEVEL_THIRD_PARTY:
                    bad.append(f"{os.path.relpath(p, here)} imports {hit} at module level")
    assert bad == [], "; ".join(sorted(set(bad)))


# ── a local project's child jobs ─────────────────────────────────────────────

def test_a_child_job_is_routed_to_the_one_queue_this_build_claims(monkeypatch):
    """A dozen handlers write `"lane": "cpu"` or `"gpu"` into a follow-up job —
    `tts` queues an `asset_ingest`, `launch_render` a `master_pass` per block.
    Nothing here claims those names, so such a job would sit `queued` forever
    on a screen reporting nothing wrong. Corrected in `sb.insert` because a
    rule repeated a dozen times is one that gets forgotten once.
    """
    sent = {}

    class Resp:
        text = "[]"

        def raise_for_status(self):
            pass

        def json(self):
            return [{"id": "new"}]

    def fake_post(url, headers=None, data=None, timeout=None):
        sent["url"] = url
        sent["body"] = json.loads(data)
        return Resp()

    monkeypatch.setenv("QAMBA_MEDIA_ROOT", "/tmp/whatever")
    sb = reload_sb(monkeypatch, SUPABASE_ANON_KEY="local", SUPABASE_ACCESS_TOKEN="tok")
    assert sb.LANE == "local"
    monkeypatch.setattr(sb.requests, "post", fake_post)

    sb.insert("jobs", {"kind": "asset_ingest", "lane": "cpu", "status": "queued"})
    assert sent["body"]["lane"] == "local"

    sb.insert("jobs", [{"kind": "master_pass", "lane": "gpu"},
                       {"kind": "audio_slice", "lane": "cpu"}])
    assert [r["lane"] for r in sent["body"]] == ["local", "local"]

    # Only the JOBS table. An asset row has no lane and must not grow one.
    sb.insert("assets", {"b2_key": "x", "kind": "audio"})
    assert "lane" not in sent["body"]


def test_the_correction_does_not_depend_on_a_media_folder_being_set(monkeypatch):
    """It used to be gated on `QAMBA_MEDIA_ROOT`, which told a LOCAL project
    from a cloud one. There is no second kind of project here, so gating it
    would only mean a job queued by a process that happened not to be handed a
    media folder went to a lane nothing claims."""

    class Resp:
        text = "[]"

        def raise_for_status(self):
            pass

        def json(self):
            return [{"id": "new"}]

    sent = {}

    def fake_post(url, headers=None, data=None, timeout=None):
        sent["body"] = json.loads(data)
        return Resp()

    monkeypatch.delenv("QAMBA_MEDIA_ROOT", raising=False)
    sb = reload_sb(monkeypatch, SUPABASE_ANON_KEY="local", SUPABASE_ACCESS_TOKEN="tok")
    monkeypatch.setattr(sb.requests, "post", fake_post)
    sb.insert("jobs", {"kind": "asset_ingest", "lane": "cpu"})
    assert sent["body"]["lane"] == "local"


def test_a_kind_that_writes_media_needs_somewhere_to_write(monkeypatch, tmp_path):
    """A render is minutes of model time and the write is its LAST step, so a
    process with no media folder is refused before it starts rather than after
    the sampling. A plan writes no media at all and is unaffected."""
    import plan_cli
    monkeypatch.setenv("SUPABASE_URL", "http://127.0.0.1:54321")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "local")
    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", "tok")
    monkeypatch.delenv("QAMBA_MEDIA_ROOT", raising=False)
    kw = dict(have=lambda _m: True, have_binary=lambda _b: True)

    why = plan_cli.preflight("tts", **kw)
    assert why and "nowhere to put" in why
    assert plan_cli.preflight("llm_task", **kw) is None
    assert plan_cli.preflight("launch_render", **kw) is None

    monkeypatch.setenv("QAMBA_MEDIA_ROOT", str(tmp_path))
    assert plan_cli.preflight("tts", **kw) is None


# ── the pod-only PACKAGES a desktop path must never reach ────────────────────
#
# `MODULE_LEVEL_THIRD_PARTY` above says function-level imports "fail only where
# the pod-only feature is actually used", and that is exactly the assumption
# this pair pins: `tts` IS in `plan_cli.KINDS`, so its OpenAI branch is a
# desktop path, and `from openai import OpenAI` inside `genmedia._openai()`
# made every local voice reference die on `No module named 'openai'` — after a
# one-shot plan had already written its storyboard. A module-level import would
# have failed loudly at `import handlers`; this one failed at render time,
# naming a package nobody had been asked to install.

def _no_openai(monkeypatch):
    """Make `import openai` raise the way it does on the engine's own Python."""
    import sys
    monkeypatch.setitem(sys.modules, "openai", None)


def test_openai_tts_does_not_need_the_openai_package(monkeypatch):
    import json
    import urllib.request

    import genmedia
    _no_openai(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    seen = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"ID3-mp3-bytes"

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["auth"] = req.headers.get("Authorization")
        seen["body"] = json.loads(req.data.decode())
        return _Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    assert genmedia._openai_tts("hello", "nova", "warm") == b"ID3-mp3-bytes"
    # OpenAI's own product endpoint, NOT `OPENAI_BASE_URL` — that one points
    # the chat backend at whichever compatible provider a deployment uses, and
    # most of them serve no /audio/speech at all.
    assert seen["url"] == "https://api.openai.com/v1/audio/speech"
    assert seen["auth"] == "Bearer sk-test"
    assert seen["body"]["voice"] == "nova"
    assert seen["body"]["instructions"] == "warm"
    # An absent delivery note is omitted rather than sent empty.
    genmedia._openai_tts("hello", "nova", None)
    assert "instructions" not in seen["body"]


def test_a_missing_openai_key_names_the_fix_rather_than_raising_KeyError(monkeypatch):
    import genmedia
    _no_openai(monkeypatch)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RuntimeError) as e:
        genmedia._openai_tts("hello", "alloy", None)
    # The SETTING, not the variable: on the desktop this is a key pasted into
    # the engine window, and four other engines would have worked.
    assert "OpenAI key" in str(e.value)
    assert "voice engine" in str(e.value)

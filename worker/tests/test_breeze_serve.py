"""The device shim — the one piece of the desktop Breeze install that is CODE
rather than a download, and the one that decides whether a line takes seconds
or minutes on a Mac.

It runs in the BREEZE venv (its own torch), not this one, so everything below
is stubbed. What is worth pinning is the two things that are silently wrong
when wrong: which device is chosen, and whether the patch is actually seen by
the caller."""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import breeze_serve as BS  # noqa: E402


def _torch(cuda=False, mps=False):
    t = types.ModuleType("torch")
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda)
    t.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: mps) if mps is not None else None)
    return t


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("BREEZE_DEVICE", raising=False)
    for m in ("torch", "breeze_infer", "breeze_infer.runtime", "breeze_infer.api"):
        monkeypatch.delitem(sys.modules, m, raising=False)


def test_cuda_wins_where_there_is_one(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=True, mps=True))
    assert BS._device() == "cuda:0"


def test_mps_is_chosen_where_upstream_would_have_said_cpu(monkeypatch):
    # THE WHOLE REASON THIS FILE EXISTS. Upstream's `resolve_device` knows only
    # cuda and cpu, so on an Apple Silicon Mac a 3B model lands on the CPU —
    # the difference between a line in seconds and a line in minutes, on the
    # machine this desktop build mostly runs on.
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=False, mps=True))
    assert BS._device() == "mps"


def test_cpu_where_there_is_nothing_else(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=False, mps=False))
    assert BS._device() == "cpu"
    # ...and a torch too old to have the attribute at all must not raise.
    t = _torch()
    t.backends = types.SimpleNamespace()
    monkeypatch.setitem(sys.modules, "torch", t)
    assert BS._device() == "cpu"


def test_an_explicit_device_wins_over_the_probe(monkeypatch):
    # A preference, not a law: somebody measuring CPU against MPS should not
    # have to edit code to do it.
    monkeypatch.setenv("BREEZE_DEVICE", "cpu")
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=True, mps=True))
    assert BS._device() == "cpu"


def test_no_torch_at_all_is_cpu_rather_than_a_crash(monkeypatch):
    # The venv is built with torch, so this is defensive — but raising here
    # would replace "the model is slow" with "the server would not start".
    monkeypatch.setitem(sys.modules, "torch", None)
    assert BS._device() == "cpu"


def test_BOTH_bindings_are_patched_and_upstream_main_is_called(monkeypatch):
    """`api.py` did `from ...runtime import resolve_device`, so patching the
    MODULE alone leaves its own binding pointing at the original — the shim
    would run, change nothing, and report success. That is the failure mode
    with no symptom: a Mac quietly on the CPU."""
    monkeypatch.setitem(sys.modules, "torch", _torch(mps=True))

    called = []
    runtime = types.ModuleType("breeze_infer.runtime")
    runtime.resolve_device = lambda explicit=None: explicit or "cpu"
    api = types.ModuleType("breeze_infer.api")
    api.resolve_device = runtime.resolve_device
    api.main = lambda: called.append(("main", api.resolve_device(), runtime.resolve_device()))
    pkg = types.ModuleType("breeze_infer")
    pkg.runtime, pkg.api = runtime, api
    for name, mod in [("breeze_infer", pkg), ("breeze_infer.runtime", runtime),
                      ("breeze_infer.api", api)]:
        monkeypatch.setitem(sys.modules, name, mod)

    BS.main()
    assert called == [("main", "mps", "mps")], \
        "both the module and api's own binding must resolve to the shim's device"


def test_an_explicit_argument_still_reaches_upstream(monkeypatch):
    """Upstream's own signature takes one. A caller that knows better must not
    be overridden by a preference."""
    monkeypatch.setitem(sys.modules, "torch", _torch(mps=True))
    seen = []
    runtime = types.ModuleType("breeze_infer.runtime")
    runtime.resolve_device = lambda explicit=None: seen.append(explicit) or f"orig:{explicit}"
    api = types.ModuleType("breeze_infer.api")
    api.main = lambda: None
    pkg = types.ModuleType("breeze_infer")
    pkg.runtime, pkg.api = runtime, api
    for name, mod in [("breeze_infer", pkg), ("breeze_infer.runtime", runtime),
                      ("breeze_infer.api", api)]:
        monkeypatch.setitem(sys.modules, name, mod)

    BS.main()
    assert runtime.resolve_device("cuda:3") == "orig:cuda:3"
    assert runtime.resolve_device() == "mps"


def test_it_is_outside_the_pipeline_s_import_closure():
    """It runs in a DIFFERENT interpreter with a different torch, so the
    bundle's own closure test neither reaches it nor should — but it is still
    shipped by `../worker/*.py`, which is what makes `start_breeze` able to
    name it."""
    import ast
    src = open(BS.__file__, encoding="utf-8").read()
    top = [n for n in ast.parse(src).body if isinstance(n, (ast.Import, ast.ImportFrom))]
    names = {a.name.split(".")[0] for n in top if isinstance(n, ast.Import) for a in n.names}
    assert names <= {"os", "sys"}, f"module-level imports must be stdlib only: {names}"

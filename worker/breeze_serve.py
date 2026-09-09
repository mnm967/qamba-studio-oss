"""Serve Breeze TTS 2, on whatever accelerator this machine actually has.

WHY THIS EXISTS AT ALL. Upstream's `breeze_infer.runtime.resolve_device` is

    if torch.cuda.is_available(): return f"cuda:{local_rank}"
    return "cpu"

— no MPS branch. On an Apple Silicon Mac that lands a 3B model on the CPU,
which is the difference between a line in seconds and a line in minutes, on
the machine this desktop build mostly runs on. The model itself is fine there:
`models/breeze.py` already special-cases `mps` in its autocast, so the gap is
the resolver rather than the runtime.

A SHIM RATHER THAN A PATCH, and that is the whole point of the file. The pod
patches ComfyUI in place (the engine window's H3 single-frame patch) because there is no
seam; here there is one, so the pinned checkout is never edited. An upstream
bump then cannot fight a patch, a re-install cannot half-apply one, and what we
changed is a file in OUR tree that says why.

DELIBERATELY OUTSIDE `plan_cli`'s IMPORT CLOSURE. It runs as its own process in
the Breeze venv — a different interpreter with a different torch from the
studio's pipeline — so the bundle tests neither reach it nor should.

`BREEZE_DEVICE` overrides everything, because the fallback below is a
preference and somebody measuring one should not have to edit code.
"""
import os
import sys


def _device():
    """cuda, mps or cpu — in the order that is fastest where each exists."""
    want = (os.environ.get("BREEZE_DEVICE") or "").strip()
    if want:
        return want
    try:
        import torch
    except ImportError:  # pragma: no cover — the venv is built with it
        return "cpu"
    if torch.cuda.is_available():
        return "cuda:0"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def main():
    import breeze_infer.runtime as rt

    dev = _device()
    original = rt.resolve_device

    def resolve_device(explicit_device=None):
        # Upstream's own signature: an explicit argument still wins, so a
        # caller that knows better is not overridden by this.
        return original(explicit_device) if explicit_device else dev

    rt.resolve_device = resolve_device
    # `api.py` imported the name directly (`from ...runtime import
    # resolve_device`), so patching the MODULE alone leaves its own binding
    # pointing at the original — the shim would then run, change nothing, and
    # report success. Both are rebound.
    import breeze_infer.api as api
    if hasattr(api, "resolve_device"):
        api.resolve_device = resolve_device

    print(f"[breeze_serve] device={dev}", flush=True)
    api.main()


if __name__ == "__main__":
    # argv is passed straight through — this shim adds no arguments of its own,
    # so upstream's parser stays the one contract.
    sys.exit(main())

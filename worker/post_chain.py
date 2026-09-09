"""Which finishing passes a clip gets in the FINAL render.

Python twin of src/lib/postChain.ts — same op ids, same order, same rule for
what `clips.post = null` means. Pure: no imports, no I/O, so it is testable off
the pod. The implementations live in handlers/post.py; the orchestration in
handlers/render.py.

Two things worth keeping straight:

`null` is INHERIT, not "no passes". The browser writes null when a clip follows
the project's chain and an object (`{}` included) when it overrides it, so a
project-wide "everything gets grain" reaches every clip that never asked for
something different, and a clip that genuinely wants nothing can still say so.

The chain is split around the clip's own normalize step, because it is the same
split the mastering canon already implies. `source` passes (SeedVR2 restore,
RIFE, FaceDetailer) run BEFORE ops/fit — an upscaler wants the original pixels,
and its output is then fitted back to the timeline's frame, which is what makes
it a restore rather than a bigger picture. `finish` passes (grade, grain) run
AFTER, on the normalized frame, because grain applied at source resolution and
then rescaled is mush, and an upscaler handed grain sharpens the noise.

BEFORE THE OPS, NOT BEFORE THE CUT. A source pass sees the clip's [in, out]
window at the take's own geometry, never the whole downloaded take: the take's
length is unbounded where the clip's is bounded by the edit, so running these
on the file meant a 3s clip of a 12s take paid four times over and the peak was
set by something no edit could bring down. It is what made a real render OOM —
see handlers/render.source_window, and handlers/post.POST_CHUNK_PIXELS for the
bound that catches the clips which are genuinely that long.
"""

POST_ORDER = ["upscale", "ltx_refine", "interpolate", "facefix", "h3_facefix",
              "color_match", "grain"]

#: Passes that may not run together, with the reason a caller can print.
#: The two face passes are alternatives, not a stack: one inpaints every
#: frame through an image model and the other re-generates the tracked crop
#: through H3, so running both re-decides the same pixels twice — the same
#: shape `resolve()` refuses `refine` + `split_pass` for, and for the same
#: reason (it is three passes and untested, not a stack anyone measured).
EXCLUSIVE = [
    (("facefix", "h3_facefix"),
     "the two face passes rewrite the same faces — pick one"),
]

#: op id -> which side of the clip's normalize step it runs on
POST_STAGE = {
    "upscale": "source",
    "ltx_refine": "source",
    "interpolate": "source",
    "facefix": "source",
    "h3_facefix": "source",
    "color_match": "finish",
    "grain": "finish",
}

#: Ops that drive ComfyUI. These decide the render's LANE — worker.py fills the
#: cpu/api/llm pool concurrently with the serial gpu slot, so a cpu-lane render
#: that loads SeedVR2 puts a second model beside a live generation.
#:
#: `color_match` is in here even though colour transfer is arithmetic and loads
#: no model: it runs on KJNodes' ColorMatch, so it occupies the ComfyUI queue,
#: which is the serial resource this set exists to protect. Membership is
#: "drives ComfyUI", not "uses the GPU". Only `grain` is genuinely ffmpeg-only.
GPU_OPS = {"upscale", "ltx_refine", "interpolate", "facefix", "h3_facefix",
           "color_match"}

_IDS = set(POST_ORDER)


def normalize(v):
    """Row value -> chain dict, or None for "inherit".

    Strict rather than forgiving: a jsonb column takes anything, and a chain of
    ``{"grian": true}`` that silently reads as empty is a switch that looks on
    and renders off.
    """
    if v is None or not isinstance(v, dict):
        return None
    return {k: True for k, on in v.items() if k in _IDS and on is True}


def resolve(clip_post, project_chain):
    """-> (mode, chain), mode being "inherit" or "custom"."""
    own = normalize(clip_post)
    if own is None:
        return "inherit", (normalize(project_chain) or {})
    return "custom", own


def active_ops(chain, stage=None):
    """The ops that will run, in the order they run. `stage` filters to one
    side of the normalize step."""
    if not chain:
        return []
    return [op for op in POST_ORDER
            if chain.get(op) is True and (stage is None or POST_STAGE[op] == stage)]


def chain_conflict(chain):
    """-> the reason two active ops cannot run together, or None.

    Checked BEFORE a render rather than in an applier: by the time a pass runs
    the clip's GPU time is already spent, and a chain that quietly dropped one
    of the pair would be the silent downgrade every gate in this file exists
    to prevent.
    """
    ops = set(active_ops(chain))
    for pair, why in EXCLUSIVE:
        if ops.issuperset(pair):
            return why
    return None


def needs_gpu(chain):
    return any(op in GPU_OPS for op in active_ops(chain))


def describe(chain):
    ops = active_ops(chain)
    return " + ".join(ops) if ops else "none"

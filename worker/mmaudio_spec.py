"""The MMAudio decisions that BOTH the browser and the worker have to make.

Twinned with `src/lib/mmaudio.ts`, and pinned against it the way `mix.py` /
`mix.ts` and `strip.py` / `previewStrip.ts` are. The failure a twin prevents
here is a specific one: the modal quotes a duration and a frame count next to
the button, the worker renders whatever it renders, and a disagreement is a
soundtrack that is shorter than the shot with nothing on screen having said so.

Nothing in here touches ComfyUI, the database or the filesystem, so both sides
can test it without either.
"""

# The node's own floor. Below about a second there is not enough of a latent
# sequence for the flow matcher to say anything.
MIN_SECONDS = 1.0

# MMAudio v2 large was trained on 8-second videos, and the vendor's own Space
# says so on the page: "Using much longer or shorter videos will degrade
# performance. Around 5s~12s should be fine." That is a QUALITY band, not a
# limit — the node accepts anything — so it is reported as a note rather than
# enforced as a clamp. Deciding for the user that their 3-second insert cannot
# be scored would be worse than telling them it is outside the band.
TRAINED_SECONDS = 8.0
BAND_LOW = 5.0
BAND_HIGH = 12.0

# Synchformer's rate, and the rate a staged batch MUST be loaded at. See
# `graphs.mmaudio_graph` for why anything else silently shortens the render.
SYNC_FPS = 25
# The CLIP semantic tower's rate. Only used to say how much of the shot it
# sees, which is the honest caveat of the port's single-batch design.
CLIP_FPS = 8


def clamp_seconds(ms, max_seconds=None):
    """Payload milliseconds (invariant #3) -> the seconds the node wants."""
    cap = float(max_seconds or 30.0)
    return max(MIN_SECONDS, min(cap, float(ms) / 1000.0))


def frames_needed(seconds, fps=SYNC_FPS):
    """How many frames the staged batch must carry for `seconds` to survive.

    The node truncates the requested duration to `total_frames / 25` whenever
    the batch is short, so this is the number `frame_load_cap` has to reach.
    """
    return max(1, int(round(float(seconds) * int(fps))))


def clip_coverage(seconds, fps=SYNC_FPS, clip_fps=CLIP_FPS):
    """The FRACTION of the shot the CLIP semantic tower actually sees, 0..1.

    Kijai's port slices one batch twice — `[:8*duration]` for CLIP and
    `[:25*duration]` for Synchformer — so at the 25fps the length contract
    requires, CLIP reads the first 8/25 of the frames. Reported rather than
    hidden: it is why the text prompt matters more on this path than it would
    on a bare video-to-audio model, and why a shot whose sound source only
    appears late is worth describing in words.
    """
    fps, clip_fps = int(fps), int(clip_fps)
    if fps <= 0 or clip_fps <= 0:
        return 1.0
    return min(1.0, clip_fps / float(fps))


def duration_note(seconds, trained=TRAINED_SECONDS, low=BAND_LOW,
                  high=BAND_HIGH):
    """A sentence about a length outside the trained band, or None."""
    s = float(seconds)
    if s < low:
        return (f"{s:.1f}s is under the {low:.0f}s this model reads best. It "
                f"was trained on {trained:.0f}-second videos, so a very short "
                f"clip tends to come back thin — render the sound long and "
                f"trim it, or describe it more concretely.")
    if s > high:
        return (f"{s:.1f}s is over the {high:.0f}s this model reads best. It "
                f"was trained on {trained:.0f}-second videos; past about "
                f"{high:.0f}s sync drifts and the sound wanders. Score the "
                f"shot in pieces if it matters.")
    return None

"""MiniMax H3 timing math — mapping arbitrary-length timeline segments onto
H3's fixed frame grid.

H3 renders only frame counts n ≡ 5 (mod 17) at a fixed 24 fps (4–15 s →
101..365 frames legal ceiling 365? No: 15 s = 360 → padded 362? See below).
The pipeline never asks the model for an exact duration; it renders slightly
LONG (warmup + content + cooldown, padded UP to the next legal count) and
trims the exact content window out afterwards. Warmup frames absorb the
model's unstable opening; cooldown gives the trim a clean tail. Ported from
VRGDG's MiniMaxH3Timing design (17n+5, round-up alignment, trim-to-exact).

All public inputs/outputs are integers: milliseconds and frames. FPS is 24.
"""
from dataclasses import dataclass, asdict

FPS = 24
FRAME_BASE = 17
FRAME_REM = 5
MIN_FRAMES = 5 + 17 * 5  # 90f ≈ 3.75s — practical floor below H3's 4s spec
MAX_FRAMES = 365         # 15.2s — the largest legal count ≤ H3's ceiling
# 22, not 12: Motion-Context pins context in whole latent steps (5/22/39/56 —
# the 17n+5 grid) and its author's guidance is "use 22" for a near-seamless
# join. The pinned window must live entirely inside the trimmed warmup, so the
# warmup IS 22 frames (0.92s) — which also absorbs more of the model's
# unstable opening on unchained blocks. plan_block still sheds it near the
# 365-frame ceiling; the context length snaps down with it.
DEFAULT_WARMUP_F = 22    # 0.92 s — one Motion-Context latent step
DEFAULT_COOLDOWN_F = 6   # 0.25 s tail so the trim never lands on the pad


def pad17(frames: int) -> int:
    """Round UP to the nearest legal H3 frame count (n ≡ 5 mod 17)."""
    frames = max(int(frames), FRAME_REM)
    return frames + (FRAME_REM - frames) % FRAME_BASE


def ms_to_frames_ceil(ms: int) -> int:
    """Frames covering a duration (ceiling, so content never gets cut)."""
    return -(-int(ms) * FPS // 1000)


def frames_to_ms(frames: int) -> int:
    return round(int(frames) * 1000 / FPS)


@dataclass(frozen=True)
class TimingPlan:
    """Everything a master_pass job needs to render long and trim exact."""
    content_ms: int          # what the storyboard asked for
    warmup_f: int            # frames rendered before the content window
    cooldown_f: int          # requested tail after the content window
    content_f: int           # frames covering content_ms (ceiling)
    render_f: int            # padded 17n+5 total frames sent to the model
    render_ms: int           # wall duration of the render
    trim_start_ms: int       # where the content window starts in the render
    trim_ms: int             # exact content duration to cut (== content_ms)
    audio_offset_ms: int     # source-audio offset for a locked slice:
                             #   slice starts (block.t_start_ms - warmup_ms)
    audio_ms: int            # locked-slice duration (== render_ms, so the
                             #   model hears audio through warmup + pad)

    def as_dict(self):
        return asdict(self)


def plan_block(content_ms: int, *, warmup_f: int = DEFAULT_WARMUP_F,
               cooldown_f: int = DEFAULT_COOLDOWN_F) -> TimingPlan:
    """Plan one master pass for an exact content duration.

    Raises ValueError when the content cannot fit a single pass even with
    zero warmup/cooldown — the planner must split earlier.
    """
    if content_ms <= 0:
        raise ValueError("content_ms must be positive")
    content_f = ms_to_frames_ceil(content_ms)
    if content_f > MAX_FRAMES:
        raise ValueError(f"content {content_ms}ms needs {content_f}f > {MAX_FRAMES}f max")

    render_f = pad17(content_f + warmup_f + cooldown_f)
    # Padding beyond the ceiling: shed cooldown, then warmup, then give up.
    while render_f > MAX_FRAMES and cooldown_f > 0:
        cooldown_f -= 1
        render_f = pad17(content_f + warmup_f + cooldown_f)
    while render_f > MAX_FRAMES and warmup_f > 0:
        warmup_f -= 1
        render_f = pad17(content_f + warmup_f + cooldown_f)
    if render_f > MAX_FRAMES:
        raise ValueError(f"content {content_ms}ms cannot fit a single pass")
    if render_f < MIN_FRAMES:
        render_f = pad17(MIN_FRAMES)

    warmup_ms = frames_to_ms(warmup_f)
    render_ms = frames_to_ms(render_f)
    return TimingPlan(
        content_ms=int(content_ms),
        warmup_f=warmup_f,
        cooldown_f=cooldown_f,
        content_f=content_f,
        render_f=render_f,
        render_ms=render_ms,
        trim_start_ms=warmup_ms,
        trim_ms=int(content_ms),
        audio_offset_ms=-warmup_ms,
        audio_ms=render_ms,
    )


# Block-size limits for the planner: content only (warmup/cooldown ride on top
# and are shed automatically near the ceiling).
MAX_CONTENT_MS = frames_to_ms(MAX_FRAMES - DEFAULT_WARMUP_F)  # keep warmup room
MIN_CONTENT_MS = 4000

// H3 frame planning, client side.
//
// worker/h3_timing.py is authoritative: master_pass re-plans from the block's
// own window and patches `frames`/`trim` before rendering. This exists because
// generation_blocks.frames is NOT NULL, so anything creating a block has to
// write a legal count up front — and because the ETA and cost readouts are
// computed from it, a placeholder like 0 would quote the wrong number.
//
// Keep the constants in step with worker/h3_timing.py; the rule itself
// (n ≡ 5 mod 17 at 24fps) is a property of the model, not a setting.

export const FPS = 24;
const FRAME_BASE = 17;
const FRAME_REM = 5;
export const MIN_FRAMES = 5 + 17 * 5;   // 90f ≈ 3.75s
export const MAX_FRAMES = 365;          // 15.2s — largest legal count under H3's ceiling
// 22, not 12 — and the 12 was a real bug, not a rounding preference. Motion
// Context pins its window in whole latent steps (5/22/39/56, the 17n+5 grid)
// and that window must live entirely inside the trimmed warmup, so the worker
// moved to 22 and this copy did not follow. Everything downstream of the
// disagreement was silently wrong in the same direction: `maxContentMs()`
// offered a 14.7s content window against the worker's 14.29s, and at the top
// of that range plan_block sheds warmup frames to fit — past which
// `_motion_ctx_wanted`'s `warmup_f >= 5` fails and a block created at the UI's
// own maximum quietly loses chained motion continuity. Pinned against the
// Python by h3timing.test.ts.
export const DEFAULT_WARMUP_F = 22;
export const DEFAULT_COOLDOWN_F = 6;

/** Round UP to the nearest legal H3 frame count (n ≡ 5 mod 17). */
export function pad17(frames: number): number {
  const f = Math.max(Math.trunc(frames), FRAME_REM);
  return f + (((FRAME_REM - f) % FRAME_BASE) + FRAME_BASE) % FRAME_BASE;
}

export const msToFramesCeil = (ms: number) => Math.ceil((Math.trunc(ms) * FPS) / 1000);
export const framesToMs = (f: number) => Math.round((Math.trunc(f) * 1000) / FPS);

export interface TimingPlan {
  warmupF: number;
  cooldownF: number;
  renderF: number;
  renderMs: number;
  trimStartMs: number;
  outMs: number;
}

/** The longest content a single pass can carry, in ms. Written as the Python's
 *  own expression (`frames_to_ms(MAX_FRAMES - DEFAULT_WARMUP_F)`) rather than
 *  an inlined floor: the two disagreed by a millisecond, which is one whole
 *  frame once `msToFramesCeil` rounds it up. */
export const maxContentMs = () => framesToMs(MAX_FRAMES - DEFAULT_WARMUP_F);

/** Plan one master pass. Mirrors h3_timing.plan_block, including the order it
 *  sheds padding in when the total overflows: cooldown first, then warmup. */
export function planBlock(
  contentMs: number,
  warmupF = DEFAULT_WARMUP_F,
  cooldownF = DEFAULT_COOLDOWN_F,
): TimingPlan {
  if (contentMs <= 0) throw new Error("contentMs must be positive");
  const contentF = msToFramesCeil(contentMs);
  if (contentF > MAX_FRAMES) {
    throw new Error(`${contentMs}ms needs ${contentF}f, over the ${MAX_FRAMES}f single-pass ceiling`);
  }
  let renderF = pad17(contentF + warmupF + cooldownF);
  while (renderF > MAX_FRAMES && cooldownF > 0) {
    cooldownF -= 1;
    renderF = pad17(contentF + warmupF + cooldownF);
  }
  while (renderF > MAX_FRAMES && warmupF > 0) {
    warmupF -= 1;
    renderF = pad17(contentF + warmupF + cooldownF);
  }
  if (renderF > MAX_FRAMES) throw new Error(`${contentMs}ms cannot fit a single pass`);
  if (renderF < MIN_FRAMES) renderF = pad17(MIN_FRAMES);

  return {
    warmupF, cooldownF, renderF,
    renderMs: framesToMs(renderF),
    trimStartMs: framesToMs(warmupF),
    outMs: Math.trunc(contentMs),
  };
}

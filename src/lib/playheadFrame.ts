// WHICH FRAME IS ON SCREEN RIGHT NOW — the pure half of the player's
// grab-frame button.
//
// It is pure and it is its own module because the alternative is reading
// pixels off the live <video>, and that is not available: those elements
// deliberately carry no `crossOrigin` (see PreviewPlayer — the B2 CDN serves
// media without ACAO and a CORS-mode media fetch that gets none fails
// outright as a black frame), so the canvas they would be drawn into is
// tainted and `toBlob` throws. The frame is therefore RE-EXTRACTED through
// `captureVideoFrame`, which goes via the proxy and is fully seekable — and
// that means something has to answer "which clip, and at what point in its
// source" without the player's help.
//
// The mapping is `clipFrames.clipSourceAt` — the same function PreviewPlayer
// drives every element through, so this answers "the picture I am looking at"
// by construction rather than by a copy that has to be kept in step.
//
// It used to be a private copy that deliberately ignored `reverse`, on the
// grounds that the preview did not play it. The preview plays it now
// (PreviewPlayer.scrubTo), so following the render is no longer a
// divergence from the screen — it IS the screen. `freeze` is still ignored,
// and still for the original reason: the player does not hold on it, so
// honouring it here would hand back a frame the stage has never shown, which
// is the exact class of silent wrong answer frameExtractor.ts exists to stop.
import type { Clip, Track } from "./db/types";
import { clipSourceAt } from "./clipFrames.ts";

export interface PlayheadFrame {
  /** The clip whose layer is on top at this instant. */
  clip: Clip;
  /** Source-media ms of the frame it is showing. */
  srcMs: number;
  /** True when that clip is part-way through its own cross-fade, so what is
   *  literally on screen is a BLEND of this layer over whatever is behind it
   *  and the grab takes the incoming layer alone. Said out loud rather than
   *  approximated: compositing two decoded sources to reproduce the blend is
   *  a different feature, and a frame that quietly differs from the stage is
   *  what this module is written to avoid. */
  midTransition: boolean;
}

/**
 * The topmost video clip under `ms`, and where in its source it is.
 *
 * "Topmost" is PreviewPlayer's own stacking: video lanes are sorted by `idx`
 * ascending and given `zIndex: i + 1`, so the LAST lane in that order is the
 * one you can see. Null on a gap — every lane empty at this instant — which
 * is an ordinary state (the playhead past the end of a cut) and not an error.
 */
export function frameAtPlayhead(
  tracks: Track[],
  clips: Clip[],
  ms: number
): PlayheadFrame | null {
  const lanes = tracks
    .filter((t) => t.kind === "video")
    .sort((a, b) => b.idx - a.idx);          // top lane first

  for (const lane of lanes) {
    const clip = clips.find(
      (c) => c.track_id === lane.id
        && ms >= c.t_start_ms
        && ms < c.t_start_ms + c.duration_ms);
    if (!clip) continue;
    const into = ms - clip.t_start_ms;
    const tr = clip.transition_in;
    return {
      clip,
      srcMs: clipSourceAt(clip, ms),
      midTransition:
        tr?.type === "xfade" && !!tr.dur_ms && into < tr.dur_ms,
    };
  }
  return null;
}

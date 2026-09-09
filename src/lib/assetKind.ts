import type { Asset } from "./db/types";

/** Is this asset a PICTURE rather than a moving image?
 *
 *  A video lane legitimately holds stills. Dropping a photo on one is allowed
 *  (WsTimeline's `dropAsset` gates audio-vs-not and nothing else), and every
 *  generate action in the timeline places one: extend, chain and add-after all
 *  put the extracted start frame on the lane as a placeholder while the GPU
 *  works, so the edit is real the instant the button is pressed.
 *
 *  It matters because a `<video>` can never finish loading a JPEG: readyState
 *  stays 0, the player's `converge` reports it stalled on every tick, and the
 *  stage sits on a black frame under "buffering…" for good. That was the whole
 *  of "the block extension is stuck buffering" — a still, in a video element,
 *  waiting for data that had already arrived.
 *
 *  Its own module because PreviewPlayer reaches Supabase at import time and so
 *  cannot be loaded by `node --test` — the same split, for the same reason, as
 *  panelSpec.ts and comfyProgress.ts.
 *
 *  Kind decides (it is what the library and every picker go on); the two
 *  fallbacks are frameExtractor's own, because an asset registered as `video`
 *  with a `.jpg` key should still show its picture rather than hang. */
export function isStill(a: Asset | undefined | null): boolean {
  if (!a) return false;
  if (a.kind === "image" || a.kind === "frame") return true;
  // Only ever a fallback: an asset whose kind SAYS video is trusted, or a
  // poster-framed mp4 would stop playing.
  if (a.kind === "video" || a.kind === "audio") return false;
  if ((a.content_type ?? "").startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(a.b2_key);
}

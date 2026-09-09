// Job row metadata shared by every queue surface (top-bar popover + the
// Render queue side panel): status colors and kind labels. Kept out of the
// components so neither imports the other (they used to, and a shared const
// is not worth a circular import).
export const ST: Record<string, string> = {
  planned: "#5b6478", queued: "#8b93a7", generating: "#e8c268",
  generated: "#6fd08c", failed: "#e46e6e", stale: "#c98fe8",
};

export const KIND: Record<string, string> = {
  master_pass: "Master pass", audio_slice: "Audio slice", image_gen: "Image",
  clip_gen: "Clip", music_gen: "Music", sfx_gen: "Sound effect",
  llm_task: "Director task", launch_render: "Launch render", tl_render: "Timeline render",
  clip_render: "Clip render", patch_flf: "Patch (FLF)", patch_splice: "Patch splice",
  transition_gen: "Transition", video_edit: "AI edit", asset_ingest: "Media ingest",
  block_from_clip: "Save as new block",
  image_upscale: "Upscale still",
  post_upscale: "Upscale", post_interpolate: "Interpolate", post_facefix: "Face detail",
  post_h3_facefix: "Face refine (H3)", post_ltx_refine: "Refine (LTX)",
  post_grain_color: "Grain + color", gc_sweep: "Storage sweep",
  tts: "Voiceover (TTS)",
  video: "Take (v1)", image: "Still (v1)", compose: "Episode (v1)",
};

/** What a queue row should call a job. Enqueuers write `payload.label`
 *  ("b12 master", "Aki Minase · face sheet") so the queue can say WHICH
 *  block or sheet a row is instead of just its kind; rows from before the
 *  convention fall back to the kind name. */
export function jobLabel(j: { kind?: string | null; payload?: unknown } | null | undefined): string {
  const label = (j?.payload as { label?: unknown } | null)?.label;
  if (typeof label === "string" && label) return label;
  return KIND[j?.kind ?? ""] ?? j?.kind ?? "job";
}

/**
 * What a queue row should print for a job's model.
 *
 * A desktop render's `model_id` is `local:wan22-5b/wan5b-q6` — an addressing
 * scheme, not a name. The label already carries the display name, so the
 * useful thing to say beside it is WHERE it is running, which for every other
 * row in the queue is "the pod" and is worth distinguishing.
 */
export function jobWhere(
  j: { lane?: string | null; model_id?: string | null } | null | undefined,
): string {
  if (j?.lane === "local") return "this machine";
  return j?.model_id ?? "";
}

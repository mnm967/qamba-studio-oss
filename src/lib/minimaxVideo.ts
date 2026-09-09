// THE MINIMAX H3 v2 REQUEST BODY — the browser twin of
// `worker/providers/minimax_api.py`.
//
// Same reason as `falVideo.ts` and `wanVideo.ts`: this render is reachable on
// the POD (an `api_generate` job on the studio's key) and in the BROWSER (a
// `byok_gen` job on the user's own), and a disagreement between the two is
// invisible.
//
// Structurally this is Wan's shape wearing different field names — a typed
// media array with `role` values — and it is deliberately NOT folded in with
// it: Wan's items are `{type, url}` under `input.media`, MiniMax's are
// `{type, role, image_url: {url}}` under a top-level `content`, and an
// abstraction over two spellings this far apart hides more than it saves.
//
// THE ONE CONSTRAINT THAT IS NOT A FIELD NAME: image-to-video and
// reference-to-video are MUTUALLY EXCLUSIVE here. `first_frame`/`last_frame`
// may not appear alongside any `reference_*` role. Wan 3.0 holds both at once,
// which is the practical difference between the two rows for an extend of a
// shot with identity sheets staged — so the references are dropped rather than
// sent to be refused, and the caller is told.

export interface MinimaxShot {
  start?: string | null;
  end?: string | null;
  images?: string[];
  videos?: string[];
  audio?: string[];
}

/** Documented ceilings: 9 images, 3 videos, 3 audio, 12 files total. */
export const MINIMAX_MEDIA_CAPS: Record<string, number> = {
  reference_image: 9, reference_video: 3, reference_audio: 3,
};
export const MINIMAX_MAX_FILES = 12;

/** 4..15 whole seconds. */
export const MINIMAX_MIN_SECONDS = 4;
export const MINIMAX_MAX_SECONDS = 15;

export const minimaxSeconds = (s?: number | null): number =>
  Math.max(MINIMAX_MIN_SECONDS, Math.min(MINIMAX_MAX_SECONDS, Math.round(s || 6)));

/** `768P` or `2K`, off the SHORT edge. */
export function minimaxResolution(
  w?: number | null, h?: number | null, want?: string | null,
): string {
  if (want) {
    const up = String(want).toUpperCase();
    if (up === "768P" || up === "2K") return up;
  }
  const short = Math.min(w || 0, h || 0);
  return short && short > 800 ? "2K" : "768P";
}

/** MiniMax's own enum, or `adaptive`.
 *
 *  On an image-driven mode the docs say ratio becomes `adaptive` anyway — the
 *  staged frame's shape decides it — so saying so beats sending a number the
 *  API will override. */
export function minimaxRatio(
  w?: number | null, h?: number | null, mode = "t2v",
): string {
  if (mode === "i2v" || mode === "flf") return "adaptive";
  if (!w || !h) return "adaptive";
  const want = w / h;
  const table: [string, number][] = [
    ["21:9", 21 / 9], ["16:9", 16 / 9], ["4:3", 4 / 3],
    ["1:1", 1], ["3:4", 3 / 4], ["9:16", 9 / 16],
  ];
  let best = "adaptive";
  let gap = Infinity;
  for (const [name, val] of table) {
    const d = Math.abs(val - want);
    if (d < gap) { best = name; gap = d; }
  }
  return gap <= 0.12 ? best : "adaptive";
}

export function minimaxInferMode(shot: MinimaxShot): string {
  if (shot.end) return "flf";
  if (shot.start) return "i2v";
  return shot.images?.length ? "r2v" : "t2v";
}

export interface MinimaxContentItem {
  type: string;
  text?: string;
  role?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
}

/** `content[]`, with the mutual exclusion applied.
 *
 *  `dropped` is returned rather than swallowed so the caller can SAY what the
 *  model could not be given — a silently weaker render is the downgrade this
 *  codebase keeps naming. The text element is REQUIRED (the docs say so for
 *  the image-driven modes explicitly) and leads, because the roles that follow
 *  are read against it. */
export function minimaxContent(shot: MinimaxShot, prompt: string, mode: string):
  { content: MinimaxContentItem[]; dropped: number } {
  const content: MinimaxContentItem[] = [{ type: "text", text: prompt ?? "" }];
  if (mode === "i2v" || mode === "flf") {
    if (shot.start) {
      content.push({ type: "image_url", role: "first_frame", image_url: { url: shot.start } });
    }
    if (mode === "flf" && shot.end) {
      content.push({ type: "image_url", role: "last_frame", image_url: { url: shot.end } });
    }
    const dropped = (shot.images?.length ?? 0) + (shot.videos?.length ?? 0)
      + (shot.audio?.length ?? 0);
    return { content, dropped };
  }
  let budget = MINIMAX_MAX_FILES;
  const groups: [string, keyof MinimaxShot, "image_url" | "video_url" | "audio_url"][] = [
    ["reference_image", "images", "image_url"],
    ["reference_video", "videos", "video_url"],
    ["reference_audio", "audio", "audio_url"],
  ];
  for (const [role, key, wrap] of groups) {
    const all = ((shot[key] as string[] | undefined) ?? []).filter(Boolean);
    const urls = all.slice(0, MINIMAX_MEDIA_CAPS[role]).slice(0, budget);
    budget -= urls.length;
    for (const url of urls) content.push({ type: wrap, role, [wrap]: { url } });
  }
  return { content, dropped: 0 };
}

export interface MinimaxBodyInput {
  prompt: string;
  model?: string;
  mode?: string;
  seconds?: number | null;
  width?: number | null;
  height?: number | null;
  resolution?: string | null;
  ratio?: string | null;
}

/** The create body. Pure — this is what the twin test pins. */
export function minimaxBody(shot: MinimaxShot, req: MinimaxBodyInput):
  { body: Record<string, unknown>; dropped: number } {
  const mode = req.mode ?? "t2v";
  const { content, dropped } = minimaxContent(shot, req.prompt, mode);
  return {
    body: {
      model: req.model ?? "MiniMax-H3",
      duration: minimaxSeconds(req.seconds),
      resolution: minimaxResolution(req.width, req.height, req.resolution),
      ratio: req.ratio || minimaxRatio(req.width, req.height, mode),
      content,
    },
    dropped,
  };
}

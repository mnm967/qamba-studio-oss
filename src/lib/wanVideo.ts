// THE WAN 3.0 REQUEST BODY — the browser twin of `worker/providers/wan_api.py`.
//
// Same reason `falVideo.ts` exists: this render is reachable on the POD (an
// `api_generate` job on the studio's key) and in the BROWSER (a `byok_gen` job
// on the user's own), and a disagreement between the two is invisible — the
// same model, the same prompt, a different clip, with nothing saying which half
// was wrong. `wanVideo.test.ts` pins them against a fixture the real Python
// emits.
//
// WHY THIS MODEL GETS ITS OWN MODULE rather than joining the fal dialect: it is
// not a fal-shaped request at all. Wan takes ONE endpoint with a typed
// `input.media[]` array — `first_frame`, `last_frame`, `reference_image`,
// `reference_video`, `reference_audio` — where fal splits the same capability
// across separate endpoints with flat url fields. Bending one into the other
// would mean a dialect that describes neither.

/** What the caller staged, by ROLE. Same shape `falVideo` takes. */
export interface WanShot {
  start?: string | null;
  end?: string | null;
  images?: string[];
  videos?: string[];
  audio?: string[];
}

/** `input.media[].type`, and the ceiling Alibaba documents for each. Exceeded,
 *  the request is rejected outright — so they are TRIMMED rather than passed
 *  through, the same rule `resolve.lora_stack` follows for an adapter a model
 *  does not declare. */
export const WAN_MEDIA_CAPS: Record<string, number> = {
  first_frame: 1, last_frame: 1, reference_image: 10,
  reference_video: 5, reference_audio: 5,
};

/** $/second by resolution tier, from Alibaba's published API pricing. */
export const WAN_PER_SECOND: Record<string, number> = {
  "480P": 0.05, "720P": 0.10, "1080P": 0.20,
};

export const WAN_STATUS_DONE = "SUCCEEDED";
export const WAN_STATUS_BAD = ["FAILED", "CANCELED", "UNKNOWN"];

/** Wan takes 2..30 seconds; out of range is a rejected request. */
export const wanSeconds = (s?: number | null): number =>
  Math.max(2, Math.min(30, Math.round(s || 5)));

/** The tier Wan takes, from the render's own size.
 *
 *  It is a TIER, not a size — the aspect is `ratio` and comes separately — so
 *  the SHORT edge decides it, which is what makes one label right on a portrait
 *  cut as well as a landscape one (`renderOutput`'s own rule). */
export function wanResolution(
  w?: number | null, h?: number | null, want?: string | null,
): string {
  if (want) {
    const up = String(want).toUpperCase();
    if (up in WAN_PER_SECOND) return up;
  }
  const short = Math.min(w || 0, h || 0);
  if (!short) return "720P";
  return short <= 544 ? "480P" : short <= 800 ? "720P" : "1080P";
}

/** Nearest declared aspect, or `adaptive`.
 *
 *  Wan takes an ENUM, so a computed "1.82:1" is a rejected request — and a
 *  shape that matches nothing declared is better served by `adaptive` (its own
 *  documented value) than by the nearest enum, which would letterbox or crop.
 *  With a first frame staged, the frame's own shape decides it there. */
export function wanRatio(w?: number | null, h?: number | null): string {
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

/** What the staging implies, when the caller did not say. Mirrored in the
 *  Python so both planes read an under-specified payload the same way. */
export function wanInferMode(shot: WanShot): string {
  if (shot.end) return "flf";
  if (shot.start) return "i2v";
  return shot.images?.length ? "r2v" : "t2v";
}

export interface WanMediaItem { type: string; url: string }

/** `input.media` for this mode, in the order the API reads it.
 *
 *  THE MODE DECIDES WHAT A PICTURE MEANS, which is the whole reason the shot
 *  keeps its roles apart. The same asset is a `first_frame` on an extend and a
 *  `reference_image` on an r2v; put a chain's closing frame in the reference
 *  pool and the model is told "here is another picture of this scene" instead
 *  of "end exactly here" — so the chain does not arrive, and nothing in the
 *  output says why. */
export function wanMedia(shot: WanShot, mode: string): WanMediaItem[] {
  const out: WanMediaItem[] = [];
  const add = (kind: string, urls: (string | null | undefined)[]) => {
    const list = urls.filter((u): u is string => !!u).slice(0, WAN_MEDIA_CAPS[kind]);
    for (const url of list) out.push({ type: kind, url });
  };
  if ((mode === "i2v" || mode === "flf") && shot.start) add("first_frame", [shot.start]);
  if (mode === "flf" && shot.end) add("last_frame", [shot.end]);
  // A start frame is already staged on i2v/flf; anything ELSE is a reference,
  // and dropping it would lose the identity sheets an extend of a cast shot
  // depends on. Wan is the row that can hold both at once — which is exactly
  // what Seedance's image-to-video endpoint cannot do.
  add("reference_image", shot.images ?? []);
  add("reference_video", shot.videos ?? []);
  add("reference_audio", shot.audio ?? []);
  return out;
}

export interface WanBodyInput {
  prompt: string;
  model?: string;
  mode?: string;
  negative?: string | null;
  seconds?: number | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
  resolution?: string | null;
  ratio?: string | null;
  audio?: boolean;
  promptExtend?: boolean;
  watermark?: boolean;
}

/** The create-task body. Pure — this is what the twin test pins. */
export function wanBody(shot: WanShot, req: WanBodyInput): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: req.prompt ?? "" };
  if (req.negative) input.negative_prompt = req.negative;
  const media = wanMedia(shot, req.mode ?? "t2v");
  if (media.length) input.media = media;
  const parameters: Record<string, unknown> = {
    resolution: wanResolution(req.width, req.height, req.resolution),
    ratio: req.ratio || wanRatio(req.width, req.height),
    duration: wanSeconds(req.seconds),
    audio: req.audio ?? true,
    // OFF by default and deliberately: `prompt_extend` rewrites the prompt
    // server-side, and on a compiled envelope (invariant #6) a rewrite is the
    // one thing that must not happen.
    prompt_extend: req.promptExtend ?? false,
    watermark: req.watermark ?? false,
  };
  if (req.seed != null) parameters.seed = req.seed & 0x7fffffff;
  return { model: req.model ?? "wan3.0-video", input, parameters };
}

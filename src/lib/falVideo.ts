// THE fal VIDEO REQUEST BODY — the browser twin of `worker/fal_video.py`.
//
// Two engines again, for the reason `mix.ts`/`mix.py` and `strip.py`/
// `previewStrip.ts` are twins: the same render is reachable on the POD (an
// `api_generate` job on the studio's key) and in the BROWSER (a `byok_gen` job
// on the user's own), and a disagreement between them is invisible — the same
// model, the same prompt, a different clip, with nothing saying which half was
// wrong. `falVideo.test.ts` pins them against each other.
//
// WHY A DIALECT TABLE RATHER THAN A FIXED BODY. fal splits a model's modes
// across SEPARATE ENDPOINTS with different field names: Seedance 2.5's
// `image-to-video` takes `image_url` + `end_image_url` (so a chain is
// expressible), while its `reference-to-video` takes `image_urls` /
// `video_urls` / `audio_urls` and no start frame at all. fal DROPS an input an
// endpoint does not declare rather than refusing it, so writing every url into
// every plausible field — which is what the first adapter did — renders a
// perfectly good clip of the wrong thing.
//
// And `duration` is a STRING enum on the current video endpoints ("auto", or
// whole seconds), not a number. A number is a 422 at submit.

/** The dialect, from the catalog row's `local_files.fal`. */
export interface FalVideoSpec {
  /** mode -> endpoint. A mode absent here is a mode this model cannot do.
   *
   *  An entry may be a bare id, or an object that overrides the fields THAT
   *  endpoint speaks — see `falEndpoint`. */
  endpoints?: Record<string, string | FalEndpointEntry>;
  duration?: "string" | "int" | null;
  /** the enum, when the endpoint declares one */
  durations?: string[];
  resolutions?: string[];
  aspect?: boolean;
  audioFlag?: string | null;
  negative?: string | null;
  start?: string | null;
  end?: string | null;
  images?: string | null;
  videos?: string | null;
  audios?: string | null;
  maxRefs?: number | null;
}

/** What the caller staged, by ROLE. Roles rather than one list because the
 *  providers disagree about what a picture MEANS — a chain's closing frame in
 *  the reference pool reads as "another picture of this scene" instead of "end
 *  exactly here". */
export interface FalShot {
  start?: string | null;
  end?: string | null;
  images?: string[];
  videos?: string[];
  audio?: string[];
}

/** An endpoint that does not speak the model's own field names. */
export interface FalEndpointEntry extends Partial<Pick<
  FalVideoSpec, "start" | "end" | "images" | "videos" | "audios" | "maxRefs"
>> {
  id: string;
}

const ENDPOINT_FIELDS = ["start", "end", "images", "videos", "audios", "maxRefs"] as const;

export const FAL_ASPECTS: [string, number][] = [
  ["21:9", 21 / 9], ["16:9", 16 / 9], ["4:3", 4 / 3],
  ["1:1", 1], ["3:4", 3 / 4], ["9:16", 9 / 16],
];

export function falAspect(w?: number | null, h?: number | null): string {
  if (!w || !h) return "auto";
  const want = w / h;
  let best = "auto";
  let gap = Infinity;
  for (const [name, val] of FAL_ASPECTS) {
    const d = Math.abs(val - want);
    if (d < gap) { best = name; gap = d; }
  }
  // A shape that matches nothing declared is better served by `auto` than by
  // the nearest enum, which would letterbox or crop the picture.
  return gap <= 0.12 ? best : "auto";
}

/** The tier THIS endpoint declares that is nearest the render's SHORT edge.
 *
 *  Clamped to what it serves rather than passed through: Seedance 2.5 tops out
 *  at 720p and FLUX 3 starts at 720p, so one shared "1080p" would be a
 *  rejected request on one of them. Short edge, not height — that is what
 *  makes one label right on a portrait cut too (`renderOutput`'s own rule). */
export function falResolution(
  spec: FalVideoSpec, w?: number | null, h?: number | null,
): string | null {
  const tiers = spec.resolutions ?? [];
  if (!tiers.length) return null;
  const short = Math.min(w || 0, h || 0) || 720;
  const ladder = tiers
    .map((t) => [parseInt(t.replace(/\D/g, ""), 10) || 0, t] as [number, string])
    .sort((a, b) => a[0] - b[0]);
  for (const [px, name] of ladder) if (short <= px + 80) return name;
  return ladder[ladder.length - 1][1];
}

/** `duration` in the shape this endpoint declares, or nothing.
 *
 *  Snapped onto the enum: an unlisted "7" is a 422, and sending nothing
 *  instead would render the endpoint's own default length into a slot cut for
 *  something else. */
export function falDuration(
  spec: FalVideoSpec, seconds?: number | null,
): string | number | null {
  if (!spec.duration || !seconds) return null;
  if (spec.duration === "int") return Math.round(seconds);
  const n = String(Math.round(seconds));
  const nums = (spec.durations ?? []).filter((d) => /^\d+$/.test(d));
  if (nums.length && !nums.includes(n)) {
    return nums.reduce((a, b) =>
      Math.abs(+a - seconds) <= Math.abs(+b - seconds) ? a : b);
  }
  return n;
}

/** The endpoint for a mode, and the mode actually served.
 *
 *  Falling back is better than failing, but only DOWNWARD and only visibly: a
 *  chain on a model with no `flf` endpoint is an extend, which is a worse
 *  answer and not a wrong one. Doing it silently is how a picker ends up
 *  offering a mode the render never performs. */
export function falEndpoint(spec: FalVideoSpec, mode: string):
  { endpoint: string; mode: string; degraded: boolean; spec: FalVideoSpec } | null {
  const eps = spec.endpoints ?? {};
  // FIELD AVAILABILITY IS PER-ENDPOINT, NOT PER-MODEL. Seedance 2.5 declares
  // `image_urls` on `reference-to-video` and NOT on `image-to-video`, so a
  // model-level `images` field writes a reference list into an i2v request
  // that fal then drops — and the extend renders without the identity sheets
  // that were staged for it, which is the very failure this module exists to
  // stop one level down.
  const merge = (entry: string | FalEndpointEntry): { id: string; spec: FalVideoSpec } => {
    if (typeof entry === "string") return { id: entry, spec };
    const out: FalVideoSpec = { ...spec };
    for (const k of ENDPOINT_FIELDS) {
      if (k in entry) (out as Record<string, unknown>)[k] = entry[k];
    }
    return { id: entry.id, spec: out };
  };
  if (eps[mode]) {
    const m = merge(eps[mode]);
    return { endpoint: m.id, mode, degraded: false, spec: m.spec };
  }
  for (const alt of ["i2v", "r2v", "t2v"]) {
    if (eps[alt]) {
      const m = merge(eps[alt]);
      return { endpoint: m.id, mode: alt, degraded: true, spec: m.spec };
    }
  }
  return null;
}

export interface FalBodyInput {
  prompt: string;
  negative?: string | null;
  mode: string;
  seconds?: number | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
  audio?: boolean | null;
  extra?: Record<string, unknown>;
}

/** The request body. Pure — this is what the twin test pins. */
export function falVideoBody(
  spec: FalVideoSpec, shot: FalShot, req: FalBodyInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: req.prompt ?? "" };
  if (req.negative && spec.negative) body[spec.negative] = req.negative;
  if (req.seed != null) body.seed = req.seed & 0x7fffffff;
  const dur = falDuration(spec, req.seconds);
  if (dur != null) body.duration = dur;
  const res = falResolution(spec, req.width, req.height);
  if (res) body.resolution = res;
  if (spec.aspect) body.aspect_ratio = falAspect(req.width, req.height);
  if (spec.audioFlag && req.audio != null) body[spec.audioFlag] = !!req.audio;

  const cap = spec.maxRefs ?? 0;
  let used = 0;
  const put = (field: string | null | undefined,
               urls: (string | null | undefined)[], single = false) => {
    if (!field) return;
    let list = urls.filter((u): u is string => !!u);
    if (cap) list = list.slice(0, Math.max(0, cap - used));
    if (!list.length) return;
    used += list.length;
    body[field] = single ? list[0] : list;
  };

  if (req.mode === "i2v" || req.mode === "flf") {
    put(spec.start, [shot.start], true);
    if (req.mode === "flf") put(spec.end, [shot.end], true);
    // An i2v endpoint that ALSO declares a reference list takes the rest; one
    // that does not simply never gets them, which is honest — the alternative
    // is writing them into a field fal will drop.
    put(spec.images, shot.images ?? []);
  } else {
    put(spec.images, shot.images ?? []);
  }
  put(spec.videos, shot.videos ?? []);
  put(spec.audios, shot.audio ?? []);
  return { ...body, ...(req.extra ?? {}) };
}

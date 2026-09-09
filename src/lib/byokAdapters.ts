// Calling a hosted model with the user's own key.
//
// ONE CONTRACT, three vendors, mirroring `worker/providers/__init__.py`: an
// adapter takes a request and returns bytes-or-a-url plus what it cost, and the
// caller does the uniform tail (upload to B2, register the asset, book the
// ledger). That tail already exists in `localRender.ts` for ComfyUI output, so
// a BYOK render reuses it rather than growing a second one.
//
// THE FIELD NAMES ARE COPIED FROM THE POD ADAPTERS, NOT REMEMBERED. Every one
// of these was verified once against the live API in `worker/providers/*.py`
// and each is pinned there by a comment saying why — Gemini's especially,
// where a wrong field name is an empty HTTP 200 rather than a 400. This module
// is their twin; when one moves, both move.
//
// THE TRANSPORT IS INJECTED. `byokJson` reaches Rust, which reaches the
// network — so passing it in is what lets every shape below be tested without
// a key, a desktop build or a provider. The same reason `director/tools.js`
// takes its database by injection.
import type { ModelCatalogRow } from "./db/types.ts";
import type { HostedSpec } from "./byokCatalog.ts";
import { falVideoBody, falEndpoint, type FalShot } from "./falVideo.ts";
import { wanBody, wanInferMode, WAN_PER_SECOND, WAN_STATUS_DONE, WAN_STATUS_BAD,
         wanResolution } from "./wanVideo.ts";
import { minimaxBody, minimaxInferMode } from "./minimaxVideo.ts";

/** The one call an adapter is allowed to make. */
export type Transport = <T = unknown>(
  provider: string, path: string,
  init?: {
    method?: string; headers?: Record<string, string>; body?: unknown;
    bodyB64?: string; contentType?: string;
  },
) => Promise<T>;

export interface ByokRequest {
  row: ModelCatalogRow;
  spec: HostedSpec;
  prompt: string;
  negative?: string | null;
  width?: number | null;
  height?: number | null;
  seconds?: number | null;
  seed?: number | null;
  /** low | medium | high, where the row takes one (OpenAI only) */
  quality?: string | null;
  /** PUBLIC urls of reference assets — the delivery bucket is public, so a
   *  provider can fetch them itself and nothing has to be re-uploaded. */
  refUrls?: string[];
  /** t2v | i2v | flf | r2v | t2i | edit. VIDEO models need it: on fal a mode
   *  is a different ENDPOINT, so inferring it from what happens to be staged
   *  picks the wrong url. The image adapters ignore it — there the mode is
   *  decided by whether references were supplied at all. */
  mode?: string | null;
  /** Staged media by ROLE, for the video adapters. A flat `refUrls` cannot
   *  express the difference between "open on this frame", "end on this frame"
   *  and "here is a picture of the subject" — and those compile to opposite
   *  instructions. */
  shot?: FalShot;
  /** raw bytes for the providers that will not fetch a url (OpenAI edits).
   *  Supplied by the caller so this module never touches the network itself. */
  refBytes?: { name: string; contentType: string; b64: string }[];
  note?: (pct: number, text: string) => void;
  /** true once the user has asked to cancel — polled between waits */
  canceled?: () => Promise<boolean>;
  /** injected so the poll loops are testable without real time passing */
  sleep?: (ms: number) => Promise<void>;
}

export interface ByokOutput {
  kind: "image" | "video";
  /** exactly one of these two */
  b64?: string;
  url?: string;
  contentType: string;
  costUsd: number;
  meta: Record<string, unknown>;
}

export class ByokAdapterError extends Error {}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ── OpenAI · GPT Image ─────────────────────────────────────────────────── */

/** The API takes an ENUM, not arbitrary dimensions. `auto` lets the model pick
 *  a shape that may not match the plate at all, so a requested size is snapped
 *  to the nearest canvas instead — the same rule `openai_image.py::_size`
 *  applies, and the same thresholds. */
export const OPENAI_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;

export function openaiSize(w?: number | null, h?: number | null): string {
  if (!w || !h) return "auto";
  const r = w / h;
  return r > 1.2 ? "1536x1024" : r < 0.83 ? "1024x1536" : "1024x1024";
}

/** $ per 1M tokens — gpt-image's published rates, the same table the pod
 *  adapter carries. A row's `pricing` may override. Wrong-but-declared beats
 *  silently free: an unpriced hosted generation is spend with no ledger row. */
export const OPENAI_TOKEN_PRICE = { text_in: 5.0, image_in: 10.0, image_out: 40.0 };

export function openaiCost(usage: unknown, pricing: Record<string, unknown> = {}): number {
  const p = { ...OPENAI_TOKEN_PRICE, ...pricing } as Record<string, number>;
  const u = (usage ?? {}) as Record<string, Record<string, number> & number>;
  const din = (u.input_tokens_details ?? {}) as Record<string, number>;
  const dout = (u.output_tokens_details ?? {}) as Record<string, number>;
  const txt = Number(din.text_tokens ?? 0);
  const imgIn = Number(din.image_tokens ?? 0);
  const imgOut = Number(dout.image_tokens ?? u.output_tokens ?? 0);
  return Math.round(
    ((txt * p.text_in + imgIn * p.image_in + imgOut * p.image_out) / 1e6) * 1e6) / 1e6;
}

/** A multipart body, built here because the transport sends bytes and knows
 *  nothing about forms. Latin-1 out of the base64 so the byte values survive
 *  the round trip back to base64 in `toB64` — a UTF-8 encode would rewrite
 *  every byte above 0x7f and corrupt the image. */
export function multipart(
  fields: Record<string, string | undefined | null>,
  files: { field: string; name: string; contentType: string; b64: string }[],
  boundary: string,
): { contentType: string; b64: string } {
  const chunks: number[] = [];
  const push = (s: string) => { for (let i = 0; i < s.length; i++) chunks.push(s.charCodeAt(i) & 0xff); };
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === "") continue;
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  for (const f of files) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; `
       + `filename="${f.name}"\r\nContent-Type: ${f.contentType}\r\n\r\n`);
    const bin = atob(f.b64);
    for (let i = 0; i < bin.length; i++) chunks.push(bin.charCodeAt(i));
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  let s = "";
  for (let i = 0; i < chunks.length; i += 0x8000) {
    s += String.fromCharCode(...chunks.slice(i, i + 0x8000));
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, b64: btoa(s) };
}

interface OpenAiImageReply {
  data?: { b64_json?: string; url?: string }[];
  usage?: unknown;
}

export async function openaiImage(req: ByokRequest, http: Transport): Promise<ByokOutput> {
  const model = req.spec.model ?? "gpt-image-2";
  const prompt = req.prompt.trim();
  if (!prompt) throw new ByokAdapterError("GPT Image needs a prompt.");
  const size = openaiSize(req.width, req.height);

  // TWO SHAPES ON ONE MODEL, and which you get is decided by whether anything
  // was staged. With references it is an EDIT — the measured reason this row
  // exists at all, since no local model can add a fixture to a plate and leave
  // the plate alone — and the FIRST image is the one being edited, which is
  // why the prompt the caller writes says "the first image".
  const files = req.refBytes ?? [];
  let reply: OpenAiImageReply;
  if (files.length) {
    const { contentType, b64 } = multipart(
      { model, prompt, size, quality: req.quality ?? undefined, n: "1" },
      files.map((f) => ({ field: "image[]", ...f })),
      `qamba${Math.random().toString(36).slice(2)}${files.length}`,
    );
    reply = await http<OpenAiImageReply>("openai", "/v1/images/edits",
      { method: "POST", bodyB64: b64, contentType });
  } else {
    reply = await http<OpenAiImageReply>("openai", "/v1/images/generations", {
      method: "POST",
      body: { model, prompt, size, n: 1, ...(req.quality ? { quality: req.quality } : {}) },
    });
  }
  const first = reply.data?.[0];
  if (!first?.b64_json && !first?.url) {
    throw new ByokAdapterError("GPT Image returned no image.");
  }
  return {
    kind: "image",
    b64: first.b64_json,
    url: first.b64_json ? undefined : first.url,
    contentType: "image/png",
    costUsd: openaiCost(reply.usage, req.row.pricing as Record<string, unknown>),
    meta: { provider: "openai", hosted_model: model, size, edit_of: files.length ? files[0].name : null },
  };
}

/* ── Google · Gemini image (Nano Banana) ────────────────────────────────── */

/** The API takes a ratio string, not pixels. Nearest of the ones it serves. */
export function geminiAspect(w?: number | null, h?: number | null): string {
  if (!w || !h) return "1:1";
  const r = w / h;
  const table: [string, number][] = [
    ["21:9", 21 / 9], ["16:9", 16 / 9], ["4:3", 4 / 3], ["3:2", 3 / 2],
    ["1:1", 1], ["2:3", 2 / 3], ["3:4", 3 / 4], ["9:16", 9 / 16],
  ];
  return table.reduce((best, t) =>
    Math.abs(Math.log(t[1] / r)) < Math.abs(Math.log(best[1] / r)) ? t : best)[0];
}

interface GeminiReply {
  candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string };
                                       text?: string }[] };
                 finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export async function geminiImage(req: ByokRequest, http: Transport): Promise<ByokOutput> {
  const model = req.spec.model ?? "gemini-3.1-flash-image";
  const caps = req.row.capabilities as { multiRef?: number; imageSize?: string };
  const parts: Record<string, unknown>[] = [{ text: req.prompt }];
  for (const r of (req.refBytes ?? []).slice(0, caps.multiRef ?? 8)) {
    parts.push({ inlineData: { mimeType: r.contentType, data: r.b64 } });
  }

  // Field names verified against the live API in gemini_image.py — each one
  // fails as an empty HTTP 200 rather than a 400, so none of them is a guess.
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["image"],
      imageConfig: {
        aspectRatio: geminiAspect(req.width, req.height),
        // A per-model CEILING, not a preference: Lite serves 1K only and
        // asking for a tier a model does not serve is a 400.
        imageSize: caps.imageSize ?? "1K",
      },
    },
  };
  const reply = await http<GeminiReply>("google",
    `/v1beta/models/${model}:generateContent`, { method: "POST", body });

  const cand = reply.candidates?.[0];
  const b64 = cand?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!b64?.data) {
    // A REFUSAL IS A TEXT PART WITH A 200. Registering an empty asset would
    // read as success, so it raises with whatever the model said instead.
    const said = cand?.content?.parts?.find((p) => p.text)?.text;
    throw new ByokAdapterError(
      `Gemini returned no image${cand?.finishReason ? ` (${cand.finishReason})` : ""}`
      + `${said ? `: ${said.slice(0, 240)}` : "."}`);
  }
  const p = req.row.pricing as Record<string, number>;
  const usage = reply.usageMetadata ?? {};
  const cost = Math.round(
    (((usage.promptTokenCount ?? 0) * (p.text_in ?? 0.3)
      + (usage.candidatesTokenCount ?? 0) * (p.image_out ?? 60)) / 1e6) * 1e6) / 1e6;
  return {
    kind: "image", b64: b64.data, contentType: b64.mimeType ?? "image/png",
    costUsd: cost,
    meta: { provider: "google", hosted_model: model,
            aspect_ratio: body.generationConfig.imageConfig.aspectRatio },
  };
}

/* ── fal · the queue ────────────────────────────────────────────────────── */

interface FalSubmit { status_url?: string; response_url?: string; request_id?: string }
interface FalStatus { status?: string; queue_position?: number; logs?: unknown[] }
interface FalResult {
  video?: { url?: string; content_type?: string };
  images?: { url?: string; content_type?: string }[];
  image?: { url?: string; content_type?: string };
  audio?: { url?: string; content_type?: string };
}

/** fal polls, so this is the one adapter with a clock. Bounded, cancellable,
 *  and the wait is injected — a test that really slept would take half an hour
 *  to cover the timeout. */
export const FAL_POLL_MS = 3000;
export const FAL_TIMEOUT_MS = 30 * 60 * 1000;

export async function falQueue(req: ByokRequest, http: Transport): Promise<ByokOutput> {
  // A dialect picks the endpoint by MODE; a plain row has exactly one.
  const routed = req.spec.fal
    ? falEndpoint(req.spec.fal, req.mode ?? "t2v")
    : null;
  const endpoint = routed?.endpoint ?? req.spec.endpoint;
  if (!endpoint) throw new ByokAdapterError("This fal model has no endpoint id.");
  if (routed?.degraded) {
    req.note?.(0, `this model has no ${req.mode} endpoint — rendering ${routed.mode}`);
  }
  const sleep = req.sleep ?? wait;

  // A VIDEO ROW BUILDS ITS BODY FROM THE DIALECT, an image row keeps the shape
  // that has always worked.
  //
  // What was here wrote every reference url into `image_url`, `image_urls` AND
  // `reference_image_urls` at once, and `duration` as a NUMBER. Measured
  // against fal's own published schemas, both are wrong for the current video
  // endpoints: `duration` is a string enum there (a number is a 422), and the
  // modes are SEPARATE endpoints whose field names differ — so the blanket
  // write lands the references in a field the chosen endpoint does not
  // declare, fal drops it silently, and the clip comes back ignoring every
  // reference. See falVideo.ts.
  // The MERGED dialect — the endpoint's own field names, not the model's.
  const dialect = routed?.spec ?? req.spec.fal;
  const body: Record<string, unknown> = dialect
    ? falVideoBody(dialect, req.shot ?? { images: req.refUrls ?? [] }, {
        prompt: req.prompt, negative: req.negative, mode: routed?.mode ?? req.mode ?? "t2v",
        seconds: req.seconds, width: req.width, height: req.height,
        seed: req.seed, audio: true,
      })
    : { prompt: req.prompt };
  if (!dialect) {
    if (req.negative) body.negative_prompt = req.negative;
    if (req.seed != null) body.seed = req.seed;
    if (req.seconds) body.duration = req.seconds;
    if (req.width && req.height) body.image_size = { width: req.width, height: req.height };
    if (req.refUrls?.length) {
      // The image endpoints take `image_url`/`image_urls`; the bucket is
      // public, so fal fetches them itself.
      body.image_url = req.refUrls[0];
      body.image_urls = req.refUrls;
    }
  }

  const sub = await http<FalSubmit>("fal", `/${endpoint}`, { method: "POST", body });
  const statusUrl = sub.status_url;
  const responseUrl = sub.response_url;
  if (!statusUrl || !responseUrl) {
    throw new ByokAdapterError("fal accepted the request but returned no status url.");
  }

  const deadline = Date.now() + FAL_TIMEOUT_MS;
  let done = false;
  while (Date.now() < deadline) {
    if (await req.canceled?.()) throw new ByokAdapterError("canceled");
    const st = await http<FalStatus>("fal", statusUrl);
    const s = (st.status ?? "").toUpperCase();
    if (s === "COMPLETED") { done = true; break; }
    if (s === "FAILED" || s === "ERROR") {
      throw new ByokAdapterError(`fal reported the job ${s.toLowerCase()}.`);
    }
    req.note?.(0.4, st.queue_position != null && st.queue_position > 0
      ? `fal: queued, ${st.queue_position} ahead`
      : `fal: ${s.toLowerCase() || "working"}`);
    await sleep(FAL_POLL_MS);
  }
  if (!done) throw new ByokAdapterError("fal did not finish within 30 minutes.");

  const res = await http<FalResult>("fal", responseUrl);
  const media = res.video ?? res.images?.[0] ?? res.image ?? res.audio;
  if (!media?.url) throw new ByokAdapterError("fal finished but returned no media url.");
  const kind = res.video ? "video" : "image";

  // Priced from the row, since fal does not report a cost. A video row prices
  // per second, so the LENGTH matters; an image row prices per image.
  const price = req.row.pricing as { unit?: string; usd?: number };
  const cost = price.usd == null ? 0
    : price.unit === "second" ? price.usd * (req.seconds ?? 6)
    : price.usd;

  return {
    kind, url: media.url,
    contentType: media.content_type ?? (kind === "video" ? "video/mp4" : "image/png"),
    costUsd: cost,
    meta: { provider: "fal", endpoint, request_id: sub.request_id ?? null },
  };
}

/* ── Alibaba Model Studio · Wan 3.0 ─────────────────────────────────────── */

/** How often the async task adapters ask. Wan and MiniMax both take minutes,
 *  so a tighter loop is rate-limit bait for no benefit. */
export const TASK_POLL_MS = 8000;
export const TASK_TIMEOUT_MS = 30 * 60 * 1000;

interface WanCreate { output?: { task_id?: string; task_status?: string } }
interface WanPoll {
  output?: { task_status?: string; video_url?: string; message?: string; code?: string };
}

/** Wan 3.0 — the only hosted row that serves an extend, a chain AND a
 *  reference shot, which is why it is worth its own adapter rather than being
 *  bent into the fal dialect.
 *
 *  `X-DashScope-Async: enable` goes on the CREATE only. Without it the call is
 *  SYNCHRONOUS, which on a thirty-second render means a request that hangs
 *  until something upstream gives up — and the poll below would then have no
 *  task to ask after. */
export async function wanQueue(req: ByokRequest, http: Transport): Promise<ByokOutput> {
  const sleep = req.sleep ?? wait;
  const shot = req.shot ?? { images: req.refUrls ?? [] };
  const mode = req.mode ?? wanInferMode(shot);
  const body = wanBody(shot, {
    prompt: req.prompt, model: req.spec.model ?? "wan3.0-video", mode,
    negative: req.negative, seconds: req.seconds,
    width: req.width, height: req.height, seed: req.seed,
  });

  const created = await http<WanCreate>(
    "alibaba", "/api/v1/services/aigc/video-generation/video-synthesis",
    { method: "POST", body, headers: { "X-DashScope-Async": "enable" } });
  const taskId = created.output?.task_id;
  if (!taskId) throw new ByokAdapterError("Model Studio accepted the request but returned no task id.");

  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let url: string | undefined;
  while (Date.now() < deadline) {
    if (await req.canceled?.()) throw new ByokAdapterError("canceled");
    const st = await http<WanPoll>("alibaba", `/api/v1/tasks/${taskId}`);
    const status = (st.output?.task_status ?? "").toUpperCase();
    if (status === WAN_STATUS_DONE) { url = st.output?.video_url; break; }
    if (WAN_STATUS_BAD.includes(status)) {
      throw new ByokAdapterError(
        `Model Studio reported the task ${status.toLowerCase()}`
        + (st.output?.message ? `: ${st.output.message}` : "."));
    }
    req.note?.(0.4, `Wan: ${status.toLowerCase() || "working"}`);
    await sleep(TASK_POLL_MS);
  }
  if (!url) throw new ByokAdapterError("Model Studio did not finish within 30 minutes.");

  const seconds = Number(body.parameters && (body.parameters as { duration?: number }).duration) || 5;
  const tier = wanResolution(req.width, req.height);
  const price = req.row.pricing as { usd?: number };
  const perS = price.usd ?? WAN_PER_SECOND[tier] ?? 0.1;
  return {
    kind: "video", url,
    contentType: "video/mp4",
    costUsd: Number((seconds * perS).toFixed(6)),
    // THE URL EXPIRES AFTER 24 HOURS on this provider, so the caller's
    // immediate download is not an optimisation here — it is the only chance.
    meta: { provider: "alibaba", task_id: taskId, mode, resolution: tier, seconds },
  };
}

/* ── MiniMax · H3 (v2) ──────────────────────────────────────────────────── */

interface MinimaxCreate { task_id?: string }
interface MinimaxPoll {
  status?: string;
  content?: { url?: string };
  task?: { status?: string; content?: { url?: string } };
}

/** H3 on MiniMax's own API — cheaper per second than the same model through
 *  fal, and the only hosted route to 2K.
 *
 *  Image-to-video and reference-to-video are MUTUALLY EXCLUSIVE here, so a
 *  chain with identity sheets staged loses the sheets. `minimaxBody` reports
 *  how many, and this SAYS so rather than rendering a quietly weaker shot. */
export async function minimaxVideo(req: ByokRequest, http: Transport): Promise<ByokOutput> {
  const sleep = req.sleep ?? wait;
  const shot = req.shot ?? { images: req.refUrls ?? [] };
  const mode = req.mode ?? minimaxInferMode(shot);
  const { body, dropped } = minimaxBody(shot, {
    prompt: req.prompt, model: req.spec.model ?? "MiniMax-H3", mode,
    seconds: req.seconds, width: req.width, height: req.height,
  });
  if (dropped) {
    req.note?.(0, `MiniMax cannot take references alongside a start or end frame — `
      + `${dropped} dropped. Wan 3.0 takes both.`);
  }

  const created = await http<MinimaxCreate>("minimax", "/v2/video_generation",
    { method: "POST", body });
  const taskId = created.task_id;
  if (!taskId) throw new ByokAdapterError("MiniMax accepted the request but returned no task id.");

  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let url: string | undefined;
  while (Date.now() < deadline) {
    if (await req.canceled?.()) throw new ByokAdapterError("canceled");
    const st = await http<MinimaxPoll>("minimax", `/v2/query/video_generation/${taskId}`);
    const status = (st.status ?? st.task?.status ?? "").toLowerCase();
    if (status === "succeeded") { url = st.task?.content?.url ?? st.content?.url; break; }
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      throw new ByokAdapterError(`MiniMax reported the task ${status}.`);
    }
    req.note?.(0.4, `MiniMax: ${status || "working"}`);
    await sleep(TASK_POLL_MS);
  }
  if (!url) throw new ByokAdapterError("MiniMax did not finish within 30 minutes.");

  const seconds = Number(body.duration) || 6;
  const price = req.row.pricing as { usd?: number };
  return {
    kind: "video", url, contentType: "video/mp4",
    costUsd: Number((seconds * (price.usd ?? 0.09)).toFixed(6)),
    meta: { provider: "minimax", task_id: taskId, mode,
            resolution: body.resolution, seconds, refs_dropped: dropped },
  };
}

/* ── Google · Gemini Omni Flash (video) ─────────────────────────────────── */

/** The first part anywhere in the reply carrying inline data or a video uri.
 *
 *  Deliberately a WALK, not a path. `gemini_video.py` says why at length: the
 *  documented shape is `steps[N].content[0]`, the SDK exposes
 *  `output_video.data`, and a uri delivery puts a file handle somewhere else
 *  again — so this looks for the thing rather than for the place it was said
 *  to be. An IndexError on a documented path reads as "the model returned
 *  nothing". */
export function findGeminiMedia(obj: unknown, depth = 0):
  { how: "data" | "uri"; value: string } | null {
  if (depth > 8 || obj == null) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) { const got = findGeminiMedia(v, depth + 1); if (got) return got; }
    return null;
  }
  if (typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const mime = String(o.mime_type ?? o.mimeType ?? "");
    if (typeof o.data === "string" && o.data && (!mime || mime.startsWith("video"))) {
      return { how: "data", value: o.data };
    }
    const uri = (o.uri ?? o.file_uri ?? o.fileUri) as string | undefined;
    if (typeof uri === "string" && (mime.startsWith("video") || uri.includes("/files/"))) {
      return { how: "uri", value: uri };
    }
    for (const v of Object.values(o)) {
      const got = findGeminiMedia(v, depth + 1);
      if (got) return got;
    }
  }
  return null;
}

const OMNI_TASKS: Record<string, string> = {
  t2v: "text_to_video", i2v: "image_to_video",
  flf: "image_to_video", r2v: "reference_to_video",
};

interface GeminiFile { state?: string; uri?: string; downloadUri?: string }

/** Gemini Omni Flash — 7 reference images and 3 short clips, native audio, on
 *  the key this app already holds for Nano Banana.
 *
 *  IT RIDES THE INTERACTIONS API, which `geminiImage` above deliberately does
 *  not: video has no `generateContent` form. `gemini_video.py` carries the full
 *  note; the short version is that those docs disagree with themselves about
 *  the response path, so the result is found by walking. */
export async function geminiVideo(req: ByokRequest, http: Transport): Promise<ByokOutput> {
  const sleep = req.sleep ?? wait;
  const model = req.spec.model ?? "gemini-omni-1.1-flash";
  const shot = req.shot;
  const mode = req.mode ?? "t2v";
  if (mode === "flf") {
    // NO FIRST-AND-LAST-FRAME MODE. Said rather than staging the closing frame
    // as another reference, which would render a chain that does not arrive
    // and look like a model quality problem.
    req.note?.(0, "Omni Flash cannot end on a given frame — the closing frame is described, not pinned.");
  }
  const parts: Record<string, unknown>[] = [{ type: "text", text: req.prompt ?? "" }];
  // Bytes, not urls: Interactions takes `data`/`mime_type` inline for an
  // image. `byokRender` supplies them for exactly this reason.
  for (const b of (req.refBytes ?? []).slice(0, 7)) {
    parts.push({ type: "image", mime_type: b.contentType, data: b.b64 });
  }
  const short = Math.min(req.width || 0, req.height || 0) || 720;
  const body = {
    model,
    input: parts,
    response_format: {
      type: "video",
      aspect_ratio: (req.height ?? 0) > (req.width ?? 0) ? "9:16" : "16:9",
      resolution: short <= 420 ? "360p" : short <= 800 ? "720p" : "1080p",
      // Every real render is over the ~4MB inline ceiling, so asking for what
      // will come back keeps the success path one branch instead of two.
      delivery: "uri",
    },
    generation_config: { video_config: { task: OMNI_TASKS[mode] ?? "text_to_video" } },
  };

  const out = await http<unknown>("google", "/v1beta/interactions", { method: "POST", body });
  const found = findGeminiMedia(out);
  if (!found) throw new ByokAdapterError("Omni Flash finished but returned no video.");

  const seconds = req.seconds ?? 8;
  const price = req.row.pricing as { usd?: number };
  const costUsd = Number((seconds * (price.usd ?? 0.1)).toFixed(6));
  const meta = { provider: "google", hosted_model: model, mode, delivery: found.how };
  if (found.how === "data") {
    return { kind: "video", b64: found.value, contentType: "video/mp4", costUsd, meta };
  }

  // A file handle, which may still be PROCESSING.
  const path = found.value.startsWith("https://")
    ? found.value
    : `/v1beta/files/${found.value.split("/").pop()}`;
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await req.canceled?.()) throw new ByokAdapterError("canceled");
    const info = await http<GeminiFile>("google", path);
    const state = (info.state ?? "ACTIVE").toUpperCase();
    if (state === "FAILED") throw new ByokAdapterError("Omni Flash could not produce the file.");
    if (state !== "PROCESSING") {
      return { kind: "video", url: info.downloadUri ?? info.uri ?? path,
               contentType: "video/mp4", costUsd, meta };
    }
    req.note?.(0.5, "Omni Flash: processing");
    await sleep(TASK_POLL_MS);
  }
  throw new ByokAdapterError("Omni Flash did not finish within 30 minutes.");
}

/* ── the dispatcher ─────────────────────────────────────────────────────── */

/** `async` so an unknown adapter arrives as a REJECTION like every other
 *  failure here. A synchronous throw would slip past a caller's `.catch()`
 *  and surface as an uncaught error rather than a failed job. */
export async function runAdapter(req: ByokRequest, http: Transport): Promise<ByokOutput> {
  switch (req.spec.adapter) {
    case "openai-image": return openaiImage(req, http);
    case "gemini-image": return geminiImage(req, http);
    case "fal-queue": return falQueue(req, http);
    case "wan-queue": return wanQueue(req, http);
    case "minimax-video": return minimaxVideo(req, http);
    case "gemini-video": return geminiVideo(req, http);
    default:
      throw new ByokAdapterError(`no adapter for '${(req.spec as HostedSpec).adapter}'`);
  }
}

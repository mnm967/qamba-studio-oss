// Civitai's REST API, as much of it as the import hub needs.
//
// COMMENTS ARE NOT AVAILABLE AND CANNOT BE MADE SO. Both routes were tried
// against the live service, with and without a valid token: `/api/v1/comments`
// answers **404 with 80KB of the site's HTML** (the same trap as a gated
// download — a client trusting the content type stores a web page), and the
// site's own tRPC route, `commentv2.getInfinite`, answers 401 with "Please use
// the public API instead". Two other fields are dead in the same way and must
// not be rendered: `stats.commentCount` is 0 on EVERY model (measured on a LoRA
// with 656k downloads and 26k thumbs-up), and image `meta` — the generation
// parameters — comes back empty even for items the search flags `hasMeta`.
// So the detail view links out for discussion and says why, rather than
// showing a "0 comments" that is a lie about a busy thread.
//
// THREE THINGS ABOUT THIS API THAT ARE NOT IN ITS DOCS, all measured against
// the live service (2026-08-16) rather than assumed:
//
//  1. SEARCH NEEDS NO PROXY. `civitai.com/api/v1/models` answers with
//     `access-control-allow-origin: *`, so the browser can call it directly and
//     the web build needs no serverless route to stand in front of it. (It also
//     answers `access-control-allow-methods: GET` only — search is a GET, and
//     downloads never go through the browser anyway.)
//
//  2. WORKFLOWS ARE `types=Workflows`, not `types=Other`. Searching Other
//     returns none of them — the top MiniMax H3 workflow has ~9.5k downloads
//     and lives under Workflows, as a file of `type: "Config"` whose name ends
//     in .json.
//
//  3. EVERY DOWNLOAD IS GATED, INCLUDING ONES MARKED "Public", and a gated
//     download answers **200 with the model's HTML page** rather than an error.
//     Three public-availability workflow ids were tried anonymously and all
//     three returned 9,685 bytes of `text/html`. So a client that trusts the
//     status code writes an HTML document into a .json file and reports
//     success — the exact failure the engine window's model list already guards
//     against on the pod. `fetchWorkflowJson` checks the content type and the
//     first byte, and says "this needs a token" instead.
//
// A token therefore is not optional for import, and it is a SECRET: it never
// goes in a URL (Civitai accepts `?token=`, which would put it in history,
// logs and the Referer header) — always the Authorization header.
import { hasRustHttp, httpFetch, isDesktop } from "./desktop.ts";

const API = "https://civitai.com/api/v1";
const UA = "QambaStudio/0.1 (+https://github.com/mnm967/qamba-studio-oss)";

/** Civitai's model types, restricted to the ones this hub offers. */
export type CivitaiType = "Workflows" | "LORA" | "Checkpoint" | "Upscaler" | "VAE" | "Other";

export interface CivitaiFile {
  id: number;
  name: string;
  sizeKB: number;
  type: string;
  downloadUrl: string;
  /** Civitai's own hashes; the download manager verifies against SHA256 */
  hashes?: Record<string, string>;
  metadata?: { format?: string; size?: string; fp?: string };
}

/** One image or video as either endpoint reports it.
 *
 *  `nsfwLevel` is deliberately `unknown`-ish: a version's own images report it
 *  as a NUMBER (`1`) and the gallery endpoint as a STRING (`"None"`) — measured,
 *  same account, same model. `explicit()` is the only thing that should read it. */
export interface CivitaiImage {
  id?: number;
  url: string;
  type?: string;
  width?: number;
  height?: number;
  nsfwLevel?: number | string;
  hash?: string;
  createdAt?: string;
  username?: string;
  postId?: number;
  stats?: { likeCount?: number; heartCount?: number; laughCount?: number; commentCount?: number };
}

export interface CivitaiVersion {
  id: number;
  name: string;
  baseModel?: string;
  description?: string;
  downloadUrl?: string;
  trainedWords?: string[];
  publishedAt?: string;
  createdAt?: string;
  availability?: string;
  stats?: { downloadCount?: number; thumbsUpCount?: number; rating?: number };
  files?: CivitaiFile[];
  images?: CivitaiImage[];
}

export interface CivitaiModel {
  id: number;
  name: string;
  description?: string;
  type: string;
  nsfw?: boolean;
  nsfwLevel?: number;
  poi?: boolean;
  tags?: string[];
  baseModels?: string[];
  allowNoCredit?: boolean;
  allowCommercialUse?: string[];
  allowDerivatives?: boolean;
  allowDifferentLicense?: boolean;
  creator?: { username?: string; image?: string };
  stats?: { downloadCount?: number; thumbsUpCount?: number; commentCount?: number;
            tippedAmountCount?: number };
  modelVersions?: CivitaiVersion[];
}

export interface SearchPage {
  items: CivitaiModel[];
  nextCursor: string | null;
}

export interface SearchOpts {
  query?: string;
  types?: CivitaiType[];
  /** Civitai's own base-model tags, e.g. "Flux.1 D", "Wan Video 2.2 I2V-A14B" */
  baseModels?: string[];
  sort?: "Highest Rated" | "Most Downloaded" | "Newest";
  period?: "AllTime" | "Year" | "Month" | "Week" | "Day";
  nsfw?: boolean;
  limit?: number;
  cursor?: string | null;
  token?: string;
  signal?: AbortSignal;
}

export class CivitaiError extends Error {
  // Written out rather than declared as constructor parameter properties:
  // `node --test` strips types instead of compiling them, and that is one of
  // the few TS constructs it refuses outright.
  status?: number;
  needsToken: boolean;

  constructor(message: string, status?: number, needsToken = false) {
    super(message);
    this.name = "CivitaiError";
    this.status = status;
    this.needsToken = needsToken;
  }
}

const authHeaders = (token?: string): Record<string, string> => ({
  accept: "application/json",
  // Civitai 403s the default fetch/curl agent even WITH a valid token
  // (the engine window's model list carries the same workaround).
  "user-agent": UA,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/**
 * Headers for the three CORS-BOUND GETs — search, model details, images.
 *
 * CIVITAI'S CORS REFUSES `Authorization` ON THESE, and the failure is total
 * rather than degraded: measured on the live API, the same search answers 200
 * anonymously and never leaves the page with a token attached, so the screen
 * shows "Failed to fetch" and nothing explains why. Rust is not subject to
 * CORS, so the token still rides when the request goes through it — which is
 * the real desktop build, and the only place a token exists at all
 * (`getToken()` is desktop-only). What this protects is every other
 * transport: the web build, the dev mock bridge, and any future caller that
 * passes a token from a browser context.
 *
 * Downloads are deliberately NOT routed through here. They are gated and MUST
 * carry the token; they also only ever run through Rust, and
 * `fetchWorkflowGraphs` already refuses a browser outright.
 */
const readHeaders = (token?: string): Record<string, string> =>
  authHeaders(hasRustHttp() ? token : undefined);

/** Turn a provider failure into something the UI can say out loud. */
function explain(status: number): string {
  if (status === 401) return "Civitai rejected the API token (401)";
  if (status === 403) return "Civitai refused the request (403) — the token may lack access";
  if (status === 404) return "not found on Civitai (404)";
  if (status === 429) return "Civitai is rate limiting (429) — wait a moment and retry";
  if (status >= 500) return `Civitai is having trouble (${status})`;
  return `Civitai answered ${status}`;
}

export async function searchCivitai(opts: SearchOpts = {}): Promise<SearchPage> {
  const q = new URLSearchParams();
  if (opts.query?.trim()) q.set("query", opts.query.trim());
  for (const t of opts.types ?? []) q.append("types", t);
  for (const b of opts.baseModels ?? []) q.append("baseModels", b);
  q.set("limit", String(opts.limit ?? 24));
  if (opts.sort) q.set("sort", opts.sort);
  if (opts.period) q.set("period", opts.period);
  // Civitai's `nsfw=false` filters the LISTING; it is not a content guarantee,
  // and the cards still carry `nsfwLevel` for the blur decision.
  if (opts.nsfw === false) q.set("nsfw", "false");
  if (opts.cursor) q.set("cursor", opts.cursor);

  const r = await httpFetch(`${API}/models?${q}`, {
    headers: readHeaders(opts.token), signal: opts.signal,
  });
  if (!r.ok) throw new CivitaiError(explain(r.status), r.status, r.status === 401);
  const d = await r.json() as { items?: CivitaiModel[]; metadata?: { nextCursor?: string } };
  return { items: d.items ?? [], nextCursor: d.metadata?.nextCursor ?? null };
}

export async function getModelDetails(modelId: number, token?: string): Promise<CivitaiModel> {
  const r = await httpFetch(`${API}/models/${modelId}`, { headers: readHeaders(token) });
  if (!r.ok) throw new CivitaiError(explain(r.status), r.status, r.status === 401);
  return await r.json() as CivitaiModel;
}

export async function getVersion(versionId: number, token?: string): Promise<CivitaiVersion> {
  const r = await httpFetch(`${API}/model-versions/${versionId}`, { headers: readHeaders(token) });
  if (!r.ok) throw new CivitaiError(explain(r.status), r.status, r.status === 401);
  return await r.json() as CivitaiVersion;
}

/* ── picking the right file out of a version ────────────────────────────── */

/**
 * The importable file in a version — the graph itself, or the archive holding it.
 *
 * MOST WORKFLOWS ON CIVITAI ARE ARCHIVES, and picking only `.json` is why the
 * hub could not import them. Measured against the live API (2026-08-20) over
 * 135 workflow models / 735 versions sampled across six queries and three
 * sort orders: **670 files are `type: "Archive"` with a `.zip` name and only
 * 72 are `Config`/`.json`** — so a selector that took the JSON alone resolved
 * 9.8% of versions and returned null for the other 90.2%. Null is what makes
 * the detail screen read "no importable file" and disable Import, i.e. the
 * failure looked like the MODEL having nothing to offer rather than like this
 * function refusing it.
 *
 * The machinery behind it was never the problem: `fetchWorkflowGraphs` sniffs
 * the bytes and unzips exactly this shape (and its own comment says four of
 * five downloads measured came back `application/zip`). It was reachable only
 * from a paste, because nothing would hand it an archive.
 *
 * Order is preference, not fallback: a version carrying a bare `.json` yields
 * the graph directly, and only then do we accept an archive to be opened. The
 * weights extensions are excluded explicitly — a LoRA version must still come
 * back null here so the workflows tab never offers a `.safetensors` as a graph.
 */
const ARCHIVE = /\.(zip)$/i;

export function workflowFile(v: CivitaiVersion): CivitaiFile | null {
  const files = (v.files ?? []).filter((f) => !/\.(safetensors|ckpt|pt|pth|gguf|bin)$/i.test(f.name));
  return files.find((f) => /\.json$/i.test(f.name))
    ?? files.find((f) => f.type === "Config")
    ?? files.find((f) => ARCHIVE.test(f.name) || f.type === "Archive")
    ?? null;
}

/**
 * Which ComfyUI directory a Civitai model type belongs in.
 *
 * A WEIGHT FILE IN THE WRONG DIRECTORY IS INVISIBLE to the loader that wants
 * it, which reads as "the download did nothing" rather than as a misfiled
 * file — so an unrecognised type returns null and the surface declines instead
 * of guessing. `engine_model_path` refuses an unknown kind for the same
 * reason; this is the browser half of that agreement.
 *
 * WHERE IT IS NECESSARILY IMPRECISE: Civitai has one "Checkpoint" type and
 * ComfyUI has two homes for one — `checkpoints/` for a full checkpoint a
 * `CheckpointLoaderSimple` opens, `diffusion_models/` for a transformer-only
 * file a `UNETLoader` does. Nothing in the listing distinguishes them (the
 * 20GB "Minimax H3 INT8/INT4 ConvRot" is filed as a Checkpoint and is really
 * the second kind), and inferring it from `baseModel` would be invented
 * knowledge that goes stale silently. So the surface NAMES the directory
 * before the download starts rather than pretending to know — a 20GB file in
 * the wrong folder is a move, not a re-fetch, once you can see where it went.
 */
export function modelDir(type: string | undefined): string | null {
  switch ((type ?? "").toLowerCase()) {
    case "lora":
    case "locon":
    case "dora":
    case "lycoris": return "loras";
    case "checkpoint": return "checkpoints";
    case "upscaler": return "upscale_models";
    case "vae": return "vae";
    case "textualinversion": return "embeddings";
    case "controlnet": return "controlnet";
    default: return null;
  }
}

/** The SHA256 Civitai publishes for a file, when it publishes one. The download
 *  verifies against it — a truncated checkpoint otherwise fails at model-load
 *  time with an error that names the model rather than the download. */
export const sha256Of = (f: CivitaiFile): string | undefined => {
  const h = f.hashes ?? {};
  const v = h.SHA256 ?? h.sha256 ?? h["SHA-256"];
  return typeof v === "string" && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : undefined;
};

/** The weights in a version — what a LoRA or checkpoint import downloads. */
export function weightFile(v: CivitaiVersion): CivitaiFile | null {
  const files = v.files ?? [];
  return files.find((f) => /\.(safetensors|gguf)$/i.test(f.name))
    ?? files.find((f) => f.type === "Model")
    ?? null;
}

/* ── preview media ──────────────────────────────────────────────────────── */
//
// MOST PREVIEWS ARE VIDEOS on the model types this hub is for. Of the top four
// MiniMax H3 workflow results, every showcase item on the two that have one is
// an `.mp4` — so a card that renders only `type !== "video"` shows a grey
// placeholder for the majority of a video-workflow search, which is exactly
// what the grid looked like. Media carries its own type and the card decides.

export interface CivitaiMedia extends CivitaiImage {
  /** the author's own showcase, or a community post */
  from: "author" | "community";
  /** which version the author attached it to */
  versionName?: string;
}

export const isVideo = (m: { type?: string; url?: string }): boolean =>
  m.type === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(m.url ?? "");

/**
 * Whether a piece of media should open blurred.
 *
 * Two spellings reach this, and they are not interchangeable: a version's
 * images carry Civitai's numeric browsing level (1 = PG … 32 = blocked) while
 * `/api/v1/images` carries the name ("None", "Soft", "Mature", "X", "XXX").
 * Reading one as the other is silent — `"Mature" > 2` is false in JS, so every
 * gallery item would come back safe.
 */
export function explicit(level?: number | string, modelNsfw?: boolean): boolean {
  if (typeof level === "number") return level > 2;         // above PG-13
  if (typeof level === "string") {
    return ["mature", "x", "xxx", "blocked"].includes(level.toLowerCase());
  }
  return !!modelNsfw;
}

/* ── asking the CDN for a size ──────────────────────────────────────────── */
//
// A CIVITAI PREVIEW IS NOT A THUMBNAIL AND CAN BE ENORMOUS. Measured on the
// four videos of one workflow page: 4.2MB, 8.4MB, 25MB and **161MB** — for a
// single preview. Rendering a gallery of 36 of those as <video preload=
// "metadata"> pulled every one of them to readyState 4, i.e. opening one model
// could cost hundreds of megabytes and 36 live decoders.
//
// The fix is in the URL. Civitai's media URLs carry a TRANSFORM segment —
// `…/<uuid>/<transform>/<file>`, normally `original=true` — and two rewrites
// were measured deterministic across every asset tried:
//
//   · IMAGES take `width=N,optimized=true` → webp. 1.59MB became 19.6KB.
//   · VIDEOS take `anim=false` → a poster JPEG, 180-435KB. 5 of 5.
//
// What does NOT work, so do not "improve" it: width is IGNORED on a video
// (`anim=false,width=200` returns the same bytes as `anim=false`), and
// combining transforms on a video is unreliable — `anim=false,optimized=true`
// returned a JPEG for one asset and the untouched 4MB mp4 for the next. Bare
// `anim=false` is the only spelling that always returned an image.
// `transcode=true,width=N` does produce a small mp4, but the first request for
// one can serve the ORIGINAL while the CDN builds it (2.3MB where a later hit
// gave 21KB), and unpredictable is the one thing a grid of 24 cannot be.

const CDN = /^https:\/\/image\.civitai\.com\//;

/**
 * The same media at the size a surface actually needs.
 *
 * `thumb` and `card` never fetch a video: they ask for its poster frame, which
 * is why the gallery strip and the search grid are <img> throughout. `hero` is
 * the real thing. Anything that is not a Civitai CDN URL is returned untouched.
 */
export function mediaUrl(
  m: { url: string; type?: string },
  want: "thumb" | "card" | "hero" | "poster",
): string {
  if (!CDN.test(m.url)) return m.url;
  const parts = m.url.split("/");
  if (parts.length < 6) return m.url;                 // not the shape we know
  const at = parts.length - 2;                        // the transform segment
  const video = isVideo(m);
  const transform =
    want === "hero" ? (video ? "original=true" : "width=1200,optimized=true")
    : video ? "anim=false"
    : `width=${want === "card" ? 400 : 200},optimized=true`;
  parts[at] = transform;
  return parts.join("/");
}

/** The author's showcase, flattened across versions in the order they list. */
export function showcaseMedia(m: CivitaiModel): CivitaiMedia[] {
  const seen = new Set<string>();
  const out: CivitaiMedia[] = [];
  for (const v of m.modelVersions ?? []) {
    for (const img of v.images ?? []) {
      if (!img.url || seen.has(img.url)) continue;
      seen.add(img.url);
      out.push({ ...img, from: "author", versionName: v.name });
    }
  }
  return out;
}

/** The first thing worth putting on a card — video or still, whichever comes. */
export const firstPreview = (m: CivitaiModel): CivitaiMedia | null =>
  showcaseMedia(m)[0] ?? null;

/**
 * The community gallery for a model.
 *
 * Worth a second request because it is a DISJOINT set from the version images:
 * measured on the top H3 workflow, 16 gallery items and 20 showcase items with
 * **zero** URLs in common. Neither one alone is the model's media.
 *
 * `meta` (generation parameters) is not requested and would not arrive: every
 * item comes back with it empty, with a valid API token as well as without.
 */
export async function getModelImages(
  modelId: number,
  opts: { limit?: number; token?: string; signal?: AbortSignal } = {},
): Promise<CivitaiMedia[]> {
  const q = new URLSearchParams({ modelId: String(modelId), limit: String(opts.limit ?? 30) });
  const r = await httpFetch(`${API}/images?${q}`, {
    headers: readHeaders(opts.token), signal: opts.signal,
  });
  if (!r.ok) throw new CivitaiError(explain(r.status), r.status, r.status === 401);
  const d = await r.json() as { items?: CivitaiImage[] };
  return (d.items ?? []).filter((i) => i.url).map((i) => ({ ...i, from: "community" as const }));
}

/**
 * A download URL that selects one file.
 *
 * `/api/download/models/<id>` takes a model VERSION id, and a FILE id in that
 * slot does not 404 — it serves a DIFFERENT model's weights with a 200 and a
 * valid content type — measured once as a 597MB file arriving as 61MB. So
 * the version id is what goes in the path and the file is selected by query,
 * never by swapping the id.
 */
export function downloadUrlFor(v: CivitaiVersion, f: CivitaiFile): string {
  const base = `https://civitai.com/api/download/models/${v.id}`;
  return (v.files ?? []).length > 1 ? `${base}?fileId=${f.id}` : base;
}

/* ── fetching the graph itself ──────────────────────────────────────────── */

const looksLikeHtml = (s: string) => /^\s*<(!doctype|html)/i.test(s);

/* ── ZIP, because most workflow downloads are one ────────────────────────── */
//
// MEASURED, not assumed: of five public Civitai workflow downloads fetched
// with a token, FOUR came back `application/zip` and one came back raw JSON.
// One of the four was a 67MB archive of preview PNGs with the graph inside it.
// So a client that only understands JSON fails on the common case, and the
// honest-looking error ("the download is not JSON") would be wrong about why.
//
// Implemented here rather than with a library: it is one archive format read
// once, `DecompressionStream` does the actual inflating, and adding a zip
// dependency to the browser bundle for this is not a trade worth making.

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else we decline rather than guess. */
  method: number;
  compressedSize: number;
  size: number;
  /** offset of the LOCAL header, which is where the data actually starts */
  offset: number;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);

/** Read the central directory. Returns [] when this is not a zip at all. */
export function listZip(buf: ArrayBuffer): ZipEntry[] {
  const v = new DataView(buf);
  if (buf.byteLength < 22) return [];
  // The End Of Central Directory record is last, but a zip comment may follow
  // it, so it is found by scanning backwards for its signature.
  let eocd = -1;
  const min = Math.max(0, buf.byteLength - 66_000);
  for (let i = buf.byteLength - 22; i >= min; i--) {
    if (u32(v, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];

  const count = u16(v, eocd + 10);
  let p = u32(v, eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.byteLength; i++) {
    if (u32(v, p) !== 0x02014b50) break;
    const nameLen = u16(v, p + 28), extraLen = u16(v, p + 30), commentLen = u16(v, p + 32);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    out.push({
      name,
      method: u16(v, p + 10),
      compressedSize: u32(v, p + 20),
      size: u32(v, p + 24),
      offset: u32(v, p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Inflate one entry to text. */
export async function readZipEntry(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  const v = new DataView(buf);
  if (u32(v, e.offset) !== 0x04034b50) throw new CivitaiError(`corrupt archive entry "${e.name}"`);
  // The local header repeats the name and extra fields, and its extra field
  // length routinely DIFFERS from the central directory's — so the data offset
  // must be computed from the local header, never from the central one.
  const dataAt = e.offset + 30 + u16(v, e.offset + 26) + u16(v, e.offset + 28);
  const raw = new Uint8Array(buf, dataAt, e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(raw);
  if (e.method !== 8) throw new CivitaiError(`"${e.name}" uses an unsupported compression method (${e.method})`);

  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([raw]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

/** Entries worth trying to import: a graph is a .json, and __MACOSX metadata
 *  and dot-files are archive noise rather than content. */
const isGraphEntry = (e: ZipEntry) =>
  /\.json$/i.test(e.name)
  && !e.name.startsWith("__MACOSX/")
  && !e.name.split("/").pop()!.startsWith(".");

export interface WorkflowCandidate {
  name: string;
  graph: unknown;
}

/**
 * Download whatever Civitai has behind this URL and return every ComfyUI graph
 * in it.
 *
 * Three shapes come back from the same endpoint, and telling them apart is the
 * whole job: a raw JSON graph, a ZIP containing one or more, and — for a
 * gated download — **200 with the model's HTML page**. That last one is why
 * the sniff is on the BYTES rather than the status: without it an HTML
 * document is stored as a workflow and only discovered at render time.
 */
export async function fetchWorkflowGraphs(url: string, token?: string): Promise<WorkflowCandidate[]> {
  let r: Awaited<ReturnType<typeof httpFetch>>;
  try {
    r = await httpFetch(url, { headers: authHeaders(token), redirect: "follow" });
  } catch (e) {
    // Search is CORS-open; DOWNLOADS ARE NOT — `/api/download/*` sends no
    // `access-control-allow-origin`, so a browser refuses the request before
    // Civitai sees it and hands back a bare "Failed to fetch" with no hint of
    // why. The desktop build goes through Rust and is not subject to this.
    if (!isDesktop()) {
      throw new CivitaiError(
        "The browser cannot download from Civitai — it allows cross-origin search but not "
        + "downloads, so the request never leaves the page. Use the desktop app, or open the "
        + "model on Civitai and paste its workflow JSON into the paste tab.");
    }
    throw new CivitaiError(`could not reach Civitai — ${String((e as Error).message || e)}`);
  }
  if (!r.ok) throw new CivitaiError(explain(r.status), r.status, r.status === 401 || r.status === 403);

  const buf = await r.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));

  // "PK\x03\x04"
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const entries = listZip(buf).filter(isGraphEntry);
    if (!entries.length) {
      const all = listZip(buf);
      throw new CivitaiError(
        `the archive has no .json workflow in it (${all.length} file(s): `
        + `${all.slice(0, 4).map((e) => e.name).join(", ")}${all.length > 4 ? "…" : ""})`);
    }
    const out: WorkflowCandidate[] = [];
    for (const e of entries.slice(0, 24)) {
      try {
        out.push({ name: e.name.split("/").pop() ?? e.name, graph: JSON.parse(await readZipEntry(buf, e)) });
      } catch {
        // one unreadable entry in a multi-graph archive must not lose the rest
      }
    }
    if (!out.length) throw new CivitaiError("every .json in the archive failed to parse");
    return out;
  }

  const body = new TextDecoder().decode(buf);
  if (looksLikeHtml(body)) {
    throw new CivitaiError(
      token
        ? "Civitai served its web page instead of the file — this download is restricted to "
          + "accounts with access, or the creator disabled downloads."
        : "Civitai requires an API token for downloads. It answers 200 with an HTML page when "
          + "there isn't one, so this would otherwise have been saved as a broken workflow. "
          + "Add a token below, or paste the workflow JSON directly.",
      r.status, true,
    );
  }
  try {
    return [{ name: "workflow.json", graph: JSON.parse(body) }];
  } catch {
    throw new CivitaiError(`the download is neither JSON nor a zip (${buf.byteLength} bytes)`);
  }
}

/* ── the token ──────────────────────────────────────────────────────────── */

const TOKEN_KEY = "qamba.civitai.token";

/**
 * The token lives in localStorage, and ONLY on the desktop build.
 *
 * On the web it would be a third-party credential held in a browser origin
 * that already ships a Supabase anon key — one more thing an XSS gets for
 * free, to buy a feature (downloading weights) that the web build cannot use
 * anyway, since it has nowhere to put a 12GB file. The web hub searches
 * anonymously and imports by paste.
 */
export const getToken = (): string | undefined => {
  if (!isDesktop()) return undefined;
  return localStorage.getItem(TOKEN_KEY) || undefined;
};

export const setToken = (t: string | null) => {
  if (!isDesktop()) return;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
};

/** Downloads need a token; search does not. Surfaces are expected to say so
 *  BEFORE the user picks something, not after the download fails. */
export const canDownload = (): boolean => isDesktop() && !!getToken();

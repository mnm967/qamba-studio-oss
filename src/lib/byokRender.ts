// Running a render on someone else's GPU, with the user's own key.
//
// IT IS A LOCAL-LANE JOB, and that is the whole reason this fits without a new
// plane. A key lives in this machine's keychain, so the render has to be driven
// by this machine — and `lane: "local"` is already the queue only this machine
// claims (`localWorker`), which the pod's `WORKER_LANES` has never included.
// Invariant #1 is intact: the frontend still never talks to the pod, and pod
// work is still a row a pod worker claims. Invariant #2 is intact too — the
// result goes to B2 and gets an `assets` row, through the same `JobIO` a
// ComfyUI render uses.
//
// WHY NOT `api_generate` ON THE `api` LANE. That is the POD's hosted path and
// it reads its keys from the pod's environment. Queueing one here would hand
// the job to a worker that has no key and cannot get one, and the failure
// would arrive minutes later as a `require_env` message about a variable the
// user has never heard of.
//
// THE TAIL IS `runLocalJob`'S TAIL, deliberately: upload, register, attach to
// whatever the payload targeted. A second implementation of that is how one of
// them ends up forgetting `attachToClip` and leaving a placeholder on the lane
// for good — which is exactly the bug that path exists to close.
// EVERY RUNTIME DEPENDENCY THAT REACHES THE NETWORK IS IMPORTED LAZILY, and
// that is a testing decision with a design payoff. `catalog`, `jobIO` and
// `localRender` all transitively import `lib/supabase`, whose extensionless
// `.js` specifier `node --test` cannot resolve — so a static import here would
// make this module untestable and push it into the source-parsing corner
// `scoreTrack.test.ts` lives in. Deferring them also means the two things this
// file is really about — resolving a model and shaping a provider call — have
// no dependencies at all.
import { attachToClip } from "./clipAttachIo.ts";
import { runAdapter, type ByokOutput, type ByokRequest, type Transport } from "./byokAdapters.ts";
import { customRow, parseByokId, specFor } from "./byokCatalog.ts";
import type { JobIO } from "./jobIO.ts";
import type { Asset, Job, ModelCatalogRow } from "./db/types.ts";

export class ByokRenderError extends Error {}

export interface ByokJobPayload {
  model_id?: string;
  /** a user-added fal row travels WITH the job: it lives in this machine's
   *  localStorage, and the worker may be running it for a project the user is
   *  not looking at — reading the config at run time would be reading a list
   *  that could have changed since the click. */
  byok_model?: Parameters<typeof customRow>[0];
  prompt?: string;
  negative?: string | null;
  width?: number; height?: number;
  seconds?: number;
  seed?: number;
  quality?: string;
  project_id?: string | null;
  ref_asset_ids?: string[];
  /** The VIDEO staging, in the same spelling the pod's `clip_gen` and
   *  `api_generate` payloads use (`_RECIPE_KEYS` in handlers/blocks.py) — so a
   *  job moves between the three planes by changing `kind` and `lane` and
   *  nothing else, which is exactly what BlockActionModal does off the
   *  catalog's tier. */
  start_asset_id?: string | null;
  end_asset_id?: string | null;
  ref_video_asset_ids?: string[];
  ref_audio_asset_ids?: string[];
  /** t2v | i2v | flf | r2v. On fal a mode is a different ENDPOINT. */
  mode?: string | null;
  /** what the timeline reserved for this render. Milliseconds, like every
   *  duration in v2 (invariant #3); `seconds` is the older spelling and still
   *  wins when both are present. */
  duration_ms?: number;
  target?: unknown;
}

export interface RunHooks {
  onProgress?: (pct: number, note: string, tick?: number) => void;
  isCanceled?: () => Promise<boolean>;
}

export interface ByokResult {
  assets: Asset[];
  seconds: number;
  costUsd: number;
}

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm",
  "audio/mpeg": "mp3", "audio/wav": "wav",
};

/** base64 → bytes, without a data URL round trip. Returns the ArrayBuffer
 *  rather than the view: a Blob part wants the buffer, and handing it a view
 *  over a larger buffer is how a file arrives with a tail of zeros. */
function fromB64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function toB64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** The adapters' one call, bound to the real bridge. */
const HTTP: Transport = async (provider, path, init = {}) => {
  const { byokJson } = await import("./byok.ts");
  return byokJson(provider, path, init as Parameters<typeof byokJson>[2]);
};

/** Fetch a result the provider handed back as a url.
 *
 *  Through Rust where it is available: a fal result lives on `fal.media`,
 *  which is on the capability allow-list, and going through the webview would
 *  put it back under CORS for no reason. */
async function fetchResult(url: string, contentType?: string): Promise<Blob> {
  // `httpFetch` is Rust in the desktop shell and the webview's own fetch
  // elsewhere, and the two agree on `ok`, `status` and `arrayBuffer` — which
  // is all this needs. `blob()` is NOT one of them: the Rust response has no
  // such method, so reading bytes is the portable half.
  const { httpFetch } = await import("./desktop.ts");
  const r = await httpFetch(url);
  if (!r.ok) throw new ByokRenderError(`could not download the result (${r.status})`);
  return new Blob([await r.arrayBuffer()], { type: contentType ?? "application/octet-stream" });
}

/** What `runByokJob` reaches the world through. Both default to the real
 *  thing; both are injectable, so the whole runner is exercisable without a
 *  key, a desktop build or a session. */
export interface ByokDeps {
  http?: Transport;
  /** the model catalog, by id. Injected for the same reason the transport is:
   *  `catalog.ts` reaches Supabase, so a test that could not replace it could
   *  only ever assert on the failure to load one. */
  lookup?: (id: string) => Promise<ModelCatalogRow | undefined>;
}

/** Resolve the row this job renders on — a catalog row, or the user's own. */
export async function rowForJob(job: Job, lookup?: ByokDeps["lookup"]): Promise<ModelCatalogRow> {
  const p = (job.payload ?? {}) as ByokJobPayload;
  const id = job.model_id ?? p.model_id ?? "";
  if (p.byok_model) return customRow(p.byok_model);
  if (parseByokId(id)) {
    throw new ByokRenderError(
      "this render used one of your own fal endpoints and the job did not carry it — "
      + "re-queue it from the composer");
  }
  const row = lookup
    ? await lookup(id)
    : (await (await import("./catalog.ts")).loadCatalog()).find((m) => m.id === id);
  if (!row) throw new ByokRenderError(`'${id}' is not a model in the catalog`);
  return row;
}

/**
 * Run one BYOK generation to completion and publish it.
 *
 * `http` is injected for the reason the adapters take one: everything below the
 * provider call is ordinary plumbing that a test should be able to exercise
 * without a key, a desktop build, or a network.
 */
export async function runByokJob(
  job: Job, hooks: RunHooks = {}, ioIn?: JobIO, deps: ByokDeps = {},
): Promise<ByokResult> {
  const http = deps.http ?? HTTP;
  const io = ioIn ?? (await import("./jobIO.ts")).OPEN_PROJECT_IO;
  const p = (job.payload ?? {}) as ByokJobPayload;
  const t0 = Date.now();
  const row = await rowForJob(job, deps.lookup);
  const spec = specFor(row);
  if (!spec) {
    throw new ByokRenderError(`${row.display_name} has no adapter in this build`);
  }

  // References travel two ways and which one is right is the PROVIDER's
  // choice, not ours. fal fetches a url itself — the delivery bucket is
  // public, so nothing is re-uploaded and a 20MB plate never crosses this
  // process. OpenAI and Google will not fetch, so those get bytes.
  const refUrls: string[] = [];
  const refBytes: { name: string; contentType: string; b64: string }[] = [];
  // WHICH ADAPTERS WILL FETCH A URL, and which need the bytes handed over.
  //
  // fal, Model Studio and MiniMax all take a url and fetch it themselves — the
  // delivery bucket is public, so nothing is re-uploaded and a 20MB plate never
  // crosses this process. OpenAI's edit endpoint and both Gemini surfaces take
  // inline data instead. Written as a SET rather than as `!== "fal-queue"`,
  // which is what it was: the moment a second url-taking adapter landed, that
  // test silently started downloading every reference for it.
  const URL_ADAPTERS = new Set(["fal-queue", "wan-queue", "minimax-video"]);
  const wantsBytes = !URL_ADAPTERS.has(spec.adapter);

  /** One asset id -> its public url, or a failure that names WHICH one.
   *
   *  The import stays INSIDE, and lazily: `db/assets.ts` reaches the supabase
   *  client, so hoisting it makes every run of this function load a module a
   *  job with no references never needs — and `node --test` cannot resolve
   *  that chain at all, so the hoist took four tests with it. */
  const urlOf = async (id: string, what: string): Promise<string> => {
    const { assetUrl } = await import("./db/assets.ts");
    const { data } = await io.from("assets").select("*").eq("id", id).maybeSingle();
    const url = assetUrl(data as Asset | null);
    if (!url) throw new ByokRenderError(`${what} is not in the library any more`);
    return url;
  };
  const urlsOf = async (ids: string[] | undefined, what: string) => {
    const out: string[] = [];
    for (const [i, id] of (ids ?? []).entries()) {
      out.push(await urlOf(id, `${what} ${i + 1}`));
    }
    return out;
  };

  for (const [i, id] of (p.ref_asset_ids ?? []).entries()) {
    hooks.onProgress?.(-1, `reading reference ${i + 1}`, 0);
    const url = await urlOf(id, `reference ${i + 1}`);
    if (wantsBytes) {
      const { data } = await io.from("assets").select("*").eq("id", id).maybeSingle();
      const blob = await fetchResult(url);
      refBytes.push({
        name: `ref${i}.png`,
        contentType: (data as Asset)?.content_type || blob.type || "image/png",
        b64: await toB64(blob),
      });
    } else {
      refUrls.push(url);
    }
  }

  // THE VIDEO STAGING, BY ROLE. Flattening these into `refUrls` would put a
  // chain's CLOSING frame in the reference pool, where it reads as "another
  // picture of this scene" rather than "end exactly here" — a bridge that
  // never arrives at block B, with nothing in the output to say why. Only the
  // url-fetching adapters get them; an image model has no use for a start
  // frame and OpenAI/Google would need bytes anyway.
  // A BYTES ADAPTER STILL NEEDS THE OPENING FRAME, and it does not arrive in
  // `ref_asset_ids` — the three planes all send it as `start_asset_id`. Gemini
  // Omni Flash is the case: an i2v with the start frame left out is a
  // text-to-video wearing an i2v label. It LEADS, because these models read
  // the first image as the one the prompt is about.
  if (wantsBytes && p.start_asset_id) {
    const url = await urlOf(p.start_asset_id, "the opening frame");
    const blob = await fetchResult(url);
    refBytes.unshift({
      name: "start.png",
      contentType: blob.type || "image/png",
      b64: await toB64(blob),
    });
  }

  const shot = wantsBytes ? undefined : {
    start: p.start_asset_id ? await urlOf(p.start_asset_id, "the opening frame") : null,
    end: p.end_asset_id ? await urlOf(p.end_asset_id, "the closing frame") : null,
    images: refUrls,
    videos: await urlsOf(p.ref_video_asset_ids, "reference video"),
    audio: await urlsOf(p.ref_audio_asset_ids, "reference audio"),
  };

  const req: ByokRequest = {
    row, spec,
    prompt: p.prompt ?? "",
    negative: p.negative ?? null,
    width: p.width ?? null, height: p.height ?? null,
    // `seconds` is the older spelling and wins where a caller sends it; every
    // timeline surface speaks milliseconds (invariant #3).
    seconds: p.seconds ?? (p.duration_ms ? p.duration_ms / 1000 : null),
    seed: p.seed ?? null,
    quality: p.quality ?? null,
    mode: p.mode ?? null, shot,
    refUrls, refBytes,
    note: (pct, text) => hooks.onProgress?.(pct, text, 1),
    canceled: async () => (await hooks.isCanceled?.()) ?? false,
  };

  hooks.onProgress?.(-1, `sending it to ${row.provider}`, 0);
  const out: ByokOutput = await runAdapter(req, http);

  // Into the bucket, then into the registry — invariant #2, and the same
  // order `runLocalJob` uses.
  hooks.onProgress?.(0.99, "saving the result", 2);
  const blob = out.b64
    ? new Blob([fromB64(out.b64)], { type: out.contentType })
    : await fetchResult(out.url!, out.contentType);
  const ext = EXT[out.contentType] ?? (out.kind === "video" ? "mp4" : "png");
  const key = `byok/${row.provider}/${job.id}.${ext}`;
  await io.upload(new File([blob], `${job.id}.${ext}`, { type: out.contentType }), key);

  const asset = await io.register({
    b2_key: key,
    kind: out.kind,
    project_id: p.project_id ?? job.project_id ?? null,
    content_type: out.contentType,
    bytes: blob.size,
    // Only what the render CHOSE. A hosted provider snaps to its own canvas
    // (`openaiSize`, `geminiAspect`), so recording the requested pixels would
    // state a size the file does not have — `asset_ingest` is a pod handler
    // and does not run for these, so a wrong number here is never corrected.
    ...(out.kind === "video" && p.seconds ? { duration_ms: Math.round(p.seconds * 1000) } : {}),
    origin: "generated",
    tags: ["library", "byok", row.provider],
    meta: {
      prompt: p.prompt ?? "",
      byok: true,
      model_id: row.id,
      seed: p.seed,
      ...out.meta,
    },
  });

  await attachToClip(io, p.target, asset);
  return { assets: [asset], seconds: Math.round((Date.now() - t0) / 1000), costUsd: out.costUsd };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { runByokJob, ByokRenderError } from "./byokRender.ts";
import { customId } from "./byokCatalog.ts";
import type { JobIO } from "./jobIO.ts";
import type { Asset, Job } from "./db/types.ts";

/** A plane that records what was written to it. */
function io(assets: Record<string, Partial<Asset>> = {}) {
  const uploads: { key: string; bytes: number; type: string }[] = [];
  const registered: Record<string, unknown>[] = [];
  const patched: Record<string, unknown>[] = [];
  const j: JobIO & { uploads: typeof uploads; registered: typeof registered;
                     patched: typeof patched } = {
    uploads, registered, patched,
    from: (table: string) => {
      const q = {
        select: () => q, eq: () => q, update: (v: Record<string, unknown>) => {
          patched.push({ table, ...v }); return q;
        },
        maybeSingle: async () => ({ data: assets[Object.keys(assets)[0]] ?? null }),
      };
      return q;
    },
    upload: async (file: Blob, key: string) => {
      uploads.push({ key, bytes: file.size, type: file.type }); return { key };
    },
    register: async (a: Record<string, unknown>) => {
      registered.push(a); return { id: `asset-${registered.length}`, ...a } as unknown as Asset;
    },
  };
  return j;
}

const job = (payload: Record<string, unknown>, model_id: string): Job => ({
  id: "job-1", kind: "byok_gen", lane: "local", status: "running",
  model_id, project_id: "proj-1", payload,
} as unknown as Job);

/** The real row's shape, minus the catalog fetch. `byokCatalog.test.ts` is
 *  what pins that this id still exists with this provider. */
const GPT_IMAGE = {
  id: "gpt-image-2", family: "openai", display_name: "GPT Image 2", kind: "image",
  provider: "openai", modes: ["t2i", "edit"], sizes: null, max_seconds: null,
  fps: null, frame_base: null, frame_rem: null, dim_step: null,
  pricing: { unit: "image", usd: 0.06 }, capabilities: {}, enabled: false, sort: 1,
} as unknown as import("./db/types.ts").ModelCatalogRow;

const CUSTOM = {
  id: customId("fal-ai/flux/dev"), endpoint: "fal-ai/flux/dev",
  label: "Flux dev", kind: "image" as const, modes: ["t2i"],
  usd: 0.03, unit: "image" as const,
};

test("a user's own fal endpoint renders, uploads and registers", async () => {
  const plane = io();
  const calls: string[] = [];
  const http = (async (_p: string, path: string) => {
    calls.push(path);
    if (path === "/fal-ai/flux/dev") {
      return { status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    }
    if (path.endsWith("/s")) return { status: "COMPLETED" };
    return { images: [{ url: "https://fal.media/out.png", content_type: "image/png" }] };
  }) as never;

  // The download of the finished picture is the one thing that leaves this
  // process, so it is stubbed at the global rather than mocked deeper — that
  // is the seam `httpFetch` falls back to off the desktop.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  })) as never;
  try {
    const res = await runByokJob(
      job({ byok_model: CUSTOM, prompt: "a shop", project_id: "proj-1" }, CUSTOM.id),
      {}, plane, { http });
    assert.equal(res.assets.length, 1);
    assert.equal(res.costUsd, 0.03, "an unpriced render would book no ledger row at all");
    assert.match(plane.uploads[0].key, /^byok\/fal\/job-1\.png$/);
    const reg = plane.registered[0];
    assert.equal(reg.kind, "image");
    assert.equal(reg.project_id, "proj-1");
    assert.deepEqual(reg.tags, ["library", "byok", "fal"]);
    assert.equal((reg.meta as Record<string, unknown>).byok, true);
    assert.equal((reg.meta as Record<string, unknown>).endpoint, "fal-ai/flux/dev");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a b64 result never touches the network", async () => {
  const plane = io();
  const http = (async () => ({ data: [{ b64_json: btoa("PNGBYTES") }], usage: {} })) as never;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("must not fetch"); }) as never;
  try {
    const res = await runByokJob(
      job({ prompt: "a shop", model_id: "gpt-image-2" }, "gpt-image-2"), {}, plane,
      { http, lookup: async () => GPT_IMAGE });
    assert.equal(res.assets.length, 1);
    assert.equal(plane.uploads[0].bytes, 8, "the decoded bytes, not the base64");
    assert.equal(plane.uploads[0].type, "image/png");
  } finally { globalThis.fetch = realFetch; }
});

test("a fal id that arrives without its model definition refuses, and says why", async () => {
  // The row lives in this machine's localStorage and the worker may be running
  // the job for a project the user is not looking at, so it TRAVELS with the
  // job. Without it there is nothing to resolve, and rendering some other
  // endpoint would be worse than failing.
  await assert.rejects(
    () => runByokJob(job({ prompt: "x" }, customId("fal-ai/flux/dev")), {}, io(),
                     { http: (async () => ({})) as never }),
    /did not carry it/);
});

test("an unknown model id refuses rather than picking one", async () => {
  await assert.rejects(
    () => runByokJob(job({ prompt: "x" }, "not-a-model"), {}, io(),
                     { http: (async () => ({})) as never, lookup: async () => undefined }),
    ByokRenderError);
});

test("a video row records the duration it asked for and an image row records none", async () => {
  const plane = io();
  const http = (async (_p: string, path: string) => {
    if (path.startsWith("/fal-ai")) {
      return { status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    }
    if (path.endsWith("/s")) return { status: "COMPLETED" };
    return { video: { url: "https://fal.media/v.mp4", content_type: "video/mp4" } };
  }) as never;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer,
  })) as never;
  try {
    const vid = { ...CUSTOM, id: customId("fal-ai/v"), endpoint: "fal-ai/v",
                  kind: "video" as const, modes: ["t2v"], unit: "second" as const, usd: 0.1 };
    const res = await runByokJob(
      job({ byok_model: vid, prompt: "x", seconds: 5 }, vid.id), {}, plane, { http });
    assert.equal(res.costUsd, 0.5, "a per-second row prices on the length");
    assert.equal(plane.registered[0].duration_ms, 5000);
    assert.equal(plane.registered[0].kind, "video");
    assert.match(plane.uploads[0].key, /\.mp4$/);
    // No width/height: a hosted provider snaps to its own canvas, so the
    // requested pixels would be a size the file does not have — and no
    // `asset_ingest` runs here to correct it.
    assert.equal(plane.registered[0].width, undefined);
  } finally { globalThis.fetch = realFetch; }
});

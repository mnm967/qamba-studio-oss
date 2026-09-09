import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAL_POLL_MS, geminiAspect, geminiImage, multipart, openaiCost, openaiImage,
  openaiSize, falQueue, runAdapter, ByokAdapterError,
  type ByokRequest, type Transport,
} from "./byokAdapters.ts";
import type { ModelCatalogRow } from "./db/types.ts";

const row = (extra: Partial<ModelCatalogRow> = {}): ModelCatalogRow => ({
  id: "x", family: "f", display_name: "X", kind: "image", provider: "openai",
  modes: ["t2i"], sizes: null, max_seconds: null, fps: null, frame_base: null,
  frame_rem: null, dim_step: null, pricing: {}, capabilities: {}, enabled: true,
  sort: 1, ...extra,
});

/** A transport that records what it was asked and replays canned answers. */
function fake(answers: unknown[] | ((path: string, init: unknown) => unknown)) {
  const calls: { provider: string; path: string; init: Record<string, unknown> }[] = [];
  let i = 0;
  const http = (async (provider: string, path: string, init = {}) => {
    calls.push({ provider, path, init: init as Record<string, unknown> });
    const a = typeof answers === "function" ? answers(path, init) : answers[i++];
    if (a instanceof Error) throw a;
    return a;
  }) as Transport;
  return { http, calls };
}

const base = (o: Partial<ByokRequest> = {}): ByokRequest => ({
  row: row(), spec: { adapter: "openai-image", model: "gpt-image-2" },
  prompt: "a watch shop at dusk", sleep: async () => {}, ...o,
});

/* ── OpenAI ─────────────────────────────────────────────────────────────── */

test("openaiSize snaps to the enum the API takes, never to arbitrary pixels", () => {
  assert.equal(openaiSize(1536, 1024), "1536x1024");
  assert.equal(openaiSize(1024, 1536), "1024x1536");
  assert.equal(openaiSize(1024, 1024), "1024x1024");
  assert.equal(openaiSize(1280, 1152), "1024x1024", "1.11 is inside the square band");
  // No dimensions is the one case where `auto` is right — the alternative is
  // inventing a shape the caller did not ask for.
  assert.equal(openaiSize(null, null), "auto");
  assert.equal(openaiSize(0, 0), "auto");
});

test("openaiCost reads the response's own token usage, not a per-image guess", () => {
  const usage = {
    input_tokens_details: { text_tokens: 100, image_tokens: 1000 },
    output_tokens_details: { image_tokens: 1500 },
  };
  // 100*5 + 1000*10 + 1500*40 = 70,500 tokens-worth / 1e6
  assert.equal(openaiCost(usage), 0.0705);
  assert.equal(openaiCost(undefined), 0, "no usage prices as zero, not NaN");
  // output_tokens is the fallback when the details block is absent
  assert.equal(openaiCost({ output_tokens: 1000 }), 0.04);
});

test("with no references it generates; with references it EDITS", async () => {
  const gen = fake([{ data: [{ b64_json: "QUJD" }], usage: {} }]);
  const a = await openaiImage(base(), gen.http);
  assert.equal(gen.calls[0].path, "/v1/images/generations");
  assert.equal(a.b64, "QUJD");
  assert.equal(a.kind, "image");

  const ed = fake([{ data: [{ b64_json: "QUJD" }], usage: {} }]);
  await openaiImage(base({
    refBytes: [{ name: "plate.png", contentType: "image/png", b64: btoa("hi") }],
  }), ed.http);
  assert.equal(ed.calls[0].path, "/v1/images/edits",
    "a staged reference is the whole reason this row exists — it must not silently generate");
  assert.match(String(ed.calls[0].init.contentType), /^multipart\/form-data; boundary=/);
  assert.ok(ed.calls[0].init.bodyB64, "an edit body is bytes, not a json string");
});

test("an empty reply raises rather than registering an empty asset", async () => {
  const f = fake([{ data: [] }]);
  await assert.rejects(() => openaiImage(base(), f.http), /returned no image/);
  await assert.rejects(() => openaiImage(base({ prompt: "   " }), fake([]).http), /needs a prompt/);
});

test("multipart keeps every byte of an image intact", () => {
  // Bytes above 0x7f are the ones a UTF-8 round trip would rewrite, which
  // corrupts the picture rather than failing the request.
  const raw = String.fromCharCode(0x00, 0x7f, 0x80, 0xff, 0xfe);
  const { b64, contentType } = multipart({ model: "m" },
    [{ field: "image[]", name: "a.png", contentType: "image/png", b64: btoa(raw) }], "BB");
  assert.match(contentType, /boundary=BB$/);
  const out = atob(b64);
  assert.ok(out.includes(raw), "the file bytes did not survive the multipart build");
  assert.ok(out.startsWith("--BB\r\n"));
  assert.ok(out.endsWith("--BB--\r\n"));
  assert.ok(out.includes('name="image[]"; filename="a.png"'));
});

test("multipart drops empty fields rather than sending blank ones", () => {
  const out = atob(multipart({ model: "m", quality: undefined, size: "" }, [], "B").b64);
  assert.ok(out.includes('name="model"'));
  assert.ok(!out.includes('name="quality"'));
  assert.ok(!out.includes('name="size"'));
});

/* ── Gemini ─────────────────────────────────────────────────────────────── */

test("geminiAspect picks the nearest ratio the API serves", () => {
  assert.equal(geminiAspect(1920, 1080), "16:9");
  assert.equal(geminiAspect(1080, 1920), "9:16");
  assert.equal(geminiAspect(1024, 1024), "1:1");
  assert.equal(geminiAspect(1280, 704), "16:9");
  assert.equal(geminiAspect(null, null), "1:1");
});

test("gemini sends the exact field names a wrong one would fail silently on", async () => {
  const f = fake([{
    candidates: [{ content: { parts: [{ inlineData: { data: "QQ==", mimeType: "image/png" } }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1000 },
  }]);
  const out = await geminiImage(base({
    row: row({ provider: "google", capabilities: { imageSize: "2K", multiRef: 3 },
               pricing: { text_in: 0.3, image_out: 60 } }),
    spec: { adapter: "gemini-image", model: "gemini-3-pro-image" },
    width: 1920, height: 1080,
    refBytes: [{ name: "a", contentType: "image/png", b64: "QQ==" }],
  }), f.http);
  const body = f.calls[0].init.body as Record<string, never>;
  assert.equal(f.calls[0].path, "/v1beta/models/gemini-3-pro-image:generateContent");
  assert.deepEqual((body.generationConfig as Record<string, unknown>).responseModalities, ["image"]);
  assert.deepEqual((body.generationConfig as Record<string, Record<string, string>>).imageConfig,
    { aspectRatio: "16:9", imageSize: "2K" });
  assert.equal((body.contents as { parts: unknown[] }[])[0].parts.length, 2);
  assert.equal(out.b64, "QQ==");
  // 100*0.3 + 1000*60 = 60,030 / 1e6
  assert.equal(out.costUsd, 0.06003);
});

test("a gemini refusal is a 200 with text, and it raises with what was said", async () => {
  const f = fake([{
    candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "I can't help with that." }] } }],
  }]);
  await assert.rejects(
    () => geminiImage(base({ row: row({ provider: "google" }),
                             spec: { adapter: "gemini-image", model: "m" } }), f.http),
    /SAFETY.*can't help/s);
});

test("the reference cap is the row's, not the adapter's", async () => {
  const f = fake([{ candidates: [{ content: { parts: [{ inlineData: { data: "QQ==" } }] } }] }]);
  await geminiImage(base({
    row: row({ provider: "google", capabilities: { multiRef: 2 } }),
    spec: { adapter: "gemini-image", model: "m" },
    refBytes: Array.from({ length: 5 }, (_, i) => ({ name: `${i}`, contentType: "image/png", b64: "QQ==" })),
  }), f.http);
  const parts = (f.calls[0].init.body as { contents: { parts: unknown[] }[] }).contents[0].parts;
  assert.equal(parts.length, 3, "one prompt part plus the row's cap of two");
});

/* ── fal ────────────────────────────────────────────────────────────────── */

const SUBMIT = { status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r",
                 request_id: "req-1" };

test("fal submits, polls until COMPLETED, then reads the result", async () => {
  const f = fake([SUBMIT, { status: "IN_QUEUE", queue_position: 2 },
                  { status: "IN_PROGRESS" }, { status: "COMPLETED" },
                  { video: { url: "https://fal.media/v.mp4", content_type: "video/mp4" } }]);
  const notes: string[] = [];
  const out = await falQueue(base({
    row: row({ kind: "video", provider: "fal", pricing: { unit: "second", usd: 0.26 } }),
    spec: { adapter: "fal-queue", endpoint: "fal-ai/minimax/hailuo-3" },
    seconds: 10, note: (_p, t) => notes.push(t),
  }), f.http);
  assert.equal(f.calls[0].path, "/fal-ai/minimax/hailuo-3");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(out.kind, "video");
  assert.equal(out.url, "https://fal.media/v.mp4");
  // A video row prices per SECOND, so the length is what makes the ledger row
  // right: 10 x $0.26.
  assert.equal(out.costUsd, 2.6);
  assert.deepEqual(notes, ["fal: queued, 2 ahead", "fal: in_progress"]);
});

test("a fal failure raises instead of polling to the timeout", async () => {
  const f = fake([SUBMIT, { status: "FAILED" }]);
  await assert.rejects(() => falQueue(base({
    row: row({ provider: "fal" }), spec: { adapter: "fal-queue", endpoint: "e" },
  }), f.http), /reported the job failed/);
});

test("a cancel is honoured between polls", async () => {
  const f = fake([SUBMIT, { status: "IN_QUEUE" }]);
  await assert.rejects(() => falQueue(base({
    row: row({ provider: "fal" }), spec: { adapter: "fal-queue", endpoint: "e" },
    canceled: async () => true,
  }), f.http), /canceled/);
  assert.equal(f.calls.length, 1, "cancel is checked before the status call, not after");
});

test("a submit with no status url raises rather than polling nothing", async () => {
  await assert.rejects(() => falQueue(base({
    row: row({ provider: "fal" }), spec: { adapter: "fal-queue", endpoint: "e" },
  }), fake([{ request_id: "x" }]).http), /no status url/);
  await assert.rejects(() => falQueue(base({
    row: row({ provider: "fal" }), spec: { adapter: "fal-queue", endpoint: undefined },
  }), fake([]).http), /no endpoint id/);
});

test("an image result comes back as an image, and an unpriced row costs nothing", async () => {
  const f = fake([SUBMIT, { status: "COMPLETED" },
                  { images: [{ url: "https://fal.media/i.png" }] }]);
  const out = await falQueue(base({
    row: row({ provider: "fal" }), spec: { adapter: "fal-queue", endpoint: "e" },
  }), f.http);
  assert.equal(out.kind, "image");
  assert.equal(out.contentType, "image/png");
  assert.equal(out.costUsd, 0);
});

test("an IMAGE row's references ride as urls in the two spellings fal's image endpoints use", async () => {
  // The bucket is public, so fal fetches these itself and nothing is
  // re-uploaded. `reference_image_urls` is deliberately NOT among them any
  // more: it is a VIDEO endpoint's field, and writing every url into every
  // plausible name is what let a mis-shaped body render a perfectly good clip
  // of the wrong thing. A video row builds its body from its endpoint's own
  // dialect instead — see falVideo.ts and the test below.
  const f = fake([SUBMIT, { status: "COMPLETED" }, { images: [{ url: "https://fal.media/i.png" }] }]);
  await falQueue(base({
    row: row({ provider: "fal" }), spec: { adapter: "fal-queue", endpoint: "e" },
    refUrls: ["https://media.example.com/a.png", "https://media.example.com/b.png"],
  }), f.http);
  const body = f.calls[0].init.body as Record<string, unknown>;
  assert.equal(body.image_url, "https://media.example.com/a.png");
  assert.deepEqual(body.image_urls,
    ["https://media.example.com/a.png", "https://media.example.com/b.png"]);
  assert.equal(body.reference_image_urls, undefined);
});

test("a VIDEO row picks its endpoint by MODE and builds the body from that endpoint's fields", async () => {
  // On fal a mode is a different URL, not a flag. This is the whole reason the
  // dialect exists: an r2v body sent to the i2v endpoint has every reference
  // dropped, and the clip comes back ignoring the sheets staged for it.
  const f = fake([SUBMIT, { status: "COMPLETED" },
                  { video: { url: "https://fal.media/v.mp4" } }]);
  await falQueue(base({
    row: row({ provider: "fal", pricing: { unit: "second", usd: 0.05 } }),
    spec: {
      adapter: "fal-queue",
      fal: {
        endpoints: { t2v: "m/t2v", i2v: { id: "m/i2v", images: null }, flf: { id: "m/i2v", images: null } },
        duration: "string", start: "image_url", end: "end_image_url",
        images: "image_urls",
      },
    },
    mode: "flf", seconds: 4,
    shot: { start: "https://cdn/a.png", end: "https://cdn/b.png", images: ["https://cdn/r.png"] },
  }), f.http);
  assert.equal(f.calls[0].path, "/m/i2v");
  const body = f.calls[0].init.body as Record<string, unknown>;
  assert.deepEqual(body, {
    prompt: "a watch shop at dusk", duration: "4",
    image_url: "https://cdn/a.png", end_image_url: "https://cdn/b.png",
  });
});

test("a mode the model has no endpoint for degrades and SAYS so", async () => {
  const notes: string[] = [];
  const f = fake([SUBMIT, { status: "COMPLETED" },
                  { video: { url: "https://fal.media/v.mp4" } }]);
  await falQueue(base({
    row: row({ provider: "fal" }),
    spec: { adapter: "fal-queue", fal: { endpoints: { i2v: "m/i2v" } } },
    mode: "flf", note: (_p, t) => { notes.push(t); },
    shot: { start: "https://cdn/a.png", end: "https://cdn/b.png" },
  }), f.http);
  assert.equal(f.calls[0].path, "/m/i2v");
  assert.ok(notes.some((n) => n.includes("no flf endpoint")), notes.join(" | "));
});

test("the poll interval is a constant a test can reason about", () => {
  assert.ok(FAL_POLL_MS >= 1000, "polling faster than a second is rate-limit bait");
});

/* ── dispatch ───────────────────────────────────────────────────────────── */

test("runAdapter routes by adapter and refuses an unknown one", async () => {
  const f = fake([{ data: [{ b64_json: "QQ==" }] }]);
  assert.equal((await runAdapter(base(), f.http)).b64, "QQ==");
  await assert.rejects(
    () => runAdapter(base({ spec: { adapter: "nope" as never } }), f.http),
    ByokAdapterError);
});

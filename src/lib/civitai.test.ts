// The Civitai client's two silent-failure surfaces.
//
// 1. THE ZIP. Four of five workflow downloads measured against the live API
//    came back `application/zip`, not JSON — so the archive reader is on the
//    main path, not an edge case. Its failure mode is quiet: read the data
//    offset from the wrong header and you inflate garbage, which surfaces much
//    later as "that workflow is corrupt".
// 2. THE HTML GATE. A download without a token answers 200 with a web page.
//    Anything that trusts the status code stores it as a workflow.
// 3. THE MEDIA URL. A preview is not a thumbnail — one measured 161MB — so the
//    gallery asks the CDN for a size by rewriting the transform segment. Get
//    that rewrite wrong and nothing breaks visibly; the page just pulls
//    hundreds of megabytes.
//
// The fixtures are built here with node's zlib rather than checked in: a
// hand-made archive can exercise the shapes that matter (stored vs deflated,
// a differing extra-field length between the local and central headers, noise
// entries) which a captured file cannot be relied on to contain.
import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import { explicit, getModelDetails, getModelImages, getVersion, isVideo, listZip, mediaUrl,
         modelDir, readZipEntry, searchCivitai, sha256Of, showcaseMedia, weightFile,
         workflowFile, type ZipEntry } from "./civitai.ts";

/* ── a minimal zip writer, for fixtures ─────────────────────────────────── */

interface Spec { name: string; body: string; store?: boolean; localExtra?: number }

function makeZip(files: Spec[]): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const raw = Buffer.from(enc.encode(f.body));
    const data = f.store ? raw : zlib.deflateRawSync(raw);
    const name = Buffer.from(enc.encode(f.name));
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    // The local header's extra field is allowed to differ in length from the
    // central directory's — real archivers use it for alignment and timestamps
    // — and getting the data offset from the central copy is the classic bug.
    const extra = Buffer.alloc(f.localExtra ?? 0);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(f.store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    locals.push(lh, name, extra, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(f.store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += 30 + name.length + extra.length + data.length;
  }

  const cdBody = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBody.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const all = Buffer.concat([...locals, cdBody, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

const GRAPH = JSON.stringify({
  "1": { class_type: "UNETLoader", inputs: { unet_name: "h3.safetensors" } },
  "2": { class_type: "SaveVideo", inputs: { images: ["1", 0] } },
});

/* ── the reader ─────────────────────────────────────────────────────────── */

test("the central directory is read, including entry names and methods", () => {
  const zip = makeZip([
    { name: "wf.json", body: GRAPH },
    { name: "readme.txt", body: "hello", store: true },
  ]);
  const e = listZip(zip);
  assert.deepEqual(e.map((x) => x.name), ["wf.json", "readme.txt"]);
  assert.equal(e[0].method, 8);
  assert.equal(e[1].method, 0);
  assert.equal(e[0].size, GRAPH.length);
});

test("a deflated entry inflates to exactly its original bytes", async () => {
  const zip = makeZip([{ name: "wf.json", body: GRAPH }]);
  const [entry] = listZip(zip);
  assert.equal(await readZipEntry(zip, entry), GRAPH);
});

test("a stored entry is returned as-is", async () => {
  const zip = makeZip([{ name: "wf.json", body: GRAPH, store: true }]);
  const [entry] = listZip(zip);
  assert.equal(await readZipEntry(zip, entry), GRAPH);
});

test("the data offset comes from the LOCAL header, not the central one", async () => {
  // The bug this pins: the central directory records its own extra-field
  // length, and using it to skip past the local header lands N bytes into (or
  // short of) the compressed data. Inflate then fails, or worse, succeeds on
  // garbage. Here the local header carries 17 bytes of extra and the central
  // one carries none.
  const zip = makeZip([{ name: "wf.json", body: GRAPH, localExtra: 17 }]);
  const [entry] = listZip(zip);
  assert.equal(await readZipEntry(zip, entry), GRAPH);
});

test("the second entry of a multi-file archive reads correctly", async () => {
  // Offsets accumulate, so an off-by-one in the walk only shows from entry two
  // onward — the single-entry test above cannot catch it.
  const other = JSON.stringify({ "9": { class_type: "SaveImage", inputs: {} } });
  const zip = makeZip([
    { name: "previews/a.png", body: "not really a png", store: true },
    { name: "graphs/second.json", body: other },
  ]);
  const entries = listZip(zip);
  const second = entries.find((e) => e.name.endsWith("second.json"))!;
  assert.equal(await readZipEntry(zip, second), other);
});

test("something that is not a zip returns no entries rather than throwing", () => {
  const enc = new TextEncoder().encode('{"1":{"class_type":"SaveImage","inputs":{}}}');
  assert.deepEqual(listZip(enc.buffer as ArrayBuffer), []);
  assert.deepEqual(listZip(new ArrayBuffer(0)), []);
  assert.deepEqual(listZip(new ArrayBuffer(4)), []);
});

test("a zip comment after the EOCD does not hide it", () => {
  // The EOCD is found by scanning backwards, because a trailing comment is
  // legal and pushes it off the end of the file.
  const base = Buffer.from(new Uint8Array(makeZip([{ name: "wf.json", body: GRAPH }])));
  const comment = Buffer.from("thanks for downloading!");
  base.writeUInt16LE(comment.length, base.length - 2);
  const withComment = Buffer.concat([base, comment]);
  const buf = withComment.buffer.slice(
    withComment.byteOffset, withComment.byteOffset + withComment.byteLength) as ArrayBuffer;
  assert.deepEqual(listZip(buf).map((e) => e.name), ["wf.json"]);
});

test("an unsupported compression method is refused, not decoded as garbage", async () => {
  const zip = makeZip([{ name: "wf.json", body: GRAPH, store: true }]);
  const [entry] = listZip(zip);
  const bogus: ZipEntry = { ...entry, method: 14 };  // LZMA
  await assert.rejects(() => readZipEntry(zip, bogus), /unsupported compression/);
});


/* ── media URLs ─────────────────────────────────────────────────────────── */

const VIDEO = {
  url: "https://image.civitai.com/xG1n/859cb6d2-ee4c/original=true/139821277.mp4",
  type: "video",
};
const IMAGE = {
  url: "https://image.civitai.com/xG1n/2d6242be-680a/original=true/139825181.jpeg",
  type: "image",
};

test("a video thumbnail asks for the poster frame, never the video", () => {
  // Measured: `anim=false` is the one spelling that returned an image for all
  // five videos tried. Width is ignored on a video, so adding one would only
  // make the request look like it did something.
  for (const want of ["thumb", "card", "poster"] as const) {
    assert.equal(mediaUrl(VIDEO, want),
      "https://image.civitai.com/xG1n/859cb6d2-ee4c/anim=false/139821277.mp4");
  }
});

test("the video hero is the real file", () => {
  assert.equal(mediaUrl(VIDEO, "hero"), VIDEO.url);
});

test("images are resized and re-encoded, at a size per surface", () => {
  assert.match(mediaUrl(IMAGE, "thumb"), /\/width=200,optimized=true\//);
  assert.match(mediaUrl(IMAGE, "card"), /\/width=400,optimized=true\//);
  assert.match(mediaUrl(IMAGE, "hero"), /\/width=1200,optimized=true\//);
});

test("only the transform segment is rewritten", () => {
  const out = mediaUrl(IMAGE, "thumb");
  assert.equal(out.split("/").length, IMAGE.url.split("/").length);
  assert.ok(out.endsWith("/139825181.jpeg"));
  assert.ok(out.startsWith("https://image.civitai.com/xG1n/2d6242be-680a/"));
});

test("a URL that is not the CDN shape is handed back untouched", () => {
  // Never guess at someone else's URL scheme: a wrong rewrite is a 404 the
  // user reads as "this model has no preview".
  for (const url of ["https://example.com/a.mp4", "https://image.civitai.com/short",
                     "data:image/png;base64,AAA"]) {
    assert.equal(mediaUrl({ url, type: "video" }, "thumb"), url);
  }
});

test("video is detected by type OR by extension", () => {
  // The two endpoints disagree about which fields they populate, and a missing
  // `type` used to mean an <img> pointed at an mp4 — a broken-image icon.
  assert.ok(isVideo({ type: "video", url: "x" }));
  assert.ok(isVideo({ url: "https://image.civitai.com/a/b/original=true/1.mp4" }));
  assert.ok(isVideo({ url: "https://image.civitai.com/a/b/anim=false/1.mp4" }));
  assert.ok(!isVideo({ url: "https://image.civitai.com/a/b/original=true/1.jpeg" }));
});

test("nsfw level is read in both spellings", () => {
  // A version's images report a NUMBER, the gallery endpoint reports a NAME —
  // measured on the same model. Reading one as the other is silent: "Mature"
  // > 2 is false, so every gallery item would come back safe.
  assert.equal(explicit(1), false);
  assert.equal(explicit(4), true);
  assert.equal(explicit("None"), false);
  assert.equal(explicit("Mature"), true);
  assert.equal(explicit("XXX"), true);
  // Nothing said either way: fall back to the model's own flag.
  assert.equal(explicit(undefined, true), true);
  assert.equal(explicit(undefined, false), false);
});

test("the showcase is flattened across versions and deduped", () => {
  const media = showcaseMedia({
    id: 1, name: "m", type: "Workflows",
    modelVersions: [
      { id: 1, name: "v2", images: [{ url: "a" }, { url: "b" }] },
      { id: 2, name: "v1", images: [{ url: "b" }, { url: "c" }] },
    ],
  });
  assert.deepEqual(media.map((m) => m.url), ["a", "b", "c"]);
  assert.deepEqual(media.map((m) => m.versionName), ["v2", "v2", "v1"]);
  assert.ok(media.every((m) => m.from === "author"));
});


/* ── which file in a version is the importable one ──────────────────────── */
//
// THE ARCHIVE IS THE COMMON CASE, and taking only `.json` is what made the hub
// unable to import most of Civitai. Measured live 2026-08-20 over 135 workflow
// models / 735 versions: 670 files are `Archive`/`.zip` against 72
// `Config`/`.json`, so a JSON-only selector resolved 9.8% of versions and
// returned null for the rest — which the detail screen renders as "no
// importable file" with Import disabled, i.e. it reads as the model having
// nothing to offer rather than as this function refusing it. The download side
// has always unzipped these; nothing would hand it one.

const version = (files: { name: string; type: string; id?: number }[]) => ({
  id: 1, name: "v1",
  files: files.map((f, i) => ({ id: f.id ?? i + 1, name: f.name, type: f.type,
                               sizeKB: 10, downloadUrl: `d${i}` })),
});

test("a version whose only file is a .zip archive is importable", () => {
  const f = workflowFile(version([{ name: "wan22Workflows_v1.zip", type: "Archive" }]));
  assert.equal(f?.name, "wan22Workflows_v1.zip");
});

test("Archive is accepted by TYPE as well as by extension", () => {
  const f = workflowFile(version([{ name: "pack_v3", type: "Archive" }]));
  assert.equal(f?.name, "pack_v3");
});

test("a bare .json still wins over an archive in the same version", () => {
  // Preference, not fallback: the graph itself needs no unzipping.
  const f = workflowFile(version([
    { name: "extras.zip", type: "Archive" },
    { name: "graph.json", type: "Config" },
  ]));
  assert.equal(f?.name, "graph.json");
});

test("weights are never offered as a workflow", () => {
  // A LORA version must come back null here, or the workflows tab would hand a
  // .safetensors to a JSON parser.
  for (const ext of ["safetensors", "ckpt", "gguf", "pt", "pth", "bin"]) {
    assert.equal(workflowFile(version([{ name: `lora.${ext}`, type: "Model" }])), null, ext);
  }
});

test("a version with no files at all is null, not a throw", () => {
  assert.equal(workflowFile({ id: 1, name: "v" }), null);
  assert.equal(weightFile({ id: 1, name: "v" }), null);
});

test("weightFile still picks the weights out of a mixed version", () => {
  const v = version([{ name: "notes.zip", type: "Archive" }, { name: "lora.safetensors", type: "Model" }]);
  assert.equal(weightFile(v)?.name, "lora.safetensors");
  assert.equal(workflowFile(v)?.name, "notes.zip");
});


/* ── where a downloaded weight file goes ────────────────────────────────── */

test("each Civitai model type maps to the ComfyUI directory its loader reads", () => {
  assert.equal(modelDir("LORA"), "loras");
  assert.equal(modelDir("LoCon"), "loras");
  assert.equal(modelDir("Checkpoint"), "checkpoints");
  assert.equal(modelDir("Upscaler"), "upscale_models");
  assert.equal(modelDir("VAE"), "vae");
});

test("an unknown type is null, so the surface declines instead of guessing", () => {
  // A weight file in the wrong directory is invisible to the loader that
  // wants it, which reads as "the download did nothing".
  assert.equal(modelDir("Workflows"), null);
  assert.equal(modelDir("Poses"), null);
  assert.equal(modelDir(undefined), null);
});

test("the SHA256 is taken only when it IS one", () => {
  // It is passed to the downloader to verify against; a malformed value would
  // fail every download with a checksum error rather than being ignored.
  const f = (hashes: Record<string, string>) =>
    ({ id: 1, name: "a.safetensors", sizeKB: 1, type: "Model", downloadUrl: "u", hashes });
  assert.equal(sha256Of(f({ SHA256: "A".repeat(64) })), "a".repeat(64));
  assert.equal(sha256Of(f({ sha256: "b".repeat(64) })), "b".repeat(64));
  assert.equal(sha256Of(f({ SHA256: "not-a-hash" })), undefined);
  assert.equal(sha256Of(f({ AutoV2: "abc" })), undefined);
  assert.equal(sha256Of({ id: 1, name: "a", sizeKB: 1, type: "Model", downloadUrl: "u" }), undefined);
});

/* ── the header the browser cannot send ─────────────────────────────────── */
//
// CIVITAI'S CORS REFUSES `Authorization` ON THE READ ENDPOINTS, and the
// failure is total rather than degraded: measured on the live API, the same
// search answers 200 anonymously and never leaves the page with a token
// attached — the screen shows "Failed to fetch" and nothing says why. Rust is
// not subject to CORS, so the token still rides in the real desktop build;
// everywhere else it has to be dropped. Under `node --test` there is no Tauri
// global at all, which is exactly the non-Rust case.

test("a READ does not send the token when the transport is a browser fetch", async () => {
  const seen: Record<string, string>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()));
    return new Response(JSON.stringify({ items: [], metadata: {} }),
                        { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await searchCivitai({ query: "x", token: "SECRET-TOKEN" });
    await getModelDetails(1, "SECRET-TOKEN");
    await getVersion(1, "SECRET-TOKEN");
    await getModelImages(1, { token: "SECRET-TOKEN" });
  } finally { globalThis.fetch = real; }
  assert.equal(seen.length, 4);
  for (const h of seen) {
    assert.equal(h.authorization, undefined, "a token the browser cannot send must be dropped");
    // the UA workaround still goes — browsers ignore it, Rust needs it
    assert.match(h["user-agent"] ?? "", /QambaStudio/);
  }
});

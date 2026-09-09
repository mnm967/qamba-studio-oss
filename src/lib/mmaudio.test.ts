import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BAND_HIGH, BAND_LOW, CLIP_FPS, DEFAULT_NEGATIVE, MIN_SECONDS, SYNC_FPS,
  TRAINED_SECONDS, clampSeconds, clipCoverage, durationNote, framesNeeded,
  v2aDefaults, v2aLabel, v2aPayload,
} from "./mmaudio.ts";
import type { ModelCatalogRow } from "./db/types";

/** The catalog row this file is written against, built the way
 *  `gen_model_catalog.py` builds it — from model_map, so the numbers here
 *  cannot drift from the entry the pod resolves. */
const MAP = JSON.parse(readFileSync(
  new URL("../../infra/model_map.full.json", import.meta.url), "utf8"));
const ENTRY = MAP.full.v2a_models["mmaudio-large-44k-v2"];

const ROW = {
  id: "mmaudio-large-44k-v2-local",
  family: "mmaudio",
  kind: "audio",
  enabled: true,
  modes: ["v2a"],
  max_seconds: ENTRY.max_seconds,
  capabilities: {
    negativePrompt: true, video2audio: true,
    trainedSeconds: ENTRY.trained_seconds, syncFps: ENTRY.sync_fps,
  },
} as unknown as ModelCatalogRow;

/* ------------------------------------------------ the twin, verbatim ------ */

const PY = readFileSync(new URL("../../worker/mmaudio_spec.py", import.meta.url), "utf8");
const pyConst = (name: string): number =>
  Number(PY.match(new RegExp(`^${name}\\s*=\\s*([0-9.]+)`, "m"))?.[1]);

test("the constants match worker/mmaudio_spec.py", () => {
  // A disagreement here is not an error anywhere: the modal quotes one number
  // and the pod renders another, and the only symptom is a soundtrack that is
  // the wrong length.
  assert.equal(MIN_SECONDS, pyConst("MIN_SECONDS"));
  assert.equal(TRAINED_SECONDS, pyConst("TRAINED_SECONDS"));
  assert.equal(BAND_LOW, pyConst("BAND_LOW"));
  assert.equal(BAND_HIGH, pyConst("BAND_HIGH"));
  assert.equal(SYNC_FPS, pyConst("SYNC_FPS"));
  assert.equal(CLIP_FPS, pyConst("CLIP_FPS"));
});

test("the model_map entry agrees with both", () => {
  assert.equal(ENTRY.sync_fps, SYNC_FPS);
  assert.equal(ENTRY.clip_fps, CLIP_FPS);
  assert.equal(ENTRY.trained_seconds, TRAINED_SECONDS);
});

/* --------------------------------------------------------- the length ----- */

test("the length is clamped to the row's ceiling, never past it", () => {
  assert.equal(clampSeconds(999_000, ENTRY.max_seconds), ENTRY.max_seconds);
  assert.equal(clampSeconds(0, ENTRY.max_seconds), MIN_SECONDS);
  assert.equal(clampSeconds(8_000, ENTRY.max_seconds), 8);
});

test("the staged batch always carries 25 frames per second of render", () => {
  // The rule the whole builder is arranged around: fewer than 25 x duration
  // frames and the node silently shortens the render.
  for (const s of [1, 3.5, 8, 12, 30]) {
    assert.ok(framesNeeded(s) >= Math.floor(SYNC_FPS * s), `${s}s`);
  }
  assert.equal(framesNeeded(8), 200);
});

test("only a length outside the trained band gets a note", () => {
  // A note on a correct length is a warning nobody reads — the mistake the
  // action-before-speech check already made once.
  assert.equal(durationNote(TRAINED_SECONDS), null);
  assert.equal(durationNote(BAND_LOW), null);
  assert.equal(durationNote(BAND_HIGH), null);
  assert.match(String(durationNote(BAND_LOW - 0.1)), /under/);
  assert.match(String(durationNote(BAND_HIGH + 0.1)), /over/);
});

test("CLIP sees the head of the shot, and the fraction is stated", () => {
  assert.equal(clipCoverage(), CLIP_FPS / SYNC_FPS);
  assert.equal(clipCoverage(0, 8), 1);   // a nonsense rate never divides by zero
});

/* -------------------------------------------------------- the payload ----- */

test("the catalog id translates to the model_map key by the plain rule", () => {
  // The worker resolves `v2a_models[<key>]`, so a catalog id reaching it is a
  // job that dies on "not available on tier". `modelKeyOf` cannot be imported
  // here (projectSettings reaches the database at module scope), so this reads
  // its own source — the same technique `scoreTrack.test.ts` uses. What it
  // proves is that our id needs NO exception: strip `-local` and you have the
  // map key, which is exactly what `gen_model_catalog.py`'s
  // `check_model_keys` refuses to sync without.
  const src = readFileSync(new URL("./projectSettings.ts", import.meta.url), "utf8");
  const table = src.slice(src.indexOf("const MODEL_KEY_EXCEPTIONS"));
  const body = table.slice(0, table.indexOf("};"));
  assert.ok(!body.includes("mmaudio"), "mmaudio must not need an exception");
  assert.equal(ROW.id.replace(/-local$/, ""), "mmaudio-large-44k-v2");
  assert.ok(MAP.full.v2a_models[ROW.id.replace(/-local$/, "")]);
});

test("a model with no map key omits it rather than sending undefined", () => {
  // `modelKeyOf` returns undefined for a desktop row and its contract is to
  // DROP the key so the pod falls back to its own default — sending the string
  // "undefined" would be a job that dies on "not available on tier".
  const p = v2aPayload({ sourceAssetId: "a1", model: ROW, prompt: "x", durationMs: 8000 });
  assert.ok(!("model_key" in p));
});

test("the payload carries the key it is given, verbatim", () => {
  const p = v2aPayload({
    sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2",
    prompt: "rain", durationMs: 8000 });
  assert.equal(p.model_key, "mmaudio-large-44k-v2");
});

test("a seed is always written, so pressing again is a new roll", () => {
  // A panel redraw with no seed returned the identical file and read as a
  // broken button. Same trap, same fix.
  const a = v2aPayload({ sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2", prompt: "x", durationMs: 8000 });
  assert.equal(typeof a.seed, "number");
  const b = v2aPayload({ sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2", prompt: "x", durationMs: 8000, seed: -1 });
  assert.equal(typeof b.seed, "number");
  const c = v2aPayload({ sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2", prompt: "x", durationMs: 8000, seed: 7 });
  assert.equal(c.seed, 7);
});

test("an empty negative is omitted rather than sent as an empty string", () => {
  // The worker falls back to the entry's own value for a key it does not
  // receive, so "" would claim "no negative" where the row declares one.
  const p = v2aPayload({ sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2", prompt: "x", durationMs: 8000, negative: "  " });
  assert.ok(!("negative" in p));
  const q = v2aPayload({ sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2", prompt: "x", durationMs: 8000, negative: "music" });
  assert.equal(q.negative, "music");
});

test("a row whose cfg cannot evaluate a negative branch drops the field", () => {
  // The rule every distilled row in this catalog follows: a control that
  // provably cannot change the render is not offered, and never sent.
  const distilled = { ...ROW, capabilities: { ...ROW.capabilities, cfg: 1 } } as ModelCatalogRow;
  assert.equal(v2aDefaults(distilled).takesNegative, false);
  const p = v2aPayload({ sourceAssetId: "a1", model: distilled, modelKey: "mmaudio-large-44k-v2", prompt: "x", durationMs: 8000, negative: "music" });
  assert.ok(!("negative" in p));
});

test("the block path activates by default and carries its provenance", () => {
  const p = v2aPayload({
    sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2",
    prompt: "x", durationMs: 8000,
    blockId: "b1", takeId: "t9",
  });
  assert.equal(p.block_id, "b1");
  assert.equal(p.activate, "replace");
  assert.equal(p.take_id, "t9");
});

test("the studio path sends no block keys at all", () => {
  // A stray `block_id` here would publish a TAKE from the library tab — a
  // block silently getting a new active take nobody asked for.
  const p = v2aPayload({ sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2", prompt: "x", durationMs: 8000 });
  for (const k of ["block_id", "activate", "take_id"]) assert.ok(!(k in p), k);
});

test("review is honoured when the caller asks for it", () => {
  const p = v2aPayload({
    sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2",
    prompt: "x", durationMs: 8000,
    blockId: "b1", activate: "review",
  });
  assert.equal(p.activate, "review");
});

test("the duration in the payload is the CLAMPED one", () => {
  const p = v2aPayload({ sourceAssetId: "a1", model: ROW, modelKey: "mmaudio-large-44k-v2", prompt: "x", durationMs: 999_000 });
  assert.equal(p.duration_ms, ENTRY.max_seconds * 1000);
});

test("the defaults come off the row, and fall back where it is silent", () => {
  assert.equal(v2aDefaults(ROW).syncFps, SYNC_FPS);
  assert.equal(v2aDefaults(null).steps, 25);
  assert.equal(v2aDefaults(null).maxSeconds, 30);
  assert.equal(v2aDefaults(null).takesNegative, true);
});

test("the queue row says what it is", () => {
  // `jobLabel` renders payload.label on every queue surface; a row saying only
  // its kind is the regression CLAUDE.md names.
  assert.match(v2aLabel({ blockLabel: "Block 4", prompt: "boots on gravel" }),
               /^Block 4 audio · boots on gravel$/);
  assert.equal(v2aLabel({ prompt: "" }), "Video → audio");
});

test("the default negative is the vendor's clean-bed one", () => {
  assert.match(DEFAULT_NEGATIVE, /music/);
  assert.match(DEFAULT_NEGATIVE, /speech/);
});

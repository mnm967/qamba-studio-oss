import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PROVIDER_OF, providerOf, castVoiceOf, LOCAL_ENGINES } from "./speechProviders.ts";

const read = (p: string) =>
  fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

/* ── the table, pinned against both ends ─────────────────────────────────── */

test("every id in the map is a catalog row, and every value a provider the worker accepts", () => {
  // BOTH DIRECTIONS, because each is a different silent failure. An id that
  // names no row is an entry that never fires — the row goes on queueing its
  // `provider` column and rendering on OpenAI. A value the worker does not
  // know is `_pick_provider` logging "unknown provider" and falling through to
  // OpenAI, which is the same wrong line by a different route.
  const catalog = read("scripts/gen_model_catalog.py");
  const tts = read("worker/handlers/tts.py");
  const known = new Set(
    (tts.match(/PROVIDERS\s*=\s*\(([^)]*)\)/) ?? ["", ""])[1]
      .match(/"([a-z-]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [],
  );
  assert.ok(known.size >= 5, `the PROVIDERS scanner found ${known.size} — it is broken`);

  for (const [id, provider] of Object.entries(PROVIDER_OF)) {
    assert.ok(catalog.includes(`row("${id}"`), `${id} is not a catalog row`);
    assert.ok(known.has(provider),
              `${id} maps to "${provider}", which handle_tts does not accept`);
  }
});

test("every catalog row whose provider is `local` is in the map", () => {
  // THE BUG THE MAP EXISTS FOR. `provider` is the VENDOR column for a hosted
  // row and the LOCATION column for a local one, so every studio-hosted engine
  // reads "local" — a value `handle_tts` has never accepted. A local speech
  // row missing from this table queues `provider: "local"` and renders on
  // OpenAI, silently, which is what "Breeze TTS 2 (local)" did.
  const catalog = read("scripts/gen_model_catalog.py");
  const rows = [...catalog.matchAll(
    /row\("([^"]+)",\s*"[^"]*",\s*"[^"]*",\s*"audio",\s*"local"/g)].map((m) => m[1]);
  assert.ok(rows.length >= 2, `the row scanner found ${rows.length} local audio rows`);
  for (const id of rows) {
    // Only the ones that SPEAK; a local music or v2a row has no provider
    // dispatch to reach.
    const after = catalog.slice(catalog.indexOf(`row("${id}"`));
    if (!/modes=\["tts"\]/.test(after.slice(0, 400))) continue;
    assert.ok(id in PROVIDER_OF, `${id} speaks and has no provider mapping`);
  }
});

test("a hosted row keeps its own vendor column", () => {
  assert.equal(providerOf({ id: "elevenlabs-v3", provider: "elevenlabs" }), "elevenlabs");
  assert.equal(providerOf({ id: "openai-tts", provider: "openai" }), "openai");
  // ...and the two that would otherwise say "local".
  assert.equal(providerOf({ id: "breeze-tts-2", provider: "local" }), "breeze");
  assert.equal(providerOf({ id: "fish-s2-local", provider: "local" }), "fish-local");
});

/* ── where each engine keeps a character's voice ─────────────────────────── */

test("a cast voice is read from the place its own engine wrote it", () => {
  // NEITHER IS A FALLBACK FOR THE OTHER. ElevenLabs casts a stock id; Breeze
  // DESIGNS a clip and the recording IS the voice. Reading one where the other
  // is meant auditions a character in a stranger's voice — the exact thing the
  // cast picker exists to prevent.
  const el = { doc: { el_voice_id: "v-abc" } };
  const bz = { doc: { breeze_voice: { asset_id: "a-1" }, voice_provider: "breeze" } };

  assert.equal(castVoiceOf(el, "elevenlabs"), "v-abc");
  assert.equal(castVoiceOf(el, "breeze"), null, "an EL voice is not a Breeze voice");
  assert.equal(castVoiceOf(bz, "breeze"), "breeze:a-1");
  assert.equal(castVoiceOf(bz, "elevenlabs"), null);
  // The `breeze:` prefix is what `dialogue_synth.is_breeze` matches on, so it
  // is part of the value rather than decoration.
  assert.match(castVoiceOf(bz, "breeze")!, /^breeze:/);
});

test("an engine with no cast has none, rather than borrowing one", () => {
  const both = { doc: { el_voice_id: "v-abc", breeze_voice: { asset_id: "a-1" } } };
  for (const p of ["openai", "fish", "fish-local", "voxtral"]) {
    assert.equal(castVoiceOf(both, p), null, `${p} has no cast voices`);
  }
});

test("a character cast on neither is left out rather than downgraded", () => {
  const none = { doc: {} };
  assert.equal(castVoiceOf(none, "elevenlabs"), null);
  assert.equal(castVoiceOf(none, "breeze"), null);
  assert.equal(castVoiceOf({ doc: null } as never, "breeze"), null);
});

test("the local engines and their prefixes agree with voice_engines.py", () => {
  // THE PREFIX MOVED, and to the right place: it used to be a literal in
  // `dialogue_synth.py` and is now `voice_engines.ENGINES`, which is what a
  // THIRD engine would be added to. A voice id whose prefix disagrees is a
  // character the worker cannot resolve — `_voice_of_doc` returns None and the
  // block silently falls back to timbre refs.
  const ve = read("worker/voice_engines.py");
  const body = ve.match(/ENGINES = \{([^}]+)\}/)?.[1];
  assert.ok(body, "ENGINES is gone from voice_engines.py — did it move?");
  const names = [...body!.matchAll(/"([a-z0-9_]+)":\s*"[a-z0-9_]+"/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), [...LOCAL_ENGINES].sort(),
                   "the browser's LOCAL_ENGINES and the worker's table disagree");
  // ...and the id each stamps is `<engine>:<asset>`, built by `voice_id`.
  assert.match(ve, /f"\{name\}:"/, "the prefix spelling moved");
  for (const e of LOCAL_ENGINES) {
    assert.equal(castVoiceOf({ doc: { [`${e}_voice`]: { asset_id: "x" } } }, e),
                 `${e}:x`);
    // ...and one engine's clip is never read as another's.
    assert.equal(castVoiceOf({ doc: { [`${e}_voice`]: { asset_id: "x" } } },
                             e === "breeze" ? "qwen" : "breeze"), null);
  }
});

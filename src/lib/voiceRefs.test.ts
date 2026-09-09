import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  TTS_VOICES, assignVoices, baseName, pickTtsVoice, providerForEntry, speakingRoles,
  voiceRefPayload,
} from "./voiceRefs.ts";
import type { BibleEntry, Beat } from "./db/types.ts";

const read = (p: string) =>
  fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const chr = (id: string, name: string, extra: Partial<BibleEntry> = {}) => ({
  id, project_id: "p", kind: "character", name, summary: null, doc: {},
  identity_line: null, voice_ref_asset_id: null, status: "draft", version: 1,
  created_at: "", updated_at: "", ...extra,
} as BibleEntry);

const beat = (dialogue: Beat["dialogue"]): Beat => ({
  id: "b", scene_id: "s", idx: 0, duration_ms: 3000, camera: null,
  action: "", dialogue, sfx: null, meta: {},
});

/* ── the preset table, pinned against the planner's own ──────────────────── */

test("the voice table is the one llm.py picks from, in the same order", () => {
  // TWO CHARACTERS ON ONE PRESET is what drift here produces, and it is
  // invisible until you play two clips back to back: both sides run the same
  // "nearest preset, skipping taken" rule, so a table that disagrees hands out
  // a different voice depending on WHO queued the job — the planner, or this
  // step's own button.
  const py = read("worker/llm.py");
  const block = py.slice(py.indexOf("_TTS_VOICES = ["));
  const listed = [...block.slice(0, block.indexOf("]\n")).matchAll(/\("([a-z]+)",\s*\(/g)]
    .map((m) => m[1]);
  assert.ok(listed.length >= 5, `the scanner found ${listed.length} voices — it is broken`);
  assert.deepEqual(TTS_VOICES.map(([v]) => v), listed);
});

test("a written voice picks its preset, and a taken one rotates", () => {
  assert.equal(pickTtsVoice("a deep, gravelly rumble", new Set()), "onyx");
  assert.equal(pickTtsVoice("bright and quick", new Set()), "nova");
  // Nothing written at all falls to the end of the list, which is what `alloy`
  // is for.
  assert.equal(pickTtsVoice("", new Set()), "onyx");
  assert.equal(pickTtsVoice("deep", new Set(["onyx"])), "echo");
  // Every preset spoken for: it reuses rather than returning nothing.
  const all = new Set(TTS_VOICES.map(([v]) => v));
  assert.ok(all.has(pickTtsVoice("deep", all)));
});

test("assignVoices is seeded from the presets already in use", () => {
  // A returning lead and a new supporting character otherwise get handed the
  // same voice — the collision `taken` exists for, and nothing on screen shows
  // it.
  const roles = speakingRoles(
    [chr("1", "Ada", { doc: { voice: "deep and low" } })],
    [beat([{ speaker_id: "1", speaker: "Ada", line: "Hello." }])]);
  assert.equal(assignVoices(roles).get("1"), "onyx");
  assert.equal(assignVoices(roles, ["onyx"]).get("1"), "echo");
});

/* ── who speaks ──────────────────────────────────────────────────────────── */

test("speakers come back in the order they first speak, with their first line", () => {
  const bible = [chr("1", "Ada"), chr("2", "Ben")];
  const roles = speakingRoles(bible, [
    beat([{ speaker_id: "2", speaker: "Ben", line: "You're late." },
          { speaker_id: "1", speaker: "Ada", line: "I'm not." }]),
    beat([{ speaker_id: "1", speaker: "Ada", line: "A later line." }]),
  ]);
  assert.deepEqual(roles.map((r) => r.entry.name), ["Ben", "Ada"]);
  assert.equal(roles[1].line, "I'm not.");
});

test("a name resolves without an id, because a fresh board has no ids", () => {
  const roles = speakingRoles([chr("1", "Ada")],
    [beat([{ speaker_id: "", speaker: "ada", line: "Hi." }])]);
  assert.equal(roles.length, 1);
});

test("an outfit variant answers to its base name", () => {
  const roles = speakingRoles([chr("1", "Ada — flight suit")],
    [beat([{ speaker_id: "", speaker: "Ada", line: "Hi." }])]);
  assert.equal(roles.length, 1);
});

test("a base name with two owners is a MISS, not a guess", () => {
  // Picking either would pin a clip to the wrong character, and every block
  // that character is in would then hear it. Skipping leaves them visibly
  // without a voice, which is the recoverable failure.
  const roles = speakingRoles([chr("1", "Rei"), chr("2", "Guide Rei")],
    [beat([{ speaker_id: "", speaker: "rei", line: "Hi." }])]);
  // "Rei" is a FULL name here, so it still resolves; the ambiguous case is a
  // base that belongs to neither entry outright.
  assert.deepEqual(roles.map((r) => r.entry.id), ["1"]);
  const other = speakingRoles([chr("1", "Rei — coat"), chr("2", "Rei — armour")],
    [beat([{ speaker_id: "", speaker: "Rei", line: "Hi." }])]);
  assert.deepEqual(other, []);
});

test("a character who does not speak is not offered a voice", () => {
  assert.deepEqual(speakingRoles([chr("1", "Ada")], [beat(null)]), []);
});

test("having a clip is reported, not filtered", () => {
  // The bar counts BOTH — "3 of 5 have a voice" needs the ones that do.
  const roles = speakingRoles([chr("1", "Ada", { voice_ref_asset_id: "a1" })],
    [beat([{ speaker_id: "1", speaker: "Ada", line: "Hi." }])]);
  assert.equal(roles[0].have, true);
});

/* ── the payload ─────────────────────────────────────────────────────────── */

test("the delivery note is not cut off mid-phrase", () => {
  // MEASURED on the live bible: 63 of the 92 characters carrying a
  // `doc.voice` are over the old 80-character cap (max 384, mean 92). That
  // cap was sized for ElevenLabs, where this field is keyword-matched onto
  // ONE v3 audio tag; on Breeze and Qwen it is the natural-language
  // instruction a voice is DESIGNED from, and the tail is where the writer
  // puts the part that makes it a particular person. Captain Rhea Dorne's
  // reached the engine as "...a clipped frontier-station " — the accent gone,
  // mid-phrase, silently.
  const voice = "A gravelly contralto with a slow deliberate pace and "
    + "a clipped frontier-station accent.";
  assert.equal(voice.length, 87);
  const [role] = speakingRoles([chr("1", "Rhea", { doc: { voice } })],
    [beat([{ speaker_id: "1", speaker: "Rhea", line: "Listen up." }])]);
  assert.equal(voiceRefPayload(role, { provider: "breeze", voice: null }).emotion,
    voice, "the whole descriptor, accent and all");
  // ...still bounded, and by more than the longest thing in the bible.
  const long = "x".repeat(900);
  const [big] = speakingRoles([chr("2", "Big", { doc: { voice: long } })],
    [beat([{ speaker_id: "2", speaker: "Big", line: "Hi." }])]);
  assert.equal(String(voiceRefPayload(big, {}).emotion).length, 400);
});


test("the clip says the character's own first line", () => {
  const [role] = speakingRoles([chr("1", "Ada", { doc: { voice: "warm alto" } })],
    [beat([{ speaker_id: "1", speaker: "Ada", line: "I'm not late." }])]);
  const p = voiceRefPayload(role, { provider: "breeze", voice: null });
  assert.equal(p.text, "I'm not late.");
  assert.equal(p.provider, "breeze");
  assert.equal(p.emotion, "warm alto");
  assert.equal(p.bible_entry_id, "1");
  // WHOSE voice, as opposed to where the clip lands. Without it the named
  // provider's branch resolves nothing and the job silently renders on the
  // OpenAI chain instead.
  assert.equal(p.speaker_entry_id, "1");
  // The chosen engine AND the OpenAI fallback: `handle_tts` falls through to
  // it whenever the named one resolves nothing, and withholding the key turns
  // a documented fallback into a failed job on a machine that has it.
  assert.deepEqual(p.byok_providers, ["breeze", "openai"]);
  assert.equal(p.label, "voice ref · Ada");
  // No preset was picked, so none is sent — the provider's own default wins
  // rather than a preset that means nothing to it.
  assert.ok(!("voice" in p));
});

test("with no engine named it still forwards the fallback's key, once", () => {
  const [role] = speakingRoles([chr("1", "Ada")],
    [beat([{ speaker_id: "1", speaker: "Ada", line: "Hi." }])]);
  assert.deepEqual(voiceRefPayload(role, {}).byok_providers, ["openai"]);
  assert.deepEqual(voiceRefPayload(role, { provider: "openai" }).byok_providers,
                   ["openai"]);
});

test("a speaker with no line yet still gets a clip", () => {
  const [role] = speakingRoles([chr("1", "Ada")],
    [beat([{ speaker_id: "1", speaker: "Ada", line: "" }])]);
  assert.match(String(voiceRefPayload(role, {}).text), /how Ada sounds/);
});

test("an empty delivery note is omitted rather than sent blank", () => {
  const [role] = speakingRoles([chr("1", "Ada")],
    [beat([{ speaker_id: "1", speaker: "Ada", line: "Hi." }])]);
  assert.ok(!("emotion" in voiceRefPayload(role, {})));
});

test("the label drops a variant's outfit suffix", () => {
  assert.equal(baseName("Ada — flight suit"), "Ada");
});

test("bible_entry_id is what makes the clip the character's anchor", () => {
  // `handle_tts` pins the result onto the entry off this key and the
  // reviewer's speaker verifier baselines every take against it. A payload
  // without it registers an ordinary library asset and the character stays
  // voiceless — which looks like the job having failed when it succeeded.
  const tts = read("worker/handlers/tts.py");
  assert.ok(tts.includes("bible_entry_id"));
});

test("providerForEntry reads the casting already on the entry", () => {
  // Explicit voice_provider wins when set
  assert.equal(providerForEntry({ voice_provider: "breeze" }), "breeze");
  assert.equal(providerForEntry({ voice_provider: "elevenlabs" }), "elevenlabs");
  assert.equal(providerForEntry({ voice_provider: "openai" }), "openai");
  assert.equal(providerForEntry({ voice_provider: "breeze", el_voice_id: "v1" }), "breeze");
  assert.equal(providerForEntry({ breeze_voice: { asset_id: "a1" } }), "breeze");
  // EVERY local engine keeps its designed clip at `doc.<engine>_voice`, so the
  // inference walks them rather than naming Breeze — a character cast on the
  // second one read as UNCAST, and the sheet then opened on Breeze and offered
  // to re-record a voice that already existed.
  assert.equal(providerForEntry({ voice_provider: "qwen" }), "qwen");
  assert.equal(providerForEntry({ qwen_voice: { asset_id: "a2" } }), "qwen");
  assert.equal(providerForEntry({ qwen_voice: { asset_id: "a2" }, el_voice_id: "v1" }), "qwen");
  assert.equal(providerForEntry({ el_voice_id: "v1" }), "elevenlabs");
  // Uncast sends nothing, which is what the planner sends and what
  // `_pick_provider` is written to answer.
  assert.equal(providerForEntry({}), null);
  assert.equal(providerForEntry(null), null);
  // A breeze row with no clip yet is not a cast voice.
  assert.equal(providerForEntry({ breeze_voice: {} }), null);
});

test("voiceRefPayload passes el_voice_id when ElevenLabs voice is specified", () => {
  const role = {
    entry: { id: "e1", project_id: "p1", name: "Dr. Sato", kind: "character", doc: {} },
    line: "Hello world", descriptor: "gravelly", have: false,
  };
  const payload = voiceRefPayload(role, { provider: "elevenlabs", voice: "v_sarah" });
  assert.equal(payload.provider, "elevenlabs");
  assert.equal(payload.el_voice_id, "v_sarah");
  assert.equal(payload.voice, "v_sarah");
});

// node --test src/lib/bibleSheet.test.ts
//
// The fixtures here are the live database's actual key distribution, not
// invented shapes — the whole point of the sheet rewrite is that the form and
// the data had drifted apart, and only real keys can pin that they agree.
// Counts quoted in the comments are from `bible_entries` on 2026-08-16.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_SHEET, PLACE_SHEET, NOTE_SHEET, classifyDoc, colorOf, hasValue,
  legalRole, parseList, parsePalette, roleLabels, sectionState, sheetFor,
  splitPalette, visibleFields, anchorLocked, anchorStanding,
} from "./bibleSheet.ts";
import type { BibleAsset, BibleEntry } from "./db/types.ts";

const entry = (over: Partial<BibleEntry> = {}) => ({
  id: "e1", project_id: "p1", kind: "character", name: "Rei",
  summary: null, doc: {}, identity_line: null, voice_ref_asset_id: null,
  status: "confirmed", version: 1, created_at: "", updated_at: "", ...over,
}) as BibleEntry;

const ctx = (e: BibleEntry, over: { voiceClip?: boolean; refCount?: number } = {}) => ({
  entry: e, doc: (e.doc ?? {}) as Record<string, unknown>,
  voiceClip: over.voiceClip ?? false, refCount: over.refCount ?? 0,
});

/* ------------------------------------------------- the sheets name the data */

// The defect this whole change exists for: PLACE_SHEET asked for `atmosphere`,
// `layout`, `soundscape` and `continuity` (0, 1, 0 and 0 rows carry them) and
// did not name `scale`, `features`, `background_life`, `light_sources` or
// `sound` — 17 rows each, every one written by the planner and read by the
// compiler. So the sheet's own boxes were empty and the real writing was
// dumped underneath them.
test("the environment sheet names the fields the planner actually writes", () => {
  const named = PLACE_SHEET.sections.flatMap((s) => s.fields.map((f) => f.key));
  for (const k of ["scale", "features", "background_life", "light_sources", "sound", "palette"]) {
    assert.ok(named.includes(k), `${k} is written on 17+ environments and must be on the sheet`);
  }
  // Offering a field nothing reads invites writing that reaches no render.
  for (const k of ["atmosphere", "layout", "soundscape", "continuity"]) {
    assert.ok(!named.includes(k), `${k} is read by nothing in worker/ — do not ask for it`);
  }
});

test("the character sheet names every field the writer fills", () => {
  const named = CHARACTER_SHEET.sections.flatMap((s) => s.fields.map((f) => f.key));
  // want/era/role/speech_pattern were all written by the planner and all
  // landed in the unlabelled leftover dump.
  for (const k of ["voice", "wardrobe", "personality", "want", "era", "role",
                   "speech_pattern", "appearance", "arc"]) {
    assert.ok(named.includes(k), `${k} must be a named field`);
  }
});

// storyplan.py validates role against exactly ("lead", "supporting", "extra")
// and rewrites anything else to "supporting" — a "background" pill would be a
// control that silently does nothing.
test("the role enum offers only values the planner accepts", () => {
  const role = CHARACTER_SHEET.sections.flatMap((s) => s.fields).find((f) => f.key === "role");
  assert.deepEqual(role?.options, ["lead", "supporting", "extra"]);
});

test("every kind gets a World section, because every kind carries era", () => {
  for (const sheet of [CHARACTER_SHEET, PLACE_SHEET, NOTE_SHEET]) {
    const world = sheet.sections.find((s) => s.id === "world");
    assert.ok(world, "era is on 31/31 characters, 28/28 environments and 31/31 props");
    assert.ok(world.fields.every((f) => f.inherited),
              "a world field is the project's, so editing it here is a world edit");
  }
});

test("a prop's column is narrow and a person's is not", () => {
  assert.equal(sheetFor("prop").refsWidth, 176);
  assert.equal(sheetFor("character").refsWidth, 326);
  assert.equal(sheetFor("environment").refCols, 3);
});

/* -------------------------------------------------------------- dot states */

test("a section reads unwritten, partial and written from its own fields", () => {
  const look = CHARACTER_SHEET.sections.find((s) => s.id === "look")!;
  assert.equal(sectionState(look, ctx(entry())), "unwritten");
  assert.equal(sectionState(look, ctx(entry({ doc: { appearance: "auburn hair" } }))), "partial");
  assert.equal(
    sectionState(look, ctx(entry({ doc: { appearance: "auburn hair", wardrobe: "oxblood cloak" } }))),
    "written");
});

test("an all-inherited section reads inherited, not merely written", () => {
  const world = CHARACTER_SHEET.sections.find((s) => s.id === "world")!;
  assert.equal(sectionState(world, ctx(entry({ doc: { era: "a near-future age" } }))), "inherited");
  assert.equal(sectionState(world, ctx(entry())), "unwritten");
});

// The amber dot the spec draws on Voice: the casting is done and the timbre
// reference every block stages does not exist yet. That is invisible on every
// other surface in the app.
test("voice is amber when cast with no clip rendered, and written once there is one", () => {
  const voice = CHARACTER_SHEET.sections.find((s) => s.id === "voice")!;
  const e = entry({ doc: { el_voice_id: "Xb7hH8MSUJpSbSDYk0k2", voice: "clear mezzo",
                           speech_pattern: "one sentence smaller than the question" } });
  assert.equal(sectionState(voice, ctx(e)), "partial");
  assert.equal(voice.attention!(ctx(e)), "cast, but no line rendered yet");
  assert.equal(sectionState(voice, ctx(e, { voiceClip: true })), "written");
});

test("an outfit field only exists on a variant", () => {
  const look = CHARACTER_SHEET.sections.find((s) => s.id === "look")!;
  const keys = (e: BibleEntry) => visibleFields(look, ctx(e)).map((f) => f.key);
  assert.ok(!keys(entry()).includes("outfit"));
  assert.ok(keys(entry({ doc: { variant_of: "d8aa3740-8178-4099-a6a8-df8183a3b8e8" } }))
    .includes("outfit"));
});

/* ------------------------------------------------------------ classifying */

test("bookkeeping leaves the form and writing stays in it", () => {
  const e = entry({
    identity_line: "black bob, turquoise streak",
    doc: {
      el_voice_id: "Xb7hH8MSUJpSbSDYk0k2", draft_session: "252ca052-28e6-4085-adf8-36292223aa44",
      sheet_kind: "turnaround", sheet_read_by: "gpt-5.6-luna", v1_kind: "charA",
      variant_of: "d8aa3740-8178-4099-a6a8-df8183a3b8e8",
      note: "multi-view character sheet reference",
    },
  });
  const c = classifyDoc(CHARACTER_SHEET, ctx(e));
  const recordKeys = c.records.map((r) => r.key).sort();
  assert.deepEqual(recordKeys,
    ["draft_session", "el_voice_id", "sheet_kind", "sheet_read_by", "v1_kind", "variant_of"]);
  // Anything else stringy the director wrote is still writing.
  assert.deepEqual(c.extras.map((x) => x.key), ["note"]);
});

test("voice provider bookkeeping keys leave the form and never become extra fields", () => {
  const e = entry({
    doc: {
      voice_provider: "breeze",
      openai_voice: "alloy",
      breeze_voice: { asset_id: "a-123" },
      bio: "written background",
    },
  });
  const c = classifyDoc(CHARACTER_SHEET, ctx(e));
  assert.deepEqual(c.extras.map((x) => x.key), ["bio"]);
  assert.ok(c.records.some((r) => r.key === "voice_provider"));
  assert.ok(c.records.some((r) => r.key === "openai_voice"));
  assert.ok(c.records.some((r) => r.key === "breeze_voice"));
});

// `features` is a JSON array. The old leftover dump required
// `typeof === "string"`, so a location's named anchor features — what the
// Continuity Director stages blocking against — were invisible entirely.
test("an array field survives classification instead of being dropped", () => {
  const e = entry({ kind: "environment",
    doc: { materials: ["salt-etched limestone", "neon-stained glass"] } });
  const c = classifyDoc(PLACE_SHEET, ctx(e));
  const materials = c.extras.find((x) => x.key === "materials");
  assert.equal(materials?.type, "list");
  assert.deepEqual(materials?.value, ["salt-etched limestone", "neon-stained glass"]);
});

// Measured: sheet_identity == identity_line in 7 of 7 rows (it records what
// the VLM read off the sheet) while identity_line_written DIFFERS in 6 of 7
// (it is what a human wrote before the sheet was read). An identical copy is
// noise; a differing one is a decision.
test("only a copy that disagrees becomes a reconcile prompt", () => {
  const e = entry({
    identity_line: "Dark shoulder-length wavy hair with a cyan streak",
    doc: {
      sheet_identity: "Dark shoulder-length wavy hair with a cyan streak",
      identity_line_written: "A slim figure with chin-length black hair, bright blue streak",
    },
  });
  const c = classifyDoc(CHARACTER_SHEET, ctx(e));
  assert.deepEqual(c.rivals.map((r) => r.key), ["identity_line_written"]);
  assert.equal(c.rivals[0].of, "identity_line");
  assert.ok(c.records.some((r) => r.key === "sheet_identity"), "the identical copy is a record");
});

// doc.summary equals the summary column in all 123 rows that carry it.
test("doc.summary never becomes a second summary box", () => {
  const e = entry({ summary: "An exiled member of the Emberwake tradition",
                    doc: { summary: "An exiled member of the Emberwake tradition" } });
  const c = classifyDoc(CHARACTER_SHEET, ctx(e));
  assert.equal(c.extras.length, 0);
  assert.equal(c.rivals.length, 0);
  assert.ok(c.records.some((r) => r.key === "summary"));
});

test("the progress count is fields written over fields askable", () => {
  const e = entry({ kind: "prop", identity_line: "a cloudy glass marble",
                    summary: "Guide Rei's countermeasure",
                    doc: { era: "a near-future interdimensional age",
                           scenes: ["MISFIRE", "DEZ_BRIEF"] } });
  const c = classifyDoc(NOTE_SHEET, ctx(e));
  // identity_line, summary, era written; appearance, reads, depicts, notes,
  // fixed_to not. `scenes` is a pipeline record and is not askable.
  assert.equal(c.written, 3);
  assert.equal(c.total, 8);
  assert.ok(c.records.some((r) => r.key === "scenes"));
});

test("hasValue treats an empty array like an empty string", () => {
  assert.equal(hasValue([]), false);
  assert.equal(hasValue(["a"]), true);
  assert.equal(hasValue("   "), false);
  assert.equal(hasValue(12), false);
});

/* --------------------------------------------------------------- palette */

test("the planner's own palette line splits into named swatches", () => {
  // Verbatim from a live environment row.
  const p = parsePalette("midnight blue, gunmetal gray, wet black, electric cyan, "
    + "blue-violet crystal glow, and orange");
  assert.deepEqual(p.map((s) => s.name),
    ["midnight blue", "gunmetal gray", "wet black", "electric cyan",
     "blue-violet crystal glow", "orange"]);
  assert.ok(p.every((s) => s.hex), "every one of these resolves");
});

test("the last recognised word is the colour and the ones before it modify it", () => {
  // "midnight blue" is a blue, not a midnight.
  assert.notEqual(colorOf("midnight blue"), colorOf("blue"));
  assert.equal(colorOf("blue")!.length, 7);
  assert.equal(colorOf("warm gold")!.length, 7);
  // A dark modifier darkens and a pale one lightens, in that order.
  const lum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16)
    + parseInt(h.slice(5, 7), 16);
  assert.ok(lum(colorOf("dark green")!) < lum(colorOf("green")!));
  assert.ok(lum(colorOf("pale green")!) > lum(colorOf("green")!));
});

test("a colour it cannot name renders empty rather than confidently wrong", () => {
  assert.equal(colorOf("bioluminescent susurrus"), null);
  assert.equal(parsePalette("humid emerald, xyzzy")[1].hex, null);
});

test("splitting handles the separators writers use", () => {
  assert.deepEqual(splitPalette("teal; rust / bone"), ["teal", "rust", "bone"]);
  assert.deepEqual(splitPalette("teal, and rust"), ["teal", "rust"]);
});

test("a list round-trips through the line someone would type", () => {
  assert.deepEqual(parseList("the freight lift, the teller cage"),
                   ["the freight lift", "the teller cage"]);
  assert.deepEqual(parseList("• the catwalk\n- the trench\n"), ["the catwalk", "the trench"]);
});

/* ------------------------------------------------------------- references */

test("only duplicate roles get an ordinal", () => {
  const links = [{ role: "master" }, { role: "alt_angle" }, { role: "detail" },
                 { role: "atmosphere" }, { role: "detail" }, { role: "alt_angle" }];
  assert.deepEqual(roleLabels(links, PLACE_SHEET.roles),
    ["master", "alt angle", "detail", "atmosphere", "detail 2", "alt angle 2"]);
});

const link = (role: string, asset_id: string) => ({ role, asset_id }) as BibleAsset;

test("the anchor is locked once other plates were made against it", () => {
  const master = link("master", "m1");
  const set = [master, link("detail", "d1"), link("alt_angle", "a1"), link("atmosphere", "t1")];
  assert.equal(anchorLocked(master, PLACE_SHEET, set), true);
  assert.equal(anchorLocked(master, PLACE_SHEET, [master]), false, "the only plate is detachable");
  assert.equal(anchorLocked(link("detail", "d1"), PLACE_SHEET, set), false);
});

// The lock counts ANCHOR-role refs, not total refs. Counting totals is what
// made a duplicate face plate permanent: both tiles locked, neither removable,
// and the wrong one still the character's identity.
test("a second sheet in the anchor slot unlocks both", () => {
  const first = link("face", "f1");
  const second = link("face", "f2");
  const set = [first, second, link("full_body", "b1")];
  assert.equal(anchorLocked(first, CHARACTER_SHEET, set), false,
    "removing one of two faces still leaves an identity");
  assert.equal(anchorLocked(second, CHARACTER_SHEET, set), false);
  // ...and removing one restores the lock on what is left.
  assert.equal(anchorLocked(first, CHARACTER_SHEET, [first, link("full_body", "b1")]), true);
});

// A prop's ONE role is also its anchor, so under the old total-count rule every
// reference on a prop with two of them was locked — the whole sheet undeletable,
// under a tooltip about plates "generated against" a picture that generates
// nothing. Counting anchor-role refs frees them.
test("a prop's library references stay removable", () => {
  const set = [link("ref", "r1"), link("ref", "r2"), link("ref", "r3")];
  for (const l of set) assert.equal(anchorLocked(l, NOTE_SHEET, set), false);
  assert.equal(anchorLocked(set[0], NOTE_SHEET, [set[0]]), false, "the only one, too");
});

// `order=slot&limit=1` — the first is the identity, the rest are on file and
// read by nothing. The list arrives in slot order.
test("only the first sheet in the anchor slot is the live anchor", () => {
  const first = link("face", "f1");
  const second = link("face", "f2");
  const body = link("full_body", "b1");
  const set = [first, second, body];
  assert.equal(anchorStanding(first, CHARACTER_SHEET, set), "live");
  assert.equal(anchorStanding(second, CHARACTER_SHEET, set), "spare");
  assert.equal(anchorStanding(body, CHARACTER_SHEET, set), null, "another role is not an anchor");
  assert.equal(anchorStanding(second, CHARACTER_SHEET, [second, body]), "live",
    "the spare is promoted when the one above it goes");
});

// Every role in `bible_assets_role_check` (migration 20260906120000). A value
// outside it is not a bad label — it is a 400 from Postgres and a reference
// that silently never attaches.
const DB_ROLES = new Set(["ref", "face", "full_body", "side", "outfit", "turnaround",
                          "master", "alt_angle", "detail", "atmosphere", "coverage"]);

test("every sheet role is one the database accepts", () => {
  for (const sheet of [CHARACTER_SHEET, PLACE_SHEET, NOTE_SHEET]) {
    for (const r of sheet.roles) {
      assert.ok(DB_ROLES.has(r.id), `${r.id} is not in bible_assets_role_check`);
    }
  }
});

// AssetPickerModal is shared and seeds each pick from the ASSET, using the
// block's vocabulary — `look` for anything in the library, `character` /
// `environment` for anything it recognises from the bible. Handed straight to
// attachRef, every one of those violates the check constraint.
test("a role from the shared picker is coerced to one this sheet has", () => {
  for (const foreign of ["look", "character", "environment", "start_frame", "chain"]) {
    assert.equal(legalRole(PLACE_SHEET, foreign, "master"), "master");
    assert.equal(legalRole(CHARACTER_SHEET, foreign, "face"), "face");
    assert.equal(legalRole(NOTE_SHEET, foreign, "ref"), "ref");
  }
  // A role the sheet does declare is kept — the chooser still decides.
  assert.equal(legalRole(PLACE_SHEET, "atmosphere", "master"), "atmosphere");
  assert.equal(legalRole(CHARACTER_SHEET, "turnaround", "face"), "turnaround");
  // "atmosphere" is a place's angle and not a character's slot.
  assert.equal(legalRole(CHARACTER_SHEET, "atmosphere", "face"), "face");
});

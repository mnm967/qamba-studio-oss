// The pure half of the segment storyboard: layout, the refusals, and the
// merge of N per-beat panel specs into ONE sheet spec.
//
// What these pin is mostly the merge, because every way it can be wrong is
// silent: a sheet with fewer panels than the block has shots renumbers every
// shot after the join, a sheet that stages a character twice spends a slot on
// a picture it already has, and a sheet that rotates its plate panel to panel
// argues with its own claim to be one place.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_SHEET_PANELS, blockSheetSpec, sheetBlocker, sheetLayout } from "./blockSheetSpec.ts";
import type { Beat, BibleEntry, GenerationBlock, Scene } from "./db/types.ts";

const entry = (id: string, name: string, kind: string): BibleEntry =>
  ({ id, name, kind, identity_line: `${name} looks like ${name}`, doc: {},
     summary: null, status: "confirmed" } as unknown as BibleEntry);

const REI = entry("c1", "Astronaut Rei", "character");
const VIL = entry("c2", "Villian Rei", "character");
const ENV = entry("e1", "Rain Street", "environment");

const scene = (id: string, envId: string | null, castIds: string[]): Scene =>
  ({ id, storyboard_id: "sb", idx: 0, slug: "MEMORY_CAPTURE", environment_id: envId,
     cast_ids: castIds, duration_ms: 12000, meta: { time: "night" },
     still_asset_id: null } as unknown as Scene);

const beat = (id: string, sceneId: string, idx: number, action: string,
              camera: string, cast: string[]): Beat =>
  ({ id, scene_id: sceneId, idx, action, camera, duration_ms: 3000,
     dialogue: [], sfx: null, meta: { cast } } as unknown as Beat);

const block = (beatIds: string[]): GenerationBlock =>
  ({ id: "b1", idx: 12, storyboard_id: "sb", beat_ids: beatIds, scene_ids: ["s1"],
     params: {} } as unknown as GenerationBlock);

const ctx = { style: "Anime (2D)", imageModel: "gpt-image-2",
              bible: [REI, VIL, ENV], projectId: "p", episodeId: "e" };

const S1 = scene("s1", "e1", ["c1", "c2"]);
const BEATS = [
  beat("t1", "s1", 0, "Astronaut Rei stands alone on the wet street.",
       "an extreme wide establishing shot at eye level", ["Astronaut Rei"]),
  beat("t2", "s1", 1, "Villian Rei steps through the tear toward Astronaut Rei.",
       "a low-angle medium-wide shot", ["Astronaut Rei", "Villian Rei"]),
  beat("t3", "s1", 2, "Astronaut Rei locks her arms wide.",
       "a clean locked medium-wide frontal shot", ["Astronaut Rei", "Villian Rei"]),
];

test("layout matches the worker's, so numbers and shot order agree", () => {
  assert.deepEqual(sheetLayout(1), { rows: 1, cols: 1 });
  assert.deepEqual(sheetLayout(2), { rows: 1, cols: 2 });
  assert.deepEqual(sheetLayout(4), { rows: 2, cols: 2 });
  assert.deepEqual(sheetLayout(6), { rows: 2, cols: 3 });
  assert.deepEqual(sheetLayout(9), { rows: 3, cols: 3 });
  // Past the ceiling it CLAMPS rather than growing: a 4x4 cell is unreadable
  // once H3 scales the sheet to the render's pixel area, and `sheetBlocker`
  // refuses that block anyway.
  assert.deepEqual(sheetLayout(12), { rows: 3, cols: 3 });
});

test("a block past the panel ceiling is refused, with the reason", () => {
  const many = Array.from({ length: MAX_SHEET_PANELS + 1 }, (_, i) =>
    beat(`x${i}`, "s1", i, "something happens", "a medium shot", ["Astronaut Rei"]));
  const why = sheetBlocker(many, "gpt-image-2");
  assert.ok(why && why.includes("too small to read"), why ?? "expected a refusal");
  assert.equal(sheetBlocker(BEATS, "gpt-image-2"), null);
  assert.ok(sheetBlocker([], "gpt-image-2"));
});

test("a breath beat is a HOLD panel, so shot k is still panel k", () => {
  // The envelope binds shot k to panel k and counts the block's beats, so a
  // sheet that dropped its breath beat would bind the last shot to a cell
  // that is not there. It stays, as a held pause on the panel before it.
  const b1 = beat("b1", "s1", 0, "She waits.", "a wide shot; the camera holds", ["Astronaut Rei"]);
  const b2 = { ...beat("b2", "s1", 1, "", "", []), meta: { cast: [], breath: true } } as unknown as Beat;
  const { spec } = blockSheetSpec(block(["b1", "b2"]), [b1, b2], [S1], ctx);
  const panels = spec.panels as Array<{ action: string; hold?: boolean; camera: string }>;
  assert.equal(panels.length, 2);
  assert.equal(panels[1].hold, true);
  assert.match(panels[1].action, /panel 1/);
  assert.equal(panels[1].camera, b1.camera);
  assert.equal(sheetBlocker([b1, b2], "krea2-local"), null);
  assert.match(sheetBlocker([b2], "krea2-local") ?? "", /no shots/);
});

test("the panel list is the block's shots, in order", () => {
  const { spec } = blockSheetSpec(block(["t1", "t2", "t3"]), BEATS, [S1], ctx);
  const panels = spec.panels as Array<{ action: string }>;
  assert.equal(panels.length, 3);
  assert.ok(panels[0].action.startsWith("Astronaut Rei stands alone"));
  assert.ok(panels[2].action.startsWith("Astronaut Rei locks her arms"));
  assert.deepEqual(spec.rows, 2);
  assert.deepEqual(spec.cols, 2);
});

test("a character in three shots is ONE locked identity, not three", () => {
  // Deduping is the whole reason the merge exists. Staging Astronaut Rei's
  // turnaround once per shot would spend three of the sheet's reference slots
  // on the same picture.
  const { spec, anchors } = blockSheetSpec(block(["t1", "t2", "t3"]), BEATS, [S1], ctx);
  const cast = spec.cast as Array<{ name: string }>;
  assert.deepEqual(cast.map((c) => c.name), ["Astronaut Rei", "Villian Rei"]);
  // characters (deduped) + exactly one location plate
  assert.equal(anchors.length, 3);
  assert.equal(anchors.filter((a) => a.entry_id === ENV.id).length, 1);
});

test("the location plate is LAST and there is exactly one of it", () => {
  // One plate for the whole sheet by construction: the sheet's claim is that
  // it is one place, so rotating the plate panel to panel would argue with it.
  const { anchors, spec } = blockSheetSpec(block(["t1", "t2", "t3"]), BEATS, [S1], ctx);
  assert.equal(anchors[anchors.length - 1].entry_id, ENV.id);
  assert.equal((spec.location as { name: string }).name, "Rain Street");
  assert.ok((spec.refs as string[])[2].includes("Rain Street"));
});

test("a block spanning two scenes gets ALL its shots", () => {
  // The failure this prevents: a sheet drawn from one scene's beats carries
  // fewer panels than the block has shots, and the panel NUMBERS are what bind
  // to `[Shot N]` — so every shot after the join is off by one.
  const s2 = scene("s2", "e1", ["c2"]);
  const t4 = beat("t4", "s2", 0, "Villian Rei walks on through the debris.",
                  "a low-angle medium tracking shot", ["Villian Rei"]);
  const { spec } = blockSheetSpec(block(["t3", "t4"]), [...BEATS, t4], [S1, s2], ctx);
  assert.equal((spec.panels as unknown[]).length, 2);
});

test("an unlocated scene composes without a plate rather than failing", () => {
  // MEMORY_CAPTURE shipped with `environment_id` null — one of two scenes on
  // that board with no location at all — so this is the state the feature was
  // built against, not a corner case. The sheet establishes the place from
  // prose; what it must not do is refuse, or invent a plate.
  const s = scene("s1", null, ["c1", "c2"]);
  const { spec, anchors } = blockSheetSpec(block(["t1", "t2"]), BEATS, [s], ctx);
  assert.equal(spec.location, null);
  assert.ok(!anchors.some((a) => a.entry_id === ENV.id));
  assert.equal((spec.panels as unknown[]).length, 2);
});

test("the spec names the kind the worker dispatches on", () => {
  const { spec } = blockSheetSpec(block(["t1"]), BEATS, [S1], ctx);
  assert.equal(spec.kind, "block_sheet");
  assert.equal(spec.style, "Anime (2D)");
  assert.equal(spec.time_of_day, "night");
});

// A SEGMENT STORYBOARD — one generation block's shots as ONE numbered contact
// sheet, staged whole into that block's r2v render as a single `<Picture N>`.
//
// This is the block twin of a per-beat panel, and it exists because per-beat
// panels lose on a block in two ways at once, both measured on Rei E3
// MEMORY_CAPTURE b13 (four shots, `minimax-h3-pdd`, 2026-09-01):
//
//   * COVERAGE. `budget_refs` allows TWO panels per block, because identity
//     sheets and the location plate need the other slots. So a four-shot block
//     composes shots 1 and 2 and hands shots 3 and 4 nothing — there, the
//     gravity gesture and the debris impact, i.e. the two shots the scene is
//     about. Nothing errors; truncation is not an error.
//   * CONSISTENCY. Panels are separate renders, so they drift. Those four came
//     back as four different cities at three different times of day — one of
//     them in overcast daylight with the wrong cast entirely — and the block
//     was handed two of them as "storyboard reference, framing intended".
//
// One sheet is one picture, one grade, one location, every shot, for ONE slot
// instead of two. Measured, the same four beats drawn both ways on gpt-image-2:
//
//     hue spread   95.6deg -> 4.4deg     (22x tighter)
//     saturation   172.1   -> 9.9        (17x tighter)
//     luma corr    +0.142  -> +0.086     (still four different shots)
//
// The last row is what makes the first two honest. Consistency bought by
// repeating one frame would show up as luma correlation RISING toward the 0.5+
// that the panel-variety measurement calls "shot from one seat". It fell: the
// camera still moves across all four panels, they are simply in one place.
//
// The grammar the sheet is CONSUMED with lives in `worker/h3_prompt.py` (the
// `block_sheet` ref kind) and is adapted from amao2001's published
// `minimax_h3_r2v_story_board` workflow, whose load-bearing sentence is
// "Treat each panel as a separate chronological shot beat, not as one
// composite image".
//
// This is the PURE half — the composition, and its twin is
// `worker/image_prompt._sheet_prompt`. Split from the queuer for the reason
// `panelSpec` is split from `panels`: everything here is testable under
// `node --test` precisely because it reaches no database, and a module that
// imports `./db/jobs` cannot be (node resolves the extensionless import and
// fails).
import { locationPlate, panelSpec, type PanelCtx } from "./panelSpec.ts";
import type { Anchor } from "./panelPrompt";
import type { Beat, BibleEntry, GenerationBlock, Scene } from "./db/types";

/** gpt-image-2's landscape canvas. The sheet is sized to the CANVAS, not to
 *  the video: H3 scales a reference image down to the render's own pixel area
 *  whatever it is handed, so asking for a shape the provider serves natively
 *  beats asking for 1280x736 and having it snapped. */
export const SHEET_W = 1536;
export const SHEET_H = 1024;

/** Twin of gridsheet.MAX_PANELS. Nine is the ceiling for two reasons, and only
 *  the first is about pixels: H3 scales a reference image to the render's own
 *  area, so on a 1280x736 render a 3x3 sheet's cell is ~396x264 against a
 *  2x3's ~396x396 — a third of the vertical resolution per panel.
 *
 *  The second is the interesting one. Measured on Rei E3 b16 (four beats, one
 *  block, sheets-only references, gpt-image-2, 2026-09-01), asking the same
 *  four story moments for 6, 8 and 9 panels:
 *
 *      6   1-2 panels per moment, chronological, all four covered
 *      8   SIX of eight panels spent on moments A and B; C and D compressed
 *          into two, and the last moment's insert dropped entirely
 *      9   3/2/2/2 across the four, chronological, all four covered
 *
 *  8 was worse than 6 AND worse than 9, which is not a resolution effect — it
 *  is front-loading. Given more cells than the story has moments, the model
 *  subdivides what it read FIRST. What fixed 9 was budgeting the moments in
 *  the prompt ("roughly two panels each, never more than three on one, the
 *  last moment must be visibly covered"). So: do not read "more panels = more
 *  coverage"; without an explicit budget it is more coverage of the opening.
 *
 *  NOTE this ceiling is not reachable from `blockSheetSpec` today, which draws
 *  exactly one panel per shot — the expansion above was measured by hand. A
 *  sheet with MORE panels than the block has shots also needs `h3_prompt` to
 *  stop binding shot k to panel k, because that binding would be a lie; the
 *  honest version splits the beats to match the sheet. See the note on
 *  `blockSheetSpec`. */
export const MAX_SHEET_PANELS = 9;

/** (rows, cols) for n panels, read left-to-right then top-to-bottom. Twin of
 *  `gridsheet.grid_layout` — the worker slices nothing here, but the layout
 *  has to match what the prompt asks for or the panel NUMBERS and the shot
 *  order stop agreeing. */
export function sheetLayout(n: number): { rows: number; cols: number } {
  const k = Math.max(1, Math.min(MAX_SHEET_PANELS, Math.floor(n)));
  if (k <= 2) return { rows: 1, cols: k };
  if (k <= 4) return { rows: 2, cols: 2 };
  if (k <= 6) return { rows: 2, cols: 3 };
  return { rows: 3, cols: 3 };
}

/** Why this block cannot have a sheet drawn for it, or null when it can.
 *
 *  Every one of these is a state the button would otherwise queue a render
 *  for and get something useless back, so each is said rather than disabled
 *  silently. */
export function sheetBlocker(
  beats: Beat[], imageModel: string | null | undefined,
): string | null {
  const drawable = beats;
  if (!drawable.filter((b) => !b.meta?.breath).length) return "this block has no shots yet";
  if (drawable.length > MAX_SHEET_PANELS)
    return `${drawable.length} shots is past the ${MAX_SHEET_PANELS}-panel `
      + "ceiling — each panel would be too small to read once H3 scales the "
      + "sheet down";
  if (!imageModel) return "no image model is set for this project";
  return null;
}

/** The spec + anchors for one block's sheet.
 *
 *  Built by running the EXISTING per-beat `panelSpec` over each shot and
 *  merging, rather than by re-deriving cast, wardrobe and plate here. That is
 *  deliberate: `panelSpec` is where the cast-resolution order
 *  (`scene cast before the rest of the bible`, `exact before base`), the
 *  `featuredCast` pruning and the variant-to-parent anchor walk all live, and
 *  every one of them was a measured bug fix. A second implementation of them
 *  is a second implementation to get wrong.
 *
 *  What this ADDS is the three things a sheet needs and a panel does not: the
 *  panel list in shot order, ONE cast union across the whole block, and ONE
 *  plate for all of them. */
export function blockSheetSpec(
  block: GenerationBlock, beats: Beat[], scenes: Scene[], ctx: PanelCtx,
): { spec: Record<string, unknown>; anchors: Anchor[] } {
  const byId = new Map(beats.map((b) => [b.id, b]));
  // EVERY beat of the block is a panel, breath beats included. The compiled
  // envelope binds shot k to panel k (`h3_prompt`, "the shot cuts to panel 3
  // of <Picture N>"), and `ref_plan_for` counts the block's beats — so a
  // sheet that skipped its breath beat would leave the LAST shot bound to a
  // panel that does not exist (or to the black cell `_sheet_prompt` fills an
  // unused cell with). A breath beat is a held pause on the previous panel's
  // staging, and that is what its panel asks for.
  const shots = (block.beat_ids ?? [])
    .map((id) => byId.get(id))
    .filter((b): b is Beat => !!b);
  const sceneById = new Map(scenes.map((s) => [s.id, s]));

  // A block may span two scenes of ONE location, so the location comes from
  // whichever of its scenes actually names one. A block whose scenes are all
  // unlocated gets no [LOCKED LOCATION] and no plate — which is honest, and is
  // exactly the state MEMORY_CAPTURE was in (`environment_id` null), where the
  // sheet has to establish the street from prose alone.
  const place: BibleEntry | null = shots
    .map((b) => sceneById.get(b.scene_id ?? "")?.environment_id)
    .map((id) => (id ? ctx.bible.find((e) => e.id === id) ?? null : null))
    .find((e): e is BibleEntry => !!e) ?? null;

  // Per-shot specs, through the real panel path. `sceneBeats` is the shot's own
  // scene, because the plate rotation is a per-scene decision and a block is
  // not a scene.
  const per = shots.map((b) => {
    const sc = sceneById.get(b.scene_id ?? "");
    if (!sc) return null;
    const sceneBeats = beats.filter((x) => x.scene_id === b.scene_id)
      .sort((x, y) => x.idx - y.idx);
    return { beat: b, ...panelSpec(sc, b, ctx, sceneBeats) };
  }).filter(Boolean) as Array<{ beat: Beat; spec: Record<string, unknown>; anchors: Anchor[] }>;
  const drawn = per.filter((p) => !p.beat.meta?.breath);

  // ONE cast across the sheet, in FIRST-MENTION order — the order the panels
  // introduce people, which is also the order the [LOCKED CHARACTER] blocks
  // and the reference images should follow. Deduped by name: a character in
  // three shots is one locked identity, not three.
  const castByName = new Map<string, { name: string; identity: string | null }>();
  for (const p of drawn)
    for (const c of (p.spec.cast as Array<{ name: string; identity: string | null }>) ?? [])
      if (c?.name && !castByName.has(c.name)) castByName.set(c.name, c);
  const cast = [...castByName.values()];

  // ONE anchor set: each character once, then the location LAST. Character
  // sheets lead because the reference-editing families weight the earlier
  // images harder and identity is what drifts; the plate is one picture doing
  // one job and does not need the strong slot when a [LOCKED LOCATION] block
  // is also naming it. (Measured that way on the b13 sheet: astronaut,
  // villain, street plate — both faces held across all four panels.)
  const seen = new Set<string>();
  const anchors: Anchor[] = [];
  const refs: string[] = [];
  for (const p of drawn) {
    const subs = (p.spec.ref_subjects as Array<{ kind: string; name: string } | null>) ?? [];
    const rf = (p.spec.refs as string[]) ?? [];
    p.anchors.forEach((a, i) => {
      const sub = subs[i];
      if (!sub || sub.kind !== "character") return;
      if (seen.has(sub.name)) return;
      seen.add(sub.name);
      anchors.push(a);
      refs.push(rf[i] ?? `${sub.name}'s character sheet`);
    });
  }
  // The plate is chosen off the block's OPENING camera, through the same ring
  // the panels use — an establishing wide wants the master, a reverse wants
  // the alt angle. One plate for the whole sheet by construction: the sheet's
  // whole claim is that it is one place, so rotating it panel to panel would
  // be arguing with itself.
  const [plateRoles] = locationPlate(drawn[0]?.beat.camera ?? shots[0]?.camera ?? "", 0);
  if (place) {
    anchors.push({ entry_id: place.id, roles: plateRoles, first: true });
    refs.push(`the ${place.name} location plate`);
  }

  const layout = sheetLayout(shots.length);
  const spec: Record<string, unknown> = {
    kind: "block_sheet",
    ...layout,
    style: ctx.style,
    time_of_day: (sceneById.get(shots[0]?.scene_id ?? "")?.meta?.time as string) ?? null,
    cast,
    location: place ? { name: place.name, identity: place.identity_line } : null,
    refs,
    panels: per.map((p, i) => (p.beat.meta?.breath
      ? {
          // A held pause: the same framing as the panel before it, nobody
          // moving. The worker's `_sheet_prompt` leads every panel with its
          // shot size, so the hold names its predecessor's camera.
          camera: per[i - 1]?.beat.camera ?? p.beat.camera ?? "",
          action: `A wordless pause: exactly the framing and staging of panel ${i}, `
            + "held still, nobody moving",
          cast: [], hold: true,
        }
      : {
          camera: p.beat.camera ?? "",
          action: p.beat.action,
          cast: ((p.spec.cast as Array<{ name: string }>) ?? []).map((c) => c.name),
        })),
  };
  return { spec, anchors };
}

// Whether a scene's blocks render with the COMBAT adapter, and what a toggle
// has to do to change that.
//
// Pure, and its own module, because every wrong answer here is silent — the
// block renders either way and only the choreography differs:
//
//  * THE FLAG THAT MATTERS IS ON THE BLOCK, NOT THE SCENE. `_block_loras`
//    reads `params.fight` and appends `combat@1.0`; `handle_launch_render`
//    derives that from the scene's `meta.type == "action"` ONCE, at plan time,
//    and stamps it. Deriving it per render was rejected deliberately (two
//    takes of one block must not disagree about whether it is a fight), so a
//    scene retyped afterwards — or planned before the flag shipped on
//    2026-08-22 — never reaches the render. Writing `meta.type` here would
//    change the storyboard's prose and nothing about the picture.
//  * A BLOCK MAY COVER TWO SCENES. Measured on this studio's data: 37 of 499.
//    A block spans one location and may span two scenes, and the plan-time
//    rule is that ANY action scene in it makes the WHOLE block a fight — half
//    a block with the adapter and half without is the continuity break
//    `_block_loras` exists to prevent. So a toggle here reaches the other
//    scene too, and has to say so rather than doing it quietly.
//  * A MODEL THAT DOES NOT DECLARE `combat` IGNORES THE FLAG. `_block_loras`
//    only appends the key where the model declares it, so on such a block the
//    switch is a control that cannot reach the render — the thing this
//    codebase keeps refusing to ship.

import { MODEL_OF } from "./blockModel.ts";

/** The catalog rows a block could render on, reduced to the one question. */
export type DeclaresCombat = (modelKey: string | null) => boolean | null;

/** The adapter `_block_loras` appends, by key. */
export const FIGHT_LORA = "combat";

export interface FightBlock {
  id: string;
  idx: number;
  scene_ids: string[];
  params: Record<string, unknown>;
}

export interface FightState {
  /** The writer's own `meta.type`, verbatim — null when unset. */
  sceneType: string | null;
  /** What `handle_launch_render` would derive: the plan-time answer. */
  planned: boolean;
  /** Blocks covering this scene. */
  total: number;
  /** …of which carry `fight: true`, i.e. render with the adapter today. */
  on: number;
  /** …of which have never been decided either way (the key is absent). This
   *  is the state a board planned before the flag is in, and it is NOT the
   *  same as an explicit off. */
  undecided: number;
  /** The switch's position: on only when EVERY block is on. A mixed scene
   *  reads as off and one click makes it uniform, the usual resolution of an
   *  indeterminate checkbox. */
  checked: boolean;
  /** True when the blocks disagree with each other. */
  mixed: boolean;
  /** True when the blocks disagree with the scene's own type — the exact gap
   *  a board planned before 2026-08-22 is in, and the reason this control
   *  exists at all. */
  drifted: boolean;
  /** Blocks that also cover another scene, with those scenes' ids. Toggling
   *  changes what they render there too. */
  shared: { idx: number; otherSceneIds: string[] }[];
  /** Blocks whose model does not declare the adapter — the flag is inert. */
  inert: { idx: number; model: string }[];
}

const flagOf = (b: FightBlock): boolean | undefined => {
  const v = b.params?.fight;
  return v === undefined || v === null ? undefined : !!v;
};

// `_block_model`'s fallback lives in ONE place — a block with no `model_key`
// renders on plain `minimax-h3`, and this file and the model card next to it
// must never disagree about that.
export { MODEL_OF };

/** model_map key -> does that model declare the combat adapter.
 *
 *  Built from `capabilities.styleLoras`, which is what `_block_loras` checks
 *  against (`R.ensure_model(model).style_loras`) and what every picker in the
 *  app already reads. A row's catalog id is not its model_map key, so the map
 *  is keyed through `modelKeyOf` — the same inversion the retake's `model_id`
 *  goes through, in the other direction.
 *
 *  A key with NO row is absent from the map, and the caller reads that as
 *  "could not tell" rather than "refuses": warning on a model the catalog
 *  simply has not loaded yet is the false alarm this whole file avoids. */
export function combatByModelKey(
  catalog: { id: string; capabilities?: Record<string, unknown> | null }[] | null | undefined,
  keyOf: (id: string) => string | undefined,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const row of catalog ?? []) {
    const key = keyOf(row.id);
    if (!key) continue;                       // a desktop `local:` id has none
    const raw = row.capabilities?.styleLoras;
    // Bare strings still parse — the catalog carries both spellings.
    const keys = Array.isArray(raw)
      ? raw.map((l) => (typeof l === "string" ? l : (l as { key?: string })?.key))
      : [];
    out.set(key, keys.includes(FIGHT_LORA));
  }
  return out;
}

export function sceneFightState(
  scene: { id: string; meta?: Record<string, unknown> | null },
  blocks: FightBlock[],
  declares: DeclaresCombat,
): FightState {
  const mine = blocks.filter((b) => (b.scene_ids ?? []).includes(scene.id));
  const raw = scene.meta?.type;
  const sceneType = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  // `handle_launch_render`'s test, character for character.
  const planned = (sceneType ?? "").toLowerCase() === "action";

  const flags = mine.map(flagOf);
  const on = flags.filter((f) => f === true).length;
  const undecided = flags.filter((f) => f === undefined).length;

  return {
    sceneType,
    planned,
    total: mine.length,
    on,
    undecided,
    checked: mine.length > 0 && on === mine.length,
    mixed: on > 0 && on < mine.length,
    // Only meaningful where there ARE blocks: a scene with none has nothing
    // to have drifted.
    drifted: mine.length > 0 && planned !== (on === mine.length),
    shared: mine
      .map((b) => ({
        idx: b.idx,
        otherSceneIds: (b.scene_ids ?? []).filter((s) => s !== scene.id),
      }))
      .filter((s) => s.otherSceneIds.length > 0),
    inert: mine
      .map((b) => ({ idx: b.idx, model: MODEL_OF(b) }))
      // `false` only — null is "could not tell", and warning on an unreadable
      // catalog would claim the model refuses the adapter.
      .filter((x) => declares(x.model) === false),
  };
}

/** The writes one click makes: each block's FULL next params.
 *
 *  Read-modify-write per block rather than a blanket patch, because `params`
 *  is one jsonb blob holding the model key, the resolution, the review flag
 *  and the LoRA stack — replacing it wholesale to set one key is how a
 *  per-block model override disappears.
 *
 *  Off writes an explicit `false` rather than deleting the key. Both render
 *  the same (`_block_loras` reads `if not p.get("fight")`), but absent means
 *  "nobody decided" and is what `backfill_fight.py`'s default pass fills in —
 *  so deleting would let a later backfill silently turn it back on. */
export function fightPatch(
  scene: { id: string },
  blocks: FightBlock[],
  on: boolean,
): { id: string; params: Record<string, unknown> }[] {
  return blocks
    .filter((b) => (b.scene_ids ?? []).includes(scene.id))
    .filter((b) => flagOf(b) !== on)
    .map((b) => ({ id: b.id, params: { ...(b.params ?? {}), fight: on } }));
}

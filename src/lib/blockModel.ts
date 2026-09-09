// Which checkpoint a scene's blocks render on, and what changing it has to
// write.
//
// THE PROJECT SETTING IS A DEFAULT FOR NEW WORK, NOT A LIVE OVERRIDE, and that
// is the whole reason this module exists. `_block_model(block, params)` reads
// `params.model_key` off the BLOCK and falls back to plain `minimax-h3`; the
// wizard's pick is copied onto every block by `handle_launch_render` ONCE, at
// plan time, so an episode cannot switch checkpoints shot to shot. Change
// `projects.settings.video_model` afterwards and nothing already planned
// moves — a scene retake renders on whatever its blocks were stamped with, and
// says nothing about the difference. Measured on this studio's own data: a
// project set to `h3-pdd-local` whose 22 blocks all carry `minimax-h3-turbo`,
// planned before the setting changed.
//
// So the answer is NOT to make the retake read the project setting — that
// would break the invariant on the one press most likely to be aimed at a
// single scene. It is to make what the blocks carry VISIBLE, and to let it be
// re-stamped deliberately, which is the shape `sceneFight.ts` already uses for
// the combat adapter one card over.
//
// TWO KEYS MOVE TOGETHER. `model_key` picks the checkpoint; `model_id` is the
// CATALOG id, which does not pick anything but is what `job_timings.model_id`
// and `cost_ledger` file the render under (and what `catalogIdOf` reads first,
// ahead of inverting the key). Writing one without the other renders on one
// model and books the time against another — the attribution bug the
// storyboard retake's hardcoded "h3-local" already caused once.

export interface ModelBlock {
  id: string;
  idx: number;
  scene_ids: string[];
  params: Record<string, unknown>;
}

/** `_block_model`'s fallback, verbatim: a block with no `model_key` renders on
 *  H3_MODEL, which is plain `minimax-h3` — NOT on the project's default and
 *  not on nothing. Two of the blocks on the board this was written against are
 *  in exactly that state, so a card that reported them as "the project model"
 *  would name a checkpoint they will not use. */
export const MODEL_OF = (b: { params?: Record<string, unknown> | null }): string =>
  (typeof b.params?.model_key === "string" && b.params.model_key) || "minimax-h3";

export interface SceneModelState {
  /** Blocks covering this scene. */
  total: number;
  /** What they render on: one entry per distinct model_map key, block indexes
   *  in `idx` order, biggest group first. */
  byKey: { key: string; idxs: number[] }[];
  /** The project default as a model_map key — undefined when it does not
   *  resolve to one (a desktop `local:` id has no key at all). */
  projectKey: string | undefined;
  /** The scene's own blocks disagree with each other. Legitimate — a block
   *  can be re-rendered on another checkpoint from PromptRefsModal — and worth
   *  saying, because the scene then has no single answer. */
  mixed: boolean;
  /** At least one block is on something other than the project default. Only
   *  ever true when `projectKey` resolved: "could not tell" must not read as
   *  "drifted". */
  drifted: boolean;
  /** Blocks that also cover another scene, with those scenes' ids. Re-stamping
   *  changes what they render there too — same reasoning as the fight toggle,
   *  and stronger here, since a block spanning two scenes must not render half
   *  on one checkpoint. */
  shared: { idx: number; otherSceneIds: string[] }[];
}

export function sceneModelState(
  scene: { id: string },
  blocks: ModelBlock[],
  projectKey: string | undefined,
): SceneModelState {
  const mine = blocks.filter((b) => (b.scene_ids ?? []).includes(scene.id));

  const groups = new Map<string, number[]>();
  for (const b of mine) {
    const k = MODEL_OF(b);
    const at = groups.get(k);
    if (at) at.push(b.idx);
    else groups.set(k, [b.idx]);
  }
  const byKey = [...groups.entries()]
    .map(([key, idxs]) => ({ key, idxs: [...idxs].sort((a, z) => a - z) }))
    // Biggest group first, then alphabetically — a stable order, so the card
    // does not reshuffle between renders of the same unchanged scene.
    .sort((a, z) => z.idxs.length - a.idxs.length || a.key.localeCompare(z.key));

  return {
    total: mine.length,
    byKey,
    projectKey,
    mixed: byKey.length > 1,
    drifted: !!projectKey && mine.length > 0 && byKey.some((g) => g.key !== projectKey),
    shared: mine
      .map((b) => ({
        idx: b.idx,
        otherSceneIds: (b.scene_ids ?? []).filter((s) => s !== scene.id),
      }))
      .filter((s) => s.otherSceneIds.length > 0),
  };
}

/** The writes one "use the project model" press makes: each block's FULL next
 *  params.
 *
 *  Read-modify-write per block for the reason `fightPatch` gives — `params` is
 *  one jsonb blob carrying the fight flag, the resolution, the review switch
 *  and the LoRA stack, and replacing it to set the model is how those vanish.
 *
 *  Blocks ALREADY on the key are skipped, so a press that changes nothing
 *  writes nothing and the receipt can say so rather than claiming a change.
 *  A block whose `model_id` is stale but whose `model_key` already matches IS
 *  rewritten: the pair has to agree or the render is filed under the wrong
 *  model. */
export function modelPatch(
  scene: { id: string },
  blocks: ModelBlock[],
  key: string,
  catalogId: string,
): { id: string; params: Record<string, unknown> }[] {
  return blocks
    .filter((b) => (b.scene_ids ?? []).includes(scene.id))
    .filter((b) => MODEL_OF(b) !== key || b.params?.model_id !== catalogId)
    .map((b) => ({
      id: b.id,
      params: { ...(b.params ?? {}), model_key: key, model_id: catalogId },
    }));
}

/** model_map key -> the catalog row's own display name.
 *
 *  Only so a card can say "Turbo" where the row says so, instead of printing
 *  `minimax-h3-turbo` at somebody. A key with no row is absent, and the caller
 *  falls back to the key itself — inventing a friendly name for a model the
 *  catalog has not loaded is worse than showing the real one. */
export function modelNameByKey(
  catalog: { id: string; display_name?: string | null; kind?: string }[] | null | undefined,
  keyOf: (id: string) => string | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of catalog ?? []) {
    if (row.kind && row.kind !== "video") continue;
    const key = keyOf(row.id);
    if (!key || !row.display_name) continue;
    if (!out.has(key)) out.set(key, row.display_name);
  }
  return out;
}

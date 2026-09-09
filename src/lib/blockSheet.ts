// Queueing a SEGMENT STORYBOARD. The composition — and the whole argument for
// it — lives in ./blockSheetSpec, which is pure and therefore tested; this
// file is the half that reaches the database, exactly the split `panels.ts`
// makes against `panelSpec.ts`. Re-exported so callers import one module.
import { enqueueJob, USER_PRIORITY } from "./db/jobs";
import { modelKeyOf } from "./projectSettings";
import { SHEET_H, SHEET_W, blockSheetSpec } from "./blockSheetSpec";
import { beatImageId, type PanelCtx } from "./panelSpec";
import { queueBeatPanel } from "./panels";
import type { Beat, GenerationBlock, Scene } from "./db/types";

export * from "./blockSheetSpec";

/** How a block's sheet comes to exist.
 *
 *  `draw`    — ONE image model paints the whole numbered board from the shot
 *              descriptions plus the character sheets (gpt-image-2 measured
 *              best: 4-14deg of hue spread across a block, against 95 for
 *              separately drawn panels). A hosted render, ~$0.30 a block.
 *  `compose` — the block's own per-shot PANELS, each an identity edit of the
 *              same character sheet on Krea 2, laid into a labelled grid by
 *              the worker (`handle_sheet_compose`). No hosted call, no GPU
 *              beyond the panels the plan already draws; and the worker
 *              MEASURES the panels' agreement first and refuses a board whose
 *              panels are not one film, because a tiled set that disagrees
 *              was measured worse than no sheet at all. */
export type SheetSource = "draw" | "compose";

/** The source to reach for when the caller has no opinion.
 *
 *  COMPOSE, always. `draw` asks one image model to paint a whole numbered
 *  board from the shot descriptions, and it was measured best on a hosted
 *  instruction-follower; the local families here are measured WORSE at it than
 *  at drawing each panel separately — a board they refuse to lay out is sliced
 *  into panels that are halves of other panels, which is worse than no board.
 *  `draw` stays reachable as an explicit `opts.source`. */
export async function defaultSheetSource(_imageModel: string): Promise<SheetSource> {
  return "compose";
}

/** Draw the sheet. Lands on `generation_blocks.params.sheet_asset_id`, which
 *  is what `ref_plan_for` stages and what makes it survive a re-render.
 *
 *  Quality is NOT taken from the project's panel default. A panel is one of N
 *  pictures conditioning one shot; this single image is the composition of an
 *  entire block, and every panel in it is read at a quarter of the sheet's
 *  resolution or less once H3 scales it — so it is worth the tier the project
 *  would not spend on a panel. Overridable, and the caller says what it costs.
 */
export async function queueBlockSheet(
  block: GenerationBlock, beats: Beat[], scenes: Scene[], ctx: PanelCtx,
  opts: { quality?: string; seed?: number; source?: SheetSource } = {},
) {
  const source = opts.source ?? await defaultSheetSource(ctx.imageModel);
  if (source === "compose") return queueComposedSheet(block, beats, scenes, ctx);
  const { spec, anchors } = blockSheetSpec(block, beats, scenes, ctx);
  const n = ((spec.panels as unknown[]) ?? []).length;
  // The spec travels and `worker/image_prompt.py` composes it — same rule as
  // every other image job here (see `panelJobPayload`).
  const payload: Record<string, unknown> = { prompt_spec: spec, anchors };
  await enqueueJob({
    kind: "image_gen", lane: "gpu", priority: ctx.priority ?? USER_PRIORITY,
    project_id: ctx.projectId ?? undefined, episode_id: ctx.episodeId ?? undefined,
    payload: {
      ...payload,
      model_key: modelKeyOf(ctx.imageModel),
      quality: opts.quality ?? "high",
      width: SHEET_W, height: SHEET_H,
      ...(opts.seed != null ? { seed: opts.seed } : {}),
      auto_accept: true,
      label: `b${block.idx + 1} · segment storyboard (${n} shots)`,
      target: { block_id: block.id, as: "sheet" },
    },
  });
  return n;
}

/** The composed route: draw whichever of the block's shots has no panel yet,
 *  then queue the worker's `sheet_compose` behind those draws. Returns the
 *  number of shots the board will hold. A shot that already has a panel (or
 *  a user's own still) is not redrawn — the board is made of what is there. */
async function queueComposedSheet(
  block: GenerationBlock, beats: Beat[], scenes: Scene[], ctx: PanelCtx,
) {
  const byId = new Map(beats.map((b) => [b.id, b]));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const shots = (block.beat_ids ?? []).map((id) => byId.get(id)).filter((b): b is Beat => !!b);
  const deps: string[] = [];
  for (const b of shots) {
    if (b.meta?.breath || beatImageId(b).id) continue;
    const sc = sceneById.get(b.scene_id ?? "");
    if (!sc) continue;
    const sceneBeats = beats.filter((x) => x.scene_id === b.scene_id).sort((x, y) => x.idx - y.idx);
    const j = await queueBeatPanel(sc, b, ctx, sceneBeats);
    if (j?.id) deps.push(j.id);
  }
  await enqueueJob({
    kind: "sheet_compose", lane: "cpu", priority: ctx.priority ?? USER_PRIORITY,
    project_id: ctx.projectId ?? undefined, episode_id: ctx.episodeId ?? undefined,
    ...(deps.length ? { depends_on: deps } : {}),
    payload: {
      block_id: block.id,
      label: `b${block.idx + 1} · segment storyboard (${shots.length} shots, composed)`,
    },
  });
  return shots.length;
}

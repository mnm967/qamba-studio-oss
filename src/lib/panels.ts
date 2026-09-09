// Storyboard panels — ONE render per shot, and ONE mechanism that queues them.
//
// A panel and a beat still are the same picture in two different slots, and
// the slots are not redundant: `beats.meta.still_asset_id` is what a human
// deliberately put there (uploaded, picked from the library, designated as a
// start frame) and `beats.meta.panel_asset_id` is regenerable auto material.
// Two reasons they cannot be one key:
//   * "re-draw panels" would destroy an upload — the auto slot is rewritten
//     every time a scene is drawn, and the deliberate one must survive that;
//   * they stage into the render with OPPOSITE instructions. A user still is
//     a `look` (its framing explicitly disclaimed) or a `start_frame`; a panel
//     is a `scene_ref`, framing INTENDED. "A scene image's role is never
//     inferred" (CLAUDE.md) — so the role is stored, not guessed from where
//     the picture came from.
// Two keys, then. But one surface and one generator: every place that shows a
// beat's picture reads `still_asset_id ?? panel_asset_id`, the same precedence
// the worker's ref plan applies, and every place that draws one comes through
// here.
//
// This mirrors what tier 1 queues in worker/llm.py (`prompt_spec.kind ===
// "panel"`) deliberately. The client used to keep its own copy, and the copy
// quietly lacked the shot-subject anchor ordering that fixed Haru's identity
// drift and passed only the first clause of the camera line — so a panel drawn
// from the storyboard page was a measurably worse picture than the identical
// panel drawn by the planner.
// The COMPOSITION lives in ./panelSpec — pure, and therefore testable, which
// nothing in this file can be while it reaches the database. Re-exported so
// callers still import one module.
import { enqueueJob, USER_PRIORITY } from "./db/jobs";
import { type Anchor } from "./panelPrompt";
import { modelKeyOf, resolveDefaults, type ProjectSettings } from "./projectSettings";
import {
  PANEL_ALTS, PANEL_H, PANEL_W, PLANNER_STYLE_FALLBACK, panelSpec, seedBase,
  sceneStillSpec, type PanelCtx,
} from "./panelSpec";
import type { Beat, Scene } from "./db/types";

export * from "./panelSpec";

/** Where a panel's style and model come from — one resolver, because the two
 *  surfaces disagreed on both and the disagreement is invisible in the UI.
 *
 *  * Style is `projects.style`, NOT the settings style guide, and that is
 *    deliberate even though every hand-driven generator in the app prefers the
 *    guide. A panel's whole job is to look like the sheets it is anchored to,
 *    and those sheets were drawn by the planner off `projects.style` — the two
 *    fields genuinely disagree in the wild (AFTERLIGHT's guide reads
 *    "Live-action cinematic photography … no illustration cues" while its
 *    sheets and panels are anime, because `projects.style` is unset and the
 *    planner substitutes "anime"). Reading the guide here would have redrawn
 *    one panel photoreal in the middle of an animated storyboard. The
 *    fallback is the planner's, for the same reason: the storyboard page used
 *    to substitute "cinematic" instead, so a hand-drawn panel and a
 *    planner-drawn one already differed on any project with no style set.
 *  * Model is `resolveDefaults(settings).image_model`, the field the bible
 *    sheets are actually drawn with. The storyboard page read a
 *    `projects.image_model` COLUMN that nothing in the app writes, so it fell
 *    through to a hard-coded default — a project on Klein drew its panels on
 *    Krea 2, breaking the "a panel must look like its sheets" rule in the one
 *    surface that exists to enforce it. */
export function panelDefaults(
  settings: ProjectSettings | null | undefined,
  projectStyle?: string | null,
): { style: string; imageModel: string; quality: string } {
  return {
    style: (projectStyle ?? "").trim() || PLANNER_STYLE_FALLBACK,
    imageModel: resolveDefaults(settings).image_model,
    // Carried so a panel queued from ANY surface renders at the tier the
    // project chose. The worker defaults panels to low on its own, so this is
    // the project overriding that, not the only thing that sets it.
    quality: resolveDefaults(settings).image_quality,
  };
}

/** The payload half both panel queuers share.
 *
 *  `prompt_spec` PLUS late-bound `anchors`, never a finished prompt: the
 *  composer is `worker/image_prompt.py` and the anchors are resolved at RENDER
 *  time, which is the whole reason a body sheet can be queued beside the face
 *  plate it composes over — the plate does not exist yet when the job is
 *  written, and `depends_on` is what makes it exist before this is read.
 *
 *  `panelPrompt.ts` is the browser's twin of that composer and is still what
 *  `/ui/panel` renders a preview from; it is not what a render is given. */
function panelJobPayload(
  spec: Record<string, unknown>, anchors: Anchor[], _ctx: PanelCtx,
): Record<string, unknown> {
  return { prompt_spec: spec, anchors };
}

/** Draw one shot. Lands on `beats.meta.panel_asset_id` (the auto slot) — a
 *  user's own still is left alone and keeps outranking it.
 *
 *  `sceneBeats` is the whole scene: the location-plate rotation is a per-scene
 *  decision, so redrawing one beat still has to know where that beat sits among
 *  the others or it would pick a different plate than the batch did. */
export async function queueBeatPanel(
  scene: Scene, beat: Beat, ctx: PanelCtx, sceneBeats: Beat[],
) {
  const { spec, anchors } = panelSpec(scene, beat, ctx, sceneBeats);
  // Returned so a caller can DEPEND on it — the composed segment storyboard
  // (`blockSheet.queueBlockSheet`, source "compose") waits for the panels it
  // lays out.
  return enqueueJob({
    kind: "image_gen", lane: "gpu", priority: ctx.priority ?? USER_PRIORITY,
    project_id: ctx.projectId ?? undefined, episode_id: ctx.episodeId ?? undefined,
    payload: {
      ...panelJobPayload(spec, anchors, ctx),
      model_key: modelKeyOf(ctx.imageModel),
      ...(ctx.quality ? { quality: ctx.quality } : {}),
      width: PANEL_W, height: PANEL_H,
      auto_accept: true,
      label: `${scene.slug ?? "scene"} b${beat.idx + 1} · panel`,
      target: { beat_id: beat.id, as: "panel" },
    },
  });
}

/** Draw the whole scene, in reading order. Returns how many were queued.
 *
 *  Breath beats are skipped, matching the planner: a held pause has no panel
 *  of its own, and one composed from its contentless filler action renders
 *  the staged sheets back. A DELIBERATE single-beat redraw through
 *  `queueBeatPanel` still works — the spec composes the location alone there. */
export async function queueScenePanels(scene: Scene, beats: Beat[], ctx: PanelCtx) {
  const drawn = beats.filter((b) => !b.meta?.breath);
  for (const b of drawn) await queueBeatPanel(scene, b, ctx, beats);
  return drawn.length;
}

/** Draw N alternate takes of ONE shot, for a human to choose between.
 *
 *  The same spec and the same anchors as `queueBeatPanel` — this is not a
 *  different picture, it is the same picture rolled again — with two
 *  differences, and both are load-bearing:
 *
 *  * **Distinct seeds.** `handle_image_gen` reads `payload.seed or 0`, so
 *    every panel job in the app renders at seed 0. Queue five identical jobs
 *    and you get five identical pictures and a very confusing screen. The
 *    offsets are derived from the beat id, so re-rolling the same shot walks
 *    to fresh seeds instead of redrawing the same five.
 *  * **`as: "panel_alt"`**, which appends to `beats.meta.panel_alts` instead
 *    of writing the single `panel_asset_id` slot. Five jobs aimed at one slot
 *    would overwrite each other and leave whichever landed last — a race, not
 *    a choice. Promotion is a separate, deliberate act (`panelChoiceMeta`).
 *
 *  Deliberately NOT touching `still_asset_id`: a user's own designated still
 *  outranks panels everywhere, and re-rolling auto material must not disturb
 *  it (see `beatImageId`). */
export async function queueBeatPanelAlternates(
  scene: Scene, beat: Beat, ctx: PanelCtx, sceneBeats: Beat[],
  n: number = PANEL_ALTS,
) {
  const { spec, anchors } = panelSpec(scene, beat, ctx, sceneBeats);
  const base = seedBase(beat);
  // Composed ONCE for all N — it is the same picture rolled again, and
  // resolving the anchors per alternate would be five identical round trips.
  const composed = panelJobPayload(spec, anchors, ctx);
  for (let i = 0; i < n; i++) {
    await enqueueJob({
      kind: "image_gen", lane: "gpu", priority: ctx.priority ?? USER_PRIORITY,
      project_id: ctx.projectId ?? undefined, episode_id: ctx.episodeId ?? undefined,
      payload: {
        ...composed,
        model_key: modelKeyOf(ctx.imageModel),
        ...(ctx.quality ? { quality: ctx.quality } : {}),
        width: PANEL_W, height: PANEL_H,
        auto_accept: true,
        seed: base + i,
        label: `${scene.slug ?? "scene"} b${beat.idx + 1} · alt ${i + 1}/${n}`,
        target: { beat_id: beat.id, as: "panel_alt" },
      },
    });
  }
  return n;
}

/** Queue it. Lands on `scenes.still_asset_id` via the handler's scene target. */
export async function queueSceneStill(scene: Scene, ctx: PanelCtx) {
  const { spec, anchors } = sceneStillSpec(scene, ctx);
  await enqueueJob({
    kind: "image_gen", lane: "gpu", priority: ctx.priority ?? USER_PRIORITY,
    project_id: ctx.projectId ?? undefined, episode_id: ctx.episodeId ?? undefined,
    payload: {
      prompt_spec: spec,
      model_key: modelKeyOf(ctx.imageModel),
      ...(ctx.quality ? { quality: ctx.quality } : {}),
      width: PANEL_W, height: PANEL_H,
      anchors, auto_accept: true,
      label: `${scene.slug ?? "scene"} · key still`,
      target: { scene_id: scene.id },
    },
  });
  return anchors.length;
}

// The model catalogue — every model a picker can offer, with its modes, its
// frame grid, its reference ceiling and its capabilities.
//
// BUNDLED, NOT FETCHED. It is generated into `modelCatalog.gen.ts` by
// `scripts/gen_model_catalog.py` from `infra/model_map.full.json` (the
// reference model map every local recipe derives from) plus the hand-written
// hosted rows, and the generator runs the same three guards the studio's sync
// used to: every local row's id must translate to its model_map key, every
// LoRA a row offers must be one its entry declares, and no two rows of one
// kind may share a sort. A row that would fail any of them never reaches this
// file.
//
// Read it through `loadCatalog()` — async, because every caller was written
// against a fetch and there is no reason to rewrite them for a constant.
import GENERATED from "./modelCatalog.gen";
import type { ModelCatalogRow } from "./db/types";

let CATALOG: ModelCatalogRow[] = [...(GENERATED as unknown as ModelCatalogRow[])]
  .sort((a, b) => a.sort - b.sort);

/** The rows, synchronously — for the studio plane, which serves them as a
 *  table to the pipeline's own queries. */
export function catalogRows(): ModelCatalogRow[] {
  return CATALOG;
}

export function loadCatalog(): Promise<ModelCatalogRow[]> {
  return Promise.resolve(CATALOG);
}

/** Kept for callers written against the fetched catalogue. A bundled one has
 *  nothing to drop or re-ask, so both are the same as `loadCatalog`. */
export function resetCatalog(): void {}

export function refreshCatalog(): Promise<ModelCatalogRow[]> {
  return loadCatalog();
}

/** Replace the catalogue with fixture rows. DEV ONLY, and a no-op otherwise.
 *
 *  The `/ui/*` harness renders model-dependent modals against a handful of
 *  rows it chooses, so a review can stand up one model that can edit a
 *  picture and one that cannot without the whole real list in the way. */
export function primeCatalog(rows: ModelCatalogRow[]) {
  if (!import.meta.env.DEV) return;
  CATALOG = [...rows].sort((a, b) => a.sort - b.sort);
}

export const videoModels = async () =>
  (await loadCatalog()).filter((m) => m.kind === "video" && m.enabled);
export const imageModels = async () =>
  (await loadCatalog()).filter((m) => m.kind === "image" && m.enabled);
/** `kind: "audio"` covers three unrelated things — songs, sound effects and
 *  speech — so the MODE is the discriminator, and these filters name it
 *  positively. `t2m` is a song; a row declaring no mode at all is one too. */
export const musicModels = async () =>
  (await loadCatalog()).filter(
    (m) => m.kind === "audio" && m.enabled
      && (m.modes?.includes("t2m") || !m.modes?.length));
/** Text-to-SFX rows (Stable Audio 3). */
export const sfxModels = async () =>
  (await loadCatalog()).filter(
    (m) => m.kind === "audio" && m.enabled && !!m.modes?.includes("t2sfx"));
/** Video-to-audio rows (MMAudio) — the one audio family whose INPUT is a clip. */
export const v2aModels = async () =>
  (await loadCatalog()).filter(
    (m) => m.kind === "audio" && m.enabled && !!m.modes?.includes("v2a"));
/** Speech engines `handle_tts` can actually reach. */
export const ttsModels = async () =>
  (await loadCatalog()).filter(
    (m) => m.kind === "audio" && m.enabled && !!m.modes?.includes("tts"));
export const llmModels = async () =>
  (await loadCatalog()).filter((m) => m.kind === "llm" && m.enabled);
export const postModels = async () =>
  (await loadCatalog()).filter((m) => m.kind === "post" && m.enabled);

export async function modelById(id: string): Promise<ModelCatalogRow | undefined> {
  return (await loadCatalog()).find((m) => m.id === id);
}

/** Pixel dims for a model+size+aspect (falls back to 16:9 720p). */
export function dimsFor(model: ModelCatalogRow, sizeId: string, aspect: string): { w: number; h: number } {
  const size = model.sizes?.find((s) => s.id === sizeId) ?? model.sizes?.[0];
  const d = size?.dims?.[aspect] ?? size?.dims?.["16:9"] ?? [1280, 720];
  return { w: d[0], h: d[1] };
}

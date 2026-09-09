// A catalog id is not a model_map key, and the browser has to guess.
//
// `payload.model_key` is what the worker resolves against model_map; what a
// person reads off a picker is the CATALOG id. Stripping `-local` is right for
// most rows and wrong for the H3 family, so the exceptions are a hand-kept
// table — there is no schema field carrying the real key.
//
// One copy, three readers: the hosted director (api/director/chat.js), the
// browser (src/lib/projectSettings.ts) and the worker's twin
// (worker/director_tools.py MODEL_KEY_EXCEPTIONS). scripts/gen_model_catalog.py
// refuses to sync when a local catalog row's derived key misses its model_map
// entry, which is the check that keeps all of them honest.
//
// Plain JS on purpose (no TS, no build step, no imports): it is loaded by the
// Vite bundle, by the serverless functions and by `node --test` alike.

export const MODEL_KEY_EXCEPTIONS = {
  "h3-local": "minimax-h3",
  "h3-turbo-local": "minimax-h3-turbo",
  "h3-pdd-local": "minimax-h3-pdd",
  "h3-lightx2v-local": "minimax-h3-lightx2v",
  "wan22-local": "wan2.2",
  // DESKTOP-ONLY, and they exist in `model_map.desktop.json` alone: the pod has
  // a 96GB card, no reason to quantise and none of these files. The wizard only
  // offers them on a desktop that has downloaded one, so a web session can
  // never send the pod a key it has never heard of.
  "h3-q5-local": "minimax-h3-q5",
  "h3-q4-local": "minimax-h3-q4",
  "h3-q3-local": "minimax-h3-q3",
};

/**
 * Catalog id (or an already-correct model_map key) -> model_map key.
 *
 * Accepts either spelling because a director tool is handed whatever the user
 * said, and the user reads catalog ids off the pickers. Falsy in, undefined
 * out — callers spread the result into a payload and an empty key must not
 * override the worker's own pick.
 *
 * A DESKTOP model has no key at all, and saying so is the point. `local:` ids
 * name a checkpoint on THIS machine, rendered by the TypeScript runner on
 * `lane: "local"` — model_map has never heard of one, so the string a bare
 * strip hands back ("local:wan22-5b/Q6_K", untouched, since that is a
 * different suffix on a different id space) is a key the worker cannot
 * resolve. Undefined DROPS it instead.
 *
 * @param {string|null|undefined} idOrKey
 * @returns {string|undefined}
 */
export function modelKeyOf(idOrKey) {
  if (!idOrKey) return undefined;
  const v = String(idOrKey).trim();
  if (!v || v.startsWith("local:")) return undefined;
  return MODEL_KEY_EXCEPTIONS[v] ?? v.replace(/-local$/, "");
}

/**
 * The other direction: a BLOCK's stored `params` -> the catalog id a `jobs`
 * row should carry in `model_id`.
 *
 * That column does not choose the checkpoint — `_block_model(block, params)`
 * does, off `params.model_key` — so getting it wrong renders the right picture
 * and files it under the wrong name. What reads it is bookkeeping and
 * curation: `sb.record_timing` stamps `job_timings.model_id` (which is what
 * `estimateBatchSeconds` corrects its per-model ETA from, and what `cold_load`
 * compares against the previous render), `record_cost` books the pod time, and
 * `_check_model_allowed` tests it against `model_visibility`. The storyboard's
 * retake hardcoded "h3-local", so a block that really renders on
 * `minimax-h3-pdd` contributed its wall time to h3-local's samples and had its
 * own row's restriction never checked.
 *
 * Two sources, in this order, because they are not equally trustworthy:
 *   1. `params.model_id` — an actual catalog id, written by PromptRefsModal
 *      beside the `model_key` it derives. Exact where it exists.
 *   2. `params.model_key` inverted against the catalog. The exception table is
 *      not invertible by string surgery ("minimax-h3" -> "h3-local"), so this
 *      is a lookup — the PanelRegenModal / ClipRetakeModal precedent.
 *
 * It NEVER returns undefined: a block that stores neither renders on
 * `H3_MODEL` (plain `minimax-h3`), and `fallback` is what names that. A wrong
 * attribution is cheap; a thrown retake is not, so a missing catalog degrades
 * to the fallback rather than failing the caller.
 *
 * @param {Record<string, unknown>|null|undefined} params
 * @param {{id: string}[]|null|undefined} catalog
 * @param {string} [fallback]
 * @returns {string}
 */
export function catalogIdOf(params, catalog, fallback = "h3-local") {
  const stored = params?.model_id;
  if (typeof stored === "string" && stored) return stored;
  const key = params?.model_key;
  if (typeof key === "string" && key) {
    const row = (catalog ?? []).find((m) => modelKeyOf(m.id) === key);
    if (row) return row.id;
  }
  return fallback;
}

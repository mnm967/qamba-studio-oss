// What KIND of block a `generation_blocks` row is — the plain-JS half of
// `src/lib/blockKind.ts`, which re-exports this so the two cannot drift.
//
// It lives here, beside `refs.js`, because the director's toolset
// (`director/tools.js`) is loaded by the Vite bundle, by the serverless
// functions and by `node --test` alike, and none of those can import a `.ts`
// file. The toolset needs it for the same reason the lane and the shot sidebar
// do: a chain is not "Block 9", an extension is not "Block 19", and a model
// told the wrong noun asks for beats a clip-born block does not have.
//
// The Python twin is `_block_kinds` / `_KIND_NOUN` in
// worker/handlers/blocks.py; `blockKind.test.ts` pins the noun table against
// it.

/** The kinds that render from `params.clip_gen` rather than from beats. */
export const CLIP_BORN = Object.freeze(["chain", "extend", "shot"]);

/** Render mode -> kind. The mode IS the action: the chain modal sends flf and
 *  the extend modal i2v. */
export function kindFromMode(mode) {
  const m = String(mode ?? "").toLowerCase();
  if (m === "flf") return "chain";
  if (m === "i2v") return "extend";
  return "shot";
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

/**
 * This block's kind, from its params alone.
 *
 * Order matters: `clip_kind` is STAMPED at creation and is authoritative; the
 * recipe's mode is the fallback for blocks made before the stamp; a
 * `derived_from` naming a CLIP is a promotion whose recipe was never recovered
 * (clip-born, kind unknown, so the generic "shot"); one naming a BLOCK is a
 * trim, which keeps its beats and its ordinary retake path.
 *
 * @param {{params?: unknown}|null|undefined} block
 * @returns {"chain"|"extend"|"shot"|"trim"|"plan"}
 */
export function blockKindOf(block) {
  const p = obj(block?.params);
  if (!p) return "plan";
  const stamped = p.clip_kind;
  if (typeof stamped === "string" && ["chain", "extend", "shot", "trim"].includes(stamped)) {
    return stamped;
  }
  const recipe = obj(p.clip_gen);
  if (recipe && typeof recipe.prompt === "string") return kindFromMode(recipe.mode);
  const from = obj(p.derived_from);
  if (from?.clip_id) return "shot";
  if (from?.block_id) return "trim";
  return "plan";
}

/** Does this block render from a recipe rather than from storyboard beats? */
export const isClipBornBlock = (block) => CLIP_BORN.includes(blockKindOf(block));

export const KIND_NOUN = Object.freeze({
  chain: "Chain", extend: "Extension", shot: "Shot", trim: "Block", plan: "Block",
});

/** What to call a block of this kind — "Chain 9", "Extension 4", "Block 7".
 *  1-indexed, like every other block reference (director/refs.js). */
export function kindLabel(kind, idx) {
  return `${KIND_NOUN[kind] ?? "Block"} ${Number(idx) + 1}`;
}

/**
 * Is this label one the studio WROTE, or one a person did?
 *
 * The lane's label is a stored column, so a renumber has to rewrite it — and
 * rewriting one somebody typed ("Chain: How the reference pictures align") is
 * exactly the loss `clipLabelFor` exists to prevent. Only the auto forms are
 * rewritten: "<noun> <n>", optionally suffixed "· audio" (the detached half)
 * or "· rendering" (a placeholder holding the block's place on the lane while
 * its first render is in flight, "· failed" once that render died). A
 * null/blank label counts as auto.
 *
 * Twin of `_AUTO_LABEL` in worker/handlers/blocks.py.
 */
export function labelIsAuto(label) {
  const s = String(label ?? "").trim();
  if (!s) return true;
  return /^(Block|Chain|Extension|Shot)\s+\d+(\s*·\s*(audio|rendering|failed))?$/i.test(s);
}

/** The suffix a placeholder clip carries until its render lands. */
export const RENDERING_SUFFIX = " · rendering";

/** When a lore fact is true, and when the audience learns it.
 *
 *  The browser twin of `worker/llm.py`'s `lore_when` / `lore_status`. Both read
 *  the same `doc.when` shape and both have to agree about what it means: the
 *  worker decides what reaches the planner, this decides what the author is
 *  shown, and an author who is shown "in force" for a fact the planner is
 *  hiding has no way to discover the disagreement.
 *
 *  Dependency-free so `node --test` can run it (same reasoning as
 *  hooks/realtimeTables.ts and lib/loreChunk.ts).
 *
 *  Why three fields rather than one episode tag: a single tag cannot express a
 *  retcon, and gets it wrong in BOTH directions. Tag "Stabilizing Presence" by
 *  when it is REVEALED and the Ep1 plan does not know the mechanic is
 *  operating, so it writes a villain who is fine and manufactures the
 *  contradiction with Ep2. Tag it by when it is TRUE and the Ep1 plan may have
 *  a character state it, spoiling the reveal. "May a scene say this" and "must
 *  the world behave this way" are different questions.
 */

export interface LoreWhen {
  /** True from this episode on. Null = true from the beginning. */
  from: string | null;
  /** No longer true FROM this episode (exclusive). Null = still true. */
  until: string | null;
  /** The audience learns it here. Null = never stated on screen. */
  revealed: string | null;
}

export const EVERGREEN: LoreWhen = { from: null, until: null, revealed: null };

export type LoreStatus = "in_force" | "unrevealed" | "not_yet" | "superseded";

/** Read `doc.when`, tolerating every shape an older or hand-edited entry has. */
export function loreWhen(doc: unknown): LoreWhen {
  const w = (doc as { when?: unknown } | null)?.when;
  if (!w || typeof w !== "object" || Array.isArray(w)) return EVERGREEN;
  const pick = (k: keyof LoreWhen) => {
    const v = (w as Record<string, unknown>)[k];
    return typeof v === "string" && v ? v : null;
  };
  return { from: pick("from"), until: pick("until"), revealed: pick("revealed") };
}

/** True when nothing about this fact is tied to an episode. */
export const isEvergreen = (w: LoreWhen) => !w.from && !w.until && !w.revealed;

/** A retcon: operating before the audience is told. The one shape that needs
 *  two fields, and the one a human has to mark — only a reader who knows the
 *  story can tell a retcon from an ordinary fact. */
export const isRetcon = (w: LoreWhen, order: Map<string, number>) => {
  const f = w.from ? order.get(w.from) : undefined;
  const r = w.revealed ? order.get(w.revealed) : undefined;
  return f !== undefined && r !== undefined && f < r;
};

/** Where a fact stands in a given episode. Mirrors `llm.lore_status` exactly,
 *  including its two tolerances: no current episode means everything is in
 *  force (the pre-tagging behaviour), and an episode id that no longer resolves
 *  is treated as unbounded rather than dropped — losing canon silently is worse
 *  than showing it a little early. */
export function loreStatus(
  doc: unknown, order: Map<string, number>, current: number | null,
): LoreStatus {
  const { from, until, revealed } = loreWhen(doc);
  if (current == null) return "in_force";
  const f = from ? order.get(from) : undefined;
  const u = until ? order.get(until) : undefined;
  const r = revealed ? order.get(revealed) : undefined;
  if (f !== undefined && current < f) return "not_yet";
  if (u !== undefined && current >= u) return "superseded";
  if (r !== undefined && current < r) return "unrevealed";
  return "in_force";
}

/** episode id -> position, from the project's episode list. */
export const episodeOrder = (episodes: { id: string; idx: number }[]): Map<string, number> =>
  new Map(episodes.map((e) => [e.id, e.idx]));

/** The one-line description of a fact's timing, for a chip.
 *
 *  Deliberately says the CONSEQUENCE rather than the field values: "Ep1 · not
 *  revealed until Ep2" tells an author what will happen to their scene, where
 *  "from: ep1, revealed: ep2" makes them work it out. */
export function whenLabel(
  w: LoreWhen, episodes: { id: string; idx: number; code?: string | null }[],
): string {
  if (isEvergreen(w)) return "always true";
  const name = (id: string | null) => {
    if (!id) return null;
    const e = episodes.find((x) => x.id === id);
    return e ? (e.code || `Ep${e.idx + 1}`) : "a deleted episode";
  };
  const from = name(w.from);
  const until = name(w.until);
  const revealed = name(w.revealed);
  const bits: string[] = [];
  bits.push(from ? `from ${from}` : "from the start");
  if (until) bits.push(`until ${until}`);
  if (revealed && revealed !== from) bits.push(`revealed ${revealed}`);
  else if (!revealed && (w.from || w.until)) bits.push("never stated");
  return bits.join(" · ");
}

// The two lore tools' descriptions and JSON schemas.
//
// Their own module because they are PURE DATA with two consumers that must not
// import each other: `api/director/_lore.js` holds the implementations (which
// reach Supabase with a service key and OpenAI for embeddings, so they are
// server-only), and `director/tools.js` needs the schemas at module level to
// build its TOOLS array — in the BROWSER, where neither of those is available.
// Duplicating them instead would be two schemas drifting apart, which is the
// failure `tool_parity.test.mjs` exists to catch one layer up.
export const SEARCH_LORE_DESC =
  "Search the project's imported lore documents (world bibles, scripts, notes) and quote "
  + "what they say. get_project_state lists which documents exist; this reads inside them. "
  + "Use it before answering any question about established canon, and before inventing "
  + "anything the documents may already have decided.";

export const SEARCH_LORE_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "what you want the lore to tell you, in plain words" },
    limit: { type: "integer", description: "passages to return (default 6, max 12)" },
  },
  required: ["query"],
};

export const SET_LORE_TIMING_DESC =
  "Say when a lore fact is true and when the audience learns it. Episodes are named as they "
  + "appear ('EP01', 'ep2', '1'). Three cases: an ordinary fact — give `from` only; a RETCON "
  + "that was always true and is only revealed later — give `from` AND a later `revealed`, and "
  + "the earlier episodes will be written so the world behaves that way while no character "
  + "states it; a fact a later episode undoes (\"she doesn't know it's her power yet\") — give "
  + "`until`. Omit everything, or pass evergreen, for a rule that never changes. Applies "
  + "immediately: timing decides which episodes see the fact, it is not story text.";

export const SET_LORE_TIMING_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "the lore entry's name" },
    from: { type: "string", description: "episode it becomes true in" },
    revealed: { type: "string",
                description: "episode the audience learns it — later than `from` for a retcon" },
    until: { type: "string", description: "episode it STOPS being true in" },
    evergreen: { type: "boolean", description: "true = always true, clears the rest" },
  },
  required: ["name"],
};

/** An episode by whatever the director calls it: uuid, code ("EP01"), or
 *  position ("1"). Twin of `_resolve_episode` — the model reads these labels off
 *  the same project state the user sees, and demanding a uuid it never saw is
 *  how a tool call becomes an invalid-input error. */
function resolveEpisode(episodes, ref) {
  const s = String(ref ?? "").trim().toLowerCase();
  if (!s) return null;
  const byId = episodes.find((e) => String(e.id) === s);
  if (byId) return byId.id;
  const byCode = episodes.find((e) => (e.code ?? "").toLowerCase() === s);
  if (byCode) return byCode.id;
  const digits = s.replace(/[^0-9]/g, "");
  if (digits) {
    const n = Number(digits);
    const byNum = episodes.find(
      (e) => (e.idx ?? 0) + 1 === n || (e.code ?? "").toLowerCase() === `ep${String(n).padStart(2, "0")}`);
    if (byNum) return byNum.id;
  }
  return null;
}

/** Write a lore entry's `doc.when`. Applied directly, not proposed — unlike a
 *  change to what a fact SAYS, timing is scoping rather than story text, and
 *  routing it through bible_revisions would leave the planner on the old scope
 *  until someone visited the Bible page. Twin of `_set_lore_timing`. */

// A JOURNAL of what a director turn WROTE, and the plan that puts it back.
//
// A director turn edits the project through the toolset — a beat rewritten,
// a scene resequenced, a block inserted with its followers shifted, a job
// queued — and until now the only record of that was prose in the transcript.
// "Undo what you just did" had no mechanism: the model would have to remember
// every row it touched and reverse each by hand, which is the thing models are
// worst at. So the toolset's own db wrappers (director/tools.js `sbIns` /
// `sbUpd` / `sbDel`) record every write here while a journal is open, the
// runner persists the journal onto the assistant message as a `changes`
// content block, and the dock's Revert button replays `revertPlan()` in the
// browser with the user's own credentials.
//
// THREE RULES, each of which is silent when broken:
//
//   * An UPDATE is journaled by reading the rows FIRST, and only the columns
//     the patch touches. Reading afterwards records the new value; reading
//     every column would put back a status the worker moved on since. So a
//     revert restores exactly what the turn changed and nothing the render
//     did afterwards — which also means a take that landed in between stays a
//     take, and the plan says so rather than pretending otherwise.
//   * The plan is the journal REVERSED. A forward sequence that shifted
//     followers back-to-front and then inserted is undone by deleting the
//     insert and then unshifting front-to-back, and that is the only order
//     that survives `unique (storyboard_id, idx)`.
//   * A queued JOB is not deleted, it is CANCELLED. `jobs` has no UPDATE
//     policy for the browser and a running job cannot be un-run; the RPC is
//     the sanctioned way, and a job that already finished simply reports so.
//
// Plain JS, no imports: read by the serverless functions, by the browser and
// by `node --test`. The Python twin is `sb.journal` in worker/sb.py, whose
// ops have the same shape so one revert reads both.

/** The identifying columns of a row, for tables with and without an `id`. */
export function keyOf(row) {
  if (!row || typeof row !== "object") return null;
  if (row.id != null) return { id: row.id };
  if (row.entry_id != null && row.asset_id != null) {
    return { entry_id: row.entry_id, asset_id: row.asset_id };
  }
  if (row.collection_id != null && row.asset_id != null) {
    return { collection_id: row.collection_id, asset_id: row.asset_id };
  }
  return null;
}

/** `table?filters…` -> `table?filters…&select=<cols>`, replacing any select
 *  the caller had. A path with no filters at all is refused (null): reading
 *  a whole table to journal an unbounded write is worse than not journaling
 *  it, and no tool writes unbounded. */
export function selectPath(path, cols) {
  const s = String(path ?? "");
  const q = s.indexOf("?");
  if (q < 0) return null;
  const table = s.slice(0, q);
  const params = s.slice(q + 1).split("&").filter((p) => p && !/^select=/.test(p));
  if (!params.length) return null;
  return `${table}?${[...params, `select=${cols}`].join("&")}`;
}

export const tableOf = (path) => String(path ?? "").split("?")[0];

/** Columns the database owns; never sent back on a re-insert. `owner_id` and
 *  `project_id` are filled by the `set_row_owner` trigger from the row's own
 *  parents, and passing ours would be a second opinion it overwrites. */
const SERVER_COLS = new Set(["owner_id", "project_id", "created_at", "updated_at"]);

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

/**
 * The undo requests for a journal, newest first.
 *
 * Each request is one of:
 *   {kind:"cancel_job", id}                     — an inserted jobs row
 *   {kind:"delete", table, key}                 — any other inserted row
 *   {kind:"patch", table, key, body}            — the pre-update values
 *   {kind:"insert", table, body}                — a deleted row, id kept
 * plus {kind:"skip", table, why} for anything the journal could not capture,
 * so a revert that cannot be complete says which part rather than being
 * silently partial.
 *
 * @param {Array<Record<string, any>>} ops
 */
export function revertPlan(ops) {
  const out = [];
  for (const op of [...(Array.isArray(ops) ? ops : [])].reverse()) {
    if (!op || typeof op !== "object") continue;
    if (op.op === "insert") {
      if (!op.id) { out.push({ kind: "skip", table: op.table, why: "insert recorded no id" }); continue; }
      out.push(op.table === "jobs"
        ? { kind: "cancel_job", id: op.id }
        : { kind: "delete", table: op.table, key: { id: op.id } });
    } else if (op.op === "update") {
      if (op.unbounded) { out.push({ kind: "skip", table: op.table, why: "unbounded update" }); continue; }
      for (const row of op.before ?? []) {
        const key = keyOf(row);
        if (!key) { out.push({ kind: "skip", table: op.table, why: "row has no key" }); continue; }
        const body = pick(row, op.keys ?? []);
        if (Object.keys(body).length) out.push({ kind: "patch", table: op.table, key, body });
      }
    } else if (op.op === "delete") {
      if (op.unbounded) { out.push({ kind: "skip", table: op.table, why: "unbounded delete" }); continue; }
      for (const row of op.rows ?? []) {
        const body = Object.fromEntries(Object.entries(row).filter(([k]) => !SERVER_COLS.has(k)));
        out.push({ kind: "insert", table: op.table, body });
      }
    }
  }
  return out;
}

const NOUN = {
  scenes: "scene", beats: "shot", generation_blocks: "block", jobs: "job",
  bible_entries: "bible entry", bible_assets: "reference", block_takes: "take",
  clips: "clip", storyboards: "storyboard", chat_threads: "thread",
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * One line per table, for the confirm dialog: "1 block added · 4 blocks
 * changed · 1 job queued". Counts rows, not ops, because a shift of four
 * followers is four rows a person will see move back.
 */
export function describeChanges(ops) {
  const added = {}, changed = {}, removed = {};
  let jobs = 0;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== "object") continue;
    if (op.op === "insert") {
      if (op.table === "jobs") jobs++;
      else added[op.table] = (added[op.table] ?? 0) + 1;
    } else if (op.op === "update") {
      changed[op.table] = (changed[op.table] ?? 0) + (op.before?.length ?? 0);
    } else if (op.op === "delete") {
      removed[op.table] = (removed[op.table] ?? 0) + (op.rows?.length ?? 0);
    }
  }
  const lines = [];
  for (const [t, n] of Object.entries(added)) lines.push(`${plural(n, NOUN[t] ?? t)} added`);
  for (const [t, n] of Object.entries(changed)) if (n) lines.push(`${plural(n, NOUN[t] ?? t)} changed`);
  for (const [t, n] of Object.entries(removed)) if (n) lines.push(`${plural(n, NOUN[t] ?? t)} removed`);
  if (jobs) lines.push(`${plural(jobs, "render")} queued`);
  return lines;
}

/** Does this journal contain anything a revert would touch? Reads are never
 *  journaled, so a turn that only looked has nothing to put back. */
export const hasChanges = (ops) =>
  Array.isArray(ops) && ops.some((o) => o && ["insert", "update", "delete"].includes(o.op));

/* ── the journal itself ────────────────────────────────────────────────── */
// One open journal per process at a time. `runTool` opens it for the length
// of a tool call and closes it after, and a director turn is one call at a
// time on every runner: a Node function serves one invocation, and a browser
// tab runs one turn. Two turns interleaving in one process would cross their
// journals, which is the one thing this shape cannot guard — it is said here
// so the day a runner becomes concurrent, this is the line to change.
let CURRENT = null;

export const journalOpen = () => CURRENT !== null;
export function noteChange(op) { if (CURRENT) CURRENT.push(op); }

/** Run `fn` with `ops` as the open journal; every write in between lands on
 *  it. Re-entrant: an already-open journal is kept, so a tool calling a tool
 *  records onto the outer one. */
export async function withJournal(ops, fn) {
  if (CURRENT) return fn();
  CURRENT = ops;
  try { return await fn(); } finally { CURRENT = null; }
}

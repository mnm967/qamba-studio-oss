// Read the column DEFAULTS the local plane has to emulate straight out of the
// migrations.
//
// WHY THIS EXISTS. Postgres fills a default when an INSERT omits the column;
// a local project's rows go into a JSON file with nobody to fill anything. So
// every column the app READS but never WRITES — `status`, `created_at`,
// `meta`, `params`, `tags` — comes back undefined on the local plane, and each
// one is a different downstream symptom: a block with no status never renders,
// a row with no `created_at` sorts to the top of every list, a `meta` that is
// undefined instead of `{}` throws on the first property read. Guessing the
// list is how you find them one at a time, in the UI.
//
// It reads three more things from the same files, for the same reason: which
// tables carry a `moddatetime` trigger (so `updated_at` moves on a local
// UPDATE the way it does in Postgres), the foreign keys and their ON DELETE
// actions (so a local delete cascades the way the database would), and the
// ownership parent map out of the accounts migration.
//
// Used by `scripts/gen_local_schema.mjs` to WRITE `src/lib/localSchema.ts`
// and by `localSchema.test.ts` to prove the committed file still matches.
import fs from "node:fs";
import path from "node:path";

/** Strip `-- …` line comments, but not a `--` inside a quoted string. Without
 *  this a trailing comment's words parse as column definitions — measured: a
 *  `-- UI order, default 0` comment produced a column called "UI". */
export function stripComments(sql) {
  let out = "", quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quoted) { out += c; if (c === "'") quoted = sql[i + 1] === "'" ? (out += sql[++i], true) : false; continue; }
    if (c === "'") { quoted = true; out += c; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; }
    out += c;
  }
  return out;
}

/** Split a clause list on TOP-LEVEL commas — a default can itself contain
 *  commas inside parens or inside a quoted string. */
export function splitDefs(body) {
  const out = [];
  let depth = 0, quoted = false, cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) { cur += c; if (c === "'") quoted = body[i + 1] === "'" ? (cur += body[++i], true) : false; continue; }
    if (c === "'") { quoted = true; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** The `default <expr>` of one column definition, or null. Stops at the next
 *  clause keyword: `default 'draft' check (…)` is one definition. */
export function defaultOf(def) {
  const m = /\bdefault\s+/i.exec(def);
  if (!m) return null;
  const rest = def.slice(m.index + m[0].length);
  const stop = /^\s*(not\s+null|null\b|check|references|unique|primary\s+key|generated|collate)/i;
  let depth = 0, quoted = false, out = "";
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quoted) { out += c; if (c === "'") quoted = rest[i + 1] === "'" ? (out += rest[++i], true) : false; continue; }
    if (c === "'") { quoted = true; out += c; continue; }
    if (c === "(") depth++;
    if (c === ")") { if (depth === 0) break; depth--; }
    if (depth === 0 && /\s/.test(c) && stop.test(rest.slice(i))) break;
    out += c;
  }
  return out.trim() || null;
}

/** A SQL default expression -> what the local store writes.
 *  `null` = cannot be represented; the caller REPORTS those rather than
 *  guessing, because a wrong default is worse than an absent one. */
export function jsDefault(expr, type) {
  const e = expr.trim().replace(/::[a-z_ \[\]]+$/i, "").trim();
  const isJson = /jsonb?\b/i.test(type);
  const isArray = /\[\]\s*$/.test(type);
  if (/^now\(\)$/i.test(e)) return { kind: "now" };
  if (/^gen_random_uuid\(\)$/i.test(e)) return { kind: "uuid" };
  if (/^(true|false)$/i.test(e)) return { kind: "value", value: e.toLowerCase() === "true" };
  if (/^-?\d+(\.\d+)?$/.test(e)) return { kind: "value", value: Number(e) };
  if (/^null$/i.test(e)) return { kind: "value", value: null };
  if (/^'[\s\S]*'$/.test(e)) {
    const raw = e.slice(1, -1).replace(/''/g, "'");
    if (isJson) {
      try { return { kind: "value", value: JSON.parse(raw) }; } catch { return null; }
    }
    // A Postgres array literal — `'{}'` is the empty array, and that is the
    // only form any migration here uses.
    if (isArray) return raw === "{}" ? { kind: "value", value: [] } : null;
    return { kind: "value", value: raw };
  }
  return null;
}

const COL = /^\s*([a-z_][a-z0-9_]*)\s+((?:[a-z][a-z0-9_]*)(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?(?:\s*\[\s*\])?)/i;
const NOT_A_COLUMN = /^(primary|unique|foreign|check|constraint|exclude|like)$/i;

/** table -> column -> {kind: "now"|"uuid"|"value", value?} for every default
 *  a migration declares, from `create table` and `alter table … add column`
 *  alike (the v1 tables only ever get columns the second way). */
export function readDefaults(dir) {
  const out = {};
  const unsupported = [];
  const put = (t, c, spec) => { (out[t] ||= {})[c] = spec; };
  const record = (table, def, source) => {
    const col = COL.exec(def);
    if (!col || NOT_A_COLUMN.test(col[1])) return;
    const d = defaultOf(def);
    if (!d) return;
    const js = jsDefault(d, col[2]);
    if (!js) { unsupported.push(`${table}.${col[1]} = ${d} (${source})`); return; }
    put(table, col[1], js);
  };

  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(dir, f), "utf8"));

    for (const m of sql.matchAll(/create table (?:if not exists )?([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const start = m.index + m[0].length;
      let depth = 1, i = start, quoted = false;
      for (; i < sql.length && depth > 0; i++) {
        const c = sql[i];
        if (quoted) { if (c === "'") quoted = false; continue; }
        if (c === "'") { quoted = true; continue; }
        if (c === "(") depth++;
        if (c === ")") depth--;
      }
      for (const def of splitDefs(sql.slice(start, i - 1))) record(m[1], def, f);
    }

    for (const m of sql.matchAll(/alter table (?:if exists )?([a-z_][a-z0-9_]*)([^;]*);/gi)) {
      for (const clause of splitDefs(m[2])) {
        const add = /^\s*add column (?:if not exists )?([\s\S]*)$/i.exec(clause);
        if (add) record(m[1], add[1], f);
      }
    }
  }
  return { defaults: out, unsupported };
}

/* ── the rest of the schema the local plane has to reproduce ─────────────── */

/** Tables whose `updated_at` is moved by a `moddatetime` trigger.
 *
 *  A default only fires on INSERT. Postgres keeps `updated_at` current through
 *  a BEFORE UPDATE trigger, and the local plane has to do the same by hand —
 *  it is what the projects list sorts on, and what a sync merge compares. */
export function readTouchTables(dir) {
  const out = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const m of sql.matchAll(
      /create trigger\s+[a-z_][a-z0-9_]*\s+before update on\s+([a-z_][a-z0-9_]*)[\s\S]{0,200}?moddatetime\(updated_at\)/gi)) {
      out.add(m[1]);
    }
  }
  return [...out].sort();
}

/** table -> [{column, parent, onDelete}] for every foreign key.
 *
 *  The local store deletes rows itself, so `on delete cascade` and
 *  `on delete set null` are behaviour it has to implement: without the first,
 *  deleting a scene leaves its beats behind as rows nothing can reach; without
 *  the second, deleting a take leaves `generation_blocks.active_take_id`
 *  pointing at a row that is gone, which every take surface then resolves to
 *  nothing with no error anywhere. */
export function readForeignKeys(dir) {
  const out = {};
  const add = (table, column, parent, onDelete) => {
    (out[table] ||= []).push({ column, parent, onDelete });
  };
  const scan = (table, def) => {
    const col = COL.exec(def);
    if (!col || NOT_A_COLUMN.test(col[1])) return;
    const ref = /references\s+([a-z_][a-z0-9_]*)\s*\([a-z_][a-z0-9_]*\)((?:\s+on\s+delete\s+(cascade|set null|set default|restrict|no action))?)/i
      .exec(def);
    if (!ref) return;
    add(table, col[1], ref[1], (ref[3] || "no action").toLowerCase());
  };
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const m of sql.matchAll(/create table (?:if not exists )?([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const start = m.index + m[0].length;
      let depth = 1, i = start, quoted = false;
      for (; i < sql.length && depth > 0; i++) {
        const c = sql[i];
        if (quoted) { if (c === "'") quoted = false; continue; }
        if (c === "'") { quoted = true; continue; }
        if (c === "(") depth++;
        if (c === ")") depth--;
      }
      for (const def of splitDefs(sql.slice(start, i - 1))) scan(m[1], def);
    }
    for (const m of sql.matchAll(/alter table (?:if exists )?([a-z_][a-z0-9_]*)([^;]*);/gi)) {
      for (const clause of splitDefs(m[2])) {
        const add2 = /^\s*add column (?:if not exists )?([\s\S]*)$/i.exec(clause);
        if (add2) { scan(m[1], add2[1]); continue; }
        // A TABLE-level constraint: `add constraint … foreign key (col)
        // references t(id) on delete set null`. Missing this form is silent —
        // `generation_blocks.active_take_id` is declared bare and given its FK
        // this way, so a local delete of a take would leave every block
        // pointing at a row that no longer exists.
        const tbl = /foreign key\s*\(\s*([a-z_][a-z0-9_]*)\s*\)\s*references\s+([a-z_][a-z0-9_]*)\s*\([a-z_][a-z0-9_]*\)((?:\s+on\s+delete\s+(cascade|set null|set default|restrict|no action))?)/i
          .exec(clause);
        if (tbl) add(m[1], tbl[1], tbl[2], (tbl[4] || "no action").toLowerCase());
      }
    }
  }
  // Deduplicate: a column added by an ALTER and later re-declared keeps one entry.
  for (const t of Object.keys(out)) {
    const seen = new Map();
    for (const fk of out[t]) seen.set(fk.column, fk);
    out[t] = [...seen.values()].sort((a, b) => a.column.localeCompare(b.column));
  }
  return out;
}

/** The owned-table list and the ownership parent map, read out of the accounts
 *  migration — the same two structures `ownership.test.ts` parses, and for the
 *  same reason: they are the canonical answer to "what is a project made of". */
export function readOwnership(dir) {
  const sql = fs.readFileSync(path.join(dir, "20260812190000_accounts.sql"), "utf8");
  const fn = /create or replace function public\.neon_owned_tables\(\)[\s\S]*?select array\[([\s\S]*?)\]/i.exec(sql);
  if (!fn) throw new Error("neon_owned_tables() not found");
  const tables = [...fn[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]);
  const block = /spec jsonb :=\s*\$j\$([\s\S]*?)\$j\$/i.exec(sql);
  if (!block) throw new Error("the ownership parent map not found");
  return { tables, parents: JSON.parse(block[1]) };
}

/** table -> primary key columns.
 *
 *  Two tables here are pure link rows — `collection_assets` and `bible_assets`
 *  — with a COMPOSITE key and no `id` column at all. A local store that
 *  invented one for them would work perfectly until the day that row was
 *  pushed to the cloud, where the insert fails on a column that does not
 *  exist; and an upsert needs the real conflict target either way. */
export function readPrimaryKeys(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const m of sql.matchAll(/create table (?:if not exists )?([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const start = m.index + m[0].length;
      let depth = 1, i = start, quoted = false;
      for (; i < sql.length && depth > 0; i++) {
        const c = sql[i];
        if (quoted) { if (c === "'") quoted = false; continue; }
        if (c === "'") { quoted = true; continue; }
        if (c === "(") depth++;
        if (c === ")") depth--;
      }
      for (const def of splitDefs(sql.slice(start, i - 1))) {
        const table = /^\s*primary key\s*\(([^)]*)\)/i.exec(def);
        if (table) { out[m[1]] = table[1].split(",").map((c) => c.trim()); continue; }
        const col = COL.exec(def);
        if (col && !NOT_A_COLUMN.test(col[1]) && /\bprimary key\b/i.test(def)) out[m[1]] = [col[1]];
      }
    }
    for (const m of sql.matchAll(
      /alter table (?:if exists )?([a-z_][a-z0-9_]*)[^;]*?add constraint\s+[a-z_][a-z0-9_]*\s+primary key\s*\(([^)]*)\)/gi)) {
      out[m[1]] = m[2].split(",").map((c) => c.trim());
    }
  }
  return out;
}

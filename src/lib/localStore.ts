// One local project's rows, in memory, behaving like the database they stand
// in for.
//
// A LOCAL PROJECT IS A PROJECT, NOT AN EXPORT. Everything the app knows how to
// do is written against tables — `beats`, `generation_blocks`, `block_takes`,
// `clips` — so a local project that were a bundle or a scene graph would need
// a second implementation of every screen. It is the same rows in the same
// shapes; only the plane they live on differs, which is why the storyboard,
// the timeline, the bible and the queue all work on one without knowing.
//
// WHAT POSTGRES WAS DOING THAT NOBODY SEES. Four things, each silent when
// missing, and `localSchema.ts` is where the first three come from:
//
//   * DEFAULTS. An INSERT that omits `status` gets `'planned'` in Postgres and
//     `undefined` here — a block that never renders, with nothing to explain
//     why. Every default in the migrations is filled on insert.
//   * `updated_at`. A `moddatetime` trigger moves it on UPDATE. The projects
//     list sorts on it and a sync compares it, so it is moved here too — on
//     exactly the tables that carry the trigger, not on all of them.
//   * ON DELETE. Deleting a scene cascades to its beats; deleting a take nulls
//     `generation_blocks.active_take_id`; deleting an asset a clip still uses
//     is REFUSED. Reproducing only the first would leave dangling references
//     that every consumer resolves to nothing.
//   * `project_id`. Denormalised onto every owned table by the same trigger
//     that derives `owner_id`, and read by half the queries in the app. A
//     local row would otherwise never carry one.
//
// It is deliberately a plain object store rather than SQLite: the query
// surface is small (see localQuery.ts), a project's rows are thousands not
// millions, and this way the whole plane is testable under `node --test` with
// no native module and no build step.
import {
  DEFAULTS, FOREIGN_KEYS, LOCAL_TABLES, LOCAL_TABLE_SET, OWNERSHIP_PARENTS,
  PRIMARY_KEYS, TOUCH_UPDATED_AT, type ColumnDefault,
} from "./localSchema.ts";

export type Row = Record<string, any>;

/** What lands on disk. `version` is checked on load: a file written by a newer
 *  build is refused rather than half-read, because a partially understood
 *  project reads as a corrupted one. */
export interface StoreSnapshot {
  version: number;
  project_id: string;
  updated_at: string;
  tables: Record<string, Row[]>;
  /** what the cloud copy has not been told about yet; absent in a file written
   *  before incremental sync existed, which reads as "nothing pending" */
  pending?: PendingRow[];
  revision?: number;
}

export const SNAPSHOT_VERSION = 1;

const TOUCH = new Set(TOUCH_UPDATED_AT);

/** PostgREST's error shape, so a caller cannot tell which plane refused it. */
export class LocalDbError extends Error {
  code: string;
  details: string | null;
  hint: string | null;
  constructor(message: string, code = "P0001", details: string | null = null, hint: string | null = null) {
    super(message);
    this.name = "LocalDbError";
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

const clone = <T>(v: T): T =>
  v === null || typeof v !== "object" ? v : (JSON.parse(JSON.stringify(v)) as T);

/**
 * Would writing `b` where `a` is change anything?
 *
 * WRONG IN ONE DIRECTION ONLY, and deliberately. Primitives compare with
 * `===`; anything else compares by its serialization, so two equal objects
 * whose keys are in a different order read as DIFFERENT and the write goes
 * ahead — a wasted write, which costs a save. The opposite mistake would drop
 * a real edit, and this is built so it cannot make it.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A v4 uuid. `crypto.randomUUID` is present in every browser this ships to
 *  and in node 19+, which is what the tests run on. */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Deterministic fallback so a missing WebCrypto degrades to a working id
  // rather than to a row with no primary key.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function defaultValue(spec: ColumnDefault, now: string): unknown {
  if (spec.kind === "now") return now;
  if (spec.kind === "uuid") return uuid();
  return clone(spec.value);
}

/** What Postgres would have stored when the column was left out — used by the
 *  filters too, so `.is("hidden", false)` matches a row written before that
 *  column existed, exactly as it would after the migration backfilled it. */
export function columnDefault(table: string, column: string): unknown {
  const spec = DEFAULTS[table]?.[column];
  if (!spec || spec.kind !== "value") return undefined;
  return spec.value;
}

export interface StoreChange {
  tables: string[];
}

/** One row that has changed since the cloud copy was last written.
 *  `rev` is the store revision at which it changed — what makes clearing the
 *  ledger after a push exact rather than approximate. */
export interface PendingRow { table: string; pk: string; op: "upsert" | "delete"; rev: number }

/**
 * A row's identity.
 *
 * NOT always `id`. `collection_assets` and `bible_assets` are link rows with a
 * COMPOSITE primary key and no `id` column at all — inventing one for them
 * works locally and then fails the day the project is pushed, on a column the
 * database does not have. `PRIMARY_KEYS` is read out of the migrations.
 */
export function pkOf(table: string, row: Row): string {
  const cols = PRIMARY_KEYS[table] ?? ["id"];
  return cols.map((c) => String(row[c] ?? "")).join("\u0000");
}

/** True when this table's key is a single `id` column the store may generate.
 *  A composite key is made of foreign keys the CALLER supplies. */
export function hasGeneratedId(table: string): boolean {
  const cols = PRIMARY_KEYS[table] ?? ["id"];
  return cols.length === 1 && cols[0] === "id";
}

export class LocalStore {
  readonly projectId: string;
  readonly ownerId: string;
  private data = new Map<string, Row[]>();
  private index = new Map<string, Map<string, Row>>();
  private listeners = new Set<(c: StoreChange) => void>();
  /** Bumped on every write. The persister compares it rather than diffing. */
  revision = 0;
  /**
   * WHAT THE CLOUD COPY DOES NOT HAVE YET, table -> pk -> op.
   *
   * Auto-sync cannot re-push a project every time a beat is edited: this one
   * is 3,337 rows and 249MB. So the store records what changed, and the sync
   * sends exactly that. It has to be a LEDGER rather than a timestamp
   * comparison for two reasons — the two link tables carry no timestamp at
   * all, and a DELETE leaves nothing behind to compare.
   */
  private pending = new Map<string, Map<string, { op: "upsert" | "delete"; rev: number }>>();

  constructor(projectId: string, ownerId: string) {
    this.projectId = projectId;
    this.ownerId = ownerId;
    for (const t of LOCAL_TABLES) {
      this.data.set(t, []);
      this.index.set(t, new Map());
    }
  }

  /* ── reading ──────────────────────────────────────────────────────────── */

  /** The live rows. Callers must not mutate them — the query layer clones on
   *  the way out, which is where every consumer actually reads from. */
  rows(table: string): Row[] {
    const t = this.data.get(table);
    if (!t) throw new LocalDbError(`relation "${table}" is not part of a local project`, "42P01");
    return t;
  }

  /** By primary key. For the two link tables that is `<a>\0<b>`; everywhere
   *  else it is the row's `id`, which is what every caller passes. */
  find(table: string, id: string): Row | undefined {
    return this.index.get(table)?.get(id);
  }

  has(table: string): boolean {
    return LOCAL_TABLE_SET.has(table);
  }

  /**
   * The newest timestamp anywhere in the project, or null.
   *
   * "Is the cloud copy behind?" cannot be answered from `projects.updated_at`:
   * that row moves when someone renames the project, not when they cut a
   * scene. A local project's real "last edited" is the newest row in it, and
   * the store is in memory, so asking is a scan of a few thousand fields.
   */
  lastChangedAt(): string | null {
    let newest: string | null = null;
    for (const rows of this.data.values()) {
      for (const row of rows) {
        const t = (typeof row.updated_at === "string" && row.updated_at)
          || (typeof row.created_at === "string" && row.created_at) || null;
        if (t && (!newest || t > newest)) newest = t;
      }
    }
    return newest;
  }

  /* ── writing ──────────────────────────────────────────────────────────── */

  insert(table: string, input: Row[], opts: { onConflict?: string } = {}): Row[] {
    const rows = this.rows(table);
    const idx = this.index.get(table)!;
    const now = new Date().toISOString();
    const out: Row[] = [];
    let touched = false;
    const conflictCols = opts.onConflict?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];

    // A unique index NEVER treats two NULLs as equal, so a row whose conflict
    // key contains one is distinct from every other row and can never be an
    // upsert's target — Postgres inserts a second row where this store, left
    // to `===`, would call it a conflict and overwrite the first. That is the
    // whole reason `custom_workflows_civitai_uniq` can be a plain unique index
    // (several hand-made workflows carry a null `civitai_version_id`), and the
    // divergence is silent: one plane keeps both rows, the other loses one.
    // Only nullish-on-BOTH-sides differs — `null === 'x'` is already false —
    // so testing the candidate is enough. (`nulls not distinct` is opt-in and
    // no index in this schema uses it.)
    const hasWholeKey = (r: Row) =>
      conflictCols.every((c) => r[c] !== null && r[c] !== undefined);

    for (const raw of input) {
      const candidate = this.fill(table, clone(raw), now);
      const key = pkOf(table, candidate);
      const existing = conflictCols.length
        ? (hasWholeKey(candidate)
            ? rows.find((r) => conflictCols.every((c) => r[c] === candidate[c]))
            : undefined)
        : idx.get(key);

      if (existing) {
        if (!conflictCols.length) {
          throw new LocalDbError(
            `duplicate key value violates unique constraint "${table}_pkey"`, "23505");
        }
        // An upsert onto an existing row is an UPDATE of the supplied columns.
        // `created_at` and the row's id are deliberately not among them.
        //
        // And one that would write the values already there is not an update
        // at all — see `update()` below for what a write really costs here.
        // `register_asset` re-upserts the same row on every re-registration,
        // which is the common case rather than a corner one.
        const cols = Object.entries(raw).filter(([k]) => k !== "id" && k !== "created_at");
        if (cols.some(([k, v]) => !sameValue(existing[k], v))) {
          for (const [k, v] of cols) existing[k] = clone(v);
          if (TOUCH.has(table)) existing.updated_at = now;
          this.scope(table, existing);
          this.markPending(table, pkOf(table, existing), "upsert");
          touched = true;
        }
        out.push(existing);
        continue;
      }
      rows.push(candidate);
      idx.set(key, candidate);
      this.markPending(table, key, "upsert");
      touched = true;
      out.push(candidate);
    }
    if (touched) this.changed([table]);
    return out;
  }

  /**
   * Apply `patch` to `targets` (rows already selected by the caller).
   *
   * A PATCH THAT CHANGES NOTHING IS NOT AN UPDATE. Postgres would write the
   * row anyway and shrug; here a write costs the whole PROJECT — `updated_at`
   * moves, the sync ledger gains an entry, every live query on the table
   * refetches and re-renders, and the persister rewrites `project.json`,
   * which on a real project is 11MB serialized on the webview's one thread.
   * A local render writes its progress every 1.5s and the values are
   * routinely the ones already there, so at idle that was a full rewrite
   * every couple of seconds for a row nobody had touched — measured, and the
   * single biggest thing the app was doing while it looked idle.
   *
   * Rows are judged one at a time: a patch that moves two of five costs two.
   * The one thing a skip forgoes is `scope()`, which would have re-derived
   * `project_id` from the row's parents — not a repair anything relies on,
   * since the row was scoped when it was written and is unchanged now.
   */
  update(table: string, targets: Row[], patch: Row): Row[] {
    if (!targets.length) return [];
    const now = new Date().toISOString();
    const cols = Object.entries(patch);
    let touched = false;
    for (const row of targets) {
      if (cols.every(([k, v]) => sameValue(row[k], v))) continue;
      for (const [k, v] of cols) row[k] = clone(v);
      if (TOUCH.has(table)) row.updated_at = now;
      this.scope(table, row);
      this.markPending(table, pkOf(table, row), "upsert");
      touched = true;
    }
    if (touched) this.changed([table]);
    return targets;
  }

  /** Delete `targets`, then do what the foreign keys say. Returns the rows
   *  that were removed from `table` itself — the cascade's own casualties are
   *  reported through the change event, not to the caller, exactly as
   *  PostgREST reports them. */
  remove(table: string, targets: Row[]): Row[] {
    if (!targets.length) return [];
    const touched = new Set<string>();
    this.removeInternal(table, targets, touched);
    this.changed([...touched]);
    return targets;
  }

  private removeInternal(table: string, targets: Row[], touched: Set<string>) {
    if (!targets.length) return;
    const ids = new Set(targets.map((r) => r.id));

    // Refusals first: a RESTRICT that fires after half the tree is gone is
    // worse than one that fires before anything is.
    for (const [child, fks] of Object.entries(FOREIGN_KEYS)) {
      for (const fk of fks) {
        if (fk.parent !== table || fk.onDelete !== "restrict") continue;
        const blocking = this.rows(child).filter((r) => r[fk.column] && ids.has(r[fk.column]));
        if (blocking.length) {
          throw new LocalDbError(
            `update or delete on table "${table}" violates foreign key constraint `
            + `on table "${child}"`, "23503",
            `Key is still referenced from table "${child}".`);
        }
      }
    }

    const rows = this.rows(table);
    const idx = this.index.get(table)!;
    for (const row of targets) {
      const at = rows.indexOf(row);
      if (at >= 0) rows.splice(at, 1);
      const key = pkOf(table, row);
      idx.delete(key);
      // A delete has to be RECORDED, not inferred: after it there is no row
      // left for a timestamp comparison to notice, so an incremental push
      // would leave it in the cloud copy forever.
      this.markPending(table, key, "delete");
    }
    touched.add(table);

    for (const [child, fks] of Object.entries(FOREIGN_KEYS)) {
      for (const fk of fks) {
        if (fk.parent !== table) continue;
        const hit = this.rows(child).filter((r) => r[fk.column] && ids.has(r[fk.column]));
        if (!hit.length) continue;
        if (fk.onDelete === "cascade") {
          this.removeInternal(child, hit, touched);
        } else if (fk.onDelete === "set null" || fk.onDelete === "set default") {
          for (const r of hit) {
            r[fk.column] = fk.onDelete === "set default"
              ? (columnDefault(child, fk.column) ?? null) : null;
            this.markPending(child, pkOf(child, r), "upsert");
          }
          touched.add(child);
        }
      }
    }
  }

  /* ── the trigger work ─────────────────────────────────────────────────── */

  /** Fill what the caller left out: primary key, defaults, owner and scope. */
  private fill(table: string, row: Row, now: string): Row {
    for (const [col, spec] of Object.entries(DEFAULTS[table] ?? {})) {
      if (row[col] === undefined) row[col] = defaultValue(spec, now);
    }
    if (hasGeneratedId(table) && !row.id) row.id = uuid();
    if (row.created_at === undefined && this.knowsColumn(table, "created_at")) row.created_at = now;
    if (TOUCH.has(table) && row.updated_at === undefined) row.updated_at = now;
    row.owner_id = this.ownerId;
    this.scope(table, row);
    return row;
  }

  private knowsColumn(table: string, column: string): boolean {
    return DEFAULTS[table]?.[column] !== undefined
      || this.rows(table).some((r) => r[column] !== undefined);
  }

  /**
   * `project_id`, derived the way `set_row_owner` derives `owner_id` — walk
   * the ownership chain, first parent that resolves wins.
   *
   * A local store holds exactly ONE project, so the answer is very nearly
   * always its own id — but deriving it rather than stamping it is what keeps
   * the rule identical on both planes, and what makes a row whose parent is
   * missing stay unscoped instead of claiming a project it is not part of.
   * `projects` itself is skipped: its `id` IS the scope.
   */
  private scope(table: string, row: Row) {
    if (table === "projects") return;
    if (row.project_id) return;
    for (const chain of [OWNERSHIP_PARENTS[table] ?? []]) {
      for (let i = 0; i < chain.length; i += 2) {
        const [parent, col] = [chain[i], chain[i + 1]];
        const fk = row[col];
        if (!fk) continue;
        if (parent === "projects") { row.project_id = fk; return; }
        const up = this.find(parent, fk);
        if (up?.project_id) { row.project_id = up.project_id; return; }
      }
    }
  }

  /* ── the pending ledger ───────────────────────────────────────────────── */

  private markPending(table: string, pk: string, op: "upsert" | "delete") {
    if (!this.pending.has(table)) this.pending.set(table, new Map());
    const rows = this.pending.get(table)!;
    // A row created and then deleted before any push has nothing to send: the
    // cloud never had it. Dropping the entry is what stops an incremental push
    // asking the database to delete a row it has never seen.
    if (op === "delete" && rows.get(pk)?.op === "upsert" && rows.get(pk)!.rev > this.syncedRev) {
      rows.delete(pk);
      return;
    }
    rows.set(pk, { op, rev: this.revision + 1 });
  }

  /** The revision at which the cloud copy was last brought level. */
  private syncedRev = 0;

  /** Everything the cloud copy does not have, newest revision last. */
  pendingChanges(): PendingRow[] {
    const out: PendingRow[] = [];
    for (const [table, rows] of this.pending) {
      for (const [pk, e] of rows) out.push({ table, pk, op: e.op, rev: e.rev });
    }
    return out.sort((a, b) => a.rev - b.rev);
  }

  pendingCount(): number {
    let n = 0;
    for (const rows of this.pending.values()) n += rows.size;
    return n;
  }

  /**
   * Forget what a push has now sent — everything at or below `rev`.
   *
   * By REVISION and not wholesale, because rows edited while the push was in
   * flight have to survive it. Clearing the map would silently drop those
   * edits from the cloud copy for good, which is the one failure an
   * incremental sync must not have.
   */
  clearPendingUpTo(rev: number): void {
    this.syncedRev = Math.max(this.syncedRev, rev);
    for (const [table, rows] of [...this.pending]) {
      for (const [pk, e] of [...rows]) if (e.rev <= rev) rows.delete(pk);
      if (!rows.size) this.pending.delete(table);
    }
  }

  /** Everything is pending — what a project that has never been pushed needs,
   *  and what a full push starts from. */
  markAllPending(): void {
    for (const table of LOCAL_TABLES) {
      for (const row of this.rows(table)) this.markPending(table, pkOf(table, row), "upsert");
    }
  }

  /* ── change notification ──────────────────────────────────────────────── */

  /**
   * The local plane has no realtime, so this is what replaces it.
   *
   * `useLiveQuery` invalidates on a postgres_changes event; nothing publishes
   * one for a row in a file, so every write announces itself here and the
   * plane turns that into the same `invalidateTables` call. Without it a local
   * project renders correctly once and then never updates.
   */
  onChange(cb: (c: StoreChange) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private changed(tables: string[]) {
    this.revision++;
    const c = { tables: [...new Set(tables)] };
    for (const cb of [...this.listeners]) {
      try { cb(c); } catch (e) { console.error("[local] change listener failed", e); }
    }
  }

  /* ── persistence ──────────────────────────────────────────────────────── */

  /** The document, once. `live` hands out the store's own row objects, which
   *  only `snapshotJson` may do — see there for why that is safe. */
  private doc(live: boolean): StoreSnapshot {
    const tables: Record<string, Row[]> = {};
    for (const t of LOCAL_TABLES) {
      const rows = this.data.get(t)!;
      if (rows.length) tables[t] = live ? rows : clone(rows);
    }
    return {
      version: SNAPSHOT_VERSION,
      project_id: this.projectId,
      updated_at: new Date().toISOString(),
      tables,
      // Without this, quitting the app between an edit and a sync loses the
      // fact that the edit happened — the rows are safe on disk and the cloud
      // copy silently never learns about them.
      pending: this.pendingChanges(),
      revision: this.revision,
    };
  }

  /** A detached copy of everything, for a caller that wants the object. */
  snapshot(): StoreSnapshot {
    return this.doc(false);
  }

  /**
   * The same document, serialized directly.
   *
   * The persister's only use for a snapshot is to stringify it, and
   * `snapshot()` deep-clones every row through a JSON round trip first — so
   * the obvious composition is THREE passes over the whole project (parse,
   * stringify, stringify again) plus about twice its size in garbage, on the
   * webview's one thread, for a document measured at 11MB on a real project.
   * `JSON.stringify` only ever READS its input, so the clone buys nothing on
   * this path: nobody can hold the result and reach the store through it.
   */
  snapshotJson(): string {
    return JSON.stringify(this.doc(true));
  }

  /** Replace the contents. Unknown tables are DROPPED with a warning rather
   *  than kept: they cannot be queried (the router only routes local tables),
   *  so keeping them would mean silently carrying rows nothing can reach. */
  static fromSnapshot(snap: StoreSnapshot, ownerId: string): LocalStore {
    if (snap.version > SNAPSHOT_VERSION) {
      throw new LocalDbError(
        `this project was written by a newer version of Qamba Studio `
        + `(format ${snap.version}, this build reads ${SNAPSHOT_VERSION})`, "0A000");
    }
    const store = new LocalStore(snap.project_id, ownerId);
    for (const [table, rows] of Object.entries(snap.tables ?? {})) {
      if (!LOCAL_TABLE_SET.has(table)) {
        console.warn(`[local] dropping unknown table "${table}" from ${snap.project_id}`);
        continue;
      }
      const target = store.data.get(table)!;
      const idx = store.index.get(table)!;
      for (const row of rows) {
        const copy = clone(row);
        target.push(copy);
        idx.set(pkOf(table, copy), copy);
      }
    }
    // Loaded rows are NOT pending by construction — `fromSnapshot` writes the
    // arrays directly rather than going through `insert`, which is what makes
    // a pulled project start level with the cloud copy it came from.
    store.revision = snap.revision ?? 0;
    for (const p of snap.pending ?? []) {
      if (!LOCAL_TABLE_SET.has(p.table)) continue;
      if (!store.pending.has(p.table)) store.pending.set(p.table, new Map());
      store.pending.get(p.table)!.set(p.pk, { op: p.op, rev: p.rev });
    }
    return store;
  }
}

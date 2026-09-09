// A PostgREST-shaped query builder over one `LocalStore`.
//
// WHY A SHIM AND NOT A DIFFERENT API. Twenty-one modules in this app talk to
// `supabase.from(...)`, and the alternative to speaking their language was to
// give every one of them a second code path — which is the same thing as
// giving the local plane its own product. Instead the plane is routed at the
// client (see planeRouter.ts) and this builder answers in the same shape:
// `{ data, error, count }`, the same filters, the same `single()` semantics,
// the same "a mutation returns nothing unless you asked it to `.select()`".
//
// IT IMPLEMENTS WHAT THIS APP USES, AND REFUSES THE REST. Every filter and
// modifier below appears somewhere in `src/`; anything else throws by name
// rather than being quietly ignored, because a filter that silently does
// nothing returns MORE rows than asked for — a bin query without its
// `deleted_at` clause is the whole library, and nothing about the result says
// so. `localQuery.test.ts` is the record of what is covered.
import { columnDefault, LocalDbError, LocalStore, type Row } from "./localStore.ts";
import { FOREIGN_KEYS } from "./localSchema.ts";

export interface LocalResult<T = any> {
  data: T | null;
  error: { message: string; details: string | null; hint: string | null; code: string } | null;
  count: number | null;
  status: number;
  statusText: string;
}

type Op =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "like" | "ilike" | "is" | "in" | "contains" | "overlaps";

interface Filter { path: string; op: Op; value: unknown; negate?: boolean; or?: Filter[] }

interface Embed { table: string; alias: string; inner: boolean; cols: string[] }

const clone = <T>(v: T): T =>
  v === null || typeof v !== "object" ? v : (JSON.parse(JSON.stringify(v)) as T);

/* ── comparison ─────────────────────────────────────────────────────────── */

/** Postgres compares in SQL types; this store holds whatever JSON held. A
 *  number column filtered with a string (`.eq("idx", "3")`, which is what a
 *  URL param produces) has to match, so mixed types compare as text — which is
 *  what PostgREST does on the wire anyway. */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === typeof b) return false;
  if (typeof a === "object" || typeof b === "object") return false;
  return String(a) === String(b);
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function likeToRegExp(pattern: string, flags: string): RegExp {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/%/g, ".*").replace(/_/g, ".")}$`, flags);
}

/** Read a filter/order path off a row: a column, a JSON key (`payload->>x`),
 *  or a path into a resolved embed (`assets.hidden`).
 *
 *  An absent column falls back to the DEFAULT the migration declares, so
 *  `.is("hidden", false)` matches a row written before that column existed —
 *  which is exactly what the database would report once the migration had
 *  backfilled it. */
function readPath(row: Row, table: string, path: string): unknown {
  if (path.includes("->>")) {
    const [col, key] = path.split("->>");
    const holder = row[col.trim()];
    const v = holder == null ? undefined : (holder as Row)[key.trim()];
    return v === undefined ? null : v;
  }
  if (path.includes(".")) {
    const [head, ...rest] = path.split(".");
    let v: any = row[head];
    if (Array.isArray(v)) v = v[0];
    for (const k of rest) v = v == null ? undefined : v[k];
    return v === undefined ? null : v;
  }
  const v = row[path];
  return v === undefined ? (columnDefault(table, path) ?? null) : v;
}

function passes(row: Row, table: string, f: Filter): boolean {
  if (f.or) return f.or.some((sub) => passes(row, table, sub));
  const actual = readPath(row, table, f.path);
  const want = f.value;
  let hit: boolean;
  switch (f.op) {
    case "eq": hit = looseEq(actual, want); break;
    case "neq": hit = !looseEq(actual, want); break;
    case "gt": hit = actual != null && cmp(actual, want) > 0; break;
    case "gte": hit = actual != null && cmp(actual, want) >= 0; break;
    case "lt": hit = actual != null && cmp(actual, want) < 0; break;
    case "lte": hit = actual != null && cmp(actual, want) <= 0; break;
    case "like": hit = actual != null && likeToRegExp(String(want), "").test(String(actual)); break;
    case "ilike": hit = actual != null && likeToRegExp(String(want), "i").test(String(actual)); break;
    case "is":
      hit = want === null ? actual === null || actual === undefined : actual === want;
      break;
    case "in":
      hit = (want as unknown[]).some((v) => looseEq(actual, v));
      break;
    case "contains": {
      // `cs.` IS TWO OPERATORS IN POSTGRES and both reach here. On an ARRAY
      // column it asks whether every wanted element is present; on a JSONB
      // column (`payload`, `meta`) it asks whether the document contains the
      // given pairs — which is what `recentFailures` uses to find the jobs of
      // one workflow. Reading the second as the first quietly matches nothing.
      if (want && typeof want === "object" && !Array.isArray(want)) {
        const doc = (actual ?? {}) as Record<string, unknown>;
        hit = Object.entries(want as Record<string, unknown>)
          .every(([k, v]) => looseEq(doc[k], v));
        break;
      }
      const have = Array.isArray(actual) ? actual : [];
      hit = (want as unknown[]).every((v) => have.some((h) => looseEq(h, v)));
      break;
    }
    case "overlaps": {
      const have = Array.isArray(actual) ? actual : [];
      hit = (want as unknown[]).some((v) => have.some((h) => looseEq(h, v)));
      break;
    }
    default: throw new LocalDbError(`unsupported filter "${f.op}"`, "42883");
  }
  return f.negate ? !hit : hit;
}

/* ── select parsing ─────────────────────────────────────────────────────── */

/** `"added_at, assets!inner(*)"` -> columns + embeds. One level deep, which is
 *  every embed this app writes; a nested one throws rather than returning the
 *  outer row with the inner half missing. */
export function parseSelect(sel: string): { cols: string[]; embeds: Embed[] } {
  const cols: string[] = [];
  const embeds: Embed[] = [];
  let depth = 0, cur = "";
  const parts: string[] = [];
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^([a-z_][a-z0-9_]*)(!inner|!left)?\s*\(([\s\S]*)\)$/i.exec(part);
    if (!m) { cols.push(part); continue; }
    if (m[3].includes("(")) {
      throw new LocalDbError(`nested embeds are not supported on a local project: "${part}"`, "0A000");
    }
    embeds.push({
      table: m[1], alias: m[1], inner: m[2] === "!inner",
      cols: m[3].split(",").map((c) => c.trim()).filter(Boolean),
    });
  }
  return { cols, embeds };
}

function project(row: Row, cols: string[], embeds: Embed[]): Row {
  if (!cols.length && !embeds.length) return clone(row);
  const wantAll = cols.includes("*");
  const out: Row = wantAll ? clone(row) : {};
  if (!wantAll) for (const c of cols) out[c] = clone(row[c] === undefined ? null : row[c]);
  for (const e of embeds) {
    const v = row[e.alias];
    out[e.alias] = v == null ? null
      : Array.isArray(v) ? v.map((r) => project(r, e.cols, []))
      : project(v as Row, e.cols, []);
  }
  return out;
}

/* ── the builder ────────────────────────────────────────────────────────── */

type Mode = "select" | "insert" | "upsert" | "update" | "delete";

export class LocalQueryBuilder<T = any> implements PromiseLike<LocalResult<T>> {
  private mode: Mode = "select";
  private payload: Row[] = [];
  private patch: Row = {};
  private filters: Filter[] = [];
  private orders: { path: string; asc: boolean; nullsFirst: boolean }[] = [];
  private limitN: number | null = null;
  private rangeAt: [number, number] | null = null;
  private selection: { cols: string[]; embeds: Embed[] } | null = null;
  private countMode: string | null = null;
  private onConflict: string | undefined;
  private ignoreDuplicates = false;
  private one: "single" | "maybe" | null = null;
  // Written out rather than declared as constructor parameter properties:
  // `node --test` STRIPS types, it does not compile them, and a parameter
  // property is the one ordinary TS construct it refuses outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). Same rule as everywhere else in src/.
  private store: LocalStore;
  private table: string;

  constructor(store: LocalStore, table: string) {
    this.store = store;
    this.table = table;
  }

  /* -- select / mutations -- */

  /**
   * WHAT THE RESULT'S SHAPE IS, and it is stated here rather than left as
   * `any` on purpose.
   *
   * The cloud build got this typing from `@supabase/supabase-js`, whose
   * builder resolved to `{ data: Row[] | null }`. Without it every
   * `.map((r) => …)` in the app is a callback with NO contextual type, which
   * `noImplicitAny` reports at some thirty-five call sites — and the fix
   * there would be thirty-five hand-written `any`s rather than one honest
   * signature. So a select resolves to an ARRAY and `single`/`maybeSingle`
   * narrow it back to one row, which is exactly what PostgREST does.
   *
   * The ROW type stays `any`: these are dynamic tables and the app casts at
   * the point of use (`as Asset[]`), which is where the shape is actually
   * known.
   */
  select(sel = "*", opts: { count?: string; head?: boolean } = {}): LocalQueryBuilder<any[]> {
    this.selection = parseSelect(sel);
    if (opts.count) this.countMode = opts.count;
    return this as unknown as LocalQueryBuilder<any[]>;
  }

  insert(rows: Row | Row[]): this {
    this.mode = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(
    rows: Row | Row[],
    opts: { onConflict?: string; ignoreDuplicates?: boolean } = {},
  ): this {
    this.mode = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    // Without a conflict target PostgREST uses the primary key.
    this.onConflict = opts.onConflict ?? "id";
    // `ignoreDuplicates` is DO NOTHING rather than DO UPDATE, and the
    // difference is invisible here: a link row is its own key and carries no
    // other column, so merging it writes back exactly what is already there.
    // Accepted rather than refused so the one caller that passes it
    // (`addToCollection`) reads the same on both planes.
    this.ignoreDuplicates = !!opts.ignoreDuplicates;
    return this;
  }

  update(patch: Row): this {
    this.mode = "update";
    this.patch = patch;
    return this;
  }

  delete(opts: { count?: string } = {}): this {
    this.mode = "delete";
    if (opts.count) this.countMode = opts.count;
    return this;
  }

  /* -- filters -- */

  private add(path: string, op: Op, value: unknown, negate = false): this {
    this.filters.push({ path, op, value, negate });
    return this;
  }

  eq(path: string, value: unknown) { return this.add(path, "eq", value); }
  neq(path: string, value: unknown) { return this.add(path, "neq", value); }
  gt(path: string, value: unknown) { return this.add(path, "gt", value); }
  gte(path: string, value: unknown) { return this.add(path, "gte", value); }
  lt(path: string, value: unknown) { return this.add(path, "lt", value); }
  lte(path: string, value: unknown) { return this.add(path, "lte", value); }
  like(path: string, value: string) { return this.add(path, "like", value); }
  ilike(path: string, value: string) { return this.add(path, "ilike", value); }
  is(path: string, value: unknown) { return this.add(path, "is", value); }
  in(path: string, values: unknown[]) { return this.add(path, "in", values); }
  contains(path: string, value: unknown[] | Record<string, unknown>) {
    return this.add(path, "contains", value);
  }
  overlaps(path: string, value: unknown[]) { return this.add(path, "overlaps", value); }

  not(path: string, op: Op, value: unknown) { return this.add(path, op, value, true); }

  match(query: Row): this {
    for (const [k, v] of Object.entries(query)) this.add(k, "eq", v);
    return this;
  }

  filter(path: string, op: Op, value: unknown) { return this.add(path, op, value); }

  /** `or("project_id.eq.X,project_id.is.null")` — PostgREST's own grammar,
   *  which is what the four call sites in this app write. */
  or(expr: string): this {
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (const ch of expr) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);

    const subs: Filter[] = parts.map((raw) => {
      const part = raw.trim();
      // The path may itself contain dots (`payload->>block_id`), so split on
      // the LAST two segments: <path>.<op>.<value>.
      const m = /^(.*?)\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.([\s\S]*)$/.exec(part);
      if (!m) throw new LocalDbError(`cannot parse or() term "${part}"`, "42601");
      const [, path, op, rawValue] = m;
      let value: unknown = rawValue;
      if (rawValue === "null") value = null;
      else if (rawValue === "true") value = true;
      else if (rawValue === "false") value = false;
      else if (op === "in") value = rawValue.replace(/^\(|\)$/g, "").split(",");
      return { path, op: op as Op, value };
    });
    this.filters.push({ path: "", op: "eq", value: null, or: subs });
    return this;
  }

  /* -- modifiers -- */

  order(path: string, opts: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string } = {}): this {
    const asc = opts.ascending !== false;
    this.orders.push({
      path, asc,
      // Postgres orders nulls last ascending, first descending, unless told.
      nullsFirst: opts.nullsFirst ?? !asc,
    });
    return this;
  }

  limit(n: number): this { this.limitN = n; return this; }

  range(from: number, to: number): this { this.rangeAt = [from, to]; return this; }

  /** One row rather than an array — `single` errors when there is not exactly
   *  one, `maybeSingle` answers null. Both narrow the result the way
   *  PostgREST's own do, which is what keeps `data.settings` legal after one
   *  and illegal after a bare select. */
  single(): LocalQueryBuilder<any> {
    this.one = "single";
    return this as unknown as LocalQueryBuilder<any>;
  }

  maybeSingle(): LocalQueryBuilder<any> {
    this.one = "maybe";
    return this as unknown as LocalQueryBuilder<any>;
  }

  /* -- execution -- */

  /**
   * A filter on an EMBEDDED column (`assets.hidden`) can only be evaluated
   * once the embed is resolved — before that the alias is simply absent, and
   * `.is("assets.hidden", false)` would drop every row. So the filter list is
   * split rather than applied twice: base filters choose the rows, embed
   * filters run after resolution.
   *
   * Re-running the BASE filters afterwards is what broke the job claim:
   * `.update({status:"running"}).eq("status","queued").select()` had already
   * stopped matching by the time the result was assembled, so a successful
   * claim came back empty and both racers concluded they had lost.
   */
  private isEmbedPath(path: string): boolean {
    return (this.selection?.embeds ?? []).some((e) => path.startsWith(`${e.alias}.`));
  }

  private embedFilter(f: Filter): boolean {
    return f.or ? f.or.some((sub) => this.isEmbedPath(sub.path)) : this.isEmbedPath(f.path);
  }

  private matching(): Row[] {
    const base = this.filters.filter((f) => !this.embedFilter(f));
    return this.store.rows(this.table).filter((r) => base.every((f) => passes(r, this.table, f)));
  }

  /** Attach each embed to a COPY of the base row, so filters can read
   *  `assets.hidden` before projection ever happens. */
  private withEmbeds(rows: Row[]): Row[] {
    const embeds = this.selection?.embeds ?? [];
    if (!embeds.length) return rows;
    return rows.map((row) => {
      const carrier: Row = Object.create(Object.getPrototypeOf(row));
      Object.assign(carrier, row);
      for (const e of embeds) carrier[e.alias] = this.resolveEmbed(row, e);
      return carrier;
    });
  }

  private resolveEmbed(row: Row, e: Embed): Row | Row[] | null {
    const toOne = (FOREIGN_KEYS[this.table] ?? []).find((fk) => fk.parent === e.table);
    if (toOne) {
      const id = row[toOne.column];
      return id ? (this.store.find(e.table, id) ?? null) : null;
    }
    const toMany = (FOREIGN_KEYS[e.table] ?? []).find((fk) => fk.parent === this.table);
    if (toMany) {
      return this.store.rows(e.table).filter((r) => r[toMany.column] === row.id);
    }
    throw new LocalDbError(
      `no foreign key between "${this.table}" and "${e.table}" — an embed the local plane `
      + "cannot resolve", "42P01");
  }

  private sort(rows: Row[]): Row[] {
    if (!this.orders.length) return rows;
    const table = this.table;
    return [...rows].sort((a, b) => {
      for (const o of this.orders) {
        const av = readPath(a, table, o.path);
        const bv = readPath(b, table, o.path);
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull || bNull) {
          if (aNull && bNull) continue;
          return (aNull ? 1 : -1) * (o.nullsFirst ? -1 : 1);
        }
        const d = cmp(av, bv);
        if (d) return o.asc ? d : -d;
      }
      return 0;
    });
  }

  private run(): LocalResult<T> {
    let affected: Row[];
    switch (this.mode) {
      case "insert":
        affected = this.store.insert(this.table, this.payload);
        break;
      case "upsert":
        affected = this.store.insert(this.table, this.payload, { onConflict: this.onConflict });
        break;
      case "update":
        affected = this.store.update(this.table, this.matching(), this.patch);
        break;
      case "delete":
        affected = this.store.remove(this.table, this.matching());
        break;
      default:
        affected = this.matching();
    }

    const count = this.countMode ? affected.length : null;

    // A mutation returns rows only when the caller asked to see them, exactly
    // as PostgREST does with `Prefer: return=representation`.
    if (this.mode !== "select" && !this.selection) {
      return { data: null as any, error: null, count, status: 204, statusText: "No Content" };
    }

    let rows = this.mode === "select" ? this.sort(this.withEmbeds(affected)) : this.withEmbeds(affected);

    // `!inner` drops a base row whose embed found nothing — the difference
    // between "every membership" and "every membership whose asset still
    // exists", which is what the collection counts depend on.
    for (const e of this.selection?.embeds ?? []) {
      if (!e.inner) continue;
      rows = rows.filter((r) => {
        const v = r[e.alias];
        return Array.isArray(v) ? v.length > 0 : v != null;
      });
    }
    // Embedded filters are applied AFTER resolution, and ONLY those: the base
    // filters already chose these rows, and an UPDATE has since changed them.
    const embedFilters = this.filters.filter((f) => this.embedFilter(f));
    if (embedFilters.length) {
      rows = rows.filter((r) => embedFilters.every((f) => passes(r, this.table, f)));
    }

    if (this.rangeAt) rows = rows.slice(this.rangeAt[0], this.rangeAt[1] + 1);
    if (this.limitN != null) rows = rows.slice(0, this.limitN);

    const sel = this.selection ?? { cols: ["*"], embeds: [] };
    const data = rows.map((r) => project(r, sel.cols, sel.embeds));

    if (this.one) {
      if (data.length > 1) {
        return {
          data: null as any,
          error: {
            message: "JSON object requested, multiple (or no) rows returned",
            details: `Results contain ${data.length} rows`, hint: null, code: "PGRST116",
          },
          count, status: 406, statusText: "Not Acceptable",
        };
      }
      if (!data.length) {
        if (this.one === "maybe") {
          return { data: null as any, error: null, count, status: 200, statusText: "OK" };
        }
        return {
          data: null as any,
          error: {
            message: "JSON object requested, multiple (or no) rows returned",
            details: "The result contains 0 rows", hint: null, code: "PGRST116",
          },
          count, status: 406, statusText: "Not Acceptable",
        };
      }
      return { data: data[0] as any, error: null, count, status: 200, statusText: "OK" };
    }
    return { data: data as any, error: null, count, status: 200, statusText: "OK" };
  }

  /** Thenable, not a promise: `await supabase.from(...)...` is how every call
   *  site executes, and a builder that only ran on `.execute()` would need all
   *  of them rewritten. */
  then<R1 = LocalResult<T>, R2 = never>(
    onfulfilled?: ((v: LocalResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    let result: LocalResult<T>;
    try {
      result = this.run();
    } catch (e) {
      const err = e instanceof LocalDbError ? e : new LocalDbError(
        e instanceof Error ? e.message : String(e));
      result = {
        data: null as any,
        error: { message: err.message, details: err.details, hint: err.hint, code: err.code },
        count: null, status: 400, statusText: "Bad Request",
      };
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

export function localFrom(store: LocalStore, table: string): LocalQueryBuilder {
  return new LocalQueryBuilder(store, table);
}

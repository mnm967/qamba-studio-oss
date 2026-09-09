// PostgREST, answered by the browser, for a project that lives on this machine.
//
// WHY THIS SHAPE. The studio's pipeline is Python and every database touch in
// it goes through `worker/sb.py`, which speaks PostgREST paths —
// `scenes?select=*&storyboard_id=eq.X&order=idx`. A local project's rows are a
// JSON file the WEBVIEW owns (localStore.ts), so the two cannot meet by
// sharing a client. They meet by sharing a WIRE FORMAT: Rust runs a loopback
// listener (dbproxy.rs), `SUPABASE_URL` points the Python at it, and every
// request lands here to be answered out of the open store.
//
// The payoff is that `sb.py` DOES NOT CHANGE AT ALL. Not one line of the
// planner, the block pipeline or the reviewer knows which plane it is running
// against — which is the only reason running the studio's own pipeline on a
// local project was affordable at all.
//
// IT DECIDES THE PLANE PER TABLE, exactly as `planeRouter` does for the app.
// `model_catalog`, `pod_status` and `job_timings` are the STUDIO's and are not
// part of a project, so they are answered from Supabase even while a local
// project's job is running. Anything else would make a local project's plan
// read an empty model catalog and quietly render on the defaults.
//
// IT IMPLEMENTS WHAT THE WORKER SENDS, AND REFUSES THE REST — the same rule
// `localQuery` states for the builder API, for the same reason: a filter that
// is silently dropped returns MORE rows than were asked for, and nothing in
// the result says so. Every operator below was counted in `worker/**.py`.

export interface RestRequest {
  method: string;
  /** the full path including `/rest/v1`, query string and all */
  path: string;
  /** the raw request body, or null */
  body: string | null;
  /** the `Prefer` header, verbatim */
  prefer: string | null;
}

export interface RestResponse {
  status: number;
  /** a JSON body — rows, a scalar, or a PostgREST-shaped error */
  body: string;
}

/** A supabase-js-shaped query builder factory. `localFrom(store, t)` and the
 *  real client's `from` both satisfy it, which is what lets one translator
 *  serve both planes. */
export type FromFn = (table: string) => any;
export type RpcFn = (name: string, args: Record<string, unknown>) => any;

export interface RestPlane {
  from: FromFn;
  rpc: RpcFn;
}

/**
 * Choose the plane for a table.
 *
 * `isRpc` is passed because a stored procedure's NAME is not a table name and
 * a table-set lookup answers no for every one of them — which would send
 * `request_job_cancel` to Supabase for a project Supabase has never heard of.
 * The caller decides; this only has to hand it the fact.
 */
export type PlaneFor = (table: string, isRpc: boolean) => RestPlane;

const err = (status: number, message: string, code = "PGRST100"): RestResponse => ({
  status,
  body: JSON.stringify({ message, details: null, hint: null, code }),
});

/* ── the value grammar ──────────────────────────────────────────────────── */

/** PostgREST's own scalar spelling. `null`, `true` and `false` are keywords on
 *  the wire; everything else arrives as text, which is what the store compares
 *  loosely anyway (`localQuery.looseEq`). */
function scalar(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  // PostgREST quotes a value containing a reserved character. Unwrap it, or a
  // legitimate `eq."a,b"` never matches.
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}

/** `(a,b,c)` — an `in.` list. */
function inList(raw: string): unknown[] {
  const inner = raw.replace(/^\(|\)$/g, "");
  return inner === "" ? [] : splitTop(inner, ",").map((s) => scalar(s.trim()));
}

/** `{a,b}` — an array literal, for `cs.`/`ov.`. */
function arrayLiteral(raw: string): unknown[] {
  const inner = raw.replace(/^\{|\}$/g, "");
  return inner === "" ? [] : splitTop(inner, ",").map((s) => scalar(s.trim()));
}

/** Split on a separator that is not inside brackets or quotes. A uuid list
 *  never needs it; an `or=(a.eq.1,b.eq.2)` term does. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") quoted = !quoted;
    if (!quoted) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Apply one `column=<op>.<value>` filter.
 *
 * `not.` is a PREFIX on the operator, not an operator — `deleted_at=not.is.null`
 * is "is not null". Reading it as an operator named `not` drops the clause,
 * which for that exact filter is the whole recycle bin.
 */
function applyFilter(q: any, column: string, raw: string): any {
  let rest = raw;
  let negate = false;
  if (rest.startsWith("not.")) { negate = true; rest = rest.slice(4); }
  const dot = rest.indexOf(".");
  if (dot < 0) throw new Error(`cannot parse filter "${column}=${raw}"`);
  const op = rest.slice(0, dot);
  const value = rest.slice(dot + 1);

  switch (op) {
    case "eq": case "neq": case "gt": case "gte": case "lt": case "lte":
      return negate ? q.not(column, op, scalar(value)) : q[op](column, scalar(value));
    case "like": case "ilike": {
      // PostgREST spells the wildcard `*` on the wire and `%` in SQL.
      const pat = value.replace(/\*/g, "%");
      return negate ? q.not(column, op, pat) : q[op](column, pat);
    }
    case "is":
      return negate ? q.not(column, "is", scalar(value)) : q.is(column, scalar(value));
    case "in":
      return negate ? q.not(column, "in", inList(value)) : q.in(column, inList(value));
    case "cs":
      return negate ? q.not(column, "contains", arrayLiteral(value))
                    : q.contains(column, arrayLiteral(value));
    case "ov":
      return negate ? q.not(column, "overlaps", arrayLiteral(value))
                    : q.overlaps(column, arrayLiteral(value));
    default:
      // By name. A silently ignored operator is the "more rows than you asked
      // for" failure this module exists to avoid.
      throw new Error(`unsupported filter operator "${op}" on ${column}`);
  }
}

/* ── the request ────────────────────────────────────────────────────────── */

interface Parsed {
  table: string;
  isRpc: boolean;
  params: [string, string][];
}

export function parsePath(path: string): Parsed {
  const clean = path.replace(/^\/+/, "");
  const withoutPrefix = clean.startsWith("rest/v1/") ? clean.slice("rest/v1/".length) : clean;
  const qm = withoutPrefix.indexOf("?");
  const head = qm < 0 ? withoutPrefix : withoutPrefix.slice(0, qm);
  const query = qm < 0 ? "" : withoutPrefix.slice(qm + 1);
  const params: [string, string][] = [];
  for (const part of query ? query.split("&") : []) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const v = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1));
    params.push([k, v]);
  }
  const isRpc = head.startsWith("rpc/");
  return { table: isRpc ? head.slice(4) : head, isRpc, params };
}

const MODIFIERS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

/** Answer one request out of `planeFor(table)`. */
export async function localRest(planeFor: PlaneFor, req: RestRequest): Promise<RestResponse> {
  let parsed: Parsed;
  try {
    parsed = parsePath(req.path);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
  if (!parsed.table) return err(404, "no table in the path");

  const plane = planeFor(parsed.table, parsed.isRpc);
  const method = req.method.toUpperCase();
  const prefer = req.prefer ?? "";
  const wantRows = prefer.includes("return=representation");

  let payload: unknown = null;
  if (req.body) {
    try { payload = JSON.parse(req.body); }
    catch { return err(400, "the request body is not JSON"); }
  }

  /* ── stored procedures ── */
  if (parsed.isRpc) {
    if (method !== "POST") return err(405, `rpc takes POST, not ${method}`);
    try {
      const out = await plane.rpc(parsed.table, (payload ?? {}) as Record<string, unknown>);
      const { data, error } = out ?? {};
      if (error) return err(400, error.message ?? String(error), error.code ?? "P0001");
      return { status: 200, body: JSON.stringify(data ?? null) };
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e));
    }
  }

  try {
    let q: any = plane.from(parsed.table);

    /* the mutation comes first: `.update()` before `.eq()` is what
       supabase-js expects, and the filters below apply to whichever it is. */
    const onConflict = parsed.params.find(([k]) => k === "on_conflict")?.[1];
    if (method === "GET") {
      const sel = parsed.params.find(([k]) => k === "select")?.[1] ?? "*";
      q = q.select(sel);
    } else if (method === "POST") {
      const rows = payload ?? [];
      // `resolution=merge-duplicates` is the only thing that separates an
      // upsert from an insert on the wire — an `on_conflict` alone does not,
      // and treating one as the other either duplicates a row or overwrites
      // one nobody asked to touch.
      q = prefer.includes("merge-duplicates")
        ? q.upsert(rows, onConflict ? { onConflict } : {})
        : q.insert(rows);
      if (wantRows) q = q.select();
    } else if (method === "PATCH") {
      q = q.update(payload ?? {});
      if (wantRows) q = q.select();
    } else if (method === "DELETE") {
      q = q.delete();
      if (wantRows) q = q.select();
    } else {
      return err(405, `${method} is not supported`);
    }

    let limit: number | null = null;
    let offset = 0;
    for (const [k, v] of parsed.params) {
      if (k === "order") {
        for (const term of splitTop(v, ",")) {
          const bits = term.trim().split(".");
          const col = bits[0];
          if (!col) continue;
          q = q.order(col, {
            ascending: !bits.includes("desc"),
            nullsFirst: bits.includes("nullsfirst"),
          });
        }
      } else if (k === "limit") {
        limit = Number(v);
      } else if (k === "offset") {
        offset = Number(v) || 0;
      } else if (k === "or") {
        q = q.or(v.replace(/^\(|\)$/g, ""));
      } else if (!MODIFIERS.has(k)) {
        q = applyFilter(q, k, v);
      }
    }
    // `offset` without `limit` is legal on the wire; `range` needs both ends,
    // so an unbounded offset becomes a range to a very large row.
    if (limit != null && Number.isFinite(limit)) {
      q = offset ? q.range(offset, offset + limit - 1) : q.limit(limit);
    } else if (offset) {
      q = q.range(offset, Number.MAX_SAFE_INTEGER);
    }

    const { data, error } = await q;
    if (error) {
      // PostgREST answers 409 on a conflict and 4xx on a bad request; `sb.py`
      // only ever looks at "did this raise", so the code matters less than the
      // MESSAGE surviving — `raise_for_status` puts the body in the traceback.
      const code = (error as { code?: string }).code ?? "PGRST100";
      return err(code === "23505" ? 409 : 400, error.message ?? String(error), code);
    }
    if (method !== "GET" && !wantRows) return { status: 204, body: "" };
    return {
      status: method === "POST" ? 201 : 200,
      body: JSON.stringify(data ?? []),
    };
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
}

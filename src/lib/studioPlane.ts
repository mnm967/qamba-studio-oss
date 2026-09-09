// The plane that answers for the STUDIO rather than for a project.
//
// Every query in this app goes through `supabase.from(table)` (see
// lib/supabase.js), and the local plane answers it for the tables a project
// owns — while a project is open. Two things are left over, and this module
// answers both:
//
//   * TABLES THAT ARE NOT PART OF ANY PROJECT. The model catalogue is a fact
//     about this build (generated into `modelCatalog.gen.ts` by
//     scripts/gen_model_catalog.py); `job_timings` is this machine's own
//     record of how long its renders take, kept in localStorage so the ETA
//     estimator has something to learn from across projects.
//   * PROJECT TABLES WHEN NO PROJECT IS OPEN. The projects list, the top bar's
//     queue badge and the queue popover all ask about `jobs`, `projects` and
//     `assets` from outside any project. They are answered READ-ONLY as the
//     union of every local project's rows; a write with no project open is a
//     bug in the caller and is refused by name rather than filed nowhere.
//
// It is a `LocalStore` subclass so `localFrom` — the PostgREST-shaped builder
// the rest of the app already speaks — needs no second implementation.
import { LocalDbError, LocalStore, uuid, type Row } from "./localStore.ts";
import { localFrom, type LocalQueryBuilder } from "./localQuery.ts";
import { LOCAL_TABLE_SET } from "./localSchema.ts";
import { localRpc, type RpcResult } from "./localRpc.ts";
import { catalogRows } from "./catalog.ts";

const CATALOG_TABLES = new Set(["model_catalog", "model_catalog_visible"]);
const TIMINGS_KEY = "qamba.studio.job_timings";
/** Enough for the estimator's rolling median, small enough to stay a
 *  localStorage value. Oldest rows fall off the front. */
const TIMINGS_KEEP = 400;

/** Who holds the local projects. Installed by `localPlane` at boot rather
 *  than imported, so this module depends on nothing that reaches the disk. */
let projectSource: () => LocalStore[] = () => [];

export function setStudioProjectSource(fn: () => LocalStore[]): void {
  projectSource = fn;
}

function readTimings(): Row[] {
  try {
    const v = JSON.parse(localStorage.getItem(TIMINGS_KEY) ?? "[]");
    return Array.isArray(v) ? (v as Row[]) : [];
  } catch { return []; }
}

function writeTimings(rows: Row[]): void {
  try { localStorage.setItem(TIMINGS_KEY, JSON.stringify(rows)); }
  catch { /* a lost timing costs a vaguer ETA, nothing more */ }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

class StudioStore extends LocalStore {
  private timings: Row[] | null = null;

  constructor() {
    super("studio", "studio");
  }

  override rows(table: string): Row[] {
    if (CATALOG_TABLES.has(table)) return catalogRows() as unknown as Row[];
    if (table === "job_timings") return (this.timings ??= readTimings());
    if (LOCAL_TABLE_SET.has(table)) {
      const out: Row[] = [];
      for (const s of projectSource()) out.push(...s.rows(table));
      return out;
    }
    // Anything else was the studio's cloud (pod status, accounts, shares) and
    // has no answer here. Empty rather than an error: a surface asking about
    // it should render "nothing", not a red banner.
    return [];
  }

  override find(table: string, id: string): Row | undefined {
    return this.rows(table).find((r) => String(r.id) === id);
  }

  override has(table: string): boolean {
    return CATALOG_TABLES.has(table) || table === "job_timings" || LOCAL_TABLE_SET.has(table);
  }

  private refuse(table: string): never {
    throw new LocalDbError(
      `cannot write "${table}" with no project open — a row belongs to a project`, "42501");
  }

  override insert(table: string, input: Row[], _opts: { onConflict?: string } = {}): Row[] {
    if (table !== "job_timings") this.refuse(table);
    const rows = this.rows(table);
    const now = new Date().toISOString();
    const out = input.map((r) => ({ id: uuid(), created_at: now, ...clone(r) }));
    rows.push(...out);
    if (rows.length > TIMINGS_KEEP) rows.splice(0, rows.length - TIMINGS_KEEP);
    writeTimings(rows);
    return out.map(clone);
  }

  override update(table: string, targets: Row[], patch: Row): Row[] {
    if (table !== "job_timings") this.refuse(table);
    for (const row of targets) Object.assign(row, clone(patch));
    writeTimings(this.rows(table));
    return targets;
  }

  override remove(table: string, targets: Row[]): Row[] {
    if (table !== "job_timings") this.refuse(table);
    const ids = new Set(targets.map((r) => r.id));
    const rows = this.rows(table);
    const kept = rows.filter((r) => !ids.has(r.id));
    rows.splice(0, rows.length, ...kept);
    writeTimings(rows);
    return targets;
  }
}

const studio = new StudioStore();

/** A query builder for a table nobody's project owns — or for a project table
 *  asked about from outside any project. */
export function studioFrom(table: string): LocalQueryBuilder {
  return localFrom(studio, table);
}

const ok = <T>(data: T): RpcResult<T> =>
  ({ data, error: null, count: null, status: 200, statusText: "OK" });
const fail = (message: string, code = "42883"): RpcResult<never> =>
  ({ data: null, error: { message, details: null, hint: null, code },
     count: null, status: 404, statusText: "Not Found" });

/** Which local project holds a row of `table` with this id. */
function storeHolding(table: string, id: string): LocalStore | null {
  for (const s of projectSource()) if (s.find(table, id)) return s;
  return null;
}

/**
 * A stored procedure asked with no project open.
 *
 * The four the local plane implements are routed to the project that owns the
 * row they name; the count RPCs are merged across every local project.
 * Anything else was one of the studio's own (accounts, visibility, the
 * orphan claim) and answers with a named refusal rather than a silent null.
 */
export async function studioRpc(name: string, args: Record<string, unknown> = {}): Promise<RpcResult> {
  const stores = projectSource();
  const forStore = (s: LocalStore) => localRpc(s, name, args) ?? Promise.resolve(fail(`unknown rpc ${name}`));
  switch (name) {
    case "request_job_cancel": {
      const s = storeHolding("jobs", String(args.p_job ?? ""));
      return s ? forStore(s) : ok(null);
    }
    case "reorder_scenes": {
      const s = storeHolding("storyboards", String(args.p_storyboard ?? ""));
      return s ? forStore(s) : fail(`storyboard ${String(args.p_storyboard)} is not on this machine`, "22023");
    }
    case "project_storage_stats": {
      const s = stores.find((x) => x.projectId === String(args.p_project ?? ""));
      return s ? forStore(s) : ok([]);
    }
    case "asset_counts":
    case "collection_counts":
    case "rag_chunk_counts": {
      // Merged across projects: each row is keyed on the first column
      // (kind / collection_id / document_id) plus the flags, and the counts
      // add — exactly what one query over every project's rows would give.
      const merged = new Map<string, Row>();
      for (const s of stores) {
        const r = await forStore(s);
        for (const row of (r.data as Row[] | null) ?? []) {
          const key = Object.entries(row)
            .filter(([k]) => !["live", "trashed", "n", "chunks", "embedded"].includes(k))
            .map(([k, v]) => `${k}=${String(v)}`).join("|");
          const acc = merged.get(key);
          if (!acc) { merged.set(key, clone(row)); continue; }
          for (const k of ["live", "trashed", "n", "chunks", "embedded"]) {
            if (typeof row[k] === "number") acc[k] = (Number(acc[k]) || 0) + (row[k] as number);
          }
        }
      }
      return ok([...merged.values()]);
    }
    default:
      return fail(`${name} is not available in this build — it belonged to the studio's cloud`);
  }
}

/** Test seam: forget the cached timings so a test can seed localStorage. */
export function __resetStudioPlane(): void {
  (studio as unknown as { timings: Row[] | null }).timings = null;
}

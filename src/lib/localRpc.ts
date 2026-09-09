// The stored procedures a local project has to run for itself.
//
// Three of this app's RPCs are about ONE project rather than about the
// studio, and they are load-bearing in a way that is invisible when they
// quietly do nothing:
//
//   * `request_job_cancel` — the Cancel button. Unrouted, it asks Supabase to
//     cancel a job that only exists in a file on this machine, gets a
//     perfectly successful "no rows", and the render carries on. A cancel that
//     does not cancel is the worst kind of control.
//   * `reorder_scenes` — a scene drag. Its whole reason for being an RPC is
//     that `(storyboard_id, idx)` is unique and NOT deferrable, so a
//     permutation applied row by row collides with a row it has not moved
//     yet. In memory there is no constraint to violate, but the OTHER half of
//     what it does still matters: a reorder marks the block plan stale,
//     because blocks span scenes and carry absolute times.
//   * `project_storage_stats` — what the storage sheet reports. Unrouted, a
//     local project asks Supabase about a project id that is not there and
//     gets an empty result, so the sheet says the project holds nothing at
//     all — while its media sits in a folder on this disk.
//
// Everything else — `model_roster`, `lora_roster`, `find_account`,
// `claim_orphan_data`, `orphan_data_count` — is the studio's and stays on the
// cloud plane even while a local project is open. `project_role` is answered
// in db/shares.ts instead: it is asked from the projects LIST too, where no
// project is open and this router is therefore not consulted.
//
// The shapes are mirrored from the SQL deliberately, down to which rows the
// update touches, so a caller cannot tell which plane answered.
import type { LocalStore, Row } from "./localStore.ts";

/** A PostgREST-shaped result, since that is what `supabase.rpc()` resolves to. */
export interface RpcResult<T = unknown> {
  data: T | null;
  error: { message: string; details: string | null; hint: string | null; code: string } | null;
  count: null;
  status: number;
  statusText: string;
}

const ok = <T>(data: T): RpcResult<T> =>
  ({ data, error: null, count: null, status: 200, statusText: "OK" });

const fail = (message: string, code: string): RpcResult<never> =>
  ({ data: null, error: { message, details: null, hint: null, code },
     count: null, status: 400, statusText: "Bad Request" });

/** Run one, or return null to leave it on the cloud plane. */
export function localRpc(
  store: LocalStore, name: string, args: Record<string, unknown> = {},
): Promise<RpcResult> | null {
  switch (name) {
    case "request_job_cancel": return Promise.resolve(cancelJob(store, String(args.p_job ?? "")));
    case "reorder_scenes":
      return Promise.resolve(reorderScenes(
        store, String(args.p_storyboard ?? ""), (args.p_ids as string[]) ?? []));
    case "project_storage_stats":
      return Promise.resolve(storageStats(store, String(args.p_project ?? "")));
    case "asset_counts":
      return Promise.resolve(assetCounts(
        store,
        args.p_project ? String(args.p_project) : null,
        args.p_owner ? String(args.p_owner) : null,
      ));
    default: return null;
  }
}

/** The twin of `public.asset_counts` (migration 20260818070000).
 *  Hidden assets are excluded (a sidebar tally must not disclose what the grid
 *  will not show). Live and binned counts are returned per kind. */
function assetCounts(
  store: LocalStore, projectId?: string | null, ownerId?: string | null,
): RpcResult<Row[]> {
  const byKind = new Map<string, { kind: string; live: number; trashed: number }>();
  for (const a of store.rows("assets")) {
    if (a.hidden) continue;
    if (projectId && a.project_id && a.project_id !== projectId) continue;
    if (ownerId && a.owner_id && a.owner_id !== ownerId) continue;
    const kind = String(a.kind ?? "file");
    let r = byKind.get(kind);
    if (!r) {
      r = { kind, live: 0, trashed: 0 };
      byKind.set(kind, r);
    }
    if (a.deleted_at) {
      r.trashed++;
    } else {
      r.live++;
    }
  }
  return ok([...byKind.values()]);
}

/** The twin of `public.project_storage_stats` (migration 20260826120000),
 *  down to which rows it counts: hidden assets INCLUDED (a copy moves them),
 *  binned ones reported separately rather than dropped, and a null `bytes`
 *  summed as zero but counted in `unsized_n` so the sheet can say the total is
 *  a floor rather than quietly under-reporting it. */
function storageStats(store: LocalStore, projectId: string): RpcResult<Row[]> {
  const byKind = new Map<string, Row>();
  for (const a of store.rows("assets")) {
    if (projectId && a.project_id && a.project_id !== projectId) continue;
    const kind = String(a.kind ?? "file");
    let r = byKind.get(kind);
    if (!r) {
      r = { kind, live_n: 0, live_bytes: 0, trashed_n: 0, trashed_bytes: 0, unsized_n: 0 };
      byKind.set(kind, r);
    }
    const bytes = typeof a.bytes === "number" ? a.bytes : null;
    if (bytes === null) (r.unsized_n as number)++;
    if (a.deleted_at) {
      (r.trashed_n as number)++;
      (r.trashed_bytes as number) += bytes ?? 0;
    } else {
      (r.live_n as number)++;
      (r.live_bytes as number) += bytes ?? 0;
    }
  }
  return ok([...byKind.values()]);
}

/**
 * `update jobs set cancel_requested = true, status = case when status =
 * 'queued' then 'canceled' else status end where id = ? and status in
 * ('queued','running')`.
 *
 * A RUNNING job keeps its status on purpose: the worker polls
 * `cancel_requested` and writes the terminal status itself once it has let go
 * of the engine. Marking it canceled here would leave a render running under
 * a row that says it stopped.
 */
function cancelJob(store: LocalStore, id: string): RpcResult<Row | null> {
  const job = store.find("jobs", id);
  if (!job || !["queued", "running"].includes(String(job.status))) return ok(null);
  store.update("jobs", [job], {
    cancel_requested: true,
    ...(job.status === "queued" ? { status: "canceled" } : {}),
    updated_at: new Date().toISOString(),
  });
  return ok(JSON.parse(JSON.stringify(job)) as Row);
}

/** Returns how many scenes moved, and marks the block plan stale when any
 *  did — both halves of the SQL, including its refusal. */
function reorderScenes(store: LocalStore, storyboardId: string, ids: string[]): RpcResult<number> {
  const scenes = store.rows("scenes").filter((s) => s.storyboard_id === storyboardId);
  const named = new Set(ids);
  if (named.size !== ids.length || named.size !== scenes.length
      || scenes.some((s) => !named.has(s.id))) {
    // The same refusal, for the same reason: a stale list would drop a scene
    // out of the episode rather than reorder it.
    return fail(
      `reorder_scenes: p_ids must name every scene in storyboard ${storyboardId} exactly once`,
      "22023");
  }
  let moved = 0;
  ids.forEach((id, ord) => {
    const scene = scenes.find((s) => s.id === id)!;
    if (scene.idx === ord) return;
    moved++;
    store.update("scenes", [scene], { idx: ord });
  });
  if (moved > 0) {
    const stale = store.rows("generation_blocks").filter(
      (b) => b.storyboard_id === storyboardId && ["planned", "generated"].includes(String(b.status)));
    if (stale.length) store.update("generation_blocks", stale, { status: "stale" });
  }
  return ok(moved);
}

// v2 asset registry access. Every B2 object flows through here (invariant #2):
// register on upload/generation, DB-row-first on delete.
import { supabase } from "../supabase";
import { mediaUrl } from "../supabase";
import { pageThrough } from "./paging";
import { planeIsLocal } from "../planeRouter.ts";
import { probeElementFor, probeMediaMeta } from "../mediaProbe";
import type { Asset, AssetKind, Job } from "./types";

export function assetUrl(a: Pick<Asset, "b2_key"> | null | undefined): string | null {
  return a ? mediaUrl(a.b2_key) : null;
}

/** What `ownedOnly` filters on, resolved once per query. */
type OwnerScope =
  /** The signed-in account — the cloud plane. */
  | { by: "uid"; uid: string }
  /** Do not filter. */
  | { by: "all" }
  /** Nothing is mine: the cloud plane with no session. */
  | { by: "none" };

/**
 * Who "mine" means for `ownedOnly`.
 *
 * THE LOCAL PLANE DOES NOT FILTER AT ALL, and that is the answer rather than a
 * shortcut. `ownedOnly` exists to keep a project someone SHARED with you out
 * of your own cross-project library; a local store holds exactly one project,
 * all of it on this machine, so there is nothing there to exclude — and every
 * id it could be compared against is wrong for some store. The session's is
 * wrong because a local project keeps working signed out, which is most of the
 * point. This install's own id is wrong too, and that is the failure this
 * replaces: a project PULLED from the cloud keeps the CLOUD account's
 * `owner_id` on every row it copied down — `fromSnapshot` writes the rows
 * verbatim, which is what makes a pull start level with the copy it came from,
 * and `forCloud` strips the column on the way back up, so the value is
 * meaningless locally by design. Measured on one such project: 1,298 of its
 * 1,304 assets carried the cloud uuid and 6 (written here since) carried the
 * install id, so every kind facet and every sidebar tally read 0 over a grid
 * that was showing the project — "This project" alone was right, because it is
 * the one row scoped by project rather than by owner.
 */
async function ownerScope(): Promise<OwnerScope> {
  // EVERY PROJECT IS THIS INSTALL'S. The cloud build asked the session whose
  // rows these were, because one registry held every account's; here there is
  // one owner and the question has one answer.
  return { by: "all" };
}

/** Browse the registry. Binned and hidden assets are excluded unless `deleted`
 *  or `hidden` asks for exactly them — every picker, every grid and every ref
 *  chooser goes through here, so both exclusions land everywhere at once. */
export async function loadAssets(opts: {
  projectId?: string | null;
  kind?: AssetKind;
  tags?: string[];
  search?: string;
  limit?: number;
  /** true = the bin itself (newest binned first) */
  deleted?: boolean;
  /** true = only assets filed in a hidden collection (the picker's Hidden tab) */
  hidden?: boolean;
  /** Only assets this account OWNS.
   *
   *  RLS already answers "may I see this", and for a shared project the answer
   *  is yes — correctly, those files are what was shared. What it cannot answer
   *  is "is this MINE", and the unscoped library asks exactly that: without
   *  this, opening your own library as a collaborator silently absorbs every
   *  file of every project anyone shared with you (measured: 877 of someone
   *  else's assets landing in a personal library that had none). A project's
   *  files belong in that project. */
  ownedOnly?: boolean;
} = {}): Promise<Asset[]> {
  // Resolved once, outside the builder: `build` runs per page and must not
  // re-await the session each time.
  const owner: OwnerScope = opts.ownedOnly ? await ownerScope() : { by: "all" };
  if (owner.by === "none") return [];
  const build = () => {
    let q = supabase.from("assets").select("*");
    if (owner.by === "uid") q = q.eq("owner_id", owner.uid);
    q = opts.deleted
      ? q.not("deleted_at", "is", null).order("deleted_at", { ascending: false })
      : q.is("deleted_at", null).order("created_at", { ascending: false });
    q = q.is("hidden", !!opts.hidden);
    if (opts.projectId !== undefined) {
      q = opts.projectId === null ? q.is("project_id", null) : q.eq("project_id", opts.projectId);
    }
    if (opts.kind) q = q.eq("kind", opts.kind);
    if (opts.tags?.length) q = q.contains("tags", opts.tags);
    if (opts.search) q = q.ilike("b2_key", `%${opts.search}%`);
    return q;
  };
  // Not `.limit()`: PostgREST caps a response at 1000 rows whatever the limit
  // says, so the grid's widening-LIMIT pager dead-ended there and reported the
  // list complete — on an account holding 3,031 assets. See ./paging.
  return pageThrough<Asset>(build, opts.limit ?? 200);
}

/** Kind histogram over the whole (unbinned, unhidden) registry, plus how many
 *  sit in the bin. The sidebar's counts must not come from the filtered grid —
 *  picking "Video" would then zero every other row — and they must not count
 *  what the grid won't show: a tally that includes hidden assets is itself a
 *  disclosure ("40 images" over a grid of 34). */
export async function loadAssetCounts(
  opts: { projectId?: string; ownedOnly?: boolean } = {},
): Promise<{ kinds: Map<string, number>; total: number; trashed: number }> {
  // Counted in Postgres, not here. This used to select a row per asset and
  // tally them client-side, which PostgREST cut off at 1000 with no error —
  // so every library over a thousand files reported exactly 1,000 (measured:
  // 3,031 for one owner, 1,257 in one project). See ./paging.
  //
  // The tallies have to carry the SAME scope as the grid, or the sidebar
  // advertises files the grid will not show — which after sharing is a count
  // of somebody else's project sitting above your own empty library.
  const owner: OwnerScope = opts.ownedOnly ? await ownerScope() : { by: "all" };
  if (owner.by === "none") return { kinds: new Map(), total: 0, trashed: 0 };
  const { data, error } = await supabase.rpc("asset_counts", {
    p_project: opts.projectId ?? null,
    p_owner: owner.by === "uid" ? owner.uid : null,
  });
  if (error) throw error;
  const kinds = new Map<string, number>();
  let total = 0, trashed = 0;
  for (const r of (data ?? []) as { kind: string; live: number; trashed: number }[]) {
    const live = Number(r.live) || 0;
    trashed += Number(r.trashed) || 0;
    if (!live) continue;          // a kind that only exists in the bin is not a facet
    total += live;
    kinds.set(r.kind, live);
  }
  return { kinds, total, trashed };
}

/** One media kind's footprint in a project. */
export interface StorageKind {
  kind: string;
  files: number;
  bytes: number;
  /** Files of this kind with no recorded size — see `unsized` below. */
  unsized: number;
}

export interface ProjectStorage {
  kinds: StorageKind[];          // biggest first, empty kinds dropped
  bytes: number;                 // live only
  files: number;                 // live only
  trashedBytes: number;
  trashedFiles: number;
  /** Live files whose `bytes` column is null, so `bytes` above is a FLOOR
   *  rather than a measurement. This is not rare: `bytes` is written when the
   *  file is registered and the pod's generated images, frames and audio
   *  routinely land without it (measured on the live database: 586 of one
   *  project's 594 images, and every one of its 185 frames). A total presented
   *  as exact would be wrong by more than it is right, so every surface that
   *  shows one has to show this beside it. */
  unsized: number;
}

/** What a project occupies, per media kind.
 *
 *  Aggregated in Postgres (`project_storage_stats`) — a `sum(bytes)` done in
 *  the browser is the 1000-row cap bug this database has been bitten by four
 *  times. The local plane answers the same RPC from its own store
 *  (lib/localRpc.ts), so a caller cannot tell which plane replied. */
export async function loadProjectStorage(projectId: string): Promise<ProjectStorage> {
  const { data, error } = await supabase.rpc("project_storage_stats", { p_project: projectId });
  if (error) throw error;
  const rows = (data ?? []) as {
    kind: string; live_n: number; live_bytes: number;
    trashed_n: number; trashed_bytes: number; unsized_n: number;
  }[];
  const out: ProjectStorage = {
    kinds: [], bytes: 0, files: 0, trashedBytes: 0, trashedFiles: 0, unsized: 0,
  };
  for (const r of rows) {
    const files = Number(r.live_n) || 0;
    const bytes = Number(r.live_bytes) || 0;
    const unsized = Number(r.unsized_n) || 0;
    out.trashedFiles += Number(r.trashed_n) || 0;
    out.trashedBytes += Number(r.trashed_bytes) || 0;
    if (!files) continue;        // a kind that exists only in the bin is not a row
    out.files += files;
    out.bytes += bytes;
    out.unsized += unsized;
    out.kinds.push({ kind: r.kind, files, bytes, unsized });
  }
  // Biggest first, and a tie broken by file count so the order is stable
  // rather than whatever the group-by happened to emit.
  out.kinds.sort((a, b) => b.bytes - a.bytes || b.files - a.files);
  return out;
}

export async function loadAssetsByIds(ids: string[]): Promise<Map<string, Asset>> {
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from("assets").select("*").in("id", ids);
  if (error) throw error;
  return new Map((data as Asset[]).map((a) => [a.id, a]));
}

/** What a generated picture was drawn FROM — its prompt and the references its
 *  job actually used. This is what "redraw it, but change this" needs, and it
 *  lives here because more than one surface asks the question and a second
 *  copy of the answer is a second answer.
 *
 *  Two things it gets right that reading the payload alone does not:
 *
 *  * **The prompt is `assets.meta.prompt`, not `payload.prompt`.** A panel
 *    carries a `prompt_spec` and `handle_image_gen` composes the real prompt
 *    worker-side (that is the whole point of composing it there — the family
 *    is only final at that moment), so the payload's prompt is absent or
 *    pre-composition. `meta.prompt` is the string ComfyUI was actually sent.
 *  * **`anchors` are late-bound and must be resolved the way the worker
 *    resolves them.** They are `{entry_id, roles}` pairs turned into assets at
 *    RUN time, so a job that used them carries no ref ids at all — a surface
 *    reading only `ref_asset_ids` reports that a panel used no references when
 *    it used four, and then offers to redraw it with none.
 */
export async function loadGenerationSource(assetId: string): Promise<{
  asset: Asset;
  job: Job | null;
  prompt: string | null;
  refs: Asset[];
  label: string | null;
} | null> {
  const { data: row } = await supabase.from("assets").select("*").eq("id", assetId).single();
  if (!row) return null;
  const asset = row as Asset;
  const { data: jobRow } = asset.source_job_id
    ? await supabase.from("jobs").select("*").eq("id", asset.source_job_id).maybeSingle()
    : { data: null };
  const job = (jobRow as Job | null) ?? null;
  const payload = (job?.payload ?? {}) as Record<string, unknown>;

  // Resolve anchors the way the WORKER resolves them, or the strip lies about
  // the render. Three ways the old lookup lied, each seen live: it sliced the
  // display to four anchors, so a five-anchor H3 panel showed its cast and
  // silently dropped the location plate — which read as "the master reference
  // is not being passed" when it was; `.in(roles)` + lowest slot ignores that
  // `roles` is a PREFERENCE order (`first: true` = first role that resolves);
  // and without `slot < 90` it could show an ARCHIVED sheet (the regen_sheets
  // convention every real consumer filters).
  const anchors = (payload.anchors as { entry_id?: string; roles?: string[] }[] | undefined) ?? [];
  const anchorIds: string[] = [];
  const resolveAnchor = async (entryId: string, roles: string[]): Promise<string | null> => {
    const { data: bas } = await supabase.from("bible_assets")
      .select("asset_id,role,slot").eq("entry_id", entryId)
      .in("role", roles).lt("slot", 90).order("slot");
    const rows = (bas ?? []) as { asset_id: string; role: string }[];
    const pick = roles.map((r) => rows.find((b) => b.role === r)).find(Boolean);
    return pick?.asset_id ?? null;
  };
  for (const an of anchors) {
    if (!an?.entry_id) continue;
    const roles = an.roles?.length ? an.roles : ["face"];
    let id = await resolveAnchor(an.entry_id, roles);
    if (!id) {
      // A sheetless variant stages its PARENT's sheet (the worker walks
      // doc.variant_of); the display has to follow or it shows a gap the
      // render doesn't have.
      const { data: entry } = await supabase.from("bible_entries")
        .select("doc").eq("id", an.entry_id).maybeSingle();
      const parent = (entry?.doc as { variant_of?: string } | null)?.variant_of;
      if (parent) id = await resolveAnchor(parent, roles);
    }
    if (id) anchorIds.push(id);
  }
  const refIds = [...new Set([
    ...(((payload.ref_assets as { asset_id?: string }[] | undefined) ?? [])
      .map((r) => r.asset_id).filter(Boolean) as string[]),
    ...((payload.ref_asset_ids as string[] | undefined) ?? []),
    ...anchorIds,
  ])].slice(0, 10);
  const { data: refs } = refIds.length
    ? await supabase.from("assets").select("*").in("id", refIds) : { data: [] };
  // `.in()` does not preserve the order asked for, and reference ORDER is
  // load-bearing — image1 carries the high token budget, which is why anchors
  // are sorted by who the shot names first. Restore the requested order.
  const byId = new Map(((refs ?? []) as Asset[]).map((r) => [r.id, r]));
  return {
    asset, job,
    prompt: (asset.meta?.prompt as string) ?? (payload.prompt as string) ?? null,
    refs: refIds.map((id) => byId.get(id)).filter(Boolean) as Asset[],
    label: (payload.label as string) ?? null,
  };
}

/** `from` names the PLANE, and only the desktop worker passes it.
 *
 *  Every screen leaves it alone and gets the open project's — which is the
 *  whole point of routing there. A background render cannot: it can be a cloud
 *  project's job finishing while a local project is on screen, and registering
 *  its output through the routed client would file the asset in the wrong
 *  project's registry with nothing to say so. See jobIO.ts. */
export async function registerAsset(a: {
  b2_key: string;
  kind: AssetKind;
  project_id?: string | null;
  content_type?: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  origin?: Asset["origin"];
  /** the job that produced it — what the pod's own register_asset records */
  source_job_id?: string;
  meta?: Record<string, unknown>;
  tags?: string[];
}, from: (t: string) => any = (t) => supabase.from(t)): Promise<Asset> {
  const { data, error } = await from("assets")
    .upsert({ origin: "uploaded", meta: {}, tags: [], ...a }, { onConflict: "b2_key" })
    .select()
    .single();
  if (error) throw error;
  return data as Asset;
}

/** Move to the recycle bin: the row and the B2 object both stay, the asset just
 *  leaves every browse surface. Reversible by `restoreAssets`. */
export async function trashAssets(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase
    .from("assets").update({ deleted_at: new Date().toISOString() }).in("id", ids);
  if (error) throw error;
}

export async function restoreAssets(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase.from("assets").update({ deleted_at: null }).in("id", ids);
  if (error) throw error;
}

/** DB-first delete; caller purges B2 afterwards with the returned keys. */
export async function deleteAssets(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase.from("assets").delete().in("id", ids).select("b2_key");
  if (error) throw error;
  return (data ?? []).map((r: { b2_key: string }) => r.b2_key);
}

/**
 * THE MEDIA'S OWN LENGTH, MEASURED IF THE REGISTRY DOES NOT KNOW IT.
 *
 * `duration_ms` arrives from the pod's `asset_ingest` job, so an upload made
 * while the pod is stopped carries null for as long as the box stays down — and
 * a null is not read as "unknown" downstream, it is read as whatever constant
 * that caller defaults to. On the timeline that constant is four seconds, which
 * is how a six-minute track lands as a four-second clip with nothing on screen
 * to say why.
 *
 * So the browser measures it instead (see mediaProbe.ts) and writes the answer
 * back, which fixes the row for every other surface at the same time. The write
 * is best-effort: a viewer on a shared project may not own the row, and failing
 * to record a number we already have is no reason to fail the edit that needed
 * it.
 *
 * Returns the asset unchanged when there is nothing to measure (a still) or the
 * source cannot be read — the caller's own fallback then applies, knowingly.
 */
export async function ensureAssetDuration(asset: Asset): Promise<Asset> {
  if (asset.duration_ms != null) return asset;
  if (!probeElementFor(asset)) return asset;
  const url = assetUrl(asset);
  if (!url) return asset;

  const meta = await probeMediaMeta(url, { element: probeElementFor(asset)! }).catch(() => null);
  if (!meta?.durationMs) return asset;

  const patch: Partial<Asset> = { duration_ms: meta.durationMs };
  if (asset.width == null && meta.width != null) patch.width = meta.width;
  if (asset.height == null && meta.height != null) patch.height = meta.height;
  // A refusal comes back in `error` and a dropped connection throws; neither is
  // worth failing the edit over, and the caller has the number either way.
  try { await supabase.from("assets").update(patch).eq("id", asset.id); } catch { /* not ours to write */ }
  return { ...asset, ...patch };
}

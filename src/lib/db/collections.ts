// Library collections: user-made groupings of registry rows, filled by dragging
// cards onto them. Membership only — an asset lives once, in `assets`
// (invariant #2), so filing it costs a row and moves no bytes, and the same
// asset can sit in as many collections as you like.
import { supabase } from "../supabase";
import { pageThrough } from "./paging";
import type { Asset, Collection } from "./types";

export async function loadCollections(_projectId?: string | null): Promise<Collection[]> {
  const { data, error } = await supabase.from("collections").select("*")
    .order("idx", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Collection[];
}

export async function createCollection(name: string, projectId?: string | null): Promise<Collection> {
  const { data, error } = await supabase
    .from("collections")
    .insert({ name: name.trim() || "Untitled", project_id: projectId ?? null })
    .select().single();
  if (error) throw error;
  return data as Collection;
}

export async function renameCollection(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("collections").update({ name: name.trim() || "Untitled" }).eq("id", id);
  if (error) throw error;
}

/** Incognito on/off. The `assets.hidden` flag on every member follows by
 *  trigger, so this one write is what takes them out of (or back into) the
 *  library, the pickers and the director's search. */
export async function setCollectionHidden(id: string, hidden: boolean): Promise<void> {
  const { error } = await supabase.from("collections").update({ hidden }).eq("id", id);
  if (error) throw error;
}

/** Drops the collection only. Its assets are untouched — unfiling is not
 *  deleting, and the membership rows cascade away on their own. Dropping a
 *  hidden collection un-hides what was in it (nothing else conceals it). */
export async function deleteCollection(id: string): Promise<void> {
  const { error } = await supabase.from("collections").delete().eq("id", id);
  if (error) throw error;
}

/** Idempotent: dropping the same card on the same collection twice is a no-op
 *  rather than a duplicate-key error. */
export async function addToCollection(collectionId: string, assetIds: string[]): Promise<void> {
  if (!assetIds.length) return;
  const { error } = await supabase.from("collection_assets").upsert(
    assetIds.map((asset_id) => ({ collection_id: collectionId, asset_id })),
    { onConflict: "collection_id,asset_id", ignoreDuplicates: true }
  );
  if (error) throw error;
}

export async function removeFromCollection(collectionId: string, assetIds: string[]): Promise<void> {
  if (!assetIds.length) return;
  const { error } = await supabase.from("collection_assets")
    .delete().eq("collection_id", collectionId).in("asset_id", assetIds);
  if (error) throw error;
}

/**
 * Members of one collection, newest first.
 *
 * A hidden collection is the one place its assets are visible, so it shows
 * them — and it shows its BINNED members too. Everywhere else the bin is where
 * you go to restore something, but the bin is a visible surface and a hidden
 * asset must not appear there; without this, binning a card from a hidden
 * collection would put it somewhere no view could reach.
 */
export async function loadCollectionAssets(
  collectionId: string,
  opts: { hidden?: boolean; limit?: number } = {}
): Promise<Asset[]> {
  // A fresh builder per page (see ./paging): `.limit()` is capped at 1000 by
  // PostgREST whatever it says, which dead-ends the grid's widening-LIMIT pager.
  const build = () => {
    let q = supabase
      .from("collection_assets")
      .select("added_at, assets!inner(*)")
      .eq("collection_id", collectionId)
      .is("assets.hidden", !!opts.hidden);
    if (!opts.hidden) q = q.is("assets.deleted_at", null);
    return q.order("added_at", { ascending: false });
  };
  const data = await pageThrough<{ assets: Asset | Asset[] }>(build, opts.limit ?? 300);
  // PostgREST types an embedded row as an array; at a to-one FK it is one row.
  return (data as { assets: Asset | Asset[] }[])
    .flatMap((r) => (Array.isArray(r.assets) ? r.assets : [r.assets]))
    .filter(Boolean);
}

/** Membership counts, cross-tabbed by the two flags that decide whether a
 *  member counts — at most four rows per collection.
 *
 *  Still UNRESOLVED, and still tallied by the caller, because what counts
 *  depends on the collection: a hidden one shows (and so counts) exactly what a
 *  visible one must not, and that rule belongs with the UI that states it. What
 *  changed is only where the counting happens — this used to fetch one row per
 *  membership and count them in the browser, which PostgREST silently cut off
 *  at 1000 (see ./paging). */
export async function loadCollectionCounts(): Promise<
  { collection_id: string; hidden: boolean; trashed: boolean; n: number }[]
> {
  const { data, error } = await supabase.rpc("collection_counts");
  if (error) throw error;
  return ((data ?? []) as { collection_id: string; hidden: boolean; trashed: boolean; n: number }[])
    .map((r) => ({ ...r, n: Number(r.n) || 0 }));
}

/** Which collections a given asset is filed under (asset detail chips). */
export async function collectionsForAsset(assetId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("collection_assets").select("collection_id").eq("asset_id", assetId);
  if (error) throw error;
  return ((data ?? []) as { collection_id: string }[]).map((r) => r.collection_id);
}

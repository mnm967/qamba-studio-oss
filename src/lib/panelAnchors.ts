// Resolving a panel's late-bound anchors in the browser, and finalising its
// spec against what actually resolved — twins of `_resolve_anchor` and
// `finalize_spec` in `worker/handlers/images.py`.
//
// A panel's references travel as `{entry_id, roles, first}` because the sheet
// they name may not have rendered yet when the panel is queued. The pod
// resolves them at render time; a job that is to leave the pod's lane has to
// resolve them at QUEUE time instead, because `runHostedImageJob` takes
// `ref_asset_ids` and nothing else. See panelPrompt.ts for why any of this is
// in TypeScript at all.
import { supabase } from "./supabase";

// The PURE half lives in panelPrompt.ts — this module reaches the database,
// so `node --test` cannot import it (the extensionless `./supabase`
// specifier its strip-only loader will not resolve), and `finalizeSpec` is
// exactly the part whose rules need testing. Same split as panelSpec/panels.
export { finalizeSpec, type FinalizeSpec } from "./panelPrompt.ts";

/** `bible_assets.slot >= 90` is a WITHDRAWAL, not a preference.
 *
 *  Slot ORDERING makes a replacement win the moment it lands and does nothing
 *  at all when the replacement does not exist yet — so a role whose only rows
 *  are archived still returns one. That is how a deformed turnaround went on
 *  being staged after it had been archived and re-rolled. Every read of
 *  `bible_assets` that feeds a render carries this filter. */
export const ARCHIVE_SLOT = 90;

import type { Anchor, Taken } from "./panelPrompt.ts";
export type { Anchor, Taken };

async function sheet(entryId: string, role?: string) {
  let q = supabase.from("bible_assets").select("asset_id,role")
    .eq("entry_id", entryId).lt("slot", ARCHIVE_SLOT)
    .order("slot").limit(1);
  if (role) q = q.eq("role", role);
  const { data } = await q;
  return (data ?? [])[0] as { asset_id: string; role: string | null } | undefined;
}

/**
 * Late-bound anchors → the asset ids to stage, in order, plus WHICH role each
 * one turned out to be.
 *
 * `taken` is not bookkeeping: `roles` is a PREFERENCE order, so a panel asking
 * a location for its reverse angle gets the master when no reverse angle is on
 * file — and the prompt describes what was staged. Composing from the request
 * rather than the result is how a prompt comes to name a picture the graph was
 * never handed.
 */
export async function resolveAnchors(
  anchors: Anchor[] | null | undefined,
): Promise<{ refIds: string[]; taken: Taken[] }> {
  const refIds: string[] = [];
  const taken: Taken[] = [];
  const add = (entry_id: string, role: string | null, assetId: string) => {
    if (!refIds.includes(assetId)) { refIds.push(assetId); taken.push({ entry_id, role }); }
  };
  for (const a of anchors ?? []) {
    const eid = a?.entry_id;
    if (!eid) continue;
    let found = false;
    // `first`: take the BEST available slot, not every listed one. The default
    // appends each role it finds — right for an outfit variant's edit (source
    // + conditioning), wrong for a panel, where a preference order like
    // turnaround > full_body > face stages three pictures of one person and
    // crowds everyone else out of the slot budget.
    const one = !!a.first;
    for (const role of a.roles?.length ? a.roles : ["face"]) {
      const row = await sheet(eid, role);
      if (row) { found = true; add(eid, role, row.asset_id); if (one) break; }
    }
    if (!found) {                    // any ref for the entry rather than none
      const row = await sheet(eid);
      if (row) { found = true; add(eid, row.role ?? null, row.asset_id); }
    }
    if (!found) {
      // A variant with no sheet of its own is anchored by its PARENT. A
      // variant's sheets are derived jobs (an identity edit of the parent's
      // body), so there is an honest window in which the entry exists and its
      // pictures do not; staging the parent keeps identity in the frame while
      // the wardrobe rides the prose. A DANGLING id — a discarded draft a
      // queued job still anchors — has no row to walk and resolves to nothing,
      // which is what `finalizeSpec`'s prune is for.
      const { data } = await supabase.from("bible_entries").select("doc").eq("id", eid).limit(1);
      const parent = ((data ?? [])[0] as { doc?: { variant_of?: string } } | undefined)
        ?.doc?.variant_of;
      if (parent) {
        for (const role of ["turnaround", "full_body", "outfit", "face"]) {
          const row = await sheet(parent, role);
          if (row) { add(eid, role, row.asset_id); break; }
        }
      }
    }
  }
  return { refIds, taken };
}

// One-shot localStorage re-key onto the current product prefix.
//
// The studio has been renamed twice — `neon.*` -> `yeuka.*` (2026-08-18) and
// `yeuka.*` -> `qamba.*` (2026-08-28) — and this file is the whole of what
// carries a browser across either hop. It exists because several of those keys
// hold something a user cannot get back by reloading: `<prefix>.auth` is the
// Supabase SESSION (renaming it bare signs everyone out) and
// `<prefix>.civitai.token` is a Civitai API token. The rest — wizard and chat
// drafts, project defaults, the workspace layout, the local-project owner id
// and sync marks, the first-run setup flag — are cheap individually and add up
// to "the app forgot everything I had done" on the one deploy that renames the
// product.
//
// A PREFIX sweep rather than a list of keys, because several of the families
// are dynamic: `<prefix>.draft.chat.<projectId>.<threadId>` and its three
// siblings are keyed per project and per thread, so there is no fixed name to
// enumerate and a list would silently miss every draft anyone had open.
//
// EVERY OLD PREFIX IS SWEPT, NOT JUST THE MOST RECENT ONE. A browser that last
// ran the studio before 2026-08-18 still holds `neon.*` and has never seen
// `yeuka.*`, so a chain that only handled the latest rename would sign exactly
// those users out — the failure the previous rename already paid to avoid.
// They are swept NEWEST FIRST and nothing overwrites a key that already
// exists, which gives the precedence the names imply: a value this build wrote
// beats one from the previous name, which beats one from the name before that.
//
// ORDERING IS THE WHOLE TRICK. `createClient` reads `storageKey` during module
// evaluation of `lib/supabase.js` — before any component mounts, before
// `main.tsx` runs a line of its own — so a migration invoked from application
// code has already lost the race and the session is gone. It is imported at the
// top of `lib/supabase.js` instead: ES modules evaluate dependencies first, so
// this file is guaranteed to have run before the client is constructed. Do not
// move that import, and do not make this module import anything of ours.
//
// Nothing here may throw. localStorage is absent in a non-DOM test runner and
// throws on access in a privacy-blocked or over-quota browser, and a rename
// must not be the reason the app fails to boot.

/** Every prefix this app has ever used, NEWEST FIRST — see above. */
const OLD = ["yeuka.", "neon."];
const NEW = "qamba.";

/** Marker key. Its presence means the sweep has run, so a later downgrade and
 *  re-upgrade cannot resurrect keys the user has since deleted. Bumped with
 *  each rename: the `v1` marker means "swept as far as yeuka.*", which is not
 *  the same claim as this one. */
const DONE = "qamba.migrated.v2";

/** The markers left by earlier runs. Carrying one forward under the new prefix
 *  would be meaningless clutter, and leaving it behind would make a future
 *  sweep look like it had already run. */
const STALE_MARKERS = ["neon.migrated.v1", "yeuka.migrated.v1", "qamba.migrated.v1"];

function migrate(): void {
  let ls: Storage;
  try {
    ls = window.localStorage;
    if (!ls) return;
    if (ls.getItem(DONE)) return;
  } catch {
    return; // no storage, or blocked — nothing to migrate and nothing to fix
  }

  // Snapshot the key list before writing: mutating localStorage while walking
  // it by index reshuffles the very indices being walked.
  const keys: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k) keys.push(k);
    }
  } catch {
    return;
  }

  let moved = 0;
  for (const oldPrefix of OLD) {
    for (const oldKey of keys) {
      if (!oldKey.startsWith(oldPrefix)) continue;
      if (STALE_MARKERS.includes(oldKey)) continue;
      const newKey = NEW + oldKey.slice(oldPrefix.length);
      try {
        const v = ls.getItem(oldKey);
        if (v === null) continue;
        // A value already under the new name wins: it was written either by
        // this build or by a newer prefix swept on an earlier pass of this
        // loop, so it is newer than anything left over from before.
        if (ls.getItem(newKey) === null) {
          ls.setItem(newKey, v);
          moved++;
        }
        ls.removeItem(oldKey);
      } catch {
        // Per-key, so one unreadable or over-quota entry cannot strand the
        // rest. Leaving the old key in place is the safe failure: it is still
        // readable by hand, and the marker below stops us retrying forever.
      }
    }
  }

  for (const k of STALE_MARKERS) {
    try { ls.removeItem(k); } catch { /* nothing depends on it going */ }
  }

  try {
    ls.setItem(DONE, String(moved));
  } catch { /* the sweep is idempotent, so a lost marker only costs a re-run */ }
}

migrate();

export {};

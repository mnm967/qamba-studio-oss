// Which project the app is inside, and how the two planes' project lists
// become one list.
//
// Pure, and separate from localPlane.ts for the reason `panelSpec.ts` is
// separate from `panels.ts`: that module reaches the database and the file
// system, so it cannot be imported by `node --test`. These two decisions are
// exactly the ones worth pinning — the first is consulted by every query in
// the app, and the second decides what a person sees on the only screen that
// can open a project at all.
import type { Row } from "./localStore.ts";

/**
 * The project id in a URL path, or null.
 *
 * THE URL IS THE PLANE SELECTOR. Every project-scoped route in this app is
 * `/project/:pid/…`, so the open project is readable at the moment a query
 * runs — before any effect has fired, after a reload, and after a back button.
 * The alternative (a mode set on navigation) has to be correct before every
 * descendant's first fetch and cleared on every exit, and the failure when it
 * is not is silent: the query goes to the other plane and comes back empty.
 *
 * Deliberately strict about the shape. `/projects` must not match `/project/`,
 * and only a uuid-shaped segment counts — a local store is keyed by id, so a
 * near-miss simply finds nothing, but matching loosely here would mean asking
 * that question far more often than it needs to be asked.
 */
export function projectIdFromPath(pathname: string): string | null {
  const m = /\/project\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:$|[/?#])/
    .exec(pathname);
  return m ? m[1] : null;
}

/**
 * The projects list, from both planes.
 *
 * DEDUPED BY ID, LOCAL FIRST. A project pushed to the cloud as a BACKUP exists
 * on both planes under one id; showing it twice would be two cards for one
 * project and, in React, two children with the same key. Local wins because
 * that is the copy the app reads and writes — the backup becomes visible on
 * the one occasion it matters, which is after the local copy is gone.
 */
export function mergeProjects<T extends Row>(local: T[], cloud: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of [...local, ...cloud]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.sort((a, b) =>
    String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

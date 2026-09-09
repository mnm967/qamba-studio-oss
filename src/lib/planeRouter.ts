// The one seam between the Supabase client and a local project.
//
// It exists so that `lib/supabase.js` — the module every query in this app
// goes through — depends on nothing but this file. Four tiny functions with a
// null default: with no project open, `planeFrom` returns null and the client
// falls through to the studio plane, which answers the build's own tables and
// a read-only union of every project on this machine.
//
// The plane installs itself at boot (see localPlane.ts), and only on the
// desktop build: a browser tab can never load a project from disk, so
// `installPlane` is never called there and this module costs it a few bytes.

export interface PlaneHooks {
  /** A query builder for `table`, or null to leave it to the studio plane.
   *  Returns null for a table a project does not contain — the model
   *  catalogue, this machine's render timings — which the STUDIO plane
   *  answers instead, because they are facts about the build rather than
   *  about any one project. */
  from(table: string): any | null;
  /** A URL the page can load for a key held on this machine, or null when
   *  nothing here holds it. */
  mediaUrl(key: string): string | null;
  /** Who owns local rows, when a project is open. Null otherwise. */
  ownerId(): string | null;
  /** A stored procedure the open project implements itself, or null to leave
   *  it to the studio plane. Only the ones that MEAN something for one
   *  project are implemented here. */
  rpc(name: string, args: Record<string, unknown> | undefined): any | null;
}

let hooks: PlaneHooks | null = null;

export function installPlane(h: PlaneHooks | null): void {
  hooks = h;
}

export function planeFrom(table: string): any | null {
  return hooks ? hooks.from(table) : null;
}

export function planeRpc(name: string, args?: Record<string, unknown>): any | null {
  return hooks ? hooks.rpc(name, args) : null;
}

export function planeMediaUrl(key: string): string | null {
  return hooks ? hooks.mediaUrl(key) : null;
}

export function planeOwnerId(): string | null {
  return hooks ? hooks.ownerId() : null;
}

/** True when a project is open and its rows are on this machine. */
export function planeIsLocal(): boolean {
  return planeOwnerId() !== null;
}

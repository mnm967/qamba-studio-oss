// Which plane answers a PostgREST path, for a project on this machine.
//
// TWO CALLERS, ONE DECISION. `localDbBridge` answers the loopback proxy for
// the pipeline's Python; `localDirector` answers the director's own forty
// tools, which speak the same PostgREST paths for the same reason. Both need
// the same split and the split is not obvious — so it is made once here
// rather than written out twice and drifting.
//
// THE SPLIT IS PER TABLE, exactly as `planeRouter` makes it for the app. A
// project's own tables come from its store; `model_catalog_visible` and
// `job_timings` are this BUILD's rather than a project's, and the studio
// plane answers them. A pipeline handed an empty model catalogue would quietly
// re-render on the defaults, which is the class of failure this codebase keeps
// naming.
//
// RPCs GO TO THE PROJECT FIRST. A stored procedure's NAME is not a table name,
// so a table-set lookup answers "studio" for every one of them; `localRpc`
// returns null for one the project plane does not implement, and those fall
// through to the studio plane.

import { localFrom } from "./localQuery.ts";
import { localRpc } from "./localRpc.ts";
import { LOCAL_TABLE_SET } from "./localSchema.ts";
import type { PlaneFor, RestPlane } from "./localRest.ts";
import { studioFrom, studioRpc } from "./studioPlane.ts";
import type { LocalStore } from "./localStore.ts";

/** The studio plane, for the tables that are the build's rather than a project's. */
export const STUDIO_PLANE: RestPlane = {
  from: (t: string) => studioFrom(t),
  rpc: (n: string, a: Record<string, unknown>) => studioRpc(n, a),
};

/** The project/studio pair for one open project's store. */
export function planesFor(store: LocalStore): PlaneFor {
  const local: RestPlane = {
    from: (t: string) => localFrom(store, t),
    rpc: (n: string, a: Record<string, unknown>) => localRpc(store, n, a) ?? STUDIO_PLANE.rpc(n, a),
  };
  return (table, isRpc) => (isRpc || LOCAL_TABLE_SET.has(table) ? local : STUDIO_PLANE);
}

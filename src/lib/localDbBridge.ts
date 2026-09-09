// The webview end of the loopback PostgREST proxy.
//
// `dbproxy.rs` listens on 127.0.0.1 so the studio's pipeline Python can reach
// a LOCAL project — whose rows are a file this process owns and writes on a
// throttle, and which therefore cannot be served from Rust without becoming a
// second writer on that file. Every request lands here as one event, is
// answered by `localRest` out of the open store, and goes back through the
// `local_db_reply` command.
//
// THE PLANE IS CHOSEN PER TABLE, exactly as `planeRouter` does for the app
// itself. A local project's own tables come from its store; `model_catalog`,
// `pod_status` and `job_timings` are the STUDIO's and are not part of any
// project, so they come from Supabase — a plan answered an empty catalog would
// silently fall back to the default model, which is the class of failure this
// codebase keeps naming.
//
// IT MUST NEVER THROW INTO THE LISTENER. A rejected handler leaves the Rust
// side waiting out its 30s timeout for every remaining query of a job that has
// already gone wrong; the failure has to come back as a status.
import { invoke, isDesktop, listen } from "./desktop.ts";
import { localStoreFor } from "./localPlane.ts";
import { planesFor } from "./localPlanes.ts";
import { localRest, type RestRequest } from "./localRest.ts";
import { invalidateTables } from "../hooks/useLiveQuery";

interface Incoming extends RestRequest {
  id: number;
  project: string;
}

let started = false;

/**
 * Start answering. Idempotent, and a no-op off the desktop — the web build has
 * no local projects and no loopback listener to answer.
 */
export async function startLocalDbBridge(): Promise<void> {
  if (started || !isDesktop()) return;
  started = true;
  await listen<Incoming>("localdb://request", (req) => { void answer(req); });
}

async function answer(req: Incoming): Promise<void> {
  let status = 500;
  let body = JSON.stringify({ message: "the app could not answer", code: "PGRST100" });
  try {
    const store = localStoreFor(req.project);
    if (!store) {
      status = 404;
      body = JSON.stringify({
        message: `project ${req.project} is not open on this machine`,
        code: "PGRST100",
      });
    } else {
      // The split, and the reasons for it, are `localPlanes.ts` — shared with
      // the director, which speaks the same paths against the same store.
      const res = await localRest(planesFor(store), req);
      status = res.status;
      body = res.body;
      // The local plane has no realtime, so a write from the pipeline is
      // invisible until something asks again. This is the same nudge
      // `localPlane`'s own `onChange` gives — needed here as well because the
      // JOBS table is what every queue surface watches, and a plan writes to
      // it constantly.
      if (req.method !== "GET" && status < 400) {
        const table = req.path.replace(/^\/*(rest\/v1\/)?/, "").split("?")[0];
        if (table && !table.startsWith("rpc/")) invalidateTables([table]);
      }
    }
  } catch (e) {
    body = JSON.stringify({
      message: e instanceof Error ? e.message : String(e),
      code: "PGRST100",
    });
  }
  // Best effort: the request may already have timed out, in which case Rust
  // has answered 504 and dropped the slot. Failing here would be a second
  // error about the first one.
  try {
    await invoke("local_db_reply", { id: req.id, status, body });
  } catch (e) {
    console.warn("[localdb] could not deliver a reply", e);
  }
}

/** Test seam — the bridge is a module singleton, like the worker's loop. */
export function __resetLocalDbBridge(): void {
  started = false;
}

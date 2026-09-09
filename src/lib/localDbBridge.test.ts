// The bridge is glue, and every rule in it fails SILENTLY.
//
// It cannot be imported under `node --test` — it reaches `lib/supabase`, whose
// extensionless specifier the strip-only loader cannot resolve — so it is
// checked the way `scoreTrack` and `audioGraph` are: by parsing its own
// source. The translation it delegates to (`localRest`) is tested for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/lib/localDbBridge.ts", "utf8").replace(/\r\n/g, "\n");
// The split itself lives in `localPlanes.ts` — the bridge and the director
// both answer PostgREST paths against the same store, so the decision is made
// once. These two rules travelled with it.
const PLANES = readFileSync("src/lib/localPlanes.ts", "utf8").replace(/\r\n/g, "\n");

test("a stored procedure is offered to the project's plane first", () => {
  // An rpc NAME is not a table name, so a bare `LOCAL_TABLE_SET.has(...)`
  // answers no for every one of them and `request_job_cancel` would go to the
  // studio plane, which has never heard of this project. `localRpc` returning
  // null is what sends the procedures the project plane does not implement on
  // to the studio one.
  assert.match(PLANES, /isRpc \|\| LOCAL_TABLE_SET\.has\(table\)/);
  assert.match(PLANES, /localRpc\(store, n, a\) \?\? STUDIO_PLANE\.rpc\(n, a\)/);
  // And the bridge still uses that pair rather than rebuilding one.
  assert.match(SRC, /planesFor\(store\)/);
});

test("the studio plane is the BUILD's tables, not the routed client", () => {
  // `supabase.from` follows the OPEN project. A job for one project asking for
  // the model catalogue while that project is on screen would be answered out
  // of its own store — an empty catalogue, and a plan that quietly falls back
  // to the default model.
  const plane = PLANES.slice(PLANES.indexOf("export const STUDIO_PLANE"),
                             PLANES.indexOf("export function planesFor"));
  assert.match(plane, /studioFrom\(t\)/);
  assert.ok(!/[^d]\bsupabase\.from\b/.test(plane), "must not use the routed client");
});

test("it never throws into the listener", () => {
  // A rejected handler leaves the Rust side waiting out its 30s timeout for
  // every remaining query of a job that has already gone wrong — thirty
  // seconds per read, on a plan that makes hundreds.
  const fn = SRC.slice(SRC.indexOf("async function answer"));
  assert.match(fn, /try \{/, "the whole body is guarded");
  assert.match(fn, /catch \(e\)/);
  // ...and the reply is still delivered on that path: `status`/`body` are
  // seeded before the try and sent after it, outside any branch.
  assert.ok(fn.indexOf("let status = 500") < fn.indexOf("try {"),
    "the failure status must be the default, not something a branch sets");
  assert.ok(fn.lastIndexOf('invoke("local_db_reply"') > fn.indexOf("catch (e)"),
    "the reply is sent after the catch, so a failure still answers");
});

test("a write nudges the tables it touched", () => {
  // The local plane has no realtime. Without this a plan writes hundreds of
  // rows and every live surface — the queue above all — shows none of them
  // until something else happens to refetch.
  assert.match(SRC, /invalidateTables\(\[table\]\)/);
  assert.match(SRC, /req\.method !== "GET"/);
});

test("it is a no-op off the desktop and starts once", () => {
  assert.match(SRC, /if \(started \|\| !isDesktop\(\)\) return;/);
});

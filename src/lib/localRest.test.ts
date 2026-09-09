// The wire the studio's Python speaks, answered by the store.
//
// Every request here is one `worker/sb.py` actually builds — the whole point
// of the proxy is that `sb.py` is unchanged, so a case invented rather than
// copied proves nothing. Counted across `worker/**.py`: 559 `eq.`, 57 `in.`,
// 17 `lt.`, 14 `ilike.`, 10 `not.is.`, 8 `cs.`, 7 `gt.`, 4 `is.`, 2 `not.in.`,
// 2 `neq.`, 1 `like.`, plus `order`, `limit`, `select`, `or=` and the three
// `Prefer` shapes.
import assert from "node:assert/strict";
import test from "node:test";
import { LocalStore } from "./localStore.ts";
import { localFrom } from "./localQuery.ts";
import { localRpc } from "./localRpc.ts";
import { localRest, parsePath, type RestPlane } from "./localRest.ts";

const OWNER = "owner-1";
const PROJECT = "11111111-1111-4111-8111-111111111111";

function fixture(): { store: LocalStore; planeFor: () => RestPlane } {
  const store = new LocalStore(PROJECT, OWNER);
  store.insert("projects", [{ id: PROJECT, title: "Local one", medium: "film" }]);
  const plane: RestPlane = {
    from: (t: string) => localFrom(store, t),
    rpc: (n: string, a: Record<string, unknown>) => localRpc(store, n, a),
  };
  return { store, planeFor: () => plane };
}

const GET = (path: string) => ({ method: "GET", path, body: null, prefer: null });

test("a path is read the way sb.py builds it", () => {
  const p = parsePath("/rest/v1/scenes?select=*&storyboard_id=eq.abc&order=idx");
  assert.equal(p.table, "scenes");
  assert.equal(p.isRpc, false);
  assert.deepEqual(p.params, [["select", "*"], ["storyboard_id", "eq.abc"], ["order", "idx"]]);
  assert.equal(parsePath("/rest/v1/rpc/claim_next_job").table, "claim_next_job");
  assert.equal(parsePath("/rest/v1/rpc/claim_next_job").isRpc, true);
});

test("select, filter and order — the shape of nearly every read", async () => {
  const { store, planeFor } = fixture();
  const sb = store.insert("storyboards", [{ project_id: PROJECT, version: 1 }])[0];
  for (const idx of [2, 0, 1]) {
    store.insert("scenes", [{ storyboard_id: sb.id, idx, slug: `S${idx}` }]);
  }
  const r = await localRest(planeFor,
    GET(`/rest/v1/scenes?select=slug,idx&storyboard_id=eq.${sb.id}&order=idx`));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).map((s: any) => s.slug), ["S0", "S1", "S2"]);
});

test("order=created_at.desc and limit=1 — the 'newest one' read", async () => {
  const { store, planeFor } = fixture();
  const sb = store.insert("storyboards", [{ project_id: PROJECT, version: 1 }])[0];
  store.insert("beats", [{ scene_id: null, idx: 0, created_at: "2020-01-01" }]);
  store.insert("beats", [{ scene_id: null, idx: 1, created_at: "2026-01-01" }]);
  const r = await localRest(planeFor, GET("/rest/v1/beats?order=created_at.desc&limit=1"));
  const rows = JSON.parse(r.body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].idx, 1);
  assert.ok(sb.id);
});

test("`not.is.null` is a NEGATED is, not an operator called not", async () => {
  // `assets?deleted_at=not.is.null` is the recycle bin. Read as an operator
  // named `not`, the clause is dropped and the answer is the whole library.
  const { store, planeFor } = fixture();
  store.insert("assets", [{ b2_key: "a", kind: "image", project_id: PROJECT }]);
  store.insert("assets", [{ b2_key: "b", kind: "image", project_id: PROJECT,
                            deleted_at: "2026-01-01" }]);
  const binned = await localRest(planeFor, GET("/rest/v1/assets?deleted_at=not.is.null"));
  assert.deepEqual(JSON.parse(binned.body).map((a: any) => a.b2_key), ["b"]);
  const live = await localRest(planeFor, GET("/rest/v1/assets?deleted_at=is.null"));
  assert.deepEqual(JSON.parse(live.body).map((a: any) => a.b2_key), ["a"]);
});

test("in.() and cs.{} carry lists, and not.in.() negates one", async () => {
  const { store, planeFor } = fixture();
  const ids = ["aaa", "bbb", "ccc"].map((slug) =>
    store.insert("scenes", [{ storyboard_id: null, idx: 0, slug }])[0].id);
  const some = await localRest(planeFor,
    GET(`/rest/v1/scenes?id=in.(${ids[0]},${ids[2]})&order=slug`));
  assert.deepEqual(JSON.parse(some.body).map((s: any) => s.slug), ["aaa", "ccc"]);
  const rest = await localRest(planeFor, GET(`/rest/v1/scenes?id=not.in.(${ids[0]})&order=slug`));
  assert.deepEqual(JSON.parse(rest.body).map((s: any) => s.slug), ["bbb", "ccc"]);

  // `jobs?depends_on=cs.{<id>}` is how `fail_dependents` walks the DAG — and
  // it is the one that must not silently match nothing, or a dead dependency
  // deadlocks every job behind it.
  store.insert("jobs", [{ kind: "master_pass", status: "queued", depends_on: ["j1", "j2"] }]);
  store.insert("jobs", [{ kind: "master_pass", status: "queued", depends_on: ["j9"] }]);
  const deps = await localRest(planeFor,
    GET("/rest/v1/jobs?status=eq.queued&depends_on=cs.{j1}&select=id"));
  assert.equal(JSON.parse(deps.body).length, 1);
});

test("ilike's wildcard is `*` on the wire and `%` in the store", async () => {
  const { store, planeFor } = fixture();
  store.insert("bible_entries", [{ project_id: PROJECT, kind: "character", name: "Mara Vale" }]);
  store.insert("bible_entries", [{ project_id: PROJECT, kind: "character", name: "Tam Reed" }]);
  const r = await localRest(planeFor, GET("/rest/v1/bible_entries?name=ilike.*vale*"));
  assert.deepEqual(JSON.parse(r.body).map((b: any) => b.name), ["Mara Vale"]);
});

test("or=(a.eq.x,a.is.null) — the project-or-global lore read", async () => {
  const { store, planeFor } = fixture();
  store.insert("rag_documents", [{ project_id: PROJECT, title: "mine" }]);
  store.insert("rag_documents", [{ project_id: null, title: "shipped" }]);
  store.insert("rag_documents", [{ project_id: "other", title: "someone else's" }]);
  const r = await localRest(planeFor,
    GET(`/rest/v1/rag_documents?or=(project_id.eq.${PROJECT},project_id.is.null)&order=title`));
  assert.deepEqual(JSON.parse(r.body).map((d: any) => d.title), ["mine", "shipped"]);
});

test("insert returns the row only when Prefer asks for it", async () => {
  const { planeFor } = fixture();
  const bare = await localRest(planeFor, {
    method: "POST", path: "/rest/v1/collections",
    body: JSON.stringify({ name: "Refs", project_id: PROJECT }), prefer: null,
  });
  assert.equal(bare.status, 204, "PostgREST returns no content without return=representation");

  const withRow = await localRest(planeFor, {
    method: "POST", path: "/rest/v1/collections",
    body: JSON.stringify({ name: "Plates", project_id: PROJECT }),
    prefer: "return=representation",
  });
  assert.equal(withRow.status, 201);
  const rows = JSON.parse(withRow.body);
  assert.equal(rows[0].name, "Plates");
  assert.match(rows[0].id, /^[0-9a-f-]{36}$/, "the store fills the defaults Postgres would");
});

test("an upsert is told apart from an insert by resolution=merge-duplicates", async () => {
  // `sb.register_asset` upserts on `b2_key` and is called twice for the same
  // object all over the pipeline. Read as a plain insert it duplicates the
  // row; read as an upsert with the wrong conflict target it overwrites one
  // nobody asked to touch.
  const { planeFor } = fixture();
  const body = JSON.stringify({ b2_key: "audio/lines/x.mp3", kind: "audio", project_id: PROJECT });
  const first = await localRest(planeFor, {
    method: "POST", path: "/rest/v1/assets?on_conflict=b2_key", body,
    prefer: "return=representation,resolution=merge-duplicates",
  });
  const again = await localRest(planeFor, {
    method: "POST", path: "/rest/v1/assets?on_conflict=b2_key",
    body: JSON.stringify({ b2_key: "audio/lines/x.mp3", kind: "audio",
                           project_id: PROJECT, duration_ms: 1234 }),
    prefer: "return=representation,resolution=merge-duplicates",
  });
  assert.equal(JSON.parse(first.body)[0].id, JSON.parse(again.body)[0].id, "one row, updated");
  assert.equal(JSON.parse(again.body)[0].duration_ms, 1234);

  const all = await localRest(planeFor, GET("/rest/v1/assets?select=id"));
  assert.equal(JSON.parse(all.body).length, 1);
});

test("patch and delete carry their filters", async () => {
  const { store, planeFor } = fixture();
  const j = store.insert("jobs", [{ kind: "tts", status: "queued" }])[0];
  const patched = await localRest(planeFor, {
    method: "PATCH", path: `/rest/v1/jobs?id=eq.${j.id}`,
    body: JSON.stringify({ status: "done", progress: 1 }), prefer: null,
  });
  assert.equal(patched.status, 204);
  assert.equal(store.find("jobs", j.id)!.status, "done");

  const gone = await localRest(planeFor, {
    method: "DELETE", path: `/rest/v1/jobs?id=eq.${j.id}`, body: null, prefer: null,
  });
  assert.equal(gone.status, 204);
  assert.ok(!store.find("jobs", j.id));
});

test("a stored procedure goes through the plane's own rpc", async () => {
  const { store, planeFor } = fixture();
  const j = store.insert("jobs", [{ kind: "tts", status: "queued" }])[0];
  const r = await localRest(planeFor, {
    method: "POST", path: "/rest/v1/rpc/request_job_cancel",
    body: JSON.stringify({ p_job: j.id }), prefer: null,
  });
  assert.equal(r.status, 200);
  assert.equal(store.find("jobs", j.id)!.status, "canceled");
});

test("an unsupported operator is REFUSED by name, never ignored", async () => {
  // The whole hazard of a shim: a dropped clause returns more rows than were
  // asked for and nothing in the answer says so.
  const { planeFor } = fixture();
  const r = await localRest(planeFor, GET("/rest/v1/assets?bytes=fts.something"));
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).message, /unsupported filter operator "fts"/);
});

test("a stored procedure is told apart from a table, or it is routed by a name that is not one", async () => {
  // `request_job_cancel` is not in LOCAL_TABLE_SET and never will be — it is a
  // procedure, not a table — so a table-set lookup answers "cloud" and the
  // cancel goes to Supabase for a project Supabase has never heard of.
  const { store } = fixture();
  const j = store.insert("jobs", [{ kind: "tts", status: "queued" }])[0];
  const seen: string[] = [];
  const local: RestPlane = {
    from: (t) => localFrom(store, t),
    rpc: (n, a) => { seen.push(n); return localRpc(store, n, a); },
  };
  const cloud: RestPlane = {
    from: () => { throw new Error("must not reach the cloud"); },
    rpc: () => { throw new Error("must not reach the cloud"); },
  };
  await localRest((t, isRpc) => (isRpc || t === "jobs" ? local : cloud), {
    method: "POST", path: "/rest/v1/rpc/request_job_cancel",
    body: JSON.stringify({ p_job: j.id }), prefer: null,
  });
  assert.deepEqual(seen, ["request_job_cancel"]);
  assert.equal(store.find("jobs", j.id)!.status, "canceled");
});

test("the plane is chosen PER TABLE, so the studio's catalog is still the studio's", async () => {
  // `model_catalog` is not part of a project — a local project reads it from
  // Supabase exactly as a cloud one does. Answering it from the local store
  // would hand the planner an EMPTY catalog and it would quietly plan on the
  // defaults.
  const { store } = fixture();
  const asked: string[] = [];
  const local: RestPlane = {
    from: (t) => { asked.push(`local:${t}`); return localFrom(store, t); },
    rpc: (n, a) => localRpc(store, n, a),
  };
  const cloud: RestPlane = {
    from: (t) => {
      asked.push(`cloud:${t}`);
      return { select: () => Promise.resolve({ data: [{ id: "krea2" }], error: null }) };
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  const planeFor = (t: string) => (t === "model_catalog" ? cloud : local);

  await localRest(planeFor, GET("/rest/v1/model_catalog?select=*"));
  await localRest(planeFor, GET("/rest/v1/scenes?select=id"));
  assert.deepEqual(asked, ["cloud:model_catalog", "local:scenes"]);
});

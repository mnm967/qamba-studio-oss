// What the local plane has to answer the way PostgREST would.
//
// Every case here is a query this app actually writes, taken from the module
// that writes it — because the failure mode of a shim is never "it threw", it
// is "it returned MORE rows than the caller asked for and nothing said so".
// The bin query without its `deleted_at` clause is the whole library; a
// collection count without `!inner` counts memberships whose asset is gone.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { LocalStore } from "./localStore.ts";
import { localFrom, parseSelect } from "./localQuery.ts";

const OWNER = "owner-1";
const PROJECT = "11111111-1111-4111-8111-111111111111";

function storeWithProject(): LocalStore {
  const s = new LocalStore(PROJECT, OWNER);
  s.insert("projects", [{ id: PROJECT, title: "Local one", medium: "film" }]);
  return s;
}

const from = (s: LocalStore, t: string) => localFrom(s, t);

test("insert fills the defaults Postgres would have filled", async () => {
  const s = storeWithProject();
  const { data, error } = await from(s, "generation_blocks")
    .insert({ storyboard_id: null, idx: 0 }).select().single();
  assert.equal(error, null);
  assert.equal(data.status, "planned", "the block status default");
  assert.equal(data.mode, "r2v");
  assert.deepEqual(data.params, {});
  assert.deepEqual(data.beat_ids, []);
  assert.match(data.id, /^[0-9a-f-]{36}$/);
  assert.ok(data.updated_at, "moddatetime column seeded on insert");
});

test("two rows do not share one default object", async () => {
  const s = storeWithProject();
  const { data } = await from(s, "beats").insert([{ scene_id: null }, { scene_id: null }]).select();
  data[0].meta.x = 1;
  const again = await from(s, "beats").select("id,meta");
  const metas = again.data.map((r: any) => r.meta);
  assert.deepEqual(metas.filter((m: any) => m.x !== undefined).length, 0,
    "a mutated result must not reach back into the store, and defaults must not be shared");
});

test("a mutation returns nothing unless it asked to select", async () => {
  const s = storeWithProject();
  const bare = await from(s, "collections").insert({ name: "Refs", project_id: PROJECT });
  assert.equal(bare.data, null);
  assert.equal(bare.error, null);
  const withSel = await from(s, "collections").insert({ name: "B", project_id: PROJECT }).select().single();
  assert.equal(withSel.data.name, "B");
});

test("project_id is derived up the ownership chain, not passed", async () => {
  const s = storeWithProject();
  const ep = (await from(s, "episodes")
    .insert({ project_id: PROJECT, code: "MAIN", idx: 0 }).select().single()).data;
  const sb = (await from(s, "storyboards").insert({ episode_id: ep.id }).select().single()).data;
  const sc = (await from(s, "scenes").insert({ storyboard_id: sb.id, idx: 0 }).select().single()).data;
  const beat = (await from(s, "beats").insert({ scene_id: sc.id, idx: 0 }).select().single()).data;
  assert.equal(sb.project_id, PROJECT);
  assert.equal(sc.project_id, PROJECT);
  assert.equal(beat.project_id, PROJECT, "four levels down and still scoped");
  assert.equal(beat.owner_id, OWNER);
});

test("eq / in / is / not / order / limit behave like the wire", async () => {
  const s = storeWithProject();
  await from(s, "assets").insert([
    { b2_key: "a.png", kind: "image", project_id: PROJECT, created_at: "2026-01-01T00:00:00Z" },
    { b2_key: "b.mp4", kind: "video", project_id: PROJECT, created_at: "2026-01-03T00:00:00Z" },
    { b2_key: "c.png", kind: "image", project_id: PROJECT, created_at: "2026-01-02T00:00:00Z", deleted_at: "2026-02-01T00:00:00Z" },
  ]);

  const live = await from(s, "assets").select("*")
    .is("deleted_at", null).is("hidden", false)
    .eq("project_id", PROJECT)
    .order("created_at", { ascending: false }).limit(200);
  assert.deepEqual(live.data.map((r: any) => r.b2_key), ["b.mp4", "a.png"],
    "the library query: newest first, bin excluded, hidden excluded");

  const bin = await from(s, "assets").select("*")
    .not("deleted_at", "is", null).order("deleted_at", { ascending: false });
  assert.deepEqual(bin.data.map((r: any) => r.b2_key), ["c.png"]);

  const byKind = await from(s, "assets").select("*").eq("kind", "image").is("deleted_at", null);
  assert.deepEqual(byKind.data.map((r: any) => r.b2_key), ["a.png"]);

  const byIds = await from(s, "assets").select("*").in("kind", ["video", "audio"]);
  assert.equal(byIds.data.length, 1);
});

test("`is(col, false)` matches a row written before the column existed", async () => {
  // `hidden` was added by a later migration with `not null default false`, so
  // Postgres backfilled it. A local row loaded from an older file has no such
  // key — and if the filter missed it, every asset would vanish from the grid.
  const s = storeWithProject();
  s.rows("assets").push({ id: "raw-1", b2_key: "old.png", kind: "image", project_id: PROJECT });
  const { data } = await from(s, "assets").select("*").is("hidden", false);
  assert.deepEqual(data.map((r: any) => r.b2_key), ["old.png"]);
});

test("ilike is a pattern, not a substring", async () => {
  const s = storeWithProject();
  await from(s, "assets").insert([
    { b2_key: "images/rei-face.png", kind: "image" },
    { b2_key: "video/clip.mp4", kind: "video" },
  ]);
  const { data } = await from(s, "assets").select("b2_key").ilike("b2_key", "%REI%");
  assert.deepEqual(data.map((r: any) => r.b2_key), ["images/rei-face.png"]);
});

test("contains and overlaps read array columns", async () => {
  const s = storeWithProject();
  await from(s, "scenes").insert([
    { idx: 0, slug: "A", cast_ids: ["e1", "e2"] },
    { idx: 1, slug: "B", cast_ids: ["e3"] },
  ]);
  const c = await from(s, "scenes").select("slug").contains("cast_ids", ["e1"]);
  assert.deepEqual(c.data.map((r: any) => r.slug), ["A"]);

  await from(s, "generation_blocks").insert([
    { idx: 0, scene_ids: ["s1", "s2"] }, { idx: 1, scene_ids: ["s9"] },
  ]);
  const o = await from(s, "generation_blocks").select("idx").overlaps("scene_ids", ["s2", "s7"]);
  assert.deepEqual(o.data.map((r: any) => r.idx), [0]);
});

test("or() parses PostgREST's grammar, including a json path", async () => {
  const s = storeWithProject();
  await from(s, "custom_workflows").insert([
    { name: "mine", project_id: PROJECT }, { name: "global", project_id: null },
    { name: "other", project_id: "22222222-2222-4222-8222-222222222222" },
  ]);
  const { data } = await from(s, "custom_workflows").select("name")
    .or(`project_id.eq.${PROJECT},project_id.is.null`);
  assert.deepEqual(data.map((r: any) => r.name).sort(), ["global", "mine"]);

  await from(s, "jobs").insert([
    { kind: "clip_gen", payload: { block_id: "b1" } },
    { kind: "clip_gen", payload: { clip_id: "c1" } },
    { kind: "image_gen", payload: { asset_id: "zz" } },
  ]);
  const j = await from(s, "jobs").select("kind")
    .or("payload->>block_id.eq.b1,payload->>clip_id.eq.c1");
  assert.equal(j.data.length, 2);
});

test("single() and maybeSingle() report the way the client does", async () => {
  const s = storeWithProject();
  const none = await from(s, "projects").select("*").eq("id", "nope").maybeSingle();
  assert.equal(none.data, null);
  assert.equal(none.error, null);

  const missing = await from(s, "projects").select("*").eq("id", "nope").single();
  assert.equal(missing.data, null);
  assert.equal(missing.error?.code, "PGRST116");

  await from(s, "episodes").insert([{ project_id: PROJECT, code: "A" }, { project_id: PROJECT, code: "B" }]);
  const many = await from(s, "episodes").select("*").maybeSingle();
  assert.equal(many.error?.code, "PGRST116", "more than one row is an error even for maybeSingle");
});

test("update takes its filters and moves updated_at only where a trigger does", async () => {
  const s = storeWithProject();
  const block = (await from(s, "generation_blocks").insert({ idx: 0 }).select().single()).data;
  const take = (await from(s, "block_takes")
    .insert({ block_id: block.id, kind: "master" }).select().single()).data;
  const before = block.updated_at;
  await new Promise((r) => setTimeout(r, 2));

  await from(s, "generation_blocks").update({ status: "done" }).eq("id", block.id);
  const after = (await from(s, "generation_blocks").select("*").eq("id", block.id).single()).data;
  assert.equal(after.status, "done");
  assert.notEqual(after.updated_at, before, "generation_blocks carries a moddatetime trigger");

  const t = (await from(s, "block_takes").select("*").eq("id", take.id).single()).data;
  assert.equal(t.updated_at, undefined, "block_takes has no such trigger — inventing one would lie");
});

test("the claim is a conditional update: exactly one caller wins", async () => {
  const s = storeWithProject();
  const job = (await from(s, "jobs")
    .insert({ kind: "clip_gen", lane: "local", status: "queued" }).select().single()).data;

  const first = await from(s, "jobs").update({ status: "running", worker_id: "A" })
    .eq("id", job.id).eq("status", "queued").select().maybeSingle();
  const second = await from(s, "jobs").update({ status: "running", worker_id: "B" })
    .eq("id", job.id).eq("status", "queued").select().maybeSingle();

  assert.equal(first.data.worker_id, "A");
  assert.equal(second.data, null, "the second claim matches no row and must come back empty");
});

test("delete cascades, nulls and refuses exactly as the foreign keys say", async () => {
  const s = storeWithProject();
  const sb = (await from(s, "storyboards").insert({ episode_id: null }).select().single()).data;
  const sc = (await from(s, "scenes").insert({ storyboard_id: sb.id, idx: 0 }).select().single()).data;
  await from(s, "beats").insert([{ scene_id: sc.id, idx: 0 }, { scene_id: sc.id, idx: 1 }]);

  await from(s, "scenes").delete().eq("id", sc.id);
  assert.equal((await from(s, "beats").select("id")).data.length, 0, "beats cascade with their scene");

  const block = (await from(s, "generation_blocks").insert({ idx: 0 }).select().single()).data;
  const take = (await from(s, "block_takes").insert({ block_id: block.id }).select().single()).data;
  await from(s, "generation_blocks").update({ active_take_id: take.id }).eq("id", block.id);
  await from(s, "block_takes").delete().eq("id", take.id);
  const after = (await from(s, "generation_blocks").select("*").eq("id", block.id).single()).data;
  assert.equal(after.active_take_id, null, "active_take_id is `on delete set null`");

  const asset = (await from(s, "assets").insert({ b2_key: "x.mp4", kind: "video" }).select().single()).data;
  const tl = (await from(s, "timelines").insert({ episode_id: null }).select().single()).data;
  const track = (await from(s, "tracks").insert({ timeline_id: tl.id, kind: "video", idx: 0 }).select().single()).data;
  await from(s, "clips").insert({ track_id: track.id, asset_id: asset.id, t_start_ms: 0, out_ms: 1 });
  const refused = await from(s, "assets").delete().eq("id", asset.id);
  assert.equal(refused.error?.code, "23503", "a clip still points at it — RESTRICT");
  assert.equal((await from(s, "assets").select("id")).data.length, 1, "and nothing was removed");
});

test("delete count is what deleteProject checks", async () => {
  const s = storeWithProject();
  const r = await from(s, "projects").delete({ count: "exact" }).eq("id", PROJECT);
  assert.equal(r.count, 1);
  const gone = await from(s, "projects").delete({ count: "exact" }).eq("id", PROJECT);
  assert.equal(gone.count, 0, "a second delete must report zero, not throw");
});

test("upsert on a conflict target updates in place", async () => {
  const s = storeWithProject();
  const first = (await from(s, "assets")
    .upsert({ b2_key: "images/x.png", kind: "image", meta: { a: 1 } }, { onConflict: "b2_key" })
    .select().single()).data;
  const second = (await from(s, "assets")
    .upsert({ b2_key: "images/x.png", kind: "image", meta: { a: 2 } }, { onConflict: "b2_key" })
    .select().single()).data;
  assert.equal(second.id, first.id, "same row");
  assert.deepEqual(second.meta, { a: 2 });
  assert.equal((await from(s, "assets").select("id")).data.length, 1);
});

test("a NULL in the conflict key is never a conflict — two rows, as Postgres keeps them", async () => {
  // `custom_workflows_civitai_uniq` is a plain unique index on
  // (owner_id, civitai_version_id), and everything hand-made or pasted carries
  // a null version id. Postgres never treats two NULLs as equal, so several of
  // those coexist; `null === null` is true in JS, so without the guard the
  // second upsert would overwrite the first and one plane would silently hold
  // one fewer workflow than the other.
  const s = storeWithProject();
  const wf = (n: string) => ({
    name: n, api_graph: {}, source: "paste", civitai_version_id: null,
    project_id: PROJECT,
  });
  const a = (await from(s, "custom_workflows")
    .upsert(wf("hand-made A"), { onConflict: "owner_id,civitai_version_id" })
    .select().single()).data;
  const b = (await from(s, "custom_workflows")
    .upsert(wf("hand-made B"), { onConflict: "owner_id,civitai_version_id" })
    .select().single()).data;

  assert.notEqual(b.id, a.id, "a null version id must not collide with another");
  const all = (await from(s, "custom_workflows").select("id,name")).data;
  assert.equal(all.length, 2, "both hand-made workflows survive");
  assert.deepEqual(all.map((r: any) => r.name).sort(), ["hand-made A", "hand-made B"]);
});

test("a re-import of the same Civitai version still updates in place", async () => {
  // The other half: with the key complete, the upsert must still find its row.
  // A guard that made every upsert insert would be the opposite bug.
  const s = storeWithProject();
  const wf = (n: string) => ({
    name: n, api_graph: {}, source: "civitai", civitai_version_id: 999,
    project_id: PROJECT,
  });
  const first = (await from(s, "custom_workflows")
    .upsert(wf("SDXL TXT to IMG"), { onConflict: "owner_id,civitai_version_id" })
    .select().single()).data;
  const again = (await from(s, "custom_workflows")
    .upsert(wf("SDXL TXT to IMG v2"), { onConflict: "owner_id,civitai_version_id" })
    .select().single()).data;

  assert.equal(again.id, first.id, "same row");
  assert.equal(again.name, "SDXL TXT to IMG v2");
  assert.equal((await from(s, "custom_workflows").select("id")).data.length, 1);
});

test("embeds resolve a to-one foreign key, and !inner drops the misses", async () => {
  const s = storeWithProject();
  const keep = (await from(s, "assets").insert({ b2_key: "k.png", kind: "image" }).select().single()).data;
  const binned = (await from(s, "assets")
    .insert({ b2_key: "b.png", kind: "image", deleted_at: "2026-01-01T00:00:00Z" }).select().single()).data;
  const col = (await from(s, "collections").insert({ name: "Set", project_id: PROJECT }).select().single()).data;
  await from(s, "collection_assets").insert([
    { collection_id: col.id, asset_id: keep.id, added_at: "2026-01-02T00:00:00Z" },
    { collection_id: col.id, asset_id: binned.id, added_at: "2026-01-01T00:00:00Z" },
    { collection_id: col.id, asset_id: "gone", added_at: "2026-01-03T00:00:00Z" },
  ]);

  const members = await from(s, "collection_assets")
    .select("added_at, assets!inner(*)")
    .eq("collection_id", col.id)
    .is("assets.hidden", false)
    .is("assets.deleted_at", null)
    .order("added_at", { ascending: false })
    .limit(300);
  assert.equal(members.error, null);
  assert.deepEqual(members.data.map((r: any) => r.assets.b2_key), ["k.png"],
    "the binned member and the dangling membership are both out");

  const counts = await from(s, "collection_assets")
    .select("collection_id, assets!inner(deleted_at, hidden)").limit(5000);
  assert.equal(counts.data.length, 2, "!inner drops the membership whose asset is gone");
  assert.deepEqual(Object.keys(counts.data[0]).sort(), ["assets", "collection_id"],
    "projection keeps exactly the named columns");
});

test("select projects columns and leaves the store alone", async () => {
  const s = storeWithProject();
  await from(s, "episodes").insert({ project_id: PROJECT, code: "MAIN", idx: 0, title: "T" });
  const { data } = await from(s, "episodes").select("id,code");
  assert.deepEqual(Object.keys(data[0]).sort(), ["code", "id"]);
  data[0].code = "MUTATED";
  const again = await from(s, "episodes").select("code").single();
  assert.equal(again.data.code, "MAIN", "results are copies");
});

test("ordering puts nulls where Postgres puts them", async () => {
  const s = storeWithProject();
  await from(s, "jobs").insert([
    { kind: "a", priority: 5 }, { kind: "b", priority: null }, { kind: "c", priority: 1 },
  ]);
  const asc = await from(s, "jobs").select("kind").order("priority");
  assert.deepEqual(asc.data.map((r: any) => r.kind), ["c", "a", "b"], "nulls last ascending");
  const desc = await from(s, "jobs").select("kind").order("priority", { ascending: false });
  assert.deepEqual(desc.data.map((r: any) => r.kind), ["b", "a", "c"], "nulls first descending");
});

test("the queue's own ordering: priority then created_at", async () => {
  const s = storeWithProject();
  await from(s, "jobs").insert([
    { kind: "late-cheap", lane: "local", status: "queued", priority: 5, created_at: "2026-01-02T00:00:00Z" },
    { kind: "early-cheap", lane: "local", status: "queued", priority: 5, created_at: "2026-01-01T00:00:00Z" },
    { kind: "batch", lane: "local", status: "queued", priority: 50, created_at: "2026-01-00T00:00:00Z" },
    { kind: "pod", lane: "gpu", status: "queued", priority: 1 },
  ]);
  const { data } = await from(s, "jobs").select("kind")
    .eq("lane", "local").eq("status", "queued")
    .order("priority").order("created_at").limit(1);
  assert.deepEqual(data.map((r: any) => r.kind), ["early-cheap"]);
});

test("range() is inclusive on both ends", async () => {
  const s = storeWithProject();
  await from(s, "beats").insert([0, 1, 2, 3, 4].map((idx) => ({ idx, scene_id: null })));
  const { data } = await from(s, "beats").select("idx").order("idx").range(1, 3);
  assert.deepEqual(data.map((r: any) => r.idx), [1, 2, 3]);
});

test("an unknown table is refused rather than silently empty", async () => {
  const s = storeWithProject();
  const { data, error } = await from(s, "model_catalog").select("*");
  assert.equal(data, null);
  assert.equal(error?.code, "42P01",
    "a shared table must never be answered from the local store — the router keeps it on the cloud plane");
});

test("parseSelect refuses a nested embed instead of half-answering it", () => {
  assert.deepEqual(parseSelect("id,name"), { cols: ["id", "name"], embeds: [] });
  assert.throws(() => parseSelect("id, a(b(c))"), /nested embeds/);
});

/* ── a write that changes nothing is not a write ────────────────────────── */
//
// Postgres would write the row and shrug. Here a write costs the whole
// PROJECT: `updated_at` moves, the sync ledger gains an entry, every live
// query on the table refetches, and the persister rewrites `project.json` —
// 11MB on a real project, serialized on the webview's one thread. Measured at
// idle, that was a full rewrite every couple of seconds for a render's
// progress row nobody had changed.

test("a patch that changes nothing writes nothing at all", async () => {
  const s = storeWithProject();
  const { data: block } = await from(s, "generation_blocks")
    .insert({ storyboard_id: null, idx: 0 }).select().single();
  s.clearPendingUpTo(s.revision);
  const before = { rev: s.revision, at: block.updated_at, pending: s.pendingCount() };
  let events = 0;
  s.onChange(() => { events += 1; });

  const { data, error } = await from(s, "generation_blocks")
    .update({ status: "planned", mode: "r2v" }).eq("id", block.id).select();

  assert.equal(error, null);
  assert.equal(data.length, 1, "the caller still gets its row back");
  assert.equal(data[0].id, block.id);
  assert.equal(s.revision, before.rev, "no revision bump");
  assert.equal(s.pendingCount(), before.pending, "nothing to push to the cloud");
  assert.equal(events, 0, "no invalidation, so no refetch and no rewrite");
  assert.equal(s.find("generation_blocks", block.id)!.updated_at, before.at,
    "updated_at is what a sync compares — it must not move for nothing");
});

test("a jsonb value that is equal but not identical is still nothing", async () => {
  // `params` defaults to {} and a caller routinely sends a fresh {} — the
  // object case, which `===` alone would call a change every time.
  const s = storeWithProject();
  const { data: block } = await from(s, "generation_blocks")
    .insert({ storyboard_id: null, idx: 0 }).select().single();
  const rev = s.revision;
  await from(s, "generation_blocks")
    .update({ params: {}, beat_ids: [] }).eq("id", block.id);
  assert.equal(s.revision, rev);
});

test("one changed column in a patch still writes, and only that row", async () => {
  const s = storeWithProject();
  const { data: rows } = await from(s, "generation_blocks")
    .insert([{ storyboard_id: null, idx: 0 }, { storyboard_id: null, idx: 1 }]).select();
  await from(s, "generation_blocks").update({ status: "generated" }).eq("idx", 1);
  s.clearPendingUpTo(s.revision);
  const rev = s.revision;

  // Two rows, one already at the value. The write must happen, and the ledger
  // must name ONE row — a per-table skip would send both.
  const { data } = await from(s, "generation_blocks")
    .update({ status: "generated" }).in("idx", [0, 1]).select();

  assert.equal(data.length, 2, "both rows come back either way");
  assert.equal(s.revision, rev + 1, "exactly one change event");
  assert.deepEqual(s.pendingChanges().map((p) => p.pk), [rows[0].id],
    "only the row that actually moved is pending");
  assert.equal(s.find("generation_blocks", rows[1].id)!.status, "generated");
});

test("an upsert onto identical values is nothing either", async () => {
  // `register_asset` re-upserts the same row on every re-registration, which
  // is the common case rather than a corner one.
  const s = storeWithProject();
  const row = { b2_key: "library/x.png", kind: "image", project_id: PROJECT };
  await from(s, "assets").upsert(row, { onConflict: "b2_key" }).select();
  s.clearPendingUpTo(s.revision);
  const rev = s.revision;

  const { data } = await from(s, "assets")
    .upsert({ ...row }, { onConflict: "b2_key" }).select();
  assert.equal(data.length, 1, "the row still comes back");
  assert.equal(s.revision, rev, "no write");
  assert.equal(s.pendingCount(), 0);

  // And a real change through the same path still lands.
  await from(s, "assets")
    .upsert({ ...row, kind: "video" }, { onConflict: "b2_key" }).select();
  assert.equal(s.revision, rev + 1);
  assert.equal(s.rows("assets")[0].kind, "video");
});

test("an insert of nothing is not a change event", async () => {
  const s = storeWithProject();
  const rev = s.revision;
  await from(s, "beats").insert([]).select();
  assert.equal(s.revision, rev);
});

/* ── the persister's serialization ──────────────────────────────────────── */

test("snapshotJson is the same document, without the clone", () => {
  const s = storeWithProject();
  s.insert("beats", [{ scene_id: null }]);
  const parsed = JSON.parse(s.snapshotJson());
  const direct = JSON.parse(JSON.stringify(s.snapshot()));
  // Stamped per call, so it is the one field the two cannot share.
  assert.notEqual(parsed.updated_at, undefined);
  delete parsed.updated_at;
  delete direct.updated_at;
  assert.deepEqual(parsed, direct);
});

test("snapshot() still hands out a DETACHED copy", () => {
  // `snapshotJson` reads the live rows, which is only safe because nobody can
  // hold its result. This one can be held, so it must still be a copy.
  const s = storeWithProject();
  const snap = s.snapshot();
  snap.tables.projects[0].title = "mutated";
  assert.equal(s.rows("projects")[0].title, "Local one");
});

/* ── the rule, enforced across the app ───────────────────────────────────── */

test("no query in src/ asks for a NESTED embed", () => {
  // `parseSelect` refusing one (above) only helps if somebody hears the
  // refusal, and `.select()` throws SYNCHRONOUSLY — inside whatever
  // `Promise.all([...])` literal it was written in, before any sibling query
  // is awaited. So one nested embed anywhere rejects an entire loader, and
  // `useLiveQuery` then leaves `data` null with the error in a field most
  // callers do not read: the surface renders as PERMANENTLY LOADING.
  //
  // Measured, on a local project: ClipRetakeModal chased
  // storyboard -> episode -> project in one round
  // (`episodes(project_id,projects(settings,style))`) to save two sequential
  // awaits. Nothing errored on screen — the modal's Edit tab simply read
  // "nothing to hold yet" over a block that had a perfectly good take, and the
  // primary button offered "take 1" over a block that already had one.
  //
  // Every table this could bite is one a LOCAL project contains, and the app's
  // components do not know which plane they are on — that is the whole point
  // of `planeRouter` — so the rule is the same everywhere: one level, and take
  // the second round trip.
  const files = readdirDeep("src").filter(
    (f) => /\.tsx?$/.test(f) && !f.includes(".test."));
  const sel = /\.select\(\s*(["'`])([\s\S]*?)\1/g;
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    for (const m of src.matchAll(sel)) {
      let depth = 0, nested = false;
      for (const ch of m[2]) {
        if (ch === "(") { if (depth >= 1) nested = true; depth++; }
        else if (ch === ")") depth--;
      }
      if (nested) {
        bad.push(`${f}:${src.slice(0, m.index).split("\n").length} ${m[2]}`);
      }
    }
  }
  assert.deepEqual(bad, [], `nested embeds refused by the local plane:\n${bad.join("\n")}`);
});

function readdirDeep(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...readdirDeep(p));
    else out.push(p);
  }
  return out;
}

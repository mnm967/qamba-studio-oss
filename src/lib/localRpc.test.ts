// The two stored procedures a local project runs for itself.
//
// Both are silent when wrong, and in opposite directions: a cancel that
// returns cleanly having cancelled nothing, and a reorder that renumbers the
// scenes without telling the block plan it is now out of date — after which
// the storyboard renders blocks against times that belong to a different
// order.
import assert from "node:assert/strict";
import test from "node:test";
import { LocalStore } from "./localStore.ts";
import { localRpc } from "./localRpc.ts";

const PID = "11111111-1111-4111-8111-111111111111";

function board() {
  const store = new LocalStore(PID, "local-1");
  store.insert("projects", [{ id: PID, title: "T", medium: "film" }]);
  const ep = store.insert("episodes", [{ project_id: PID, code: "MAIN", idx: 0 }])[0];
  const sb = store.insert("storyboards", [{ episode_id: ep.id }])[0];
  const scenes = ["A", "B", "C"].map((slug, idx) =>
    store.insert("scenes", [{ storyboard_id: sb.id, idx, slug }])[0]);
  return { store, sb, scenes };
}

test("an unknown procedure is left on the cloud plane", () => {
  const { store } = board();
  assert.equal(localRpc(store, "model_roster", {}), null);
  assert.equal(localRpc(store, "claim_orphan_data", {}), null,
    "the account tools are the studio's, not this machine's");
});

test("cancelling a queued job cancels it outright", async () => {
  const { store } = board();
  const job = store.insert("jobs", [{ kind: "clip_gen", lane: "local", status: "queued" }])[0];
  const res = await localRpc(store, "request_job_cancel", { p_job: job.id })!;
  assert.equal(res.error, null);
  const after = store.find("jobs", job.id)!;
  assert.equal(after.status, "canceled");
  assert.equal(after.cancel_requested, true);
});

test("cancelling a RUNNING job asks, and lets the worker finish the sentence", async () => {
  // The worker polls `cancel_requested` and writes the terminal status once it
  // has let go of the engine. Writing `canceled` here would leave a render
  // running under a row that says it stopped.
  const { store } = board();
  const job = store.insert("jobs", [{ kind: "clip_gen", lane: "local", status: "running" }])[0];
  await localRpc(store, "request_job_cancel", { p_job: job.id })!;
  const after = store.find("jobs", job.id)!;
  assert.equal(after.status, "running");
  assert.equal(after.cancel_requested, true);
});

test("a finished job is not resurrected by a late cancel", async () => {
  const { store } = board();
  const job = store.insert("jobs", [{ kind: "clip_gen", lane: "local", status: "done" }])[0];
  const res = await localRpc(store, "request_job_cancel", { p_job: job.id })!;
  assert.equal(res.data, null, "the SQL's `where status in ('queued','running')`");
  assert.equal(store.find("jobs", job.id)!.status, "done");
  assert.notEqual(store.find("jobs", job.id)!.cancel_requested, true);
});

test("reordering renumbers the scenes and reports how many moved", async () => {
  const { store, sb, scenes } = board();
  const res = await localRpc(store, "reorder_scenes",
    { p_storyboard: sb.id, p_ids: [scenes[2].id, scenes[0].id, scenes[1].id] })!;
  assert.equal(res.error, null);
  assert.equal(res.data, 3);
  const order = store.rows("scenes").sort((a, b) => a.idx - b.idx).map((s) => s.slug);
  assert.deepEqual(order, ["C", "A", "B"]);
});

test("…and marks the block plan stale, because blocks span scenes", async () => {
  const { store, sb, scenes } = board();
  const planned = store.insert("generation_blocks",
    [{ storyboard_id: sb.id, idx: 0, status: "planned" }])[0];
  const rendered = store.insert("generation_blocks",
    [{ storyboard_id: sb.id, idx: 1, status: "generated" }])[0];
  const queued = store.insert("generation_blocks",
    [{ storyboard_id: sb.id, idx: 2, status: "queued" }])[0];

  await localRpc(store, "reorder_scenes",
    { p_storyboard: sb.id, p_ids: [scenes[1].id, scenes[0].id, scenes[2].id] })!;

  assert.equal(store.find("generation_blocks", planned.id)!.status, "stale");
  assert.equal(store.find("generation_blocks", rendered.id)!.status, "stale");
  assert.equal(store.find("generation_blocks", queued.id)!.status, "queued",
    "a block already on its way is not the plan's to touch");
});

test("a no-op reorder moves nothing and leaves the plan alone", async () => {
  const { store, sb, scenes } = board();
  const block = store.insert("generation_blocks",
    [{ storyboard_id: sb.id, idx: 0, status: "planned" }])[0];
  const res = await localRpc(store, "reorder_scenes",
    { p_storyboard: sb.id, p_ids: scenes.map((s) => s.id) })!;
  assert.equal(res.data, 0);
  assert.equal(store.find("generation_blocks", block.id)!.status, "planned");
});

test("a list that does not name every scene is refused", async () => {
  // The SQL raises 22023 for exactly this: a stale list would drop a scene out
  // of the episode rather than reorder it.
  const { store, sb, scenes } = board();
  for (const ids of [
    [scenes[0].id, scenes[1].id],                       // one missing
    [scenes[0].id, scenes[0].id, scenes[1].id],         // one twice
    [...scenes.map((s) => s.id), "22222222-2222-4222-8222-222222222222"], // a stranger
  ]) {
    const res = await localRpc(store, "reorder_scenes", { p_storyboard: sb.id, p_ids: ids })!;
    assert.equal(res.error?.code, "22023", JSON.stringify(ids));
  }
  assert.deepEqual(
    store.rows("scenes").sort((a, b) => a.idx - b.idx).map((s) => s.slug),
    ["A", "B", "C"], "and nothing moved");
});

/* ── project_storage_stats ─────────────────────────────────────────────────
 *
 * The twin of the SQL in 20260826120000. Its three judgement calls are the
 * ones a reimplementation drifts on, and each is wrong in a way the sheet
 * would state confidently: hidden media is COUNTED (a copy moves it, so
 * excluding it understates the transfer), binned media is reported SEPARATELY
 * rather than dropped (it still occupies the bucket), and a null `bytes` is
 * summed as zero AND counted, so the total can be shown as a floor instead of
 * quietly under-reporting.
 */
function library() {
  const store = new LocalStore(PID, "local-1");
  store.insert("projects", [{ id: PID, title: "T", medium: "film" }]);
  store.insert("assets", [
    { project_id: PID, kind: "render", b2_key: "r/1.mp4", bytes: 3_000_000 },
    { project_id: PID, kind: "video", b2_key: "v/1.mp4", bytes: 1_000_000 },
    { project_id: PID, kind: "video", b2_key: "v/2.mp4", bytes: null },
    { project_id: PID, kind: "image", b2_key: "i/1.png", bytes: 500, hidden: true },
    { project_id: PID, kind: "image", b2_key: "i/2.png", bytes: 700,
      deleted_at: "2026-08-26T00:00:00Z" },
  ]);
  return store;
}

const statsFor = async (store: LocalStore) => {
  const res = await localRpc(store, "project_storage_stats", { p_project: PID })!;
  const by = new Map<string, Record<string, number>>();
  for (const r of (res.data as Record<string, number>[]) ?? []) {
    by.set(String(r.kind), r);
  }
  return by;
};

test("storage stats sum per kind, and a null size is counted rather than ignored", async () => {
  const by = await statsFor(library());
  assert.equal(by.get("render")!.live_bytes, 3_000_000);
  assert.equal(by.get("video")!.live_n, 2, "both videos are live");
  assert.equal(by.get("video")!.live_bytes, 1_000_000, "the unsized one adds nothing");
  assert.equal(by.get("video")!.unsized_n, 1, "…but it is counted, so the UI can say so");
});

test("HIDDEN media is counted — a copy moves it either way", async () => {
  const by = await statsFor(library());
  // The sidebar's `asset_counts` excludes hidden deliberately; this sheet must
  // not, or someone approves a copy and watches more arrive than it promised.
  assert.equal(by.get("image")!.live_n, 1, "the hidden image is in the live count");
  assert.equal(by.get("image")!.live_bytes, 500);
});

test("BINNED media is reported apart, not dropped", async () => {
  const by = await statsFor(library());
  const img = by.get("image")!;
  assert.equal(img.trashed_n, 1);
  assert.equal(img.trashed_bytes, 700);
  assert.equal(img.live_bytes, 500, "the bin does not inflate the live total");
});

test("another project's media is not counted", async () => {
  const store = library();
  store.insert("assets", [{ project_id: "22222222-2222-4222-8222-222222222222",
                            kind: "render", b2_key: "other.mp4", bytes: 9_000_000 }]);
  const by = await statsFor(store);
  assert.equal(by.get("render")!.live_bytes, 3_000_000);
});

test("asset_counts excludes hidden and reports live and trashed per kind", async () => {
  const store = library();
  const res = await localRpc(store, "asset_counts", { p_project: PID })!;
  assert.equal(res.error, null);
  const rows = (res.data ?? []) as { kind: string; live: number; trashed: number }[];
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  assert.equal(byKind.get("video")!.live, 2);
  assert.equal(byKind.get("video")!.trashed, 0);
  assert.equal(byKind.get("image")!.live, 0, "the hidden image is excluded from live");
  assert.equal(byKind.get("image")!.trashed, 1, "the binned image is counted in trashed");
  assert.equal(byKind.get("render")!.live, 1);
});



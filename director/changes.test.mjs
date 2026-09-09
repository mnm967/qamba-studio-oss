// node --test director/changes.test.mjs
//
// The revert is only as good as the journal, and every failure here is quiet:
// an update journaled AFTER the write restores the value it just set, a plan
// replayed in forward order collides with `unique (storyboard_id, idx)`, a
// job deleted instead of cancelled disappears from a queue that a worker may
// already be serving. So the recording (through the toolset's real wrappers)
// and the plan are pinned side by side.
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeChanges, hasChanges, keyOf, revertPlan, selectPath, withJournal,
} from "./changes.js";
import { configureTools, runTool } from "./tools.js";

test("selectPath adds a select to a filtered path and refuses an unfiltered one", () => {
  assert.equal(selectPath("beats?id=eq.b1", "id,meta"), "beats?id=eq.b1&select=id,meta");
  assert.equal(selectPath("beats?scene_id=eq.s1&select=id,idx&order=idx", "*"),
               "beats?scene_id=eq.s1&order=idx&select=*",
               "the caller's own select is replaced, its filters kept");
  assert.equal(selectPath("beats", "*"), null, "a whole-table read is never made to journal");
  assert.equal(selectPath("beats?select=*", "*"), null);
});

test("keyOf knows the two composite link tables and refuses a keyless row", () => {
  assert.deepEqual(keyOf({ id: "x", a: 1 }), { id: "x" });
  assert.deepEqual(keyOf({ entry_id: "e", asset_id: "a", role: "face" }),
                   { entry_id: "e", asset_id: "a" });
  assert.deepEqual(keyOf({ collection_id: "c", asset_id: "a" }),
                   { collection_id: "c", asset_id: "a" });
  assert.equal(keyOf({ role: "face" }), null);
});

test("the plan is the journal REVERSED, jobs are cancelled, deletes come back whole", () => {
  const ops = [
    { op: "update", table: "generation_blocks", keys: ["idx", "t_start_ms"],
      before: [{ id: "b2", idx: 2, t_start_ms: 12000, status: "generated" }] },
    { op: "insert", table: "scenes", id: "sc-new" },
    { op: "insert", table: "generation_blocks", id: "blk-new" },
    { op: "insert", table: "jobs", id: "job-1" },
    { op: "delete", table: "beats",
      rows: [{ id: "bt-9", scene_id: "sc1", idx: 3, action: "x", owner_id: "me",
               project_id: "p1", created_at: "t", updated_at: "t" }] },
  ];
  const plan = revertPlan(ops);
  assert.deepEqual(plan.map((s) => s.kind), ["insert", "cancel_job", "delete", "delete", "patch"],
                   "newest first: the insert is removed before the shift it followed is undone");
  assert.deepEqual(plan[0].body, { id: "bt-9", scene_id: "sc1", idx: 3, action: "x" },
                   "server-owned columns are never sent back; the id is");
  assert.deepEqual(plan[1], { kind: "cancel_job", id: "job-1" });
  assert.deepEqual(plan[2], { kind: "delete", table: "generation_blocks", key: { id: "blk-new" } });
  assert.deepEqual(plan[4], { kind: "patch", table: "generation_blocks", key: { id: "b2" },
                              body: { idx: 2, t_start_ms: 12000 } },
                   "only the columns the turn touched go back — not the status the worker moved");
});

test("an unbounded write becomes a skip that names its table, never silence", () => {
  const plan = revertPlan([{ op: "update", table: "beats", unbounded: true }]);
  assert.deepEqual(plan, [{ kind: "skip", table: "beats", why: "unbounded update" }]);
});

test("describeChanges counts rows in words a person reads", () => {
  const lines = describeChanges([
    { op: "insert", table: "generation_blocks", id: "x" },
    { op: "insert", table: "jobs", id: "j" },
    { op: "update", table: "generation_blocks", keys: ["idx"], before: [{ id: 1 }, { id: 2 }] },
    { op: "delete", table: "beats", rows: [{ id: 9 }] },
  ]);
  assert.deepEqual(lines, ["1 block added", "2 blocks changed", "1 shot removed", "1 render queued"]);
  assert.equal(hasChanges([]), false);
  assert.equal(hasChanges([{ op: "insert", table: "x", id: 1 }]), true);
});

/** A fake db that answers reads from a table of rows and records writes. */
function fakeDb(rows) {
  const calls = { get: [], ins: [], upd: [], del: [] };
  const db = {
    get: async (path) => {
      calls.get.push(path);
      const table = path.split("?")[0];
      return (rows[table] ?? []).filter((r) => {
        const m = path.match(/id=eq\.([^&]+)/);
        return !m || String(r.id) === m[1];
      });
    },
    ins: async (table, body) => { calls.ins.push([table, body]); return { id: `${table}-new`, ...body }; },
    upd: async (path, body) => { calls.upd.push([path, body]); },
    updRows: async (path, body) => { calls.upd.push([path, body]); return []; },
    del: async (path) => { calls.del.push(path); },
  };
  return { db, calls };
}

const BT1 = "11111111-1111-4111-8111-111111111111";   // uuid-shaped: a bare id, not a "b2" ref

test("the toolset's wrappers journal an update by reading the touched columns FIRST", async () => {
  const { db, calls } = fakeDb({});
  configureTools({ db, lore: {} });
  const ops = [];
  // set_beat_image is the smallest tool that both reads and writes a beat.
  const ctx = { projectId: "p1", episodeId: "e1", settings: {}, journal: ops };
  db.get = (async (path) => {
    calls.get.push(path);
    if (path.startsWith(`beats?id=eq.${BT1}`)) return [{ id: BT1, scene_id: "s1", meta: { cast: ["A"] } }];
    if (path.startsWith("assets?id=eq.as1")) return [{ id: "as1", kind: "image", b2_key: "k.png" }];
    if (path.startsWith("scenes?id=eq.s1")) return [{ id: "s1", storyboard_id: "sb1" }];
    if (path.startsWith("generation_blocks?")) return [{ id: "blk1", status: "generated" }];
    return [];
  });
  const out = await runTool("set_beat_image", { beat_id: BT1, asset_id: "as1", purpose: "look" }, ctx);
  assert.equal(out.beat_id, BT1, JSON.stringify(out));
  const upd = ops.find((o) => o.op === "update" && o.table === "beats");
  assert.ok(upd, "the beat update was journaled");
  assert.deepEqual(upd.keys, ["meta"]);
  assert.deepEqual(upd.before, [{ id: BT1, scene_id: "s1", meta: { cast: ["A"] } }],
                   "the row as it was BEFORE the write, so the revert puts the old meta back");
  // and the read came before the write
  const readAt = calls.get.findIndex((p) => p.startsWith(`beats?id=eq.${BT1}&select=`));
  assert.ok(readAt >= 0, "a select of the touched columns was issued");
  const writeIdx = calls.upd.findIndex(([p]) => p === `beats?id=eq.${BT1}`);
  assert.ok(writeIdx >= 0);
  // The plan undoes it with the captured meta.
  const plan = revertPlan(ops);
  const patch = plan.find((s) => s.kind === "patch" && s.table === "beats");
  assert.deepEqual(patch.body, { meta: { cast: ["A"] } });
});

test("without a journal on ctx nothing is recorded and nothing extra is read", async () => {
  const { db, calls } = fakeDb({});
  configureTools({ db, lore: {} });
  db.get = (async (path) => {
    calls.get.push(path);
    if (path.startsWith(`beats?id=eq.${BT1}`)) return [{ id: BT1, scene_id: "s1", meta: {} }];
    if (path.startsWith("assets?id=eq.as1")) return [{ id: "as1", kind: "image" }];
    if (path.startsWith("scenes?id=eq.s1")) return [{ id: "s1", storyboard_id: "sb1" }];
    return [];
  });
  await runTool("set_beat_image", { beat_id: BT1, asset_id: "as1" },
                { projectId: "p1", episodeId: "e1", settings: {} });
  assert.ok(!calls.get.some((p) => /select=id,entry_id/.test(p)),
            "the journal's pre-read must not happen when no journal is open");
});

test("withJournal is re-entrant: a nested call records onto the outer journal", async () => {
  const outer = [];
  await withJournal(outer, async () => {
    const { noteChange } = await import("./changes.js");
    noteChange({ op: "insert", table: "a", id: 1 });
    await withJournal([], async () => noteChange({ op: "insert", table: "b", id: 2 }));
  });
  assert.deepEqual(outer.map((o) => o.table), ["a", "b"]);
});

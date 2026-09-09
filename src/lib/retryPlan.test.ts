// node --test src/lib/retryPlan.test.ts
//
// What a retry does to a dependency graph.
//
// The motivating failure is the pod boot window: neon-worker and comfyui start
// together, ComfyUI listens minutes later, and a gpu job claimed into that gap
// died on a refused connection — measured live, every `unreachable` row in this
// studio's history is a gpu job that failed 0.5-9 seconds after being claimed.
// The worker then calls fail_dependents, so ONE real failure leaves a whole
// tree of collateral ones, and retrying any single row of it either runs
// without its inputs or leaves everything behind it dead.
//
// Both ways of rewriting that graph wrong are silent — a job pointing at a
// dependency that can never be `done` is simply never selected by
// claim_next_job, with nothing on screen to say why — which is exactly the
// kind of thing worth a test that needs no database.
import assert from "node:assert/strict";
import test from "node:test";

import { liveDeps, planRetry, remapDeps } from "./retryPlan.ts";

/** A wizard tier-1 shape: a face sheet, the two sheets composed from it, and
 *  the render waiting on all three. The face is what hit the boot window. */
const FACE = { id: "face", depends_on: [] };
const BODY = { id: "body", depends_on: ["face"] };
const TURN = { id: "turn", depends_on: ["face", "body"] };
const RENDER = { id: "render", depends_on: ["turn", "voice"] };   // voice is done
const CHAIN = [RENDER, TURN, BODY, FACE];                         // newest-first, as read

test("insertion is dependency-first whatever order the rows arrive in", () => {
  const order = planRetry(CHAIN, new Set(["voice"])).map((s) => s.job.id);
  assert.deepEqual(order, ["face", "body", "turn", "render"]);
});

test("a dependency that completed is kept, by its original id", () => {
  // claim_next_job is satisfied by a `done` dependency, and the voice ref this
  // render needs is already on file — requeueing it would redo paid work.
  const render = planRetry(CHAIN, liveDeps([{ id: "voice", status: "done" }]))
    .find((s) => s.job.id === "render")!;
  assert.deepEqual(render.deps.sort(), ["turn", "voice"]);
});

test("a dependency that can never complete is DROPPED, not carried", () => {
  // The silent deadlock: `dj.status <> 'done'` is claim_next_job's whole
  // condition, so a canceled dependency parks the retry in the queue forever.
  const render = planRetry(CHAIN, liveDeps([{ id: "voice", status: "canceled" }]))
    .find((s) => s.job.id === "render")!;
  assert.deepEqual(render.deps, ["turn"]);
});

test("queued and running deps are kept — they have not failed, only not finished", () => {
  assert.deepEqual(
    [...liveDeps([{ id: "a", status: "queued" }, { id: "b", status: "running" },
                  { id: "c", status: "done" }, { id: "d", status: "error" }])].sort(),
    ["a", "b", "c"],
  );
});

test("chain deps are rewritten to the new ids as the rows go in", () => {
  const remap = new Map<string, string>();
  const written: Record<string, string[]> = {};
  for (const step of planRetry(CHAIN, new Set(["voice"]))) {
    written[step.job.id] = remapDeps(step.deps, remap);
    remap.set(step.job.id, `new-${step.job.id}`);
  }
  assert.deepEqual(written, {
    face: [],
    body: ["new-face"],
    turn: ["new-face", "new-body"],
    // The outside dependency keeps its own id; only retried rows are remapped.
    render: ["new-turn", "voice"],
  });
});

test("a lone failure is a chain of one, with no deps invented", () => {
  // The common case, and the one in the screenshot that prompted this: two
  // image_gen rows with no dependents at all.
  const plan = planRetry([{ id: "solo", depends_on: null }]);
  assert.deepEqual(plan.map((s) => [s.job.id, s.deps]), [["solo", []]]);
});

test("a dep on a row that is NOT in the chain and NOT live is dropped", () => {
  // e.g. the user retried one branch of a cascade from a filtered list. Better
  // a job that runs early than one that never runs.
  const plan = planRetry([{ id: "a", depends_on: ["stranger"] }]);
  assert.deepEqual(plan[0].deps, []);
});

test("a cycle drops out rather than producing a false order", () => {
  // Unreachable in practice (depends_on is written at enqueue time against
  // rows that already exist), but emitting these in some arbitrary order would
  // insert a row pointing at an id that never gets remapped.
  const plan = planRetry([{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["a"] },
                          { id: "c", depends_on: [] }]);
  assert.deepEqual(plan.map((s) => s.job.id), ["c"]);
});

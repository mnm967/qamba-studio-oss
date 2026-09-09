import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_OF, modelNameByKey, modelPatch, sceneModelState, type ModelBlock } from "./blockModel.ts";

const blk = (idx: number, params: Record<string, unknown>, scenes = ["s1"]): ModelBlock =>
  ({ id: `b${idx}`, idx, scene_ids: scenes, params });

const S = { id: "s1" };

test("a block with no model_key renders on plain h3, not on the project default", () => {
  // `_block_model`'s own fallback. Two blocks on the board this was written
  // against are in exactly this state, and reporting them as the project's
  // model would name a checkpoint they will not use.
  assert.equal(MODEL_OF(blk(0, {})), "minimax-h3");
  assert.equal(MODEL_OF({ params: null }), "minimax-h3");
  assert.equal(MODEL_OF({ params: { model_key: "" } }), "minimax-h3");
});

test("a uniform scene is not mixed and is not drifted when it matches", () => {
  const st = sceneModelState(S, [
    blk(1, { model_key: "minimax-h3-pdd" }),
    blk(2, { model_key: "minimax-h3-pdd" }),
  ], "minimax-h3-pdd");
  assert.equal(st.total, 2);
  assert.equal(st.mixed, false);
  assert.equal(st.drifted, false);
  assert.deepEqual(st.byKey, [{ key: "minimax-h3-pdd", idxs: [1, 2] }]);
});

test("the measured case: every block on turbo, the project set to pdd", () => {
  const st = sceneModelState(S, [
    blk(15, { model_key: "minimax-h3-turbo" }),
    blk(16, { model_key: "minimax-h3-turbo" }),
  ], "minimax-h3-pdd");
  assert.equal(st.drifted, true);
  assert.equal(st.mixed, false, "they agree with each other, just not with the project");
});

test("mixed reports every group, biggest first", () => {
  const st = sceneModelState(S, [
    blk(4, { model_key: "minimax-h3-turbo" }),
    blk(5, { model_key: "minimax-h3-pdd" }),
    blk(6, { model_key: "minimax-h3-turbo" }),
  ], "minimax-h3-turbo");
  assert.equal(st.mixed, true);
  assert.equal(st.drifted, true, "b5 is off the default");
  assert.deepEqual(st.byKey, [
    { key: "minimax-h3-turbo", idxs: [4, 6] },
    { key: "minimax-h3-pdd", idxs: [5] },
  ]);
});

test("an unresolvable project default is 'could not tell', never 'drifted'", () => {
  // A desktop `local:` id has no model_map key at all. Claiming drift there
  // would put a warning on every scene of a project rendering locally.
  const st = sceneModelState(S, [blk(1, { model_key: "minimax-h3-turbo" })], undefined);
  assert.equal(st.drifted, false);
  assert.equal(st.projectKey, undefined);
});

test("a scene with no blocks has nothing to have drifted", () => {
  const st = sceneModelState(S, [blk(1, { model_key: "minimax-h3-turbo" }, ["s2"])], "minimax-h3-pdd");
  assert.equal(st.total, 0);
  assert.equal(st.drifted, false);
});

test("blocks covering another scene are named", () => {
  const st = sceneModelState(S, [
    blk(1, { model_key: "minimax-h3" }, ["s1", "s2"]),
    blk(2, { model_key: "minimax-h3" }),
  ], "minimax-h3");
  assert.deepEqual(st.shared, [{ idx: 1, otherSceneIds: ["s2"] }]);
});

test("the patch writes BOTH keys and preserves everything else", () => {
  const p = modelPatch(S, [
    blk(1, { model_key: "minimax-h3-turbo", model_id: "h3-turbo-local", fight: true, width: 864, loras: [{ key: "combat" }] }),
  ], "minimax-h3-pdd", "h3-pdd-local");
  assert.deepEqual(p, [{
    id: "b1",
    params: { model_key: "minimax-h3-pdd", model_id: "h3-pdd-local", fight: true, width: 864, loras: [{ key: "combat" }] },
  }]);
});

test("a block already on the model is skipped, so a no-op press writes nothing", () => {
  const p = modelPatch(S, [
    blk(1, { model_key: "minimax-h3-pdd", model_id: "h3-pdd-local" }),
  ], "minimax-h3-pdd", "h3-pdd-local");
  assert.deepEqual(p, []);
});

test("a stale model_id beside a matching key IS rewritten", () => {
  // The pair has to agree: model_key picks the checkpoint, model_id is what
  // job_timings and cost_ledger file the render under.
  const p = modelPatch(S, [blk(1, { model_key: "minimax-h3-pdd" })], "minimax-h3-pdd", "h3-pdd-local");
  assert.equal(p.length, 1);
  assert.equal(p[0].params.model_id, "h3-pdd-local");
});

test("the patch never reaches a block outside the scene", () => {
  const p = modelPatch(S, [blk(9, { model_key: "minimax-h3" }, ["s2"])], "minimax-h3-pdd", "h3-pdd-local");
  assert.deepEqual(p, []);
});

test("names come off the catalog's video rows only, keyed by model_map key", () => {
  const keyOf = (id: string) => (id.startsWith("local:") ? undefined : id.replace(/-local$/, "").replace(/^h3/, "minimax-h3"));
  const m = modelNameByKey([
    { id: "h3-turbo-local", display_name: "MiniMax H3 · Turbo", kind: "video" },
    { id: "h3-pdd-local", display_name: "MiniMax H3 · PDD 8-step", kind: "video" },
    { id: "h3-image-local", display_name: "H3 stills", kind: "image" },
    { id: "local:wan22-5b/Q6_K", display_name: "Wan", kind: "video" },
  ], keyOf);
  assert.equal(m.get("minimax-h3-turbo"), "MiniMax H3 · Turbo");
  assert.equal(m.get("minimax-h3-pdd"), "MiniMax H3 · PDD 8-step");
  assert.equal(m.has("minimax-h3-image"), false, "image rows are not video models");
  assert.equal(m.size, 2, "a desktop id has no key and contributes nothing");
});

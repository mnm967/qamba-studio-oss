/**
 * The scene-level combat toggle's decision, pinned.
 *
 * The bug it exists to fix: `params.fight` is stamped at PLAN time, so a board
 * planned before 2026-08-22 (or a scene retyped afterwards) renders its fight
 * scenes without the adapter for good, and nothing anywhere says so. Measured
 * on this studio's Rei EP03 v6: nine blocks touching an action scene, zero
 * carrying the flag.
 *
 * Every case below is a way of being wrong that still renders a video.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fightPatch, sceneFightState, type FightBlock } from "./sceneFight.ts";

const SCENE = { id: "s1", meta: { type: "action" } };
const QUIET = { id: "s1", meta: { type: "quiet" } };
const yes = () => true;

const blk = (idx: number, params: Record<string, unknown> = {},
             scenes = ["s1"]): FightBlock =>
  ({ id: `b${idx}`, idx, scene_ids: scenes, params });

test("a board planned before the flag reads as drifted, not as off", () => {
  // The whole point. `undecided` is what separates "nobody ever decided" from
  // "I turned it off", and only the first is something to offer to fix.
  const s = sceneFightState(SCENE, [blk(1), blk(2)], yes);
  assert.equal(s.planned, true);
  assert.equal(s.on, 0);
  assert.equal(s.undecided, 2);
  assert.equal(s.drifted, true);
  assert.equal(s.checked, false);
});

test("a scene whose blocks all carry it is settled", () => {
  const s = sceneFightState(SCENE, [blk(1, { fight: true }), blk(2, { fight: true })], yes);
  assert.equal(s.checked, true);
  assert.equal(s.drifted, false);
  assert.equal(s.mixed, false);
});

test("an explicit off on an action scene is drift too — the user's, but drift", () => {
  const s = sceneFightState(SCENE, [blk(1, { fight: false })], yes);
  assert.equal(s.undecided, 0, "an explicit false is decided");
  assert.equal(s.drifted, true);
});

test("a quiet scene with the adapter on is drift the other way", () => {
  const s = sceneFightState(QUIET, [blk(1, { fight: true })], yes);
  assert.equal(s.planned, false);
  assert.equal(s.checked, true);
  assert.equal(s.drifted, true);
});

test("blocks that disagree read as mixed and the switch sits off", () => {
  // A switch has two states and this has three. Off + one click makes it
  // uniform, which is the usual indeterminate-checkbox resolution.
  const s = sceneFightState(SCENE, [blk(1, { fight: true }), blk(2)], yes);
  assert.equal(s.mixed, true);
  assert.equal(s.checked, false);
  assert.equal(s.on, 1);
});

test("only this scene's blocks are counted", () => {
  const s = sceneFightState(SCENE, [blk(1), blk(2, {}, ["s2"])], yes);
  assert.equal(s.total, 1);
});

test("a scene with no blocks has not drifted", () => {
  // Nothing to disagree with. Reporting drift here would put a fix-it prompt
  // on every unrendered scene in the storyboard.
  const s = sceneFightState(SCENE, [], yes);
  assert.equal(s.total, 0);
  assert.equal(s.drifted, false);
  assert.equal(s.checked, false);
});

test("a block covering two scenes is REPORTED, because toggling reaches both", () => {
  // 37 of 499 blocks on this studio's data span two scenes. The plan-time rule
  // is whole-block, so there is no way to change one half — only to say so.
  const s = sceneFightState(SCENE, [blk(1, {}, ["s1", "s2"]), blk(2)], yes);
  assert.deepEqual(s.shared, [{ idx: 1, otherSceneIds: ["s2"] }]);
});

test("a model that does not declare the adapter makes the switch inert", () => {
  const declares = (m: string | null) => m !== "ltx-25";
  const s = sceneFightState(SCENE, [blk(1, { model_key: "ltx-25" }), blk(2)], declares);
  assert.deepEqual(s.inert, [{ idx: 1, model: "ltx-25" }]);
});

test("…and a block with no model_key is measured against the DEFAULT checkpoint", () => {
  // `_block_model` falls back to H3_MODEL — plain minimax-h3 — so a params-less
  // block (what add_block writes) is not "unknown model", it is that one.
  const seen: (string | null)[] = [];
  sceneFightState(SCENE, [blk(1)], (m) => { seen.push(m); return true; });
  assert.deepEqual(seen, ["minimax-h3"]);
});

test("an unreadable catalog warns about nothing", () => {
  // null is "could not tell". Treating it as a refusal puts an amber warning
  // on a model that declares the adapter perfectly well.
  const s = sceneFightState(SCENE, [blk(1)], () => null);
  assert.deepEqual(s.inert, []);
});

// --- the write ---------------------------------------------------------------

test("the patch keeps every other key in params", () => {
  // params is ONE jsonb blob holding the model key, the resolution, the review
  // flag and the LoRA stack. Replacing it to set one key is how a per-block
  // model override disappears.
  const b = blk(1, { model_key: "minimax-h3-pdd", review: false, width: 1280 });
  assert.deepEqual(fightPatch(SCENE, [b], true), [{
    id: "b1",
    params: { model_key: "minimax-h3-pdd", review: false, width: 1280, fight: true },
  }]);
});

test("off writes an explicit false rather than deleting the key", () => {
  // Both render the same. But absent means "nobody decided", which is what
  // backfill_fight.py's default pass fills in — so deleting would let a later
  // backfill turn it silently back on.
  const [p] = fightPatch(SCENE, [blk(1, { fight: true })], false);
  assert.equal(p.params.fight, false);
  assert.ok("fight" in p.params);
});

test("a block already in the wanted state is not rewritten", () => {
  assert.deepEqual(fightPatch(SCENE, [blk(1, { fight: true })], true), []);
  // …but an UNDECIDED block is, even when turning off: absent and false are
  // different states and the whole point is to record a decision.
  assert.equal(fightPatch(SCENE, [blk(1)], false).length, 1);
});

test("the patch never touches a block outside this scene", () => {
  assert.deepEqual(fightPatch(SCENE, [blk(9, {}, ["s2"])], true), []);
});

// --- which models declare it -------------------------------------------------

test("combatByModelKey reads styleLoras in both spellings", async () => {
  const { combatByModelKey } = await import("./sceneFight.ts");
  const keyOf = (id: string) => (id === "h3-turbo-local" ? "minimax-h3-turbo"
    : id === "ltx-25-local" ? "ltx-25" : undefined);
  const m = combatByModelKey([
    { id: "h3-turbo-local", capabilities: { styleLoras: [{ key: "combat" }, { key: "grain" }] } },
    { id: "ltx-25-local", capabilities: { styleLoras: [] } },
    { id: "local:wan22-5b/Q6_K", capabilities: { styleLoras: [{ key: "combat" }] } },
  ], keyOf);

  assert.equal(m.get("minimax-h3-turbo"), true);
  assert.equal(m.get("ltx-25"), false);
  // A desktop row has no model_map key at all, so it contributes nothing —
  // otherwise `undefined` would become a map entry that matches every block
  // whose params carry no key.
  assert.equal(m.size, 2);

  // Bare strings are the other spelling the catalog carries.
  const b = combatByModelKey(
    [{ id: "h3-turbo-local", capabilities: { styleLoras: ["combat"] } }], keyOf);
  assert.equal(b.get("minimax-h3-turbo"), true);
});

test("a model with no row is UNKNOWN, not a refusal", async () => {
  const { combatByModelKey, sceneFightState } = await import("./sceneFight.ts");
  const m = combatByModelKey([], () => undefined);
  const declares = (k: string | null) => (k && m.has(k) ? m.get(k)! : null);
  const s = sceneFightState(SCENE, [blk(1, { model_key: "minimax-h3-pdd" })], declares);
  assert.deepEqual(s.inert, [], "an unloaded catalog must not accuse a model");
});

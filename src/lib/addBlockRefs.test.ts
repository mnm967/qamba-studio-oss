import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseModeFor, jobModeFor, refsBlocker, refCapOf, hasBackgroundSlot, submitBlocker,
} from "./addBlockRefs.ts";
import type { ModelCatalogRow } from "./db/types.ts";

const row = (p: Partial<ModelCatalogRow>): ModelCatalogRow => ({
  id: "m", family: "minimax-h3", display_name: "MiniMax H3", kind: "video",
  provider: "local", modes: ["t2v", "i2v", "flf", "r2v"], sizes: null,
  max_seconds: 15, fps: 24, frame_base: 17, frame_rem: 5, dim_step: 32,
  pricing: null, capabilities: { multiRef: 9 }, enabled: true, sort: 1,
  ...p,
} as ModelCatalogRow);

test("the picker filters on the action's FLOOR, so attaching a ref never re-picks the model", () => {
  assert.equal(baseModeFor("add_after"), "t2v");
  assert.equal(baseModeFor("extend"), "i2v");
  assert.equal(baseModeFor("chain"), "flf");
  // The floor is blind to the reference count — that is the whole point.
  assert.equal(baseModeFor("add_after"), jobModeFor("add_after", 0));
});

test("a reference turns the JOB into r2v, because that is the only mode wired for one", () => {
  assert.equal(jobModeFor("add_after", 0), "t2v");
  assert.equal(jobModeFor("add_after", 1), "r2v");
  assert.equal(jobModeFor("add_after", 9), "r2v");
  // Never for the keyframe actions: `handle_clip_gen` wires `ref_images` under
  // `if mode == "r2v"` alone, so an i2v carrying references stages the files
  // and drops them.
  assert.equal(jobModeFor("extend", 3), "i2v");
  assert.equal(jobModeFor("chain", 3), "flf");
});

test("extend and chain say WHY they take no references, in their own words", () => {
  assert.match(refsBlocker("extend", row({})), /opens on the last frame/);
  assert.match(refsBlocker("chain", row({})), /between two frames/);
});

test("a model with no r2v is refused by name rather than hidden", () => {
  const t2vOnly = row({ display_name: "FLUX.3 Video", modes: ["t2v"] });
  assert.match(refsBlocker("add_after", t2vOnly), /FLUX\.3 Video has no reference mode/);
  assert.equal(refsBlocker("add_after", row({})), null);
  assert.match(refsBlocker("add_after", null), /Pick a model/);
});

test("the ceiling is the model's, not a constant", () => {
  assert.equal(refCapOf(row({})), 9);
  assert.equal(refCapOf(row({ capabilities: { multiRef: 4 } })), 4);
  // An undeclared ceiling falls back to Ref2VA's, which is what every H3 row
  // declares anyway — a 0 here would make the control impossible to use.
  assert.equal(refCapOf(row({ capabilities: {} })), 9);
  assert.equal(refCapOf(null), 9);
});

test("the background slot is a declared capability, not a family guess", () => {
  assert.equal(hasBackgroundSlot(row({ capabilities: { backgroundRef: true } })), true);
  assert.equal(hasBackgroundSlot(row({})), false);
});

test("the submit asks again, because a selection outlives what made it legal", () => {
  // Attach references to a model that can hold them, then switch models.
  const t2vOnly = row({ display_name: "FLUX.3 Video", modes: ["t2v"] });
  assert.equal(submitBlocker("add_after", row({}), 2), null);
  assert.match(submitBlocker("add_after", t2vOnly, 2), /no reference mode/);
  assert.match(submitBlocker("add_after", t2vOnly, 2), /Remove the references/);
  // With nothing attached there is nothing to refuse — a t2v-only model still
  // renders the text block.
  assert.equal(submitBlocker("add_after", t2vOnly, 0), null);
  assert.equal(submitBlocker("extend", row({}), 0), null);
});

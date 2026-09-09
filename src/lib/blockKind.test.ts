// What a block is called, and what it is drawn as.
//
// Both halves are silent when wrong in the same way: the block still renders,
// the clip still plays, and the lane simply says something untrue about it —
// which is the bug being fixed (a chain the user had named was relabelled
// "Block 9" by a renumber it had nothing to do with).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockKind, blockLabel, clipKindClass, clipLabelFor, isClipBorn, kindFromMode, labelIsAuto,
} from "./blockKind.ts";
import type { GenerationBlock } from "./db/types";

const b = (params: unknown) => ({ params } as GenerationBlock);

// ---------------------------------------------------------------- the kind ---

test("the stamped kind wins — it is written at creation and cannot be inferred wrong", () => {
  assert.equal(blockKind(b({ clip_kind: "chain", clip_gen: { prompt: "p", mode: "i2v" } })), "chain");
});

test("a recipe's mode names the action that made it", () => {
  assert.equal(blockKind(b({ clip_gen: { prompt: "p", mode: "flf" } })), "chain");
  assert.equal(blockKind(b({ clip_gen: { prompt: "p", mode: "i2v" } })), "extend");
  assert.equal(blockKind(b({ clip_gen: { prompt: "p", mode: "t2v" } })), "shot");
});

test("a promotion whose recipe was never recovered is clip-born, kind unknown", () => {
  // "shot" is the generic clip-born kind: it renders from a recipe, and we
  // cannot claim it is a chain without evidence.
  assert.equal(blockKind(b({ derived_from: { clip_id: "c1" } })), "shot");
});

test("a trim keeps its beats, so it is NOT clip-born", () => {
  const t = b({ derived_from: { block_id: "b1", in_ms: 0, out_ms: 900 } });
  assert.equal(blockKind(t), "trim");
  assert.equal(isClipBorn(t), false);
});

test("a planner block is a plain block", () => {
  assert.equal(blockKind(b({ model_key: "minimax-h3" })), "plan");
  assert.equal(blockKind(b({})), "plan");
  assert.equal(blockKind(b(null)), "plan");
  assert.equal(blockKind(null), "plan");
});

test("a recipe with no prompt is not a recipe", () => {
  // The router reads this: a false positive would strip a planner block of
  // its whole beats-path retake surface.
  assert.equal(blockKind(b({ clip_gen: { mode: "flf" } })), "plan");
  assert.equal(blockKind(b({ clip_gen: [1, 2] })), "plan");
});

test("chains and extensions render from a recipe, plans and trims from beats", () => {
  assert.equal(isClipBorn(b({ clip_kind: "chain" })), true);
  assert.equal(isClipBorn(b({ clip_kind: "extend" })), true);
  assert.equal(isClipBorn(b({ clip_kind: "shot" })), true);
  assert.equal(isClipBorn(b({})), false);
});

test("an unknown stamp is ignored rather than trusted", () => {
  assert.equal(blockKind(b({ clip_kind: "wormhole" })), "plan");
});

// --------------------------------------------------------------- the label ---

test("each kind is called what it is, 1-indexed like every block ref", () => {
  assert.equal(blockLabel("chain", 8), "Chain 9");
  assert.equal(blockLabel("extend", 3), "Extension 4");
  assert.equal(blockLabel("plan", 0), "Block 1");
  // A trim IS a shot of the plan — calling it anything else would invent a
  // distinction the storyboard does not make.
  assert.equal(blockLabel("trim", 6), "Block 7");
});

test("an auto label is anything the studio itself writes", () => {
  for (const s of ["Block 9", "Chain 12", "Extension 4", "Shot 2", "Block 9 · audio",
                   "chain 3", "", "   ", null, undefined]) {
    assert.equal(labelIsAuto(s), true, String(s));
  }
});

test("a label a PERSON wrote is never auto", () => {
  for (const s of ["Chain: How the reference pi", "Block 9 (hero)", "Ext: she turns",
                   "the good one", "Chain"]) {
    assert.equal(labelIsAuto(s), false, s);
  }
});

test("a renumber rewrites the studio's own label and keeps a written one", () => {
  assert.equal(clipLabelFor("chain", 8, "Chain 3"), "Chain 9");
  assert.equal(clipLabelFor("chain", 8, "Block 3"), "Chain 9");
  assert.equal(clipLabelFor("chain", 8, "Chain: How the reference pi"),
               "Chain: How the reference pi");
});

test("the detached audio half keeps its suffix through a renumber", () => {
  // It was being eaten: the heal matched "Block 9 · audio", saw it differ
  // from "Block 9" and wrote the suffix away.
  assert.equal(clipLabelFor("chain", 8, "Chain 3 · audio", { audio: true }), "Chain 9 · audio");
});

// -------------------------------------------------------------- the colour ---

test("only chains and extensions are drawn differently", () => {
  assert.equal(clipKindClass("chain"), " k-chain");
  assert.equal(clipKindClass("extend"), " k-extend");
  assert.equal(clipKindClass("trim"), "");
  assert.equal(clipKindClass("plan"), "");
});

test("the mode map matches BlockActionModal's MODE_FOR", () => {
  assert.equal(kindFromMode("flf"), "chain");
  assert.equal(kindFromMode("i2v"), "extend");
  assert.equal(kindFromMode("t2v"), "shot");
  // A new block that carries REFERENCES renders as r2v, and it is still a
  // shot — only the two keyframe modes name themselves after what they join.
  assert.equal(kindFromMode("r2v"), "shot");
  assert.equal(kindFromMode(null), "shot");
});

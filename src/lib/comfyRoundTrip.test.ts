// The naming half of the ComfyUI round trip.
//
import assert from "node:assert/strict";
import test from "node:test";

import { comfyImportName, comfySourceUrl } from "./comfyImport.ts";

test("an imported name drops our staging prefix, not the workflow's own name", () => {
  assert.equal(comfyImportName("Qamba - minimax_h3_flf.json"), "minimax_h3_flf");
  // A graph the user made in ComfyUI keeps its name exactly.
  assert.equal(comfyImportName("My own graph.json"), "My own graph");
  // …including one that merely mentions us.
  assert.equal(comfyImportName("Qamba experiments.json"), "Qamba experiments");
  assert.equal(comfyImportName(".json"), "Untitled workflow");
});

test("the source url is the key a second save updates through", () => {
  assert.equal(comfySourceUrl("Qamba - a.json"), "comfyui:Qamba - a.json");
  // Two different files never collide, which is what stops one import
  // overwriting another's row.
  assert.notEqual(comfySourceUrl("a.json"), comfySourceUrl("b.json"));
});

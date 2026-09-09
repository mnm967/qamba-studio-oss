// node --test src/lib/clipAttach.test.ts
//
// Pinned against worker/handlers/blocks.py::_attach_to_clip, which is the
// same rule on the pod. The two planes disagreeing here is invisible in the
// output: the lane simply looks different depending on which machine rendered.
import test from "node:test";
import assert from "node:assert/strict";
import { clipAttachPatch } from "./clipAttach.ts";

test("the take becomes the clip's whole media", () => {
  const p = clipAttachPatch(4000, "a1", 4000);
  assert.equal(p.asset_id, "a1");
  assert.equal(p.in_ms, 0);
  assert.equal(p.out_ms, 4000);
  assert.equal(p.duration_ms, undefined);   // same length: nothing to change
});

test("a render that overshoots its slot does NOT grow the clip", () => {
  // Frame grids round UP, so this is the normal case. Growing would overlap
  // whatever is next on the lane.
  const p = clipAttachPatch(4000, "a1", 4250);
  assert.equal(p.duration_ms, undefined);
  assert.equal(p.out_ms, 4250);             // the media is longer; the clip is not
});

test("a render that came back SHORT shrinks the clip to fit", () => {
  // Otherwise the clip plays black past the end of its own file and the
  // preview sits on "buffering…".
  const p = clipAttachPatch(4000, "a1", 3200);
  assert.equal(p.duration_ms, 3200);
  assert.equal(p.out_ms, 3200);
});

test("an unknown render length changes no geometry", () => {
  for (const bad of [null, undefined, 0]) {
    const p = clipAttachPatch(4000, "a1", bad);
    assert.equal(p.duration_ms, undefined);
    assert.equal(p.out_ms, null);
    assert.equal(p.asset_id, "a1");         // the repoint still happens
  }
});

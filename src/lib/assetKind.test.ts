import { test } from "node:test";
import assert from "node:assert/strict";
import { isStill } from "./assetKind.ts";
import type { Asset } from "./db/types";

const asset = (p: Partial<Asset>): Asset => ({
  id: "a1", project_id: null, kind: "video", b2_key: "library/gen/x.mp4",
  content_type: null, bytes: null, width: 1280, height: 720, duration_ms: 4000,
  fps: 24, origin: "generated", source_job_id: null, meta: {}, tags: [],
  created_at: "2026-08-19T00:00:00Z", ...p,
} as Asset);

test("the extracted frame a generate action leaves on the lane is a still", () => {
  // extend / chain / add-after all place one of these while the GPU works.
  assert.equal(isStill(asset({ kind: "image", b2_key: "p/frames/frame_last_1.jpg" })), true);
  assert.equal(isStill(asset({ kind: "frame", b2_key: "frames/grab/x.png" })), true);
});

test("the render that replaces it is not", () => {
  assert.equal(isStill(asset({ kind: "video", b2_key: "library/gen/j1.mp4" })), false);
});

test("a kind that says video is trusted over the filename", () => {
  // A poster-framed or oddly-keyed mp4 must keep playing: guessing "still"
  // here would freeze a shot on frame 0 with nothing to explain it.
  assert.equal(isStill(asset({ kind: "video", b2_key: "library/gen/thumb.jpg" })), false);
});

test("an unlabelled picture still shows rather than hanging", () => {
  // `kind` is a text column with six legal values and registrations come from
  // several places; the two fallbacks are frameExtractor's own.
  assert.equal(isStill(asset({ kind: "file", content_type: "image/png", b2_key: "x/y" })), true);
  assert.equal(isStill(asset({ kind: "file", b2_key: "x/y.webp" })), true);
  assert.equal(isStill(asset({ kind: "file", b2_key: "x/y.mp4" })), false);
});

test("a missing asset is not a still", () => {
  // The player looks its clip's asset up in a map that may not hold it yet;
  // answering "still" would mount an <img src=undefined> over the stage.
  assert.equal(isStill(undefined), false);
  assert.equal(isStill(null), false);
});

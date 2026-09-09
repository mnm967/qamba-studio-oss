/**
 * The one-shot (tier 1) plan job must carry everything the tier-2 launch does.
 *
 * There are two launch paths and only one of them passes through "Queue the
 * episode". Tier 2 queues `launch_render` from the wizard; TIER 1 queues its
 * own on the pod, out of the PLAN job's payload — so anything that shapes the
 * render has to ride that payload too, and for its whole life three things
 * did not:
 *
 *   - `params.model_key` — `_block_model` falls back to plain `H3_MODEL`, so
 *     a one-shot rendered 20-step base H3 whatever the picker said. The
 *     wizard's own default is `h3-turbo-local` (6 steps), so the common case
 *     was ~2.7x the sampling time nobody asked for.
 *   - `dims` — `handle_master_pass` falls through to 1280x720, so the
 *     Resolution card was decoration on this path. Picking 480p rendered 2.2x
 *     the pixels; picking 720p rendered 1280x720 against the 1280x704 every
 *     other path uses.
 *   - `video_model`.
 *
 * All three are silent: the episode renders, correctly, wrong. Parsed from
 * source because the payload is built inside a React component with a dozen
 * hooks above it — the same answer `scoreTrack.test.ts` and
 * `worker/tests/test_review_gate.py` reach for the same reason.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = readFileSync(new URL("../components/modals/WizardModal.tsx", import.meta.url),
                         "utf8").replace(/\r\n/g, "\n");

function block(startsWith: string): string {
  const at = SRC.indexOf(startsWith);
  assert.ok(at > 0, `not found: ${startsWith}`);
  const end = SRC.indexOf("\n  };", at);
  assert.ok(end > at, `could not find the end of: ${startsWith}`);
  return SRC.slice(at, end);
}

const PLAN = (() => {
  const at = SRC.indexOf("const launchPlan = async");
  assert.ok(at > 0, "launchPlan is gone");
  const end = SRC.indexOf("setPlanJobId", at);
  assert.ok(end > at);
  return SRC.slice(at, end);
})();

const QUEUE = (() => {
  const at = SRC.indexOf('kind: "launch_render"');
  assert.ok(at > 0, "the tier-2 launch is gone");
  return SRC.slice(at, at + 2500);
})();

test("the render-shaping params are built ONCE, not per launch path", () => {
  // Two copies of the rule is exactly how these drifted apart.
  assert.ok(SRC.includes("const episodeParams"), "episodeParams is gone");
  const uses = SRC.split("episodeParams").length - 1;
  assert.ok(uses >= 3, `episodeParams declared but used ${uses - 1} time(s)`);
});

test("episodeParams carries the checkpoint, and only for a local model", () => {
  const b = block("const episodeParams");
  assert.match(b, /videoModel\.endsWith\("-local"\)/);
  assert.match(b, /model_key: modelKeyOf\(videoModel\)/);
  // A hosted row has no model_map entry — a key the worker cannot resolve
  // fails the render rather than falling back.
  assert.ok(b.indexOf('endsWith("-local")') < b.indexOf("model_key"));
});

test("the block flags sit OUTSIDE the local-only branch", () => {
  // Nesting `review` with `model_key` is what made the QA toggle a silent
  // no-op on `h3-api`.
  const b = block("const episodeParams");
  assert.ok(b.indexOf("...blockParams") > b.indexOf("model_key"));
  assert.ok(!/\{ model_key[\s\S]*blockParams[\s\S]*\}\s*:/.test(b));
});

test("the tier-1 plan job carries params, dims and the video model", () => {
  assert.match(PLAN, /params: episodeParams/);
  assert.match(PLAN, /dims: RES_DIMS\[res\]/);
  assert.match(PLAN, /video_model: videoModel/);
});

test("the tier-2 launch uses the same object, not a second copy", () => {
  assert.match(QUEUE, /params: episodeParams/);
  assert.match(QUEUE, /dims: RES_DIMS\[res\]/);
});

test("dims keys stay {w,h} — the worker reads dims.w / dims.h", () => {
  // `launch_render` and `handle_master_pass` both index `w`/`h`; a payload of
  // {width,height} passes every type check and silently selects the default.
  const dims = SRC.match(/const RES_DIMS[\s\S]*?\n\};/);
  assert.ok(dims, "RES_DIMS is gone");
  assert.match(dims[0], /\{ w: \d+, h: \d+ \}/);
});

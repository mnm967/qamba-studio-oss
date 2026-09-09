/**
 * A RETAKE RESTAGES ITS REFERENCES — pinned by parsing the surfaces that queue
 * one, because none of them is a function a unit test can call (each is a
 * component-local closure over Supabase writes, the situation
 * `scoreTrack.test.ts` and `worker/tests/test_review_gate.py` are in).
 *
 * The bug this exists to prevent was live for as long as panels have been
 * redrawable. `handle_master_pass` stages the plan STORED on the block, which
 * was computed when the episode was planned, and it recomputes only when the
 * job says `recompute_refs`. So redrawing a scene's panels — or recasting a
 * voice, or casting an outfit variant, or redrawing a location plate — moved
 * every text surface in the app and reached the render nowhere: `ref_plan`
 * still named the archived asset ids and the retake came back staging exactly
 * the pictures that had just been replaced. Nothing errors, so it reads as the
 * redraw not having worked rather than as the retake ignoring it.
 *
 * `queueStaleRerenders` and the director's `rerender_block` have always sent
 * it; the two RETAKE buttons had not, which is the whole asymmetry.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// Normalised to LF before anything indexes into it: git's default on Windows
// is core.autocrlf=true, and a regex `.` does not match `\r` — which is how a
// source-parsing test comes back reporting "found 0" instead of failing.
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The body of one `const <name> = async (…) => { … };` declaration. Chunked
 *  by its own terminator rather than by matching braces: these files are full
 *  of apostrophes and braces inside prose, and any scanner tracking those
 *  reads one as a delimiter and swallows the file — the trap
 *  `director/tool_parity.test.mjs` already documents. */
function arrowFn(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = async (`);
  assert.ok(at > 0, `${name} is gone — did it move or get renamed?`);
  const end = src.indexOf("\n  };\n", at);
  assert.ok(end > at, `could not find the end of ${name}`);
  return src.slice(at, end);
}

const STORYBOARD = read("../components/shell/StoryboardView.tsx");
const TAKESPOP = read("../components/timeline/TakesPopover.tsx");
const PROMPTREFS = read("../components/modals/PromptRefsModal.tsx");
const JOBS = read("./db/jobs.ts");

test("the storyboard's per-scene retake recomputes the reference plan", () => {
  const fn = arrowFn(STORYBOARD, "retakeBlocks");
  assert.match(fn, /queueBlockRender\(/, "it no longer queues a block render");
  assert.match(fn, /recompute_refs:\s*true/,
    "retakeBlocks queues without recompute_refs — the render will restage the "
    + "panels and sheets that were just redrawn, and say nothing about it");
});

test("…and so does the timeline's, so the two buttons agree", () => {
  const fn = arrowFn(TAKESPOP, "retake");
  assert.match(fn, /recompute_refs:\s*true/,
    "the takes popover's retake queues the block's stored plan");
});

test("the stale re-render still sends it", () => {
  // Not new — but it is the same flag for the same reason, and losing it here
  // would make the notice bar's one action a re-render of the old sheets.
  const at = JOBS.indexOf("export async function queueStaleRerenders");
  assert.ok(at > 0, "queueStaleRerenders is gone");
  assert.match(JOBS.slice(at, JOBS.indexOf("\n}\n", at)), /recompute_refs:\s*true/);
});

test("the prompt & references modal deliberately does NOT send it", () => {
  // That modal PERSISTS the plan it is showing (`persist()` writes `ref_plan`
  // straight onto the row) immediately before queueing, so a recompute would
  // replace the references the user just hand-picked with the ones derived
  // from the beats — the exact edit they opened the modal to make. Its own
  // regenerate has to render what the modal shows.
  assert.doesNotMatch(PROMPTREFS, /recompute_refs/,
    "PromptRefsModal now sends recompute_refs — a hand-picked reference set "
    + "cannot survive one; the worker rebuilds the plan from the beats and "
    + "carries only a designated closing frame across");
});

// --- and the job row names the model the block really renders on ------------

test("the storyboard retake no longer hardcodes the job's model_id", () => {
  const fn = arrowFn(STORYBOARD, "retakeBlocks");
  assert.doesNotMatch(fn, /model_id:\s*"h3-local"/,
    'retakeBlocks pins model_id to "h3-local" again — every turbo and PDD '
    + "block's wall time is then booked against plain h3 in job_timings, which "
    + "is what estimateBatchSeconds corrects its per-model ETA from");
  assert.match(fn, /model_id:\s*catalogIdOf\(/, "it no longer derives model_id at all");
});

test("…and does not also send a model_key override", () => {
  // The block's `params.model_key` is authoritative and `_block_model` reads
  // it directly. Putting one on the payload makes it a per-run OVERRIDE
  // (`_block_params` lifts it onto params), i.e. a second chance to get the
  // checkpoint wrong on a path that never needed to name it.
  assert.doesNotMatch(arrowFn(STORYBOARD, "retakeBlocks"), /model_key\s*:/,
    "retakeBlocks now overrides the checkpoint as well as naming it");
});

test("…and neither does the stale re-render, which had the same constant", () => {
  // `queueStaleRerenders` is the director dock's one fan-out, and it carried
  // the identical `model_id: "h3-local"` the storyboard retake did. Fixing one
  // and not its twin leaves the same wrong attribution one surface over.
  const at = JOBS.indexOf("export async function queueStaleRerenders");
  assert.ok(at > 0, "queueStaleRerenders is gone");
  const fn = JOBS.slice(at, JOBS.indexOf("\n}\n", at));
  assert.doesNotMatch(fn, /model_id:\s*"h3-local"/,
    "queueStaleRerenders pins model_id to \"h3-local\" again");
  assert.match(fn, /model_id:\s*catalogIdOf\(/);
});

test("the scene editor's model card writes BOTH model keys", () => {
  // `model_key` picks the checkpoint and `model_id` is what job_timings and
  // cost_ledger file the render under. Writing one without the other renders
  // on one model and books the time against another — which is the bug the
  // card exists to make visible in the first place.
  const BM = read("./blockModel.ts");
  const at = BM.indexOf("export function modelPatch");
  assert.ok(at > 0, "modelPatch is gone");
  const fn = BM.slice(at, BM.indexOf("\n}\n", at));
  assert.match(fn, /model_key:\s*key/);
  assert.match(fn, /model_id:\s*catalogId/);
});

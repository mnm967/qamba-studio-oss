import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FFMPEG_KINDS, LOCAL_PROJECT_KINDS, PY_KINDS, RENDER_KINDS,
         planLanes, podStillNeeded } from "./desktopPlanner.ts";

test("a plan's lanes are claimed per KIND, and only when this machine can serve one", () => {
  // Narrow on purpose. `localImages` is what `imagesHere` answers — the
  // bundled Python for a desktop-map row, `localRender` for a `local:` id —
  // so sheets, plates and panels render here; `tts` needs a speech key of the
  // user's own, or the pod's is the only one there is; `music_gen` has no
  // local recipe at all. Claiming a kind whose only worker cannot run it looks
  // exactly like a plan that succeeded and then stalled forever.
  assert.deepEqual(planLanes({ localImages: true }), { image_gen: "local" });
  assert.deepEqual(planLanes({ localImages: false }), {});
  assert.deepEqual(planLanes({ localImages: false, speech: true }), { tts: "local" });
  assert.deepEqual(planLanes({ localImages: true, speech: true }),
    { image_gen: "local", tts: "local" });
});

test("a LOCAL project routes everything this machine can do, key or no key", () => {
  // There is no alternative to route to: the pod polls Supabase and a local
  // project's rows are a file on this laptop. `tts` without a speech key still
  // goes here and falls back to a stock OpenAI voice — which is a worse voice,
  // where the pod is no voice at all.
  assert.deepEqual(planLanes({ localImages: false, forceLocal: true }),
    { image_gen: "local", tts: "local", launch_render: "local",
      master_pass: "local", audio_slice: "local", music_gen: "local" });
});

test("rendering the blocks here is its own answer, and it is about the WEIGHTS", () => {
  // A speech key does not make a block renderable and a downloaded checkpoint
  // does not make a voice. Kept separate because the two failures are
  // different — one is a keychain, the other is 57GB — and the wizard says
  // which.
  assert.deepEqual(planLanes({ localImages: false, render: true }),
    { launch_render: "local", master_pass: "local",
      audio_slice: "local", music_gen: "local" });
  assert.ok(!planLanes({ localImages: true, speech: true }).master_pass);
});

test("a local project may queue an episode render, now that a block can render here", () => {
  // It could not, and the reason was one thing: `launch_render` emits one
  // `master_pass` per block, and a master pass resolved its graph through the
  // POD's model map. With `infra/model_map.desktop.json` it resolves against
  // files the engine window downloaded, and `sb.insert` routes what it emits
  // onto this machine's own lane.
  assert.ok(PY_KINDS.has("launch_render"));
  assert.ok(LOCAL_PROJECT_KINDS.has("launch_render"));
  assert.ok(LOCAL_PROJECT_KINDS.has("master_pass"));
  for (const k of ["llm_task", "tts", "tl_render", "assemble_take"]) {
    assert.ok(LOCAL_PROJECT_KINDS.has(k), k);
  }
});

test("an empty lane map is the pod's own defaults, unchanged", () => {
  // The pod path must be byte-identical: `llm.job_lane` falls back to
  // LANE_DEFAULTS, so a plan queued without lanes is the plan that always was.
  assert.deepEqual(planLanes({ localImages: false }), {});
});

test("what still needs the pod is NAMED, not left to be discovered", () => {
  const all = podStillNeeded({});
  assert.deepEqual(all, ["reference sheets and panels", "voice references",
                         "the score", "planning the episode's blocks",
                         "rendering the blocks"]);
  const some = podStillNeeded({ image_gen: "local" });
  assert.ok(!some.includes("reference sheets and panels"));
  // A LOCAL project leaves NOTHING on the pod — which is the whole claim, and
  // it is only true because there is a desktop model map to render against.
  assert.deepEqual(podStillNeeded(planLanes({ localImages: true, forceLocal: true })), []);
});

test("every kind the planner can route has copy, or it goes unmentioned", () => {
  // A kind in `llm.LANE_DEFAULTS` with no label here is one that silently
  // never appears in the warning — the user is told the pod is needed for
  // three things when it is needed for four.
  assert.equal(podStillNeeded({}).length, 5,
    "every kind `planLanes` can route must have copy here, or it goes unmentioned");
});

/* ── the two allow-lists, pinned against each other ──────────────────────── */

const worker = (f: string) =>
  fs.readFileSync(path.join(process.cwd(), "worker", f), "utf8");

/** `KINDS = { "llm_task": None, ... }` — the keys only. */
function pythonKinds(): Set<string> {
  const src = worker("plan_cli.py");
  const body = src.split("KINDS = {")[1].split("\n}")[0];
  // DIGITS ARE PART OF A KIND NAME, and leaving them out was a scanner that
  // silently under-reported: `v2a_gen` is the first kind with one in it, and
  // a `[a-z_]+` scan simply did not see it. That direction is the dangerous
  // one — had the browser dropped the kind too, both sides would have agreed
  // about a list neither of them contained.
  return new Set([...body.matchAll(/^\s*"([a-z0-9_]+)":/gm)].map((m) => m[1]));
}

test("the browser routes exactly the kinds the Python will accept", () => {
  // BOTH DIRECTIONS, because each is a different silent failure. A kind the
  // browser routes to `local` and the Python refuses is a job that queues, is
  // claimed, and dies naming the render pod. A kind the Python would run and
  // the browser never routes is a capability nobody can reach.
  const py = pythonKinds();
  assert.ok(py.size > 5, "the KINDS scanner found almost nothing — it is broken");
  assert.deepEqual([...PY_KINDS].sort(), [...py].sort());
});

test("the ComfyUI-driving kinds on the list are the ones the desktop map covers", () => {
  // `master_pass` and friends resolve through `model_map.desktop.json`, which
  // is generated from the pod's and pruned to what the engine window can
  // download — so they are here. `clip_gen` is NOT, because the local worker
  // already runs it in TypeScript against the desktop's own recipe table, and
  // a second implementation of one kind is two places for it to be wrong.
  for (const k of ["master_pass", "patch_flf", "music_gen", "sfx_gen", "v2a_gen",
                   "image_gen"]) {
    assert.ok(RENDER_KINDS.has(k), k);
    assert.ok(PY_KINDS.has(k), k);
  }
  for (const k of ["clip_gen", "byok_gen", "take_review"]) {
    assert.ok(!PY_KINDS.has(k), `${k} must not be claimed by the Python runner`);
  }
  for (const k of RENDER_KINDS) assert.ok(PY_KINDS.has(k), `${k} is not a Python kind`);
});

test("a sheet is a Python kind because a sheet is not one picture", () => {
  // `localRender` renders a PROMPT. A plan's own sheets are composed for the
  // family finally chosen and hang on late-bound `anchors` — a body sheet
  // composes over a face plate that has not rendered when the job is written
  // — and `handlers/images.py` is the only implementation of either. Running
  // them on the TypeScript runner draws a sheet that is not the sheet the pod
  // would have drawn, after which a character's identity anchor depends on
  // which machine drew it.
  assert.ok(PY_KINDS.has("image_gen"));
  assert.ok(RENDER_KINDS.has("image_gen"), "it drives ComfyUI, so the engine is pinged first");
  // It is the one graph-driving kind that never shells out: `handlers/images`
  // is b2_get, a graph, b2_put. Demanding ffmpeg would refuse a machine that
  // could draw the sheet.
  assert.ok(!FFMPEG_KINDS.has("image_gen"));
});

test("a LOCAL project's image job is decided by the MODEL, not by the kind", () => {
  // The one exception to `LOCAL_PROJECT_KINDS = PY_KINDS`, and it is not a
  // tidy-up: whether an image job can run here depends on which model was
  // picked. A desktop-map row with its weights down renders through the
  // bundled Python, a `local:` id through the TypeScript runner, a
  // studio-hosted row through the `hosted` edge function — and a pod-only
  // row (Krea 2 among
  // them, whose abliterated encoder the engine window cannot fetch) through
  // none of them. On the kind list that last case stops being a refusal at
  // the queue naming the fix and becomes a job that is claimed and dies
  // inside `resolve.py`.
  assert.ok(!LOCAL_PROJECT_KINDS.has("image_gen"));
  // Everything else still is, or the exception has quietly become a rule.
  for (const k of PY_KINDS) {
    if (k !== "image_gen") assert.ok(LOCAL_PROJECT_KINDS.has(k), k);
  }
});

test("the ffmpeg list is a subset, and names the ones that shell out", () => {
  for (const k of FFMPEG_KINDS) assert.ok(PY_KINDS.has(k), `${k} is not a Python kind`);
  assert.ok(FFMPEG_KINDS.has("tl_render"), "the cut render is ffmpeg from end to end");
  assert.ok(!FFMPEG_KINDS.has("llm_task"), "a plan touches no media at all");
  // `tts` is on it: `handle_tts` measures the file it just wrote whenever the
  // provider reported no duration, and every path enqueues an `asset_ingest`.
  assert.ok(FFMPEG_KINDS.has("tts"));
});

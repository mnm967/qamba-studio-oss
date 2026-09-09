import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { breezeAction, breezeBlocked, remainingGb, WEIGHT_FILES,
         type BreezeStatus } from "./breezeLocal.ts";
import { speechEngineOf, speechNeedOf } from "./desktopPlanner.ts";

const st = (over: Partial<BreezeStatus> = {}): BreezeStatus => ({
  installed: true, code: true, venv: true,
  weights_mb: 7328, weights_total_mb: 7328, weights_missing: [],
  reachable: true, ours: true, starting: false, foreign: false,
  device: "mps", rev: "d76819fa9c04", port: 7860, root: "/r",
  license: "BreezeBlue Research — non-commercial, weights and outputs",
  ...over,
});

/* ── the action table ────────────────────────────────────────────────────── */

test("nothing installed offers the install", () => {
  assert.equal(breezeAction(null).kind, "install");
  const a = breezeAction(st({
    installed: false, code: false, venv: false, weights_mb: 0,
    weights_missing: ["config.json"], reachable: false, ours: false,
  }));
  assert.equal(a.kind, "install");
});

test("a HALF-fetched install offers to resume, and says how much is left", () => {
  // "Install" over 6GB already on disk reads as starting again from nothing.
  // The download resumes at file AND byte granularity, so the label may say so.
  const a = breezeAction(st({
    installed: false, weights_mb: 6000, weights_missing: ["model-00002-of-00002.safetensors"],
    reachable: false, ours: false,
  }));
  assert.equal(a.kind, "resume");
  assert.match(a.note!, /1 of 12 files/);
  assert.match(a.note!, /picks up where it stopped/);
});

test("a foreign server on the port offers NOTHING and says whose it is", () => {
  // WE DO NOT FIGHT FOR THE PORT. Starting a second one would take a port we
  // do not own and load 7.7GB beside somebody else's copy — and offering Stop
  // would kill a process this app did not start.
  const a = breezeAction(st({ ours: false, foreign: true }));
  assert.equal(a.kind, "none");
  assert.equal(a.label, "");
  assert.match(a.note!, /7860/);
  assert.match(a.note!, /your own Breeze/i);
});

test("a loading model says so rather than reading as down", () => {
  // A 3B model takes 30-60s. A status that called that "down" would offer
  // Start — which is exactly when a user presses it a second time.
  const a = breezeAction(st({ reachable: false, ours: false, starting: true }));
  assert.equal(a.kind, "wait");
  assert.match(a.note!, /30 to 60 seconds/);
});

test("installed and down offers Start; ours and up offers Stop", () => {
  assert.equal(breezeAction(st({ reachable: false, ours: false })).kind, "start");
  assert.equal(breezeAction(st()).kind, "stop");
});

test("foreign is checked before installed, and starting before reachable", () => {
  // Both orderings are the whole reason this is a function. A foreign server
  // while we are half-installed must still say "something else is on the
  // port"; a loading child must not be offered an install.
  const a = breezeAction(st({ installed: false, weights_mb: 0, foreign: true, ours: false }));
  assert.equal(a.kind, "none", "foreign wins over not-installed");
  const b = breezeAction(st({ installed: false, starting: true, reachable: false, ours: false }));
  assert.equal(b.kind, "wait", "starting wins over not-installed");
});

test("remainingGb is what is left, never negative", () => {
  assert.equal(remainingGb(null), 0);
  assert.equal(remainingGb(st({ weights_mb: 0 })).toFixed(1), "7.2");
  assert.equal(remainingGb(st()), 0);
  assert.equal(remainingGb(st({ weights_mb: 9999 })), 0);
});

/* ── the sentence a blocked picker row shows ─────────────────────────────── */

test("the picker's refusal is the Speech tab's own, per state", () => {
  // ONE PLACE DECIDES. A row that says "unavailable" while the tab says
  // "start it" is two answers to one question.
  assert.equal(breezeBlocked(st()), null, "a running Breeze blocks nothing");
  assert.match(breezeBlocked(st({ installed: false, reachable: false }))!,
               /install .*Speech tab/i);
  assert.match(breezeBlocked(st({ installed: false, reachable: false }))!,
               /non-commercial/, "the licence is part of the decision");
  assert.match(breezeBlocked(st({ reachable: false, ours: false }))!, /start/i);
  assert.match(breezeBlocked(st({ reachable: false, ours: false, starting: true }))!,
               /loading/i);
  assert.match(breezeBlocked(null)!, /Speech tab/);
});

/* ── the GPU policy ──────────────────────────────────────────────────────── */

test("a ComfyUI render parks it; a line brings it back", () => {
  // ~8.5GB resident beside a render is the measured OOM this exists for.
  for (const kind of ["master_pass", "patch_flf", "music_gen", "sfx_gen", "v2a_gen"]) {
    assert.equal(speechNeedOf({ kind }), "park", kind);
  }
  assert.equal(speechNeedOf({ kind: "tts", payload: { provider: "breeze" } }), "ensure");
  assert.equal(speechNeedOf({ kind: "voice_clone", payload: { provider: "breeze" } }),
               "ensure");
});

test("a line on another engine needs nothing either way", () => {
  // Ensuring for an ElevenLabs line would load 8.5GB for a hosted request.
  // ANY LOCAL ENGINE, not just Breeze: a `tts` job carrying `provider: "qwen"`
  // returned null here, so the service was never brought up, `handle_tts`
  // resolved nothing and fell through to the OpenAI chain — a stock voice
  // where a cast one was asked for.
  assert.equal(speechNeedOf({ kind: "tts", payload: { provider: "qwen" } }), "ensure");
  assert.equal(speechNeedOf({ kind: "voice_clone", payload: { provider: "qwen" } }),
               "ensure");
  assert.equal(speechNeedOf({ kind: "tts", payload: { provider: "elevenlabs" } }), null);
  assert.equal(speechNeedOf({ kind: "tts", payload: { provider: "openai" } }), null);
  assert.equal(speechNeedOf({ kind: "asset_ingest" }), null);
  assert.equal(speechNeedOf({ kind: "tl_render" }), null);
});

test("a plan ENSURES unless it named another engine", () => {
  // A plan measures every line it writes, and that is where the voices are
  // cast and the shot durations floored. `provider_default` picks Breeze
  // whenever `BREEZE_TTS_URL` is set — which `plan_run` only does when the
  // service answers — so an unset provider means "whatever the child decides",
  // and ensuring is the cautious direction.
  assert.equal(speechNeedOf({ kind: "llm_task", payload: { task: "plan_storyboard" } }),
               "ensure");
  assert.equal(speechNeedOf({ kind: "llm_task", payload: { dialogue_provider: "breeze" } }),
               "ensure");
  assert.equal(speechNeedOf({ kind: "llm_task", payload: { dialogue_provider: "elevenlabs" } }),
               null);
});

/* ── the twins ───────────────────────────────────────────────────────────── */

test("the file count agrees with the Rust weight list", () => {
  // A file added there and not here leaves the resume note reading "3 of 12"
  // about a set of thirteen — a number that is wrong in the direction that
  // makes an install look further along than it is.
  const rs = fs.readFileSync(
    path.join(process.cwd(), "src-tauri/src/breeze.rs"), "utf8").replace(/\r\n/g, "\n");
  const body = rs.split("const WEIGHTS: &[(&str, u64)] = &[")[1].split("];")[0];
  const n = [...body.matchAll(/\("([^"]+)",\s*\d+\)/g)].length;
  assert.equal(n, WEIGHT_FILES, `Rust names ${n} weight files, this says ${WEIGHT_FILES}`);
});

test("the port agrees with the Rust one and with the worker's own default", () => {
  const rs = fs.readFileSync(
    path.join(process.cwd(), "src-tauri/src/breeze.rs"), "utf8");
  assert.match(rs, /pub const PORT: u16 = 7860;/);
  // ...and `planner.rs` hands the child a URL built from it, which
  // `worker/breeze_tts.py` reads as `BREEZE_TTS_URL`. A disagreement is a
  // service that runs and a worker that cannot find it.
  const pl = fs.readFileSync(
    path.join(process.cwd(), "src-tauri/src/planner.rs"), "utf8");
  assert.match(pl, /BREEZE_TTS_URL/);
  assert.match(pl, /BREEZE_UNIT/);
});


test("which engine to ensure is the one the job names", () => {
  // PARKING IS ALL OF THEM and ensuring is ONE, so only the second needs a
  // name — and getting it wrong brings up the engine the job is not using
  // while the one it needs stays down.
  assert.equal(speechEngineOf({ kind: "tts", payload: { provider: "qwen" } }), "qwen");
  assert.equal(speechEngineOf({ kind: "tts", payload: { provider: "breeze" } }), "breeze");
  assert.equal(speechEngineOf({ kind: "llm_task", payload: { dialogue_provider: "qwen" } }),
               "qwen");
  // A plan that named nothing lets the child decide — `plan_run` tells it only
  // about engines already answering — so null means "whichever is here".
  assert.equal(speechEngineOf({ kind: "llm_task", payload: {} }), null);
  assert.equal(speechEngineOf({ kind: "tts", payload: { provider: "elevenlabs" } }), null);
  assert.equal(speechEngineOf({ kind: "tl_render" }), null);
  // A `tts` job's provider is not a PLAN's, and reading the wrong key is how
  // an engine gets ensured for a job that never asked for it.
  assert.equal(speechEngineOf({ kind: "tts", payload: { dialogue_provider: "qwen" } }), null);
});

test("the runner parks EVERY engine before a render, and one after", () => {
  // The engines share one card. `parkSpeech` naming a subset is the failure
  // `voice_engines.park_all` was written for on a pooled worker: the engine
  // nobody parked loads its weights beside the render and the OOM comes back
  // through the one that was not being watched. Measured there — a 9GB service
  // crash-looping 36 times against a resident ComfyUI.
  //
  // Source-parsed: the loop is a `while` over a live queue with Tauri
  // commands in it, so there is nothing to call in a test that would not also
  // claim a job.
  const lw = fs.readFileSync(
    path.join(process.cwd(), "src/lib/localWorker.ts"), "utf8").replace(/\r\n/g, "\n");
  const park = lw.split("async function parkSpeech(")[1].split("\n}")[0];
  for (const cmd of ["breezePark(", "qwenPark("]) {
    assert.ok(park.includes(cmd), `parkSpeech does not park ${cmd}`);
  }
  // ...and every engine the app can START is one it can park. A command added
  // to Rust and not here is an engine that comes up and never goes away.
  for (const f of ["src-tauri/src/breeze.rs", "src-tauri/src/qwen.rs"]) {
    const rs = fs.readFileSync(path.join(process.cwd(), f), "utf8");
    assert.match(rs, /pub fn \w+_park\(/, `${f} exposes no park command`);
  }
  // The decision and the call sit either side of `speechNeedOf`.
  assert.match(lw, /if \(need === "park"\) await parkSpeech\(\);/);
  assert.match(lw, /else if \(need === "ensure"\) await ensureSpeech\(speechEngineOf\(job\)\);/);
});

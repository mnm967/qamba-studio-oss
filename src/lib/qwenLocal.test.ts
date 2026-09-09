import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { qwenAction, qwenBlocked, remainingGb, WEIGHT_FILES } from "./qwenLocal.ts";

const read = (p: string) =>
  fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const S = (over: Partial<Parameters<typeof qwenAction>[0] & object> = {}) => ({
  installed: true, venv: true, weights_mb: 9000, weights_total_mb: 9000,
  weights_missing: [], reachable: false, ours: false, starting: false,
  foreign: false, device: "cuda", port: 7870, root: "/x",
  license: "Apache 2.0", supports_direction: false, ...over,
} as Parameters<typeof qwenAction>[0]);

test("the file count matches the Rust weight lists", () => {
  // A COUNT THAT DRIFTS IS A PROGRESS LINE THAT LIES: "3 of 22" about a set of
  // twenty-three reads as a stalled download that is actually fine.
  const rs = read("src-tauri/src/qwen.rs");
  const n = ["DESIGN_WEIGHTS", "CLONE_WEIGHTS"].reduce((acc, name) => {
    const body = rs.split(`const ${name}: &[(&str, u64)] = &[`)[1]?.split("];")[0];
    assert.ok(body, `${name} is gone from qwen.rs — did it move?`);
    return acc + [...body!.matchAll(/\("([^"]+)",\s*(\d+)\)/g)].length;
  }, 0);
  assert.equal(n, WEIGHT_FILES);
});

test("the port agrees with the Rust and is not Breeze's", () => {
  // A shared port makes "already running" answer for the WRONG engine, which
  // starts nothing and reports success.
  const rs = read("src-tauri/src/qwen.rs");
  const mine = Number(rs.match(/pub const PORT: u16 = (\d+)/)?.[1]);
  const theirs = Number(
    read("src-tauri/src/breeze.rs").match(/pub const PORT: u16 = (\d+)/)?.[1]);
  assert.equal(mine, S().port);
  assert.notEqual(mine, theirs);
});

test("a server we do not own is never stopped from here", () => {
  const a = qwenAction(S({ foreign: true, reachable: true }));
  assert.equal(a.kind, "none");
  assert.match(a.note!, /quit it first/);
});

test("a loading model is not reported as down", () => {
  // The window is minutes here (two checkpoints), which is exactly when a user
  // presses Start again and gets a second process.
  const a = qwenAction(S({ starting: true, ours: true }));
  assert.equal(a.kind, "wait");
  assert.match(a.note!, /two checkpoints/);
});

test("a half-fetched install offers to resume rather than to start over", () => {
  const a = qwenAction(S({
    installed: false, weights_mb: 4400,
    weights_missing: ["qwen3-tts-base/model.safetensors"],
  }));
  assert.equal(a.kind, "resume");
  assert.match(a.note!, /1 of 22/);
  assert.equal(Math.round(remainingGb(S({ weights_mb: 4400 })) * 10) / 10, 4.5);
});

test("a fresh machine is offered the install, and the licence is the good news", () => {
  assert.equal(qwenAction(null).kind, "install");
  // NOT "non-commercial": that is Breeze's caveat and the reason to reach for
  // this engine instead, so the blocked sentence must not borrow it.
  const why = qwenBlocked(S({ installed: false, weights_mb: 0, reachable: false }))!;
  assert.match(why, /Apache 2\.0/);
  assert.doesNotMatch(why, /non-commercial/);
});

test("start, stop and ready are the three live states", () => {
  assert.equal(qwenAction(S({ reachable: false })).kind, "start");
  assert.equal(qwenAction(S({ reachable: true, ours: true })).kind, "stop");
  assert.equal(qwenBlocked(S({ reachable: true })), null);
});

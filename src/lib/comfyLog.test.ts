// The linked-engine log, and the two ways its shape goes wrong quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatComfyLog } from "./comfyLog.ts";

const E = String.fromCharCode(27);
const entry = (m: string) => ({ t: "2026-09-05T17:00:00", m });

test("entries carry their own newlines — joining on one more double-spaces the panel", () => {
  const out = formatComfyLog({ entries: [entry("one\n"), entry("two\n"), entry("three\n")] });
  assert.equal(out, "one\ntwo\nthree");
  assert.ok(!out.includes("\n\n"));
});

test("ComfyUI's colour codes are stripped", () => {
  const out = formatComfyLog({ entries: [entry(`${E}[32m[INFO]${E}[0m setup plugin\n`)] });
  assert.equal(out, "[INFO] setup plugin");
});

test("only the last N lines come back", () => {
  const many = Array.from({ length: 200 }, (_, i) => entry(`line ${i}\n`));
  const out = formatComfyLog({ entries: many }, 5).split("\n");
  assert.equal(out.length, 5);
  assert.equal(out[4], "line 199");
});

test("an engine too old for the endpoint answers 200 with something else — an empty panel, not a crash", () => {
  assert.equal(formatComfyLog({}), "");
  assert.equal(formatComfyLog(null), "");
  assert.equal(formatComfyLog("<!doctype html>"), "");
  assert.equal(formatComfyLog({ entries: "not an array" }), "");
});

test("a multi-line entry is split, and a plain-string entry still works", () => {
  assert.equal(formatComfyLog({ entries: [entry("a\nb\n")] }), "a\nb");
  assert.equal(formatComfyLog({ entries: ["x\ny\n"] }), "x\ny");
});

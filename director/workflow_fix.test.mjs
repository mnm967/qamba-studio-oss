// The one AI step in workflow repair, and the guard that makes it safe.
//
// Two things are pinned here and both are about NOT trusting the model:
// every `use` must name a class the engine really has, and the ROUTE must
// build the prompt rather than accept one. The second is not a style
// preference — a route that took a system string would be an open relay to a
// paid backend wearing a feature's name.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { MAX_CLASSES, MAX_FAULTS, fixSystem, fixUser, parseFixReply } from "./workflow_fix.js";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
// CRLF: git's default on Windows is autocrlf, and a source-parsing test that
// does not normalise silently matches nothing — the trap CLAUDE.md records.
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

test("the system prompt forbids the failure that matters", () => {
  const s = fixSystem();
  // An invented class fails exactly like the missing one it replaces, except
  // the user was told it was fixed.
  assert.match(s, /verbatim/i);
  // Most custom nodes have no stock equivalent; a model that feels obliged to
  // answer is the problem this sentence exists to prevent.
  assert.match(s, /empty list is a good answer/i);
  assert.match(s, /Do not invent nodes/i);
});

test("the user half carries the inputs, which is what rule 2 rests on", () => {
  // "Same job" cannot be judged from a class NAME — a substitute has to take
  // the same wires.
  const u = fixUser([{ class_type: "ImageResizeKJ", node: "5",
                       inputs: ["image", "width", "height"] }], ["ImageScale"]);
  assert.match(u, /ImageResizeKJ \(node #5\), inputs: image, width, height/);
  assert.match(u, /Installed classes \(1\)/);
});

test("with no installed list the model is told to propose nothing", () => {
  // Every `use` would be dropped by the validator anyway, so the call could
  // only cost money and return nothing.
  assert.match(fixUser([{ class_type: "X" }], []), /propose nothing/);
});

test("a truncated class list SAYS it was truncated", () => {
  // A real engine reports ~850 classes and the pod ~1700. Implying the model
  // saw all of them would make an empty answer look like "there is nothing",
  // when it may just not have been shown the class.
  const many = Array.from({ length: MAX_CLASSES + 50 }, (_, i) => `Node${i}`);
  const u = fixUser([{ class_type: "X" }], many);
  assert.match(u, new RegExp(`Installed classes \\(${MAX_CLASSES} of ${many.length}, truncated\\)`));
});

test("faults are capped, so one broken graph cannot become one huge prompt", () => {
  const lots = Array.from({ length: MAX_FAULTS + 10 }, (_, i) => ({ class_type: `C${i}` }));
  const u = fixUser(lots, ["SaveImage"]);
  assert.equal(u.match(/^- C\d+/gm).length, MAX_FAULTS);
});

test("A CLASS THE MODEL INVENTED IS DROPPED", () => {
  const out = parseFixReply(
    '{"substitutions":[{"missing":"A","use":"NotInstalled","why":"trust me"},'
    + '{"missing":"B","use":"SaveImage","why":"it saves"}]}',
    new Set(["SaveImage"]));
  assert.deepEqual(out.map((s) => s.use), ["SaveImage"]);
});

test("prose around the JSON is tolerated; nonsense yields nothing", () => {
  assert.equal(parseFixReply('Sure!\n{"substitutions":[{"missing":"A","use":"S"}]}\nHope that helps',
                             new Set(["S"])).length, 1);
  for (const junk of ["", "I could not work that out.", null, undefined, "{oops"]) {
    assert.deepEqual(parseFixReply(junk, new Set(["S"])), [], String(junk));
  }
});

test("an empty substitution list is a normal answer, not an error", () => {
  assert.deepEqual(parseFixReply('{"substitutions":[]}', new Set(["S"])), []);
});

/* ── the route ──────────────────────────────────────────────────────────── */

test("the browser goes through the SAME builder rather than a second copy", () => {
  // A prompt written twice drifts, and the half that drifts is whichever one
  // nobody is looking at.
  assert.match(read("src/lib/workflowRepair.ts"),
    /from "\.\.\/\.\.\/director\/workflow_fix\.js"/);
});

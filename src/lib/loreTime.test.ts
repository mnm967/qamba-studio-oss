// Lore timing has two implementations and they must agree.
//
// `worker/llm.py::lore_status` decides what reaches the planner; `loreTime.ts`
// decides what the author is shown. If they disagree, the UI says a fact is in
// force for an episode the planner is hiding it from — and there is no surface
// anywhere that would reveal the disagreement. The author would conclude the
// model ignored their canon.
//
// The four states are not arbitrary. A single episode tag cannot express a
// retcon and gets it wrong in BOTH directions: tag by REVEALED and the earlier
// episode does not know the mechanic is operating, so it writes a world that
// contradicts the later reveal; tag by TRUE and the earlier episode may state
// it outright, spoiling. Hence `from` and `revealed` as separate fields — and
// `until`, for facts a later episode undoes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EVERGREEN, episodeOrder, isEvergreen, isRetcon, loreStatus, loreWhen, whenLabel,
} from "./loreTime.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EPS = [
  { id: "ep1", idx: 0, code: "EP01" },
  { id: "ep2", idx: 1, code: "EP02" },
  { id: "ep3", idx: 2, code: "EP03" },
];
const ORDER = episodeOrder(EPS);

test("an untagged entry is evergreen", () => {
  // Every entry that exists today has no `when`. A feature that silently drops
  // a project's whole bible on upgrade is worse than no feature.
  assert.deepEqual(loreWhen({}), EVERGREEN);
  assert.deepEqual(loreWhen(null), EVERGREEN);
  assert.deepEqual(loreWhen({ when: "nonsense" }), EVERGREEN);
  assert.deepEqual(loreWhen({ when: ["a"] }), EVERGREEN);
  assert.equal(loreStatus({}, ORDER, 0), "in_force");
});

test("a fact does not exist before the episode that establishes it", () => {
  const doc = { when: { from: "ep2", revealed: "ep2" } };
  assert.equal(loreStatus(doc, ORDER, 0), "not_yet");
  assert.equal(loreStatus(doc, ORDER, 1), "in_force");
});

test("a retcon is operating before it is revealed", () => {
  const doc = { when: { from: "ep1", revealed: "ep2" } };
  assert.equal(loreStatus(doc, ORDER, 0), "unrevealed");
  assert.equal(loreStatus(doc, ORDER, 1), "in_force");
  assert.ok(isRetcon(loreWhen(doc), ORDER));
  assert.ok(!isRetcon(loreWhen({ when: { from: "ep1", revealed: "ep1" } }), ORDER));
});

test("a fact can stop being true", () => {
  const doc = { when: { from: "ep1", revealed: "ep1", until: "ep2" } };
  assert.equal(loreStatus(doc, ORDER, 0), "in_force");
  assert.equal(loreStatus(doc, ORDER, 1), "superseded");
});

test("no current episode means the pre-tagging behaviour", () => {
  assert.equal(loreStatus({ when: { from: "ep3" } }, ORDER, null), "in_force");
});

test("an unresolvable episode is treated as unbounded, not dropped", () => {
  assert.equal(loreStatus({ when: { from: "gone", revealed: "gone" } }, ORDER, 0), "in_force");
});

test("evergreen is the absence of all three, not a shape of its own", () => {
  assert.ok(isEvergreen(EVERGREEN));
  assert.ok(isEvergreen(loreWhen({})));
  assert.ok(!isEvergreen({ from: "ep1", until: null, revealed: "ep1" }));
});

test("the label says the consequence, not the field values", () => {
  assert.equal(whenLabel(EVERGREEN, EPS), "always true");
  assert.equal(whenLabel({ from: "ep1", until: null, revealed: "ep1" }, EPS), "from EP01");
  assert.equal(whenLabel({ from: "ep1", until: null, revealed: "ep2" }, EPS),
               "from EP01 · revealed EP02");
  assert.equal(whenLabel({ from: "ep1", until: "ep2", revealed: "ep1" }, EPS),
               "from EP01 · until EP02");
  // A dangling id must read as a problem, not as a silent "from the start".
  assert.match(whenLabel({ from: "gone", until: null, revealed: null }, EPS), /deleted episode/);
});

// ---------------------------------------------------------------- parity ---

test("the four states match the worker's, by name", () => {
  // The strings themselves cross the boundary in logs and in reasoning about
  // this feature; a rename on one side only is a silent divergence.
  const py = fs.readFileSync(path.join(ROOT, "worker/llm.py"), "utf8");
  for (const [constant, value] of [
    ["LORE_IN_FORCE", "in_force"], ["LORE_UNREVEALED", "unrevealed"],
    ["LORE_NOT_YET", "not_yet"], ["LORE_SUPERSEDED", "superseded"],
  ]) {
    assert.match(py, new RegExp(`${constant} = "${value}"`),
      `worker/llm.py must define ${constant} as "${value}"`);
  }
});

test("both sides read the same three keys off doc.when", () => {
  const py = fs.readFileSync(path.join(ROOT, "worker/llm.py"), "utf8");
  const when = py.slice(py.indexOf("def lore_when("), py.indexOf("def episode_order("));
  for (const k of ["from", "until", "revealed"]) {
    assert.match(when, new RegExp(`pick\\("${k}"\\)`), `lore_when must read "${k}"`);
  }
  assert.match(py, /w = \(doc or \{\}\)\.get\("when"\)/,
    "the worker must read the same doc.when key the client writes");
});

test("the worker applies the same precedence: not_yet, then superseded, then unrevealed", () => {
  // Order matters at the boundaries. A fact that both starts and ends at the
  // current episode, or one revealed after it ends, must resolve the same way
  // on both sides or the two disagree only in the rare cases nobody tests by
  // hand.
  const py = fs.readFileSync(path.join(ROOT, "worker/llm.py"), "utf8");
  const fn = py.slice(py.indexOf("def lore_status("), py.indexOf("def lore_context("));
  const order = ["LORE_NOT_YET", "LORE_SUPERSEDED", "LORE_UNREVEALED"].map((s) => fn.indexOf(s));
  assert.ok(order.every((i) => i > 0), "all three states must be returned");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "precedence differs from the client");

  // And the client's own order, exercised rather than parsed.
  assert.equal(loreStatus({ when: { from: "ep2", until: "ep2", revealed: "ep3" } }, ORDER, 0),
               "not_yet");
  assert.equal(loreStatus({ when: { from: "ep1", until: "ep2", revealed: "ep3" } }, ORDER, 1),
               "superseded");
});

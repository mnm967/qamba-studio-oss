// The TypeScript sheet composer must produce EXACTLY what the pod produces.
//
// This is a twin, and the failure when a twin drifts is the quietest one this
// app has: a sheet renders fine, looks like a sheet, and differs from the one
// the same entry would have got from the pod — so a character's identity
// anchor, which every other reference derives from, depends on which machine
// drew it. No assertion about state can see that; only the string can.
//
// The fixtures are emitted by the REAL Python (`scripts/gen_sheet_golden.py`),
// so this is not two hand-written opinions agreeing with each other. A change
// to `worker/image_prompt.py` fails `test_sheet_golden.py` until the fixture is
// regenerated, and the regenerated fixture then fails THIS until the twin is
// brought along. Neither side can move alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { faceIdentity, sheetProse, sheetPrompt, SHEET_KINDS } from "./sheetPrompt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(join(HERE, "__fixtures__", "sheet_prompts.json"), "utf8"),
) as { cases: Array<{ name: string; family: string; spec: Record<string, unknown>; prompt: string }> };

test("the fixture is not empty — a silent read failure would pass everything", () => {
  assert.ok(GOLDEN.cases.length > 40, `only ${GOLDEN.cases.length} cases`);
});

for (const c of GOLDEN.cases) {
  test(`golden · ${c.name}`, () => {
    assert.equal(sheetPrompt(c.spec, c.family), c.prompt);
  });
}

// ── the refusals, which are the safety property ───────────────────────────

test("a family this cannot compose for is REFUSED, never guessed at", () => {
  // The bug being replaced is a model handed the wrong dialect in silence.
  // A plausible-but-wrong prompt is the one outcome that would hide a routing
  // mistake, so every local family and every catalog id throws.
  for (const fam of ["krea2", "klein", "h3", "sensenova", "anima", "gpt-image-2", ""]) {
    assert.throws(() => sheetPrompt({ kind: "character" }, fam), /cannot compose for/);
  }
});

test("a kind that takes another branch of the Python is REFUSED", () => {
  // `panel` is panelPrompt.ts and `scene_grid` is `_grid_prompt`, neither of
  // which is ported here. Composing one as a character sheet would return a
  // well-formed prompt for the wrong thing.
  for (const kind of ["panel", "scene_grid"]) {
    assert.throws(() => sheetPrompt({ kind }, "openai"), /cannot compose kind/);
  }
  for (const kind of SHEET_KINDS) {
    assert.doesNotThrow(() => sheetPrompt({ kind, identity: "x" }, "openai"));
  }
});

test("an absent kind composes as a character, exactly as the Python defaults", () => {
  assert.equal(sheetPrompt({ identity: "x" }, "openai"),
               sheetPrompt({ kind: "character", identity: "x" }, "openai"));
});

// ── the two rules a golden case cannot pin on its own ─────────────────────

test("the below-collar trim matches a term's PLURAL, `\\bWORDs?\\b`", () => {
  // Written singular, and real prose is not: `armored gauntlets` survived a
  // trim that had already removed `greaves`. The failure is silent, so the
  // suffix is pinned rather than left to a golden case that happens to use
  // one form. Checked against the real Python: the entries that are ALREADY
  // plural (`boots`, `gloves`, `shoulders`) therefore match only their own
  // plural, and both languages agree on that — the point here is that the two
  // agree, not that the list is well chosen.
  for (const w of ["jacket", "gauntlet", "nail", "sleeve"]) {
    assert.equal(faceIdentity(`amber eyes, one ${w} of steel`), "amber eyes");
    assert.equal(faceIdentity(`amber eyes, ${w}s of steel`), "amber eyes");
  }
  for (const w of ["boots", "gloves", "shoulders", "greaves"]) {
    assert.equal(faceIdentity(`amber eyes, ${w} of steel`), "amber eyes");
  }
});

test("`..` is collapsed EVERYWHERE, not just the first time", () => {
  // Python's `str.replace` is global and JS's string form replaces once. A
  // spec whose subject AND note both end in a period is the case that tells
  // them apart, and it renders a stray `..` into the stored prompt.
  const out = sheetProse({
    kind: "character", identity: "a person.", note: "make it rain.", style: "anime",
  });
  assert.ok(!out.includes(".."), out);
});

// The TypeScript panel composer must produce EXACTLY what the pod produces.
//
// This is a twin, and the failure when a twin drifts is the quietest one this
// app has: a panel renders fine, looks like a panel, and differs from the one
// the same beat would have got from the pod — so the picture depends on which
// machine drew it. No assertion about state can see that; only the string can.
//
// The fixtures are emitted by the REAL Python (`scripts/gen_panel_golden.py`),
// so this is not two hand-written opinions agreeing with each other. A change
// to `worker/image_prompt.py` fails `test_panel_golden.py` until the fixture is
// regenerated, and the regenerated fixture then fails THIS until the twin is
// brought along. Neither side can move alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  cap, clean, finalizeSpec, panelPrompt, panelProse, shotFraming, PROSE_FAMILIES,
} from "./panelPrompt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(join(HERE, "__fixtures__", "panel_prompts.json"), "utf8"),
) as { cases: Array<{ name: string; family: string; spec: Record<string, unknown>; prompt: string }> };

test("the fixture is not empty — a silent read failure would pass everything", () => {
  assert.ok(GOLDEN.cases.length > 25, `only ${GOLDEN.cases.length} cases`);
});

for (const c of GOLDEN.cases) {
  test(`golden · ${c.name}`, () => {
    assert.equal(panelPrompt(c.spec, c.family), c.prompt);
  });
}

// ── the refusal, which is the safety property ─────────────────────────────

test("a family this cannot compose for is REFUSED, never guessed at", () => {
  // The bug being replaced is a model handed the wrong dialect in silence:
  // hosted rows took the bracketed "stack" default for their whole life
  // because SHAPES had no entry for a catalog id. A plausible-but-wrong prompt
  // is the one outcome that would hide a routing mistake.
  for (const fam of ["krea2", "klein", "h3", "sensenova", "gpt-image-2", ""]) {
    assert.throws(() => panelPrompt({ action: "x" }, fam), /cannot compose for/);
  }
});

test("it composes for exactly the families a hosted render can reach", () => {
  assert.deepEqual([...PROSE_FAMILIES], ["openai", "google"]);
});

// ── the helpers, where the two languages disagree most easily ─────────────

test("clean mirrors Python's join/split, including the non-string guard", () => {
  assert.equal(clean("  she   turns \n away  "), "she turns away");
  assert.equal(clean("   "), "");
  assert.equal(clean(null), "");
  assert.equal(clean(7), "");        // isinstance(v, str) — a number is not
});

test("cap returns the ORIGINAL text when it is under the limit", () => {
  // Python returns `text`, not `" ".join(parts)` — so odd spacing survives,
  // and re-joining here would differ on any spec that skipped `clean`.
  assert.equal(cap("a  b", 30), "a  b");
});

test("cap cuts on a clause and strips the punctuation it cut at", () => {
  // Verified against the Python, not invented: a comma PAST 60% of the kept
  // text is the cut point, and the comma itself is stripped.
  assert.equal(cap("alpha beta gamma delta epsilon zeta eta, theta iota kappa", 9),
               "alpha beta gamma delta epsilon zeta eta");
  assert.equal(
    cap("ankle-deep black water under sodium light, shuttered storefronts either side, a tram line", 12),
    "ankle-deep black water under sodium light, shuttered storefronts either side");
});

test("cap keeps a hard cut when the clause break is too early", () => {
  // `cut > len(kept) * 0.6` — a comma inside the first 60% is not a cut
  // point, or a long sentence would be truncated to its opening clause.
  assert.equal(cap("one two three, four five six seven eight nine ten", 8),
               "one two three, four five six seven eight");
});

test("LONGEST framing key wins, not the first in the table", () => {
  // The table is grouped by family, which puts "close-up" ahead of
  // "over-the-shoulder" — so an unsorted scan composed every
  // "over-the-shoulder close-up" as a plain close-up and dropped the reverse.
  const [size] = shotFraming("an over-the-shoulder close-up on Rei");
  assert.ok(size.startsWith("OVER-THE-SHOULDER"), size);
});

test("a camera line naming nothing yields no framing rather than a guess", () => {
  assert.deepEqual(shotFraming("the camera does something new"), ["", ""]);
  assert.deepEqual(shotFraming(null), ["", ""]);
});

test("the style article follows the first letter, not the word", () => {
  const of = (style: string) => panelProse({ action: "x", style }).split("In the style of ")[1];
  assert.ok(of("anime").startsWith("an anime"));
  assert.ok(of("cinematic 35mm").startsWith("a cinematic"));
  assert.ok(of("Ink-wash").startsWith("an Ink-wash"));   // "I" is not a vowel here
});

// ── finalizeSpec, goldened against the pod's own function ─────────────────

const FINALIZE = (JSON.parse(
  readFileSync(join(HERE, "__fixtures__", "panel_prompts.json"), "utf8"),
) as {
  finalize: Array<{
    name: string; spec: Record<string, unknown>;
    planned: Array<{ entry_id: string }>; taken: Array<{ entry_id: string; role: string | null }>;
    has_refs: boolean; out: Record<string, unknown>;
  }>;
}).finalize;

test("the finalize fixture is not empty", () => {
  assert.ok(FINALIZE.length >= 6, `only ${FINALIZE.length}`);
});

for (const c of FINALIZE) {
  test(`golden · finalize · ${c.name}`, () => {
    assert.deepEqual(
      finalizeSpec(c.spec, c.planned, c.taken, c.has_refs) as Record<string, unknown>,
      c.out,
    );
  });
}

test("finalizeSpec does not mutate the spec it was handed", () => {
  // The pod builds a NEW dict at every step (`{**spec, ...}`); mutating here
  // would leave the caller's `prompt_spec` — which is also what a non-hosted
  // job sends to the pod — carrying a plate nobody asked for.
  const spec = { plate: "alt_angle", ref_subjects: [{ kind: "location", name: "X" }] };
  finalizeSpec(spec, [{ entry_id: "e" }], [{ entry_id: "e", role: "master" }], true);
  assert.deepEqual(spec, { plate: "alt_angle", ref_subjects: [{ kind: "location", name: "X" }] });
});

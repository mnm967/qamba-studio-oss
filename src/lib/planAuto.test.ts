import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  AUTO_STEPS, autoBlocked, autoForTier, autoSummary, planAutoFlags, toggleAuto,
  type AutoKey,
} from "./planAuto.ts";

const read = (p: string) =>
  fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const on = (...k: AutoKey[]) => new Set<AutoKey>(k);

/* ── the flags, pinned against the worker that reads them ────────────────── */

test("every flag is read by plan_storyboard, off the object it is sent on", () => {
  // THE SPLIT IS THE TRAP. Three of these are read off the payload and one off
  // `payload.brief`, and a flag sent on the wrong object is not an error — the
  // worker takes its default, which is TRUE, so the thing you switched off
  // generates anyway and nothing anywhere says so. That is precisely the
  // failure this whole card is meant to prevent, so it is pinned rather than
  // commented.
  const llm = read("worker/llm.py");
  for (const k of ["plan_refs", "ref_sheets", "scene_panels"]) {
    assert.ok(llm.includes(`payload.get("${k}"`),
              `plan_storyboard does not read payload.${k}`);
  }
  assert.ok(llm.includes('brief.get("voice_refs"'),
            "plan_storyboard reads voice_refs off the brief, not the payload");
  // ...and the shape this module returns puts each one where that says.
  const f = planAutoFlags(on("sheets", "panels", "voices"));
  assert.deepEqual(Object.keys(f.payload).sort(),
                   ["plan_refs", "ref_sheets", "scene_panels"]);
  assert.deepEqual(Object.keys(f.brief), ["voice_refs"]);
});

test("nothing on means the whole production block is skipped", () => {
  const f = planAutoFlags(on());
  assert.equal(f.payload.plan_refs, false);
  assert.equal(f.payload.ref_sheets, false);
  assert.equal(f.payload.scene_panels, false);
  assert.equal(f.brief.voice_refs, false);
});

test("voices alone still opens the outer gate", () => {
  // `plan_refs` is the gate the voice loop lives INSIDE, so "voices only" has
  // to send it true and the sheets flag false. Sending plan_refs off would
  // silently drop the one thing that was asked for.
  const f = planAutoFlags(on("voices"));
  assert.equal(f.payload.plan_refs, true);
  assert.equal(f.payload.ref_sheets, false);
  assert.equal(f.brief.voice_refs, true);
});

test("panels are never sent without the sheets they are composed over", () => {
  // Not reachable through `toggleAuto`, which is the point of having both:
  // this is the backstop for a set built any other way (a resumed session, a
  // saved draft from before the ladder existed).
  const f = planAutoFlags(on("panels"));
  assert.equal(f.payload.scene_panels, false);
});

/* ── the ladder ──────────────────────────────────────────────────────────── */

test("turning panels on turns sheets on with it", () => {
  assert.deepEqual([...toggleAuto(on(), "panels")].sort(), ["panels", "sheets"]);
});

test("turning sheets off takes panels with it rather than leaving a dead switch", () => {
  const next = toggleAuto(on("sheets", "panels", "voices"), "sheets");
  assert.deepEqual([...next], ["voices"]);
});

test("voices are independent of both", () => {
  assert.deepEqual([...toggleAuto(on(), "voices")], ["voices"]);
  assert.deepEqual([...toggleAuto(on("voices"), "voices")], []);
});

test("autoBlocked names the prerequisite and only for panels", () => {
  const panels = AUTO_STEPS.find((s) => s.id === "panels")!;
  assert.match(autoBlocked(panels, on()) ?? "", /reference sheets/);
  assert.equal(autoBlocked(panels, on("sheets")), null);
  for (const s of AUTO_STEPS.filter((x) => x.id !== "panels")) {
    assert.equal(autoBlocked(s, on()), null, `${s.id} should need nothing`);
  }
});

/* ── full auto ───────────────────────────────────────────────────────────── */

test("tier 1 draws everything whatever the switches say", () => {
  // It launches the render from the plan job, so it never reaches a step whose
  // button would draw these — an episode rendered with no sheets invents every
  // character per block.
  assert.deepEqual([...autoForTier(1, on())].sort(), ["panels", "sheets", "voices"]);
  assert.deepEqual([...autoForTier(2, on("voices"))], ["voices"]);
});

/* ── the copy, which is the whole control on a card this small ───────────── */

test("the summary says which step each un-drawn thing waits on", () => {
  assert.match(autoSummary(on()), /Nothing is drawn until you ask/);
  assert.match(autoSummary(on("sheets", "panels", "voices")),
               /Everything is drawn/);
  const one = autoSummary(on("sheets", "voices"));
  assert.match(one, /storyboard panels wait for you on the Storyboard step\./);
  const two = autoSummary(on("sheets"));
  assert.match(two, /steps\.$/, `two steps should pluralise: ${two}`);
});

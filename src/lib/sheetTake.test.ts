// The cast & world step's Generate draws EVERY view, not just the anchor.
//
// WHAT THIS PINS, and why each half is silent when it breaks.
//
// The wizard's sheets bar drew face + full_body for a character, master for a
// location and ref for a prop — the ANCHOR roles and nothing else. So a
// location came out of a one-shot with `Plates 1 · 1 angle` and a character
// with no turnaround, and nothing anywhere said a view was missing: the jobs
// it queued all succeeded, and the ones it never queued left no row. Measured
// on a real run — 7 face, 7 full_body, 6 master, 6 ref, no turnaround, no
// alt_angle, no detail, no atmosphere.
//
// The fix is a second rung: the anchor as its own `image_gen`, then one
// `orbit_sheet` (`sheet_mode: "coverage"`) DEPENDING on it, which is the H3
// take that produces every remaining view at once. Every assertion below is a
// way that rung silently does not happen.
//
// Source-parsed rather than executed, for `scoreTrack.test.ts`'s reason:
// `WizardModal.tsx` is a React component that reaches Supabase at import, so
// `node --test` cannot load it and the thing worth checking is the wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PY_KINDS, RENDER_KINDS, SHEET_MODEL_KEY } from "./desktopPlanner.ts";

const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const WIZARD = read("../components/modals/WizardModal.tsx");
const BAR = read("../components/modals/CastWorldRefsBar.tsx");
const ORBIT = read("../../worker/handlers/orbit.py");
const SHEET = read("../../worker/h3_sheet.py");

/** The body of a `const <name> = ...` arrow, to its closing `\n  };`. */
function fn(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = `);
  assert.ok(at > 0, `${name} is gone — this test is checking nothing`);
  const end = src.indexOf("\n  };", at);
  assert.ok(end > at, `${name} does not end where this parser expects`);
  return src.slice(at, end);
}

test("the take is queued from ONE place, for every kind", () => {
  // MEASURED: with the take queued inside each kind's own enqueuer, a Redraw
  // All came back with all six location masters and NOT ONE location take,
  // while every character got theirs — two call sites doing the same thing and
  // one of them silently not. One site means a kind cannot differ from another
  // kind: the enqueuers decide the ANCHORS, and whether a take follows is
  // decided once, from the entry's own kind.
  const calls = [...WIZARD.matchAll(/\bawait enqueueSheetTake\(/g)];
  assert.equal(calls.length, 1,
               "more than one place queues the take — that is how one kind "
               + "silently stopped getting one");
  const funnel = fn(WIZARD, "enqueueRefsFor");
  assert.match(funnel, /await enqueueSheetTake\(entry, anchors, lane\)/);
  // …and it is genuinely the funnel: both enqueuers hand their anchors back
  // rather than queueing anything themselves.
  for (const name of ["enqueueCharacterRefs", "enqueueEnvironmentRef"]) {
    assert.match(fn(WIZARD, name), /return (anchors|\[master\.id\]);/,
                 `${name} must return its anchors for the funnel to depend on`);
    assert.doesNotMatch(fn(WIZARD, name), /enqueueSheetTake/, name);
  }
  // Every path that draws an entry's sheets goes through it — the per-card
  // re-roll included, which had its own three-way branch and is the second
  // place the two could drift.
  assert.match(fn(WIZARD, "regenRefs"), /await enqueueRefsFor\(entry/);
  assert.match(fn(WIZARD, "generateMissingRefs"), /enqueueRefsFor\(e, lane\)/);
  assert.match(fn(WIZARD, "redrawAllRefs"), /enqueueRefsFor\(e, lane\)/);
});

test("a character's body sheet is composed OVER its face plate", () => {
  // Drawn independently the two are two text-to-image renders of one sentence
  // at different random seeds, and they came back as different people often
  // enough to be reported. `llm.sheet_job` has always anchored the body on the
  // face; this bar did not, and the face is what every other sheet of that
  // character derives from — so a body that does not match it is a second face
  // loose in the bible.
  const body = fn(WIZARD, "enqueueCharacterRefs");
  assert.match(body, /anchor_entry_id: c\.id, anchor_roles: \["face"\]/);
  // The plate is still QUEUED when this is written, so the anchor is the
  // late-bound form and `depends_on` is what makes sure it has landed by the
  // time `_resolve_anchor` reads it. Composing the prompt early would bake in
  // a reference set that does not exist yet.
  assert.match(body, /depends_on: \[anchors\[0\]\]/);
  // And the planner's own loop, so the two paths cannot drift apart again.
  const plan = read("../../worker/llm.py");
  assert.match(plan, /"anchor_entry_id": row\["id"\], "anchor_roles": \["face"\]/);
});

test("the take DEPENDS on the anchor rather than racing it", () => {
  // `handlers/orbit._sheet_refs` reads LIVE plates, so a take queued beside
  // its own anchor finds none and raises "has no reference plates to build a
  // sheet from" — which reads as the entry being empty rather than as a race.
  const body = fn(WIZARD, "enqueueSheetTake");
  assert.match(body, /depends_on/);
  assert.match(body, /sheet_mode: "coverage"/);
  assert.match(body, /kind: "orbit_sheet"/);
  // A PROP HAS NO COVERAGE SHAPE and the handler refuses the kind outright, so
  // queueing one would be a job that fails after being claimed.
  assert.match(body, /entry\.kind !== "character" && entry\.kind !== "environment"/);
  assert.match(ORBIT, /if entry\["kind"\] not in \("character", "environment"\)/);
});

test("a take that cannot be queued does not take the anchor down with it", () => {
  // The anchor plates are already in by the time this runs, so an entry whose
  // take was refused is exactly as drawn as it was before any of this existed.
  // Thrown, it would abort `Promise.all` and leave the rest of the bible
  // untouched — a bulk action that stops at whichever entry happened to be
  // first.
  const body = fn(WIZARD, "enqueueSheetTake");
  assert.match(body, /try \{/);
  assert.match(body, /catch \(e\)/);
});

test("the in-flight check reads BOTH ways an entry is named", () => {
  // `image_gen` puts the entry in `target.bible_entry_id` and `orbit_sheet`
  // takes a bare `entry_id`. Reading only the first reports an entry whose
  // anchors have landed and whose take is still queued as idle, and every
  // press of the bar queues another take of it.
  const body = fn(WIZARD, "sheetInFlight");
  assert.match(body, /bible_entry_id/);
  assert.match(body, /p\.entry_id === entryId/);
  // …and the query has to actually fetch them, or the check reads an empty
  // list and the same double-queue happens one layer up.
  assert.match(WIZARD, /\.in\("kind", \["image_gen", "tts", "orbit_sheet"\]\)/);
  assert.match(WIZARD, /j\.kind === "image_gen" \|\| j\.kind === "orbit_sheet"/);
});

test("both runners claim the kind, and they agree", () => {
  // A kind the browser routes to `local` that the Python refuses is a job that
  // queues, is claimed, and dies naming the render pod. `desktopPlanner.test`
  // pins the whole set; this names the one this feature added.
  assert.ok(PY_KINDS.has("orbit_sheet"));
  assert.ok(RENDER_KINDS.has("orbit_sheet"));
  const py = read("../../worker/plan_cli.py");
  assert.match(py, /"orbit_sheet": "comfy"/);
});

test("the lane is asked about the VIDEO map, not the image one", () => {
  // A sheet is a video take: `_h3_files` reads the video entry's `r2v` mode,
  // which is what a coverage take conditions its reference set on. The two
  // genuinely disagree — a laptop can hold Krea 2 and not the 32GB H3
  // reference checkpoint — so answering the image question for both would
  // route a take onto a lane that then refuses to resolve it.
  const planner = read("./desktopPlanner.ts");
  assert.match(planner, /renderableHere\(SHEET_MODEL_KEY, "video"\)/);
  assert.match(ORBIT, /r2v/);
  // The default the handler picks must be the one the browser asks about.
  assert.equal(SHEET_MODEL_KEY, "minimax-h3-pdd");
  assert.match(ORBIT, /"minimax-h3-pdd" if mode == "coverage"/);
});

test("the take really does fill the roles the bar stopped drawing", () => {
  // The claim the button's copy makes, checked against the plans themselves —
  // a role quietly dropped from `h3_sheet` would leave the bar promising a
  // turnaround nothing produces.
  //
  // A character's contact SHEET is the turnaround (six agreeing views at one
  // slot's cost, which `ref_plan_for` stages in place of full_body), so that
  // one is asserted where it is written rather than in the view table.
  for (const role of ["full_body", "side", "face"]) {
    assert.ok(SHEET.includes(`"${role}"`), `character views lost ${role}`);
  }
  assert.match(ORBIT, /"character":\s*"turnaround"/);
  // …and a LOCATION's contact sheet is `coverage`, which for a long time was
  // rendered, fetched and then DELETED with the temp files: the handler saved
  // a sheet only for a character, so a coverage take came out as eight loose
  // plates and the grid it had already drawn was thrown away. Nothing errored
  // — the sheet simply did not exist to be staged. Both halves are pinned:
  // the map having an entry for each kind, and the registration reading it
  // rather than a literal.
  assert.match(ORBIT, /"environment":\s*"coverage"/);
  assert.match(ORBIT, /"role": sheet_role/);
  for (const role of ["master", "alt_angle", "atmosphere", "detail"]) {
    assert.ok(SHEET.includes(`"${role}"`), `location views lost ${role}`);
  }
});

test("redraw-all clears before it queues, and skips what is mid-draw", () => {
  const body = fn(WIZARD, "redrawAllRefs");
  // `image_gen` writes its plate at slot 0 without retiring what is already
  // there, so an un-cleared role ends up with two rows at slot 0 and
  // `order=slot&limit=1` picks between them arbitrarily — which is the anchor
  // the take then conditions on.
  const detach = body.indexOf("detachRef");
  const queue = body.indexOf("enqueueRefsFor");
  assert.ok(detach > 0 && queue > detach,
            "the queue must come after the unlink, or the take reads a stale anchor");
  // Anything already mid-draw is left alone rather than queued twice — the
  // trap `pendingRefs` documents one bar up, where a queued sheet does not
  // create its link until it lands.
  assert.match(fn(WIZARD, "redrawableRefs"), /!sheetInFlight\(b\.id\)/);
  // Unlink, never delete: the pictures stay in the library and the recycle bin
  // stays the deliberate place to discard them.
  assert.doesNotMatch(body, /deleteAsset|binAsset/);
});

test("the redraw button is offered without waiting for something to be missing", () => {
  // The reasons to redraw are not "something is absent" — the style changed,
  // the model changed, or a sheet pass drew the anchors and none of the views.
  // Gating it on `n > 0` like the primary would hide it in exactly the state
  // it exists for.
  assert.match(BAR, /\{redrawable > 0 && onRedrawAll && \(/);
  assert.doesNotMatch(BAR, /n > 0 && redrawable/);
});

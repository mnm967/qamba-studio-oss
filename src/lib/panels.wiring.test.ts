// How a panel job is SHAPED, pinned by parsing the source.
//
// `panels.ts` reaches the database at import (db/jobs → supabase, whose
// extensionless specifier `node --test`'s strip-only loader cannot resolve),
// so these claims cannot be made by calling the functions — the same situation
// scoreTrack.test.ts and test_review_gate.py are in. They are worth pinning
// anyway: each one is a way for a hosted panel to quietly go back to needing
// the pod, or worse, to be queued somewhere nothing will claim it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "panels.ts"), "utf8").replace(/\r\n/g, "\n");
const JOBS = readFileSync(join(HERE, "db", "jobs.ts"), "utf8").replace(/\r\n/g, "\n");
const SCENE = readFileSync(
  join(HERE, "..", "components", "modals", "SceneEditorModal.tsx"), "utf8")
  .replace(/\r\n/g, "\n");

function fn(name: string): string {
  const i = SRC.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} is gone from panels.ts`);
  const j = SRC.indexOf("\n}\n", i);
  return SRC.slice(i, j > 0 ? j : SRC.length);
}

test("both panel queuers go through ONE payload builder", () => {
  // Two copies of "what does a panel job carry" is how one of them drifts —
  // and a payload field the runner does not expect is a job that queues and
  // then fails, minutes later, on a machine nobody is watching.
  for (const f of ["queueBeatPanel", "queueBeatPanelAlternates"]) {
    assert.match(fn(f), /panelJobPayload\(spec, anchors, ctx\)|\.\.\.composed/,
      `${f} builds its own payload instead of using panelJobPayload`);
    assert.doesNotMatch(fn(f), /prompt_spec:/,
      `${f} hardcodes prompt_spec instead of going through the builder`);
    // a LINE beginning `anchors,` is the payload field; `anchors` mid-line is
    // the argument being handed to the builder, which is the point.
    assert.doesNotMatch(fn(f), /^\s*anchors,/m,
      `${f} hardcodes anchors — the payload is never literal`);
  }
});

test("a panel job is a SPEC and its anchors, composed on the machine that renders", () => {
  // `image_prompt` picks the prompt dialect off the family that is FINALLY
  // chosen — the reference fallback can still change it — and resolves the
  // late-bound anchors a plan's own sheets hang on. Composing in the browser
  // instead would draw a sheet that renders perfectly well and is not the
  // sheet the pipeline would have drawn, after which a character's identity
  // anchor depends on which side composed it.
  assert.match(fn("panelJobPayload"), /return \{ prompt_spec: spec, anchors \};/);
});

test("panels.ts never picks the local lane itself", () => {
  // `enqueueJob` owns the correction and makes exactly this decision for every
  // job in the app. A second copy of the rule here is the one that goes stale,
  // and getting it wrong strands the job on a lane nothing serves.
  assert.doesNotMatch(SRC, /lane: "local"/);
  assert.match(JOBS, /j\.lane !== "local" && planeIsLocal\(\)/,
    "enqueueJob's lane correction moved — panels.ts is relying on it");
});


/* ── choosing a shot's picture, rather than only drawing or uploading one ───
 *
 * The scene editor's picture control was a bare file input whose own tooltip
 * read "Upload or pick from library" — so a panel drawn anywhere else, a frame
 * saved off the timeline, or a reference already in the library could not be
 * put on a shot at all. These pin the two halves that are silent when they go
 * wrong; the rule itself (which slot, which start frame) is `beatStillMeta`,
 * unit-tested in panelSpec.test.ts. */

const sceneFn = (name: string): string => {
  const i = SCENE.indexOf(`const ${name} = `);
  assert.ok(i > 0, `${name} is gone from SceneEditorModal`);
  const j = SCENE.indexOf("\n  };", i);
  const k = SCENE.indexOf("\n\n  ", i);
  const end = j > 0 && (k < 0 || j < k) ? j : k;
  return SCENE.slice(i, end > i ? end : SCENE.length);
};

test("the scene editor can choose a shot's picture from the library", () => {
  assert.match(SCENE, /<AssetPickerModal/,
               "the library picker is gone — the control is back to upload-only");
  assert.match(SCENE, /setPickFor\(b\)/, "nothing opens the picker from a beat row");
  assert.doesNotMatch(SCENE, /type="file"[\s\S]{0,200}still_asset_id/,
                      "a raw file input writes the beat still again");
});

test("putting a picture on a shot marks its blocks stale", () => {
  // The picture rides into the render through `ref_plan_for`, so this changes
  // what the block looks like. The upload path never marked it — an edit that
  // changes the render with nothing saying to re-render is the failure the
  // director's tools note calls the main way this goes wrong, and CLEARING a
  // picture has always marked it, so the two disagreed.
  assert.match(sceneFn("setBeatStill"), /markSceneBlocksStale\(scene\.id\)/);
});

test("it writes the slot through the shared rule, not by hand", () => {
  // A hand-rolled `{...b.meta, still_asset_id}` is how the start-frame drop
  // gets left out again — it reads correct, and the block then opens on a
  // picture no surface is showing.
  const f = sceneFn("setBeatStill");
  assert.match(f, /beatStillMeta\(b, assetId\)/);
  assert.doesNotMatch(f, /still_asset_id:/,
                      "setBeatStill builds the meta itself instead of using beatStillMeta");
});

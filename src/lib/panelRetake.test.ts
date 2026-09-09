// Every assertion here is a failure that produces a plausible-looking picture.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COPY, altSeeds, defaultPanelMode, defaultSeedMode, editBlocker, editRefWarning,
  footerSummary, heldSeed, panelJobs, promotedNote, queueBlocker, refCapacity,
  rollSeed, seedForRound, targetFor,
} from "./panelRetake.ts";

const QWEN = {
  id: "qwen-edit-local", display_name: "Qwen-Image-Edit 2511", family: "qwen",
  modes: ["t2i", "r2i", "edit"], capabilities: { multiRef: 3 },
};
const H3 = {
  id: "h3-image-local", display_name: "MiniMax H3 · image", family: "minimax-h3",
  modes: ["t2i", "r2i", "edit"], capabilities: { multiRef: 9 },
};
const ANIMA = {
  id: "hikari-anima-local", display_name: "Hikari Anima 1.0", family: "anima",
  modes: ["t2i"], capabilities: {},
};

const JOB = {
  mode: "redraw" as const, sourceAssetId: "panel-1", beatId: "beat-1",
  text: " a wide shot ", refAssetIds: ["face-1", "loc-1"], seed: 4242,
  width: 1280, height: 704, rolls: 1, modelKey: "krea2", label: "SCENE b3 · panel",
};

test("an edit needs a model that declares the mode, not merely references", () => {
  assert.equal(editBlocker({ hasSource: true, model: QWEN, modelName: "Qwen" }), "");
  // Anima takes no references and does not edit: the worker would compose a
  // new frame from an empty latent and hand back a different picture.
  const why = editBlocker({ hasSource: true, model: ANIMA, modelName: "Hikari Anima 1.0" });
  assert.match(why, /can't rework one/);
  assert.match(why, /Hikari Anima 1\.0/);
});

test("a model with references but no edit mode is still refused", () => {
  const composeOnly = { ...QWEN, modes: ["t2i", "r2i"] };
  assert.notEqual(editBlocker({ hasSource: true, model: composeOnly, modelName: "X" }), "");
});

test("a model that only edits still has one reference slot", () => {
  // GenComposer's last clause: the picture being edited IS a reference, so a
  // row declaring `edit` and no multiRef must not report a capacity of 0 —
  // the grid would then refuse to hold the source it is about to edit.
  assert.equal(refCapacity({ id: "gpt", modes: ["t2i", "edit"], capabilities: { edit: true } }), 1);
  assert.equal(refCapacity(null), 0);
  assert.equal(editBlocker({
    hasSource: true, modelName: "GPT Image",
    model: { id: "gpt", modes: ["t2i", "edit"], capabilities: { edit: true } },
  }), "");
});

test("with nothing drawn there is nothing to hold", () => {
  assert.match(editBlocker({ hasSource: false, model: QWEN, modelName: "Qwen" }),
               /has to exist/);
});

test("the modal opens on REDRAW even when the panel is editable", () => {
  // Deliberately the opposite of the video side. The button that opens this
  // says Redraw; opening on Edit would change what it does.
  assert.equal(defaultPanelMode(), "redraw");
});

test("a redraw rolls the seed and an edit holds it", () => {
  assert.equal(defaultSeedMode("redraw"), "roll");
  assert.equal(defaultSeedMode("edit"), "hold");
});

test("an edit rolls when the picture recorded no seed to hold", () => {
  // Otherwise the control reads `seed —` and rolls anyway — a control
  // describing something other than what happens.
  assert.equal(defaultSeedMode("edit", false), "roll");
  assert.equal(defaultSeedMode("redraw", false), "roll");
});

test("the seed a hold means is the one the panel rendered at", () => {
  assert.equal(heldSeed({ seed: 8412 }), 8412);
  // An uploaded picture has none. Inventing one and calling it the panel's is
  // worse than rolling.
  assert.equal(heldSeed({}), null);
  assert.equal(heldSeed(null), null);
  assert.equal(heldSeed({ seed: "8412" }), null);
});

test("a redraw always writes a seed, because 0 is what the panel already is", () => {
  const [job] = panelJobs(JOB);
  assert.equal(job.seed, 4242);
  assert.ok("seed" in job);
});

test("the source LEADS the references on an edit — the worker edits ref[0]", () => {
  const [job] = panelJobs({ ...JOB, mode: "edit", text: "open the shutter" });
  assert.deepEqual(job.ref_asset_ids, ["panel-1", "face-1", "loc-1"]);
  assert.equal(job.mode, "edit");
});

test("a source already in the reference list is not staged twice", () => {
  const [job] = panelJobs({
    ...JOB, mode: "edit", text: "x", refAssetIds: ["face-1", "panel-1"],
  });
  assert.deepEqual(job.ref_asset_ids, ["panel-1", "face-1"]);
});

test("a redraw does not send `mode`, so it composes rather than edits", () => {
  const [job] = panelJobs(JOB);
  assert.equal(job.mode, undefined);
  assert.equal(job.denoise, undefined);
  assert.deepEqual(job.ref_asset_ids, ["face-1", "loc-1"]);
});

test("`prompt_spec` is never sent — it would discard what was typed", () => {
  for (const mode of ["redraw", "edit"] as const) {
    const [job] = panelJobs({ ...JOB, mode, text: "something" });
    assert.equal(job.prompt_spec, undefined);
    assert.equal(job.anchors, undefined);
  }
});

test("the prompt is trimmed but otherwise verbatim", () => {
  assert.equal(panelJobs(JOB)[0].prompt, "a wide shot");
});

test("one roll replaces the panel; several land as alternates", () => {
  assert.equal(targetFor(1), "panel");
  assert.equal(targetFor(5), "panel_alt");
  assert.equal(panelJobs(JOB)[0].target.as, "panel");
  const round = panelJobs({ ...JOB, rolls: 5 });
  assert.equal(round.length, 5);
  assert.ok(round.every((j) => j.target.as === "panel_alt"));
  assert.ok(round.every((j) => j.target.beat_id === "beat-1"));
});

test("every roll in a round gets its own seed", () => {
  const seeds = panelJobs({ ...JOB, rolls: 5 }).map((j) => j.seed);
  assert.equal(new Set(seeds).size, 5);
  assert.deepEqual(seeds, altSeeds(4242, 5));
});

test("a roll's label says which of the round it is", () => {
  assert.equal(panelJobs(JOB)[0].label, "SCENE b3 · panel · redraw");
  assert.equal(panelJobs({ ...JOB, rolls: 3 })[1].label, "SCENE b3 · panel · redraw 2/3");
  assert.equal(panelJobs({ ...JOB, mode: "edit", rolls: 1 })[0].label,
               "SCENE b3 · panel · edit");
});

test("a hosted row carries no model_key — one the worker can't resolve fails", () => {
  assert.equal(panelJobs({ ...JOB, modelKey: null })[0].model_key, undefined);
  assert.equal(panelJobs(JOB)[0].model_key, "krea2");
});

test("denoise rides an edit only", () => {
  assert.equal(panelJobs({ ...JOB, mode: "edit", text: "x", denoise: 0.4 })[0].denoise, 0.4);
  assert.equal(panelJobs({ ...JOB, denoise: 0.4 })[0].denoise, undefined);
});

test("H3 warns that an added reference cancels the edit", () => {
  // `edit_one = editing and len(ref_names) == 1` — with more staged it drops
  // back to the ref2va compose path, and the only trace is a journal line.
  assert.match(editRefWarning(H3, 1), /one picture only/);
  assert.equal(editRefWarning(H3, 0), "");
  assert.equal(editRefWarning(QWEN, 2), "");
});

test("the queue refuses an edit with no instruction", () => {
  assert.match(queueBlocker({ mode: "edit", text: "  ", editWhy: "" }),
               /re-renders the panel as it is/);
  assert.equal(queueBlocker({ mode: "edit", text: "open the shutter", editWhy: "" }), "");
  assert.match(queueBlocker({ mode: "redraw", text: "", editWhy: "" }), /empty/);
  assert.equal(queueBlocker({ mode: "redraw", text: "a wide shot", editWhy: "" }), "");
});

test("an edit blocked by the model is refused before it costs a claim", () => {
  assert.equal(queueBlocker({ mode: "edit", text: "x", editWhy: "no edit mode" }), "no edit mode");
  // …and the same model does not block a redraw.
  assert.equal(queueBlocker({ mode: "redraw", text: "x", editWhy: "no edit mode" }), "");
});

test("the footer names what is actually being staged", () => {
  assert.equal(
    footerSummary({ mode: "redraw", refCount: 3, rolls: 5, seedMode: "roll",
                    seed: null, width: 1280, height: 704 }),
    "3 refs · 5 rolls · new seed · 1280×704");
  assert.equal(
    footerSummary({ mode: "edit", refCount: 1, rolls: 1, seedMode: "hold",
                    seed: 8412, width: 1280, height: 704, denoise: 0.55 }),
    "panel + 1 ref · seed 8412 held · changes 55% · 1280×704");
  // An edit with nothing added still stages the panel itself.
  assert.match(
    footerSummary({ mode: "edit", refCount: 0, rolls: 1, seedMode: "hold",
                    seed: 1, width: 8, height: 8 }),
    /^panel · /);
});

test("promoting onto a beat with a user still says what it did and didn't do", () => {
  assert.match(promotedNote(true), /still outranks it/);
  assert.match(promotedNote(false), /panel now/);
});

test("each mode's copy names its own field, because they are not the same field", () => {
  // Redraw's box IS the prompt (sent verbatim); edit's is an instruction.
  assert.equal(COPY.redraw.fieldLabel, "Prompt");
  assert.match(COPY.edit.fieldLabel, /change/);
  assert.notEqual(COPY.redraw.primary(1), COPY.edit.primary(1));
  assert.match(COPY.redraw.primary(5), /5/);
});


test("a ROLL is random, not derived from the beat", () => {
  // `seedBase(beat)` advances only with the alternates already on the beat,
  // and a single roll writes `panel`, not `panel_alts` — so a derived seed
  // would repeat on the next press and hand back the identical picture, which
  // is the bug the seed exists to fix.
  let n = 0;
  const rnd = () => [0.1, 0.5][n++] ?? 0.9;
  const a = seedForRound({ seedMode: "roll", typed: null, held: 8412, rnd });
  const b = seedForRound({ seedMode: "roll", typed: null, held: 8412, rnd });
  assert.notEqual(a, b);
  assert.notEqual(a, 8412);
});

test("a HOLD takes the panel's own seed, and rolls when there is none", () => {
  assert.equal(seedForRound({ seedMode: "hold", typed: null, held: 8412 }), 8412);
  const rolled = seedForRound({ seedMode: "hold", typed: null, held: null, rnd: () => 0.5 });
  assert.equal(rolled, rollSeed(() => 0.5));
});

test("a typed seed outranks both modes", () => {
  assert.equal(seedForRound({ seedMode: "roll", typed: 7, held: 8412 }), 7);
  assert.equal(seedForRound({ seedMode: "hold", typed: 7, held: 8412 }), 7);
});

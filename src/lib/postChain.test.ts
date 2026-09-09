// `postChain.ts` and `worker/post_chain.py` are twins: the browser writes the
// chain and picks the render's LANE from it, the worker reads the same value
// and runs the passes. Every way they can disagree is silent — an op id the
// worker doesn't know is a switch that renders nothing, a `stage` that drifts
// puts grain under the upscaler, and a GPU op the browser thinks is cheap
// queues a ComfyUI render on the cpu lane, where it loads beside a live
// generation.
//
// Same treatment h3timing.test.ts gives h3_timing.py: parse the Python, demand
// the two agree.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  activeOps, chainNeedsGpu, describeChain, normalizeChain, normalizePostOptions,
  offeredOps, POST_OP, POST_OPS, POST_ORDER, POST_OPTIONS_DEFAULT,
  REFINE_SIGMA_PRESETS, REFINE_SIZES,
  chainNeedsEngine, resolvePost, tunableOps, UPSCALE_MODELS, type PostChain,
  chainConflict, EXCLUSIVE, GRADE_METHODS, H3_FACE_CANVASES, toggleOp,
} from "./postChain.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const py = fs.readFileSync(path.join(ROOT, "worker", "post_chain.py"), "utf8");

// AN OP ID MAY CONTAIN A DIGIT, and this parser could not see one. It read
// `[a-z_]+`, so `"h3_facefix"` matched nothing and was silently DROPPED from
// the Python side of every comparison below — which does not fail loudly, it
// makes the two sides look like they disagree about an op the file plainly
// declares. Worse in the other direction: an op present in Python and absent
// from TypeScript would have been invisible to the very test that exists to
// catch it. `[a-z0-9_]`.
const ID = /"([a-z0-9_]+)"/g;

const pyList = (name: string) => {
  const m = py.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  assert.ok(m, `${name} not found in post_chain.py`);
  return [...m![1].matchAll(ID)].map((x) => x[1]);
};

/* ── the twins agree ─────────────────────────────────────────────────────── */

test("both sides declare the same ops, in the same order", () => {
  assert.deepEqual(pyList("POST_ORDER"), POST_ORDER);
  assert.deepEqual(POST_OPS.map((o) => o.id), POST_ORDER);
});

test("both sides agree which ops drive ComfyUI", () => {
  const m = py.match(/GPU_OPS\s*=\s*\{([^}]*)\}/);
  assert.ok(m, "GPU_OPS not found in post_chain.py");
  const pyGpu = new Set([...m![1].matchAll(ID)].map((x) => x[1]));
  const tsGpu = new Set(POST_OPS.filter((o) => o.gpu).map((o) => o.id));
  assert.deepEqual([...pyGpu].sort(), [...tsGpu].sort());
});

test("both sides agree which side of the normalize step each op runs on", () => {
  const m = py.match(/POST_STAGE\s*=\s*\{([^}]*)\}/);
  assert.ok(m, "POST_STAGE not found in post_chain.py");
  const pyStage = Object.fromEntries(
    [...m![1].matchAll(/"([a-z0-9_]+)":\s*"(source|finish)"/g)].map((x) => [x[1], x[2]]));
  assert.deepEqual(pyStage, Object.fromEntries(POST_OPS.map((o) => [o.id, o.stage])));
});

test("grain finishes last — applied before the fit it would be rescaled to mush", () => {
  assert.equal(POST_ORDER[POST_ORDER.length - 1], "grain");
  assert.equal(POST_OPS.find((o) => o.id === "grain")!.stage, "finish");
});

/* ── inherit vs custom ───────────────────────────────────────────────────── */

test("null inherits the project and {} does not", () => {
  // The whole reason clips.post is nullable: a clip that wants nothing has to
  // survive a project-wide "everything gets grain".
  assert.deepEqual(resolvePost(null, { grain: true }), { mode: "inherit", chain: { grain: true } });
  assert.deepEqual(resolvePost({}, { grain: true }), { mode: "custom", chain: {} });
});

test("a custom chain replaces the project's rather than merging with it", () => {
  assert.deepEqual(resolvePost({ upscale: true }, { grain: true }),
                   { mode: "custom", chain: { upscale: true } });
});

test("unknown and false keys are dropped", () => {
  // A typo that reads as empty is a switch that looks on and renders off.
  assert.deepEqual(normalizeChain({ grian: true, grain: false }), {});
  assert.deepEqual(normalizeChain({ grain: true, nope: true }), { grain: true });
});

test("anything that is not an object reads as inherit", () => {
  for (const v of [null, undefined, [], "grain", 3]) {
    assert.equal(normalizeChain(v), null);
  }
});

test("ops run in canon order whatever order the row lists them", () => {
  assert.deepEqual(activeOps({ grain: true, upscale: true, interpolate: true } as PostChain),
                   ["upscale", "interpolate", "grain"]);
});

/* ── the lane ────────────────────────────────────────────────────────────── */

test("needsGpu is about ComfyUI, not about cost", () => {
  // color_match FLIPPED to true on 2026-08-23 and the test's own name is why.
  // It used to be a stub that raised; it now runs on KJNodes' ColorMatch, so
  // it occupies the serial ComfyUI queue even though colour transfer loads no
  // model and touches no GPU. The question this answers is "does the render
  // drive ComfyUI", and for this pass the answer changed.
  assert.equal(chainNeedsGpu({ grain: true }), false);
  assert.equal(chainNeedsGpu({ color_match: true }), true);
  assert.equal(chainNeedsGpu({ upscale: true }), true);
  assert.equal(chainNeedsGpu({ ltx_refine: true }), true);
  assert.equal(chainNeedsGpu({}), false);
  assert.equal(chainNeedsGpu(null), false);
});

test("grain is the only pass that runs without ComfyUI", () => {
  // Pinned as a set rather than one-by-one: the trap is adding a pass that
  // shells out to a graph and leaving gpu:false on it, which puts a ComfyUI
  // job on the cpu lane beside a live render.
  assert.deepEqual(POST_OPS.filter((o) => !o.gpu).map((o) => o.id), ["grain"]);
});

test("one inheriting clip is enough to make the whole render wait for the engine", () => {
  // The trap this pins: the clip's own column is null, so nothing on the row
  // says GPU — the project's default is where it comes from.
  assert.equal(chainNeedsEngine([{ post: null }, { post: {} }], { upscale: true }), true);
  assert.equal(chainNeedsEngine([{ post: {} }], { upscale: true }), false);
  assert.equal(chainNeedsEngine([{ post: { grain: true } }], {}), false);
  assert.equal(
    chainNeedsEngine([{ post: { grain: true } }, { post: { facefix: true } }], {}), true);
});

test("a timeline with no chain anywhere needs no engine", () => {
  assert.equal(chainNeedsEngine([{ post: null }, { post: null }], {}), false);
  assert.equal(chainNeedsEngine([], null), false);
});

/* ── the summary line ────────────────────────────────────────────────────── */

test("describeChain reads as a look, not as job kinds", () => {
  assert.equal(describeChain({}), "None");
  assert.equal(describeChain(null), "None");
  assert.equal(describeChain({ grain: true, upscale: true }), "Upscale + Film Grain");
});


/* ─────────────────────────────────── the tuning vocabulary, both ways ──── */
// A THIRD pair of files to keep in step, and the failure is the same shape as
// the one at the top of this file: a size mode or a sigma preset the worker
// does not know falls back to a DIFFERENT render, and the panel goes on naming
// the one you picked. The keys live in two Python modules, so both are read.
const renderPy = fs.readFileSync(
  path.join(ROOT, "worker", "handlers", "render.py"), "utf8");
const graphsPy = fs.readFileSync(path.join(ROOT, "worker", "graphs.py"), "utf8");

/** The string keys of a `NAME = {...}` dict literal. */
const pyDictKeys = (src: string, name: string) => {
  const m = src.match(new RegExp(`^${name}\\s*=\\s*\\{([\\s\\S]*?)^\\}`, "m"));
  assert.ok(m, `${name} not found`);
  return [...m![1].matchAll(/^\s*"([^"]*)":/gm)].map((x) => x[1]);
};
/** The string members of a `NAME = (...)` tuple literal. */
const pyTuple = (src: string, name: string) => {
  const m = src.match(new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, "m"));
  assert.ok(m, `${name} not found`);
  return [...m![1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
};

test("the refine's size modes are the ones the worker acts on", () => {
  assert.deepEqual(REFINE_SIZES.map((s) => s.id).sort(),
                   pyTuple(renderPy, "REFINE_SIZES").sort());
});

test("every sigma preset the panel offers resolves to a schedule", () => {
  // "" is the browser's own "let the size choose" and is deliberately NOT a
  // preset — the worker reads it as "send no override", which is what every
  // render before this feature did.
  const offered = REFINE_SIGMA_PRESETS.map((s) => s.id).filter(Boolean);
  const known = pyDictKeys(graphsPy, "LTX_REFINE_PRESETS");
  assert.deepEqual(offered.sort(), known.sort());
  assert.equal(REFINE_SIGMA_PRESETS[0].id, "", "the default rung must come first");
});

test("every restore checkpoint the panel offers is a key the worker can map", () => {
  assert.deepEqual(UPSCALE_MODELS.map((m) => m.id).sort(),
                   pyDictKeys(graphsPy, "SEEDVR2_MODELS").sort());
});

test("no checkpoint FILENAME reaches the browser", () => {
  // The `style_loras` rule: the browser sends a key, the worker owns the name
  // on disk. A settings row holding a filename is a render that dies inside
  // ComfyUI on an enum the day the box is re-fetched.
  const blob = JSON.stringify([UPSCALE_MODELS.map((m) => m.id),
                               REFINE_SIGMA_PRESETS.map((s) => s.id)]);
  assert.ok(!/safetensors/.test(blob));
});

test("the defaults are what the worker defaults to, so an untouched project is unchanged", () => {
  const py = pyDictKeys(renderPy, "POST_OPTS");
  // The browser's keys are the SETTINGS keys (post_*) and the worker's are the
  // short names it uses internally; the pairing is what has to hold.
  assert.deepEqual(py.sort(), ["grade_method", "h3face_canvas", "h3face_denoise",
                              "refine_cfg", "refine_sigmas", "refine_size",
                              "upscale_model"]);
  const m = renderPy.match(/^POST_OPTS\s*=\s*\{([\s\S]*?)^\}/m)!;
  assert.match(m[1], /"refine_size":\s*"native"/);
  assert.match(m[1], /"refine_sigmas":\s*""/);
  assert.match(m[1], /"refine_cfg":\s*1\.0/);
  assert.match(m[1], /"upscale_model":\s*"3b"/);
  assert.match(m[1], /"h3face_canvas":\s*"768"/);
  assert.match(m[1], /"h3face_denoise":\s*0\.4/);
  assert.match(m[1], /"grade_method":\s*"mkl"/);
  assert.deepEqual(POST_OPTIONS_DEFAULT, {
    post_refine_size: "native", post_refine_sigmas: "",
    post_refine_cfg: 1, post_upscale_model: "3b", post_grade_method: "mkl",
    post_h3face_canvas: "768", post_h3face_denoise: 0.4,
  });
});

test("an unreadable option falls back to the default, never to a neighbour", () => {
  assert.deepEqual(normalizePostOptions(undefined), POST_OPTIONS_DEFAULT);
  assert.deepEqual(normalizePostOptions({
    post_refine_size: "enormous", post_refine_sigmas: "crunchy",
    post_refine_cfg: "loud", post_upscale_model: "70b",
    post_grade_method: "vibes",
  }), POST_OPTIONS_DEFAULT);
  // Out of range is CLAMPED rather than dropped: a number somebody typed is a
  // direction, where a word nobody recognises is not.
  assert.equal(normalizePostOptions({ post_refine_cfg: 9 }).post_refine_cfg, 3);
  assert.equal(normalizePostOptions({ post_refine_cfg: 0.2 }).post_refine_cfg, 1);
});

test("a real value survives the round trip", () => {
  assert.deepEqual(normalizePostOptions({
    post_refine_size: "fit", post_refine_sigmas: "faithful",
    post_refine_cfg: 1.5, post_upscale_model: "7b-sharp",
    post_grade_method: "reinhard_lab_gpu",
    post_h3face_canvas: "512", post_h3face_denoise: 0.25, unrelated: 1,
  }), {
    post_refine_size: "fit", post_refine_sigmas: "faithful",
    post_refine_cfg: 1.5, post_upscale_model: "7b-sharp",
    post_grade_method: "reinhard_lab_gpu",
    post_h3face_canvas: "512", post_h3face_denoise: 0.25,
  });
});

test("every grade transfer the panel offers is one the worker builds", () => {
  assert.deepEqual(GRADE_METHODS.map((m) => m.id).sort(),
                   pyTuple(graphsPy, "COLOR_MATCH_METHODS").sort());
  // MKL leads, because it is the default on both sides and the row reads in
  // the order someone would try them.
  assert.equal(GRADE_METHODS[0].id, "mkl");
});

test("every post setting the worker READS has something that WRITES it", () => {
  // THE BUG CLASS THIS EXISTS FOR. `post_ref_asset_id` was read by the worker,
  // named in a tooltip and written by nothing — Color Match was a switch whose
  // only outcome was a failed render. `post_ref_strength` was the same one
  // field along and lasted longer, because its default is 1.0: nothing failed,
  // every grade this studio rendered just silently ran at full strength with
  // no way to say otherwise.
  const keys = [...renderPy.matchAll(/st\.get\("(post_[a-z0-9_]+)"\)/g)]
    .map((m) => m[1]);
  assert.ok(keys.length >= 8, `only found ${keys.length} settings reads`);
  const settingsTs = fs.readFileSync(
    path.join(ROOT, "src", "lib", "projectSettings.ts"), "utf8");
  // COMMENTS ARE STRIPPED AND THE MATCH IS `key:`, an object property being
  // written. Both halves are load-bearing: every one of these keys is NAMED in
  // a doc comment somewhere (that is how the dead ones stayed plausible), so a
  // plain substring search over these files passes for a setting nothing
  // writes — checked by deleting the write and watching the test still pass.
  const strip = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const surfaces = ["components/shell/ContextPanel.tsx",
                    "components/modals/RenderSettingsModal.tsx",
                    "components/ui/PostRefPicker.tsx",
                    "components/ui/PostOptionsPanel.tsx",
                    "routes/Workspace.tsx", "lib/postChain.ts"]
    .map((f) => strip(fs.readFileSync(path.join(ROOT, "src", f), "utf8"))).join("\n");
  for (const k of new Set(keys)) {
    assert.ok(settingsTs.includes(k),
      `the worker reads ${k} and projectSettings.ts does not declare it`);
    assert.match(surfaces, new RegExp(`\\b${k}\\s*:`),
      `the worker reads ${k} and no surface WRITES it (a doc comment is not a write)`);
  }
});

test("the grade strength is clamped the same on both sides", () => {
  // The control and the render must not disagree about a value typed into the
  // row by hand. The worker clamps 0..1; so does resolveDefaults.
  assert.match(renderPy, /max\(0\.0,\s*min\(1\.0,\s*strength\)\)/);
  const settingsTs = fs.readFileSync(
    path.join(ROOT, "src", "lib", "projectSettings.ts"), "utf8");
  assert.match(settingsTs, /post_ref_strength:\s*Math\.max\(0,\s*Math\.min\(1,/);
});

test("a refused transfer is offered by neither side, and the reason survives", () => {
  // The node goes on declaring `hm-mvgd-hm` — it measured unusable on this
  // studio's footage (blotchy faces), and the gap metric does NOT catch that,
  // so the record of the decision is the only thing standing between the next
  // reader and putting it back.
  const refused = pyDictKeys(graphsPy, "COLOR_MATCH_REFUSED");
  assert.ok(refused.includes("hm-mvgd-hm"));
  const offered = GRADE_METHODS.map((m) => m.id) as string[];
  for (const id of refused) {
    assert.ok(!offered.includes(id), `${id} is refused and still offered`);
  }
  // And the browser keeps its own note, so a reader here is not left thinking
  // the omission was an oversight. (`py` above is post_chain.py — this one has
  // to read the TS module's own source.)
  const chainTs = fs.readFileSync(path.join(ROOT, "src", "lib", "postChain.ts"), "utf8");
  assert.match(chainTs, /NOT OFFERED: `hm-mvgd-hm`/);
});

test("the learned-LUT grade is offered and is not a ColorMatch method", () => {
  const row = GRADE_METHODS.find((m) => m.id === "vcg");
  assert.ok(row, "vcg is not offered");
  // It needs weights the render engine may not have, so the row has to say
  // so — the same rule the ColorMatchV2-only row follows. In the user's
  // words, not the pod's fetch target: the hint is picker copy.
  assert.match(row!.hint, /needs the pack .*checkpoint/s);
  // The worker keeps it OUT of the V2-only set: it is not a ColorMatch method
  // at all, and conflating the two produces an error naming a KJNodes update
  // that would not help.
  assert.ok(!pyTuple(graphsPy, "COLOR_MATCH_V2_ONLY").includes("vcg"));
});

test("the ColorMatchV2-only method is named as such on both sides", () => {
  // The browser cannot know which node a pod has, so it OFFERS the method and
  // the worker refuses it by name where it cannot be served. What has to hold
  // is that the hint says so — a row that reads like every other one, on the
  // one method that can fail, is how a render fails for a reason nobody
  // expected.
  const v2only = pyTuple(graphsPy, "COLOR_MATCH_V2_ONLY");
  assert.deepEqual(v2only, ["reinhard_lab_gpu"]);
  for (const id of v2only) {
    const row = GRADE_METHODS.find((m) => m.id === id);
    assert.ok(row, `${id} is offered by the worker and not by the panel`);
    assert.match(row!.hint, /ColorMatchV2/);
  }
  // And the fallback order is newest-first, or a pod with both renders on the
  // deprecated one forever.
  assert.deepEqual(pyTuple(graphsPy, "COLOR_MATCH_NODES"),
                   ["ColorMatchV2", "ColorMatch"]);
});

test("the grade's tuning row shows only when the grade is on", () => {
  assert.ok(tunableOps({ color_match: true } as PostChain).has("color_match"));
  assert.ok(!tunableOps({ grain: true } as PostChain).has("color_match"));
});

test("every face canvas the panel offers is a key the worker can map", () => {
  assert.deepEqual(H3_FACE_CANVASES.map((c) => c.id).sort(),
                   pyDictKeys(graphsPy, "H3_FACE_CANVASES").sort());
  // The MEASURED default leads the row, and both languages agree on it. `auto`
  // was the default for one afternoon and picked 512 on the small faces this
  // pass exists for — the arm that came back softest.
  assert.equal(H3_FACE_CANVASES[0].id, "768");
  assert.match(graphsPy, /H3_FACE_CANVAS_DEFAULT\s*=\s*"768"/);
});

/* ────────────────────────────────── passes that exclude each other ─────── */

test("both sides refuse the same pairs", () => {
  // Declared twice because both sides act on it: the toggles resolve it so the
  // combination cannot be set, and the render refuses it so a row written
  // before that (or by anything else) fails by name rather than rewriting a
  // face twice.
  const m = py.match(/EXCLUSIVE\s*=\s*\[([\s\S]*?)^\]/m);
  assert.ok(m, "EXCLUSIVE not found in post_chain.py");
  const pyPairs = [...m![1].matchAll(/\(\(([^)]*)\)/g)]
    .map((x) => [...x[1].matchAll(ID)].map((y) => y[1]).sort());
  assert.deepEqual(pyPairs, EXCLUSIVE.map((e) => [...e.ops].sort()));
  assert.ok(pyPairs.length > 0, "a vacuous comparison would pass on an empty file");
});

test("the two face passes cannot both be on", () => {
  assert.ok(chainConflict({ facefix: true, h3_facefix: true }));
  assert.equal(chainConflict({ h3_facefix: true, grain: true }), null);
  assert.equal(chainConflict({ facefix: true }), null);
  assert.equal(chainConflict(null), null);
});

test("turning one face pass on turns the other off", () => {
  // In the TOGGLES and not only in the render: a switch you can set to a
  // combination the worker refuses is a render that fails minutes later for a
  // reason the screen showed no sign of.
  assert.deepEqual(toggleOp({ facefix: true }, "h3_facefix"), { h3_facefix: true });
  assert.deepEqual(toggleOp({ h3_facefix: true }, "facefix"), { facefix: true });
  // ...and it never invents the reverse: both may be off, and an unrelated
  // pass is untouched.
  assert.deepEqual(toggleOp({ h3_facefix: true, grain: true }, "h3_facefix"),
                   { grain: true });
  assert.deepEqual(toggleOp({ grain: true }, "upscale"),
                   { grain: true, upscale: true });
});

/* ── retired passes ──────────────────────────────────────────────────────── */

test("a retired pass is not offered, and a retired pass that is ON still is", () => {
  // The whole point of the second half: the worker reads the project's chain
  // off the row, so a pass hidden while switched ON goes on running with
  // nothing on screen naming it — and no way to stop it.
  assert.ok(POST_OP.facefix.retired, "Face Detailer is retired in favour of Face Refine (H3)");
  assert.ok(!POST_OP.h3_facefix.retired, "its replacement is not");

  const ids = (c: PostChain) => offeredOps(c).map((o) => o.id);
  assert.ok(!ids({}).includes("facefix"));
  assert.ok(!ids({ h3_facefix: true }).includes("facefix"));
  assert.ok(ids({ facefix: true }).includes("facefix"));

  // Everything still offered is always listed, in POST_ORDER, whatever is on.
  const live = POST_ORDER.filter((id) => !POST_OP[id].retired);
  assert.deepEqual(ids({}), live);
  assert.deepEqual(ids({ grain: true }), live);
  assert.ok(live.length > 0, "a vacuous comparison would pass on an all-retired list");
});

test("switching the replacement on clears the retired pass, so its row goes away", () => {
  // EXCLUSIVE already does the clearing; this pins that the two rules compose
  // — a project carrying the retired pass is one click from being rid of it.
  const next = toggleOp({ facefix: true, grain: true }, "h3_facefix");
  assert.deepEqual(next, { h3_facefix: true, grain: true });
  assert.ok(!offeredOps(next).map((o) => o.id).includes("facefix"));
});

test("a retired pass keeps its MEANING everywhere but the pickers", () => {
  // Retired is a UI word. The op is still in POST_ORDER (the worker's twin
  // still lists it), still runs, still names itself, and still puts the render
  // on the GPU lane — otherwise an existing project's stored chain would
  // silently change what it delivers.
  assert.ok(POST_ORDER.includes("facefix"));
  assert.deepEqual(activeOps({ facefix: true }), ["facefix"]);
  assert.deepEqual(normalizeChain({ facefix: true }), { facefix: true });
  assert.equal(chainNeedsGpu({ facefix: true }), true);
  assert.match(describeChain({ facefix: true }), /Face Detailer/);
});

test("no chain the toggles can produce is one the render refuses", () => {
  // The property, not the pair: every reachable state from every starting
  // point, so a THIRD exclusive pair added later is covered without a new test.
  for (const start of [{}, ...POST_ORDER.map((id) => ({ [id]: true } as PostChain))]) {
    for (const id of POST_ORDER) {
      assert.equal(chainConflict(toggleOp(start, id)), null,
                   `toggling ${id} on ${JSON.stringify(start)} made a refused chain`);
    }
  }
});

test("tuning rows are offered only for passes that are on", () => {
  assert.deepEqual([...tunableOps({})], []);
  assert.deepEqual([...tunableOps({ grain: true, interpolate: true })], []);
  assert.deepEqual([...tunableOps({ ltx_refine: true })], ["ltx_refine"]);
  assert.deepEqual([...tunableOps({ upscale: true, ltx_refine: true })].sort(),
                   ["ltx_refine", "upscale"]);
});

// The repair engine, against errors a REAL ComfyUI produced.
//
// `__fixtures__/comfy_errors.json` is not hand-written: each case was made by
// submitting a deliberately broken graph to a live engine (ComfyUI 0.33, 857
// classes) and keeping the 400 verbatim. That matters more here than anywhere
// else in this module's tests, because the whole design rests on one measured
// claim — that `value_not_in_list` carries `extra_info.input_config[0]`, the
// engine's own list of legal values. Invent the fixture and you can "prove" a
// repair strategy the real service never supports.
//
// The other thing pinned here is the refusal to guess. A fixer that swaps in a
// plausible wrong checkpoint, or applies two of three repairs while reporting
// three, is worse than one that does nothing: the render then fails for a
// reason the user believes was already handled.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  aiRepairRequest, aiRepairsFromReply, applyRepairs, bestFile, dedupeFaults, fileScore,
  fillFor, parseComfyError, proposeRepairs, staticFaults, substitutionCheck,
} from "./workflowRepair.ts";
import type { ApiGraph, SlotMap } from "./workflowAdapter.ts";

const REAL = JSON.parse(readFileSync(
  new URL("./__fixtures__/comfy_errors.json", import.meta.url), "utf8")) as
  Record<string, { status: number; body: string }>;

/* ── parsing what the engine actually said ──────────────────────────────── */

test("a real value_not_in_list yields the wanted file AND the legal list", () => {
  const [f, ...rest] = parseComfyError(REAL.value_not_in_list.body);
  assert.equal(rest.length, 0);
  assert.equal(f.kind, "missing_file");
  assert.equal(f.node, "1");
  assert.equal(f.class_type, "UnetLoaderGGUF");
  assert.equal(f.input, "unet_name");
  assert.equal(f.got, "NotInstalled_v3_fp16.safetensors");
  // the whole reason this is arithmetic rather than AI
  assert.deepEqual(f.options, ["Wan2.2-TI2V-5B-Q6_K.gguf", "Wan2.2-TI2V-5B-Q8_0.gguf"]);
});

test("a real missing_node_type is read off `error`, not `node_errors`", () => {
  // It arrives in a different place from every other fault — a parser that
  // only walked node_errors would report NOTHING for the commonest failure an
  // imported graph has.
  const [f] = parseComfyError(REAL.missing_class.body);
  assert.equal(f.kind, "missing_class");
  assert.equal(f.class_type, "SomeCivitaiCustomNode");
  assert.equal(f.node, "999");
});

test("a real required_input_missing names the input", () => {
  const [f] = parseComfyError(REAL.required_missing.body);
  assert.equal(f.kind, "missing_input");
  assert.equal(f.node, "4");
  assert.equal(f.input, "text");
});

test("a real dangling wire is recognised rather than reported as unknown", () => {
  const [f] = parseComfyError(REAL.dangling.body);
  assert.equal(f.kind, "dead_wire");
  assert.equal(f.input, "positive");
});

test("the worker's stored shape parses too — prefix, and a wrapping row", () => {
  // The row holds `last_error.message`, which is OUR prefix in front of the
  // engine's JSON. A parser that only took the bare object works in a test and
  // finds nothing on any real row.
  const prefixed = `ComfyUI rejected graph: ${REAL.value_not_in_list.body}`;
  assert.equal(parseComfyError(prefixed)[0].kind, "missing_file");
  const row = { message: prefixed, at: "2026-08-20T00:00:00Z", node: null };
  assert.equal(parseComfyError(row)[0].kind, "missing_file");
});

test("junk is one unknown fault, never a throw", () => {
  assert.deepEqual(parseComfyError(""), []);
  assert.equal(parseComfyError("the engine went away")[0].kind, "unknown");
  assert.equal(parseComfyError(null).length, 0);
});

/* ── matching a filename ────────────────────────────────────────────────── */

test("a directory prefix does not stop a match", () => {
  // ComfyUI reports what it sees on disk; a downloaded graph names the bare
  // file. This is the common case, not an edge one.
  assert.equal(fileScore("krea2_turbo_fp8_scaled.safetensors",
                         "Krea2/krea2_turbo_fp8_scaled.safetensors"), 1);
});

test("the same file in another format still matches", () => {
  assert.ok(fileScore("model.safetensors", "model.gguf") >= 0.9);
});

test("near-miss models do NOT match each other", () => {
  // Edit distance calls these neighbours; they are different models, and a
  // confident swap to the wrong one is the failure this whole module exists
  // to avoid.
  assert.equal(bestFile("flux1-dev.safetensors", ["flux1-schnell.safetensors"]), null);
});

test("a one-token name does not match everything containing that token", () => {
  const hit = bestFile("wan.safetensors",
    ["wan2.2_something_huge_14b_fp8_scaled.safetensors"]);
  assert.equal(hit, null, "Jaccard, not fraction-of-wanted");
});

test("the best of several is chosen, and reported with its score", () => {
  const hit = bestFile("Wan2.2-TI2V-5B-Q8_0.gguf",
    ["Wan2.2-TI2V-5B-Q6_K.gguf", "Wan2.2-TI2V-5B-Q8_0.gguf"]);
  assert.equal(hit!.name, "Wan2.2-TI2V-5B-Q8_0.gguf");
  assert.equal(hit!.score, 1);
});

/* ── proposals ──────────────────────────────────────────────────────────── */

const GRAPH: ApiGraph = {
  "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "NotInstalled_v3_fp16.safetensors" } },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["2", 0] } },
  "9": { class_type: "PreviewImage", inputs: { images: ["8", 0] } },
};

test("a near-miss file becomes a concrete swap, with no model asked", () => {
  // The realistic case, captured live: the graph names the model in the format
  // its author had (`…Q8_0.safetensors`) on a machine holding the GGUF quant.
  const faults = parseComfyError(REAL.near_miss_file.body);
  const [r] = proposeRepairs(GRAPH, {}, faults);
  assert.equal(r.kind, "missing_file");
  assert.equal(r.confidence, "exact", "same stem, different extension");
  assert.equal(r.patch!.set!.node, "1");
  assert.equal(r.patch!.set!.input, "unet_name");
  assert.equal(r.patch!.set!.value, "Wan2.2-TI2V-5B-Q8_0.gguf");
  assert.ok(!r.ai, "this one is arithmetic — no model was asked");
  assert.match(r.detail, /closest/);
});

test("A FILE UNRELATED TO ANYTHING INSTALLED IS NOT SWAPPED", () => {
  // The live fixture asks for `NotInstalled_v3_fp16.safetensors` on a machine
  // holding two Wan quants. They share no tokens, so there is no defensible
  // value to write — and writing the only installed file anyway is exactly the
  // "confidently wrong model" this module refuses to do. Advice, not a patch.
  const faults = parseComfyError(REAL.value_not_in_list.body);
  const [r] = proposeRepairs(GRAPH, {}, faults);
  assert.equal(r.kind, "missing_file");
  assert.equal(r.patch, null);
  assert.equal(r.confidence, "guess");
  assert.match(r.detail, /nothing installed/);
});

test("a swap the engine's own list cannot justify is offered as ADVICE, not a patch", () => {
  const faults = [{ kind: "missing_file" as const, node: "1", input: "unet_name",
                    class_type: "UnetLoaderGGUF", got: "totally_unrelated.safetensors",
                    options: ["Wan2.2-TI2V-5B-Q6_K.gguf"], message: "x" }];
  const [r] = proposeRepairs(GRAPH, {}, faults);
  assert.equal(r.patch, null, "no patch, because there is no defensible value to write");
  assert.equal(r.confidence, "guess");
});

test("a preview-only output becomes a SaveImage of the same node", () => {
  const [r] = proposeRepairs(GRAPH, {}, staticFaults(GRAPH, { prompt: { node: "4", input: "text", class_type: "CLIPTextEncode" } } as SlotMap));
  assert.equal(r.kind, "preview_only");
  assert.deepEqual(r.patch!.reclass, { node: "9", class_type: "SaveImage" });
});

test("a UUID class is a SUBGRAPH and is never reported as a missing pack", () => {
  // Telling someone to install a repository named after a UUID sends them
  // looking for something that does not exist. Measured on a real Civitai
  // download: 6 subgraph definitions, each a UUID class_type.
  const [r] = proposeRepairs(GRAPH, {}, [{
    kind: "missing_class", node: "7", class_type: "fe965eb7-2c71-4e8d-a105-4fdfa63d0336",
    message: "not installed" }]);
  assert.match(r.title, /re-export/i);
  assert.match(r.detail, /Convert to Nodes/);
  assert.ok(!r.action?.install);
});

test("a class a known pack provides names the pack and its URL", () => {
  const [r] = proposeRepairs(GRAPH, {}, [{
    kind: "missing_class", node: "7", class_type: "MiniMaxH3TurboSampler", message: "x" }]);
  assert.match(r.title, /Install/);
  assert.ok(r.action!.install!.url.startsWith("https://"));
});

test("one text encoder means the prompt slot can be tagged without a model", () => {
  const [r] = proposeRepairs(GRAPH, {}, [{ kind: "no_prompt_slot", message: "x" }]);
  assert.equal(r.confidence, "likely");
  assert.deepEqual(r.patch!.slot, { key: "prompt", node: "4", input: "text",
                                    class_type: "CLIPTextEncode" });
});

test("two text encoders means it is a judgement, and no patch is offered", () => {
  const two: ApiGraph = { ...GRAPH, "5": { class_type: "CLIPTextEncode", inputs: { text: "blurry" } } };
  const [r] = proposeRepairs(two, {}, [{ kind: "no_prompt_slot", message: "x" }]);
  assert.equal(r.patch, null);
  assert.equal(r.confidence, "guess");
});

test("proposals are ordered exact first, so the list reads top-down", () => {
  const faults = [
    { kind: "no_prompt_slot" as const, message: "x" },
    ...parseComfyError(REAL.near_miss_file.body),
  ];
  const rs = proposeRepairs(GRAPH, {}, faults);
  assert.equal(rs[0].confidence, "exact");
});

/* ── applying ───────────────────────────────────────────────────────────── */

test("applying never mutates the stored graph", () => {
  const before = JSON.stringify(GRAPH);
  const rs = proposeRepairs(GRAPH, {}, parseComfyError(REAL.near_miss_file.body));
  const out = applyRepairs(GRAPH, {}, rs);
  assert.equal(JSON.stringify(GRAPH), before);
  assert.equal(out.graph["1"].inputs.unet_name, "Wan2.2-TI2V-5B-Q8_0.gguf");
  assert.deepEqual(out.applied, [rs[0].id]);
});

test("a repair that cannot land is REPORTED, never silently dropped", () => {
  // "3 fixes applied" having applied two is worse than fixing nothing: the
  // render then fails for a reason the user believes was handled.
  const rs = proposeRepairs(GRAPH, {}, [{
    kind: "missing_file", node: "404", input: "unet_name", got: "a.safetensors",
    options: ["a.safetensors"], message: "x" }]);
  const out = applyRepairs(GRAPH, {}, rs);
  assert.deepEqual(out.applied, []);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /not in the graph/);
});

test("advice-only proposals are skipped with a reason rather than counted", () => {
  const out = applyRepairs(GRAPH, {}, [{
    id: "x", kind: "missing_class", confidence: "exact", title: "Install a pack",
    detail: "", patch: null }]);
  assert.deepEqual(out.applied, []);
  assert.equal(out.skipped[0].reason, "nothing to change in the graph");
});

test("a slot repair writes the SLOT MAP and leaves the graph alone", () => {
  const rs = proposeRepairs(GRAPH, {}, [{ kind: "no_prompt_slot", message: "x" }]);
  const out = applyRepairs(GRAPH, {}, rs);
  assert.equal(JSON.stringify(out.graph), JSON.stringify(GRAPH));
  assert.equal((out.slots.prompt as { node: string }).node, "4");
});

/* ── the AI half ────────────────────────────────────────────────────────── */

test("no ask is made when arithmetic already covers everything", () => {
  // "No AI needed" is the normal case, not an error — a fixer that calls a
  // model on every failure spends money to restate what the engine said.
  assert.equal(aiRepairRequest(GRAPH, parseComfyError(REAL.near_miss_file.body)), null);
  assert.equal(aiRepairRequest(GRAPH, [{ kind: "missing_class", node: "1",
    class_type: "MiniMaxH3TurboSampler", message: "x" }]), null, "a known pack needs no model");
  assert.equal(aiRepairRequest(GRAPH, [{ kind: "missing_class", node: "1",
    class_type: "fe965eb7-2c71-4e8d-a105-4fdfa63d0336", message: "x" }]), null, "a subgraph is not a class");
});

test("an ask is made for an unknown class, and carries the installed list", () => {
  const ask = aiRepairRequest(GRAPH, [{ kind: "missing_class", node: "7",
    class_type: "SomeCivitaiCustomNode", message: "x" }],
    { installed: new Set(["SaveImage", "KSampler"]) });
  assert.ok(ask);
  assert.match(ask!.user, /SomeCivitaiCustomNode/);
  assert.match(ask!.user, /SaveImage, KSampler/);
  assert.match(ask!.system, /verbatim/);
});

test("A CLASS THE MODEL INVENTED IS DROPPED", () => {
  // The validation is the feature: the worst a confabulating model can do is
  // produce nothing. An invented class fails exactly like the missing one it
  // replaced, except the user was told it was fixed.
  const faults = [{ kind: "missing_class" as const, node: "7",
                    class_type: "SomeCivitaiCustomNode", message: "x" }];
  const reply = '{"substitutions":[{"missing":"SomeCivitaiCustomNode","use":"TotallyMadeUp","why":"looks right"}]}';
  assert.deepEqual(aiRepairsFromReply(reply, faults, { installed: new Set(["SaveImage"]) }), []);
});

test("a real substitution becomes a proposal, marked as the model's", () => {
  const faults = [{ kind: "missing_class" as const, node: "7",
                    class_type: "SomeCivitaiCustomNode", message: "x" }];
  const reply = 'sure!\n{"substitutions":[{"missing":"SomeCivitaiCustomNode","use":"SaveImage","why":"it saves the image"}]}';
  const [r] = aiRepairsFromReply(reply, faults, { installed: new Set(["SaveImage"]) });
  assert.equal(r.ai, true);
  assert.equal(r.confidence, "guess", "a model's swap is never presented as exact");
  assert.deepEqual(r.patch!.reclass, { node: "7", class_type: "SaveImage" });
  assert.match(r.detail, /check the result/);
});

test("a reply that is not JSON produces nothing rather than throwing", () => {
  assert.deepEqual(aiRepairsFromReply("I could not work that out.", [], {}), []);
});

/* ── a reclass is not just a name ───────────────────────────────────────── */
//
// THIS IS THE BUG THE LIVE ENGINE FOUND AND UNIT TESTS COULD NOT. Swapping
// PreviewImage for SaveImage took a graph the engine ACCEPTED (200) and made it
// fail validation (400): SaveImage requires `filename_prefix`, and PreviewImage
// has no such input. A hand-written fixture would have carried whatever its
// author expected — these schemas are the real ones, read off ComfyUI 0.33.

const SAVE_SPEC = { input: { required: {
  images: ["IMAGE", { tooltip: "The images to save." }],
  filename_prefix: ["STRING", { default: "ComfyUI" }],
} } };
const PREVIEW_GRAPH: ApiGraph = {
  "900": { class_type: "PreviewImage", inputs: { images: ["12", 0] } },
};

test("a reclass carries the inputs the NEW class requires", () => {
  const [r] = proposeRepairs(PREVIEW_GRAPH, {}, staticFaults(PREVIEW_GRAPH, {} as SlotMap),
    { installed: new Set(["SaveImage"]), specFor: () => SAVE_SPEC });
  assert.equal(r.patch!.reclass!.class_type, "SaveImage");
  assert.deepEqual(r.patch!.reclass!.set, { filename_prefix: "ComfyUI" });
  const out = applyRepairs(PREVIEW_GRAPH, {}, [r]);
  assert.deepEqual(out.graph["900"],
    { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "ComfyUI" } });
});

test("with no schema to consult the swap is a GUESS, not exact", () => {
  // "We could not check" is never "it is fine" — compat.ts's rule, and the
  // consequence here is a graph that fails on a different error.
  const [r] = proposeRepairs(PREVIEW_GRAPH, {}, staticFaults(PREVIEW_GRAPH, {} as SlotMap),
    { installed: new Set(["SaveImage"]) });
  assert.equal(r.confidence, "guess");
});

test("a swap needing a WIRE the node has not got is refused, not attempted", () => {
  // Trading a graph that runs and saves nothing for one that does not run is
  // the fixer making things worse.
  const spec = { input: { required: {
    images: ["IMAGE", {}], audio: ["AUDIO", {}], filename_prefix: ["STRING", { default: "x" }],
  } } };
  const [r] = proposeRepairs(PREVIEW_GRAPH, {}, staticFaults(PREVIEW_GRAPH, {} as SlotMap),
    { installed: new Set(["SaveImage"]), specFor: () => spec });
  assert.equal(r.patch, null);
  assert.match(r.detail, /audio/);
});

test("fillFor reports a wire it cannot supply rather than inventing one", () => {
  const got = fillFor({ class_type: "PreviewImage", inputs: {} }, "SaveImage", SAVE_SPEC);
  assert.deepEqual(got!.blocked, ["images"]);
  assert.deepEqual(got!.set, { filename_prefix: "ComfyUI" });
});

test("fillFor returns null with no schema — 'not checked' is its own answer", () => {
  assert.equal(fillFor({ class_type: "PreviewImage", inputs: {} }, "SaveImage", undefined), null);
});

test("a COMBO input defaults to its first legal value", () => {
  const spec = { input: { required: { sampler_name: [["euler", "dpmpp_2m"], {}] } } };
  assert.deepEqual(fillFor({ class_type: "A", inputs: {} }, "B", spec)!.set,
                   { sampler_name: "euler" });
});

test("the same fault from both halves is ONE problem", () => {
  // A missing class is named by the engine's stored refusal AND by the static
  // check; offering the same install twice reads as a worse-broken workflow.
  const twice = [
    ...parseComfyError(REAL.missing_class.body),
    { kind: "missing_class" as const, node: "999",
      class_type: "SomeCivitaiCustomNode", message: "not installed on this engine" },
  ];
  assert.equal(twice.length, 2);
  assert.equal(dedupeFaults(twice).length, 1);
});

/* ── a model's "equivalent", checked against the wiring ─────────────────── */
//
// FOUND BY RUNNING THE REAL THING. Against a real Civitai workflow (SDXL PONY
// ILLUSTRIOUS DMD2, 45 nodes, 17 classes this engine lacks) a live model
// offered two substitutions and nothing about them looked different:
//   GetImageSize+   -> GetImageSize        SAFE
//   JoinStringMulti -> StringConcatenate   LOSES TWO LIVE LINKS
// The second validates cleanly and renders with two empty strings, because
// ComfyUI ignores an input the class does not declare. That is the silent
// downgrade, and only arithmetic over the graph can tell the two apart.

const SUB_GRAPH: ApiGraph = {
  "42": { class_type: "Whatever", inputs: {} },
  "51": { class_type: "Whatever", inputs: {} },
  "44": { class_type: "JoinStringMulti", inputs: { string_1: ["51", 0], string_2: ["42", 0] } },
  "53": { class_type: "GetImageSize+", inputs: { image: ["204", 0] } },
  "49": { class_type: "CR Integer To String", inputs: { int_: ["53", 1] } },
  "50": { class_type: "CR Integer To String", inputs: { int_: ["53", 0] } },
};
// the engine's real schemas for these two
const GET_SIZE = { input: { required: { image: ["IMAGE", {}] } }, output: ["INT", "INT", "INT"] };
const CONCAT = { input: { required: {
  string_a: ["STRING", { multiline: true }], string_b: ["STRING", { multiline: true }],
  delimiter: ["STRING", { default: "" }],
} }, output: ["STRING"] };

test("a substitution that carries the wires and the outputs is a PATCH", () => {
  const reply = '{"substitutions":[{"missing":"GetImageSize+","use":"GetImageSize","why":"same job"}]}';
  const faults = [{ kind: "missing_class" as const, node: "53",
                    class_type: "GetImageSize+", message: "x" }];
  const [r] = aiRepairsFromReply(reply, faults,
    { installed: new Set(["GetImageSize"]), specFor: () => GET_SIZE }, SUB_GRAPH);
  assert.equal(r.patch!.reclass!.class_type, "GetImageSize");
  assert.equal(r.ai, true);
});

test("A SUBSTITUTION THAT WOULD DROP A LIVE LINK IS ADVICE, NOT A PATCH", () => {
  const reply = '{"substitutions":[{"missing":"JoinStringMulti","use":"StringConcatenate","why":"both join strings"}]}';
  const faults = [{ kind: "missing_class" as const, node: "44",
                    class_type: "JoinStringMulti", message: "x" }];
  const [r] = aiRepairsFromReply(reply, faults,
    { installed: new Set(["StringConcatenate"]), specFor: () => CONCAT }, SUB_GRAPH);
  assert.equal(r.patch, null, "it validates and renders without the strings — refuse it");
  assert.match(r.detail, /string_1, string_2 carries a link/);
});

test("output arity is checked — a graph reading index 1 needs two outputs", () => {
  const narrow = { input: { required: { image: ["IMAGE", {}] } }, output: ["INT"] };
  const c = substitutionCheck(SUB_GRAPH, "53", "Narrow", narrow);
  assert.equal(c!.outputsNeeded, 2);
  assert.equal(c!.outputsHave, 1);
  assert.equal(c!.ok, false);
});

test("a stale LITERAL is tolerated where a stale wire is not", () => {
  // ComfyUI ignores an undeclared input either way; only a link loses content
  // the graph was feeding in.
  const g: ApiGraph = { "1": { class_type: "Old", inputs: { image: ["2", 0], fancy_option: 7 } },
                        "2": { class_type: "Src", inputs: {} } };
  const spec = { input: { required: { image: ["IMAGE", {}] } }, output: ["IMAGE"] };
  const c = substitutionCheck(g, "1", "New", spec);
  assert.deepEqual(c!.stale, ["fancy_option"]);
  assert.deepEqual(c!.lostLinks, []);
  assert.equal(c!.ok, true);
});

test("a wire pointing at a node that is gone is not counted as a lost link", () => {
  // It was already broken; blaming the substitution for it would refuse a swap
  // that changes nothing about that.
  const g: ApiGraph = { "1": { class_type: "Old", inputs: { image: ["2", 0], ghost: ["404", 0] } },
                        "2": { class_type: "Src", inputs: {} } };
  const spec = { input: { required: { image: ["IMAGE", {}] } }, output: ["IMAGE"] };
  assert.deepEqual(substitutionCheck(g, "1", "New", spec)!.lostLinks, []);
});

test("with no schema the substitution is offered unchecked, and says less", () => {
  const reply = '{"substitutions":[{"missing":"A","use":"SaveImage","why":"x"}]}';
  const faults = [{ kind: "missing_class" as const, node: "53", class_type: "A", message: "x" }];
  const [r] = aiRepairsFromReply(reply, faults, { installed: new Set(["SaveImage"]) }, SUB_GRAPH);
  assert.ok(r.patch, "still offered — the class is installed");
  assert.doesNotMatch(r.detail, /takes the wires/, "no wiring claim without a schema to check it");
});

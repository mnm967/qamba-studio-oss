// The adapter is the one piece of the import path with no human in the loop:
// a graph converts, gets tagged, and then RENDERS. Every failure mode here is
// silent by construction — a widget written into the wrong input, a bypassed
// node dropped instead of passed through, a seed slot on the wrong node — so
// the tests are against real graphs rather than hand-made happy paths.
//
// Two fixtures, deliberately:
//  · workflows/*.json — the API-format templates the studio actually renders.
//    `detectSlots` must find the same knobs resolve.py drives on every one of
//    them, which is the check that the tagger and the worker agree.
//  · krea2_image_tool.json — a real Civitai download in UI format, 113 nodes,
//    carrying every editor-only construct at once (bypass, converted widgets,
//    Get/SetNode, Anything Everywhere, subgraphs, rgthree furniture). It is
//    the shape a user will actually import, and it is not a nice graph.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FALLBACK_WIDGETS, apiToUi, applySlots, apiNodes, detectSlots,
  isApiGraph, isUiGraph, pad17, requiredClasses, requiredFiles, snapDim,
  toApiGraph, uiToApi, validateGraph, widgetNames,
  type ApiGraph, type ObjectInfo, type UiGraph,
} from "./workflowAdapter.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF = path.join(ROOT, "workflows");
const read = (f: string) => fs.readFileSync(path.join(WF, f), "utf8");
const load = (f: string) => JSON.parse(read(f));

/* ── format detection ───────────────────────────────────────────────────── */

test("the two graph formats are told apart, both ways", () => {
  assert.ok(isUiGraph(load("krea2_image_tool.json")));
  assert.ok(!isApiGraph(load("krea2_image_tool.json")));

  const api = load("minimax_h3_i2v.json");
  assert.ok(isApiGraph(api));
  assert.ok(!isUiGraph(api));

  // an API graph passes through toApiGraph untouched — importing one must not
  // run it through the converter, which would find no `nodes` and return {}
  const t = toApiGraph(api);
  assert.equal(t.clean, true);
  assert.deepEqual(Object.keys(t.api).sort(), Object.keys(api).filter((k) => !k.startsWith("_")).sort()
    .concat(Object.keys(api).filter((k) => k.startsWith("_"))).sort());
});

test("something that is not a graph is refused, not half-converted", () => {
  for (const junk of [null, 42, "{}", { hello: "world" }, []]) {
    const c = toApiGraph(junk);
    assert.deepEqual(c.api, {});
    assert.equal(c.warnings[0].level, "error");
  }
});

/* ── widget mapping ─────────────────────────────────────────────────────── */

test("widgetNames reads the order out of an /object_info entry", () => {
  const spec: ObjectInfo[string] = {
    input: {
      required: {
        model: ["MODEL"],                                   // a wire, not a widget
        seed: ["INT", { default: 0, control_after_generate: true }],
        steps: ["INT", { default: 20 }],
        sampler_name: [["euler", "dpmpp_2m"], {}],          // combo = widget
      },
      optional: { denoise: ["FLOAT", { default: 1 }] },
    },
  };
  const names = widgetNames(spec);
  // the control_after_generate sentinel has to occupy a position, or every
  // widget after the seed lands one input to the left
  assert.deepEqual(names, ["seed", "__control_after_generate__", "steps", "sampler_name", "denoise"]);
});

test("control_after_generate does not shift the widgets behind it", () => {
  const g: UiGraph = {
    nodes: [{
      id: 1, type: "KSampler", mode: 0,
      widgets_values: [123456, "fixed", 25, 7.5, "euler", "normal", 1],
      inputs: [], outputs: [],
    }],
    links: [],
  };
  const { api } = uiToApi(g);
  assert.deepEqual(api["1"].inputs, {
    seed: 123456, steps: 25, cfg: 7.5,
    sampler_name: "euler", scheduler: "normal", denoise: 1,
  });
  assert.ok(!("__control_after_generate__" in api["1"].inputs));
});

test("an unknown class is reported unmapped, never guessed at", () => {
  const g: UiGraph = {
    nodes: [{ id: 7, type: "SomeCustomSampler", widgets_values: [1, 2, 3], inputs: [], outputs: [] }],
    links: [],
  };
  const c = uiToApi(g);
  assert.deepEqual(c.unmapped, ["SomeCustomSampler"]);
  assert.equal(c.clean, false);
  assert.deepEqual(c.api["7"].inputs, {});   // no invented names
  assert.match(c.warnings[0].message, /no widget schema/);
});

test("/object_info beats the fallback table for a class in both", () => {
  const g: UiGraph = {
    nodes: [{ id: 3, type: "UNETLoader", widgets_values: ["a.safetensors", "fp8"], inputs: [], outputs: [] }],
    links: [],
  };
  assert.deepEqual(uiToApi(g).api["3"].inputs,
    { unet_name: "a.safetensors", weight_dtype: "fp8" });

  // a pod whose UNETLoader has a third widget: the schema, not our table, wins
  const oi: ObjectInfo = {
    UNETLoader: { input: { required: {
      unet_name: [["a.safetensors"]], weight_dtype: [["fp8"]], device: [["cuda"], {}],
    } } },
  };
  const g2: UiGraph = {
    nodes: [{ id: 3, type: "UNETLoader", widgets_values: ["a.safetensors", "fp8", "cuda"], inputs: [], outputs: [] }],
    links: [],
  };
  assert.deepEqual(uiToApi(g2, oi).api["3"].inputs,
    { unet_name: "a.safetensors", weight_dtype: "fp8", device: "cuda" });
});

/* ── the editor-only constructs ─────────────────────────────────────────── */

/** origin → [reroute] → consumer, plus a muted branch and a bypassed one. */
const wired = (): UiGraph => ({
  nodes: [
    { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["m.safetensors"],
      outputs: [{ type: "MODEL", links: [10] }] },
    { id: 2, type: "Reroute", mode: 0,
      inputs: [{ name: "", type: "MODEL", link: 10 }], outputs: [{ type: "MODEL", links: [11] }] },
    { id: 3, type: "KSampler", mode: 0, widgets_values: [1, "fixed", 20, 8, "euler", "normal", 1],
      inputs: [{ name: "model", type: "MODEL", link: 11 }] },
  ],
  links: [[10, 1, 0, 2, 0, "MODEL"], [11, 2, 0, 3, 0, "MODEL"]],
});

test("a reroute is resolved through to the real producer", () => {
  const { api } = uiToApi(wired());
  assert.ok(!api["2"], "the reroute itself must not reach the backend");
  assert.deepEqual(api["3"].inputs.model, ["1", 0]);
});

test("BYPASS passes the wire through by type; MUTE cuts it", () => {
  // model → LoraLoaderModelOnly(bypassed) → sampler: the sampler should end up
  // reading the checkpoint directly, exactly as ComfyUI does.
  const g: UiGraph = {
    nodes: [
      { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["m.safetensors"], outputs: [{ type: "MODEL", links: [10] }] },
      { id: 2, type: "LoraLoaderModelOnly", mode: 4, widgets_values: ["l.safetensors", 1],
        inputs: [{ name: "model", type: "MODEL", link: 10 }], outputs: [{ type: "MODEL", links: [11] }] },
      { id: 3, type: "KSampler", inputs: [{ name: "model", type: "MODEL", link: 11 }] },
    ],
    links: [[10, 1, 0, 2, 0, "MODEL"], [11, 2, 0, 3, 0, "MODEL"]],
  };
  const bypassed = uiToApi(g);
  assert.ok(!bypassed.api["2"], "a bypassed node does not execute");
  assert.deepEqual(bypassed.api["3"].inputs.model, ["1", 0], "its wire survives");

  // the same graph with the LoRA MUTED: there is no output at all, so the
  // sampler's input is genuinely missing and the user must be told
  g.nodes[1].mode = 2;
  const muted = uiToApi(g);
  assert.ok(!muted.api["3"].inputs.model);
  assert.ok(muted.warnings.some((w) => w.level === "error" && /does not survive/.test(w.message)));
});

test("GetNode follows its SetNode; an orphan GetNode is an error", () => {
  const g: UiGraph = {
    nodes: [
      { id: 1, type: "VAELoader", widgets_values: ["v.safetensors"], outputs: [{ type: "VAE", links: [10] }] },
      { id: 2, type: "SetNode", widgets_values: ["theVae"], inputs: [{ name: "VAE", type: "VAE", link: 10 }] },
      { id: 3, type: "GetNode", widgets_values: ["theVae"], outputs: [{ type: "VAE", links: [11] }] },
      { id: 4, type: "VAEDecode", inputs: [{ name: "vae", type: "VAE", link: 11 }] },
      { id: 5, type: "GetNode", widgets_values: ["nobody"], outputs: [{ type: "VAE", links: [12] }] },
      { id: 6, type: "VAEDecode", inputs: [{ name: "vae", type: "VAE", link: 12 }] },
    ],
    links: [[10, 1, 0, 2, 0, "VAE"], [11, 3, 0, 4, 0, "VAE"], [12, 5, 0, 6, 0, "VAE"]],
  };
  const c = uiToApi(g);
  assert.deepEqual(c.api["4"].inputs.vae, ["1", 0], "the named wire is followed to the loader");
  assert.ok(!c.api["3"] && !c.api["2"], "the virtual pair does not reach the backend");
  assert.ok(c.warnings.some((w) => /no matching SetNode/.test(w.message)));
});

test("ComfyUI-Easy-Use's get/set spelling is followed too", () => {
  // Measured on a real Civitai WAN 2.2 download: 42 of its 86 nodes were
  // `easy getNode`/`easy setNode`. Handling only the KJNodes spelling does not
  // fail loudly — the pair survives as ordinary nodes, so the CLIPTextEncode
  // behind them is no longer wired to anything called `positive` and the graph
  // imports with NO PROMPT SLOT. Conversion of that file went 86 nodes → 46
  // and found its prompt once this spelling was added.
  const g: UiGraph = {
    nodes: [
      { id: 1, type: "CLIPTextEncode", widgets_values: ["a lighthouse"],
        outputs: [{ type: "CONDITIONING", links: [10] }] },
      { id: 2, type: "easy setNode", widgets_values: ["POS"],
        inputs: [{ name: "value", type: "CONDITIONING", link: 10 }] },
      { id: 3, type: "easy getNode", widgets_values: ["POS"],
        outputs: [{ type: "CONDITIONING", links: [11] }] },
      { id: 4, type: "KSampler", widgets_values: [1, "fixed", 20, 8, "euler", "normal", 1],
        inputs: [{ name: "positive", type: "CONDITIONING", link: 11 }] },
      { id: 5, type: "SaveImage", widgets_values: ["out"], inputs: [] },
    ],
    links: [[10, 1, 0, 2, 0, "CONDITIONING"], [11, 3, 0, 4, 0, "CONDITIONING"]],
  };
  const { api } = uiToApi(g);
  assert.ok(!api["2"] && !api["3"], "the virtual pair must not reach the backend");
  assert.deepEqual(api["4"].inputs.positive, ["1", 0], "the sampler reads the encoder directly");

  const slots = detectSlots(api);
  assert.equal(slots.prompt?.node, "1", "the prompt slot is the encoder behind the named wire");
  assert.equal(slots.prompt?.input, "text");
});

test("a converted widget takes the LINK, not the stale literal beside it", () => {
  // EmptyLatentImage with width/height promoted to inputs: the editor keeps
  // 1024,1024 in widgets_values, and taking those would silently ignore the
  // resolution the graph computes upstream. This is the exact shape in
  // krea2_image_tool.json.
  const g: UiGraph = {
    nodes: [
      { id: 9, type: "easy imageSize", outputs: [{ type: "INT", links: [1] }, { type: "INT", links: [2] }] },
      { id: 11, type: "EmptyLatentImage", widgets_values: [1024, 1024, 1], inputs: [
        { name: "width", type: "INT", widget: { name: "width" }, link: 1 },
        { name: "height", type: "INT", widget: { name: "height" }, link: 2 },
      ] },
    ],
    links: [[1, 9, 0, 11, 0, "INT"], [2, 9, 1, 11, 1, "INT"]],
  };
  const { api } = uiToApi(g);
  assert.deepEqual(api["11"].inputs.width, ["9", 0]);
  assert.deepEqual(api["11"].inputs.height, ["9", 1]);
  assert.equal(api["11"].inputs.batch_size, 1, "the un-promoted widget keeps its literal");
});

test("Anything Everywhere is reported as an error, not quietly dropped", () => {
  // It broadcasts at prompt-build time inside the extension; nothing in the
  // file records where the value lands, so the converted graph HAS holes and
  // saying so is the only honest option.
  const g: UiGraph = {
    nodes: [{ id: 1, type: "Anything Everywhere", inputs: [{ name: "anything", type: "VAE", link: null }] }],
    links: [],
  };
  const c = uiToApi(g);
  assert.equal(c.clean, false);
  assert.ok(c.warnings.some((w) => w.level === "error" && /broadcast/.test(w.message)));
});

test("notes and rgthree furniture vanish without complaint", () => {
  const g: UiGraph = {
    nodes: [
      { id: 1, type: "MarkdownNote", widgets_values: ["hello"] },
      { id: 2, type: "Label (rgthree)", widgets_values: ["x"] },
      { id: 3, type: "Bookmark (rgthree)", widgets_values: ["1", 1] },
      // a REAL node alongside them, to prove the sweep is targeted: PreviewImage
      // executes on the backend and is a legitimate output, unlike the three above
      { id: 4, type: "SaveImage", widgets_values: ["out"], inputs: [] },
    ],
    links: [],
  };
  const c = uiToApi(g);
  assert.deepEqual(Object.keys(c.api), ["4"]);
  assert.deepEqual(c.warnings, []);
  assert.equal(c.clean, true);
});

/* ── the real Civitai download ──────────────────────────────────────────── */

test("the real UI-format Civitai graph converts, and says what it lost", () => {
  const ui = load("krea2_image_tool.json") as UiGraph;
  const c = uiToApi(ui);

  // every surviving node is API-shaped
  for (const [id, n] of Object.entries(c.api)) {
    assert.match(id, /^\d+$/);
    assert.equal(typeof n.class_type, "string");
    assert.equal(typeof n.inputs, "object");
  }
  // the furniture is gone and the real loaders are not
  const classes = new Set(Object.values(c.api).map((n) => n.class_type));
  for (const gone of ["MarkdownNote", "Note", "Label (rgthree)", "Anything Everywhere", "GetNode", "SetNode"]) {
    assert.ok(!classes.has(gone), `${gone} must not reach the backend`);
  }
  assert.ok(classes.has("UNETLoader") && classes.has("CLIPLoader") && classes.has("VAELoader"));

  // the loader's filename survived the positional mapping
  const unet = Object.values(c.api).find((n) => n.class_type === "UNETLoader");
  assert.equal(unet?.inputs.unet_name, "Krea2/krea2_turbo_fp8_scaled.safetensors");

  // and the graph is honestly reported as NOT clean: it uses broadcast wiring
  // and subgraphs, both of which lose information here
  assert.equal(c.clean, false);
  assert.ok(c.warnings.some((w) => /subgraph/.test(w.message)));
  assert.ok(c.warnings.some((w) => /broadcast/.test(w.message)));
});

test("a bypassed SaveImage in the real graph is not offered as an output", () => {
  // node 158 is SaveImage with mode 4 — a graph whose only output is bypassed
  // renders and saves nothing, and reporting it as the output would hide that.
  const ui = load("krea2_image_tool.json") as UiGraph;
  const bypassedSaves = ui.nodes.filter((n) => n.type === "SaveImage" && n.mode === 4);
  assert.ok(bypassedSaves.length > 0, "fixture drifted: expected a bypassed SaveImage");
  const { api } = uiToApi(ui);
  for (const n of bypassedSaves) assert.ok(!api[String(n.id)]);
});

/* ── slot tagging against the templates the studio really renders ───────── */

const TEMPLATES = fs.readdirSync(WF).filter((f) => f.endsWith(".json"));

/** The API-format templates, i.e. everything except the UI export, the stubs
 *  and the text-substituted one (which is not valid JSON on disk). */
const apiTemplates = TEMPLATES.filter((f) => {
  try {
    const d = JSON.parse(read(f));
    return isApiGraph(d) && !d._stub;
  } catch { return false; }
});

test("every shipped template is recognised as an API graph", () => {
  // Of the shipped files, the stubs and the UI export are expected to be
  // excluded — if this number collapses, the detector broke.
  assert.ok(apiTemplates.length >= 15, `only ${apiTemplates.length} API templates found`);
});

test("MiniMax H3: prompt, size, seed and output are found on every H3 template", () => {
  const h3 = apiTemplates.filter((f) => f.startsWith("minimax_h3"));
  assert.ok(h3.length >= 4);
  for (const f of h3) {
    const slots = detectSlots(load(f));
    // H3 conditions inside the latent builder — the prompt is a plain string
    // input there, NOT a CLIPTextEncode. Getting this wrong writes the prompt
    // nowhere and renders the template's own.
    assert.ok(slots.prompt, `${f}: no prompt slot`);
    assert.equal(slots.prompt!.input, "prompt", `${f}: prompt slot is not the H3 string input`);
    assert.match(slots.prompt!.class_type, /^MiniMaxH3/, `${f}`);

    assert.ok(slots.size, `${f}: no size slot`);
    assert.equal(slots.size!.width, "width");
    assert.equal(slots.size!.height, "height");
    assert.equal(slots.size!.length, "length", `${f}: no frame-count input`);

    assert.ok(slots.seed, `${f}: no seed slot`);
    assert.ok(slots.output?.length, `${f}: no output node`);
  }
});

test("MiniMax H3 i2v tags the source still; t2v has none to tag", () => {
  assert.ok(detectSlots(load("minimax_h3_i2v.json")).start_frame, "i2v must take a first frame");
  assert.ok(!detectSlots(load("minimax_h3_t2v.json")).start_frame, "t2v has no LoadImage to tag");
});

test("MiniMax H3 flf tags BOTH stills, and to different nodes", () => {
  const s = detectSlots(load("minimax_h3_flf.json"));
  assert.ok(s.start_frame && s.end_frame, "flf needs a first and a last frame");
  assert.notEqual(s.start_frame!.node, s.end_frame!.node,
    "first and last frame resolved to the same LoadImage");
});

test("MiniMax H3 r2v exposes the reference builder", () => {
  const s = detectSlots(load("minimax_h3_r2v.json"));
  assert.ok(s.refs, "r2v must expose MiniMaxH3ReferenceToVideo for _wire_refs");
});

test("Wan: the prompt is the WIRED encoder, and the negative is found too", () => {
  for (const f of apiTemplates.filter((x) => x.startsWith("wan22"))) {
    const api = load(f) as ApiGraph;
    const s = detectSlots(api);
    assert.ok(s.prompt, `${f}: no prompt slot`);
    assert.equal(s.prompt!.class_type, "CLIPTextEncode", `${f}`);
    assert.equal(s.prompt!.input, "text");
    assert.ok(s.negative, `${f}: no negative slot`);
    assert.notEqual(s.prompt!.node, s.negative!.node, `${f}: positive and negative are the same node`);

    // the tagged node must really be the one wired to `positive`
    const sinks = Object.values(api).flatMap((n) =>
      Object.entries(n.inputs ?? {}).filter(([k]) => k === "positive").map(([, v]) => (v as string[])[0]));
    assert.ok(sinks.includes(s.prompt!.node), `${f}: prompt slot is not wired to a sampler`);
  }
});

test("LTX: size and seed are found on a third family", () => {
  const s = detectSlots(load("ltx23_i2v.json"));
  assert.ok(s.prompt && s.size && s.seed && s.output?.length);
});

test("the seed slot prefers the sampler over a helper node", () => {
  const api: ApiGraph = {
    "1": { class_type: "SeedNode", inputs: { seed: 42 } },
    "2": { class_type: "KSampler", inputs: { seed: 7, steps: 20 } },
  };
  assert.deepEqual(detectSlots(api).seed, { node: "2", input: "seed", class_type: "KSampler" });
});

test("a seed that arrives over a wire is not offered as a writable slot", () => {
  // writing into it would be overwritten by the link at execution time
  const api: ApiGraph = {
    "1": { class_type: "SeedNode", inputs: { seed: 42 } },
    "2": { class_type: "KSampler", inputs: { seed: ["1", 0] } },
  };
  assert.equal(detectSlots(api).seed?.node, "1");
});

/* ── validation ─────────────────────────────────────────────────────────── */

test("a node the engine lacks is an error, once per class", () => {
  const api: ApiGraph = {
    "1": { class_type: "SageAttentionCustomSampler", inputs: {} },
    "2": { class_type: "SageAttentionCustomSampler", inputs: {} },
    "3": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  };
  const issues = validateGraph(api, detectSlots(api), { classes: new Set(["SaveImage"]) });
  const missing = issues.filter((i) => i.kind === "missing_node");
  assert.equal(missing.length, 1, "one finding per class, not per node");
  assert.equal(missing[0].class_type, "SageAttentionCustomSampler");
});

test("an empty class set means 'could not ask', not 'nothing is installed'", () => {
  const api: ApiGraph = { "1": { class_type: "Whatever", inputs: {} } };
  const issues = validateGraph(api, detectSlots(api), { classes: new Set() });
  assert.equal(issues.filter((i) => i.kind === "missing_node").length, 0);
});

test("a Windows path matches the installed file by basename", () => {
  const api: ApiGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "D:\\ComfyUI\\models\\unet\\h3.safetensors" } },
    "2": { class_type: "UNETLoader", inputs: { unet_name: "nope.safetensors" } },
  };
  const files = { unet_name: new Set(["h3.safetensors"]) };
  const missing = validateGraph(api, detectSlots(api), { files }).filter((i) => i.kind === "missing_model");
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /nope\.safetensors/);
});

test("H3's two grids are enforced with the fix in the hint", () => {
  const api: ApiGraph = {
    "1": { class_type: "MiniMaxH3ImageToVideo",
           inputs: { prompt: "x", width: 1280, height: 720, length: 100 } },
    "2": { class_type: "SaveVideo", inputs: {} },
  };
  const issues = validateGraph(api, detectSlots(api));
  const dims = issues.find((i) => i.kind === "bad_dims");
  assert.ok(dims, "720 is not a multiple of 32 and H3 rejects it");
  assert.match(dims!.hint!, /1280x704/);
  const frames = issues.find((i) => i.kind === "bad_frames");
  assert.ok(frames, "100 is not on the 17n+5 grid");
  assert.match(frames!.hint!, /107/);
});

test("the frame grid helpers agree with invariant #5", () => {
  assert.equal(pad17(1), 5);
  assert.equal(pad17(5), 5);
  assert.equal(pad17(6), 22);
  assert.equal(pad17(22), 22);
  assert.equal(pad17(100), 107);
  for (const n of [5, 22, 39, 56, 107]) assert.equal(pad17(n), n, `${n} is already legal`);
});

test("dimension snapping rounds like Python, and keeps the author's framing", () => {
  // 720/32 is exactly 22.5. JS Math.round gives 23 (736); Python's round gives
  // 22 (704). Agreeing with the pod at the midpoint is the whole reason
  // pyRound exists — and 720 is the most common illegal height there is.
  assert.equal(snapDim(720), 704);
  assert.equal(snapDim(1280), 1280);
  assert.equal(snapDim(721), 736, "above the midpoint still rounds up");
  assert.equal(snapDim(10), 32, "never below one latent block");

  // The hint must be the nearest LEGAL size, not graphs.h3_snap_dims's nearest
  // NATIVE one: measured, that function sends 1280x720 AND 1920x1080 to
  // 736x416, and telling someone to fix a rounding error with a 3x downscale
  // would be worse than the error.
  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    const api: ApiGraph = {
      "1": { class_type: "MiniMaxH3ImageToVideo", inputs: { prompt: "x", width: w, height: h, length: 22 } },
      "2": { class_type: "SaveVideo", inputs: {} },
    };
    const hint = validateGraph(api, detectSlots(api)).find((i) => i.kind === "bad_dims")?.hint ?? "";
    assert.match(hint, new RegExp(`${w}x`), `${w}x${h}: the width was legal and must not move`);
    assert.ok(!/736x416/.test(hint), `${w}x${h}: hinted a downscale to 736x416`);
  }
});

test("the grids are only enforced where an H3 node reads them", () => {
  // a Flux graph at 720 high is perfectly legal — applying H3's rule to it
  // would be a fabricated error
  const api: ApiGraph = {
    "1": { class_type: "EmptyLatentImage", inputs: { width: 1280, height: 720, batch_size: 1 } },
    "2": { class_type: "SaveImage", inputs: {} },
  };
  assert.equal(validateGraph(api, detectSlots(api)).filter((i) => i.kind === "bad_dims").length, 0);
});

test("a graph with no output node is an error, not a warning", () => {
  const api: ApiGraph = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };
  const i = validateGraph(api, detectSlots(api)).find((x) => x.kind === "no_output");
  assert.equal(i?.level, "error");
});

test("an input pointing at a node that is not in the graph is caught", () => {
  const api: ApiGraph = {
    "1": { class_type: "VAEDecode", inputs: { samples: ["99", 0] } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  };
  const i = validateGraph(api, detectSlots(api)).find((x) => x.kind === "dangling_input");
  assert.match(i!.message, /#99/);
});

test("every shipped template passes validation against its own classes", () => {
  // the strongest available statement that the validator does not invent
  // problems: the graphs the pod renders every day must come back clean.
  for (const f of apiTemplates) {
    const api = load(f) as ApiGraph;
    const slots = detectSlots(api);
    const env = { classes: new Set(requiredClasses(api)) };
    const errors = validateGraph(api, slots, env).filter((i) => i.level === "error");
    assert.deepEqual(errors.map((e) => `${e.kind}:${e.message}`), [], `${f} should validate clean`);
  }
});

/* ── manifests + writing values back ────────────────────────────────────── */

test("requiredFiles lists what has to be on disk before the graph runs", () => {
  const files = requiredFiles(load("minimax_h3_i2v.json"));
  assert.ok(files.length > 0);
  assert.ok(files.every((f) => typeof f.value === "string" && f.value.length));
  assert.ok(files.some((f) => f.input === "unet_name" || f.input === "vae_name"));
});

test("applySlots writes only the tagged inputs, and never mutates the source", () => {
  const api = load("minimax_h3_i2v.json") as ApiGraph;
  const before = JSON.stringify(api);
  const slots = detectSlots(api);
  const out = applySlots(api, slots, {
    prompt: "a cat", seed: 999, width: 1280, height: 704, length: 107,
  });
  assert.equal(JSON.stringify(api), before, "the imported graph must not be mutated by a render");
  assert.equal(out[slots.prompt!.node].inputs.prompt, "a cat");
  assert.equal(out[slots.size!.node].inputs.width, 1280);
  assert.equal(out[slots.size!.node].inputs.length, 107);
  assert.equal(out[slots.seed!.node].inputs[slots.seed!.input], 999);

  // and nothing else moved
  const diff = apiNodes(out).filter((n) => JSON.stringify(n.inputs) !== JSON.stringify(api[n.id].inputs));
  const touched = new Set([slots.prompt!.node, slots.size!.node, slots.seed!.node]);
  assert.deepEqual(diff.map((n) => n.id).filter((id) => !touched.has(id)), []);
});

test("applySlots skips a value with no slot instead of throwing", () => {
  const api: ApiGraph = { "1": { class_type: "SaveImage", inputs: {} } };
  const out = applySlots(api, detectSlots(api), { prompt: "x", seed: 1, length: 22 });
  assert.deepEqual(out, api);
});

/* ── the fallback table is a promise about resolve.py's classes ─────────── */

test("the fallback table covers every class the shipped templates parameterise", () => {
  // an imported graph reusing a class our own templates use must convert with
  // exact widget names even when no engine is reachable.
  const need = new Set<string>();
  for (const f of apiTemplates) {
    for (const n of apiNodes(load(f))) need.add(n.class_type);
  }
  const missing = [...need].filter((c) => !(c in FALLBACK_WIDGETS)).sort();
  // Classes that legitimately have no widgets at all, or are pack nodes whose
  // schema we only ever get from the pod, are allowed to be absent — but the
  // list is pinned so adding one is a decision, not an accident.
  //
  // Two kinds are allowed. Core nodes with no widgets at all (nothing to map),
  // and PACK nodes whose INPUT_TYPES order we cannot know without asking an
  // engine — for those, guessing is the failure mode the whole table exists to
  // avoid, so they are left to /object_info and reported unmapped offline.
  const ALLOWED = new Set([
    "VAEDecodeAudio", "CreateVideo", "SaveVideo", "ConditioningZeroOut",
    "BasicGuider", "SamplerCustomAdvanced", "CFGGuider", "LatentUpscale",
    "ModelSamplingSD3", "PathchSageAttentionKJ", "MiniMaxH3TurboLoRA",
    "MiniMaxH3TurboSampler", "MiniMaxH3MotionContext", "MiniMaxH3AddGuide",
    "LatentUpscaleBy", "ImageScale", "SeedVR2", "RIFE VFI", "VHS_LoadVideo",
    "VHS_VideoCombine", "LatentConcat", "TorchCompileModel", "LoadVideo",
    "GetVideoComponents", "TrimVideoLatent", "MiniMaxH3ImageToVideoAdvanced",
    // LTX pack + lipsync + the audio-drive node: pod-schema only
    "LTX2LoraLoaderAdvanced", "LTXVConcatAVLatent", "LTXVConditioning",
    "LTXVEmptyLatentAudio", "LTXVImgToVideoInplace", "LTXVPreprocess",
    "LTXVSeparateAVLatent", "LatentSyncNode", "VRGDG_MiniMaxH3AudioDrive",
    "VideoLengthAdjuster",
    // The LTX 2.5 MSR pack. Its six CORE siblings are in FALLBACK_WIDGETS with
    // their real orders; these two are a third-party pack and only the pod can
    // say what their widgets are.
    "ComfyUILTX25MSRICLoRALoader", "ComfyUILTX25MSRMultiReferenceGuide",
  ]);
  const unexpected = missing.filter((c) => !ALLOWED.has(c));
  assert.deepEqual(unexpected, [],
    "add these to FALLBACK_WIDGETS (with their real INPUT_TYPES order) or to ALLOWED");
});

/* ── API → UI, checked by round trip ────────────────────────────────────── */
//
// `apiToUi` exists so a graph can be OPENED in ComfyUI's editor, which reads
// UI documents and draws NOTHING when handed an API one (measured on a live
// 0.33 engine). The risk in the conversion is entirely positional: a
// `widgets_values` array one slot out writes a value into the wrong input and
// the graph still opens, still runs, and renders something else. So it is
// checked the only way that catches that — convert BACK with the reader this
// repo already trusts and demand the original.

/**
 * The shared fixture is stored TRIMMED — `{required: {clip: "CLIP"}, output:
 * [...]}` — because `localGraphs.test.ts` only ever asks it for types. That is
 * not `/object_info`'s shape, where an entry is `[type, opts]` under `input`,
 * and `widgetNames` reads exactly that. Reshaped here rather than re-captured:
 * one fixture, two readers.
 */
const OI: ObjectInfo = (() => {
  const raw = JSON.parse(fs.readFileSync(
    path.join(ROOT, "src", "lib", "__fixtures__", "comfy_object_info.json"), "utf8")) as
    Record<string, { required?: Record<string, unknown>; optional?: Record<string, unknown>;
                     output?: unknown[] }>;
  // Three shapes in there, and the COMBO ones are why a naive wrap fails: the
  // fixture stores a combo either as its bare options list or as the
  // `"__FILE__"` placeholder (the real list is machine-specific), where
  // `/object_info` nests it — `[[opt, opt], {}]`. Wrapped flat, a combo's
  // first element is a plain string, `isWidgetEntry` reads it as a TYPE, and
  // every file picker in the graph is treated as a wire.
  const wrap = (g: Record<string, unknown> = {}) => Object.fromEntries(
    Object.entries(g).map(([k, v]) => [k,
      v === "__FILE__" ? [[]] : Array.isArray(v) ? [v] : [v]]));
  return Object.fromEntries(Object.entries(raw).map(([cls, spec]) => [cls, {
    input: { required: wrap(spec.required), optional: wrap(spec.optional) },
    output: spec.output ?? [],
  }])) as ObjectInfo;
})();

/** A value, with a link written so two graphs can be compared by shape. */
const val = (v: unknown) =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string"
    ? `link:${v[0]}:${v[1]}` : JSON.stringify(v);

test("every API template survives a round trip through the editor's format", () => {
  const apis = fs.readdirSync(WF).filter((f) => f.endsWith(".json"))
    .map((f) => [f, (() => { try { return load(f); } catch { return null; } })()] as const)
    .filter(([, g]) => g && isApiGraph(g));
  assert.ok(apis.length >= 10, `expected the repo's API templates, saw ${apis.length}`);
  let exact = 0, unmappedSeen = 0;
  const exactNames = new Set<string>();

  for (const [name, api] of apis) {
    // BOTH schema states, because both really happen: with the engine running
    // the widget order comes from it, and with nothing to ask it comes from
    // FALLBACK_WIDGETS — and an offline conversion that silently shifted its
    // widgets would be the harder one to notice.
    for (const [where, oi] of [["with /object_info", OI], ["offline", undefined]] as const) {
      const { graph, warnings, unmapped, dropped } = apiToUi(api as ApiGraph, oi);
      // An empty canvas is the failure this whole function exists to prevent,
      // and it is the one thing that must never happen whatever we know.
      assert.ok(graph.nodes.length > 0, `${name}: converted to an empty graph`);
      if (unmapped.length) {
        // A custom pack nobody here has a schema for — `lipsync_latentsync`'s
        // LatentSync nodes are the case. Its values are LEFT OUT rather than
        // written into a guessed slot, so it cannot round-trip and says so.
        // With that pack installed the live schema fills them.
        assert.match(warnings.join(" "), /no widget order/, `${name} ${where}`);
        unmappedSeen++;
        continue;
      }
      const back = uiToApi(graph, oi);
      // THE CONTRACT, and it is stronger than deepEqual: nothing the original
      // set may come back CHANGED, and anything that does not come back at all
      // has to have been REPORTED. An extra input is fine — a widget the graph
      // left unset takes its class default, which is what ComfyUI applies
      // anyway — but a silently altered or vanished value is the failure this
      // whole function could have.
      for (const [id, n] of Object.entries(api as ApiGraph)) {
        if (id.startsWith("_")) continue;
        assert.equal(back.api[id]?.class_type, n.class_type, `${name} #${id} changed class`);
        for (const [k, v] of Object.entries(n.inputs ?? {})) {
          const got = back.api[id]?.inputs?.[k];
          if (got === undefined) {
            assert.ok(dropped.includes(`#${id}.${k}`),
              `${name} ${where}: #${id}.${k} vanished without being reported`);
            continue;
          }
          assert.equal(val(got), val(v), `${name} ${where}: #${id}.${k} changed`);
        }
      }
      exact++;
      if (oi) exactNames.add(name);
    }
  }
  // …and the skip above cannot hollow the test out. THE SPLIT IS THE POINT:
  // with a schema every Wan and core-H3 template converts exactly, and those
  // are the ones the desktop renders; what stays unmapped is a graph naming a
  // CUSTOM PACK's classes (LTX's MSR guide, LatentSync, VRGDG's audio drive),
  // whose widget order only that pack's own engine can supply.
  const need = ["minimax_h3_t2v.json", "minimax_h3_i2v.json", "minimax_h3_flf.json",
                "minimax_h3_r2v.json", "wan22_5b_t2v.json", "wan22_14b_i2v.json"];
  for (const f of need) assert.ok(exactNames.has(f), `${f} did not round-trip with a schema`);
  assert.ok(exact >= 12, `only ${exact} conversions round-tripped exactly`);
  // OFFLINE IS NEVER CLEAN, and the feature is built on knowing it:
  // FALLBACK_WIDGETS covers the classes resolve.py PARAMETERISES, not every
  // class in a graph, so a conversion with no engine to ask loses values from
  // nodes like BasicGuider. That is why "Edit in ComfyUI" requires a running
  // engine — the schema comes from the same box that is about to open it.
  assert.equal(exactNames.size, exact, "offline should not have contributed an exact conversion");
});

test("the control_after_generate slot is kept, so nothing shifts after a seed", () => {
  // The trap, in the direction that writes it: ComfyUI puts a UI-only value
  // after a seed widget, so a converter that emits only the real inputs sends
  // every later widget one slot to the left — silently, since the graph still
  // opens and still runs.
  const spec: ObjectInfo = {
    KSampler: {
      input: {
        required: {
          seed: ["INT", { control_after_generate: true }],
          steps: ["INT", {}],
          cfg: ["FLOAT", {}],
          model: ["MODEL"],
        },
      },
      output: ["LATENT"],
    },
  };
  const { graph } = apiToUi(
    { "1": { class_type: "KSampler", inputs: { seed: 7, steps: 20, cfg: 8 } } }, spec);
  assert.deepEqual(graph.nodes[0].widgets_values, [7, "fixed", 20, 8]);
});

test("a class with no known widget order loses its values rather than guessing", () => {
  const { graph, unmapped, warnings } = apiToUi(
    { "1": { class_type: "SomePackNobodyHas", inputs: { alpha: 1, beta: "x" } } }, {});
  assert.deepEqual(unmapped, ["SomePackNobodyHas"]);
  assert.equal(graph.nodes[0].widgets_values, undefined);
  assert.match(warnings.join(" "), /no widget order/);
});

test("a link lands on the slot the editor would have put it in", () => {
  const api: ApiGraph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "hi", clip: ["1", 1] } },
  };
  const { graph } = apiToUi(api, OI);
  const enc = graph.nodes.find((n) => n.type === "CLIPTextEncode")!;
  const clip = enc.inputs?.find((i) => i.name === "clip");
  assert.ok(clip?.link != null, "the clip input was not wired");
  // …and the link records the ORIGIN slot, which is what carries CLIP rather
  // than MODEL out of a checkpoint loader.
  const link = graph.links?.find((l) => l && l[0] === clip!.link);
  assert.equal(link?.[2], 1, "the origin slot was not preserved");
  assert.equal(String(link?.[1]), "1");
});

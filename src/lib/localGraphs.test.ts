// A local graph is validated by a REAL ComfyUI, and only once — the first time
// it is rendered. Everything before that is this file.
//
// The failure mode these guard is the one that costs the most: a graph that
// ComfyUI accepts and samples for twenty minutes before failing on a channel
// count, or worse, one that succeeds and quietly renders the wrong thing (an
// adapter spliced below the sampler, a frame count off the family's grid, the
// 2.1 VAE on a 48-channel latent). `__fixtures__/comfy_object_info.json` is
// the node schema read off a live ComfyUI 0.33.0 with the GGUF pack installed,
// trimmed to the classes these builders emit and with the machine-specific
// file combos collapsed — so "does this input exist on this node, and is this
// combo value legal" is answered against the engine rather than from memory.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import {
  NO_RECIPE, pickFromAddon, RECIPES, samplingFor, snapFrames,
  type BuildInput,
} from "./localGraphs.ts";
import { FAMILIES, type FamilyAddon, type ModelFamily, type ModelVariant } from "./engineCatalog.ts";
import type { ApiGraph } from "./workflowAdapter.ts";

interface Spec {
  required: Record<string, unknown>;
  optional: Record<string, unknown>;
  output: string[];
}
const OI = JSON.parse(readFileSync(
  new URL("./__fixtures__/comfy_object_info.json", import.meta.url), "utf8")) as Record<string, Spec>;

const fam = (id: string): ModelFamily => {
  const f = FAMILIES.find((x) => x.id === id);
  assert.ok(f, `no family ${id}`);
  return f;
};
const variant = (f: ModelFamily, id: string): ModelVariant => {
  const v = f.variants.find((x) => x.id === id);
  assert.ok(v, `no variant ${id}`);
  return v;
};

function build(famId: string, varId: string, over: Partial<BuildInput> = {}): ApiGraph {
  const f = fam(famId);
  const v = variant(f, varId);
  const r = RECIPES[famId];
  return r.build({
    family: f, variant: v,
    prompt: "a test", negative: r.negative ?? "",
    width: 640, height: 352, seed: 7,
    sampling: samplingFor(r, varId),
    frames: r.kind === "video" ? snapFrames(r, 33) : undefined,
    loras: [], prefix: "qamba/test",
    ...over,
  });
}

/**
 * Every rule a graph must satisfy to be worth submitting, checked against the
 * engine's own schema. Returns the problems rather than throwing, so a failure
 * names all of them at once.
 */
function validate(g: ApiGraph): string[] {
  const bad: string[] = [];
  for (const [id, node] of Object.entries(g)) {
    const spec = OI[node.class_type];
    if (!spec) { bad.push(`#${id}: unknown class ${node.class_type}`); continue; }
    const known = { ...spec.required, ...spec.optional };
    // AUTOGROW inputs are declared once under a NAMESPACE and filled with
    // dotted keys — `ref_images.ref_image_0`, `images.image_1`. The live
    // engine accepts those; a validator that only knows the declared names
    // rejects every correct reference graph, which is how this one first
    // reported three healthy builders as broken.
    const autogrow = new Set(Object.entries(known)
      .filter(([, d]) => d === "COMFY_AUTOGROW_V3")
      .map(([k]) => k));
    const filled = new Set<string>();
    for (const [k, v] of Object.entries(node.inputs)) {
      const ns = k.includes(".") ? k.slice(0, k.indexOf(".")) : null;
      if (ns && autogrow.has(ns)) { filled.add(ns); continue; }
      const decl = known[k];
      if (decl === undefined) { bad.push(`#${id} ${node.class_type}: no input "${k}"`); continue; }
      if (Array.isArray(v) && typeof v[0] === "string" && v.length === 2 && typeof v[1] === "number") {
        // a wire — the node it names must exist and the slot must be plausible
        const [src, slot] = v as [string, number];
        if (!g[src]) bad.push(`#${id}.${k} wires to missing node #${src}`);
        else if (OI[g[src].class_type] && slot >= (OI[g[src].class_type].output?.length ?? 1)) {
          bad.push(`#${id}.${k} wants slot ${slot} of ${g[src].class_type}`);
        }
        continue;
      }
      // a literal into a COMBO must be one of the declared options, unless the
      // fixture collapsed a machine-specific file list.
      if (Array.isArray(decl) && decl !== "__FILE__" as unknown) {
        const opts = decl as unknown[];
        if (opts.length && !opts.includes(v)) {
          bad.push(`#${id} ${node.class_type}.${k}: "${String(v)}" is not one of ${opts.slice(0, 6).join("|")}`);
        }
      }
    }
    for (const k of Object.keys(spec.required)) {
      if (k in node.inputs || filled.has(k)) continue;
      bad.push(`#${id} ${node.class_type}: required "${k}" is missing`);
    }
  }
  return bad;
}

const EVERY: [string, string][] = [
  ["sd15", "sd15-fp16"],
  ["sdxl", "sdxl-turbo"],
  ["sdxl", "sdxl-base"],
  ["wan21-1.3b", "wan13-fp16"],
  ["wan21-1.3b", "wan13-q4"],
  ["wan22-5b", "wan5b-fp16"],
  ["wan22-5b", "wan5b-q6"],
  ["wan22-14b", "wan14b-fp8"],
  ["wan22-14b", "wan14b-q4"],
];

for (const [f, v] of EVERY) {
  test(`${f}/${v} builds a graph the engine's schema accepts`, () => {
    assert.deepEqual(validate(build(f, v)), []);
  });
}

test("every recipe covers a real family, and every renderable family a recipe", () => {
  for (const id of Object.keys(RECIPES)) {
    assert.ok(FAMILIES.some((f) => f.id === id), `RECIPES names a missing family ${id}`);
    assert.equal(RECIPES[id].family, id, `${id} recipe disagrees with its key`);
  }
});

test("a recipe's declared modes are ones the composer can drive", () => {
  // The audio modes are the discriminator between the MUSIC picker and the SFX
  // one, not a shape the composer's MODES map describes — both are `kind:
  // "audio"` because the column allows no third value, so `catalog.musicModels`
  // and `sfxModels` tell them apart by mode alone.
  const KNOWN = new Set(["t2i", "r2i", "edit", "t2v", "i2v", "flf", "r2v", "v2v",
                         "t2m", "t2sfx"]);
  for (const [id, r] of Object.entries(RECIPES)) {
    assert.ok(r.modes.length, `${id} declares no modes`);
    for (const m of r.modes) assert.ok(KNOWN.has(m), `${id} declares unknown mode ${m}`);
  }
});

test("a GGUF variant loads through UnetLoaderGGUF, an fp16 one does not", () => {
  const q = build("wan22-5b", "wan5b-q6");
  const f = build("wan22-5b", "wan5b-fp16");
  assert.equal(q["1"].class_type, "UnetLoaderGGUF");
  assert.equal(f["1"].class_type, "UNETLoader");
  // The stock loader will not even LIST a .gguf, so the wrong one here is not
  // a quality bug — it is a graph that cannot resolve its own weights.
  assert.match(String(q["1"].inputs.unet_name), /\.gguf$/);
  assert.match(String(f["1"].inputs.unet_name), /\.safetensors$/);
});

test("the 5B decodes through its own 48-channel VAE, not the 2.1 one", () => {
  // The bug this pins shipped: the catalogue row declared `wan_2.1_vae`, the
  // download completed, the row read installed, and VAEDecode could not have
  // worked. Both halves are asserted — the graph AND the catalogue — because
  // fixing only the graph would leave the file un-downloaded.
  const g = build("wan22-5b", "wan5b-q6");
  assert.equal(g["3"].inputs.vae_name, "wan2.2_vae.safetensors");
  assert.ok(fam("wan22-5b").shared.some((f) => f.filename === "wan2.2_vae.safetensors"));
  assert.equal(build("wan22-14b", "wan14b-q4")["3"].inputs.vae_name, "wan_2.1_vae.safetensors");
});

test("i2v adds a LoadImage and wires it into the latent; t2v does not", () => {
  const t2v = build("wan22-5b", "wan5b-q6");
  const i2v = build("wan22-5b", "wan5b-q6", { startImage: "start_00001_.png" });
  assert.equal(t2v["7"].inputs.start_image, undefined);
  assert.deepEqual(i2v["7"].inputs.start_image, ["15", 0]);
  assert.equal(i2v["15"].inputs.image, "start_00001_.png");
  assert.deepEqual(validate(i2v), []);
});

test("a picked adapter goes BETWEEN the model and the sampler", () => {
  // The pod learned this one the hard way (`resolve()`'s stack splice must sit
  // below the style splice). Spliced anywhere else the LoRA loads, logs
  // nothing, and changes nothing about the render.
  const lora: FamilyAddon = {
    id: "x", name: "x", kind: "speed", blurb: "",
    files: [{ url: "", filename: "x.safetensors", dir: "loras", size_mb: 1 }],
  };
  const g = build("wan22-5b", "wan5b-q6", { loras: [pickFromAddon(lora, 0.8)] });
  const node = Object.entries(g).find(([, n]) => n.class_type === "LoraLoaderModelOnly");
  assert.ok(node, "no LoraLoaderModelOnly was spliced");
  const [id, n] = node;
  assert.deepEqual(n.inputs.model, ["6", 0], "must take the shifted model");
  assert.deepEqual(g["8"].inputs.model, [id, 0], "the sampler must read the LoRA's output");
  assert.deepEqual(validate(g), []);
});

test("a distillation's step count beats the recipe, and the user beats both", () => {
  const r = RECIPES["wan22-14b"];
  const turbo = (fam("wan22-14b").addons ?? []).find((a) => a.id === "wan-lightx2v");
  assert.ok(turbo?.sampling, "the 4-step distill must be machine-readable, not just prose");
  assert.equal(samplingFor(r, "wan14b-q4").steps, 20);
  assert.equal(samplingFor(r, "wan14b-q4", [pickFromAddon(turbo!)]).steps, 4);
  assert.equal(samplingFor(r, "wan14b-q4", [pickFromAddon(turbo!)], { steps: 12 }).steps, 12);
});

test("the LightX2V adapter is only offered on the family it fits", () => {
  // Measured off the file's own header: its tensors are 5120 wide, which is
  // the 14B's hidden size. The 1.3B is 1536 and the 5B is 3072, and ComfyUI's
  // loader skips what it cannot reshape rather than erroring — so offering it
  // there is a 4-step render of a model that was never distilled.
  const has = (id: string) => (fam(id).addons ?? []).some((a) => a.id === "wan-lightx2v");
  assert.equal(has("wan22-14b"), true);
  assert.equal(has("wan22-5b"), false);
  assert.equal(has("wan21-1.3b"), false);
});

test("the 14B pair splits the schedule at half of whatever steps it runs", () => {
  const g = build("wan22-14b", "wan14b-q4");
  assert.equal(g["10"].inputs.end_at_step, g["11"].inputs.start_at_step);
  assert.equal(g["10"].inputs.end_at_step, 10);
  assert.equal(g["10"].inputs.return_with_leftover_noise, "enable");
  assert.equal(g["11"].inputs.add_noise, "disable");
  // and the two experts are two DIFFERENT files, in high-then-low order
  assert.match(String(g["1"].inputs.unet_name), /High/i);
  assert.match(String(g["2b"].inputs.unet_name), /Low/i);
});

test("frames land on the family's own grid", () => {
  const wan = RECIPES["wan22-5b"];
  for (const n of [1, 20, 33, 49, 100]) {
    assert.equal((snapFrames(wan, n) - 1) % 4, 0, `${n} -> ${snapFrames(wan, n)} is not 4n+1`);
  }
  assert.equal(snapFrames(wan, 0), 5, "never below one grid step");
});

test("every graph ends in a node that WRITES a file", () => {
  // A preview-only graph runs happily and leaves nothing to upload — the job
  // then "succeeds" with no asset, which is `resolve_custom`'s documented trap
  // arriving from the other direction.
  for (const [f, v] of EVERY) {
    const g = build(f, v);
    const saves = Object.values(g).filter((n) => /^Save/.test(n.class_type));
    assert.equal(saves.length, 1, `${f}/${v} has ${saves.length} save nodes`);
    assert.equal(saves[0].inputs.filename_prefix, "qamba/test");
  }
});

/* ── Krea 2, the studio's own default image model ───────────────────────── */

test("Krea 2 renders locally, on the pod's own recipe", () => {
  // Ported node for node from `worker/graphs.py::krea2_graph`, which is the
  // only reason it can exist: that graph is entirely stock ComfyUI, so the
  // `NO_RECIPE` claim that this family "needs the Krea2EditRebalance node" was
  // only ever true of the REFERENCE path.
  const g = build("krea2", "krea2-fp8");
  assert.deepEqual(validate(g), []);
  const cls = Object.values(g).map((n) => n.class_type);
  assert.ok(cls.includes("EmptySD3LatentImage"),
    "the latent must match the UNET's channel count — EmptyLatentImage fails at VAEDecode");
  assert.ok(cls.includes("ConditioningZeroOut"),
    "cfg 1.0 never evaluates a second encode; the reference workflow zeroes the positive");
  assert.equal(
    Object.values(g).filter((n) => n.class_type === "CLIPTextEncode").length, 1,
    "a second text encode would be a negative prompt the sampler cannot use");
});

test("Krea 2's CLIP loader asks for the tap this checkpoint was trained on", () => {
  const g = build("krea2", "krea2-fp8");
  const clip = Object.values(g).find((n) => n.class_type === "CLIPLoader");
  assert.equal(clip?.inputs.type, "krea2");
});

test("a quantised Krea 2 takes the GGUF loader the installer already provides", () => {
  const g = build("krea2", "krea2-q4");
  assert.deepEqual(validate(g), []);
  assert.equal(g["1"].class_type, "UnetLoaderGGUF");
  assert.match(String(g["1"].inputs.unet_name), /\.gguf$/);
  // …and the unquantised one does not.
  assert.equal(build("krea2", "krea2-fp8")["1"].class_type, "UNETLoader");
});

test("a picked LoRA lands between the Krea 2 loader and its sampler", () => {
  const g = build("krea2", "krea2-fp8", {
    loras: [{ files: ["hub.safetensors"], strength: 0.8 }],
  });
  assert.deepEqual(validate(g), []);
  const ks = Object.values(g).find((n) => n.class_type === "KSampler")!;
  const feeding = g[String(ks.inputs.model[0])];
  assert.equal(feeding.class_type, "LoraLoaderModelOnly");
  assert.equal(feeding.inputs.lora_name, "hub.safetensors");
  assert.equal(feeding.inputs.strength_model, 0.8);
});

test("a recipe declares a negative only where the graph can sample one", () => {
  // Not an omission — a property of the graph. Krea 2 turbo runs cfg 1.0 into
  // a ConditioningZeroOut and H3 conditions through BasicGuider, which has no
  // uncond branch at all; a field on either would be a control that provably
  // cannot change the render.
  // Krea 2 zeroes the positive encode; H3 conditions through BasicGuider;
  // Music 3 zeroes the positive too. Stable Audio is the audio family that
  // DOES wire a second encode, at cfg 7 — which is why its distilled variants
  // are handled per-variant rather than here (see `localModelRows`).
  // Two distinct reasons, and both count: some graphs wire no second encode
  // at all (Krea 2 and Music 3 zero the positive; H3 conditions through
  // BasicGuider), and Flux 2 dev is GUIDANCE-DISTILLED — it wires a
  // ConditioningZeroOut into a CFGGuider at cfg 1, where the uncond branch is
  // never evaluated whatever is attached to it.
  // LTX 2.5 is the fourth reason and a different one: its guider is
  // `LTXVDualCFGGuider`, which core drops to single-CFG the moment its two
  // scales match — and the distilled recipe is 1.0/1.0, so the uncond branch
  // is never evaluated whatever is wired to it. The builder zeroes rather than
  // encoding a second prompt so that this test can check the claim.
  // Both Klein sizes are the same case as Flux 2 dev, for the same reason:
  // BFL's distilled klein publishes `guidance_scale=1.0`, so the CFGGuider's
  // uncond branch is never evaluated. (Klein *base* would NOT belong here — it
  // wants real guidance — which is one of the reasons this catalogue offers
  // the distilled checkpoints only.)
  const NO_UNCOND = new Set(["krea2", "minimax-h3", "music3", "flux2", "acestep", "ltx25",
    "flux2-klein-4b", "flux2-klein-9b"]);
  for (const [id, r] of Object.entries(RECIPES)) {
    if (NO_UNCOND.has(id)) assert.equal(r.negative, undefined, `${id} should declare none`);
    else assert.ok(r.negative, `${id} should still declare a default negative`);
  }
  // …and the claim is checked against the GRAPH, not just asserted: a family
  // said to have no uncond branch must not wire a second text encode.
  for (const id of NO_UNCOND) {
    const f = fam(id);
    const g = build(id, f.variants[0].id);
    const encodes = Object.values(g)
      .filter((n) => String(n.class_type).includes("TextEncode")).length;
    assert.ok(encodes <= 1, `${id} wires ${encodes} text encodes but claims no uncond`);
    assert.ok(Object.values(g).some((n) => n.class_type === "ConditioningZeroOut")
      || !Object.values(g).some((n) => n.class_type === "KSampler"),
      `${id} has one encode and no ConditioningZeroOut — what feeds the negative?`);
  }
});

/* ── MiniMax H3, the studio's own video model ───────────────────────────── */

test("H3 renders locally — every class its templates name is stock", () => {
  const g = build("minimax-h3", "h3-int8");
  assert.deepEqual(validate(g), []);
  const cls = Object.values(g).map((n) => n.class_type);
  for (const n of ["MiniMaxH3ImageToVideo", "BasicGuider", "SamplerCustomAdvanced",
                   "VAEDecodeAudio", "CreateVideo", "SaveVideo"]) {
    assert.ok(cls.includes(n), `H3 needs ${n}`);
  }
});

test("H3 decodes the SAME latent twice, through two different VAEs", () => {
  // Native audio is the whole reason an episode renders on this model. Wiring
  // both decodes to the video VAE loses the soundtrack silently: the file
  // plays, mute.
  const g = build("minimax-h3", "h3-int8");
  const video = Object.values(g).find((n) => n.class_type === "VAEDecode")!;
  const audio = Object.values(g).find((n) => n.class_type === "VAEDecodeAudio")!;
  assert.deepEqual(video.inputs.samples, audio.inputs.samples, "one latent, two decodes");
  const nameOf = (ref: unknown) =>
    String(g[String((ref as [string, number])[0])].inputs.vae_name);
  assert.match(nameOf(video.inputs.vae), /video/);
  assert.match(nameOf(audio.inputs.vae), /audio/);
  assert.notEqual(nameOf(video.inputs.vae), nameOf(audio.inputs.vae));
  // …and the sound actually reaches the file.
  const cv = Object.values(g).find((n) => n.class_type === "CreateVideo")!;
  assert.deepEqual(cv.inputs.audio, [
    Object.entries(g).find(([, n]) => n.class_type === "VAEDecodeAudio")![0], 0]);
});

test("the loader is picked by the FILE, so a GGUF UNet can take a safetensors encoder", () => {
  // THE PAIRING CHANGED UNDER THIS BUILDER AND IT DID THE RIGHT THING. H3's
  // quantised rungs used to carry Abiray's Q4 GGUF text encoder, and the
  // 2026-09-01 tier benchmark measured that pairing OOMing during text encode
  // at 8, 12 and 16GB — ComfyUI partial-loads its 14.6GB to ~13.4GB and the
  // encode's 1.45GiB activation has nowhere to go. Every GGUF rung now names
  // the nvfp4 SAFETENSORS encoder instead.
  //
  // `clipLoader` keys off the extension rather than the variant's `precision`,
  // which is exactly why that swap needed no change here — and this is the
  // test that says so, because keying off precision would have looked correct
  // right up until the day the two stopped agreeing.
  const g = build("minimax-h3", "h3-q4");
  assert.deepEqual(validate(g), []);
  assert.equal(g["1"].class_type, "UnetLoaderGGUF", "the UNet is still quantised");
  assert.equal(g["2"].class_type, "CLIPLoader", "…and its encoder is not");
  assert.equal(g["2"].inputs.device, "default");
  // …and the int8 rung, whose files are safetensors throughout, is unchanged.
  const s = build("minimax-h3", "h3-int8");
  assert.equal(s["1"].class_type, "UNETLoader");
  assert.equal(s["2"].class_type, "CLIPLoader");
  // The GGUF loader has no `device` input and sending one fails validation, so
  // the rule still has to hold for a genuinely GGUF encoder.
  const q = build("qwen-edit", "qwen-q4");
  assert.ok(Object.values(q).every((n) =>
    n.class_type !== "CLIPLoaderGGUF" || n.inputs.device === undefined));
});

test("H3's conditioning names the tap, and its steps come off the SCHEDULER", () => {
  const g = build("minimax-h3", "h3-int8");
  assert.equal(g["2"].inputs.type, "minimax");
  // The trap `resolve()` documents on the pod: H3 samples through
  // BasicScheduler, so a step count written onto a KSampler is dropped.
  const sch = Object.values(g).find((n) => n.class_type === "BasicScheduler")!;
  assert.equal(sch.inputs.steps, RECIPES["minimax-h3"].sampling.steps);
  assert.ok(!Object.values(g).some((n) => n.class_type === "KSampler"));
});

test("i2v pins a first frame; t2v wires none", () => {
  const t2v = build("minimax-h3", "h3-int8");
  assert.ok(!Object.values(t2v).some((n) => n.class_type === "LoadImage"));
  assert.equal(t2v["6"].inputs.first_frame, undefined);
  const i2v = build("minimax-h3", "h3-int8", { startImage: "seed.png" });
  assert.deepEqual(validate(i2v), []);
  const load = Object.entries(i2v).find(([, n]) => n.class_type === "LoadImage")!;
  assert.equal(load[1].inputs.image, "seed.png");
  assert.deepEqual(i2v["6"].inputs.first_frame, [load[0], 0]);
});

test("frames land on H3's own 17n+5 grid, which is the node's own step", () => {
  const r = RECIPES["minimax-h3"];
  for (const n of [1, 5, 60, 124, 125, 300]) {
    const f = snapFrames(r, n);
    assert.equal((f - 5) % 17, 0, `${n} -> ${f} is off the grid`);
    assert.ok(f >= 5, `${n} -> ${f} is below the node's minimum`);
  }
});

test("a distillation rewrites H3's step count instead of loading for nothing", () => {
  const lx = (fam("minimax-h3").addons ?? []).find((a) => a.id === "h3-lightx2v-8")!;
  assert.equal(samplingFor(RECIPES["minimax-h3"], "h3-int8").steps, 20);
  const s = samplingFor(RECIPES["minimax-h3"], "h3-int8", [pickFromAddon(lx)]);
  assert.equal(s.steps, 8);
  assert.equal(s.sampler, "sa_solver");
});

/* ── Qwen-Image-Edit: the only local family that composes from pictures ──── */

test("Qwen-Edit builds clean with no references at all", () => {
  const g = build("qwen-edit", "qwen-fp8");
  assert.deepEqual(validate(g), []);
  assert.ok(!Object.values(g).some((n) => n.class_type === "LoadImage"));
  // Both encodes exist even with nothing staged: cfg is 2.5 here, so unlike
  // every turbo checkpoint in this catalogue the negative branch is real.
  const enc = Object.values(g).filter((n) => n.class_type === "TextEncodeQwenImageEditPlus");
  assert.equal(enc.length, 2);
  assert.equal(RECIPES["qwen-edit"].sampling.cfg, 2.5);
});

test("references are staged in PICK ORDER and capped at the node's three", () => {
  const g = build("qwen-edit", "qwen-fp8", { refImages: ["a.png", "b.png", "c.png", "d.png"] });
  assert.deepEqual(validate(g), []);
  const loads = Object.entries(g).filter(([, n]) => n.class_type === "LoadImage");
  assert.equal(loads.length, 3, "TextEncodeQwenImageEditPlus takes image1..image3");
  const pos = Object.values(g).find((n) => n.class_type === "TextEncodeQwenImageEditPlus")!;
  // image1 is the slot the node anchors on, so order is composition, not taste.
  const named = (k: string) => g[String((pos.inputs[k] as [string, number])[0])].inputs.image;
  assert.equal(named("image1"), "a.png");
  assert.equal(named("image2"), "b.png");
  assert.equal(named("image3"), "c.png");
});

test("both encodes see the same pictures — only the prompt differs", () => {
  const g = build("qwen-edit", "qwen-fp8", { refImages: ["a.png", "b.png"] });
  const [pos, neg] = Object.entries(g)
    .filter(([, n]) => n.class_type === "TextEncodeQwenImageEditPlus")
    .sort(([a], [b]) => Number(a) - Number(b)).map(([, n]) => n);
  assert.deepEqual(pos.inputs.image1, neg.inputs.image1);
  assert.deepEqual(pos.inputs.image2, neg.inputs.image2);
  assert.notEqual(pos.inputs.prompt, neg.inputs.prompt);
});

test("the flow-model nodes ride BELOW the LoRA chain", () => {
  // Spliced above them, an adapter would be sampled through an unshifted
  // model — it would load, and quietly do the wrong thing.
  const g = build("qwen-edit", "qwen-fp8", {
    loras: [{ files: ["x.safetensors"], strength: 1 }],
  });
  assert.deepEqual(validate(g), []);
  const shift = Object.values(g).find((n) => n.class_type === "ModelSamplingAuraFlow")!;
  assert.equal(g[String((shift.inputs.model as [string, number])[0])].class_type,
    "LoraLoaderModelOnly");
  const ks = Object.values(g).find((n) => n.class_type === "KSampler")!;
  assert.equal(g[String((ks.inputs.model as [string, number])[0])].class_type, "CFGNorm");
});

test("the latent starts EMPTY, which is what makes this compose and not repaint", () => {
  const g = build("qwen-edit", "qwen-fp8", { refImages: ["a.png"] });
  const ks = Object.values(g).find((n) => n.class_type === "KSampler")!;
  assert.equal(g[String((ks.inputs.latent_image as [string, number])[0])].class_type,
    "EmptySD3LatentImage");
  assert.equal(ks.inputs.denoise, 1.0);
});

/* ── audio: the category that did not exist locally at all ──────────────── */

test("both audio families build clean and end in a file", () => {
  for (const id of ["music3", "stable-audio"]) {
    for (const v of fam(id).variants) {
      const g = build(id, v.id, { seconds: 30, lyrics: "la la" });
      assert.deepEqual(validate(g), [], `${id}/${v.id}`);
      assert.ok(Object.values(g).some((n) => n.class_type === "SaveAudioMP3"),
        `${id}/${v.id} writes nothing`);
      assert.ok(Object.values(g).some((n) => n.class_type === "VAEDecodeAudio"),
        `${id}/${v.id} never decodes audio`);
    }
  }
});

test("Music 3's length comes off the ENCODER, not off a number", () => {
  // `MiniMaxMusic3TextEncode` returns (CONDITIONING, FLOAT) and that float is
  // the duration its 8B planner chose having read the lyrics. Writing our own
  // number into the latent renders fine and pads the end with filler.
  const g = build("music3", "music3-fp16", { seconds: 90 });
  const latent = Object.values(g).find((n) => n.class_type === "EmptyMiniMaxMusic3LatentAudio")!;
  const enc = Object.entries(g).find(([, n]) => n.class_type === "MiniMaxMusic3TextEncode")!;
  assert.deepEqual(latent.inputs.seconds, [enc[0], 1], "slot 1 is the planned duration");
  assert.notEqual(typeof latent.inputs.seconds, "number");
  // …and the number we were given is the CEILING it may finish under.
  assert.equal(enc[1].inputs.max_duration, 90);
});

test("Stable Audio takes t5gemma, not the checkpoint's own CLIP", () => {
  // CheckpointLoaderSimple hands back a CLIP and it is a decoy: the
  // conditioner is t5gemma at type `stable_audio`. Taking slot 1 would
  // validate and condition on the wrong encoder.
  const g = build("stable-audio", "sa-sfx", { seconds: 6 });
  const enc = Object.values(g).filter((n) => n.class_type === "CLIPTextEncode");
  assert.equal(enc.length, 2);
  for (const e of enc) {
    const src = g[String((e.inputs.clip as [string, number])[0])];
    assert.equal(src.class_type, "CLIPLoader");
    assert.equal(src.inputs.type, "stable_audio");
  }
  // The VAE, by contrast, IS the checkpoint's — slot 2, no VAELoader.
  const dec = Object.values(g).find((n) => n.class_type === "VAEDecodeAudio")!;
  assert.deepEqual(dec.inputs.vae, ["1", 2]);
  assert.ok(!Object.values(g).some((n) => n.class_type === "VAELoader"));
});

test("a distilled audio checkpoint is sampled as one — `_base` is the tell", () => {
  const r = RECIPES["stable-audio"];
  assert.deepEqual(
    { steps: samplingFor(r, "sa-sfx").steps, cfg: samplingFor(r, "sa-sfx").cfg },
    { steps: 8, cfg: 1 });
  assert.deepEqual(
    { steps: samplingFor(r, "sa-medium").steps, cfg: samplingFor(r, "sa-medium").cfg },
    { steps: 8, cfg: 1 }, "the plain name is the DISTILLED one");
  assert.deepEqual(
    { steps: samplingFor(r, "sa-sfx-base").steps, cfg: samplingFor(r, "sa-sfx-base").cfg },
    { steps: 50, cfg: 7 });
  // Every variant the catalogue declares is either in the map or on the base
  // recipe deliberately — a typo'd key would silently leave a distillation at
  // 50 steps, which is how `sa-medium` was wrong on the first pass.
  for (const k of Object.keys(r.perVariant ?? {})) {
    assert.ok(fam("stable-audio").variants.some((v) => v.id === k),
      `perVariant names ${k}, which is not a variant`);
  }
});

test("an audio family declares seconds, not a frame grid", () => {
  for (const id of ["music3", "stable-audio"]) {
    const r = RECIPES[id];
    assert.equal(r.kind, "audio");
    assert.ok(r.maxSeconds, `${id} needs a length ceiling`);
    assert.equal(r.frameBase, undefined);
    assert.deepEqual(r.sizes, [], "a track has no resolution");
  }
});

/* ── the families the mirror and the audit added last ───────────────────── */

test("every recipe builds a graph the engine's schema accepts", () => {
  // The blanket check. Each family below has its own test for the thing that
  // is easy to get wrong about IT; this one catches a new recipe that was
  // never wired up at all.
  for (const [id, r] of Object.entries(RECIPES)) {
    for (const v of fam(id).variants) {
      const g = build(id, v.id, {
        seconds: 30, lyrics: "x", refImages: r.modes.some((m) => m === "r2i" || m === "r2v")
          ? ["a.png", "b.png"] : [],
      });
      assert.deepEqual(validate(g), [], `${id}/${v.id}`);
    }
  }
});

test("H3 reference-to-video is a DIFFERENT node, wired to the audio VAE", () => {
  const g = build("minimax-h3", "h3-int8", { refImages: ["a.png", "b.png"] });
  assert.deepEqual(validate(g), []);
  const node = Object.values(g).find((n) => n.class_type === "MiniMaxH3ReferenceToVideo");
  assert.ok(node, "r2v must not reuse MiniMaxH3ImageToVideo");
  assert.ok(!Object.values(g).some((n) => n.class_type === "MiniMaxH3ImageToVideo"));
  // The audio VAE is REQUIRED on this node, unlike the i2v one.
  assert.ok(node!.inputs.audio_vae, "r2v requires the audio VAE");
  // NAMESPACED autogrow keys. ComfyUI drops a key a class does not declare,
  // so a bare `image1` here would render a text-to-video and log nothing.
  assert.ok(node!.inputs["ref_images.ref_image_0"], "slots are ref_images.ref_image_N");
  assert.ok(node!.inputs["ref_images.ref_image_1"]);
  assert.equal(node!.inputs.image1, undefined);
  // …and only ONE audio VAE loader, even though both branches want it.
  assert.equal(Object.values(g).filter((n) => n.class_type === "VAELoader"
    && String(n.inputs.vae_name).includes("audio")).length, 1);
});

test("HiDream's reference keys are FLAT, unlike H3's", () => {
  // The two node families spell autogrow differently and both fail silently
  // when it is wrong — this is the pair that makes the distinction concrete.
  const g = build("hidream-o1", "hidream-fp8", { refImages: ["a.png"] });
  assert.deepEqual(validate(g), []);
  const refs = Object.values(g).find((n) => n.class_type === "HiDreamO1ReferenceImages")!;
  assert.ok(refs.inputs["images.image_1"], "HiDream numbers from 1 under `images.`");
  assert.equal(refs.inputs["ref_images.ref_image_0"], undefined);
  // With references the sampler takes BOTH conditionings off the ref node.
  const sc = Object.values(g).find((n) => n.class_type === "SamplerCustom")!;
  assert.deepEqual(sc.inputs.positive, [Object.entries(g)
    .find(([, n]) => n.class_type === "HiDreamO1ReferenceImages")![0], 0]);
  assert.deepEqual(sc.inputs.negative, [Object.entries(g)
    .find(([, n]) => n.class_type === "HiDreamO1ReferenceImages")![0], 1]);
  // …and without them, off the text encodes.
  const plain = build("hidream-o1", "hidream-fp8");
  const sc2 = Object.values(plain).find((n) => n.class_type === "SamplerCustom")!;
  assert.deepEqual(sc2.inputs.positive, ["4", 0]);
});

test("Flux 2 chains its references, so order is the composition", () => {
  const g = build("flux2", "flux2-q4", { refImages: ["a.png", "b.png"] });
  assert.deepEqual(validate(g), []);
  const guider = Object.values(g).find((n) => n.class_type === "CFGGuider")!;
  // The guider's positive is the LAST ReferenceLatent, which chains back
  // through the first to the text encode.
  const chain: string[] = [];
  let at = String((guider.inputs.positive as [string, number])[0]);
  while (g[at]?.class_type === "ReferenceLatent") {
    chain.push(at);
    at = String((g[at].inputs.conditioning as [string, number])[0]);
  }
  assert.equal(chain.length, 2, "one ReferenceLatent per picture");
  assert.equal(g[at].class_type, "CLIPTextEncode", "the chain roots on the prompt");
});

test("ACE-Step needs BOTH encoders, and writes one duration twice", () => {
  const g = build("acestep", "ace-turbo", { seconds: 90 });
  assert.deepEqual(validate(g), []);
  const dual = Object.values(g).find((n) => n.class_type === "DualCLIPLoader")!;
  assert.notEqual(dual.inputs.clip_name1, dual.inputs.clip_name2,
    "loading one file into both slots is not a smaller model, it is a broken one");
  // Unlike Music 3 there is no duration OUTPUT to read back, so the two
  // numbers must agree or the tail is filler.
  const enc = Object.values(g).find((n) => n.class_type === "TextEncodeAceStepAudio1.5")!;
  const latent = Object.values(g).find((n) => n.class_type === "EmptyAceStep1.5LatentAudio")!;
  assert.equal(enc.inputs.duration, 90);
  assert.equal(latent.inputs.seconds, 90);
});

test("Anima is the one image family that is not distilled", () => {
  const r = RECIPES.anima;
  assert.ok(r.sampling.steps >= 30 && r.sampling.cfg >= 3,
    "sampling an undistilled model like a turbo one is what makes it look bad");
  assert.ok(r.negative, "and its negative branch is real");
  const g = build("anima", "anima-bf16");
  assert.equal(
    Object.values(g).filter((n) => n.class_type === "CLIPTextEncode").length, 2);
  // Its encoder loads at type `stable_diffusion` despite being a Qwen tower —
  // the template's own value, not a tidy-up target.
  assert.equal(g["2"].inputs.type, "stable_diffusion");
});

/* ── post passes: the tools that run over a finished clip ───────────────── */

import { POST_PROCESS } from "./engineCatalog.ts";
import { POST_RECIPES, postRecipe } from "./localGraphs.ts";

const buildPost = (id: string, over: Partial<BuildInput> = {}): ApiGraph => {
  const r = postRecipe(id)!;
  const tool = POST_PROCESS.find((t) => t.id === r.tool)!;
  return r.build({
    family: { id: tool.id, name: tool.name, media: "video", blurb: "",
              license: tool.license, shared: [], variants: [] },
    variant: { id: tool.id, label: tool.name, precision: "fp16",
               files: tool.files, vram_gb: tool.vram_gb, quality: "" },
    prompt: "", negative: "", width: 0, height: 0, seed: 1,
    sampling: { steps: 1, cfg: 1, sampler: "euler", scheduler: "simple" },
    loras: [], prefix: "p", sourceVideo: "clip.mp4", ...over,
  });
};

test("every post pass builds a graph the engine accepts", () => {
  for (const r of Object.values(POST_RECIPES)) {
    assert.deepEqual(validate(buildPost(r.tool)), [], r.tool);
  }
});

test("a post pass names a tool the catalogue can actually download", () => {
  // The half that rots: a recipe keyed on an id `POST_PROCESS` does not carry
  // is a button that resolves to nothing at render time.
  for (const r of Object.values(POST_RECIPES)) {
    const tool = POST_PROCESS.find((t) => t.id === r.tool);
    assert.ok(tool, `${r.tool} has no POST_PROCESS entry`);
    assert.ok(tool!.files.length, `${r.tool} names no weights`);
  }
});

test("SeedVR2 is one step, and its colour reference is the RESIZED input", () => {
  const g = buildPost("seedvr2-3b", { factor: 2 });
  const ks = Object.values(g).find((n) => n.class_type === "KSampler")!;
  assert.equal(ks.inputs.steps, 1, "raising this is fighting the model");
  assert.equal(ks.inputs.cfg, 1);
  // `original_resized_images` is the ENLARGED input, not the source: it has to
  // be the same geometry as the decode or the colour match is against a
  // different picture.
  const post = Object.values(g).find((n) => n.class_type === "SeedVR2PostProcessing")!;
  const scale = Object.entries(g).find(([, n]) => n.class_type === "ImageScaleBy")!;
  assert.deepEqual(post.inputs.original_resized_images, [scale[0], 0]);
  assert.equal(scale[1].inputs.scale_by, 2);
  // Scale 1.0 is a legitimate request, not a no-op — see the builder.
  const same = buildPost("seedvr2-3b", { factor: 1 });
  assert.deepEqual(validate(same), []);
});

test("a post pass carries the SOURCE's own sound and frame rate through", () => {
  // A restore that silently resampled the audio or dropped it would be a
  // different clip handed back under the same name.
  for (const r of Object.values(POST_RECIPES)) {
    const g = buildPost(r.tool);
    const comps = Object.entries(g).find(([, n]) => n.class_type === "GetVideoComponents")!;
    const cv = Object.values(g).find((n) => n.class_type === "CreateVideo")!;
    assert.deepEqual(cv.inputs.audio, [comps[0], 1], `${r.tool} drops the audio`);
    assert.deepEqual(cv.inputs.fps, [comps[0], 2], `${r.tool} invents a frame rate`);
  }
});

test("interpolation multiplies the frame rate rather than slowing the clip", () => {
  const g = buildPost("frame-interp", { factor: 4 });
  const fi = Object.values(g).find((n) => n.class_type === "FrameInterpolate")!;
  assert.equal(fi.inputs.multiplier, 4);
  // Below 2 there is nothing to interpolate, so the floor is not a preference.
  assert.equal(
    Object.values(buildPost("frame-interp", { factor: 1 }))
      .find((n) => n.class_type === "FrameInterpolate")!.inputs.multiplier, 2);
});

test("every ported-from source still resolves", () => {
  // `portedFrom` is a CLAIM about another file, and a claim about a file is
  // the kind of documentation that rots silently — a renamed template leaves
  // the Workflows page pointing at a graph nobody ships. Every entry is either
  // a template on disk or a symbol in graphs.py; anything else is prose and is
  // allowed, since two of these graphs came from stock ComfyUI and there is no
  // file here to name.
  const root = new URL("../../", import.meta.url);
  const graphsPy = readFileSync(new URL("worker/graphs.py", root), "utf8");
  const named = Object.values(RECIPES).flatMap((r) => r.portedFrom ?? []);
  assert.ok(named.length > 0, "no recipe records where its graph came from");

  for (const src of named) {
    if (src.startsWith("workflows/")) {
      assert.ok(existsSync(new URL(src, root)), `${src} is named but not in the repo`);
    } else if (src.startsWith("worker/graphs.py::")) {
      const fn = src.split("::")[1];
      assert.match(graphsPy, new RegExp(`^def ${fn}\\b`, "m"), `graphs.py has no ${fn}`);
    }
  }
});

test("the video families the engine window offers all have a recipe", () => {
  // The complaint this answers: "I have Wan downloaded and see no workflow for
  // it." A downloadable family with no recipe and no NO_RECIPE reason is a
  // model the app will offer and then refuse, with nothing to read.
  for (const f of FAMILIES) {
    const covered = !!RECIPES[f.id] || !!NO_RECIPE[f.id];
    assert.ok(covered, `${f.id} can be downloaded but has neither a recipe nor a stated reason`);
  }
});

test("the 4-step adapter brings H3's sigma shift with it, and both consumers see it", () => {
  // THE RECIPE IS THE PAIR, not the step count. Every passing cell of the
  // 2026-09-01 tier benchmark rendered at 4 steps WITH `MiniMaxH3SigmaShift`
  // at 12/3; shipping the step count alone would ship a recipe nobody
  // verified. The node patches the MODEL, and H3 takes its sigmas off
  // `BasicScheduler` — so the scheduler has to read the shifted model too, or
  // the shift is applied to the picture and not to the schedule.
  const lx = (fam("minimax-h3").addons ?? []).find((a) => a.id === "h3-lightx2v-4")!;
  const s = samplingFor(RECIPES["minimax-h3"], "h3-int8", [pickFromAddon(lx)]);
  assert.equal(s.steps, 4);
  assert.deepEqual(s.h3Shift, [12, 3]);

  const g = build("minimax-h3", "h3-int8", { sampling: s, loras: [pickFromAddon(lx)] });
  assert.deepEqual(validate(g), []);
  const shift = Object.entries(g).find(([, n]) => n.class_type === "MiniMaxH3SigmaShift");
  assert.ok(shift, "the adapter asked for a shift and the graph has none");
  const [shiftId, shiftNode] = shift!;
  assert.equal(shiftNode.inputs.shift_video, 12);
  assert.equal(shiftNode.inputs.shift_audio, 3);

  const guider = Object.values(g).find((n) => n.class_type === "BasicGuider")!;
  const sched = Object.values(g).find((n) => n.class_type === "BasicScheduler")!;
  assert.deepEqual(guider.inputs.model, [shiftId, 0]);
  assert.deepEqual(sched.inputs.model, [shiftId, 0], "the schedule must be shifted too");

  // …and it sits BELOW the adapter, or the shift is replaced by the LoRA.
  const lora = Object.entries(g).find(([, n]) => n.class_type === "LoraLoaderModelOnly");
  assert.ok(lora);
  assert.deepEqual(shiftNode.inputs.model, [lora![0], 0]);
});

test("without that adapter H3 stays exactly the workflow it was ported from", () => {
  // The pod's own `minimax_h3_t2v.json` has no shift node. A local render that
  // grew one unconditionally would quietly stop matching the graph this
  // builder's `portedFrom` claims it is.
  const g = build("minimax-h3", "h3-int8");
  assert.ok(!Object.values(g).some((n) => n.class_type === "MiniMaxH3SigmaShift"));
});

/* ── LTX 2.5 ─────────────────────────────────────────────────────────────── */
//
// The family whose ordinary render is two passes. Everything below is a way of
// getting that wrong that still produces a graph ComfyUI accepts — which is why
// each is pinned rather than left to the schema check above.

const ltx = (over: Partial<BuildInput> = {}) => build("ltx25", "ltx25-int8", over);
const byClass = (g: ApiGraph, c: string) =>
  Object.entries(g).filter(([, n]) => n.class_type === c);

test("LTX samples at HALF size and the upsampler brings it back", () => {
  // `latent_scale: 0.5` on the pod is this decision, and it is the whole reason
  // the recipe's `dimStep` is 64 rather than 32: pass 1's latent is half the
  // requested size, so only a multiple of 64 comes back to what was asked for
  // when `LTXVLatentUpsampler` doubles it. A builder that sampled at full size
  // would render fine and cost four times the pixels for the first pass.
  const g = ltx({ width: 1280, height: 704 });
  const [, latent] = byClass(g, "EmptyLTXVLatentVideo")[0]!;
  assert.equal(latent.inputs.width, 640);
  assert.equal(latent.inputs.height, 352);
  assert.equal(byClass(g, "LTXVLatentUpsampler").length, 1);
  assert.equal(RECIPES.ltx25!.dimStep, 64);
});

test("pass 2 continues pass 1 — its picture AND its sound", () => {
  // The audio is the half that is easy to lose: a second `LTXVEmptyLatentAudio`
  // for pass 2 would build a graph that samples and decodes perfectly and
  // throws the first pass's soundtrack away, which is silence nobody can trace.
  const g = ltx();
  assert.equal(byClass(g, "LTXVEmptyLatentAudio").length, 1,
    "the empty audio latent is created ONCE and rides both passes");
  const [sep1] = byClass(g, "LTXVSeparateAVLatent");
  const concat2 = byClass(g, "LTXVConcatAVLatent")[1]![1];
  assert.deepEqual(concat2.inputs.audio_latent, [sep1![0], 1],
    "pass 2's audio must be pass 1's, not a fresh empty latent");
  assert.equal(byClass(g, "SamplerCustomAdvanced").length, 2);
});

test("the two sigma schedules are the recipe, and steps cannot change them", () => {
  // `ManualSigmas` IS the distillation. A caller raising the step count gets
  // the same nine sigmas, which is correct and worth pinning: the alternative
  // reading — that `steps` shortens or lengthens the trajectory — would be a
  // control that silently renders something the model was never distilled for.
  const a = ltx();
  const b = ltx({ sampling: { ...samplingFor(RECIPES.ltx25!, "ltx25-int8"), steps: 40 } });
  const sig = (g: ApiGraph) => byClass(g, "ManualSigmas").map(([, n]) => n.inputs.sigmas);
  assert.deepEqual(sig(a), sig(b));
  assert.equal(sig(a).length, 2, "one schedule per pass");
  assert.ok(String(sig(a)[0]).startsWith("1.0,"), "pass 1 starts from full noise");
  assert.ok(String(sig(a)[1]).startsWith("0.85,"), "pass 2 is a low-sigma refine");
});

test("t2v pins nothing; i2v pins the first frame into BOTH passes", () => {
  // A guide applied to pass 1 only is a frame the refine pass is free to move
  // off — the render still opens on something plausible, so the failure is a
  // start frame that is nearly right rather than an error.
  assert.equal(byClass(ltx(), "LTXVAddGuide").length, 0);
  const g = ltx({ startImage: "start.png" });
  const guides = byClass(g, "LTXVAddGuide");
  assert.equal(guides.length, 2, "one per pass");
  for (const [, n] of guides) assert.equal(n.inputs.frame_idx, 0);
  assert.equal(byClass(g, "LoadImage").length, 1, "one picture, loaded once");
});

test("flf pins at BOTH ends, and the index is what says which", () => {
  // `LTXVAddGuide` calls its picture `image` at either end and distinguishes
  // them by `frame_idx` alone, so a builder that lost the -1 would produce a
  // graph that validates and renders the start frame twice.
  const g = ltx({ startImage: "a.png", endImage: "b.png" });
  const guides = byClass(g, "LTXVAddGuide");
  // Asserted as STRUCTURE, not as graph order: the ids are allocated per pass
  // from two ranges, so `Object.entries` interleaves them and an order-based
  // assertion would pin the allocator rather than the wiring.
  const idx = guides.map(([, n]) => n.inputs.frame_idx).sort();
  assert.deepEqual(idx, [-1, -1, 0, 0], "both ends, both passes");
  // …and the pair in each pass is CHAINED — the second guide must add to the
  // latent the first produced, or one of the two ends is silently dropped.
  const firsts = new Set(guides.filter(([, n]) => n.inputs.frame_idx === 0).map(([k]) => k));
  for (const [, n] of guides.filter(([, x]) => x.inputs.frame_idx === -1)) {
    assert.ok(firsts.has((n.inputs.latent as [string, number])[0]),
      "the end guide must build on the start guide's latent");
  }
  assert.equal(byClass(g, "LoadImage").length, 2);
});

test("every guided pass crops its guides before anything reads the latent", () => {
  // A guide is PREPENDED to the latent. Left in, pass 1's guides are upsampled
  // and pass 2 pins its own on top of them, and the decode emits frames nobody
  // asked for — a clip that is right except for extra stills at the front.
  const g = ltx({ startImage: "start.png" });
  const crops = byClass(g, "LTXVCropGuides");
  assert.equal(crops.length, 2, "one per pass");
  const [, ups] = byClass(g, "LTXVLatentUpsampler")[0]!;
  assert.equal((ups.inputs.samples as [string, number])[0], crops[0]![0],
    "the upsampler reads the CROPPED latent, not the raw separate");
  const [, dec] = byClass(g, "VAEDecode")[0]!;
  assert.equal((dec.inputs.samples as [string, number])[0], crops[1]![0]);
});

test("the audio decode reads the SEPARATE, never the crop", () => {
  // `LTXVCropGuides` is a video-latent concept and has no audio to give back;
  // wiring the audio decode to it is a graph that fails at execution, after the
  // GPU time is spent.
  const g = ltx({ startImage: "start.png" });
  const seps = byClass(g, "LTXVSeparateAVLatent");
  const [, audio] = byClass(g, "LTXVAudioVAEDecode")[0]!;
  assert.deepEqual(audio.inputs.samples, [seps[1]![0], 1]);
});

test("LTX references fill four SUBJECT slots and then the BACKGROUND", () => {
  // The MSR slots carry LEARNED embeddings, so a fifth picture is the location
  // rather than a fifth subject — putting a plate in `pic5` is not merely
  // wrong, there is no such input. Same split `blocks._wire_msr_refs` makes.
  const g = ltx({ refImages: ["a.png", "b.png", "c.png", "d.png", "e.png"] });
  const guides = byClass(g, "ComfyUILTX25MSRMultiReferenceGuide");
  assert.equal(guides.length, 2, "the references are re-pinned for pass 2");
  const [, first] = guides[0]!;
  for (const k of ["pic1", "pic2", "pic3", "pic4", "background"]) {
    assert.ok(first.inputs[k], `${k} should be staged`);
  }
  assert.ok(!("pic5" in first.inputs), "there is no fifth subject slot");
  // 25 or 33 ONLY, and it is PER reference — the guide raises on anything else.
  assert.equal(first.inputs.reference_frames, "33");
  // The IC-LoRA carries the slot embeddings the guide addresses through.
  assert.equal(byClass(g, "ComfyUILTX25MSRICLoRALoader").length, 1);
});

test("the MSR IC-LoRA patches the model BOTH guiders read", () => {
  // A guide whose embeddings are not on the model conditions on nothing and
  // renders a clip that ignores every reference — the silent downgrade the
  // whole reference path exists to avoid.
  const g = ltx({ refImages: ["a.png"] });
  const [lid] = byClass(g, "ComfyUILTX25MSRICLoRALoader")[0]!;
  for (const [, guider] of byClass(g, "LTXVDualCFGGuider")) {
    assert.deepEqual(guider.inputs.model, [lid, 0]);
  }
});

test("r2v is withheld rather than rendered wrong when its pack is absent", () => {
  // Two halves and both are needed: `localModels` must not OFFER the mode, and
  // the builder must not silently render a text-to-video if something reaches
  // it anyway. `modePacks` is the first; this is the second.
  assert.equal(RECIPES.ltx25!.modePacks?.r2v, "ComfyUI-LTX2.5-MSR");
  const f = fam("ltx25");
  const stripped: ModelFamily = {
    ...f, shared: f.shared.filter((x) => !x.filename.includes("MSR")),
  };
  assert.throws(() => RECIPES.ltx25!.build({
    family: stripped, variant: f.variants[0]!,
    prompt: "x", negative: "", width: 640, height: 352, seed: 1,
    sampling: samplingFor(RECIPES.ltx25!, f.variants[0]!.id),
    frames: 33, loras: [], prefix: "t", refImages: ["a.png"],
  }), /MSR IC-LoRA/);
});

test("the adapters ride below the transformer and above the MSR patch", () => {
  // Order is the whole point: a LoRA spliced ABOVE the IC-LoRA would be
  // patched over by it, and one spliced below the guider would not be read at
  // all. Both render; neither renders what was picked.
  const g = ltx({
    refImages: ["a.png"],
    loras: [{ files: ["style.safetensors"], strength: 0.7 }],
  });
  const [lora] = byClass(g, "LoraLoaderModelOnly")[0]!;
  const [, msr] = byClass(g, "ComfyUILTX25MSRICLoRALoader")[0]!;
  assert.deepEqual(msr.inputs.model, [lora, 0]);
});

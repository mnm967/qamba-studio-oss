// The compatibility check tells someone their machine cannot run something.
// Every failure mode here is a CONFIDENT wrong answer, which is worse than no
// answer at all — so the rules that keep it honest are the ones under test:
// max() rather than sum() for VRAM, null rather than a guess for an unreadable
// filename, and "not checked" rather than "fine" when nothing was compared.
import assert from "node:assert/strict";
import test from "node:test";

import { analyseGraph, packFor, sizeFromFilename, type CompatEnv } from "./compat.ts";
import type { ApiGraph } from "./workflowAdapter.ts";

const mac = (vramMb: number) => ({
  os: "Darwin", arch: "aarch64", cpu: "Apple M3", cores: 8,
  ram_mb: vramMb, free_disk_mb: 100_000, comfy_paths: [],
  gpus: [{ name: "Apple M3", vendor: "apple" as const, vram_mb: vramMb, unified: true }],
});
const nvidia = (vramMb: number) => ({
  os: "Windows 11", arch: "x86_64", cpu: "i7", cores: 16,
  ram_mb: 65_536, free_disk_mb: 900_000, comfy_paths: [],
  gpus: [{ name: "RTX 4090", vendor: "nvidia" as const, vram_mb: vramMb, unified: false }],
});

/** Wan 2.2's real shape: a big diffusion model plus a big text encoder. */
const WAN: ApiGraph = {
  "1": { class_type: "UNETLoader",
         inputs: { unet_name: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "4": { class_type: "EmptyHunyuanLatentVideo",
         inputs: { width: 1280, height: 720, length: 121, batch_size: 1 } },
  "5": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["2", 0] } },
  "6": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
};

/** An engine's class list. Padded to a BELIEVABLE size on purpose: a real
 *  ComfyUI reports ~851 classes, and `analyseGraph` refuses to trust a list
 *  short enough to be a truncated response — a fixture of three would
 *  otherwise be testing the "do not trust this" path while looking like it
 *  tested the real one. */
const engine = (...classes: string[]) => new Set([
  ...classes,
  ...Array.from({ length: 60 }, (_, i) => `CoreNode${i}`),
]);
const allOf = (g: ApiGraph) => engine(...Object.values(g).map((n) => n.class_type));

/* ── sizing ─────────────────────────────────────────────────────────────── */

test("a filename that carries params AND precision is read, not guessed", () => {
  // 14e9 x 1 byte. The real file is 14.9GB, so this is within ~6%.
  const mb = sizeFromFilename("wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors")!;
  assert.ok(mb > 13_000 && mb < 15_000, `${mb}MB`);
  // 5e9 x 2 bytes against a real 9.5GB.
  const fp16 = sizeFromFilename("Wan2.2-TI2V-5B_fp16.safetensors")!;
  assert.ok(fp16 > 9_000 && fp16 < 11_000, `${fp16}MB`);
  // GGUF is bits-per-weight: 5e9 x 4.8/8 against a real 3.2GB.
  const q4 = sizeFromFilename("Wan2.2-TI2V-5B-Q4_K_M.gguf")!;
  assert.ok(q4 > 2_700 && q4 < 3_500, `${q4}MB`);
});

test("a filename missing either fact returns null rather than a number", () => {
  // No precision token — this file is int8 CONVROT, a layout the name states
  // and the arithmetic cannot use.
  assert.equal(sizeFromFilename("minimax_h3_fl2va_pruned_convrot.safetensors"), null);
  // No parameter count at all — "xxl" is a size class, not a number, and
  // inventing one for it is how a table like this starts lying.
  assert.equal(sizeFromFilename("umt5_xxl_fp16.safetensors"), null);
  assert.equal(sizeFromFilename("ae.safetensors"), null);
  // A version number is not a parameter count, and neither is a step count.
  assert.equal(sizeFromFilename("qwen_image_edit_2509.safetensors"), null);
  assert.equal(sizeFromFilename("lightx2v_4step_lora.safetensors"), null);
});

test("the studio's own catalog is used before the filename guess", () => {
  // umt5 has no readable size in its name, but it is a file this app ships,
  // so the answer is the measured one rather than nothing.
  const r = analyseGraph(WAN, { files: new Set(), classes: allOf(WAN) });
  const umt5 = r.weights.find((w) => w.name.startsWith("umt5"))!;
  assert.equal(umt5.from, "catalog");
  assert.ok(umt5.mb! > 4_000, `${umt5.mb}MB`);
});

test("a file on disk is measured, never estimated", () => {
  const env: CompatEnv = {
    classes: allOf(WAN),
    files: new Set(["wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"]),
    fileMb: { "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors": 14_900 },
  };
  const w = analyseGraph(WAN, env).weights.find((x) => x.name.startsWith("wan2.2"))!;
  assert.equal(w.from, "disk");
  assert.equal(w.mb, 14_900);
  assert.equal(w.installed, true);
});

/* ── the VRAM model ─────────────────────────────────────────────────────── */

test("VRAM is the LARGEST weight, not the sum — a 4090 runs Wan 2.2 14B", () => {
  // ComfyUI loads the text encoder, encodes, frees it, then loads the
  // diffusion model. Summing 14.9GB + 11.4GB would tell a 4090 owner that
  // their own working setup is impossible.
  const env: CompatEnv = {
    classes: allOf(WAN), hardware: nvidia(24_564),
    files: new Set(Object.values(WAN).flatMap((n) =>
      Object.values(n.inputs).filter((v): v is string =>
        typeof v === "string" && v.endsWith(".safetensors")))),
    fileMb: { "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors": 14_900,
              "umt5_xxl_fp8_e4m3fn_scaled.safetensors": 6_400, "wan_2.1_vae.safetensors": 254 },
  };
  const r = analyseGraph(WAN, env);
  assert.equal(r.vram!.peakMb, 14_900);
  assert.equal(r.verdict, "ready");
});

test("unified memory is discounted, so a 16GB Mac is told the truth", () => {
  const env: CompatEnv = {
    classes: allOf(WAN), hardware: mac(16_384),
    files: new Set(["wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
                    "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "wan_2.1_vae.safetensors"]),
    fileMb: { "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors": 14_900,
              "umt5_xxl_fp8_e4m3fn_scaled.safetensors": 6_400, "wan_2.1_vae.safetensors": 254 },
  };
  const r = analyseGraph(WAN, env);
  assert.equal(r.vram!.budgetMb, Math.round(16_384 * 0.6));   // the OS needs its share
  assert.equal(r.verdict, "wont_fit");
  assert.match(r.headline, /swap rather than render/);
});

test("just over budget is 'tight', not 'impossible'", () => {
  const env: CompatEnv = {
    classes: allOf(WAN), hardware: nvidia(12_282),
    files: new Set(["m.safetensors"]),
    fileMb: { "m.safetensors": 13_000 },
  };
  const g: ApiGraph = { "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } } };
  const r = analyseGraph(g, { ...env, classes: engine("UNETLoader") });
  assert.equal(r.verdict, "tight");
});

/* ── what is missing ────────────────────────────────────────────────────── */

test("a missing node pack outranks a missing download", () => {
  // Both are wrong, but one is a search-the-internet problem and the other is
  // a press-a-button problem. Report the harder wall first.
  const g: ApiGraph = {
    ...WAN,
    "9": { class_type: "MiniMaxH3MotionContext", inputs: {} },
  };
  const r = analyseGraph(g, { classes: allOf(WAN), files: new Set() });
  assert.equal(r.verdict, "nodes");
  assert.equal(r.nodes.missing.length, 1);
  assert.equal(r.nodes.missing[0].pack, "ComfyUI-H3-Motion-Context-MultiRef");
});

test("an unknown class is reported without a pack, never with a guessed one", () => {
  const g: ApiGraph = { "1": { class_type: "SomeoneElsesMysteryNode", inputs: {} } };
  const r = analyseGraph(g, { classes: engine("SaveImage") });
  assert.equal(r.nodes.missing[0].class_type, "SomeoneElsesMysteryNode");
  assert.equal(r.nodes.missing[0].pack, undefined);
  assert.equal(packFor("SomeoneElsesMysteryNode"), undefined);
});

test("one file named by several nodes is one download", () => {
  const g: ApiGraph = {
    "1": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "x_14B_fp8.safetensors" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "x_14B_fp8.safetensors" } },
  };
  const r = analyseGraph(g, { classes: engine("LoraLoaderModelOnly"), files: new Set() });
  assert.equal(r.weights.length, 1);
});

test("an unsized download makes the total null, not a smaller number", () => {
  // Reporting "about 3GB to fetch" when one of the three files could not be
  // sized is the confident-wrong-answer failure this module exists to avoid.
  const g: ApiGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "a_14B_fp8.safetensors" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "mystery_encoder.safetensors" } },
  };
  const r = analyseGraph(g, { classes: engine("UNETLoader", "CLIPLoader"), files: new Set() });
  assert.equal(r.downloadMb, null);
  assert.equal(r.downloadUnsized, 1);
  assert.match(r.headline, /unknown size/);
});

test("nothing to compare against reports 'not checked', never 'fine'", () => {
  const r = analyseGraph(WAN, {});
  assert.equal(r.verdict, "unknown");
  assert.equal(r.nodes.missing.length, 0);   // absent != verified absent
  assert.equal(r.vram, null);
  assert.match(r.headline, /Nothing checked/);
});

test("the graph's declared render size is read out of the graph", () => {
  // It is advisory — activations are not in the peak — so it has to be the
  // real number, not the slot's input NAME, which is what it was first.
  const r = analyseGraph(WAN, { classes: allOf(WAN) }, {
    size: { node: "4", class_type: "EmptyHunyuanLatentVideo",
            width: "width", height: "height", length: "length" },
    output: [],
  });
  assert.deepEqual(r.frame, { width: 1280, height: 720, length: 121 });
});

/* ── a verdict is only as good as what was compared ─────────────────────── */

test("weights present but nodes UNCHECKED is not 'runs here'", () => {
  // The first version of this returned "ready" for a graph naming three packs
  // the installer does not clone, purely because nobody had looked at the node
  // list. A green tick earned by not checking is worse than no tick.
  const g: ApiGraph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } },
    "2": { class_type: "SeedVR2", inputs: {} },
    "3": { class_type: "SomeoneElsesMysteryNode", inputs: {} },
  };
  const r = analyseGraph(g, { files: new Set(["sd15.safetensors"]), fileMb: { "sd15.safetensors": 4_060 } });
  assert.equal(r.verdict, "unknown");
  assert.match(r.headline, /nothing checked its NODE list/i);
});

test("nodes checked but no file list is also only half an answer", () => {
  const g: ApiGraph = { "1": { class_type: "SaveImage", inputs: {} } };
  const r = analyseGraph(g, { classes: engine("SaveImage") });
  assert.equal(r.verdict, "unknown");
  assert.match(r.headline, /nothing checked the weight files/i);
});

test("a download that would not fit anyway says so in the same breath", () => {
  // Finding that out after a 13GB fetch is the worst possible moment.
  const g: ApiGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "big_14B_fp8.safetensors" } },
  };
  const r = analyseGraph(g, {
    classes: engine("UNETLoader"), files: new Set(), hardware: mac(16_384),
  });
  assert.equal(r.verdict, "downloads");
  assert.match(r.headline, /would not fit once fetched/);
});

test("a truncated /object_info is not believed", () => {
  // A real engine reports hundreds of classes. Three means the response was
  // cut off or the caller passed a stub, and the output of trusting it is the
  // most discrediting thing this panel can say: "CLIPTextEncode is not
  // installed". Caught by the harness, where the mock engine declared 3.
  const g: ApiGraph = {
    "1": { class_type: "CLIPTextEncode", inputs: {} },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  };
  const stub = analyseGraph(g, { classes: new Set(["SaveImage"]), files: new Set() });
  assert.equal(stub.nodes.missing.length, 0);
  assert.equal(stub.verdict, "unknown");
  // …and a believable one is believed.
  const real = analyseGraph(g, { classes: engine("SaveImage"), files: new Set() });
  assert.deepEqual(real.nodes.missing.map((m) => m.class_type), ["CLIPTextEncode"]);
});

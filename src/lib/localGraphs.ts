// Render recipes for the models the desktop engine can actually be given —
// the TypeScript twin of `worker/graphs.py`, scoped to `engineCatalog`.
//
// WHY THIS IS NOT `resolve.py`. The pod parameterises a template by matching
// `class_type`, which is only safe on templates we wrote. It is also Python on
// a box the desktop app cannot reach. A local render is built here, in the
// browser, from the same catalogue the download screen offers — so the model
// you downloaded and the graph that renders it come from one list and cannot
// drift into naming a file that was never fetched.
//
// A FAMILY WITHOUT A RECIPE IS SAID TO HAVE NO RECIPE. Guessing at one would
// produce a picker row that queues a job that dies several minutes in, naming
// a node the user never chose — so an unported family is absent from RECIPES,
// `localRecipe()` returns null, and `NO_RECIPE` carries the reason, which
// every surface reports as "no local recipe yet" rather than as a broken
// model. `ltx25` is the one left: its two-pass distilled schedule is not
// ported and its weights are gated upstream anyway. (This paragraph used to
// name `krea2` and `minimax-h3` as the examples; both have been ported since,
// and each builder's own comment records what it took.)
//
// EVERY GRAPH HERE IS PORTED, NOT INVENTED. Wan comes from this repo's own
// `workflows/wan22_*.json` (the same graphs the pod renders on), with two
// deliberate substitutions: the GGUF loader in place of `UNETLoader`, and the
// 5B's own 48-channel `wan2.2_vae` in place of the 2.1 VAE its catalogue row
// used to name. SD 1.5 / SDXL are the stock ComfyUI default graph, which this
// repo has no template for because the pod does not render them.
import type { ApiGraph, ApiNode } from "./workflowAdapter.ts";
import {
  FAMILIES, variantFiles,
  type EngineFile, type FamilyAddon, type ModelFamily, type ModelVariant,
} from "./engineCatalog.ts";

/** How a graph is sampled. Everything a distillation is allowed to rewrite. */
export interface Sampling {
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** flow-matching shift (`ModelSamplingSD3`), video families only */
  shift?: number;
  /**
   * MiniMax H3's own sigma shift, `[video, audio]` — a DIFFERENT node from
   * `shift` above (`MiniMaxH3SigmaShift`, core ComfyUI, and it takes two
   * values because H3 decodes picture and sound from one latent).
   *
   * It belongs to the 4-step distillation rather than to H3, which is why it
   * is set by the adapter and not by the recipe: the pod's own 20-step
   * templates carry no shift node, and applying one unconditionally would make
   * a local render diverge from the workflow this builder is a port of. The
   * 2026-09-01 tier benchmark measured every passing cell with the adapter AND
   * this shift on, so shipping the adapter's step count without it would ship
   * a recipe nobody verified.
   */
  h3Shift?: [number, number];
}

export interface LocalSize {
  id: string;
  label: string;
  dims: Record<string, [number, number]>;
  maxFrames?: number;
}

export interface LocalRecipe {
  /** `engineCatalog` family id */
  family: string;
  kind: "image" | "video" | "audio";
  /** the GenComposer modes this family can drive */
  modes: string[];
  /**
   * Modes that need a CUSTOM NODE PACK, by the directory `engine_status.nodes`
   * reports — withheld until it is installed rather than offered and failed.
   *
   * A SECOND REASON A MODE CAN BE ABSENT, and it is not the same as H3's. There
   * the reference mode needs a second CHECKPOINT and `localModels` checks the
   * file; here LTX 2.5's `r2v` needs liconstudio's MSR nodes, which are a
   * clone rather than a download — so a machine can hold every LTX weight and
   * still not have them. Both failures are the same from outside (a job that
   * queues, is claimed, and dies inside ComfyUI on a class it cannot find),
   * which is why neither is left to be discovered at render time.
   *
   * A pack name, never a class name: the status probe lists `custom_nodes/*`
   * directories, so a class name could never match and the gate would pass by
   * accident — the same trap `FamilyAddon.needsPack` documents.
   */
  modePacks?: Record<string, string>;
  sampling: Sampling;
  /** width/height must be a multiple of this */
  dimStep: number;
  sizes: LocalSize[];
  /** video: frames must be `frameBase * n + frameRem` */
  fps?: number;
  frameBase?: number;
  frameRem?: number;
  maxSeconds?: number;
  /** The default negative prompt — and ABSENT where the family samples no
   *  negative branch at all. Krea 2 turbo runs at cfg 1.0 into a
   *  `ConditioningZeroOut`, so a negative field there is a control that
   *  provably cannot change the picture: the same rule GenComposer's own
   *  gating follows, reaching the local rows through
   *  `localModels.localModelRows`. */
  negative?: string;
  /** per-variant sampling overrides — SDXL Turbo is 4 steps where Base is 30 */
  perVariant?: Record<string, Partial<Sampling>>;
  /**
   * WHAT THIS GRAPH WAS PORTED FROM — a `workflows/*.json` template or a
   * `worker/graphs.py` builder, transcribed from each builder's own doc
   * comment rather than invented.
   *
   * It is data rather than prose because a reader asking "which workflow does
   * my Wan render on?" is asking exactly this, and the honest answer is on
   * the other side of a file they have no reason to open: the desktop's Wan
   * renders through THIS module, and `wan22_5b_t2v.json` — which no model_map
   * names, so every tier calls it unused — is where it came from. The
   * Workflows page shows it on both sides. `localGraphs.test.ts` checks every
   * entry still resolves, so it cannot rot into a claim about a file that has
   * been renamed.
   */
  portedFrom?: string[];
  build: (b: BuildInput) => ApiGraph;
}

/**
 * One LoRA in a render: the files to load, in order, and how hard.
 *
 * `files` is a list because an adapter can genuinely be several files that
 * only work together — the pod's `duotone` is a stills half and a motion half,
 * and taking one is the failure the pairing exists to prevent.
 */
export interface LoraPick {
  files: string[];
  strength: number;
  /** what this adapter rewrites about the recipe, if anything. Only a
   *  distillation sets it; a style or concept LoRA changes nothing. */
  sampling?: Partial<Sampling>;
}

/** The pick an `engineCatalog` add-on produces. */
export const pickFromAddon = (addon: FamilyAddon, strength = 1): LoraPick => ({
  files: addon.files.filter((f) => f.dir === "loras").map((f) => f.filename),
  strength,
  ...(addon.sampling ? { sampling: addon.sampling } : {}),
});

export interface BuildInput {
  family: ModelFamily;
  variant: ModelVariant;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  sampling: Sampling;
  /** video only */
  frames?: number;
  /** a file already uploaded to the engine's input dir, for i2v */
  startImage?: string;
  /**
   * The frame the render must ARRIVE at — `flf`, first-and-last.
   *
   * Separate from `startImage` for the reason the pod keeps `start_asset_id`
   * and `end_asset_id` separate: they are pinned at opposite ends of the same
   * latent, and a builder handed one field could not tell which end was meant.
   * Only LTX 2.5 reads it today (core's `LTXVAddGuide` takes a `frame_idx`, so
   * -1 is the whole implementation); H3's own flf mode lives on the pod.
   */
  endImage?: string;
  /** audio only: how long the render should be, in seconds. Distinct from a
   *  video's `frames` because these models take SECONDS directly and one of
   *  them treats the number as a CEILING it may finish under. */
  seconds?: number;
  /** audio only: the words to sing, and whether to sing at all. An empty
   *  `lyrics` is an ABSENCE, not an instruction — both models sing whatever
   *  the caption implies, so "instrumental" has to be said in the caption. */
  lyrics?: string;
  /** post only: a VIDEO already on the engine's disk, the pass's input. */
  sourceVideo?: string;
  /** post only: how much bigger, or how many times the frame rate. */
  factor?: number;
  /** reference images already on the engine's disk, in pick order.
   *
   *  Separate from `startImage` because they mean different things: a start
   *  frame is the first frame of the render, a reference is something to
   *  compose FROM. The pod keeps the same split (`start_asset_id` vs
   *  `ref_asset_ids`) and so does the composer. */
  refImages?: string[];
  /** LoRAs the user picked, in pick order, already RESOLVED TO FILENAMES.
   *
   *  Resolved rather than carrying the `FamilyAddon` it may have come from,
   *  because it may not have come from one: a LoRA downloaded through the
   *  Civitai hub is a file in `models/loras/` with a `localLoras` record and no
   *  catalogue entry at all. Both sources produce this, so nothing downstream
   *  has to know which it was — which is what stopped a hub LoRA being dropped
   *  by an `addonById` lookup that could never find it. */
  loras: LoraPick[];
  /** `filename_prefix` — where the engine writes, before we fetch it back */
  prefix: string;
  /** Every model file on the engine's disk, when the caller asked.
   *
   *  Only a builder that has a genuine EITHER/OR uses it — today that is Krea
   *  2 choosing between the stock text encoder and the abliterated one beside
   *  it. It is optional because `graphForJob` is documented as testable
   *  without an engine, and absent means "take the default", never "nothing is
   *  installed". */
  have?: Set<string>;
}

/* ── small helpers ──────────────────────────────────────────────────────── */

const filesIn = (files: EngineFile[], dir: EngineFile["dir"]) =>
  files.filter((f) => f.dir === dir).map((f) => f.filename);

/** The diffusion weights of a variant, in declaration order. The 14B pair is
 *  two entries and the order is load-bearing: high noise first. */
const unets = (v: ModelVariant) => filesIn(v.files, "diffusion_models");
const one = (files: EngineFile[], dir: EngineFile["dir"]) => filesIn(files, dir)[0];

/**
 * The model loader for a variant.
 *
 * A GGUF is not loadable by `UNETLoader` — it lands in the same directory and
 * the stock loader simply will not list it, which reads as "the download did
 * not work". `UnetLoaderGGUF` (city96/ComfyUI-GGUF) takes the same input name
 * and no `weight_dtype`, so this is the only difference between the two paths.
 */
const modelLoader = (v: ModelVariant, name: string): ApiNode =>
  // KEYED ON THE FILE, like `clipLoader` below, and no longer on
  // `v.precision`. The two agree for every rung here — a GGUF variant's
  // checkpoint and its reference checkpoint are both `.gguf` — but the rule
  // that survives is the one about the file being loaded, not about the label
  // on the row it came from. H3's r2v path is the case that made the
  // difference expressible: it loads a DIFFERENT file from the variant's own.
  name.endsWith(".gguf")
    ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: name } }
    : { class_type: "UNETLoader", inputs: { unet_name: name, weight_dtype: "default" } };

/**
 * The CLIP loader for a text encoder, picked by the FILE rather than by the
 * variant's precision.
 *
 * A `.gguf` encoder needs city96's `CLIPLoaderGGUF` — the stock `CLIPLoader`
 * lists only what `folder_paths` calls a text encoder and would simply not
 * offer the file, which reads as "the download did nothing". They also differ
 * in signature: the GGUF one has no `device` input, and sending one is a
 * validation error at submit.
 */
const clipLoader = (filename: string, type: string): ApiNode =>
  filename.endsWith(".gguf")
    ? { class_type: "CLIPLoaderGGUF", inputs: { clip_name: filename, type } }
    : { class_type: "CLIPLoader", inputs: { clip_name: filename, type, device: "default" } };

/**
 * Splice the picked adapters onto a MODEL output, in pick order.
 *
 * Returns the id of the last node in the chain, so the caller wires whatever
 * consumed the loader to this instead. One `LoraLoaderModelOnly` per file —
 * same convention as `resolve.lora_stack` on the pod.
 */
function spliceLoras(
  g: ApiGraph, from: string, loras: BuildInput["loras"], startId: number,
): { last: string; nextId: number } {
  let last = from;
  let id = startId;
  for (const { files, strength } of loras) {
    for (const filename of files) {
      const key = String(id++);
      g[key] = {
        class_type: "LoraLoaderModelOnly",
        inputs: { model: [last, 0], lora_name: filename, strength_model: strength },
      };
      last = key;
    }
  }
  return { last, nextId: id };
}

/**
 * LTX 2.5's two schedules, VERBATIM from `workflows/ltx25_t2v.json`.
 *
 * These are the distillation, not a schedule with a length — which is why the
 * recipe's `steps` is inert for this family and raising it changes nothing.
 * They are strings because `ManualSigmas` takes one; a comma-separated list is
 * the node's own format and reformatting it (dropping a trailing zero, say) is
 * a different trajectory.
 */
const LTX25_SIGMAS_1 =
  "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
const LTX25_SIGMAS_2 = "0.85, 0.7250, 0.4219, 0.0";

/* ── builders ───────────────────────────────────────────────────────────── */

/**
 * SD 1.5 / SDXL — one checkpoint carrying its own CLIP and VAE.
 *
 * The stock ComfyUI default graph. This repo has no template to port because
 * the pod renders neither, but it is the most-reproduced graph in existence
 * and every node in it is core.
 */
function buildCheckpointImage(b: BuildInput): ApiGraph {
  const ckpt = one(b.variant.files, "checkpoints")
    ?? one(variantFiles(b.family, b.variant), "checkpoints");
  const g: ApiGraph = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    4: { class_type: "CLIPTextEncode", inputs: { text: b.prompt, clip: ["1", 1] } },
    5: { class_type: "CLIPTextEncode", inputs: { text: b.negative, clip: ["1", 1] } },
    7: {
      class_type: "EmptyLatentImage",
      inputs: { width: b.width, height: b.height, batch_size: 1 },
    },
  };
  const { last } = spliceLoras(g, "1", b.loras, 20);
  g["8"] = {
    class_type: "KSampler",
    inputs: {
      model: [last, 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["4", 0], negative: ["5", 0], latent_image: ["7", 0], denoise: 1.0,
    },
  };
  g["9"] = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["1", 2] } };
  g["10"] = { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: b.prefix } };
  return g;
}

/**
 * The shared front of every Wan graph: weights, text encoder, VAE, both
 * prompts, and the flow-matching shift. Returns the graph plus the node ids
 * the family-specific tail needs to wire to.
 */
function wanHead(b: BuildInput, unetName: string, nodeId: string, samplerId: string) {
  const shared = variantFiles(b.family, b.variant);
  const g: ApiGraph = {
    [nodeId]: modelLoader(b.variant, unetName),
    // `type: "wan"` selects umt5's Wan tokenizer/projection. It is a combo
    // value, so a typo is a validation error rather than a silent wrong
    // encoding — which is the good outcome.
    2: {
      class_type: "CLIPLoader",
      inputs: { clip_name: one(shared, "text_encoders"), type: "wan", device: "default" },
    },
    3: { class_type: "VAELoader", inputs: { vae_name: one(shared, "vae") } },
    4: { class_type: "CLIPTextEncode", inputs: { text: b.prompt, clip: ["2", 0] } },
    5: { class_type: "CLIPTextEncode", inputs: { text: b.negative, clip: ["2", 0] } },
  };
  g[samplerId] = {
    class_type: "ModelSamplingSD3",
    inputs: { model: [nodeId, 0], shift: b.sampling.shift ?? 8.0 },
  };
  return g;
}

/** Everything after the sampler: decode, mux, write. Shared by every video
 *  family, because ComfyUI's video output path is the same for all of them. */
function videoTail(g: ApiGraph, b: BuildInput, latentFrom: string, fps: number) {
  g["12"] = { class_type: "VAEDecode", inputs: { samples: [latentFrom, 0], vae: ["3", 0] } };
  g["13"] = { class_type: "CreateVideo", inputs: { images: ["12", 0], fps } };
  g["14"] = {
    class_type: "SaveVideo",
    inputs: { video: ["13", 0], filename_prefix: b.prefix, format: "auto", codec: "auto" },
  };
}

/**
 * Wan 2.2 TI2V 5B — one model, text OR image to video.
 *
 * Ported from `workflows/wan22_5b_t2v.json` / `wan22_5b_i2v.json`. The 5B is
 * the only Wan whose latent is 48-channel, which is why it has its own VAE and
 * its own latent node (`Wan22ImageToVideoLatent`, which does both t2v and i2v
 * — the start image is an optional input, not a different graph).
 */
function buildWan5b(b: BuildInput): ApiGraph {
  const g = wanHead(b, unets(b.variant)[0], "1", "6");
  const { last } = spliceLoras(g, "6", b.loras, 20);
  const latent: Record<string, unknown> = {
    vae: ["3", 0], width: b.width, height: b.height,
    length: b.frames ?? 49, batch_size: 1,
  };
  if (b.startImage) {
    g["15"] = { class_type: "LoadImage", inputs: { image: b.startImage } };
    latent.start_image = ["15", 0];
  }
  g["7"] = { class_type: "Wan22ImageToVideoLatent", inputs: latent };
  g["8"] = {
    class_type: "KSampler",
    inputs: {
      model: [last, 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["4", 0], negative: ["5", 0], latent_image: ["7", 0], denoise: 1.0,
    },
  };
  videoTail(g, b, "8", 24);
  return g;
}

/** Wan 2.1 1.3B — text to video only, 16-channel latent, 16fps. */
function buildWan13b(b: BuildInput): ApiGraph {
  const g = wanHead(b, unets(b.variant)[0], "1", "6");
  const { last } = spliceLoras(g, "6", b.loras, 20);
  g["7"] = {
    class_type: "EmptyHunyuanLatentVideo",
    inputs: { width: b.width, height: b.height, length: b.frames ?? 33, batch_size: 1 },
  };
  g["8"] = {
    class_type: "KSampler",
    inputs: {
      model: [last, 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["4", 0], negative: ["5", 0], latent_image: ["7", 0], denoise: 1.0,
    },
  };
  videoTail(g, b, "8", 16);
  return g;
}

/**
 * Wan 2.2 I2V A14B — the high-noise/low-noise expert PAIR.
 *
 * Ported from `workflows/wan22_14b_i2v.json`. Two `KSamplerAdvanced` passes
 * over one latent: the first runs the first half of the schedule and hands on
 * its leftover noise, the second finishes it. Both must sample the same total
 * `steps` or the handover lands mid-schedule — the split point is `steps / 2`,
 * not a fixed 10, so a distillation that changes the step count still splits
 * in the right place.
 */
function buildWan14b(b: BuildInput): ApiGraph {
  const [high, low] = unets(b.variant);
  const g = wanHead(b, high, "1", "7");
  g["2b"] = modelLoader(b.variant, low ?? high);
  g["8"] = { class_type: "ModelSamplingSD3", inputs: { model: ["2b", 0], shift: b.sampling.shift ?? 5.0 } };
  const hi = spliceLoras(g, "7", b.loras, 20);
  const lo = spliceLoras(g, "8", b.loras, hi.nextId);

  const i2v: Record<string, unknown> = {
    positive: ["4", 0], negative: ["5", 0], vae: ["3", 0],
    width: b.width, height: b.height, length: b.frames ?? 81, batch_size: 1,
  };
  if (b.startImage) {
    g["15"] = { class_type: "LoadImage", inputs: { image: b.startImage } };
    i2v.start_image = ["15", 0];
  }
  g["9"] = { class_type: "WanImageToVideo", inputs: i2v };

  const half = Math.max(1, Math.round(b.sampling.steps / 2));
  const common = {
    steps: b.sampling.steps, cfg: b.sampling.cfg,
    sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
    positive: ["9", 0], negative: ["9", 1],
  };
  g["10"] = {
    class_type: "KSamplerAdvanced",
    inputs: {
      ...common, model: [hi.last, 0], add_noise: "enable", noise_seed: b.seed,
      latent_image: ["9", 2], start_at_step: 0, end_at_step: half,
      return_with_leftover_noise: "enable",
    },
  };
  g["11"] = {
    class_type: "KSamplerAdvanced",
    inputs: {
      ...common, model: [lo.last, 0], add_noise: "disable", noise_seed: b.seed,
      latent_image: ["10", 0], start_at_step: half, end_at_step: 10000,
      return_with_leftover_noise: "disable",
    },
  };
  videoTail(g, b, "11", 16);
  return g;
}

/* ── the table ──────────────────────────────────────────────────────────── */

/** Square-ish ladders for the image families. `dims` is keyed the way
 *  `model_catalog.sizes` is, so `resOptions` reads them unchanged. */
const imageSizes = (base: number[]): LocalSize[] =>
  base.map((n) => ({
    id: String(n),
    label: `${n}px`,
    dims: {
      "1:1": [n, n],
      "16:9": [Math.round((n * 4) / 3 / 8) * 8, Math.round((n * 3) / 4 / 8) * 8],
      "9:16": [Math.round((n * 3) / 4 / 8) * 8, Math.round((n * 4) / 3 / 8) * 8],
      "4:3": [Math.round((n * 1.15) / 8) * 8, Math.round((n * 0.87) / 8) * 8],
      "3:4": [Math.round((n * 0.87) / 8) * 8, Math.round((n * 1.15) / 8) * 8],
      "21:9": [Math.round((n * 1.6) / 8) * 8, Math.round((n * 0.69) / 8) * 8],
    },
  }));

/** Video ladders, /32 so no snapping is needed on any aspect. */
const videoSizes = (rows: [string, string, number, number][]): LocalSize[] =>
  rows.map(([id, label, w, h]) => ({
    id, label,
    dims: {
      "16:9": [w, h], "9:16": [h, w], "1:1": [h, h],
      "4:3": [Math.round((h * 4) / 3 / 32) * 32, h],
      "3:4": [h, Math.round((h * 4) / 3 / 32) * 32],
      "21:9": [w, Math.round((w * 9) / 21 / 32) * 32],
    },
  }));

const NEG_IMAGE = "blurry, low quality, watermark, text, deformed";
const NEG_VIDEO = "blurry, low quality, watermark, text, static, jpeg artifacts";

/**
 * Krea 2 Turbo — text to image.
 *
 * A PORT OF `worker/graphs.py::krea2_graph`, node for node, and the reason it
 * can exist at all is that that graph is entirely stock ComfyUI:
 * UNETLoader / CLIPLoader / VAELoader / CLIPTextEncode / ConditioningZeroOut /
 * EmptySD3LatentImage / KSampler / VAEDecode / SaveImage. `NO_RECIPE` used to
 * say this family "needs the Krea2EditRebalance node, which the local
 * installer does not add" — true of the REFERENCE path (`krea2_ref_graph`),
 * and never true of t2i, so the studio's own default image model sat in the
 * download list unrenderable for want of a graph nobody had written.
 *
 * THREE THINGS THAT ARE NOT THE OBVIOUS CHOICE, all of them the pod's:
 *   - `EmptySD3LatentImage`, not `EmptyLatentImage`. The latent channel count
 *     has to match the UNET, and getting it wrong fails at `VAEDecode`
 *     several minutes into a sample.
 *   - `CLIPLoader` at type "krea2", which is what routes ComfyUI to the 12-layer
 *     conditioning tap this model was trained against.
 *   - No second `CLIPTextEncode`. cfg is 1.0, so the negative branch is never
 *     evaluated; the reference workflow zeroes the positive encode instead,
 *     and mirroring that keeps the graph matching the recipe the checkpoint
 *     was tuned on.
 */
function buildKrea2(b: BuildInput): ApiGraph {
  const unet = unets(b.variant)[0];
  const all = variantFiles(b.family, b.variant);
  const vae = one(all, "vae");
  const te = filesIn(all, "text_encoders")[0];

  const g: ApiGraph = {
    1: modelLoader(b.variant, unet),
    2: { class_type: "CLIPLoader", inputs: { clip_name: te, type: "krea2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: b.prompt } },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    6: {
      class_type: "EmptySD3LatentImage",
      inputs: { width: b.width, height: b.height, batch_size: 1 },
    },
  };
  const { last } = spliceLoras(g, "1", b.loras, 20);
  g["7"] = {
    class_type: "KSampler",
    inputs: {
      model: [last, 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], denoise: 1.0,
    },
  };
  g["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  g["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: b.prefix } };
  return g;
}

/**
 * MiniMax H3 — the studio's own video model, on your own machine.
 *
 * A PORT OF `workflows/minimax_h3_t2v.json` and `…_i2v.json`, which differ by
 * one node: i2v adds a `LoadImage` and hands it to `first_frame`. `NO_RECIPE`
 * used to say "the local H3 path (dual VAE, audio, GGUF text encoder) is not
 * built yet", and the word doing the work there was BUILT — every class those
 * templates name is stock ComfyUI (checked against a live local engine's 857:
 * `MiniMaxH3ImageToVideo`, `VAEDecodeAudio`, `CreateVideo`, `SaveVideo` are
 * all core, and `CLIPLoaderGGUF` comes with the GGUF pack the installer
 * already adds). Nothing was missing but the graph.
 *
 * TWO VAEs, AND THEY ARE NOT INTERCHANGEABLE. H3 decodes one latent twice —
 * video through `minimax_h3_video_vae` and sound through
 * `minimax_h3_audio_vae` — and native audio is the whole reason an episode
 * renders on this model. Wiring both decodes to the video VAE loses the
 * soundtrack silently: the file plays, mute.
 *
 * NO NEGATIVE, NO CFG. Conditioning comes out of `MiniMaxH3ImageToVideo` and
 * goes into a `BasicGuider`, which has no uncond branch at all — so the recipe
 * declares no `negative`, and `localModelRows` therefore offers no field.
 */
function buildH3(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  // THE REFERENCE MODE IS DIFFERENT WEIGHTS, not just a different conditioning
  // node — and this builder used to miss that entirely. MiniMax ships `fl2va`
  // and `ref2va` as a pair; `fl2va` was never trained to consume reference
  // images, so staging a character sheet through `MiniMaxH3ReferenceToVideo`
  // on top of it produces a perfectly good clip that ignores the reference.
  // That is the silent-downgrade shape this repo keeps naming: it renders, so
  // nothing looks wrong. `localModels` withholds the r2v mode when this file
  // is not on disk, so reaching here without it means the user asked for a
  // mode the row does not advertise.
  const wantsRefs = !!b.refImages?.length;
  const unet = (wantsRefs && b.variant.refCheckpoint?.filename)
    || unets(b.variant)[0];
  const te = filesIn(b.variant.files, "text_encoders")[0]
    ?? filesIn(files, "text_encoders")[0];
  // The two VAEs are told apart by NAME, not by order: `variantFiles` puts the
  // variant's own files first and the family's shared ones after, and a
  // silently swapped pair is a mute render rather than an error.
  const vaes = filesIn(files, "vae");
  const videoVae = vaes.find((f) => f.includes("video")) ?? vaes[0];
  const audioVae = vaes.find((f) => f.includes("audio"));

  const g: ApiGraph = {
    1: modelLoader(b.variant, unet),
    2: clipLoader(te, "minimax"),
    3: { class_type: "VAELoader", inputs: { vae_name: videoVae } },
  };
  const refs = (b.refImages ?? []).slice(0, 9);
  const cond: Record<string, unknown> = {
    clip: ["2", 0], vae: ["3", 0], prompt: b.prompt,
    width: b.width, height: b.height, length: b.frames ?? 125,
  };
  if (refs.length) {
    // REFERENCE-TO-VIDEO IS A DIFFERENT NODE, not the same one with pictures
    // attached: `MiniMaxH3ReferenceToVideo` takes the AUDIO vae as a required
    // input too, and its reference slots are AUTOGROW keys under a namespace
    // (`ref_images.ref_image_0`, …). ComfyUI DROPS a key a class does not
    // declare rather than rejecting it, so a bare `image1` here would render
    // a text-to-video and log nothing — the trap `hidream_o1_graph` and the
    // SenseNova builder both document.
    if (!audioVae) {
      throw new Error("H3 reference-to-video needs the audio VAE, which is not installed");
    }
    g["4"] = { class_type: "VAELoader", inputs: { vae_name: audioVae } };
    cond.audio_vae = ["4", 0];
    cond.ref_image_size = "match";
    refs.forEach((name, i) => {
      g[String(30 + i)] = { class_type: "LoadImage", inputs: { image: name } };
      cond[`ref_images.ref_image_${i}`] = [String(30 + i), 0];
    });
    g["6"] = { class_type: "MiniMaxH3ReferenceToVideo", inputs: cond };
  } else {
    if (b.startImage) {
      g["5"] = { class_type: "LoadImage", inputs: { image: b.startImage } };
      cond.first_frame = ["5", 0];
    }
    g["6"] = { class_type: "MiniMaxH3ImageToVideo", inputs: cond };
  }
  let { last } = spliceLoras(g, "1", b.loras, 20);
  // THE SHIFT GOES BELOW THE ADAPTERS AND ABOVE BOTH CONSUMERS. It patches the
  // MODEL, so a node spliced above the LoRA chain would be shifted and then
  // replaced; and H3's step count comes off `BasicScheduler`, so the SCHEDULER
  // has to read the shifted model too — wiring only the guider leaves the
  // sigmas computed from an unshifted schedule, which is the half-applied form
  // of exactly the recipe this exists to reproduce.
  if (b.sampling.h3Shift) {
    const [video, audio] = b.sampling.h3Shift;
    g["2b"] = {
      class_type: "MiniMaxH3SigmaShift",
      inputs: { model: [last, 0], shift_video: video, shift_audio: audio },
    };
    last = "2b";
  }
  g["7"] = { class_type: "BasicGuider", inputs: { model: [last, 0], conditioning: ["6", 0] } };
  g["8"] = { class_type: "KSamplerSelect", inputs: { sampler_name: b.sampling.sampler } };
  // The step count comes off BasicScheduler here, not off a KSampler — the
  // trap `resolve()` documents on the pod, where a caller's `steps=` was
  // accepted and dropped for H3's whole life because only KSampler was written.
  g["9"] = {
    class_type: "BasicScheduler",
    inputs: {
      model: [last, 0], scheduler: b.sampling.scheduler,
      steps: b.sampling.steps, denoise: 1.0,
    },
  };
  g["10"] = { class_type: "RandomNoise", inputs: { noise_seed: b.seed } };
  g["11"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["10", 0], guider: ["7", 0], sampler: ["8", 0],
      sigmas: ["9", 0], latent_image: ["6", 1],
    },
  };
  g["12"] = { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } };
  const video: Record<string, unknown> = { images: ["12", 0], fps: 24 };
  if (audioVae) {
    // Already loaded on the r2v branch, where the node REQUIRES it — writing
    // it twice is harmless, wiring a second loader would not be.
    g["4"] ??= { class_type: "VAELoader", inputs: { vae_name: audioVae } };
    g["13"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["11", 0], vae: ["4", 0] } };
    video.audio = ["13", 0];
  }
  g["14"] = { class_type: "CreateVideo", inputs: video };
  g["15"] = {
    class_type: "SaveVideo",
    inputs: { video: ["14", 0], filename_prefix: b.prefix, format: "auto", codec: "auto" },
  };
  return g;
}

/**
 * LTX 2.5 — the one family here whose ordinary render is ALREADY two passes.
 *
 * A port of `workflows/ltx25_t2v.json` and `ltx25_r2v.json`, node for node,
 * with `i2v`/`flf` built on core's `LTXVAddGuide` in the same shape. Node ids
 * follow the r2v template's numbering so the two can be read side by side.
 *
 * WHY IT LOOKS LIKE TWO GRAPHS STACKED. That is what it is: the distilled
 * recipe samples a HALF-SIZE latent on a 9-sigma schedule, runs
 * `LTXVLatentUpsampler` over it, and finishes on a 4-sigma schedule at full
 * size. `latent_scale: 0.5` in the pod's map is the same decision, and
 * `dimStep: 64` is what makes it work without a resize node: half of a
 * multiple of 64 is a multiple of 32, so 2x lands exactly back on the size
 * that was asked for.
 *
 * THE SIGMAS ARE THE DISTILLATION, so `sampling.steps` is deliberately unused
 * here — the same rule the pod's entry documents. A caller raising the step
 * count gets the same nine sigmas, which is correct: these are not a schedule
 * with a length, they are the trained trajectory.
 *
 * THE NEGATIVE IS INERT AND THAT IS READ OFF CORE'S SOURCE, not assumed.
 * `Guider_LTXAVDualCFG.predict_noise` falls back to single-CFG the moment
 * `video_cfg == audio_cfg`, and the distilled recipe is 1.0/1.0 — so ComfyUI
 * never runs the uncond pass and the negative encode is decorative. The
 * recipe therefore declares no `negative`, and the reference path zeroes it
 * outright the way its template does.
 *
 * AUDIO IS NOT OPTIONAL. LTX samples a CONCATENATED audio+video latent, so an
 * empty audio latent rides both passes and is separated out again; the video
 * decode reads pass 2 and the audio decode reads pass 2's audio half. Dropping
 * the audio branch does not give you a silent render, it gives you a latent
 * the sampler cannot read.
 */
function buildLtx25(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const te = filesIn(files, "text_encoders")[0];
  const vaes = filesIn(files, "vae");
  // Told apart by NAME, never by order — `variantFiles` puts the variant's own
  // files first and the family's shared ones after, and a swapped pair decodes
  // a waveform as pictures rather than failing.
  const videoVae = vaes.find((f) => f.includes("video")) ?? vaes[0];
  const audioVae = vaes.find((f) => f.includes("audio"));
  const upscaler = filesIn(files, "latent_upscale_models")[0];
  const msrLora = filesIn(files, "loras").find((f) => f.includes("MSR"));

  if (!audioVae) throw new Error("LTX 2.5 needs its audio VAE, which is not installed");
  if (!upscaler) {
    // The second pass has nothing to upsample with, and there is no one-pass
    // fallback worth having: the first pass renders at HALF the requested size.
    throw new Error("LTX 2.5 needs its x2 latent upsampler, which is not installed");
  }

  const refs = (b.refImages ?? []).slice(0, 5);
  const guided = refs.length > 0 || !!b.startImage || !!b.endImage;
  const frames = b.frames ?? 121;
  // Half size for pass 1 — see the header. Rounded to /32 rather than floored:
  // these are latent dimensions and the upsampler doubles whatever it is given.
  const half = (n: number) => Math.max(32, Math.round(n / 2 / 32) * 32);

  const g: ApiGraph = {
    1: modelLoader(b.variant, unets(b.variant)[0]),
    2: clipLoader(te, "ltxv"),
    3: { class_type: "VAELoader", inputs: { vae_name: videoVae } },
    4: { class_type: "VAELoader", inputs: { vae_name: audioVae } },
    5: { class_type: "LatentUpscaleModelLoader", inputs: { model_name: upscaler } },
    7: { class_type: "CLIPTextEncode", inputs: { text: b.prompt, clip: ["2", 0] } },
  };

  // The picked adapters go on the transformer FIRST, so the MSR IC-LoRA — which
  // is a model patch like any other — sits at the end of the chain and every
  // consumer below reads one model.
  const { last: loraEnd, nextId } = spliceLoras(g, "1", b.loras, 50);
  let model = loraEnd;

  if (refs.length) {
    if (!msrLora) {
      // `resolve()` raises here too, and for the same reason: the guide node
      // without its IC-LoRA is misconfiguration, not a weaker render. The
      // slot embeddings the references are addressed through live in this file.
      throw new Error("LTX 2.5 reference mode needs the MSR IC-LoRA, which is not installed");
    }
    g["6"] = {
      class_type: "ComfyUILTX25MSRICLoRALoader",
      inputs: { model: [model, 0], lora_name: msrLora, strength_model: 1.0 },
    };
    model = "6";
  }

  // ONE ENCODE, ZEROED FOR THE NEGATIVE — the reference template's shape, used
  // for every mode here including t2v, where the template wires a second
  // `CLIPTextEncode` instead.
  //
  // A DELIBERATE DIVERGENCE, and the only one in this port. The two are
  // equivalent while `video_cfg == audio_cfg`, because core's
  // `Guider_LTXAVDualCFG.predict_noise` then never evaluates the uncond branch
  // at all — so the second encode is a text encoder pass whose result is
  // thrown away. Zeroing says that out loud, matches the recipe declaring no
  // `negative`, and keeps this family's claim ("no uncond branch") checkable
  // against the graph rather than asserted. If the two scales are ever allowed
  // to differ, this is the line that has to change back.
  g["8"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["7", 0] } };

  g["9"] = {
    class_type: "LTXVConditioning",
    inputs: { positive: ["7", 0], negative: ["8", 0], frame_rate: 24.0 },
  };
  g["10"] = {
    class_type: "EmptyLTXVLatentVideo",
    inputs: { width: half(b.width), height: half(b.height), length: frames, batch_size: 1 },
  };
  g["12"] = {
    class_type: "LTXVEmptyLatentAudio",
    inputs: { frames_number: frames, frame_rate: 24, batch_size: 1, audio_vae: ["4", 0] },
  };

  // Every staged picture becomes a LoadImage once and is wired into BOTH
  // passes: a guide pinned only into pass 1 is a frame the refine pass is free
  // to move off, which is the whole failure `LTXVCropGuides` and the re-applied
  // guide exist to prevent.
  let imgId = nextId;
  const image = (name: string): [string, number] => {
    const key = String(imgId++);
    g[key] = { class_type: "LoadImage", inputs: { image: name } };
    return [key, 0];
  };
  const refPics = refs.map(image);
  const startPic = b.startImage ? image(b.startImage) : null;
  const endPic = b.endImage ? image(b.endImage) : null;

  /**
   * Pin the mode's pictures into one pass's latent.
   *
   * Returns the ids to read positive, negative and latent from — which is why
   * it hands back a triple rather than a node id: every guide node here has
   * three outputs and the un-guided case has none, so the caller must not
   * assume where its conditioning comes from.
   */
  function applyGuides(
    id: number, pos: [string, number], neg: [string, number], latent: [string, number],
  ): { pos: [string, number]; neg: [string, number]; latent: [string, number] } {
    if (refs.length) {
      const inputs: Record<string, unknown> = {
        positive: pos, negative: neg, vae: ["3", 0], latent,
        strength: 1.0,
        // 25 or 33 ONLY — the guide raises on anything else, and it is PER
        // REFERENCE rather than a budget to divide between them.
        reference_frames: "33",
        use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
        msr_parameters: ["6", 1],
      };
      // Four SUBJECT slots and a dedicated BACKGROUND, each carrying its own
      // learned embedding — so a fifth picture is the location, not a fifth
      // subject. Same split `blocks._wire_msr_refs` makes on the pod.
      refPics.slice(0, 4).forEach((ref, i) => { inputs[`pic${i + 1}`] = ref; });
      if (refPics[4]) inputs.background = refPics[4];
      g[String(id)] = { class_type: "ComfyUILTX25MSRMultiReferenceGuide", inputs };
      return { pos: [String(id), 0], neg: [String(id), 1], latent: [String(id), 2] };
    }
    let cur = { pos, neg, latent };
    // frame_idx 0 is the first frame and -1 the last, so first-and-last is two
    // guides CHAINED on one latent rather than a different node. The FIRST
    // takes the template's own id so a one-guide graph reads like the template
    // it came from; a second would need a fractional id, and a graph key is a
    // string — so it comes off the shared allocator instead.
    let first = true;
    for (const [pic, frameIdx] of [[startPic, 0], [endPic, -1]] as const) {
      if (!pic) continue;
      const key = first ? String(id) : String(imgId++);
      first = false;
      g[key] = {
        class_type: "LTXVAddGuide",
        inputs: {
          positive: cur.pos, negative: cur.neg, vae: ["3", 0], latent: cur.latent,
          image: pic, frame_idx: frameIdx, strength: 1.0,
        },
      };
      cur = { pos: [key, 0], neg: [key, 1], latent: [key, 2] };
    }
    return cur;
  }

  // PASS 1 — half size, nine sigmas.
  const p1 = applyGuides(11, ["9", 0], ["9", 1], ["10", 0]);
  g["13"] = {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: p1.latent, audio_latent: ["12", 0] },
  };
  g["14"] = { class_type: "RandomNoise", inputs: { noise_seed: b.seed } };
  g["15"] = { class_type: "KSamplerSelect", inputs: { sampler_name: b.sampling.sampler } };
  g["16"] = { class_type: "ManualSigmas", inputs: { sigmas: LTX25_SIGMAS_1 } };
  g["17"] = {
    class_type: "LTXVDualCFGGuider",
    inputs: {
      model: [model, 0], positive: p1.pos, negative: p1.neg,
      video_cfg: b.sampling.cfg, audio_cfg: b.sampling.cfg,
    },
  };
  g["18"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["14", 0], guider: ["17", 0], sampler: ["15", 0],
      sigmas: ["16", 0], latent_image: ["13", 0],
    },
  };
  g["19"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["18", 0] } };

  // The guide frames have to come OFF before the upsampler sees the latent —
  // they were prepended to it, so upsampling without cropping doubles them too
  // and pass 2 re-pins its guides on top of the old ones.
  let upsampleFrom: [string, number] = ["19", 0];
  if (guided) {
    g["20"] = {
      class_type: "LTXVCropGuides",
      inputs: { positive: p1.pos, negative: p1.neg, latent: ["19", 0] },
    };
    upsampleFrom = ["20", 2];
  }
  g["21"] = {
    class_type: "LTXVLatentUpsampler",
    inputs: { samples: upsampleFrom, upscale_model: ["5", 0], vae: ["3", 0] },
  };

  // PASS 2 — full size, four sigmas, guides re-applied to the upscaled latent.
  const p2raw = applyGuides(22, ["7", 0], ["8", 0], ["21", 0]);
  g["23"] = {
    class_type: "LTXVConditioning",
    inputs: { positive: p2raw.pos, negative: p2raw.neg, frame_rate: 24.0 },
  };
  const p2 = { pos: ["23", 0] as [string, number], neg: ["23", 1] as [string, number] };
  g["24"] = {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: p2raw.latent, audio_latent: ["19", 1] },
  };
  g["25"] = { class_type: "RandomNoise", inputs: { noise_seed: b.seed } };
  g["26"] = { class_type: "KSamplerSelect", inputs: { sampler_name: b.sampling.sampler } };
  g["27"] = { class_type: "ManualSigmas", inputs: { sigmas: LTX25_SIGMAS_2 } };
  g["28"] = {
    class_type: "LTXVDualCFGGuider",
    inputs: {
      model: [model, 0], positive: p2.pos, negative: p2.neg,
      video_cfg: b.sampling.cfg, audio_cfg: b.sampling.cfg,
    },
  };
  g["29"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["25", 0], guider: ["28", 0], sampler: ["26", 0],
      sigmas: ["27", 0], latent_image: ["24", 0],
    },
  };
  g["30"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["29", 0] } };

  let decodeFrom: [string, number] = ["30", 0];
  if (guided) {
    g["31"] = {
      class_type: "LTXVCropGuides",
      inputs: { positive: p2.pos, negative: p2.neg, latent: ["30", 0] },
    };
    decodeFrom = ["31", 2];
  }
  g["32"] = { class_type: "VAEDecode", inputs: { samples: decodeFrom, vae: ["3", 0] } };
  // The AUDIO half is read from the SEPARATE, never from the crop: guides are a
  // video-latent concept and `LTXVCropGuides` has no audio to give back.
  g["33"] = {
    class_type: "LTXVAudioVAEDecode",
    inputs: { samples: ["30", 1], audio_vae: ["4", 0] },
  };
  g["34"] = {
    class_type: "CreateVideo",
    inputs: { images: ["32", 0], audio: ["33", 0], fps: 24.0 },
  };
  g["35"] = {
    class_type: "SaveVideo",
    inputs: { video: ["34", 0], filename_prefix: b.prefix, format: "auto", codec: "auto" },
  };
  return g;
}

/**
 * Qwen-Image-Edit — the only local family that can compose FROM pictures.
 *
 * A port of `worker/graphs.py::qwen_edit_graph`. Until this existed every
 * local model was text-to-image only: `localRender` staged exactly one image
 * (a start frame) and no builder took a reference at all, so "edit this" and
 * "compose these three" had no local answer whatsoever. `TextEncodeQwenImageEditPlus`
 * is CORE ComfyUI (`comfy_extras.nodes_qwen`), so unlike the Krea 2 reference
 * path this cannot fall back for want of an install.
 *
 * BOTH ENCODES SEE THE SAME PICTURES; only the prompt differs. cfg is 2.5, so
 * unlike every turbo checkpoint here the negative branch is genuinely
 * evaluated — this family declares a negative and means it.
 *
 * THE LATENT STARTS EMPTY, which is what makes this `r2i` (compose the
 * references into a NEW frame) rather than a repaint. The distinction is the
 * one the pod's own `payload.mode` exists to carry: inferring it from "has
 * references" is what once made every edit render a different picture.
 */
function buildQwenEdit(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const g: ApiGraph = {
    1: modelLoader(b.variant, unets(b.variant)[0]),
    2: clipLoader(filesIn(files, "text_encoders")[0], "qwen_image"),
    3: { class_type: "VAELoader", inputs: { vae_name: one(files, "vae") } },
    6: {
      class_type: "EmptySD3LatentImage",
      inputs: { width: b.width, height: b.height, batch_size: 1 },
    },
  };
  const { last } = spliceLoras(g, "1", b.loras, 20);
  // A flow model wants AuraFlow's shift; CFGNorm is what keeps 2.5 from
  // burning. Both ride the MODEL, so they go AFTER the LoRA chain — spliced
  // before them, an adapter would be sampled through an unshifted model.
  g["4"] = { class_type: "ModelSamplingAuraFlow", inputs: { model: [last, 0], shift: 3.1 } };
  g["5"] = { class_type: "CFGNorm", inputs: { model: ["4", 0], strength: 1.0 } };

  // image1 is the one the node anchors on, so pick order is load-bearing —
  // the same rule `order_anchors` encodes on the pod. Three is the node's
  // ceiling, not a budget we chose.
  const refs = (b.refImages ?? []).slice(0, 3);
  refs.forEach((name, i) => {
    g[String(30 + i)] = { class_type: "LoadImage", inputs: { image: name } };
  });
  const encode = (id: string, text: string) => {
    const ins: Record<string, unknown> = { clip: ["2", 0], prompt: text, vae: ["3", 0] };
    refs.forEach((_, i) => { ins[`image${i + 1}`] = [String(30 + i), 0]; });
    g[id] = { class_type: "TextEncodeQwenImageEditPlus", inputs: ins };
  };
  encode("7", b.prompt);
  encode("8", b.negative);

  g["9"] = {
    class_type: "KSampler",
    inputs: {
      model: ["5", 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["7", 0], negative: ["8", 0], latent_image: ["6", 0], denoise: 1.0,
    },
  };
  g["10"] = { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } };
  g["11"] = { class_type: "SaveImage", inputs: { images: ["10", 0], filename_prefix: b.prefix } };
  return g;
}

/**
 * MiniMax Music 3 — full songs with sung vocals, on this machine.
 *
 * A port of `worker/graphs.py::music3_graph`. Until this and the SFX builder
 * below there was NO local audio of any kind: the desktop catalogue listed
 * image and video families only, so every soundtrack, every effect and every
 * score meant waking a $3.36/hr box.
 *
 * THE LENGTH COMES OUT OF THE ENCODER, NOT OFF A NUMBER, and this is the one
 * thing about the family that is easy to get wrong. `MiniMaxMusic3TextEncode`
 * returns (CONDITIONING, FLOAT), and that float is the duration its 8B planner
 * chose having READ the lyrics; `max_duration` is a ceiling it may finish
 * under. Writing your own number into the latent instead renders successfully
 * and pads the end with filler.
 */
function buildMusic3(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const g: ApiGraph = {
    1: modelLoader(b.variant, unets(b.variant)[0]),
    3: clipLoader(filesIn(files, "text_encoders")[0], "minimax"),
    4: { class_type: "VAELoader", inputs: { vae_name: one(files, "vae") } },
    5: {
      class_type: "MiniMaxMusic3TextEncode",
      inputs: {
        clip: ["3", 0], caption: b.prompt, lyrics: b.lyrics ?? "",
        seed: b.seed, max_duration: b.seconds ?? 60, cfg_scale: 1.5, top_k: 50,
      },
    },
    // No second text encode: the reference graph zeroes the positive instead,
    // which is what the recipe was tuned against.
    6: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
    7: {
      class_type: "EmptyMiniMaxMusic3LatentAudio",
      inputs: { seconds: ["5", 1], batch_size: 1 },
    },
  };
  const { last } = spliceLoras(g, "1", b.loras, 20);
  g["8"] = {
    class_type: "KSampler",
    inputs: {
      model: [last, 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], denoise: 1.0,
    },
  };
  g["9"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 0], vae: ["4", 0] } };
  g["10"] = {
    class_type: "SaveAudioMP3",
    inputs: { audio: ["9", 0], filename_prefix: b.prefix, quality: "V0" },
  };
  return g;
}

/**
 * Stable Audio 3 — sound effects and short beds, and the smallest useful
 * model in this whole catalogue at 3.3GB the pair.
 *
 * A port of `worker/graphs.py::stable_audio_graph`. Two things it does that
 * look like mistakes and are not:
 *
 * THE CHECKPOINT'S CLIP IS A DECOY. `CheckpointLoaderSimple` hands back MODEL,
 * CLIP and VAE — and the conditioner is NOT that CLIP. It is t5gemma, loaded
 * separately at type `stable_audio`. Taking the checkpoint's own would
 * validate, condition on the wrong encoder and quietly produce a worse sound.
 * The VAE, by contrast, IS the checkpoint's (slot 2), which is why there is no
 * VAELoader here.
 *
 * THE NEGATIVE IS REAL. This samples at cfg 7, unlike every distilled row in
 * this catalogue — so unlike Krea 2 and H3 the recipe declares one and means
 * it.
 */
function buildStableAudio(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const g: ApiGraph = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: one(files, "checkpoints") } },
    3: clipLoader(filesIn(files, "text_encoders")[0], "stable_audio"),
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: b.prompt } },
    6: { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: b.negative } },
    7: { class_type: "EmptyLatentAudio", inputs: { seconds: b.seconds ?? 10, batch_size: 1 } },
  };
  const { last } = spliceLoras(g, "1", b.loras, 20);
  g["8"] = {
    class_type: "KSampler",
    inputs: {
      model: [last, 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], denoise: 1.0,
    },
  };
  g["9"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 0], vae: ["1", 2] } };
  g["10"] = {
    class_type: "SaveAudioMP3",
    inputs: { audio: ["9", 0], filename_prefix: b.prefix, quality: "V0" },
  };
  return g;
}

/**
 * Anima 2.9B — anime and illustration, and the one image family here that is
 * NOT distilled.
 *
 * A port of `worker/graphs.py::anima_graph`. Two consequences of not being
 * distilled: it wants a real step count and a real cfg (32 at 4.0, on
 * sgm_uniform), and its negative prompt genuinely reaches the sampler — where
 * Krea 2's cannot. It also loads its encoder at type `stable_diffusion`
 * despite being a Qwen3-0.6B tower, which is the template's own value and not
 * a mistake to tidy.
 */
function buildAnima(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const g: ApiGraph = {
    1: modelLoader(b.variant, unets(b.variant)[0]),
    2: clipLoader(filesIn(files, "text_encoders")[0], "stable_diffusion"),
    3: { class_type: "VAELoader", inputs: { vae_name: one(files, "vae") } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: b.prompt } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: b.negative } },
    6: {
      class_type: "EmptyLatentImage",
      inputs: { width: b.width, height: b.height, batch_size: 1 },
    },
  };
  const { last } = spliceLoras(g, "1", b.loras, 20);
  g["7"] = {
    class_type: "KSampler",
    inputs: {
      model: [last, 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], denoise: 1.0,
    },
  };
  g["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  g["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: b.prefix } };
  return g;
}

/**
 * HiDream O1 — up to TEN reference images, more than anything else here.
 *
 * A port of `worker/graphs.py::hidream_o1_graph`, and the odd one out in three
 * ways, all of them the model's:
 *   - it samples through `SamplerCustom` over `BasicScheduler` sigmas, not a
 *     KSampler, with `ModelNoiseScale` ahead of the scheduler;
 *   - its reference node's autogrow keys are FLAT (`images.image_1`), where
 *     H3's are namespaced per slot — ComfyUI drops an undeclared key silently,
 *     so the difference is a reference set that vanishes rather than an error;
 *   - `HiDreamO1ReferenceImages` returns BOTH conditionings, so with
 *     references the sampler reads slots 0 and 1 of that node rather than the
 *     two text encodes.
 */
function buildHiDream(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const g: ApiGraph = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: one(files, "checkpoints") } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: b.prompt } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: b.negative } },
    7: {
      class_type: "EmptyHiDreamO1LatentImage",
      inputs: { width: b.width, height: b.height, batch_size: 1 },
    },
    8: { class_type: "KSamplerSelect", inputs: { sampler_name: b.sampling.sampler } },
  };
  const { last } = spliceLoras(g, "1", b.loras, 30);
  g["2"] = { class_type: "ModelNoiseScale", inputs: { model: [last, 0], noise_scale: 8.0 } };
  g["3"] = {
    class_type: "HiDreamO1PatchSeamSmoothing",
    inputs: {
      model: ["2", 0], start_percent: 0.8, end_percent: 1.0,
      pattern: "single_shift", passes: "2", blend: "average", strength: 1.0,
    },
  };
  g["9"] = {
    class_type: "BasicScheduler",
    inputs: {
      model: ["2", 0], scheduler: b.sampling.scheduler,
      steps: b.sampling.steps, denoise: 1.0,
    },
  };
  let pos: [string, number] = ["4", 0];
  let neg: [string, number] = ["5", 0];
  const refs = (b.refImages ?? []).slice(0, 10);
  if (refs.length) {
    const ins: Record<string, unknown> = { positive: ["4", 0], negative: ["5", 0] };
    refs.forEach((name, i) => {
      g[String(40 + i)] = { class_type: "LoadImage", inputs: { image: name } };
      ins[`images.image_${i + 1}`] = [String(40 + i), 0];
    });
    g["6"] = { class_type: "HiDreamO1ReferenceImages", inputs: ins };
    pos = ["6", 0];
    neg = ["6", 1];
  }
  g["10"] = {
    class_type: "SamplerCustom",
    inputs: {
      model: ["3", 0], add_noise: true, noise_seed: b.seed, cfg: b.sampling.cfg,
      positive: pos, negative: neg, sampler: ["8", 0], sigmas: ["9", 0],
      latent_image: ["7", 0],
    },
  };
  g["11"] = { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 2] } };
  g["12"] = { class_type: "SaveImage", inputs: { images: ["11", 0], filename_prefix: b.prefix } };
  return g;
}

/**
 * ACE-Step 1.5 — the fast songwriter.
 *
 * A port of `worker/graphs.py::acestep_graph`. TWO ENCODERS, and both are
 * required: `DualCLIPLoader` takes the 0.6b embedder and the 1.7b planner, so
 * loading one is not a smaller model but a graph that fails validation.
 *
 * THE DURATION IS WRITTEN TWICE, into the encoder AND the latent, and unlike
 * Music 3 they are the SAME number — the encoder has no duration output to
 * read back. Writing two different values renders successfully with filler on
 * the end, which is the same silent failure from the other direction.
 */
function buildAceStep(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const tes = filesIn(files, "text_encoders");
  const seconds = b.seconds ?? 120;
  const g: ApiGraph = {
    1: modelLoader(b.variant, unets(b.variant)[0]),
    3: {
      class_type: "DualCLIPLoader",
      inputs: { clip_name1: tes[0], clip_name2: tes[1], type: "ace", device: "default" },
    },
    4: { class_type: "VAELoader", inputs: { vae_name: one(files, "vae") } },
    5: {
      class_type: "TextEncodeAceStepAudio1.5",
      inputs: {
        clip: ["3", 0], tags: b.prompt, lyrics: b.lyrics ?? "", seed: b.seed,
        bpm: 120, duration: seconds, timesignature: "4", language: "en",
        keyscale: "C major", generate_audio_codes: true,
        cfg_scale: 1.5, temperature: 1.0, top_p: 0.95, top_k: 50, min_p: 0.0,
      },
    },
    6: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
    7: { class_type: "EmptyAceStep1.5LatentAudio", inputs: { seconds, batch_size: 1 } },
  };
  const { last } = spliceLoras(g, "1", b.loras, 20);
  // A flow model: AuraFlow's shift rides the MODEL, so it goes below the LoRA
  // chain for the same reason it does on Qwen-Edit.
  g["2"] = { class_type: "ModelSamplingAuraFlow", inputs: { model: [last, 0], shift: 3.0 } };
  g["8"] = {
    class_type: "KSampler",
    inputs: {
      model: ["2", 0], seed: b.seed,
      steps: b.sampling.steps, cfg: b.sampling.cfg,
      sampler_name: b.sampling.sampler, scheduler: b.sampling.scheduler,
      positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], denoise: 1.0,
    },
  };
  g["9"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 0], vae: ["4", 0] } };
  g["10"] = {
    class_type: "SaveAudioMP3",
    inputs: { audio: ["9", 0], filename_prefix: b.prefix, quality: "V0" },
  };
  return g;
}

/**
 * Flux 2 dev — references through a LATENT rather than a text encoder.
 *
 * A port of `worker/graphs.py::flux2_ref_graph`. The difference from
 * Qwen-Edit is the mechanism, not the size of the reference budget:
 * `ReferenceLatent` chains VAE-encoded pictures onto the conditioning, so a
 * likeness comes through pixels rather than through a vision tower — which is
 * why both are worth having locally.
 */
function buildFlux2(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const g: ApiGraph = {
    1: modelLoader(b.variant, unets(b.variant)[0]),
    2: clipLoader(filesIn(files, "text_encoders")[0], "flux2"),
    3: { class_type: "VAELoader", inputs: { vae_name: one(files, "vae") } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: b.prompt } },
    6: {
      class_type: "EmptyFlux2LatentImage",
      inputs: { width: b.width, height: b.height, batch_size: 1 },
    },
    8: { class_type: "KSamplerSelect", inputs: { sampler_name: b.sampling.sampler } },
    10: { class_type: "RandomNoise", inputs: { noise_seed: b.seed } },
  };
  const { last } = spliceLoras(g, "1", b.loras, 30);
  // Each reference is encoded and CHAINED onto the one before it, so the
  // order is the composition — the same rule Qwen-Edit's image1 follows.
  let cond: [string, number] = ["4", 0];
  (b.refImages ?? []).slice(0, 4).forEach((name, i) => {
    const load = String(40 + i * 3);
    const enc = String(41 + i * 3);
    const ref = String(42 + i * 3);
    g[load] = { class_type: "LoadImage", inputs: { image: name } };
    g[enc] = { class_type: "VAEEncode", inputs: { pixels: [load, 0], vae: ["3", 0] } };
    g[ref] = { class_type: "ReferenceLatent", inputs: { conditioning: cond, latent: [enc, 0] } };
    cond = [ref, 0];
  });
  g["5"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: cond } };
  g["7"] = {
    class_type: "CFGGuider",
    inputs: { model: [last, 0], positive: cond, negative: ["5", 0], cfg: b.sampling.cfg },
  };
  // NO `model` INPUT. `Flux2Scheduler` derives its sigmas from the RESOLUTION
  // and the step count alone — the pod's own graph passes exactly these three.
  // ComfyUI drops an undeclared key silently rather than refusing it, so a
  // stray `model` here validated against the live engine and was caught only
  // by checking against the schema.
  g["9"] = {
    class_type: "Flux2Scheduler",
    inputs: { steps: b.sampling.steps, width: b.width, height: b.height },
  };
  g["11"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["10", 0], guider: ["7", 0], sampler: ["8", 0],
      sigmas: ["9", 0], latent_image: ["6", 0],
    },
  };
  g["12"] = { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } };
  g["13"] = { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: b.prefix } };
  return g;
}

/* ── post: passes that run over a finished clip ─────────────────────────── */

/**
 * SeedVR2 — a diffusion RESTORE for video.
 *
 * A port of `worker/graphs.py::seedvr2_graph`. Three things about it are
 * counter-intuitive and all three are the model's, not choices:
 *   - ONE STEP, cfg 1.0. Raising the step count is fighting the model.
 *   - THE ENLARGE IS A PLAIN LANCZOS RESIZE and SeedVR2 re-detects detail at
 *     the target size, which is why scale 1.0 is a legitimate request: clean
 *     up a soft render without changing its size.
 *   - `original_resized_images` is the RESIZED input, not the source. It is
 *     the colour reference the post-process matches back to, so it has to be
 *     the same geometry as the decode.
 *
 * The tiled encode/decode is not optional at video resolutions: the plain
 * pair holds every frame's activations at once.
 */
function buildSeedVr2(b: BuildInput): ApiGraph {
  const files = variantFiles(b.family, b.variant);
  const tile = { tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 };
  const g: ApiGraph = {
    1: modelLoader(b.variant, unets(b.variant)[0]),
    2: { class_type: "VAELoader", inputs: { vae_name: one(files, "vae") } },
    3: { class_type: "LoadVideo", inputs: { file: b.sourceVideo } },
    4: { class_type: "GetVideoComponents", inputs: { video: ["3", 0] } },
    5: {
      class_type: "ImageScaleBy",
      inputs: { image: ["4", 0], upscale_method: "lanczos", scale_by: b.factor ?? 2 },
    },
    6: { class_type: "SeedVR2Preprocess", inputs: { resized_images: ["5", 0] } },
    7: { class_type: "VAEEncodeTiled", inputs: { pixels: ["6", 0], vae: ["2", 0], ...tile } },
    8: { class_type: "SeedVR2Conditioning", inputs: { model: ["1", 0], vae_conditioning: ["7", 0] } },
    9: {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], seed: b.seed, steps: 1, cfg: 1,
        sampler_name: "euler", scheduler: "simple",
        positive: ["8", 0], negative: ["8", 1], latent_image: ["7", 0], denoise: 1.0,
      },
    },
    10: { class_type: "VAEDecodeTiled", inputs: { samples: ["9", 0], vae: ["2", 0], ...tile } },
    11: {
      class_type: "SeedVR2PostProcessing",
      inputs: {
        images: ["10", 0], original_resized_images: ["5", 0],
        color_correction_method: "lab",
      },
    },
    // The SOURCE's own fps, audio and bit depth ride through — a restore that
    // silently resampled the sound or dropped it would be a different clip.
    12: {
      class_type: "CreateVideo",
      inputs: { images: ["11", 0], fps: ["4", 2], audio: ["4", 1], bit_depth: ["4", 3] },
    },
    13: {
      class_type: "SaveVideo",
      inputs: { video: ["12", 0], filename_prefix: b.prefix, format: "auto", codec: "auto" },
    },
  };
  return g;
}

/**
 * FILM / RIFE — more frames between the frames there are.
 *
 * A port of `worker/graphs.py::frame_interp_graph`. The output fps is the
 * source's TIMES the multiplier, which is what makes this smoother playback
 * rather than slow motion; passing the source's own fps instead would be the
 * slow-motion pass, and it is a different feature.
 */
function buildFrameInterp(b: BuildInput): ApiGraph {
  const model = filesIn(variantFiles(b.family, b.variant), "frame_interpolation")[0];
  const mult = Math.max(2, Math.round(b.factor ?? 2));
  return {
    1: { class_type: "FrameInterpolationModelLoader", inputs: { model_name: model } },
    2: { class_type: "LoadVideo", inputs: { file: b.sourceVideo } },
    3: { class_type: "GetVideoComponents", inputs: { video: ["2", 0] } },
    4: {
      class_type: "FrameInterpolate",
      inputs: { interp_model: ["1", 0], images: ["3", 0], multiplier: mult },
    },
    5: { class_type: "CreateVideo", inputs: { images: ["4", 0], fps: ["3", 2], audio: ["3", 1] } },
    6: {
      class_type: "SaveVideo",
      inputs: { video: ["5", 0], filename_prefix: b.prefix, format: "auto", codec: "auto" },
    },
  };
}

/**
 * The post passes, keyed by `POST_PROCESS` tool id.
 *
 * SEPARATE FROM `RECIPES` because a post tool is not a model: you do not
 * CHOOSE between SeedVR2 and Wan, and putting one in the video picker would
 * offer "generate a clip with an upscaler". It also takes a clip as its input,
 * which no recipe here does — hence its own job kinds and its own trigger on
 * the asset itself.
 */
export interface PostRecipe {
  /** `POST_PROCESS` tool id */
  tool: string;
  /** the job kind the local worker queues */
  jobKind: string;
  label: string;
  /** what `factor` means for this pass, for the surface to say */
  factorLabel: string;
  factors: number[];
  build: (b: BuildInput) => ApiGraph;
}

export const POST_RECIPES: Record<string, PostRecipe> = {
  "seedvr2-3b": {
    tool: "seedvr2-3b", jobKind: "post_upscale", label: "Restore / upscale",
    // 1.0 is a real choice, not a no-op: the enlarge is a plain resize and
    // SeedVR2 is the restore after it, so scale 1 cleans up a soft render at
    // its own size.
    factorLabel: "scale", factors: [1, 1.5, 2],
    build: buildSeedVr2,
  },
  "frame-interp": {
    tool: "frame-interp", jobKind: "post_interpolate", label: "Interpolate frames",
    factorLabel: "x frame rate", factors: [2, 4],
    build: buildFrameInterp,
  },
};

export const postRecipe = (tool: string): PostRecipe | null => POST_RECIPES[tool] ?? null;

export const RECIPES: Record<string, LocalRecipe> = {
  sd15: {
    family: "sd15", kind: "image", modes: ["t2i"], dimStep: 8,
    sampling: { steps: 20, cfg: 7, sampler: "euler", scheduler: "normal" },
    sizes: imageSizes([512, 640, 768]),
    negative: NEG_IMAGE,
    portedFrom: ["ComfyUI's own default graph"],
    build: buildCheckpointImage,
  },
  krea2: {
    family: "krea2", kind: "image", modes: ["t2i"], dimStep: 16,
    // The pod's own recipe for this checkpoint: distilled turbo, so 8 steps at
    // cfg 1.0 on euler/simple. Sampling it like a base model is both slower
    // and worse.
    sampling: { steps: 8, cfg: 1, sampler: "euler", scheduler: "simple" },
    sizes: imageSizes([1024, 1280]),
    // No `negative`: cfg 1.0 never evaluates the branch. See LocalRecipe.
    portedFrom: ["worker/graphs.py::krea2_graph"],
    build: buildKrea2,
  },
  "music3": {
    family: "music3", kind: "audio",
    // `t2m` is what puts a row in the MUSIC picker rather than the SFX one —
    // the same discriminator `catalog.musicModels` uses, because both are
    // `kind: "audio"` and the column allows no third value.
    modes: ["t2m"], dimStep: 1, sizes: [],
    sampling: { steps: 50, cfg: 3, sampler: "euler", scheduler: "simple" },
    maxSeconds: 300,
    // No `negative`: the graph zeroes the positive encode rather than
    // evaluating a second one.
    portedFrom: ["worker/graphs.py::music3_graph"],
    build: buildMusic3,
  },
  "stable-audio": {
    family: "stable-audio", kind: "audio",
    modes: ["t2sfx"], dimStep: 1, sizes: [],
    // The BASE recipe. `perVariant` drops the distilled rows to 8 steps at cfg
    // 1 — sampling a distillation like a base model is both slower and worse.
    sampling: { steps: 50, cfg: 7, sampler: "euler", scheduler: "simple" },
    // THE `_base` SUFFIX IS THE WHOLE DISTINCTION, and it is inverted from
    // what the names suggest: `stable_audio_3_*_base` is the UNDISTILLED
    // model (50 steps, cfg 7) and the plain name is the distilled one (8
    // steps, cfg 1). Sampling a distillation at the base recipe is both
    // slower and worse — which is exactly what this map got wrong on its
    // first pass, by naming a variant that does not exist and leaving the
    // real distilled medium on 50 steps.
    perVariant: {
      "sa-sfx": { steps: 8, cfg: 1 },
      "sa-medium": { steps: 8, cfg: 1 },
    },
    maxSeconds: 120,
    negative: "low quality, distorted, clipping, hiss",
    portedFrom: ["worker/graphs.py::stable_audio_graph"],
    build: buildStableAudio,
  },
  anima: {
    family: "anima", kind: "image", modes: ["t2i"], dimStep: 8,
    // NOT distilled: 32 steps at cfg 4 on sgm_uniform, which is the pod's own
    // recipe for the 2.9B. Sampling it like a turbo model is what makes an
    // undistilled model look bad.
    sampling: { steps: 32, cfg: 4, sampler: "euler", scheduler: "sgm_uniform" },
    sizes: imageSizes([1024, 1328]),
    negative: NEG_IMAGE,
    portedFrom: ["worker/graphs.py::anima_graph"],
    build: buildAnima,
  },
  "hidream-o1": {
    family: "hidream-o1", kind: "image", modes: ["t2i", "r2i"], dimStep: 16,
    sampling: { steps: 40, cfg: 5, sampler: "dpmpp_2m_sde_gpu", scheduler: "normal" },
    sizes: imageSizes([1024, 1328]),
    negative: NEG_IMAGE,
    portedFrom: ["worker/graphs.py::hidream_o1_graph"],
    build: buildHiDream,
  },
  flux2: {
    family: "flux2", kind: "image", modes: ["t2i", "r2i"], dimStep: 16,
    // cfg 1: Flux 2 dev is guidance-distilled, so the CFGGuider's negative
    // branch is not evaluated — hence no `negative` below.
    sampling: { steps: 20, cfg: 1, sampler: "euler", scheduler: "simple" },
    sizes: imageSizes([1024, 1328]),
    portedFrom: ["worker/graphs.py::flux2_ref_graph"],
    build: buildFlux2,
  },
  // BOTH KLEIN SIZES RENDER THROUGH `buildFlux2`, and that is a fact about
  // the architecture rather than a shortcut. ComfyUI detects Klein as
  // `image_model = "flux2"` off its own state dict (`model_detection.py`, keyed
  // on `double_stream_modulation_img.lin.weight`), its encoder loads at
  // CLIPLoader type `flux2`, and the pod's `flux2_klein_graph` is
  // `flux2_ref_graph` node for node bar the loader. The one thing the pod's
  // klein builder does NOT do is branch on `.gguf` — it only ever loads a
  // safetensors — and `modelLoader` here does, which is what makes the
  // quantised rungs loadable at all.
  //
  // FOUR STEPS AT cfg 1.0 IS BFL'S PUBLISHED RECIPE for the distilled klein
  // ("guidance_scale=1.0, num_inference_steps=4" in the model card's own
  // example), NOT the pod's 50-at-4.0 — that entry runs klein *base*, whose
  // own docstring records 50/4.0 coming back over-guided with "radioactive
  // green tiles, hard black outlines and posterised flat light". Copying the
  // pod's numbers onto a distilled checkpoint would import a known-bad pairing.
  // No `negative`: at cfg 1 the CFGGuider never evaluates the branch.
  "flux2-klein-4b": {
    family: "flux2-klein-4b", kind: "image", modes: ["t2i", "r2i"], dimStep: 16,
    sampling: { steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" },
    sizes: imageSizes([1024, 1328]),
    portedFrom: ["worker/graphs.py::flux2_klein_graph", "worker/graphs.py::flux2_ref_graph"],
    build: buildFlux2,
  },
  "flux2-klein-9b": {
    family: "flux2-klein-9b", kind: "image", modes: ["t2i", "r2i"], dimStep: 16,
    sampling: { steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" },
    sizes: imageSizes([1024, 1328]),
    portedFrom: ["worker/graphs.py::flux2_klein_graph", "worker/graphs.py::flux2_ref_graph"],
    build: buildFlux2,
  },
  acestep: {
    family: "acestep", kind: "audio", modes: ["t2m"], dimStep: 1, sizes: [],
    sampling: { steps: 8, cfg: 1, sampler: "euler", scheduler: "simple" },
    maxSeconds: 240,
    portedFrom: ["worker/graphs.py::acestep_graph"],
    build: buildAceStep,
  },
  "qwen-edit": {
    family: "qwen-edit", kind: "image",
    // The three modes the pod distinguishes, and it MATTERS that they travel:
    // "has references" cannot tell an edit from a compose, which is exactly
    // how an edit once returned a different picture that merely resembled the
    // source.
    modes: ["t2i", "r2i", "edit"], dimStep: 16,
    sampling: { steps: 20, cfg: 2.5, sampler: "euler", scheduler: "simple" },
    sizes: imageSizes([1024, 1328]),
    negative: NEG_IMAGE,
    portedFrom: ["worker/graphs.py::qwen_edit_graph"],
    build: buildQwenEdit,
  },
  sdxl: {
    family: "sdxl", kind: "image", modes: ["t2i"], dimStep: 8,
    sampling: { steps: 30, cfg: 7, sampler: "dpmpp_2m", scheduler: "karras" },
    // Turbo is distilled: sampling it at Base's 30 steps and cfg 7 is both
    // slower AND worse, and it is the variant most people install first.
    perVariant: { "sdxl-turbo": { steps: 4, cfg: 1, sampler: "euler", scheduler: "sgm_uniform" } },
    sizes: imageSizes([768, 1024, 1280]),
    negative: NEG_IMAGE,
    portedFrom: ["ComfyUI's own default graph"],
    build: buildCheckpointImage,
  },
  "minimax-h3": {
    family: "minimax-h3", kind: "video",
    // r2v landed with the reference staging Qwen-Image-Edit needed: the
    // runner uploads a LIST of pictures now, not just a start frame.
    modes: ["t2v", "i2v", "r2v"], dimStep: 32,
    // The pod's own recipe, and the sampler pair the LoRA author calls out as
    // the first thing to check on this model.
    sampling: { steps: 20, cfg: 1, sampler: "res_multistep", scheduler: "simple" },
    sizes: videoSizes([
      ["720p", "720p", 1280, 736], ["480p", "480p", 864, 480], ["small", "small", 608, 352],
    ]),
    // Invariant #5: 17n+5 at 24fps, which is also what the node's own `length`
    // input declares (`min: 5, step: 17`). 15s is the top of the trained range
    // the node's tooltip states; longer is untested rather than illegal.
    fps: 24, frameBase: 17, frameRem: 5, maxSeconds: 15,
    // No `negative`: conditioning goes through BasicGuider, which has no
    // uncond branch.
    portedFrom: ["workflows/minimax_h3_t2v.json", "workflows/minimax_h3_i2v.json"],
    build: buildH3,
  },
  ltx25: {
    family: "ltx25", kind: "video",
    // Every mode the pod's entry declares, plus the two core `LTXVAddGuide`
    // gives for free. `r2v` is offered here and WITHHELD by `localModels` until
    // the MSR pack is installed — the same shape H3's r2v follows for its
    // reference checkpoint, and for the same reason: a mode that resolves to a
    // node ComfyUI does not have is a job that dies after being claimed.
    modes: ["t2v", "i2v", "flf", "r2v"],
    modePacks: { r2v: "ComfyUI-LTX2.5-MSR" },
    // /64 rather than /32, and it is load-bearing: pass 1 samples at HALF size
    // and `LTXVLatentUpsampler` doubles it, so only a multiple of 64 comes back
    // to the size that was asked for without a resize node in the way.
    dimStep: 64,
    // `steps` is INERT — the two `ManualSigmas` schedules are the recipe. It is
    // stated anyway because `Sampling` requires it and because the ETA
    // estimator reads it; 13 is the two passes' sigma count, which is the
    // honest number of model evaluations.
    sampling: { steps: 13, cfg: 1, sampler: "euler_ancestral", scheduler: "simple" },
    sizes: videoSizes([
      ["720p", "720p", 1280, 704], ["480p", "480p", 832, 448], ["small", "small", 640, 384],
    ]),
    // LTX's own grid, not H3's: 8n+1 at 24fps.
    fps: 24, frameBase: 8, frameRem: 1, maxSeconds: 10,
    // No `negative`: `Guider_LTXAVDualCFG` collapses to single-CFG when the two
    // scales match, and the distilled recipe is 1.0/1.0 — so the uncond pass
    // never runs and a negative field could not change the render.
    //
    // ONE ASSUMPTION WORTH KNOWING: LTX 2.5's AV nodes are RECENT core
    // (`comfy_extras/nodes_lt.py`, `nodes_lt_audio.py`, `nodes_lt_upsampler.py`),
    // so an engine installed long enough ago can hold every weight and lack
    // `LTXVEmptyLatentAudio`. There is no gate for that here and there is no
    // precedent for one — `engine_status.nodes` reports custom_nodes only, and
    // H3 makes the same assumption about its own core builders. `install_engine`
    // fetches ComfyUI master, so a fresh install is fine; an ancient one fails
    // at submit naming the class, which is at least loud.
    portedFrom: [
      "workflows/ltx25_t2v.json", "workflows/ltx25_i2v.json",
      "workflows/ltx25_flf.json", "workflows/ltx25_r2v.json",
    ],
    build: buildLtx25,
  },
  "wan21-1.3b": {
    family: "wan21-1.3b", kind: "video", modes: ["t2v"], dimStep: 32,
    sampling: { steps: 20, cfg: 6, sampler: "uni_pc", scheduler: "simple", shift: 8 },
    sizes: videoSizes([["480p", "480p", 832, 480], ["small", "small", 640, 352]]),
    fps: 16, frameBase: 4, frameRem: 1, maxSeconds: 5,
    negative: NEG_VIDEO,
    build: buildWan13b,
  },
  "wan22-5b": {
    family: "wan22-5b", kind: "video", modes: ["t2v", "i2v"], dimStep: 32,
    sampling: { steps: 30, cfg: 5, sampler: "euler", scheduler: "simple", shift: 8 },
    sizes: videoSizes([
      ["720p", "720p", 1280, 704], ["480p", "480p", 832, 480], ["small", "small", 640, 352],
    ]),
    // 24fps and a 4n+1 grid: the 2.2 VAE compresses 4x temporally, so a length
    // off that grid is padded by the node and the tail frames are invented.
    fps: 24, frameBase: 4, frameRem: 1, maxSeconds: 5,
    negative: NEG_VIDEO,
    portedFrom: ["workflows/wan22_5b_t2v.json", "workflows/wan22_5b_i2v.json"],
    build: buildWan5b,
  },
  "wan22-14b": {
    family: "wan22-14b", kind: "video", modes: ["i2v", "t2v"], dimStep: 32,
    sampling: { steps: 20, cfg: 3.5, sampler: "euler", scheduler: "simple", shift: 5 },
    sizes: videoSizes([["720p", "720p", 1280, 720], ["480p", "480p", 832, 480]]),
    fps: 16, frameBase: 4, frameRem: 1, maxSeconds: 5,
    negative: NEG_VIDEO,
    portedFrom: ["workflows/wan22_14b_i2v.json"],
    build: buildWan14b,
  },
};

/** The recipe for a family, or null when this studio has never rendered it
 *  locally. Null is an answer, not a failure — see the header. */
export const localRecipe = (familyId: string): LocalRecipe | null =>
  RECIPES[familyId] ?? null;

/** Why a family has no local recipe, for the picker to say out loud. */
export const NO_RECIPE: Record<string, string> = {
  // NOT A GAP, AND NOT A REFUSAL: MMAudio renders on this machine perfectly
  // well — through the BUNDLED PIPELINE (`v2a_gen` in `plan_cli.KINDS`,
  // `worker/handlers/v2a.py`), which is where it belongs, because its tail is
  // mux the track onto the take, publish a derived take and re-anchor the
  // block, and a second implementation of that in TypeScript is the twin
  // drift this codebase keeps paying for.
  //
  // WHAT THIS ENTRY IS FOR is the composer: `localModelRows` mints a `local:`
  // id per family with a recipe, and MMAudio must not become one — it scores
  // a clip you already have rather than making one from a prompt, so there is
  // no graph for that path to build and nothing for a prompt box to send.
  //
  // READ IT AS "no local GRAPH", NEVER AS "does not run here". This entry
  // said the second thing for one release, and the engine window believed it:
  // `!localRecipe(...)` printed "cannot be rendered on this machine" over a
  // family whose weights were on disk and whose renders were working, in the
  // same sentence that named the two screens that render it. `markFor` is the
  // verdict on a bundled family; this map answers a narrower question.
  mmaudio: "scores a video rather than rendering one — pick it in the Audio & Voice "
    + "studio's Video tab, or from \u201cChange the audio\u2026\u201d on a block",
  // EMPTY, and that is the point: every family the catalogue offers now has a
  // local builder. LTX 2.5 was the last one — its two-pass distilled schedule
  // (sample at half size, latent-upsample, refine) is `buildLtx25` above, and
  // `localModels` withholds only the modes whose NODES are missing rather than
  // the whole family.
  //
  // Keep the map rather than deleting it. `familyGap` and the pickers both
  // read it, and a family added here later needs somewhere to say why — a
  // model with no recipe and no explanation is the "nothing happens when I
  // pick it" this exists to prevent.
};

/** What a family can do on the pod and not here yet. A family with a recipe is
 *  not necessarily a family with EVERY mode — Krea 2 renders text-to-image
 *  locally and cannot compose references, because that path is the one that
 *  genuinely needs `Krea2EditRebalance`. Saying so is the difference between a
 *  known limit and a feature that looks broken. */
export const PARTIAL_RECIPE: Record<string, string> = {
  krea2: "text-to-image only — composing references needs the Krea2EditRebalance node, "
    + "which the local installer does not add",
};

/**
 * Sampling for one render: the recipe, then the variant's override, then any
 * distillation the user picked, then the user's own step count.
 *
 * ORDER MATTERS AND THE USER IS LAST. A LoRA that declares 4 steps must beat
 * the recipe's 30 (otherwise the adapter loads and does nothing), and an
 * explicit step count must beat the LoRA (otherwise the control is a lie).
 */
export function samplingFor(
  recipe: LocalRecipe,
  variantId: string,
  loras: Pick<LoraPick, "sampling">[] = [],
  override: Partial<Sampling> = {},
): Sampling {
  let s: Sampling = { ...recipe.sampling, ...(recipe.perVariant?.[variantId] ?? {}) };
  for (const l of loras) if (l.sampling) s = { ...s, ...l.sampling };
  for (const [k, v] of Object.entries(override)) {
    if (v != null) (s as unknown as Record<string, unknown>)[k] = v;
  }
  return s;
}

/** Round `n` onto this family's frame grid, never below one grid step. */
export function snapFrames(recipe: LocalRecipe, n: number): number {
  const base = recipe.frameBase ?? 1;
  const rem = recipe.frameRem ?? 0;
  const k = Math.max(1, Math.round((n - rem) / base));
  return k * base + rem;
}

export const familyById = (id: string): ModelFamily | undefined =>
  FAMILIES.find((f) => f.id === id);

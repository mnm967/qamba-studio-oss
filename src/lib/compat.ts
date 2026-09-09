// "Could this machine actually run that workflow?" — answered by arithmetic,
// and honest about the one part that is a guess.
//
// THIS IS NOT AN AI FEATURE, and it is worth being clear about where the line
// falls, because two thirds of the question are exact:
//
//   EXACT   which node classes the graph names, and which of them the engine
//           does not have. Both sides are enumerable — `requiredClasses()`
//           reads the graph, `/object_info` reads the engine.
//   EXACT   which weight files the graph names, and which are on disk.
//   MOSTLY  how big those weights are. On disk it is a stat. In the studio's
//           own catalog it is a measured HuggingFace file size. Otherwise it
//           is read off the FILENAME, and only when the filename actually
//           carries the two facts needed (parameter count and precision) —
//           `wan2.2_i2v_high_noise_14B_fp8_scaled` does, `minimax_h3_fl2va_
//           pruned_int8_convrot` does not, and the second returns null rather
//           than a number someone might trust.
//   AI      "the author says this needs sage-attention 2.2 compiled from
//           source", picking a substitute node, or repairing the graph. None
//           of that is here.
//
// THE VRAM MODEL IS max(), NOT sum(), and that is the load-bearing choice.
// ComfyUI loads the text encoder, encodes, frees it, then loads the diffusion
// model — so Wan 2.2 14B fp8 (14GB) beside umt5-xxl fp16 (11.4GB) peaks near
// 14GB, not 25GB, which is exactly why people run it on a 24GB card. Summing
// would tell a 4090 owner their own working setup is impossible. The sum is
// still reported, as the DOWNLOAD, which is what it actually is.
//
// What the estimate deliberately leaves out is activations, because they scale
// with the render size and frame count and this module will not invent a
// coefficient for that. The graph's own declared size is surfaced beside the
// number instead, so the user can see what the estimate is not counting.
import { requiredClasses, requiredFiles, type ApiGraph, type SlotMap } from "./workflowAdapter.ts";
import { FAMILIES, POST_PROCESS } from "./engineCatalog.ts";
import { usableVramMb, type HardwareProfile } from "./desktop.ts";

/** What the target engine and machine have. Every field is optional: a missing
 *  one narrows what can be said, and the report says which question it could
 *  not answer rather than assuming the answer is "fine". */
export interface CompatEnv {
  /** node classes from /object_info */
  classes?: Set<string>;
  /** every model file on disk, by bare filename */
  files?: Set<string>;
  /** size in MB of the files that ARE on disk */
  fileMb?: Record<string, number>;
  hardware?: HardwareProfile | null;
}

export type SizeSource = "disk" | "catalog" | "filename" | "unknown";

export interface WeightNeed {
  name: string;
  /** the loader input that names it — ckpt_name, unet_name, lora_name… */
  input: string;
  class_type: string;
  installed: boolean;
  mb: number | null;
  from: SizeSource;
}

export type Verdict = "ready" | "tight" | "wont_fit" | "downloads" | "nodes" | "unknown";

export interface CompatReport {
  verdict: Verdict;
  headline: string;
  nodes: { total: number; missing: MissingNode[] };
  weights: WeightNeed[];
  /** what is NOT on disk yet, in MB — null when any of it is unsized */
  downloadMb: number | null;
  downloadUnsized: number;
  vram: VramEstimate | null;
  /** the render size the graph itself declares, if it declares one */
  frame: { width?: number; height?: number; length?: number } | null;
}

export interface MissingNode {
  class_type: string;
  /** the pack that provides it, when we happen to know */
  pack?: string;
  url?: string;
}

export interface VramEstimate {
  /** what the machine can be asked for, after the unified-memory discount */
  budgetMb: number;
  /** peak resident weights: the largest single file, not their sum */
  peakMb: number | null;
  unified: boolean;
  gpu: string;
  /** weights whose size nothing could determine */
  unsized: number;
}

/* ── which pack provides which class ────────────────────────────────────── */
//
// Grounded in what this studio actually installs (the engine window's node-pack install)
// plus the handful of packs that turn up in nearly every downloaded graph. It
// is deliberately SHORT and deliberately incomplete: a class that is not here
// is reported as "unknown pack", never guessed at, because sending someone to
// install the wrong repository is worse than telling them to search.

const PACKS: { url: string; name: string; classes: string[] }[] = [
  { name: "ComfyUI-MiniMax-H3-Turbo", url: "https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo",
    classes: ["MiniMaxH3TurboLoRA", "MiniMaxH3TurboSampler"] },
  { name: "ComfyUI-H3-Motion-Context-MultiRef",
    url: "https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef",
    classes: ["MiniMaxH3MotionContext", "MiniMaxH3SaveLatent", "MiniMaxH3LoadLatent"] },
  { name: "ComfyUI-Conditioning-Rebalance",
    url: "https://github.com/nova452/ComfyUI-Conditioning-Rebalance",
    classes: ["Krea2EditRebalance"] },
  { name: "ComfyUI_UltimateSDUpscale", url: "https://github.com/ssitu/ComfyUI_UltimateSDUpscale",
    classes: ["UltimateSDUpscale", "UltimateSDUpscaleNoUpscale"] },
  { name: "comfyui-krea2-controlnet", url: "https://github.com/facok/comfyui-krea2-controlnet",
    classes: ["Krea2ControlNetLoader", "Krea2ControlNetApply", "Krea2DepthEncode"] },
  { name: "ComfyUI-GGUF", url: "https://github.com/city96/ComfyUI-GGUF",
    classes: ["UnetLoaderGGUF", "UnetLoaderGGUFAdvanced", "CLIPLoaderGGUF", "DualCLIPLoaderGGUF"] },
  { name: "ComfyUI-VideoHelperSuite",
    url: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite",
    classes: ["VHS_VideoCombine", "VHS_LoadVideo", "VHS_LoadVideoPath", "VHS_LoadImages",
              "VHS_SplitImages", "VHS_SelectEveryNthImage"] },
  { name: "ComfyUI-KJNodes", url: "https://github.com/kijai/ComfyUI-KJNodes",
    classes: ["SetNode", "GetNode", "ImageResizeKJ", "ColorMatch", "GetImageSizeAndCount",
              "ModelPatchTorchSettings", "PathchSageAttentionKJ", "PatchSageAttentionKJ"] },
  { name: "ComfyUI-Easy-Use", url: "https://github.com/yolain/ComfyUI-Easy-Use",
    classes: ["easy setNode", "easy getNode", "easy seed", "easy cleanGpuUsed",
              "easy imageSize", "easy showAnything"] },
  { name: "rgthree-comfy", url: "https://github.com/rgthree/rgthree-comfy",
    classes: ["Fast Groups Bypasser (rgthree)", "Reroute (rgthree)", "Any Switch (rgthree)",
              "Power Lora Loader (rgthree)", "Node Collector (rgthree)"] },
  { name: "was-node-suite-comfyui", url: "https://github.com/WASasquatch/was-node-suite-comfyui",
    classes: ["Text Multiline", "Image Blank", "Number Counter", "Text Concatenate"] },
  { name: "ComfyUI-Frame-Interpolation",
    url: "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation",
    classes: ["RIFE VFI", "FILM VFI", "GMFSS Fortuna VFI"] },
  { name: "ComfyUI-Impact-Pack", url: "https://github.com/ltdrdata/ComfyUI-Impact-Pack",
    classes: ["FaceDetailer", "UltralyticsDetectorProvider", "SAMLoader", "ImpactSimpleDetectorSEGS"] },
  { name: "ComfyUI-SeedVR2_VideoUpscaler",
    url: "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler",
    classes: ["SeedVR2", "SeedVR2VideoUpscaler"] },
  { name: "ComfyUI-Manager (or the author's own pack)",
    url: "https://github.com/Comfy-Org/ComfyUI-Manager",
    classes: [] },
];

const PACK_BY_CLASS = new Map<string, { name: string; url: string }>();
for (const p of PACKS) for (const c of p.classes) PACK_BY_CLASS.set(c, { name: p.name, url: p.url });

/** The pack that provides a class, if this table happens to know it. */
export const packFor = (cls: string) => PACK_BY_CLASS.get(cls);

/* ── how big is that file ───────────────────────────────────────────────── */

/** Every filename the engine catalog knows, with its measured size. */
const CATALOG_MB: Record<string, number> = {};
for (const f of FAMILIES.flatMap((fam) => [
  ...fam.shared,
  ...fam.variants.flatMap((v) => v.files),
  ...(fam.addons ?? []).flatMap((a) => a.files),
])) CATALOG_MB[f.filename] = f.size_mb;
for (const t of POST_PROCESS) for (const f of t.files) CATALOG_MB[f.filename] = f.size_mb;

// EVERY PATTERN BELOW RUNS AGAINST A NORMALISED NAME, and that is not
// cosmetic: `\b` does not fire around an UNDERSCORE — `_` is a word character
// — so `\bfp8\b` never matched `wan2.2_..._14B_fp8_scaled.safetensors`, which
// is the spelling essentially every real checkpoint uses. The symptom was the
// worst kind: not a wrong number but a silent "unknown size" on the exact
// files this is for, while `-Q4_K_M.gguf` matched and made it look like the
// table worked. Underscores become dashes first, so the boundaries are real.
const norm = (name: string) => name.toLowerCase().replace(/_/g, "-");

/** bytes per weight, by the precision token in a filename. */
const PRECISION: [RegExp, number][] = [
  [/\b(fp32|float32)\b/, 4],
  [/\b(fp16|bf16|float16)\b/, 2],
  [/\b(fp8|e4m3fn|e4m3|e5m2|int8)\b/, 1],
  [/\b(nf4|int4|fp4)\b/, 0.5],
];

/** bits per weight for the GGUF quant tags, from llama.cpp's own table.
 *  Longest first — `q3-k-l` must not be eaten by the `q3-k` pattern. */
const GGUF: [RegExp, number][] = [
  [/\bq2-k\b/, 2.6], [/\bq3-k-s\b/, 3.0], [/\bq3-k-l\b/, 3.7], [/\bq3-k(-m)?\b/, 3.4],
  [/\bq4-0\b/, 4.5], [/\bq4-1\b/, 5.0], [/\bq4-k-s\b/, 4.6], [/\bq4-k(-m)?\b/, 4.8],
  [/\bq5-0\b/, 5.5], [/\bq5-1\b/, 6.0], [/\bq5-k-s\b/, 5.5], [/\bq5-k(-m)?\b/, 5.7],
  [/\bq6-k\b/, 6.6], [/\bq8-0\b/, 8.5],
];

/**
 * Read a weight's size off its own filename — ONLY when the filename carries
 * both facts. Returns null otherwise, which is the point: a family-name
 * lookup table ("anything called umt5-xxl is 11.4GB") is the kind of invented
 * knowledge that goes stale silently, and a wrong number here becomes a
 * confident "your machine can't run this".
 */
export function sizeFromFilename(name: string): number | null {
  const s = norm(name);
  // "14b", "a14b" (the active half of a MoE — still the file's own size),
  // "5b", "1.3b", "2.9b", "0.6b". Not "2509" and not "4step".
  const m = /(?:^|[^0-9a-z])a?(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/.exec(s);
  if (!m) return null;
  const params = parseFloat(m[1]) * 1e9;
  if (!isFinite(params) || params <= 0) return null;

  for (const [re, bits] of GGUF) if (re.test(s)) return Math.round(params * bits / 8 / 1e6);
  for (const [re, bytes] of PRECISION) if (re.test(s)) return Math.round(params * bytes / 1e6);
  return null;                      // params but no precision — do not guess
}

function sizeOf(name: string, env: CompatEnv): { mb: number | null; from: SizeSource } {
  const base = name.split(/[\\/]/).pop() ?? name;
  const disk = env.fileMb?.[base] ?? env.fileMb?.[name];
  if (disk) return { mb: disk, from: "disk" };
  if (CATALOG_MB[base]) return { mb: CATALOG_MB[base], from: "catalog" };
  const guess = sizeFromFilename(base);
  return guess ? { mb: guess, from: "filename" } : { mb: null, from: "unknown" };
}

/* ── the report ─────────────────────────────────────────────────────────── */

const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`);

/** Fewer classes than this and the `/object_info` response is not believable
 *  as a whole engine. Core ComfyUI alone is well past 300. */
export const MIN_PLAUSIBLE_CLASSES = 50;

/**
 * Compare one graph against one machine.
 *
 * Pure, and every unknown is reported as an unknown — an absent `classes` set
 * means "nothing checked the node list", not "the nodes are fine".
 */
export function analyseGraph(api: ApiGraph, env: CompatEnv, slots?: SlotMap): CompatReport {
  const classes = requiredClasses(api);
  // A REAL ComfyUI declares hundreds of classes — the one this repo installed
  // reports 851. A handful means the response was truncated, or the caller
  // handed over a stub, and trusting it produces the most discrediting output
  // this panel can make: "CLIPTextEncode is not installed". Below the floor
  // the node list is treated as unchecked, which is what it is.
  const trusted = (env.classes?.size ?? 0) >= MIN_PLAUSIBLE_CLASSES;
  const missing: MissingNode[] = trusted
    ? classes.filter((c) => !env.classes!.has(c))
             .map((c) => ({ class_type: c, ...(packFor(c) ?? {}) }))
             .map(({ class_type, name, url }: { class_type: string; name?: string; url?: string }) =>
               ({ class_type, pack: name, url }))
    : [];

  // One FILE may be named by several nodes (a LoRA stack, a VAE shared between
  // two decoders); it is one download and one allocation, so it is deduped
  // before anything is added up.
  const seen = new Set<string>();
  const weights: WeightNeed[] = [];
  for (const f of requiredFiles(api)) {
    const base = f.value.split(/[\\/]/).pop() ?? f.value;
    if (seen.has(base)) continue;
    seen.add(base);
    const installed = !!env.files && (env.files.has(f.value) || env.files.has(base));
    const { mb, from } = sizeOf(f.value, env);
    weights.push({ name: base, input: f.input, class_type: f.class_type, installed, mb, from });
  }

  // With no file list there is nothing to compare against, so NOTHING is
  // absent — "we did not look" must never render as "you are missing all of
  // them", which is what an unguarded `!w.installed` did.
  const absent = env.files ? weights.filter((w) => !w.installed) : [];
  const absentSized = absent.filter((w) => w.mb != null);
  const downloadMb = absentSized.reduce((s, w) => s + (w.mb ?? 0), 0);
  const downloadUnsized = absent.length - absentSized.length;

  const gpu = env.hardware?.gpus?.[0];
  const rawMb = usableVramMb(env.hardware ?? null);
  // The unified-memory discount is the same 60% the first-run recommender
  // uses: the OS needs its share of a Mac's single pool.
  const budgetMb = gpu?.unified ? Math.round(rawMb * 0.6) : rawMb;
  const sized = weights.filter((w) => w.mb != null);
  const peakMb = sized.length ? Math.max(...sized.map((w) => w.mb!)) : null;
  const vram: VramEstimate | null = rawMb > 0 && gpu
    ? { budgetMb, peakMb, unified: !!gpu.unified, gpu: gpu.name,
        unsized: weights.length - sized.length }
    : null;

  // `slots.size` names the INPUTS, not their values — read the numbers out of
  // the graph itself. This is advisory: activations scale with them and the
  // peak above does not count activations, so the figure is shown rather than
  // folded into an estimate it would make up.
  const sizeNode = slots?.size ? api[slots.size.node]?.inputs : undefined;
  const at = (k?: string) => {
    const v = k && sizeNode ? sizeNode[k] : undefined;
    return typeof v === "number" ? v : undefined;
  };
  const frame = slots?.size
    ? { width: at(slots.size.width), height: at(slots.size.height), length: at(slots.size.length) }
    : null;

  // WHAT WAS ACTUALLY COMPARED, tracked separately from what was found. An
  // absent `classes` set is "nobody looked at the node list", and the first
  // version of this let that fall through to "runs here" on a graph naming
  // three packs the installer does not clone — a green tick earned by not
  // checking, which is the precise failure this module exists to avoid.
  const nodesChecked = trusted;
  const filesChecked = !!env.files;
  const overBudget = vram && peakMb != null && peakMb > budgetMb;
  const tooBig = vram && peakMb != null && peakMb > budgetMb * 1.25;

  // Order matters: a missing node pack is a harder stop than a download, and a
  // download is a harder stop than a tight fit. Report the first wall — but a
  // weight that will not fit once downloaded is said in the same breath,
  // because finding that out after a 13GB fetch is the worst possible moment.
  let verdict: Verdict = "unknown";
  let headline = "Nothing checked this graph — connect a local engine to compare it against one.";
  if (missing.length) {
    verdict = "nodes";
    headline = `${missing.length} node ${missing.length === 1 ? "class is" : "classes are"} `
      + "missing — the render fails immediately without the pack that provides "
      + (missing.length === 1 ? "it." : "them.");
  } else if (absent.length) {
    verdict = "downloads";
    headline = `${absent.length} weight ${absent.length === 1 ? "file is" : "files are"} not on `
      + `disk${downloadMb ? ` — about ${gb(downloadMb)} to fetch` : ""}`
      + (downloadUnsized ? `, plus ${downloadUnsized} of unknown size.` : ".")
      + (overBudget ? ` Its largest weight is ${gb(peakMb!)} against a ${gb(budgetMb)} budget, `
          + "so it would not fit once fetched." : "");
  } else if (tooBig) {
    verdict = "wont_fit";
    headline = `Its largest weight is ${gb(peakMb!)} against a ${gb(budgetMb)} budget — `
      + "this will swap rather than render.";
  } else if (overBudget) {
    verdict = "tight";
    headline = `Installed, but its largest weight (${gb(peakMb!)}) is over the ${gb(budgetMb)} `
      + "budget — expect offloading and a slow render.";
  } else if (nodesChecked && filesChecked) {
    verdict = "ready";
    headline = peakMb != null
      ? "Everything this graph names is installed, and its largest weight fits."
      : "Everything this graph names is installed.";
  } else if (nodesChecked || filesChecked) {
    // Half an answer, labelled as half an answer.
    verdict = "unknown";
    headline = nodesChecked
      ? `All ${classes.length} node classes are installed, but nothing checked the weight `
        + "files — start the engine to compare them."
      : "Every weight this graph names is on disk, but nothing checked its NODE list — "
        + "start the engine, or this could still fail on a missing pack.";
  }

  return { verdict, headline, nodes: { total: classes.length, missing },
           weights, downloadMb: downloadUnsized ? null : downloadMb, downloadUnsized,
           vram, frame };
}

/**
 * Ask the machine about itself, for `analyseGraph`'s second argument.
 *
 * PRESENCE comes from `/object_info` and SIZES from our own engine, and they
 * are two different questions on purpose. A user may have linked a ComfyUI
 * they already ran, in which case our engine directory is empty while theirs
 * is full — `/object_info` is the only thing that knows what the engine
 * actually answering on :8188 can load. `engine_status` can then only size the
 * files WE installed, which is fine: an unsized file falls through to the
 * catalog and then to the filename, and says which it used.
 */
export async function compatEnv(objectInfo?: Record<string, unknown> | null): Promise<CompatEnv> {
  const [{ detectHardware, engineStatus, isDesktop }, { filesFromObjectInfo }] = await Promise.all([
    import("./desktop.ts"), import("./comfyLocal.ts"),
  ]);
  if (!isDesktop()) return {};

  const [hardware, status] = await Promise.all([
    detectHardware().catch(() => null),
    engineStatus().catch(() => null),
  ]);

  let files: Set<string> | undefined;
  if (objectInfo) {
    const pools = filesFromObjectInfo(objectInfo as Parameters<typeof filesFromObjectInfo>[0]);
    files = new Set(Object.values(pools).flatMap((p) => [...p]));
  } else if (status?.files?.length) {
    files = new Set(status.files);
  }

  return { files, fileMb: status?.file_mb, hardware,
           classes: objectInfo ? new Set(Object.keys(objectInfo)) : undefined };
}

export const VERDICT_COLOR: Record<Verdict, string> = {
  ready: "#6fd08c", tight: "#e8a13a", wont_fit: "#e8734a",
  downloads: "#e8a13a", nodes: "#e8734a", unknown: "#5e6678",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  ready: "runs here", tight: "tight fit", wont_fit: "too big",
  downloads: "needs weights", nodes: "needs nodes", unknown: "not checked",
};

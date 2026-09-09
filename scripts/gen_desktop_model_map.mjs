#!/usr/bin/env node
// Generate the DESKTOP tier of model_map from the pod's, keeping only what
// this machine could actually be given.
//
// WHY GENERATED RATHER THAN HAND-WRITTEN. `resolve.py` is the pod's, and every
// filename, workflow template, frame grid, sampler and dim_step in it lives in
// `infra/model_map.full.json`. A second map maintained by hand would drift the
// day someone changed a checkpoint over there — and the drift is SILENT: the
// desktop would resolve a graph naming a file the engine catalog no longer
// downloads, and the job would die inside ComfyUI on an enum error about a
// `unet_name`. Same shape and same reason as `gen_local_schema.mjs`, which
// derives the local plane's column defaults from the migrations.
//
// WHAT DECIDES WHETHER AN ENTRY SURVIVES is `src/lib/engineCatalog.ts`: the
// set of files the engine window can put on disk. An entry every one of whose
// files is in that set is emitted; anything else is dropped WITH A REASON,
// printed and recorded in the file, because "the desktop cannot render H3"
// and "the desktop is one 32GB checkpoint short of rendering H3" are different
// facts and only one of them is worth acting on.
//
//   node scripts/gen_desktop_model_map.mjs            # write + report
//   node scripts/gen_desktop_model_map.mjs --check    # report only, exit 1 on drift
import { existsSync, readFileSync, writeFileSync } from "node:fs";
// The catalog is ALSO read as text below (`catalogFiles`) — that scan wants
// every filename regardless of shape and predates type stripping. This import
// is for the part that needs STRUCTURE: which variants are one checkpoint at
// different precisions, which is a relation a regex cannot see.
import { FAMILIES } from "../src/lib/engineCatalog.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "infra", "model_map.full.json");
const OUT = path.join(ROOT, "infra", "model_map.desktop.json");
const CATALOG = path.join(ROOT, "src", "lib", "engineCatalog.ts");
const WORKFLOWS = path.join(ROOT, "workflows");

/**
 * Files the desktop deliberately gets in a DIFFERENT form from the pod.
 *
 * One entry, and it is a hardware decision rather than an oversight: the pod
 * deleted its fp8 umt5 because `model_map` declares the fp16 (11.4GB), and the
 * engine catalog offers the fp8 (6.4GB) because these are laptops. `resolve()`
 * rewrites every `CLIPLoader`'s `clip_name` from the map, so naming the fp8
 * here is all it takes — and putting it HERE rather than in the catalog keeps
 * the pod's own map saying what the pod actually has.
 */
const SUBSTITUTE = {
  "umt5_xxl_fp16.safetensors": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",

  // MiniMax H3, from the 2026-09-01 tier benchmark. The pod loads the UNPRUNED
  // checkpoints beside a 25.9GB int8 text encoder; on a laptop that pairing
  // needs a 16GB card and ~59GB of RAM. Comfy-Org publishes a PRUNED pair (the
  // timestep embedder replaced by a lookup table — same weights, 932 tensors
  // against 1035) and an nvfp4 encoder, and that set rendered the same clip
  // inside a driver-enforced 8GB with ~48GB of RAM. No measured quality
  // difference; 24GB less to download.
  //
  // THIS HAS TO MOVE WITH THE CATALOG OR THE WIZARD LIES. `engineCatalog`'s
  // recommended H3 rung is the pruned pair, so without these three lines the
  // engine window downloads files `resolve()` never names and every H3 render
  // dies on `ensure_model` naming a checkpoint nobody was offered.
  "minimax_h3_fl2va_int8_convrot.safetensors":
    "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  "minimax_h3_ref2va_int8_convrot.safetensors":
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  "qwen3vl_32b_minimax_h3_int8_convrot.safetensors":
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",

  // THE SAME FILE UNDER TWO NAMES, not a swap. the engine window's model list's
  // `h3_lightx2v` downloads Kijai's `..._fl2v_lightx2v_turbo_4step_v0.1_comfy`
  // and saves it as `..._lightx2v_turbo_4step_v01`; the catalog keeps the
  // upstream name. Without this line `minimax-h3-lightx2v` is dropped for a
  // missing file that is sitting on the disk under its own name — and with it,
  // a desktop renders H3 in 4 steps instead of 20.
  "minimax_h3_lightx2v_turbo_4step_v01.safetensors":
    "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors",

  // THE SAME FILE UNDER TWO NAMES AGAIN — hyphens against underscores, and it
  // cost the whole KREA 2 ENTRY. the engine window's model list saves the abliterated
  // encoder from Civitai as `qwen3vl-4b-abliterated_bf16` under a `Qwen3VL4B/`
  // nesting; the catalog names the identical object
  // `qwen3vl_4b_abliterated_bf16` (its own comment says so: "this is the file
  // the pod itself loads"). FLATTEN strips the directory and the basenames
  // still differ, so `krea2` was dropped for a file that is downloadable and
  // sitting on the disk.
  //
  // WHAT THAT DROP COST is the FACE DETAILER: `_image_model` re-samples every
  // detected face through `image_models["krea2"]`, so with the entry gone the
  // pass could not run here at all however many node packs were installed.
  "qwen3vl-4b-abliterated_bf16.safetensors":
    "qwen3vl_4b_abliterated_bf16.safetensors",
};

/**
 * Keys stripped from every surviving entry, and why.
 *
 * Each names a CUSTOM NODE the engine installer does not provide, so leaving
 * it in would produce a graph ComfyUI rejects — after the job is claimed and
 * the model loaded. `install_engine` adds exactly one pack (ComfyUI-GGUF), and
 * a desktop build has no `install_custom_nodes.sh`.
 */
const STRIP_KEYS = {
  refine: "NeonH3RefineLatent — a vendored pack the desktop installer does not add",
  latent_upscale: "MinimaxH3LatentUpscaler3D — LBH-123-AI's pack, which the desktop installer does not add",
  turbo_lora: "MiniMaxH3TurboLoRA/Sampler — larryvrh's pack, not installed here "
    + "(kept when `turbo_apply` is `plain`, which needs no pack)",
  turbo_apply: "goes with turbo_lora",
  turbo_steps: "goes with turbo_lora",
  auto_download: "there is no `fetchmodel` on a desktop; the engine window is the downloader",
  // `pdd` is NOT stripped either, for the same reason and since the same
  // commit: `install_engine` clones the PDD pack now, so `needsAPack` has
  // already dropped the entry if that pack is absent, and what survives here
  // is a recipe the machine can run. Stripping it would be the worse half of
  // the two — the entry would keep `steps: 8` and lose the distillation, which
  // is eight steps of an UNDISTILLED model: the exact failure `keepAnyway`
  // exists to prevent one key over.
  // `extra_nodes` is NOT stripped, and it used to be, with the reason "nothing
  // here can clone a node pack" — true until `install_engine` grew NODE_PACKS.
  // Now that it clones two, `needsAPack` has already dropped any entry naming a
  // pack the installer does NOT provide, so whatever survives here is a pack
  // that IS on the machine. Keeping the list is what lets `ensure_model` catch
  // an engine installed before that step and say which pack is missing —
  // instead of building an r2v graph whose guide node ComfyUI has never heard
  // of and failing after the job is claimed and the model loaded.
};

/**
 * The one exemption to STRIP_KEYS, and it closes a trap the two rules had
 * between them.
 *
 * `needsAPack` deliberately KEEPS an entry whose `turbo_apply` is `"plain"` —
 * lightx2v's distillation is an ordinary `LoraLoaderModelOnly` and needs no
 * node pack, which is the whole reason that key exists. The strip then deleted
 * its adapter anyway while leaving `steps: 4` and `sampler: er_sde` behind:
 * four steps of an UNDISTILLED model, which renders mush and says nothing.
 * That is exactly the failure `needsAPack`'s own comment argues against,
 * arriving through the other door.
 *
 * Nothing hit it until now only because the adapter's file was missing from the
 * catalog under the pod's name; the SUBSTITUTE above fixes that, so this has to
 * land in the same commit.
 */
const TURBO_KEYS = new Set(["turbo_lora", "turbo_apply", "turbo_steps"]);
const keepAnyway = (m, k) => TURBO_KEYS.has(k) && m.turbo_apply === "plain";

/**
 * The custom node packs `install_engine` puts on a desktop, by DIRECTORY —
 * which is the name `engine_status.nodes` reports and the name
 * `LocalRecipe.modePacks` gates on.
 *
 * THIS LIST AND `src-tauri/src/engine.rs`'s `NODE_PACKS` MUST AGREE, and the
 * failure is one-directional and silent: a pack listed here that the installer
 * does not add produces a desktop entry whose graph names a class ComfyUI has
 * never heard of — a job that queues, is claimed, loads a model, and dies. A
 * pack the installer adds and this omits merely drops a capability nobody is
 * offered. `desktopModelMap.test.ts` parses the Rust and fails on either.
 *
 * `extra_nodes` carries repo URLs, so the comparison is on the last path
 * segment — the same reduction `resolve.ensure_model` makes when it looks for
 * `custom_nodes/<basename>`.
 */
const DESKTOP_PACKS = new Set([
  "ComfyUI-GGUF", "ComfyUI-LTX2.5-MSR",
  // video → audio: the MMAudio nodes and the VideoHelperSuite loader that
  // feeds them a clip's frames. Both are added by `install_engine` step 4.
  "ComfyUI-MMAudio", "ComfyUI-VideoHelperSuite",
  // MiniMax's official 8-step distillation. Its Apply node is what makes
  // `minimax-h3-pdd` expressible here at all — see `needsAPack`.
  "ComfyUI-MiniMax-H3-PDD-Acc",
]);
const packDir = (url) => String(url).split("/").pop().replace(/\.git$/, "");
/** The pack `pdd` needs. Named once so `needsAPack` and `DESKTOP_PACKS` cannot
 *  disagree about its spelling — a typo there would silently drop the entry. */
const PDD_PACK = "ComfyUI-MiniMax-H3-PDD-Acc";

/**
 * An entry that would emit a CUSTOM NODE class through `resolve()` even though
 * every one of its own files is present.
 *
 * Dropped whole rather than stripped, and that is the important half: a turbo
 * row minus its distillation is plain H3 wearing a faster name and a shorter
 * step count — it would render, badly, and nothing would say why. `turbo_apply
 * === "plain"` is the one distillation applied by an ordinary
 * `LoraLoaderModelOnly`, so it needs no pack; everything else here does.
 */
function needsAPack(m) {
  if (m.turbo_lora && m.turbo_apply !== "plain") {
    return "its step distillation is applied through larryvrh's node pack, "
      + "which the desktop installer does not add";
  }
  // PDD used to be refused outright here. It is a PACK CHECK now, like every
  // other one: the installer clones `ComfyUI-MiniMax-H3-PDD-Acc`, so the entry
  // survives — and if that pack is ever dropped from `NODE_PACKS`, this drops
  // the entry whole rather than letting it through as eight steps of an
  // undistilled model.
  if (m.pdd && !DESKTOP_PACKS.has(PDD_PACK)) {
    return `its distillation is applied through ${PDD_PACK}, which the desktop `
      + "installer does not add";
  }
  const absent = (m.extra_nodes ?? []).filter((u) => !DESKTOP_PACKS.has(packDir(u)));
  if (absent.length) {
    return `it needs node pack(s) the desktop installer does not add: ${absent.join(", ")}`;
  }
  return null;
}

/* ── what the engine window can put on disk ─────────────────────────────── */

/**
 * Entries that exist ONLY on the desktop, derived from one that survived.
 *
 * WHY DERIVED RATHER THAN WRITTEN. A quantised H3 differs from the pruned one
 * in exactly two things — the checkpoint per mode and the workflow that loads
 * it — and in nothing else: same 17n+5 grid, same fps, same `dim_step`, same
 * encoder, same VAEs, same adapter table. Hand-writing three of them is three
 * chances to mistype a frame grid, and a wrong grid dies deep inside the
 * sampler. Copying `minimax-h3` and swapping two keys cannot.
 *
 * WHY NOT IN `model_map.full.json`. The pod has a 96GB card and no reason to
 * quantise, and it does not hold these files — an entry there would make
 * `ensure_model` try to `fetchmodel` a GGUF the pod was never given a target
 * for. This is a fact about laptops, so it lives on the laptop tier, the same
 * way `SUBSTITUTE` keeps the pod's own map saying what the pod actually has.
 *
 * `gguf: true` is deliberately NOT set. On the pod that flag means "look in
 * `models/unet`"; the engine window writes every GGUF to `models/diffusion_
 * models` (`engineCatalog`'s `gguf()` helper), which is also the only place
 * `engine_status` scans. The LOADER comes from the workflow, not the flag.
 */
const DESKTOP_ONLY = [
  { key: "minimax-h3-q5", from: "minimax-h3", suffix: "Q5_K_M" },
  { key: "minimax-h3-q4", from: "minimax-h3", suffix: "Q4_K_M" },
  { key: "minimax-h3-q3", from: "minimax-h3", suffix: "Q3_K_M" },
];

/** fl2va for every mode but r2v, which is a separate checkpoint entirely. */
const ggufCheckpoint = (mode, suffix) =>
  `MiniMax-H3-${mode === "r2v" ? "Ref2VA" : "FL2VA"}-${suffix}.gguf`;

function derived(desktopModels, have) {
  const out = {};
  for (const { key, from, suffix } of DESKTOP_ONLY) {
    const base = desktopModels[from];
    if (!base) continue;                       // the parent was dropped
    const m = JSON.parse(JSON.stringify(base));
    // These entries EXIST to pin one rung, so they must not carry the base's
    // rung table — and it would be keyed on the base's own filenames, which
    // the loop below is about to replace, so it would be silently inert as
    // well as wrong.
    delete m._rungs;
    m.modes = {};
    let ok = true;
    for (const [mode, spec] of Object.entries(base.modes ?? {})) {
      const ckpt = ggufCheckpoint(mode, suffix);
      const wf = `minimax_h3_${mode}_gguf.json`;
      // Same bar as every other entry: a file the engine window cannot supply,
      // or a template that is not on disk, drops the mode rather than emitting
      // a graph that fails at execution.
      if (!have.has(ckpt) || !existsSync(path.join(WORKFLOWS, wf))) { ok = false; break; }
      m.modes[mode] = { ...spec, checkpoint: ckpt, workflow: wf };
    }
    if (ok && Object.keys(m.modes).length) out[key] = m;
  }
  return out;
}

function catalogFiles() {
  const src = readFileSync(CATALOG, "utf8").replace(/\r\n/g, "\n");
  const have = new Map();                       // filename -> dir
  for (const m of src.matchAll(/filename:\s*"([^"]+)"\s*,\s*dir:\s*"([^"]+)"/g)) {
    have.set(m[1], m[2]);
  }
  // The `gguf(url, name, mb)` helper fills in `dir: "unet"` itself.
  for (const m of src.matchAll(/gguf\(`[^`]*`,\s*"([^"]+)"/g)) have.set(m[1], "unet");
  if (have.size < 40) {
    throw new Error(`the catalog scanner found only ${have.size} files — it is broken`);
  }
  return have;
}

/**
 * Every weight file an entry names, at any depth.
 *
 * DELIBERATELY NOT A MIRROR OF `resolve.ensure_model`. That function walks a
 * fixed list of keys — checkpoint/high/low, vae, audio_vae, lora, style_lora,
 * latent_upscaler, msr_lora, text_encoders — and it MISSES some: `turbo_lora`
 * is not on it, which is a pod bug too (a distillation whose file was never
 * fetched resolves into a graph naming a LoRA that is not there, and ComfyUI
 * rejects the prompt on an enum). Mirroring that list here would import the
 * same blind spot into the thing whose whole job is to answer "can this
 * machine have every file".
 *
 * So: any string ANYWHERE in the entry that looks like a weight file counts.
 * `style_loras` is excluded because it is pruned separately — those are
 * optional picks, and an entry is not unrenderable for lacking one.
 */
const WEIGHT = /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i;

function requiredFiles(m) {
  const out = [];
  const walk = (v, key) => {
    if (key === "style_loras") return;
    if (typeof v === "string") { if (WEIGHT.test(v)) out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(m, null);
  return [...new Set(out)];
}

/**
 * Weight files a mode's TEMPLATE names that the entry itself does not.
 *
 * THE ENTRY IS NOT THE WHOLE STORY, and this is the trap that made the check
 * worth writing. `resolve()` rewrites `unet_name`, `clip_name` and `vae_name`
 * from the map — so those are covered by the entry — but it only rewrites a
 * `lora_name` on a `STYLE` PLACEHOLDER. `wan22_14b_i2v_fp8.json` has the
 * lightx2v 4-step adapter baked straight into a `LoraLoaderModelOnly`, and
 * that filename reaches ComfyUI untouched. An entry judged on its own keys
 * alone would be emitted as renderable and then rejected on an enum naming a
 * LoRA nobody chose.
 *
 * Subtracting the entry's OWN names (pre-rename, since that is what the
 * template holds) leaves exactly the extras.
 */
function templateExtras(m, own) {
  const out = new Set();
  for (const spec of Object.values(m.modes ?? {})) {
    const wf = spec.workflow;
    if (!wf) continue;
    let g;
    try { g = JSON.parse(readFileSync(path.join(WORKFLOWS, wf), "utf8")); }
    catch { out.add(`(missing template ${wf})`); continue; }
    for (const node of Object.values(g)) {
      for (const v of Object.values(node?.inputs ?? {})) {
        // `resolve()` REWRITES a `lora_name` containing STYLE — that is what
        // makes a `*_style.json` template a placeholder rather than a
        // requirement — and `RESOLVE_*` marks the same thing on a checkpoint.
        // Counting either would drop an entry for a file that never reaches
        // ComfyUI, and worse, would put a made-up filename in the reason.
        if (typeof v !== "string" || !WEIGHT.test(v) || own.has(v)) continue;
        if (v.includes("STYLE") || v.startsWith("RESOLVE_")) continue;
        out.add(v);
      }
    }
  }
  return [...out];
}

/**
 * What this machine would call one of the pod's files, or the name unchanged.
 *
 * Two rewrites, both mechanical:
 *
 *  SUBSTITUTE   a deliberate precision swap (see above).
 *  FLATTEN      the pod files some models under a subdirectory
 *               (`Krea2/krea2_turbo_fp8_scaled.safetensors`) and the engine
 *               window writes every file straight into its `dir`. Same file,
 *               different shelf — and `resolve()` writes whatever this map
 *               says into the loader, so the name has to be the one on THIS
 *               disk. Only applied when the catalog really has the basename,
 *               so it can never invent a path.
 */
function desktopName(fn, have) {
  const sub = SUBSTITUTE[fn] ?? fn;
  if (have.has(sub)) return sub;
  const base = sub.split("/").pop();
  if (have.has(base)) return base;
  // THE TWO REWRITES COMPOSE, and until they did, one file needed both and got
  // neither: the abliterated Krea 2 encoder is nested AND named differently
  // (`Qwen3VL4B/qwen3vl-4b-abliterated_bf16` against the catalog's
  // `qwen3vl_4b_abliterated_bf16`), so a SUBSTITUTE keyed on the basename
  // never matched the full path and the flatten alone never fixed the name.
  // Additive: every existing key is a bare basename, which this branch is only
  // reached for when the flatten has already failed.
  const subBase = SUBSTITUTE[base];
  return subBase && have.has(subBase) ? subBase : sub;
}

/** Rewrite every weight filename in an entry to its desktop name. */
function rename(m, have) {
  const walk = (v) => {
    if (typeof v === "string") return WEIGHT.test(v) ? desktopName(v, have) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) =>
        // `style_loras` is pruned rather than rewritten — see `pruneLoras`.
        [k, k === "style_loras" ? x : walk(x)]));
    }
    return v;
  };
  return walk(JSON.parse(JSON.stringify(m)));
}

/* ── the adapters ───────────────────────────────────────────────────────── */

/**
 * Prune `style_loras` to the adapters this machine can actually load.
 *
 * NOT COSMETIC. `_block_loras` appends `combat` to every FIGHT block when the
 * model declares it, and `resolve.lora_stack` RAISES on a picked-but-missing
 * file — deliberately, because a render that quietly ignores a pick is the
 * silent downgrade this repo keeps being bitten by. So an entry that kept the
 * pod's adapter table would fail every fight block on a machine that has none
 * of the files. Pruned, `_block_loras`' own lookup answers "this model does
 * not declare combat" and the block renders without it, which is the correct
 * degradation and is visible in `master_pass`'s adapter log line.
 */
function pruneLoras(m, have, dropped) {
  const table = m.style_loras;
  if (!table) return m;
  const kept = {};
  for (const [key, val] of Object.entries(table)) {
    const files = (Array.isArray(val) ? val : [val])
      .map((v) => (typeof v === "string" ? v : v.file));
    if (files.every((f) => have.has(f))) kept[key] = val;
    else dropped.push(key);
  }
  if (Object.keys(kept).length) {
    m.style_loras = kept;
    // BOTH side tables follow the pruning, not just the triggers. Until an
    // adapter survived the prune this was invisible: with `style_loras` deleted
    // whole, its companions went with it. Keeping a `lora_defaults` entry for a
    // key the entry no longer declares is inert today — `lora_stack` drops the
    // key before it ever consults a default — and it is a map that describes a
    // strength for an adapter this machine cannot load, which is exactly the
    // kind of statement someone later reads as a promise.
    for (const side of ["lora_triggers", "lora_defaults"]) {
      if (!m[side]) continue;
      m[side] = Object.fromEntries(
        Object.entries(m[side]).filter(([k]) => k in kept));
      if (!Object.keys(m[side]).length) delete m[side];
    }
  } else {
    delete m.style_loras;
    delete m.lora_triggers;
    delete m.lora_defaults;
  }
  return m;
}

/* ── the rungs ──────────────────────────────────────────────────────────── */

/**
 * The OTHER precision rungs of whatever checkpoint an entry names.
 *
 * THE PROBLEM. A model_map entry names ONE file per role, and `engineCatalog`
 * offers up to five of the same weights at different precisions. So a machine
 * that downloaded Klein 4B at Q4_K_M did not satisfy an entry naming the fp8 —
 * `desktop_render_models` reported a file missing, the picker left the row on
 * the studio's tier, and the honest-looking answer ("download it") pointed at
 * 3.9GB of a model already on the disk. Measured across the twelve desktop
 * entries: each ignores one to five rungs.
 *
 * WHAT THIS EMITS is a rename map per alternative rung, in catalog order
 * (best first). `resolve.load_map()` and `desktop_render_models` each apply
 * the FIRST whose files are all present, so readiness and the render agree by
 * construction rather than by two implementations agreeing.
 *
 * THE UNIT IS THE VARIANT, NOT THE FILE. H3's rungs are an fl2va checkpoint
 * plus their own text encoder plus a ref2va, and Wan 14B's are a high/low
 * pair — swap one file of a set and you get the crossed pairing the PDD note
 * already records as "applies cleanly and renders silently wrong". So a rung
 * is offered only when its file list lines up with the declared one position
 * for position AND shelf for shelf; anything else is REPORTED, never guessed.
 *
 * ONLY LADDERS. `ModelFamily.swappable` is the opt-in, and its own note says
 * why three families are absent from it.
 */
function fileOwners() {
  const out = new Map();                    // filename -> [{fam, v}, ...]
  for (const fam of FAMILIES) {
    if (!fam.swappable?.length) continue;
    for (const v of fam.variants) {
      if (!fam.swappable.includes(v.id)) continue;
      for (const f of [...v.files, ...(v.refCheckpoint ? [v.refCheckpoint] : [])]) {
        if (!out.has(f.filename)) out.set(f.filename, []);
        out.get(f.filename).push({ fam, v });
      }
    }
  }
  return out;
}

/**
 * The model_map families whose builder picks its LOADER off the filename.
 *
 * A RUNG SWAP MUST NOT CHANGE THE GRAPH, and a `.gguf` needs
 * `UnetLoaderGGUF` where a `.safetensors` needs the stock `UNETLoader`.
 * `graphs._unet_loader` decides that from the name it is given, and every
 * builder that names a unet from the map goes through it.
 *
 * WHAT IS STILL ABSENT, and why:
 *  · `hidream_o1` CANNOT branch. It reads a single all-in-one checkpoint
 *    through `CheckpointLoaderSimple`, and city96's pack registers no
 *    checkpoint loader (only Unet/CLIP/DualCLIP/TripleCLIP/QuadrupleCLIP), so
 *    there is no node to branch to. Both its rungs are safetensors anyway, so
 *    it ladders on extension alone.
 *  · `krea2` branches nowhere yet and does not need to — the generator drops
 *    every Krea 2 entry for an encoder the engine window cannot fetch, so no
 *    rung table is emitted for it to cross.
 *  · H3, Wan and LTX are TEMPLATE-driven: the loader is baked into the
 *    workflow JSON, not chosen by a builder. That is exactly why
 *    `DESKTOP_ONLY` swaps the TEMPLATE as well as the checkpoint for H3's
 *    quantised rungs, and why a file-level swap can never reach them.
 *
 * So the default is that a rung must keep the declared file's EXTENSION, and
 * this set is the one place that says otherwise. `test_rungs.py` reads
 * `graphs.py` and fails if a family named here stops branching, or if one
 * that does branch is missing.
 */
const GGUF_SAFE = new Set(["flux2", "qwen", "anima"]);

const ext = (f) => f.slice(f.lastIndexOf(".")).toLowerCase();

/** The files of one variant, in the order a sibling's line up against. */
const rungFiles = (v) => [...v.files, ...(v.refCheckpoint ? [v.refCheckpoint] : [])];

/** Do these two rungs describe the same set of roles? */
function alignable(a, b) {
  const fa = rungFiles(a), fb = rungFiles(b);
  if (fa.length !== fb.length) return false;
  return fa.every((f, i) => f.dir === fb[i].dir);
}

function rungsFor(entry, owners, warn) {
  const names = requiredFiles(entry);
  // A FILE SHARED BY EVERY RUNG CANNOT IDENTIFY ONE, and H3 is why this is not
  // a detail: its rungs each list their own text encoder, and four of the six
  // list the SAME nvfp4 one. Keyed on that filename the entry looks like it
  // names several rungs at once, and the first version refused all three H3
  // entries for it. So the rung is identified from the files that DISCRIMINATE
  // — owned by exactly one variant of their family — while the swap below is
  // still built from the whole set, so a shared file that does differ between
  // two rungs (int8's encoder against the quants') still travels.
  const hits = names.map((n) => [n, owners.get(n)])
    .filter(([, o]) => o?.length === 1)
    .map(([n, o]) => [n, o[0]]);
  if (!hits.length) return null;
  const fams = new Set(hits.map(([, o]) => o.fam.id));
  const vars = new Set(hits.map(([, o]) => o.v.id));
  if (fams.size > 1 || vars.size > 1) {
    // Two rungs (or two families) named by one entry is not something to
    // guess at — it would mean choosing which of them the swap follows.
    warn(`names files from more than one rung (${[...vars].join(", ")})`);
    return null;
  }
  const { fam, v } = hits[0][1];
  const named = new Set(names);
  const out = [];
  for (const w of fam.variants) {
    if (w.id === v.id || !fam.swappable.includes(w.id)) continue;
    if (!alignable(v, w)) { warn(`rung ${w.id} does not line up with ${v.id}`); continue; }
    const from = rungFiles(v), to = rungFiles(w);
    const swap = {};
    let loaderChanged = false;
    from.forEach((f, i) => {
      if (!named.has(f.filename)) return;
      // An identity mapping is noise: four of H3's six rungs list the SAME
      // nvfp4 encoder, so most of its swaps would carry a line renaming a file
      // to itself.
      if (f.filename === to[i].filename) return;
      if (ext(f.filename) !== ext(to[i].filename)) loaderChanged = true;
      swap[f.filename] = to[i].filename;
    });
    if (loaderChanged && !GGUF_SAFE.has(entry.family)) continue;
    if (Object.keys(swap).length) out.push({ id: w.id, swap });
  }
  return out.length ? { declared: v.id, alts: out } : null;
}

/* ── build ──────────────────────────────────────────────────────────────── */

export function buildDesktopMap() {
  const have = catalogFiles();
  const owners = fileOwners();
  const pod = JSON.parse(readFileSync(SRC, "utf8"));
  const tier = pod[Object.keys(pod)[0]];
  const out = {};
  const report = { kept: [], dropped: [], loras: {}, rungs: [], rungWarnings: [] };

  for (const section of Object.keys(tier)) {
    const entries = tier[section];
    if (!entries || typeof entries !== "object") continue;
    const keep = {};
    for (const [key, entry] of Object.entries(entries)) {
      // The pack test reads the ENTRY as written — its distillation keys are
      // among the ones stripped below, and stripping first would let a turbo
      // row through as plain H3 wearing a faster name.
      const packWhy = needsAPack(entry);
      if (packWhy) {
        report.dropped.push({ section, key, why: packWhy });
        continue;
      }
      // A STRIPPED key is stripped BEFORE the FILE check: a recipe the
      // desktop cannot run (refine's vendored node, the latent upscaler's
      // pack) names weights the engine window cannot fetch, and judging the
      // entry with the recipe still on it would drop H3 itself for the sake
      // of a second pass the desktop was never going to offer.
      // `keepAnyway` is evaluated against the untouched entry: it reads
      // `turbo_apply`, which is itself a stripped key, so testing the copy
      // would let the deletion order decide whether the adapter survives.
      // A SECTION'S ENTRY IS NOT ALWAYS AN OBJECT — `image_control` maps a
      // name straight to a filename — and `{ ...aString }` is a map of its
      // CHARACTERS, in which nothing looks like a weight file. That made the
      // file check pass vacuously for every such entry, which is the same
      // hole the no-weights guard below closes from the other side.
      const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
      const raw = isObj ? { ...entry } : entry;
      if (isObj) {
        for (const k of Object.keys(STRIP_KEYS)) if (!keepAnyway(entry, k)) delete raw[k];
      }
      const own = requiredFiles(raw);
      // AN ENTRY THAT NAMES NO WEIGHT FILE CANNOT BE JUDGED, and letting one
      // through is the check passing VACUOUSLY — every file present, because
      // there are none to look for.
      //
      // `sensenova-u1` is the case that found this. Its weights are a
      // transformers checkpoint at `model_path: "/data/models/sensenova/…"` —
      // an absolute POD path, outside ComfyUI's model tree, which is why it is
      // the one model directory `relink_data.sh` deliberately skips. Nothing
      // in it looks like a weight filename, so it sailed through here AND
      // through `desktop_render_models`' identical scan, and the wizard
      // offered it under "on this machine" on a laptop that has none of it and
      // no way to get it.
      //
      // `from_model` is the legitimate way to name no files of your own —
      // `h3-image` is `minimax-h3` plus a decoder — so an entry that inherits
      // is judged on what it inherits.
      const inherits = isObj && typeof raw.from_model === "string" && raw.from_model;
      if (!own.length && !inherits) {
        report.dropped.push({
          section, key,
          why: "it names no weight file this check can see (its weights are not "
             + "in ComfyUI's model tree), so 'every file present' would be "
             + "vacuously true",
        });
        continue;
      }
      const missing = [...own, ...templateExtras(raw, new Set(own))]
        .map((fn) => desktopName(fn, have))
        .filter((fn) => !have.has(fn));
      if (missing.length) {
        report.dropped.push({
          section, key,
          why: `the engine window cannot download ${[...new Set(missing)].join(", ")}`,
        });
        continue;
      }
      const m = rename(raw, have);
      const lost = [];
      keep[key] = pruneLoras(m, have, lost);
      if (lost.length) report.loras[key] = lost;
      // AFTER the rename, because the rungs are named in the DESKTOP's
      // spelling — `SUBSTITUTE` and `FLATTEN` have already moved the declared
      // file onto the shelf the engine window writes to, and a swap keyed on
      // the pod's name would match nothing.
      const rungs = rungsFor(keep[key], owners,
        (why) => report.rungWarnings.push({ section, key, why }));
      if (rungs) {
        keep[key]._rungs = rungs.alts;
        report.rungs.push({ section, key, declared: rungs.declared,
                            alts: rungs.alts.map((a) => a.id) });
      }
      report.kept.push({ section, key });
    }
    if (Object.keys(keep).length) out[section] = keep;
  }

  // Desktop-only entries, derived from what survived — see DESKTOP_ONLY.
  const extra = derived(out.models ?? {}, have);
  for (const [k, m] of Object.entries(extra)) {
    out.models[k] = m;
    report.kept.push({ section: "models", key: k });
  }
  if (Object.keys(extra).length !== DESKTOP_ONLY.length) {
    for (const { key } of DESKTOP_ONLY) {
      if (!extra[key]) {
        report.dropped.push({
          section: "models", key,
          why: "the engine window cannot download one of its quantised checkpoints, "
            + "or its GGUF workflow is missing",
        });
      }
    }
  }

  return {
    map: {
      _generated: "scripts/gen_desktop_model_map.mjs — do not edit by hand",
      _from: "infra/model_map.full.json",
      _dropped: report.dropped,
      _adapters_dropped: report.loras,
      _stripped_keys: STRIP_KEYS,
      desktop: out,
    },
    report,
  };
}

const text = (m) => `${JSON.stringify(m, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { map, report } = buildDesktopMap();
  const next = text(map);
  const check = process.argv.includes("--check");
  let prev = null;
  try { prev = readFileSync(OUT, "utf8"); } catch { /* first run */ }
  if (check) {
    if (prev !== next) {
      console.error("infra/model_map.desktop.json is stale — run "
        + "`node scripts/gen_desktop_model_map.mjs`");
      process.exit(1);
    }
    console.log("desktop model map is current");
  } else {
    writeFileSync(OUT, next);
    console.log(`wrote ${path.relative(ROOT, OUT)}`);
  }
  for (const k of report.kept) console.log(`  keep  ${k.section}/${k.key}`);
  for (const d of report.dropped) console.log(`  drop  ${d.section}/${d.key} — ${d.why}`);
  for (const [k, v] of Object.entries(report.loras)) {
    console.log(`  loras ${k}: dropped ${v.join(", ")}`);
  }
  for (const r of report.rungs) {
    console.log(`  rungs ${r.section}/${r.key}: ${r.declared} + ${r.alts.join(", ")}`);
  }
  // A rung that could not be lined up is a capability quietly not offered, so
  // it prints rather than being swallowed — the same reason a dropped entry
  // carries its reason.
  for (const w of report.rungWarnings) {
    console.log(`  RUNG? ${w.section}/${w.key} — ${w.why}`);
  }
}

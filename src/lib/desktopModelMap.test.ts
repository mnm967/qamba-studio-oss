// The desktop tier of model_map, and the things that make it safe to render on.
//
// It is GENERATED (`scripts/gen_desktop_model_map.mjs`) from the pod's, so the
// first duty here is the one `localSchema.test.ts` has: fail when the checked-in
// file no longer matches what the generator would write. The pod's map moves
// often — a new checkpoint, a renamed LoRA — and every one of those moves is
// SILENT on the desktop: the entry still resolves, the graph still submits, and
// ComfyUI rejects it on an enum naming a `unet_name`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDesktopMap } from "../../scripts/gen_desktop_model_map.mjs";

const CHECKED_IN = JSON.parse(readFileSync("infra/model_map.desktop.json", "utf8"));
const { map, report } = buildDesktopMap();

test("the checked-in map is what the generator writes today", () => {
  assert.deepEqual(CHECKED_IN, map,
    "run `node scripts/gen_desktop_model_map.mjs`");
});

test("Krea 2 is there, which is what the Face Detailer re-samples through", () => {
  // `handlers/post._image_model` reads `image_models["krea2"]`, so without the
  // entry the pass cannot run on a desktop render however many node packs are
  // installed — and it was absent for a NAMING reason once: the source map
  // filed the encoder under a subdirectory and the catalogue names the bare
  // basename, so the flatten and the substitution each fixed half of it.
  const k = map.desktop.image_models?.krea2;
  assert.ok(k, "krea2 is not in the desktop map — the Face Detailer cannot run here");
  assert.equal(k.text_encoder, "qwen3vl_4b_bf16.safetensors",
    "the encoder is named as the engine window writes it, not as the source map files it");
});

test("H3 is there and it can do r2v — which is what an episode renders on", () => {
  // `master_pass` renders a block in `r2v`: that is the mode the whole
  // reference system is built around, and `fl2va` cannot do it. The engine
  // catalog listed the fl2va checkpoint and not the ref2va one for as long as
  // the row existed, so the desktop could download 57GB of H3 and still not
  // render one block of a storyboard.
  const h3 = map.desktop.models["minimax-h3"];
  assert.ok(h3, "the desktop must be able to render on plain H3");
  assert.deepEqual(Object.keys(h3.modes).sort(), ["flf", "i2v", "r2v", "t2v"]);
  // THE PRUNED PAIR, and both halves of it. The tier benchmark measured the
  // pruned fl2va + nvfp4 encoder rendering inside a driver-enforced 8GB where
  // the pod's unpruned set needs 16GB and 11GB more RAM — so `engineCatalog`
  // recommends the pruned rung and this map has to name it. Mixing them is the
  // real hazard: a pruned 20GB checkpoint for clips beside a 32GB unpruned one
  // for episodes would silently give r2v the memory profile of the tier the
  // wizard said this machine did not need.
  assert.equal(h3.modes.r2v.checkpoint, "minimax_h3_ref2va_pruned_int8_convrot.safetensors");
  assert.equal(h3.modes.i2v.checkpoint, "minimax_h3_fl2va_pruned_int8_convrot.safetensors");
  assert.deepEqual(h3.text_encoders, ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"]);
});

test("a `plain` distillation KEEPS its adapter through the strip", () => {
  // The trap this closes: `needsAPack` deliberately keeps an entry whose
  // `turbo_apply` is "plain" (an ordinary LoraLoaderModelOnly needs no pack),
  // and STRIP_KEYS then deleted `turbo_lora` anyway while leaving `steps: 4`
  // and `sampler: er_sde` behind — four steps of an UNDISTILLED model, which
  // renders mush and says nothing. Exactly the failure `needsAPack`'s own
  // comment argues against, arriving through the other door.
  const lx = map.desktop.models["minimax-h3-lightx2v"];
  assert.ok(lx, "lightx2v's 4-step needs no node pack, so it must survive");
  assert.equal(lx.turbo_apply, "plain");
  assert.ok(lx.turbo_lora, "the step count survived; the adapter must too");
  assert.equal(lx.steps, 4);
  // …and larryvrh's, which DOES need a pack, still goes whole.
  assert.ok(!map.desktop.models["minimax-h3-turbo"]);
});

/**
 * The packs `install_engine` clones, read out of the RUST rather than restated.
 *
 * This is the pin the generator's `DESKTOP_PACKS` comment promises, and the
 * failure it catches is one-directional and silent: a pack the generator
 * believes in and the installer does not add produces a desktop entry whose
 * graph names a class ComfyUI has never heard of — a job that queues, is
 * claimed, loads twenty gigabytes, and dies. Parsing the source is the only way
 * to check it: the two halves are in different languages and nothing at build
 * time compares them.
 */
const INSTALLER_PACKS = new Set(
  // Normalised to LF first: git's default on Windows is core.autocrlf, and a
  // regex `.` does not match `\r` — which is how a source-parsing test comes
  // back reporting "found 0" rather than failing.
  [...readFileSync("src-tauri/src/engine.rs", "utf8").replace(/\r\n/g, "\n")
    .split("const NODE_PACKS")[1]!.split("];")[0]!
    .matchAll(/\("([^"]+)",\s*[A-Z0-9_]+_URL/g)].map((m) => m[1]!),
);

test("nothing in it needs a node pack the desktop installer does not add", () => {
  // A turbo row minus its distillation is plain H3 wearing a faster name and a
  // shorter step count: it would render, badly, and nothing would say why. So
  // those entries are dropped WHOLE rather than stripped.
  for (const section of Object.values(map.desktop) as Record<string, any>[]) {
    for (const [key, m] of Object.entries(section)) {
      // `extra_nodes` is ALLOWED now — but only for a pack `install_engine`
      // actually clones. It used to be forbidden outright, which was right
      // while the installer added nothing but ComfyUI-GGUF; now that it adds
      // the LTX MSR nodes too, forbidding the declaration would throw away the
      // early check that names the missing pack instead of letting ComfyUI
      // fail on an unknown class after the job is claimed.
      for (const url of m.extra_nodes ?? []) {
        const dir = String(url).split("/").pop().replace(/\.git$/, "");
        assert.ok(INSTALLER_PACKS.has(dir),
          `${key} needs ${dir}, which install_engine does not clone`);
      }
      assert.ok(!m.turbo_lora || m.turbo_apply === "plain", `${key} needs a turbo pack`);
      // PDD is ALLOWED now, and only because `install_engine` clones its pack.
      // Asserted against the Rust rather than against a literal, for the same
      // reason `extra_nodes` is: the two halves are in different languages and
      // a pack dropped from `NODE_PACKS` would otherwise leave an entry here
      // whose graph names a class ComfyUI has never heard of.
      if (m.pdd) {
        assert.ok(INSTALLER_PACKS.has("ComfyUI-MiniMax-H3-PDD-Acc"),
          `${key} declares pdd, which install_engine does not clone`);
      }
      assert.ok(!m.refine, `${key} keeps a refine recipe whose node is not installed`);
    }
  }
  assert.ok(report.dropped.some((d: any) => d.key === "minimax-h3-turbo"));
});

test("the OFFICIAL 8-step distillation survives, with the files a render names", () => {
  // It was refused outright until the installer grew the pack — so a desktop
  // could render H3 at 20 steps or at lightx2v's 4, and not at MiniMax's own
  // 8, which is the only distillation with a REFERENCE build and therefore the
  // only one an episode block can run end to end.
  const pdd = map.desktop.models["minimax-h3-pdd"];
  assert.ok(pdd, "the desktop must be able to render on the official distill");
  assert.deepEqual(Object.keys(pdd.modes).sort(), ["flf", "i2v", "r2v", "t2v"]);
  // THE FILE FOLLOWS THE CHECKPOINT. The two trunks share identical key sets,
  // so a crossed pairing applies cleanly and renders silently wrong — both
  // files have to be named, and named the right way round.
  assert.match(pdd.pdd.fl2va, /FL2VA/);
  assert.match(pdd.pdd.ref2va, /Ref2VA/);
  assert.equal(pdd.steps, 8);
  // …and the recipe it CANNOT run here is gone: `latent_upscale` needs a pack
  // the installer does not add, and `refine` a vendored one.
  assert.ok(!pdd.latent_upscale && !pdd.refine);
  // IT DECLARES THE PACK IT NEEDS, which is what lets `resolve.ensure_model`
  // NAME a missing one. Without it an engine installed before that pack was
  // added has every file on disk and no node to load them, and the render dies
  // inside ComfyUI on an unknown class — after the job is claimed and twenty
  // gigabytes are resident. The same declaration `ltx-25` and MMAudio carry.
  assert.deepEqual(pdd.extra_nodes,
    ["https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc"]);
});

test("the two adapters the pipeline applies BY ITSELF are downloadable", () => {
  // `_block_loras` appends `combat` to every action block and `camera` to a
  // block whose shots ask for a move — but only when the model DECLARES them.
  // Pruned out (which is what happened while the engine window could not fetch
  // the files), a fight renders without its adapter and the only trace is one
  // line in `master_pass`'s log.
  for (const key of ["minimax-h3", "minimax-h3-pdd", "minimax-h3-lightx2v"]) {
    const m = map.desktop.models[key];
    assert.deepEqual(Object.keys(m.style_loras ?? {}).sort(), ["camera", "combat"], key);
  }
  // The trigger travels with the adapter. `camera` is INERT without its token
  // — the author trained on it and `h3_prompt` places it at the head of the
  // compiled description — so an entry that kept the adapter and dropped the
  // trigger would load it and change nothing.
  assert.equal(map.desktop.models["minimax-h3"].lora_triggers.camera, "camera motion");
});

test("a side table never outlives the adapter it describes", () => {
  // `lora_defaults` and `lora_triggers` are keyed by the same names as
  // `style_loras`, and until an adapter survived the prune this was invisible:
  // with the table deleted whole, its companions went with it.
  for (const m of Object.values(map.desktop.models) as Record<string, any>[]) {
    const keys = new Set(Object.keys(m.style_loras ?? {}));
    for (const side of ["lora_triggers", "lora_defaults"]) {
      for (const k of Object.keys(m[side] ?? {})) {
        assert.ok(keys.has(k), `${side}.${k} describes an adapter this entry dropped`);
      }
    }
  }
});

test("every file it names is one the engine window can download", () => {
  // The whole point. A name here that the catalog cannot supply is a job that
  // queues, is claimed, loads a model and then fails on a filename.
  const cat = readFileSync("src/lib/engineCatalog.ts", "utf8");
  const have = new Set<string>();
  for (const m of cat.matchAll(/filename:\s*"([^"]+)"/g)) have.add(m[1]);
  for (const m of cat.matchAll(/gguf\(`[^`]*`,\s*"([^"]+)"/g)) have.add(m[1]);

  const weights: string[] = [];
  const walk = (v: unknown, key: string | null): void => {
    if (key === "style_loras") return;
    if (typeof v === "string") {
      if (/\.(safetensors|gguf|ckpt|pt|pth|bin)$/i.test(v)) weights.push(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(map.desktop, null);
  assert.ok(weights.length > 5, "the walker found almost nothing — it is broken");
  const missing = [...new Set(weights)].filter((w) => !have.has(w));
  assert.deepEqual(missing, []);
});

test("the adapters are pruned, so a FIGHT block does not fail on a missing LoRA", () => {
  // `_block_loras` appends `combat` to every fight block WHEN THE MODEL
  // DECLARES IT, and `resolve.lora_stack` raises on a picked-but-missing file.
  // An entry that kept the pod's adapter table would fail every fight block on
  // a machine that has none of them; pruned, the lookup answers "this model
  // does not declare combat" and the block renders without it — visible in
  // `master_pass`'s own adapter log line.
  //
  // WHAT IS PRUNED MOVES with the catalogue, so this asserts the RULE rather
  // than a list: `combat` and `camera` are downloadable and survive (pinned
  // two tests up), and every key the report says was dropped has to be gone
  // from the entry it was dropped from.
  const dropped = Object.entries(report.loras) as [string, string[]][];
  assert.ok(dropped.length, "nothing was pruned at all — the report is not being read");
  for (const [key, keys] of dropped) {
    const entry = map.desktop.models?.[key] ?? map.desktop.image_models?.[key];
    assert.ok(entry, `${key} was pruned and is not in the map at all`);
    for (const k of keys) {
      assert.ok(!(k in (entry.style_loras ?? {})), `${key}/${k} was dropped and is still declared`);
    }
  }
});

test("a template's BAKED-IN weights count, not just the entry's", () => {
  // `resolve()` rewrites unet_name/clip_name/vae_name from the map, but only
  // rewrites a `lora_name` on a STYLE placeholder — and
  // `wan22_14b_i2v_fp8.json` has the lightx2v 4-step adapter baked straight
  // into a LoraLoaderModelOnly. Judged on its own keys, `wan2.2` reads as
  // fully downloadable; it is not.
  assert.ok(!map.desktop.models["wan2.2"], "wan2.2 must be dropped");
  const why = report.dropped.find((d: any) => d.key === "wan2.2").why;
  assert.match(why, /lightx2v/);
});

test("the SOURCE map is untouched by any of this", () => {
  // `model_map.full.json` is the catalogue of everything this pipeline knows
  // how to render, including entries no desktop can fetch the weights for.
  // The generator PRUNES on the way out; a drop or a substitution that reached
  // back into the source would quietly change what the source means.
  const full = JSON.parse(readFileSync("infra/model_map.full.json", "utf8"));
  assert.deepEqual(Object.keys(full), ["full"], "the source has exactly one tier");
  assert.ok(full.full.models["minimax-h3-turbo"],
    "dropping a row from the desktop map must not drop it from the source");
  assert.equal(full.full.models["wan2.2"].text_encoders[0], "umt5_xxl_fp16.safetensors",
    "the fp8 substitution is the DESKTOP's; the source still says what it says");
});

test("the quantised H3 entries load through the GGUF loader, and only that differs", () => {
  // THE POINT OF A SECOND TEMPLATE. The stock `UNETLoader` will not even LIST a
  // `.gguf`, so `resolve()` writing a quantised filename into the safetensors
  // template produces a prompt ComfyUI rejects on an enum — after the job is
  // claimed and the block's turn on the GPU has come round. Everything else
  // about the graph is the same file, which is why these are generated from it.
  const models = map.desktop.models as Record<string, any>;
  const quants = Object.keys(models).filter((k) => /^minimax-h3-q\d$/.test(k));
  assert.deepEqual(quants.sort(), ["minimax-h3-q3", "minimax-h3-q4", "minimax-h3-q5"]);

  const base = models["minimax-h3"];
  for (const k of quants) {
    const m = models[k];
    // Every mode the safetensors entry has, including r2v — an episode renders
    // in r2v and a quantised entry without it could not render one.
    assert.deepEqual(Object.keys(m.modes).sort(), Object.keys(base.modes).sort(), k);
    for (const [mode, spec] of Object.entries(m.modes) as [string, any][]) {
      assert.match(spec.checkpoint, /\.gguf$/, `${k}/${mode}`);
      assert.equal(spec.workflow, `minimax_h3_${mode}_gguf.json`, `${k}/${mode}`);
      // r2v is a DIFFERENT checkpoint, not the same one through another node.
      assert.match(spec.checkpoint,
        mode === "r2v" ? /Ref2VA/ : /FL2VA/, `${k}/${mode} names the wrong half of the pair`);
    }
    // Derived, so everything that is not the checkpoint or the workflow is the
    // parent's — a mistyped frame grid dies deep inside the sampler.
    for (const key of ["fps", "frame_base", "frame_rem", "dim_step", "text_encoders",
                       "vae", "audio_vae"]) {
      assert.deepEqual(m[key], base[key], `${k}.${key} drifted from minimax-h3`);
    }
    // `gguf: true` means "look in models/unet" to `ensure_model`; the engine
    // window writes every GGUF to models/diffusion_models, which is the only
    // place `engine_status` scans. The LOADER comes from the workflow.
    assert.equal(m.gguf, undefined, `${k} sets gguf, which would misdirect ensure_model`);
  }
});

test("every GGUF template is a real file that loads through UnetLoaderGGUF", () => {
  // A `workflow` naming a template that is not on disk is a job that dies at
  // resolve time; one that kept `UNETLoader` is a job that dies at submit.
  for (const mode of ["i2v", "t2v", "flf", "r2v"]) {
    const p = new URL(`../../workflows/minimax_h3_${mode}_gguf.json`, import.meta.url);
    const g = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
    const loaders = Object.values(g).filter(
      (n) => typeof n === "object" && n && String(n.class_type ?? "").includes("Loader"));
    const unet = loaders.filter((n: any) => /UNETLoader|UnetLoaderGGUF/.test(n.class_type));
    assert.equal(unet.length, 1, `${mode}: ${unet.length} model loaders`);
    assert.equal(unet[0].class_type, "UnetLoaderGGUF", mode);
    // `UnetLoaderGGUF` declares ONLY `unet_name` — read off the pod's own live
    // /object_info. Sending `weight_dtype` fails validation at submit.
    assert.deepEqual(Object.keys(unet[0].inputs), ["unet_name"], mode);
    assert.match(unet[0].inputs.unet_name, /\.gguf$/, mode);
  }
});

test("the wizard's quantised rows translate, and exist only in the desktop map", () => {
  // THREE WAYS THIS FAILS SILENTLY, so all three are pinned here.
  //
  //  · a wizard id whose `modelKeyOf` guess is not a key in the map — the plan
  //    carries a key `_block_model` cannot resolve and every block dies;
  //  · a key that ALSO exists in the SOURCE map would make the desktop-only
  //    framing a lie. These rungs are generated for machines that cannot hold
  //    the full checkpoint, so they exist in the generated map and nowhere
  //    else — the ids still have to line up;
  //  · `MODEL_KEY_EXCEPTIONS` living in more than one language, which is why
  //    every copy is read here rather than one. There are THREE now and the
  //    canonical one is `director/model_keys.js`, the single JS home the
  //    browser and the director both import; `projectSettings.ts` merely
  //    re-exports from it, so reading THAT file for the table finds nothing
  //    and this test would fail on a repo that is perfectly correct.
  //    The other two are hand-kept copies `model_keys.test.mjs` pins.
  // The rows MOVED out of the modal and into `wizardModels.ts`, which is what
  // the tests, the picker and `/ui/wizmodels` all read — so this parse follows
  // them. Keyed on `home: "local"`, the field that MEANS desktop-only, rather
  // than on the ids: a fourth rung added without one would be a row offered to
  // a web session, which is the second failure below.
  const wiz = readFileSync("src/lib/wizardModels.ts", "utf8");
  const js = readFileSync("director/model_keys.js", "utf8");
  const py = readFileSync("scripts/gen_model_catalog.py", "utf8");
  const wk = readFileSync("worker/director_tools.py", "utf8");
  const full = JSON.parse(readFileSync("infra/model_map.full.json", "utf8"));

  const rows = [...wiz.matchAll(
    /id:\s*"([a-z0-9-]+)",\s*key:\s*"([a-z0-9.-]+)",\s*home:\s*"local"/g)]
    .map((m) => ({ id: m[1], key: m[2] }));
  assert.equal(rows.length, 3, `the wizard offers ${rows.length} quantised rows`);

  for (const { key, id } of rows) {
    assert.ok(map.desktop.models[key], `the wizard offers ${id} -> ${key}, which the map lacks`);
    assert.ok(!full.full.models[key],
      `${key} is in the source map too, so the desktop-only framing is wrong`);
    // Both translation tables, and they have to agree with each other.
    for (const [lang, src] of [["js", js], ["py", py], ["worker", wk]] as const) {
      assert.ok(src.includes(`"${id}": "${key}"`),
        `${lang}'s MODEL_KEY_EXCEPTIONS is missing ${id} -> ${key}`);
    }
  }
});

// Two jobs here, and the first one is the reason the module is allowed to
// duplicate anything at all.
//
// 1. DRIFT. `workflows.ts` re-declares LATENT_CLASSES / PROMPT_INPUT_CLASSES
//    from worker/resolve.py, because the browser cannot import Python. If
//    those two copies disagree, the inspector reports a contract nobody is
//    running — the most damaging thing a read-only view can do, since it would
//    say "size and length are wired" about a graph where they are not. So the
//    test parses resolve.py and demands the sets match exactly.
//
// 2. THE REAL TEMPLATES. Every file in workflows/ is run through the analysis,
//    and the invariant that matters is asserted against the ones that ship:
//    anything a model_map mode or a handler names must parse, and must not
//    drop a parameter the job passes it. That check is what would have caught
//    the UI-format file and the stubs before they were noticed by eye.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HANDLER_TEMPLATES, LATENT_CLASSES, PROMPT_INPUT_CLASSES,
  contractOf, imageFamilies, mapProvenance, parseTemplate, pinContract,
  substitutionContract, templateRows, workflowUsage,
  type ModelMap, type ParsedTemplate,
} from "./workflows.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF_DIR = path.join(ROOT, "workflows");
const TIER = "full";

const resolvePy = fs.readFileSync(path.join(ROOT, "worker", "resolve.py"), "utf8");
const modelMap = JSON.parse(
  fs.readFileSync(path.join(ROOT, "infra", "model_map.full.json"), "utf8")) as ModelMap;

const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith(".json")).sort();
const parsed: ParsedTemplate[] = files.map(
  (f) => parseTemplate(f, fs.readFileSync(path.join(WF_DIR, f), "utf8")));
const rows = templateRows(parsed, workflowUsage(modelMap, TIER));
const byName = new Map(rows.map((r) => [r.parsed.name, r]));

// The OTHER tier the app ships. It is generated from the map above by
// scripts/gen_desktop_model_map.mjs, and the Workflows page reads it whenever
// it is describing this machine rather than the pod.
const DESKTOP = "desktop";
const desktopRaw = JSON.parse(
  fs.readFileSync(path.join(ROOT, "infra", "model_map.desktop.json"), "utf8")) as unknown;
const desktopMap = desktopRaw as ModelMap;
const desktopRows = templateRows(parsed, workflowUsage(desktopMap, DESKTOP), DESKTOP);
const desktopByName = new Map(desktopRows.map((r) => [r.parsed.name, r]));

/** Pull a `NAME = { "A", "B" }` python set literal out of resolve.py. */
function pySet(name: string): Set<string> {
  const m = resolvePy.match(new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`, "s"));
  assert.ok(m, `${name} not found in worker/resolve.py`);
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

const sorted = (s: Set<string>) => [...s].sort();

test("LATENT_CLASSES matches worker/resolve.py", () => {
  assert.deepEqual(sorted(LATENT_CLASSES), sorted(pySet("LATENT_CLASSES")));
});

test("PROMPT_INPUT_CLASSES matches worker/resolve.py", () => {
  assert.deepEqual(sorted(PROMPT_INPUT_CLASSES), sorted(pySet("PROMPT_INPUT_CLASSES")));
});

test("every template in workflows/ is classified", () => {
  assert.ok(files.length > 0, "no templates found");
  for (const r of rows) {
    assert.ok(["api", "ui", "stub", "invalid"].includes(r.parsed.format), r.parsed.name);
  }
});

// The one that would have caught krea2_image_tool.json being UI format if
// anything had ever pointed a mode at it.
test("no template that ships in a mode or a handler is broken", () => {
  const broken = rows.filter((r) => r.health === "broken")
    .map((r) => `${r.parsed.name}: ${r.note}`);
  assert.deepEqual(broken, [], `reachable templates must parse:\n${broken.join("\n")}`);
});

test("every handler-named template exists on disk", () => {
  for (const name of Object.keys(HANDLER_TEMPLATES)) {
    assert.ok(byName.has(name), `${name} is named in HANDLER_TEMPLATES but not in workflows/`);
  }
});

// The substance: resolve() must be able to write every parameter the job
// passes. A "risk" row is a parameter the graph silently drops.
test("no live resolve-pipeline template drops a parameter", () => {
  const risks: string[] = [];
  for (const r of rows) {
    if (r.dialect !== "resolve" || r.parsed.format !== "api") continue;
    const as = r.handler?.as, use = r.uses[0];
    const model = as?.model ?? use?.model;
    const mode = as?.mode ?? use?.mode;
    for (const c of contractOf(r.parsed.nodes,
      { mode, model: model ? modelMap[TIER]?.models?.[model] : undefined })) {
      if (c.status === "risk") risks.push(`${r.parsed.name} — ${c.label}: ${c.detail}`);
    }
  }
  assert.deepEqual(risks, [], `\n${risks.join("\n")}`);
});

test("the node ids the lipsync handler pins still exist", () => {
  const r = byName.get("lipsync_latentsync.json");
  assert.ok(r?.handler?.pins);
  const bad = pinContract(r.parsed.nodes, r.handler.pins)
    .filter((c) => c.status === "risk").map((c) => `${c.label}: ${c.detail}`);
  assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
});

test("every substitution hole lands on a node input", () => {
  for (const r of rows) {
    if (r.dialect !== "substitution") continue;
    const bad = substitutionContract(r.parsed)
      .filter((c) => c.status === "risk").map((c) => `${r.parsed.name} ${c.label}`);
    assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
    assert.ok(r.parsed.placeholders.length, `${r.parsed.name} has no holes to substitute`);
  }
});

// The `post_rife.json` case that used to sit here is gone with the file. It
// pinned the one property that made the substitution dialect worth modelling —
// a template that is NOT valid JSON until its holes are filled — and
// `lipsync_wav2vec.json` still exercises that through the loop above.

/* ── the contract check itself, on graphs built for the purpose ─────────── */

const node = (class_type: string, inputs: Record<string, unknown> = {}) => ({ class_type, inputs });
const graph = (o: Record<string, ReturnType<typeof node>>) =>
  Object.entries(o).map(([id, n]) => ({ id, ...n }));

const rowFor = (rs: ReturnType<typeof contractOf>, id: string) => {
  const r = rs.find((x) => x.id === id);
  assert.ok(r, `no ${id} row`);
  return r;
};

test("a graph with no recognised latent builder is flagged, not passed", () => {
  const c = contractOf(graph({
    1: node("UNETLoader", { unet_name: "x.safetensors" }),
    2: node("SomeCustomLatent", { width: 1280, height: 720, length: 81 }),
    3: node("KSampler", { seed: 1 }),
  }));
  assert.equal(rowFor(c, "dims").status, "risk");
  assert.match(rowFor(c, "dims").detail, /silently ignored/);
});

test("a CLIPTextEncode nobody wires as positive does not count as a prompt sink", () => {
  const c = contractOf(graph({
    1: node("CLIPTextEncode", { text: "a cat" }),
    2: node("KSampler", { seed: 1, negative: ["9", 0] }),
  }));
  assert.equal(rowFor(c, "prompt").status, "risk");
  assert.match(rowFor(c, "prompt").detail, /none wired to a `positive` input/);
});

test("H3's inline prompt input counts as a prompt sink", () => {
  const c = contractOf(graph({
    1: node("MiniMaxH3ImageToVideo", { prompt: "", width: 1280, height: 720, length: 101 }),
  }));
  assert.equal(rowFor(c, "prompt").status, "ok");
  assert.equal(rowFor(c, "dims").status, "ok");
});

test("a missing seed sink is a risk — the render would repeat one seed", () => {
  const c = contractOf(graph({ 1: node("BasicScheduler", { steps: 20 }) }));
  assert.equal(rowFor(c, "seed").status, "risk");
});

test("a STYLE placeholder with no style_lora in the entry is called out", () => {
  const g = graph({ 1: node("LoraLoaderModelOnly", { lora_name: "STYLE", strength_model: 1 }) });
  assert.equal(rowFor(contractOf(g, {}), "lora").status, "risk");
  assert.equal(rowFor(contractOf(g, { model: { style_lora: "s.safetensors" } }), "lora").status, "ok");
});

// resolve()'s fall-through writes the source still into EVERY LoadImage it did
// not classify, which is invisible in the template and surprising in a graph
// that stages a picture for some other purpose.
test("extra LoadImage nodes beside the start frame are called out", () => {
  const c = contractOf(graph({
    1: node("WanImageToVideo", { width: 1, height: 1, length: 1, start_image: ["2", 0] }),
    2: node("LoadImage", { image: "start.png" }),
    3: node("LoadImage", { image: "a-logo.png" }),
    4: node("KSampler", { seed: 1 }),
  }), { mode: "i2v" });
  assert.equal(rowFor(c, "loadimage").status, "risk");
  assert.match(rowFor(c, "loadimage").detail, /#3/);
});

test("a UI-format export is recognised rather than parsed as a graph", () => {
  const p = parseTemplate("x.json", JSON.stringify({ nodes: [], links: [], version: 0.4 }));
  assert.equal(p.format, "ui");
  assert.deepEqual(p.nodes, []);
});

test("a stub is recognised, matching resolve()'s own refusal", () => {
  assert.ok(/_stub/.test(resolvePy), "resolve.py no longer guards on _stub");
  assert.equal(parseTemplate("x.json", '{"_stub": true}').format, "stub");
});

test("image families map to a builder, since they have no template", () => {
  const fams = imageFamilies(modelMap, TIER);
  assert.ok(fams.length > 0);
  const unmapped = fams.filter((f) => f.builder.includes("unmapped")).map((f) => f.family);
  assert.deepEqual(unmapped, [], `image families with no builder named: ${unmapped}`);
});

// ── the desktop tier ────────────────────────────────────────────────────────
//
// TWO MAPS, TWO ANSWERS. `full` is the catalogue of everything this pipeline
// knows how to render; `desktop` is generated from it and pruned to what the
// engine window can actually download, so it is the one that answers "will
// this run here". These pin the half of that distinction that is not a
// picture.

test("every workflow the desktop map names is a template on disk", () => {
  // The map is GENERATED, so this is the drift that would arrive silently: a
  // regenerated map naming a file nobody ships resolves to a missing template
  // and the desktop tier quietly loses a mode.
  const named = [...workflowUsage(desktopMap, DESKTOP).keys()];
  assert.ok(named.length > 0, "the desktop map names no workflow at all");
  for (const name of named) {
    assert.ok(desktopByName.has(name), `${name} is named by the desktop map but not in workflows/`);
  }
});

test("a template the desktop map names is in use on that tier and not broken", () => {
  const live = desktopRows.filter((r) => r.health === "ok" && r.uses.length > 0);
  assert.ok(live.length > 0, "no template is reachable on the desktop tier");
  for (const r of live) {
    assert.equal(r.dialect, "resolve", `${r.parsed.name} is not resolve-parameterised`);
  }
});

test("a pod-only handler does not count as a use on the desktop tier", () => {
  // `run_lipsync` is the v1 studio's, and no kind in plan_cli.KINDS reaches
  // it — counting it would report a template as live on a machine that can
  // never run it, which is the one direction this page must not be wrong in.
  const onPod = byName.get("lipsync_latentsync.json");
  const onDesktop = desktopByName.get("lipsync_latentsync.json");
  assert.ok(onPod && onDesktop);
  assert.equal(onPod.health, "ok");
  assert.equal(onDesktop.health, "unused");
  // …and it is still SHOWN, because what the file is for is worth knowing on
  // either tier. Only the count changes, and the note says why.
  assert.ok(onDesktop.handler, "the handler was dropped rather than uncounted");
  assert.match(onDesktop.note, /does not run on this tier/);
});

test("a handler the desktop DOES reach still counts there", () => {
  // AUDIOLOCK_WF is named in handlers/blocks.py by handle_master_pass, which
  // is a kind the desktop claims — so it is live on both tiers.
  for (const m of [byName, desktopByName]) {
    const r = m.get("minimax_h3_r2v_audiolock.json");
    assert.ok(r, "the audiolock template is missing");
    assert.notEqual(r.health, "unused");
  }
});

test("the generated map reports what it dropped, with a reason for each", () => {
  const prov = mapProvenance(desktopRaw);
  assert.ok(prov, "model_map.desktop.json carries no _generated marker");
  assert.match(prov.generated, /gen_desktop_model_map/);
  assert.ok(prov.dropped.length > 0, "nothing was dropped, which would be a first");
  for (const d of prov.dropped) {
    assert.ok(d.section && d.key, "a dropped entry with no name");
    // The reason is the whole point of surfacing this — a count alone reads
    // as a studio with nothing in it.
    assert.ok(d.why.length > 10, `${d.key} was dropped with no reason given`);
  }
  for (const k of prov.strippedKeys) assert.ok(k.why.length > 5, `${k.key} stripped with no reason`);
});

test("a hand-written map has no provenance to report", () => {
  assert.equal(mapProvenance(modelMap), null);
  assert.equal(mapProvenance(null), null);
  assert.equal(mapProvenance({}), null);
});

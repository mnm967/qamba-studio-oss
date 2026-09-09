import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { FAMILIES } from "./engineCatalog.ts";
import { BREEZE_ROW, QWEN_ROW,
         markFor, markDesktopRows, markDesktopImageRows, imageVerdict,
         isDesktopReady, bundledFamilies, IMAGE_PACKS,
         type DesktopCtx } from "./desktopRows.ts";
import { tierOf } from "./localModels.ts";
import type { EngineStatus } from "./desktop.ts";
import type { ModelCatalogRow } from "./db/types.ts";

const MM = FAMILIES.find((f) => f.id === "mmaudio")!;
const PACKS = MM.bundled!.packs;
/** every file of the one variant, which is what "installed" means */
const ALL_FILES = [...MM.shared, ...MM.variants[0].files].map((f) => f.filename);

function status(over: Partial<EngineStatus> = {}): EngineStatus {
  return {
    installed: true, python: null, comfy_dir: null, root: "/r",
    checkpoints: [], loras: [], files: ALL_FILES, file_mb: {},
    partial_mb: {}, partial_owner: {}, by_dir: {},
    nodes: [...PACKS], nodes_broken: [],
    running: true, port: 8188, models_dir: "/r", models_linked: false,
    planner: true, ffmpeg: true, ffmpeg_ours: true,
    ...over,
  } as EngineStatus;
}

const ctx = (over: Partial<DesktopCtx> = {}): DesktopCtx =>
  ({ status: status(), planner: true, engineUp: true, ...over });

const row = (): ModelCatalogRow => ({
  id: "mmaudio-large-44k-v2-local", family: "mmaudio",
  display_name: "MMAudio · Large 44k v2", kind: "audio", provider: "local",
  modes: ["v2a"], sizes: null, max_seconds: 30, fps: null,
  frame_base: null, frame_rem: null, dim_step: null,
  pricing: {}, capabilities: { steps: 25, cfg: 4.5 }, enabled: true, sort: 48,
});

/* ── the six states ──────────────────────────────────────────────────────── */

test("everything present and running is ready, and says nothing", () => {
  const v = markFor(MM, ctx())!;
  assert.equal(v.mark, "ready");
  // A ready row must carry NO sentence: `rowBlocked` shows one whenever it is
  // there, and "you can use this" under a usable row is noise.
  assert.equal(v.why, "");
});

test("no weights is an OFFER that names the download and its size", () => {
  const v = markFor(MM, ctx({ status: status({ files: [] }) }))!;
  assert.equal(v.mark, "offer");
  assert.equal(v.fix, "models");
  assert.match(v.why, /download/i);
  assert.match(v.why, /GB/, "the size is the decision — say it");
});

test("a half-downloaded family is still an offer, not a broken install", () => {
  // Three of four files: the shared set landed and the transformer did not.
  const v = markFor(MM, ctx({ status: status({ files: MM.shared.map((f) => f.filename) }) }))!;
  assert.equal(v.mark, "offer");
});

test("downloaded with the engine asleep is BLOCKED, and the fix is the engine", () => {
  const v = markFor(MM, ctx({ engineUp: false }))!;
  assert.equal(v.mark, "blocked");
  assert.equal(v.fix, "engine");
  assert.match(v.why, /start the engine/i);
});

test("a missing node pack says reinstall, not download", () => {
  // The weights are on disk. Telling someone to download what they already
  // have is the sentence that sends them round a loop.
  const v = markFor(MM, ctx({ status: status({ nodes: ["ComfyUI-GGUF"] }) }))!;
  assert.equal(v.mark, "blocked");
  assert.equal(v.fix, "engine");
  assert.match(v.why, /reinstall/i);
  assert.doesNotMatch(v.why, /download/i);
});

test("a pack whose dependencies were REFUSED says so in its own words", () => {
  // `nodes_broken` is the state pinning creates: the directory is on disk and
  // importable-looking, so it is excluded from `nodes` — and "reinstall the
  // engine, it adds this at install time" would be a lie, because it did.
  const v = markFor(MM, ctx({ status: status({
    nodes: ["ComfyUI-GGUF", "ComfyUI-VideoHelperSuite"],
    nodes_broken: ["ComfyUI-MMAudio"],
  }) }))!;
  assert.equal(v.mark, "blocked");
  assert.match(v.why, /would not install/i);
  assert.match(v.why, /ComfyUI-MMAudio/);
});

test("weights but no pipeline Python is blocked on the pipeline", () => {
  // A machine that took "Utilities only", or brought its own ComfyUI: it has
  // the model and no runner, which is a different install from the engine's.
  const v = markFor(MM, ctx({ planner: false }))!;
  assert.equal(v.mark, "blocked");
  assert.match(v.why, /pipeline/i);
});

test("off the desktop nothing is marked at all", () => {
  // The web build has no engine status, and an unmarked row behaves exactly as
  // it did before this module existed.
  assert.equal(markFor(MM, { status: null, planner: false, engineUp: false }), null);
  const rows = [row()];
  markDesktopRows(rows, { status: null, planner: false, engineUp: false });
  assert.equal((rows[0].capabilities as { desktop?: string }).desktop, undefined);
});

/* ── the local speech services ───────────────────────────────────────────── */

const speechRow = (id: string): ModelCatalogRow =>
  ({ id, kind: "audio", provider: "local", modes: ["tts"], enabled: true,
     sort: 50, capabilities: {} } as unknown as ModelCatalogRow);

const svc = (p: Record<string, unknown>) => ({
  installed: false, code: false, venv: false, weights_mb: 0,
  weights_total_mb: 1000, weights_missing: ["m.safetensors"], reachable: false,
  ours: false, starting: false, foreign: false, device: null, rev: "",
  port: 0, root: "/e", license: "", ...p,
}) as never;

test("each speech row is marked from ITS OWN service", () => {
  // THE BUG THIS PINS: one hardcoded Breeze lookup marked every speech row, so
  // a second engine's card carried Breeze's verdict — ready on a machine that
  // has no Qwen, blocked on one where it is fine, and a plausible sentence
  // either way.
  const rows = [speechRow(BREEZE_ROW), speechRow(QWEN_ROW)];
  markDesktopRows(rows, {
    status: null, planner: true, engineUp: true,
    breeze: svc({ installed: true, reachable: true }),
    qwen: svc({}),
  });
  const cap = (i: number) => rows[i].capabilities as { desktop?: string; desktopWhy?: string };
  assert.equal(cap(0).desktop, "ready", "Breeze is serving");
  assert.equal(cap(1).desktop, "offer", "Qwen is not installed — an offer, not a block");
  assert.match(cap(1).desktopWhy!, /Qwen/, "the sentence must name its own engine");
  // WHICH SECTION IT APPEARS UNDER, which is what the mark is FOR: a served
  // engine moves to ON THIS MACHINE and an unserved one stays on the studio's
  // tier carrying the download that would move it. `provider: "local"` means
  // the POD before any of this, so an unmarked row is the studio's.
  assert.equal(tierOf(rows[0]), "local", "a serving engine is on this machine");
  assert.equal(tierOf(rows[1]), "cloud", "an absent one stays the studio's");
});

test("installed-but-asleep is BLOCKED where never-installed is an OFFER", () => {
  // Different fixes — "start it" against "download it" — and `rowBlocked`
  // renders them differently. Reading the flag off the wrong service is what
  // the single lookup did.
  const rows = [speechRow(QWEN_ROW)];
  markDesktopRows(rows, { status: null, planner: true, engineUp: true,
                          qwen: svc({ installed: true }) });
  const c = rows[0].capabilities as { desktop?: string; desktopWhy?: string };
  assert.equal(c.desktop, "blocked");
  assert.match(c.desktopWhy!, /start Qwen/);
});

test("a service this build has not asked about leaves its row alone", () => {
  const rows = [speechRow(QWEN_ROW)];
  markDesktopRows(rows, { status: null, planner: true, engineUp: true,
                          breeze: svc({ installed: true, reachable: true }) });
  assert.equal((rows[0].capabilities as { desktop?: string }).desktop, undefined,
    "an absent answer must not mark the row");
});

/* ── what the mark does to the row ───────────────────────────────────────── */

test("a ready row moves to the local tier and reads as ready", () => {
  const rows = [row()];
  // Before: `provider: "local"` means the POD, so it is the studio's.
  assert.equal(tierOf(rows[0]), "cloud");
  markDesktopRows(rows, ctx());
  assert.equal(tierOf(rows[0]), "local");
  assert.ok(isDesktopReady(rows[0]));
});

test("a BLOCKED row is local too — the weights are on this disk", () => {
  const rows = [row()];
  markDesktopRows(rows, ctx({ engineUp: false }));
  assert.equal(tierOf(rows[0]), "local");
  assert.ok(!isDesktopReady(rows[0]), "blocked must never route a job here");
});

test("an OFFER row stays where it was, so the pod stays available", () => {
  // Nothing about "I have not downloaded it" makes the studio's own copy
  // unusable, and moving the row would take that away to advertise a download.
  const rows = [row()];
  markDesktopRows(rows, ctx({ status: status({ files: [] }) }));
  assert.equal(tierOf(rows[0]), "cloud");
  assert.ok(!isDesktopReady(rows[0]));
});

test("re-marking clears a stale sentence rather than leaving it on a ready row", () => {
  // The rows are a cached shared array marked in place, so the engine coming
  // up has to REMOVE the reason it was down — otherwise a usable row keeps
  // saying "start the engine" for the life of the session.
  const rows = [row()];
  markDesktopRows(rows, ctx({ engineUp: false }));
  assert.match((rows[0].capabilities as { desktopWhy?: string }).desktopWhy!, /start/);
  markDesktopRows(rows, ctx());
  assert.equal((rows[0].capabilities as { desktopWhy?: string }).desktopWhy, undefined);
});

test("a catalogue without the row is left alone", () => {
  // A member's catalogue may not carry it at all (`model_catalog_visible`).
  const rows: ModelCatalogRow[] = [{ ...row(), id: "something-else" }];
  markDesktopRows(rows, ctx());
  assert.equal((rows[0].capabilities as { desktop?: string }).desktop, undefined);
});

/* ── the claims the family makes about the rest of the repo ──────────────── */

test("every bundled family names a real catalog row, a real kind and real packs", () => {
  // Three claims across three languages, each silent when wrong: a row id
  // nothing defines marks nothing, a kind the Python refuses is a job that
  // dies after being claimed, and a pack the installer never adds is a
  // capability offered on a machine that cannot have it.
  const read = (p: string) =>
    fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
  const catalog = read("scripts/gen_model_catalog.py");
  const kinds = read("worker/plan_cli.py").split("KINDS = {")[1].split("\n}")[0];
  const packs = new Set(
    [...read("src-tauri/src/engine.rs")
      .split("const NODE_PACKS")[1].split("];")[0]
      .matchAll(/\("([^"]+)",\s*[A-Z0-9_]+_URL/g)].map((m) => m[1]),
  );
  assert.ok(packs.size >= 2, "the NODE_PACKS scanner is broken");

  const fams = bundledFamilies();
  assert.ok(fams.length >= 1, "nothing declares `bundled` — did the field move?");
  for (const f of fams) {
    const b = f.bundled!;
    assert.ok(catalog.includes(`row("${b.catalogRow}"`),
              `${f.id}: no catalog row named ${b.catalogRow}`);
    assert.ok(new RegExp(`"${b.kind}":`).test(kinds),
              `${f.id}: plan_cli.KINDS does not claim ${b.kind}`);
    for (const p of b.packs) {
      assert.ok(packs.has(p), `${f.id}: the installer does not add ${p}`);
    }
  }
});

test("a bundled family has no local recipe, and says why", () => {
  // `localModelRows` skips a family with no recipe, which is right here — it
  // would otherwise be offered as a composer pick that can never build a
  // graph. `NO_RECIPE` is what turns that skip into a sentence.
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/lib/localGraphs.ts"), "utf8").replace(/\r\n/g, "\n");
  const body = src.split("export const NO_RECIPE")[1].split("\n};")[0];
  for (const f of bundledFamilies()) {
    assert.ok(new RegExp(`\\b${f.id}\\b`).test(body),
              `${f.id} renders through the pipeline — NO_RECIPE must say so`);
  }
});


/* ── image rows, marked from the MODEL MAP rather than from the catalogue ── */

const imgRow = (id: string): ModelCatalogRow => ({
  id, display_name: id, kind: "image", provider: "local", enabled: true,
  modes: ["t2i"], capabilities: {},
} as unknown as ModelCatalogRow);

/** `modelKeyOf`'s rule, inlined: the picker's id minus `-local`. */
const keyOf = (id: string) => id.replace(/-local$/, "");

test("an image row the desktop map carries moves onto the local tier", () => {
  const rows = [imgRow("qwen-edit-local")];
  markDesktopImageRows(rows, [{ key: "qwen-edit", ready: true, missing: [] }],
                       { planner: true, engineUp: true }, keyOf);
  assert.equal(tierOf(rows[0]), "local");
  assert.ok(isDesktopReady(rows[0]));
});

test("a row the map does NOT carry is left exactly as it was", () => {
  // Krea 2 is the live case: the generator drops it because the engine window
  // cannot fetch its abliterated encoder. Marking it from the catalogue alone
  // would be a sheet that dies inside `resolve()` naming a file nobody can
  // download — so the row stays the studio's, which is where it can run.
  const rows = [imgRow("krea2-local")];
  markDesktopImageRows(rows, [{ key: "qwen-edit", ready: true, missing: [] }],
                       { planner: true, engineUp: true }, keyOf);
  assert.equal(tierOf(rows[0]), "cloud");
  assert.equal((rows[0].capabilities as { desktop?: string }).desktop, undefined);
});

test("a model whose weights the scan cannot see is left on the studio's tier", () => {
  // THE BUG THIS EXISTS FOR. SenseNova's weights are a transformers checkpoint
  // at an absolute POD path outside ComfyUI's model tree, so the weight scan
  // finds none of its files — and "every file present" was vacuously true at
  // BOTH ends, the generator's and `desktop_render_models`'. It was offered
  // under "on this machine" on a laptop that had none of it and no way to get
  // it. `ready: false` with nothing to name is neither an offer (there is no
  // download to point at) nor a block (the machine does not own it), so the
  // row keeps the tier where it can actually run.
  const rows = [imgRow("sensenova-u1-local")];
  markDesktopImageRows(rows, [{ key: "sensenova-u1", ready: false, missing: [] }],
                       { planner: true, engineUp: true }, keyOf);
  assert.equal(tierOf(rows[0]), "cloud");
  assert.equal((rows[0].capabilities as { desktop?: string }).desktop, undefined);
});

test("nobody has asked yet is not the same as nothing is installed", () => {
  // Null is the state before the first `desktop_render_models` lands, and off
  // the desktop entirely. Marking from an absent answer would put "download
  // it" on a row the pod can already run.
  const rows = [imgRow("qwen-edit-local")];
  markDesktopImageRows(rows, null, { planner: true, engineUp: true }, keyOf);
  assert.equal((rows[0].capabilities as { desktop?: string }).desktop, undefined);
});

test("only IMAGE rows are marked — the map's two sections are two id spaces", () => {
  const video = { ...imgRow("h3-local"), kind: "video" } as ModelCatalogRow;
  markDesktopImageRows([video], [{ key: "h3", ready: true, missing: [] }],
                       { planner: true, engineUp: true }, keyOf);
  assert.equal((video.capabilities as { desktop?: string }).desktop, undefined);
});

test("each image verdict is its own sentence, because each has its own fix", () => {
  const down = imageVerdict({ key: "k", ready: false, missing: ["a.safetensors", "b"] },
                            { planner: true, engineUp: true });
  assert.equal(down.mark, "offer");
  assert.equal(down.fix, "models");
  assert.match(down.why, /a\.safetensors/);

  const noPy = imageVerdict({ key: "k", ready: true, missing: [] },
                            { planner: false, engineUp: true });
  assert.equal(noPy.mark, "blocked");
  assert.match(noPy.why, /pipeline/);

  const asleep = imageVerdict({ key: "k", ready: true, missing: [] },
                              { planner: true, engineUp: false });
  assert.equal(asleep.mark, "blocked");
  assert.match(asleep.why, /start the engine/);

  assert.equal(imageVerdict({ key: "k", ready: true, missing: [] },
                            { planner: true, engineUp: true }).mark, "ready");
});

test("an un-downloaded image model stays on the tier it was already on", () => {
  // `offer` is not `blocked`: the weights are the big commitment, so the row
  // goes on working wherever it already worked and merely says it could run
  // here. An admin who wants the pod keeps the pod.
  const rows = [imgRow("qwen-edit-local")];
  markDesktopImageRows(rows, [{ key: "qwen-edit", ready: false, missing: ["x"] }],
                       { planner: true, engineUp: true }, keyOf);
  assert.equal(tierOf(rows[0]), "cloud");
});

/** Every catalogue id `gen_model_catalog.py` writes — the `row("id", …)`
 *  calls AND the tuple loops that feed one, which is where the Krea 2 and
 *  Klein rows live. Missing the second form silently under-reports. */
function catalogIds(): Set<string> {
  const src = fs.readFileSync(
    path.join(process.cwd(), "scripts/gen_model_catalog.py"), "utf8");
  return new Set([
    ...[...src.matchAll(/row\(\s*"([^"]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*\(\s*"([\w.-]+-local)",/gm)].map((m) => m[1]),
  ]);
}

/** Desktop image models that deliberately have no catalogue row, and why.
 *
 *  BOTH PREDATE THIS: the map is generated from the pod's, which carries
 *  entries the catalogue has never surfaced. They are named rather than
 *  tolerated by a loose assertion, so a NEW unreachable entry fails. */
const NO_CATALOG_ROW: Record<string, string> = {
  // The catalogue's own comment: plain Flux 2 has no reference path of any
  // kind, so listing it put a mode in the picker whose references the worker
  // staged and then rendered without. The row was removed; the map entry is
  // what `klein` and the Klein rows still resolve their shared files against.
  flux2: "no catalogue row — plain Flux 2 was removed for having no reference path",
  "hidream-o1": "no catalogue row — never surfaced on any picker",
};

test("the desktop map's image entries name catalogue rows that exist", () => {
  // THE JOIN IS BY `modelKeyOf`, and nothing else checks it. An entry whose
  // key no catalogue id reduces to is a model this machine can render and no
  // picker can offer — silent, because an unmarked row simply reads as the
  // studio's.
  const map = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "infra/model_map.desktop.json"), "utf8"));
  const keys = Object.keys(map.desktop?.image_models ?? {});
  assert.ok(keys.length, "the desktop map carries no image models at all");
  const ids = catalogIds();
  assert.ok(ids.size > 20, "the catalog-id scanner is broken");
  const unreachable = keys.filter(
    (k) => !ids.has(k) && !ids.has(`${k}-local`) && !(k in NO_CATALOG_ROW));
  assert.deepEqual(unreachable, [],
    "these desktop image models have no catalogue row to mark");
  // And the exemptions are still real: one that grew a row should come off
  // the list rather than sitting there claiming it has none.
  for (const [k, why] of Object.entries(NO_CATALOG_ROW)) {
    assert.ok(!ids.has(k) && !ids.has(`${k}-local`),
      `${k} has a catalogue row now — drop it from NO_CATALOG_ROW (${why})`);
  }
});

test("no desktop image entry names zero weight files", () => {
  // The generator drops one, because the file check would pass VACUOUSLY —
  // every file present, since there are none to look for. This is the same
  // rule the Rust backstop applies, asserted against the map that ships.
  const map = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "infra/model_map.desktop.json"), "utf8"));
  const WEIGHT = /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i;
  const named = (v: unknown): boolean =>
    typeof v === "string" ? WEIGHT.test(v)
    : Array.isArray(v) ? v.some(named)
    : !!v && typeof v === "object" ? Object.values(v as object).some(named)
    : false;
  for (const [key, entry] of Object.entries(map.desktop?.image_models ?? {})) {
    const e = entry as { from_model?: string };
    assert.ok(named(entry) || typeof e.from_model === "string",
      `${key} names no weight file and inherits none — it cannot be judged`);
  }
});

test("the catalogue rows the map DOES reach are the ones a plan can draw with", () => {
  // The point of the join, stated as the list it produces: these are the ids
  // the wizard's sheet picker can mark "on this machine". An empty result
  // would mean the mark can never fire and the local tier never appears.
  const map = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "infra/model_map.desktop.json"), "utf8"));
  const ids = catalogIds();
  const reachable = Object.keys(map.desktop?.image_models ?? {})
    .filter((k) => ids.has(k) || ids.has(`${k}-local`));
  assert.ok(reachable.length >= 3,
    `only ${reachable.length} desktop image model(s) reach a catalogue row: `
    + reachable.join(", "));
});

test("a ready row says which rung it will actually load, an offer does not", () => {
  // SAID RATHER THAN SILENT. `apply_rungs` lets a machine holding Klein 4B at
  // Q4_K_M satisfy an entry naming the fp8 — which is the whole point of the
  // rung table — but a row reading "on this machine" over weights the map does
  // not name is the substitution this codebase treats as a bug everywhere else.
  const row = () => ({
    id: "flux2-klein-4b-local", provider: "local", kind: "image",
    enabled: true, capabilities: {},
  }) as unknown as ModelCatalogRow;
  const keyOf = (id: string) => id.replace(/-local$/, "");

  const ready = row();
  markDesktopImageRows([ready],
    [{ key: "flux2-klein-4b", ready: true, missing: [], rung: "klein4b-q4" }],
    { planner: true, engineUp: true }, keyOf);
  // The LABEL, not the id — `klein4b-q4` is what the map keys on and "Q4_K_M"
  // is what anyone calls the file.
  assert.equal((ready.capabilities as Record<string, unknown>).desktopRung, "Q4_K_M");

  // An OFFER names a rung nothing is going to render on — the row stays on the
  // studio's tier — so claiming one would be a statement about this machine
  // that is not true.
  const offered = row();
  markDesktopImageRows([offered],
    [{ key: "flux2-klein-4b", ready: false, missing: ["x.safetensors"], rung: "klein4b-q4" }],
    { planner: true, engineUp: true }, keyOf);
  assert.equal((offered.capabilities as Record<string, unknown>).desktopRung, undefined);

  // And the common case — rendering on the rung the map declares — says
  // nothing at all rather than repeating the default back.
  const plain = row();
  markDesktopImageRows([plain],
    [{ key: "flux2-klein-4b", ready: true, missing: [] }],
    { planner: true, engineUp: true }, keyOf);
  assert.equal((plain.capabilities as Record<string, unknown>).desktopRung, undefined);
});

/* ── the node packs an image row's graph needs ───────────────────────────── */

test("every image entry that needs a node pack is in IMAGE_PACKS", () => {
  // WEIGHTS ON DISK IS NOT AVAILABILITY, and this is the direction that
  // actually bites: an entry that needs a pack and is NOT listed here reads
  // READY off the map, the wizard offers it, and every face and master plate
  // of the episode dies on `missing_node_type` — with the derived sheets and
  // every panel cascading behind. Measured on a real one-shot: 7 real
  // failures and 111 dependents, all queued before a single sheet had been
  // looked at.
  //
  // The shapes are the generator's own (`needsAPack` in
  // gen_desktop_model_map.mjs): a `pdd` block, a non-`plain` distillation, the
  // LTX reference guide, or a GGUF file — read off the ENTRY and, because an
  // image entry routinely inherits its checkpoint, off `from_model` too.
  const map = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "infra/model_map.desktop.json"), "utf8"));
  const d = map.desktop ?? {};
  const images: Record<string, Record<string, unknown>> = d.image_models ?? {};
  const videos: Record<string, Record<string, unknown>> = d.models ?? {};
  assert.ok(Object.keys(images).length > 3, "the image-entry scanner is broken");

  const needsPack = (key: string, depth = 0): boolean => {
    const e = images[key] ?? videos[key];
    if (!e || depth > 4) return false;
    if (e.pdd) return true;
    if (e.turbo_lora && e.turbo_apply !== "plain") return true;
    if (e.msr || e.msr_lora) return true;
    // The entry's OWN files only — a `_rungs` swap introduces a GGUF just for
    // the rung that names it, which is `packsFor`'s question rather than this
    // table's. Stripping them is what keeps the two from claiming each other's
    // job.
    const own = { ...e };
    delete (own as Record<string, unknown>)._rungs;
    if (JSON.stringify(own).includes(".gguf")) return true;
    return typeof e.from_model === "string" && needsPack(e.from_model, depth + 1);
  };

  for (const key of Object.keys(images)) {
    const listed = key in IMAGE_PACKS;
    assert.equal(listed, needsPack(key),
      listed
        ? `${key} is in IMAGE_PACKS and its map entry needs no pack — a row `
          + "blocked for a pack nobody has to install is unpickable forever"
        : `${key} needs a custom node pack and is not in IMAGE_PACKS — it will `
          + "read READY and fail inside ComfyUI");
  }
});

test("a missing pack blocks the row rather than letting it read ready", () => {
  const m = { key: "h3-image-pdd", ready: true, missing: [] };
  const up = { planner: true, engineUp: true };
  // Installed: it renders here.
  assert.equal(imageVerdict(m, { ...up, nodes: [...IMAGE_PACKS["h3-image-pdd"]] }).mark,
               "ready");
  // Absent: blocked, and the fix is the engine window rather than a download —
  // the weights are already on disk.
  const gone = imageVerdict(m, { ...up, nodes: [] });
  assert.equal(gone.mark, "blocked");
  assert.equal(gone.fix, "engine");
  assert.match(gone.why, /ComfyUI-MiniMax-H3-PDD-Acc/);
  // A pack that would not INSTALL has a different fix from one never
  // installed, so it gets a different sentence.
  const broke = imageVerdict(m, { ...up, nodes: [], nodesBroken: [...IMAGE_PACKS["h3-image-pdd"]] });
  assert.match(broke.why, /would not install/);
});

test("a row that needs no pack is unaffected, and null nodes judge nothing", () => {
  const up = { planner: true, engineUp: true };
  assert.equal(imageVerdict({ key: "qwen-edit", ready: true, missing: [] },
                            { ...up, nodes: [] }).mark, "ready");
  // Before the first status lands `nodes` is null — "nobody has asked", not
  // "nothing is installed". Blocking on it would flicker every pack-bearing
  // row on every open.
  assert.equal(imageVerdict({ key: "h3-image-pdd", ready: true, missing: [] },
                            { ...up, nodes: null }).mark, "ready");
});

test("missing FILES still outrank a missing pack", () => {
  // The order is `markFor`'s: a download is the bigger commitment and is an
  // OFFER, so a row with neither says the useful thing rather than sending
  // someone to reinstall an engine that could not run it anyway.
  const v = imageVerdict({ key: "h3-image-pdd", ready: false, missing: ["a.safetensors"] },
                         { planner: true, engineUp: true, nodes: [] });
  assert.equal(v.mark, "offer");
  assert.match(v.why, /a\.safetensors/);
});

/* ── the engine window asks the right question ───────────────────────────── */

// THE BUG THIS PINS shipped in 0.2.0 and was reported off a screenshot: the
// engine window's "Download only — cannot be rendered on this machine yet"
// banner was gated on `!localRecipe(fam.id)`, i.e. on whether `localGraphs.ts`
// has a TypeScript graph builder. MMAudio deliberately has none — it renders
// through the bundled pipeline instead — so the one family that runs the other
// way was the one family declared unrenderable, in a sentence that then named
// the two screens in this app that render it.
//
// Parsed rather than rendered because the claim is about WHICH FUNCTION the
// screen consults, and a DOM assertion would pass just as happily against the
// wrong one with a stubbed status.
test("the engine window judges a bundled family with markFor, not localRecipe", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "../components/modals/EngineModal.tsx"), "utf8",
  ).replace(/\r\n/g, "\n");

  assert.match(src, /import \{ markFor \} from "\.\.\/\.\.\/lib\/desktopRows"/,
    "EngineModal no longer imports the verdict it is supposed to render");

  // The `!localRecipe(...)` banner must be reachable only when the family is
  // NOT bundled. Anything else is the shipped bug returning.
  const gate = /\{fam\.bundled \?[\s\S]*?\}\)\(\) : !localRecipe\(fam\.id\) &&/;
  assert.match(src, gate,
    "the download-only banner is no longer gated on `fam.bundled` first");

  // And it must say something DIFFERENT for a bundled family — the whole
  // point is that "cannot be rendered here" was the false half.
  assert.ok(!/Download only[\s\S]{0,400}fam\.bundled/.test(src),
    "the download-only wording reaches a bundled family again");
});

test("every bundled family renders here when the machine is ready", () => {
  // The screen shows its banner on `blocked` only, so this is the property
  // that makes a ready machine silent: no bundled family may report a block
  // when everything it asked for is present.
  for (const fam of bundledFamilies()) {
    const v = markFor(fam, ctx());
    assert.ok(v, `${fam.id} returned no verdict on a ready machine`);
    assert.equal(v!.mark, "ready", `${fam.id} is ${v!.mark} on a ready machine: ${v!.why}`);
  }
});

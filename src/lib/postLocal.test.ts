// What each finishing pass needs before it can run on this machine.
//
// HALF OF THIS SUITE PARSES `worker/handlers/post.py`, and that is the point:
// the requirement table is a twin of that file's own `_require_nodes` calls and
// `load_map()` reads, and it fails in both directions. A requirement that has
// quietly stopped being one refuses a render that would have worked; one that
// has quietly started is the twenty-minute failure this module exists to
// prevent, which is much the worse of the two.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POST_OPS, POST_OPTIONS_DEFAULT, type PostOpId } from "./postChain.ts";
import { POST_PROCESS } from "./engineCatalog.ts";
import {
  gapLines, gapSentence, needsFor, postLocalGaps, type Inventory,
} from "./postLocal.ts";

const PY = readFileSync(new URL("../../worker/handlers/post.py", import.meta.url), "utf8");
const GRAPHS = readFileSync(new URL("../../worker/graphs.py", import.meta.url), "utf8");

/** Every class name the worker demands, from the three places it names one.
 *
 *  Over-broad on purpose: what is being caught is a name in OUR table that the
 *  worker never asks for, so a scan of every call is the cheapest way to be
 *  sure. `_require_nodes(...)` literals are most of it; the two node TUPLES in
 *  graphs.py are the rest, and the colour ones are only ever reached through
 *  `_color_match_node`, which resolves them against the live engine rather
 *  than passing them to `_require_nodes` — so a scan of post.py alone reports
 *  a correct entry as invented. */
const WORKER_NODES = new Set(
  [...PY.matchAll(/_require_nodes\(([^)]*)\)/g)]
    .flatMap((m) => [...m[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((q) => q[1])),
);
/** …plus the ones it builds into a `need` list before calling. */
for (const m of PY.matchAll(/need\s*\+?=\s*\[([^\]]*)\]/g)) {
  for (const q of m[1].matchAll(/"([A-Za-z0-9_]+)"/g)) WORKER_NODES.add(q[1]);
}
for (const name of ["COLOR_MATCH_NODES", "VCG_NODES"]) {
  const m = GRAPHS.match(new RegExp(`${name}\\s*=\\s*\\(([^)]*)\\)`));
  assert.ok(m, `worker/graphs.py no longer declares ${name}`);
  for (const q of m![1].matchAll(/"([A-Za-z0-9_]+)"/g)) WORKER_NODES.add(q[1]);
}

/** The model_map keys the file reads. */
const WORKER_MODELS = new Set(
  [...PY.matchAll(/\["(?:image_)?models"\]\["([a-z0-9.-]+)"\]/g)].map((m) => m[1]),
);

const EMPTY: Inventory = { files: new Set(), nodes: new Set(), models: new Map() };

/** A machine with everything the chain could want. */
function stocked(): Inventory {
  const files = new Set(POST_PROCESS.flatMap((t) => t.files.map((f) => f.filename)));
  const nodes = new Set([...WORKER_NODES, "ColorMatchV2", "VCGLoadModel",
                         "VCGGenerateLUT", "VCGApplyLUT"]);
  const models = new Map([
    ["ltx-25", { ready: true, missing: [] }],
    ["minimax-h3", { ready: true, missing: [] }],
    ["krea2", { ready: true, missing: [] }],
  ]);
  return { files, nodes, models };
}

const ALL_OPS = POST_OPS.map((o) => o.id);

/* ── the table against the worker ───────────────────────────────────────── */

test("every pass in the chain has a requirement entry", () => {
  // A pass with no entry is one this check silently lets through.
  for (const op of ALL_OPS) assert.ok(needsFor(op, POST_OPTIONS_DEFAULT));
});

test("every node the table names is one the worker really demands", () => {
  // Both grade methods, since the table branches on one.
  for (const op of ALL_OPS) {
    for (const opts of [POST_OPTIONS_DEFAULT,
                        { ...POST_OPTIONS_DEFAULT, post_grade_method: "vcg" as const }]) {
      for (const cls of needsFor(op, opts).nodes) {
        assert.ok(WORKER_NODES.has(cls),
          `${op} names ${cls}, which worker/handlers/post.py never requires`);
      }
    }
  }
});

test("every model_map key the table names is one the worker reads", () => {
  for (const op of ALL_OPS) {
    for (const key of needsFor(op, POST_OPTIONS_DEFAULT).models) {
      assert.ok(WORKER_MODELS.has(key),
        `${op} names model_map key ${key}, which post.py never loads`);
    }
  }
});

test("a pass the worker gates on nodes is gated here too", () => {
  // The direction that costs a render. Every `apply_*` with a `_require_nodes`
  // call has to contribute at least one class — otherwise a pass whose pack is
  // absent sails through this check and dies at render time.
  const gated = [...PY.matchAll(/def apply_([a-z0-9_]+)\(([\s\S]*?)(?=\ndef |\Z)/g)]
    .filter((m) => /_require_nodes\(/.test(m[2]))
    .map((m) => m[1])
    .filter((n) => (ALL_OPS as string[]).includes(n));
  assert.ok(gated.length >= 5, `only found ${gated.length} gated passes — did the parse break?`);
  for (const op of gated) {
    assert.ok(needsFor(op as PostOpId, POST_OPTIONS_DEFAULT).nodes.length > 0,
      `apply_${op} calls _require_nodes and the table asks for nothing`);
  }
});

test("every catalogue row the table names exists", () => {
  // `seedvr2-${id}` is derived from the settings id rather than being a second
  // table, so this is what keeps the derivation true.
  const ids = new Set(POST_PROCESS.map((t) => t.id));
  for (const m of ["3b", "7b", "7b-sharp"] as const) {
    for (const id of needsFor("upscale", { ...POST_OPTIONS_DEFAULT, post_upscale_model: m }).tools) {
      assert.ok(ids.has(id), `no catalogue row ${id}`);
    }
  }
  assert.ok(ids.has(needsFor("interpolate", POST_OPTIONS_DEFAULT).tools[0]));
});

/* ── the comparison ─────────────────────────────────────────────────────── */

test("a stocked machine reports nothing", () => {
  assert.deepEqual(postLocalGaps(ALL_OPS, POST_OPTIONS_DEFAULT, stocked()), []);
});

test("grain never needs anything", () => {
  // ffmpeg-only, and the place check already asked about ffmpeg.
  assert.deepEqual(postLocalGaps(["grain"], POST_OPTIONS_DEFAULT, EMPTY), []);
});

test("a missing SeedVR2 checkpoint is a DOWNLOAD, named and sized", () => {
  const inv = { ...stocked(), files: new Set<string>() };
  const [g] = postLocalGaps(["upscale"], POST_OPTIONS_DEFAULT, inv);
  assert.equal(g.op, "upscale");
  assert.equal(g.downloads.length, 1);
  assert.match(g.downloads[0].name, /SeedVR2 3B/);
  assert.ok(g.downloads[0].sizeMb > 3000);
  assert.equal(gapLines([g])[0].fixable, true);
});

test("the checkpoint follows the SETTING, not a constant", () => {
  const inv = { ...stocked(), files: new Set<string>() };
  const pick = (m: "3b" | "7b" | "7b-sharp") =>
    postLocalGaps(["upscale"], { ...POST_OPTIONS_DEFAULT, post_upscale_model: m }, inv)[0]
      .downloads[0].id;
  assert.equal(pick("3b"), "seedvr2-3b");
  assert.equal(pick("7b"), "seedvr2-7b");
  assert.equal(pick("7b-sharp"), "seedvr2-7b-sharp");
});

test("a shared file is counted once", () => {
  // The three SeedVR2 rows share one VAE. Summing per row would quote a
  // download half a gigabyte too big.
  const inv = { ...stocked(), files: new Set<string>() };
  const g = postLocalGaps(["upscale"], POST_OPTIONS_DEFAULT, inv)[0];
  const row = POST_PROCESS.find((t) => t.id === "seedvr2-3b")!;
  assert.equal(g.downloads[0].sizeMb,
    Math.round(row.files.reduce((n, f) => n + (f.size_mb ?? 0), 0)));
});

test("a half-fetched model_map entry says how much is left", () => {
  const inv: Inventory = { ...stocked(),
    models: new Map([["ltx-25", { ready: false, missing: ["a.safetensors", "b.safetensors"] }]]) };
  const [g] = postLocalGaps(["ltx_refine"], POST_OPTIONS_DEFAULT, inv);
  assert.equal(g.models[0].missing, 2);
  const line = gapLines([g])[0];
  assert.match(line.label, /LTX 2\.5/);
  assert.match(line.detail, /2 files missing/);
  assert.equal(line.fixable, true);
});

test("a model the desktop map does not carry is NOT offered as a download", () => {
  // A DROPPED entry and a not-yet-downloaded one are different states: the
  // generator drops an entry whose files the engine window cannot fetch, and a
  // Download button pointing at one of those is the refusal-with-nowhere-to-go
  // this whole pattern avoids. Krea 2 WAS that case until the generator learned
  // that its encoder is the same file under two names; the mechanism outlives
  // the example, so this states it with the model absent rather than naming a
  // model that is currently carried.
  const inv: Inventory = { ...stocked(), models: new Map() };
  const [g] = postLocalGaps(["ltx_refine"], POST_OPTIONS_DEFAULT, inv);
  assert.deepEqual(g.unsupported, ["ltx-25"]);
  assert.equal(g.models.length, 0);
  assert.equal(gapLines([g]).some((l) => l.fixable), false);
});

test("both face passes want the SAME detector, and it is one download", () => {
  // `apply_facefix` and `apply_h3_facefix` each default
  // `detector="bbox/face_yolov8m.pt"`, so a machine that has it can run either
  // — and one that does not can run neither, however many packs are installed.
  for (const op of ["facefix", "h3_facefix"] as const) {
    assert.deepEqual(needsFor(op, POST_OPTIONS_DEFAULT).tools, ["face-detector"]);
  }
  const inv = { ...stocked(), files: new Set<string>() };
  const gaps = postLocalGaps(["facefix", "h3_facefix"], POST_OPTIONS_DEFAULT, inv);
  assert.equal(gaps.length, 2);
  // Named once per pass, because the passes are what the reader turns off —
  // but it is the same row, so downloading it clears both.
  const ids = new Set(gaps.flatMap((g) => g.downloads.map((d) => d.id)));
  assert.deepEqual([...ids], ["face-detector"]);
});

test("two passes wanting one download list it ONCE", () => {
  // A chain with both face passes on named the detector twice, which reads as
  // a bug in the list rather than as two passes agreeing.
  const inv: Inventory = { ...stocked(), files: new Set<string>(), nodes: new Set() };
  const lines = gapLines(postLocalGaps(["facefix", "h3_facefix"], POST_OPTIONS_DEFAULT, inv));
  const detector = lines.filter((l) => /Face detector/.test(l.label));
  assert.equal(detector.length, 1);
  // …and the node lines, which are genuinely two different things, survive.
  assert.equal(lines.filter((l) => /ComfyUI nodes/.test(l.label)).length, 2);
});

test("the detector's default is the one the worker names", () => {
  // The filename is the CONTRACT between the catalogue row and the graph: the
  // pass passes `bbox/face_yolov8m.pt` straight into the node, so a row that
  // fetched `face_yolov8n.pt` would download 6MB and leave the dropdown empty.
  const row = POST_PROCESS.find((t) => t.id === "face-detector")!;
  assert.equal(row.files[0].filename, "face_yolov8m.pt");
  assert.equal(row.files[0].dir, "ultralytics/bbox");
  for (const py of [PY]) {
    assert.match(py, /detector="bbox\/face_yolov8m\.pt"/,
      "the worker no longer defaults to this detector");
  }
});

test("a missing node pack is reported and is NOT a download", () => {
  const inv: Inventory = { ...stocked(), nodes: new Set(["SeedVR2Preprocess"]) };
  const [g] = postLocalGaps(["h3_facefix"], POST_OPTIONS_DEFAULT, inv);
  assert.ok(g.nodes.length >= 4);
  assert.equal(g.downloads.length, 0);
  assert.equal(gapLines([g]).every((l) => !l.fixable), true);
});

test("either ColorMatch class satisfies the grade", () => {
  // `_color_match_node` prefers V2 and falls back, so demanding V2 alone would
  // refuse a perfectly good engine that has only the deprecated one.
  for (const cls of ["ColorMatchV2", "ColorMatch"]) {
    const inv: Inventory = { ...stocked(), nodes: new Set([cls]) };
    assert.deepEqual(postLocalGaps(["color_match"], POST_OPTIONS_DEFAULT, inv), []);
  }
});

test("the learned-LUT grade asks for its own pack", () => {
  const inv: Inventory = { ...stocked(), nodes: new Set(["ColorMatchV2"]) };
  const opts = { ...POST_OPTIONS_DEFAULT, post_grade_method: "vcg" as const };
  const [g] = postLocalGaps(["color_match"], opts, inv);
  assert.ok(g.nodes.includes("VCGLoadModel"));
});

test("a dead engine reports no NODE gap, because nothing was asked", () => {
  // "I could not look" and "it is absent" are different answers, and only one
  // of them should refuse a render. The place check already blocks a ComfyUI
  // chain on a dead engine, so this is not a hole.
  const inv: Inventory = { ...stocked(), nodes: null };
  assert.deepEqual(postLocalGaps(ALL_OPS, POST_OPTIONS_DEFAULT, inv), []);
  // …and a WEIGHT gap is still reported, because that question needs no engine.
  const dry: Inventory = { files: new Set(), nodes: null, models: new Map() };
  assert.ok(postLocalGaps(["upscale"], POST_OPTIONS_DEFAULT, dry).length === 1);
});

/* ── what it says ───────────────────────────────────────────────────────── */

test("the sentence names the passes, not the files", () => {
  // The post card is directly above, so which PASS is what the reader can act
  // on without leaving the modal.
  const inv = { ...stocked(), files: new Set<string>(),
                models: new Map([["ltx-25", { ready: false, missing: ["x"] }]]) };
  const s = gapSentence(postLocalGaps(["upscale", "ltx_refine"], POST_OPTIONS_DEFAULT, inv));
  assert.match(s, /Upscale and Refine/);
  assert.match(s, /do(es)? not have/);
  assert.doesNotMatch(s, /safetensors/);
});

test("the sentence agrees in number, both times", () => {
  // "Upscale need models" is what a reader notices before they notice what
  // the sentence is telling them.
  const one = { ...stocked(), files: new Set<string>() };
  assert.match(gapSentence(postLocalGaps(["upscale"], POST_OPTIONS_DEFAULT, one)),
    /^Upscale needs a model /);
  const many = { ...stocked(), files: new Set<string>(),
                 models: new Map([["ltx-25", { ready: false, missing: ["x"] }]]) };
  assert.match(gapSentence(postLocalGaps(["upscale", "ltx_refine"], POST_OPTIONS_DEFAULT, many)),
    /^Upscale and Refine need models /);
});

test("it distinguishes a download from something that cannot run here", () => {
  const dl = { ...stocked(), files: new Set<string>() };
  assert.match(gapSentence(postLocalGaps(["upscale"], POST_OPTIONS_DEFAULT, dl)),
    /needs a model/);
  const no: Inventory = { ...stocked(), nodes: new Set() };
  assert.match(gapSentence(postLocalGaps(["h3_facefix"], POST_OPTIONS_DEFAULT, no)),
    /cannot run on this machine/);
});

test("three passes read as a list", () => {
  const inv = { ...stocked(), files: new Set<string>(), nodes: new Set<string>() };
  const s = gapSentence(postLocalGaps(["upscale", "interpolate", "h3_facefix"],
                                      POST_OPTIONS_DEFAULT, inv));
  assert.match(s, /Upscale, Interpolate and Face Refine/);
});

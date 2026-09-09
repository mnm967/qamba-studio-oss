/**
 * ONE model-key table, pinned across the copies that cannot import it.
 *
 * `director/model_keys.js` is canonical — the hosted director imports it, and
 * so does the browser now (`src/lib/projectSettings.ts` re-exports it). Two
 * readers still cannot: `worker/director_tools.py` is Python, and
 * `scripts/gen_model_catalog.py` is the check that refuses to sync a catalog
 * whose derived keys miss their model_map entries. Both keep hand-written
 * copies, and both had drifted.
 *
 * MEASURED, not hypothetical: `h3-pdd-local` shipped with the PDD row on
 * 2026-08-30 into the TS copy and the sync script, and into NEITHER of the
 * other two. So `modelKeyOf("h3-pdd-local")` returned `h3-pdd` in the hosted
 * director and in the worker's twin — not a model_map key — and every
 * "re-render this block on PDD" asked through the director died with
 * `model 'h3-pdd' not available on tier 'aws'`. Nothing about the id looks
 * wrong, which is why it survived: the failure names a key nobody typed.
 *
 * The parser deliberately reads whole-line pairs rather than tracking quote
 * state — both files are full of apostrophes inside prose comments, and any
 * scanner that follows quotes swallows the file. The same trap
 * `tool_parity.test.mjs` documents.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_KEY_EXCEPTIONS, catalogIdOf, modelKeyOf } from "./model_keys.js";

// Normalised to LF: git's default on Windows is core.autocrlf=true and a
// regex `.` does not match `\r`, which makes a source-parsing test report
// "found 0" instead of failing.
const read = (rel) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Every `"catalog-id": "model-key"` pair inside the table that follows the
 *  named declaration, in either language — the literal shapes agree. */
function tableAfter(src, decl) {
  const at = src.indexOf(decl);
  assert.ok(at > 0, `${decl} is gone — did it move or get renamed?`);
  const body = src.slice(at, src.indexOf("\n}", at));
  const out = {};
  for (const m of body.matchAll(/"([a-z0-9.\-]+)"\s*:\s*"([a-z0-9.\-]+)"/g)) {
    out[m[1]] = m[2];
  }
  assert.ok(Object.keys(out).length > 3, `parsed ${decl} as almost empty`);
  return out;
}

const COPIES = {
  "worker/director_tools.py": tableAfter(
    read("../worker/director_tools.py"), "MODEL_KEY_EXCEPTIONS = {"),
  "scripts/gen_model_catalog.py": tableAfter(
    read("../scripts/gen_model_catalog.py"), "MODEL_KEY_EXCEPTIONS = {"),
};

for (const [where, table] of Object.entries(COPIES)) {
  test(`${where} carries the same table as director/model_keys.js`, () => {
    assert.deepEqual(table, MODEL_KEY_EXCEPTIONS,
      `${where} has drifted. Every id here translates a CATALOG id to a `
      + "model_map key; a missing row derives a key that is not a model and "
      + "the render dies naming a string nobody typed.");
  });
}

test("the browser does not keep a second copy any more", () => {
  const ts = read("../src/lib/projectSettings.ts");
  assert.doesNotMatch(ts, /const MODEL_KEY_EXCEPTIONS/,
    "src/lib/projectSettings.ts has re-declared the table — that is the "
    + "duplication this test exists to end; re-export from model_keys.js");
  assert.match(ts, /export \{[^}]*modelKeyOf[^}]*\} from "\.\.\/\.\.\/director\/model_keys\.js"/,
    "projectSettings no longer re-exports modelKeyOf — a dozen call sites "
    + "import it from there");
});

test("every H3 catalog id needs an entry, because the strip guesses wrong", () => {
  // `h3-pdd-local`.replace(/-local$/, "") is `h3-pdd`, and there is no such
  // model. That is true of the whole family, which is why the table exists.
  for (const [id, key] of Object.entries(MODEL_KEY_EXCEPTIONS)) {
    assert.notEqual(id.replace(/-local$/, ""), key,
      `${id} strips to its own key — it does not need a table entry`);
    assert.equal(modelKeyOf(id), key);
  }
  assert.equal(modelKeyOf("h3-pdd-local"), "minimax-h3-pdd");
});

test("a desktop model has no model_map key at all", () => {
  // model_map has never heard of a `local:` id, so the bare strip would hand
  // the worker `local:wan22-5b/Q6_K` — unresolvable. Dropping the key lets the
  // render fall back to the block's own pick instead of dying.
  assert.equal(modelKeyOf("local:wan22-5b/Q6_K"), undefined);
  assert.equal(modelKeyOf(""), undefined);
  assert.equal(modelKeyOf(null), undefined);
});

test("catalogIdOf prefers the stored catalog id, then inverts the key", () => {
  const catalog = [{ id: "h3-turbo-local" }, { id: "h3-pdd-local" }, { id: "h3-local" }];

  // 1. What PromptRefsModal wrote, exactly — no lookup, no guess.
  assert.equal(
    catalogIdOf({ model_id: "h3-pdd-local", model_key: "minimax-h3-pdd" }, catalog),
    "h3-pdd-local");

  // 2. A wizard-planned block stores the KEY only, and the table is not
  //    invertible by string surgery: "minimax-h3-turbo" -> "h3-turbo-local"
  //    is a lookup or it is nothing.
  assert.equal(catalogIdOf({ model_key: "minimax-h3-turbo" }, catalog), "h3-turbo-local");
  assert.equal(catalogIdOf({ model_key: "minimax-h3" }, catalog), "h3-local");

  // 3. A hand-added block (`add_block`) stores `{}` and renders on H3_MODEL —
  //    plain minimax-h3, 20 steps. The fallback has to name that, not throw.
  assert.equal(catalogIdOf({}, catalog), "h3-local");
  assert.equal(catalogIdOf(null, catalog), "h3-local");

  // 4. An unreadable catalog is bookkeeping degrading, never a failed retake.
  assert.equal(catalogIdOf({ model_key: "minimax-h3-pdd" }, []), "h3-local");
  assert.equal(catalogIdOf({ model_key: "minimax-h3-pdd" }, null), "h3-local");

  // 5. A key nothing in the catalog claims — a model_map entry with no row —
  //    falls back rather than inventing an id.
  assert.equal(catalogIdOf({ model_key: "minimax-h3-nonesuch" }, catalog), "h3-local");
});

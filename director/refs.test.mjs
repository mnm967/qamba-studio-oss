import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REF_BASE, blockRef, sceneRef, shotRef,
         blockRefToIdx, sceneRefToIdx, shotRefToIdx, refToIdx } from "./refs.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("all three ref kinds count from the same base", () => {
  // The bug this module exists for: scenes and shots were 1-indexed while
  // BLOCKS were 0-indexed, so `b6` meant the seventh block and the sixth shot
  // on the same screen. Asked to "redo block 6 and seven" on a seven-block
  // storyboard, the director re-rendered one block and reported success —
  // b0..b6 has no b7 and nothing said so.
  assert.equal(blockRef(0), "b1");
  assert.equal(shotRef(0), "b1");
  assert.equal(sceneRef(0), "S1");
  assert.equal(blockRef(6), "b7");
});

test("a ref round-trips to the idx it names", () => {
  for (const idx of [0, 1, 5, 42]) {
    assert.equal(blockRefToIdx(blockRef(idx)), idx);
    assert.equal(shotRefToIdx(shotRef(idx)), idx);
    assert.equal(sceneRefToIdx(sceneRef(idx)), idx);
  }
});

test("a non-ref is null, not NaN", () => {
  // The caller has to tell "not a ref, try a slug or a uuid" from "a ref that
  // matched nothing" — those want different errors, and conflating them is how
  // a bad ref used to surface as a raw Postgres 22P02.
  for (const bad of ["", null, undefined, "THE_LESSON", "abc", "b", "b-1"]) {
    assert.equal(blockRefToIdx(bad), null, JSON.stringify(bad));
  }
  assert.equal(refToIdx("b0"), null, "b0 is below the base — not a valid ref");
});

test("the bare number form works, since people type it", () => {
  assert.equal(blockRefToIdx("7"), 6);
  assert.equal(sceneRefToIdx("3"), 2);
});

test("the python twin declares the same base", () => {
  // director_tools.py mirrors this module; a base that disagrees would make the
  // local/uncensored backend name a different block than the hosted one.
  const py = fs.readFileSync(path.join(ROOT, "worker", "director_tools.py"), "utf8")
               .replace(/\r\n/g, "\n");
  const m = py.match(/^REF_BASE = (\d+)$/m);
  assert.ok(m, "worker/director_tools.py must declare REF_BASE");
  assert.equal(Number(m[1]), REF_BASE);
});

test("no surface still builds a 0-indexed block ref by hand", () => {
  // Every label must go through this module (or its python twin). A stray
  // `b${b.idx}` is a surface that names blocks one lower than every other one.
  const roots = ["src", "worker", "director"];
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs|py)$/.test(e.name)) continue;
      if (/\.test\.|test_/.test(e.name)) continue;
      const txt = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
      for (const [i, ln] of txt.split("\n").entries()) {
        // a template/f-string/JSX expression that pastes idx straight after a
        // bare "b".
        //
        // Case-INSENSITIVE and camelCase-aware: `b${atIdx}` slipped past a
        // `\bidx\b` scan (capital I, no word boundary) and shipped a
        // 0-indexed label out of add_block, which is exactly the class this
        // guard exists for.
        //
        // …and the THIRD spelling is JSX TEXT — `b{b.idx}`, no backtick and no
        // `$`. StoryboardView rendered `BLOCK b{g.block.idx}` and `b{b.idx}`
        // for the feature's whole life, so the one page the storyboard is read
        // off named every block one lower than the director, the queue labels
        // and every script — while this guard reported clean, because it only
        // ever looked for the two interpolations that carry a sigil.
        if (/`b\$\{[^}]*[Ii]dx\b[^}+]*\}/.test(ln)
            || /f"b\{[^}]*[Ii]dx\b[^}+]*\}/.test(ln)
            // JSX: a bare `b` then `{ … idx }`, not preceded by an identifier
            // character (so `blockRef(b.idx)` and `numb{…}` do not match).
            || /(^|[^A-Za-z0-9_$`])b\{[^}]*[Ii]dx\b[^}+]*\}/.test(ln)) {
          bad.push(`${path.relative(ROOT, p)}:${i + 1}`);
        }
      }
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  assert.deepEqual(bad, [], "these build a block ref without the shared base");
});

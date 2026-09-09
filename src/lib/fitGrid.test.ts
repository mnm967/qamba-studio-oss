// The whole point of this module is that a picture is never cropped and never
// stretched, so every test asserts the cell's own ratio as well as its fit.
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AR, aspectOf, fitBox, fitGrid } from "./fitGrid.ts";

const WIDE = 16 / 9;
const ratio = (f: { w: number; h: number }) => f.w / f.h;
/** Rounding is to whole pixels, so a cell's ratio lands near, not on, its aim. */
const near = (a: number, b: number, tol = 0.02) =>
  assert.ok(Math.abs(a - b) < tol, `${a} is not within ${tol} of ${b}`);

test("a cell keeps the media's aspect ratio, whatever shape the box is", () => {
  for (const box of [{ w: 620, h: 970 }, { w: 300, h: 120 }, { w: 1000, h: 1000 }]) {
    for (const n of [1, 2, 3, 4]) {
      const f = fitGrid(box, n, WIDE, 8);
      near(ratio(f), WIDE);
      assert.ok(f.w > 0 && f.h > 0, `no cell for ${n} in ${box.w}x${box.h}`);
    }
  }
});

test("the cells fit inside the box, gaps included", () => {
  const box = { w: 620, h: 970 };
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const f = fitGrid(box, n, WIDE, 8);
    assert.ok(f.cols * f.w + 8 * (f.cols - 1) <= box.w + 1, `too wide for n=${n}`);
    assert.ok(f.rows * f.h + 8 * (f.rows - 1) <= box.h + 1, `too tall for n=${n}`);
    assert.ok(f.cols * f.rows >= n, `only ${f.cols}x${f.rows} tracks for n=${n}`);
  }
});

// This is the bug the module exists for: two 16:9 takes side by side in a tall
// narrow column gave each a cell far taller than it was wide, so `cover` cut
// the picture to a strip. Stacked, each is more than twice the size.
test("two wide takes in a tall column stack rather than sitting side by side", () => {
  const f = fitGrid({ w: 620, h: 970 }, 2, WIDE, 8);
  assert.equal(f.cols, 1);
  assert.equal(f.rows, 2);
  assert.ok(f.w > 600, `stacked cells should span the column, got ${f.w}`);
});

test("a wide short box lays the same two takes out side by side", () => {
  const f = fitGrid({ w: 1200, h: 260 }, 2, WIDE, 8);
  assert.equal(f.cols, 2);
  assert.equal(f.rows, 1);
});

test("four takes take the arrangement that makes the picture biggest", () => {
  // A near-square box: 2x2 beats both 1x4 and 4x1.
  const f = fitGrid({ w: 800, h: 800 }, 4, WIDE, 8);
  assert.equal(f.cols, 2);
  assert.equal(f.rows, 2);
  const flat = fitGrid({ w: 2000, h: 200 }, 4, WIDE, 8);
  assert.equal(flat.cols, 4);
});

test("a portrait render gets a portrait cell, not a rotated one", () => {
  const f = fitGrid({ w: 620, h: 970 }, 2, 9 / 16, 8);
  near(ratio(f), 9 / 16);
  assert.ok(f.h > f.w);
});

test("nothing to lay out, or nowhere to lay it out, is zero and not a crash", () => {
  assert.deepEqual(fitGrid({ w: 620, h: 400 }, 0, WIDE, 8), { cols: 0, rows: 0, w: 0, h: 0 });
  assert.deepEqual(fitGrid({ w: 0, h: 0 }, 2, WIDE, 8), { cols: 0, rows: 0, w: 0, h: 0 });
  // A gap wider than the box leaves no room for any arrangement.
  assert.equal(fitGrid({ w: 10, h: 10 }, 4, WIDE, 40).cols, 0);
});

test("fitBox is the single-picture case and never overflows either axis", () => {
  near(ratio(fitBox({ w: 700, h: 970 }, WIDE)), WIDE);
  const tall = fitBox({ w: 700, h: 200 }, WIDE);
  assert.equal(tall.h, 200);                      // height-bound
  assert.ok(tall.w <= 700);
  const wide = fitBox({ w: 300, h: 970 }, WIDE);
  assert.equal(wide.w, 300);                      // width-bound
});

test("aspectOf refuses a dimension it cannot believe", () => {
  assert.equal(aspectOf(1280, 720), 1280 / 720);
  assert.equal(aspectOf(null, 720), DEFAULT_AR);
  assert.equal(aspectOf(1280, 0), DEFAULT_AR);
  assert.equal(aspectOf(undefined, undefined), DEFAULT_AR);
  assert.equal(aspectOf(1280, 1), DEFAULT_AR);    // a corrupt probe, not a banner
  assert.equal(aspectOf(0, 0, 1), 1);             // caller's own fallback wins
});

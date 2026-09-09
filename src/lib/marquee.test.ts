// node --test src/lib/marquee.test.ts
//
// The rubber band. Every case here fails SILENTLY in the editor: a band that
// takes one clip too few reads as a drag the user drew badly, a selection
// holding a dead id is a clip that lights up and cannot be found, and a group
// drag clamped per clip piles a selection up on top of itself at zero with
// nothing to say it happened.
import test from "node:test";
import assert from "node:assert/strict";
import {
  clipsInMarquee, edgeScroll, groupMove, isDrag, mergeSelection, normalizeRect,
  MARQUEE_MIN_PX,
} from "./marquee.ts";

const clip = (id: string, track_id: string, t_start_ms: number, duration_ms: number) =>
  ({ id, track_id, t_start_ms, duration_ms }) as never;

const CLIPS = [
  clip("a", "V1", 0, 1000),
  clip("b", "V1", 1000, 1000),      // back to back with a
  clip("c", "V1", 5000, 2000),
  clip("d", "A1", 500, 4000),
];

test("a band TOUCHES rather than contains", () => {
  // The whole point: at fit zoom one shot is routinely wider than the drag.
  const hit = clipsInMarquee(CLIPS, [{ trackId: "V1", fromMs: 5500, toMs: 5600 }]);
  assert.deepEqual(hit, ["c"]);
});

test("a band ending exactly on a join takes the clip it is over, not both", () => {
  // `overlaps` is half-open, so two clips back to back are never both taken.
  assert.deepEqual(clipsInMarquee(CLIPS, [{ trackId: "V1", fromMs: 200, toMs: 1000 }]), ["a"]);
  assert.deepEqual(clipsInMarquee(CLIPS, [{ trackId: "V1", fromMs: 1000, toMs: 1200 }]), ["b"]);
});

test("a band spans several lanes, and only the lanes it names", () => {
  const hit = clipsInMarquee(CLIPS, [
    { trackId: "V1", fromMs: 0, toMs: 9000 },
    { trackId: "A1", fromMs: 0, toMs: 9000 },
  ]);
  assert.deepEqual(hit, ["a", "b", "c", "d"]);
  assert.deepEqual(
    clipsInMarquee(CLIPS, [{ trackId: "A1", fromMs: 0, toMs: 9000 }]),
    ["d"],
  );
});

test("a zero-width band takes nothing — a click is not a marquee", () => {
  assert.deepEqual(clipsInMarquee(CLIPS, [{ trackId: "V1", fromMs: 700, toMs: 700 }]), []);
  assert.deepEqual(clipsInMarquee(CLIPS, []), []);
});

test("the hit order follows the clip list, so the primary is stable", () => {
  // The component takes the LAST id as the primary. Ordering by the pointer's
  // path instead would move the inspector depending on which corner the drag
  // started from, for the same rectangle.
  const band = [{ trackId: "V1", fromMs: 0, toMs: 9000 }];
  assert.deepEqual(clipsInMarquee(CLIPS, band), clipsInMarquee([...CLIPS].reverse(), band).reverse());
});

test("replace, add and toggle", () => {
  assert.deepEqual(mergeSelection(["a", "b"], ["c"], "replace"), ["c"]);
  assert.deepEqual(mergeSelection(["a", "b"], ["b", "c"], "add"), ["a", "b", "c"]);
  // Toggle is the one gesture that can take something back OUT.
  assert.deepEqual(mergeSelection(["a", "b"], ["b"], "toggle"), ["a"]);
  assert.deepEqual(mergeSelection(["a"], ["b"], "toggle"), ["a", "b"]);
});

test("a shift-drag never REMOVES what it crosses", () => {
  // Additive, not toggling: a rubber band that deselected clips the user could
  // not see under their own pointer is the opposite of what shift means here.
  assert.deepEqual(mergeSelection(["a", "b"], ["a", "c"], "add"), ["a", "b", "c"]);
});

test("a rectangle is the same box drawn from any corner", () => {
  const a = normalizeRect({ x: 10, y: 10 }, { x: 40, y: 30 });
  const b = normalizeRect({ x: 40, y: 30 }, { x: 10, y: 10 });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { x: 10, y: 10, w: 30, h: 20 });
});

test("a click is not a drag", () => {
  assert.equal(isDrag(0, 0), false);
  assert.equal(isDrag(MARQUEE_MIN_PX - 1, MARQUEE_MIN_PX - 1), false);
  assert.equal(isDrag(0, MARQUEE_MIN_PX), true);
  assert.equal(isDrag(-MARQUEE_MIN_PX, 0), true);
});

test("a group drag is RIGID — one clamp for the whole set", () => {
  const movers = [
    { id: "a", t_start_ms: 1000 },
    { id: "b", t_start_ms: 4000 },
  ] as never as { id: string; t_start_ms: number }[];
  // Asked for -3000, the earliest clip can only give 1000. Both move 1000, so
  // the 3000ms gap between them survives. Clamping per clip would put `a` at 0
  // and `b` at 1000 — a two-second gap silently closed.
  assert.deepEqual(groupMove(movers, -3000), [
    { id: "a", t_start_ms: 0 },
    { id: "b", t_start_ms: 3000 },
  ]);
  assert.deepEqual(groupMove(movers, 500), [
    { id: "a", t_start_ms: 1500 },
    { id: "b", t_start_ms: 4500 },
  ]);
  assert.deepEqual(groupMove([], -1), []);
});

// ── the edge auto-scroll ─────────────────────────────────────────────────────
// Tested here rather than in the component because the loop that drives it is
// rAF, and a page that does not composite never fires one — so this is the only
// place the decision can be exercised at all.
const BOX = { left: 100, right: 900, top: 200, bottom: 500 };

test("a pointer in the middle scrolls nothing", () => {
  assert.deepEqual(edgeScroll({ x: 500, y: 350 }, BOX), { dx: 0, dy: 0 });
});

test("each edge scrolls its own way, and corners do both", () => {
  assert.deepEqual(edgeScroll({ x: 895, y: 350 }, BOX), { dx: 18, dy: 0 });
  assert.deepEqual(edgeScroll({ x: 110, y: 350 }, BOX), { dx: -18, dy: 0 });
  assert.deepEqual(edgeScroll({ x: 500, y: 205 }, BOX), { dx: 0, dy: -18 });
  assert.deepEqual(edgeScroll({ x: 500, y: 495 }, BOX), { dx: 0, dy: 18 });
  assert.deepEqual(edgeScroll({ x: 895, y: 495 }, BOX), { dx: 18, dy: 18 });
});

test("the LEFT trigger zone starts after the sticky lane labels", () => {
  // Without the inset the zone sits under the label column, so the slab runs
  // away before the pointer has reached anything the band can be seen against.
  const inset = { leftInset: 120 };
  assert.deepEqual(edgeScroll({ x: 200, y: 350 }, BOX, inset), { dx: -18, dy: 0 });
  assert.deepEqual(edgeScroll({ x: 200, y: 350 }, BOX), { dx: 0, dy: 0 });
  // and the right edge is unaffected by it
  assert.deepEqual(edgeScroll({ x: 895, y: 350 }, BOX, inset), { dx: 18, dy: 0 });
});

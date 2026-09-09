// An assembly is an ordered list of slices, so the safety story moved: nothing
// has to tile anything any more, and what would now be silent in the rendered
// file is a slice that names a moment its take does not have, a length the two
// halves of the studio disagree about, or an order that quietly re-sorts
// itself. Every operation is checked against that, and so is the auto-planner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FIT_EPS, MIN_SEGMENT_MS, SWITCH_COST, autoAssemble, coalesce, cutTimeNear, cutTimeOf, cutWarnings, cuts,
  evidenceFromReview, fitToBlock, indexAt, insertIndexAt, insertSlice, isSingleTake, isValid, layout,
  moveBoundary, moveSegment, placedAt, removeSegment, setSegmentTake, shotLabel, shotSpans,
  sliceMs, spanScore, splitAt, srcAt, takesUsed, tile, totalMs, trimSegment, wholeTakeId,
  type Segment, type TakeEvidence,
} from "./assembly.ts";

const D = 14000;
const one = tile("t1", D);
const slice = (t: string, a: number, b: number): Segment => ({ take_id: t, in_ms: a, out_ms: b });

const ev = (id: string, o: Partial<TakeEvidence> = {}): TakeEvidence =>
  ({ take_id: id, overall: 0.8, lines: [], bad: [], global: [], ...o });

test("a fresh assembly is the whole of one take", () => {
  assert.deepEqual(one, [{ take_id: "t1", in_ms: 0, out_ms: 14000 }]);
  assert.ok(isValid(one, D));
  assert.equal(totalMs(one), D);
  assert.equal(wholeTakeId(one, D), "t1");
});

test("every assembly written under the tiling model reads identically", () => {
  // The compatibility claim the whole change rests on: a gapless tiling laid
  // end to end in order IS the sequence of source windows it already was, so
  // no stored row means something different now than it did.
  const legacy = [slice("t1", 0, 5200), slice("t2", 5200, 8700), slice("t1", 8700, 14000)];
  assert.ok(isValid(legacy, D));
  for (const p of layout(legacy)) {
    assert.equal(p.t0_ms, p.in_ms, "cut time still equals source time");
    assert.equal(p.t1_ms, p.out_ms);
  }
  for (const t of [0, 5199, 5200, 8699, 8700, 13999]) assert.equal(srcAt(legacy, t), t);
});

// ---------------------------------------------------------------- editing ---

test("a piece goes wherever it is dropped and everything after it ripples", () => {
  const next = insertSlice(one, slice("t2", 2000, 3500), 0);
  assert.deepEqual(next, [
    { take_id: "t2", in_ms: 2000, out_ms: 3500 },
    { take_id: "t1", in_ms: 0, out_ms: 14000 },
  ]);
  // it plays FIRST, at its own length, and the cut grew by exactly that much
  const [a, b] = layout(next);
  assert.deepEqual([a.t0_ms, a.t1_ms], [0, 1500]);
  assert.deepEqual([b.t0_ms, b.t1_ms], [1500, 15500]);
  assert.equal(totalMs(next), D + 1500);
  assert.ok(isValid(next));
  // and at the end, which is where an append lands
  assert.equal(layout(insertSlice(one, slice("t2", 0, 1000)))[1].t0_ms, D);
});

test("the same moment of one take can be used twice, in either order", () => {
  // Not expressible at all under the tiling: the second copy would have had to
  // overwrite the first.
  const beat = slice("t1", 4000, 6000);
  // Back to back it is a HOLD, and it must survive coalesce: only pieces that
  // are continuous in their take (`prev.out === next.in`) are one piece, and
  // two copies of one window are not — they are the same two seconds twice.
  const twice = insertSlice(insertSlice([], beat, 0), { ...beat }, 1);
  assert.equal(twice.length, 2);
  assert.equal(totalMs(twice), 4000);
  const apart = insertSlice(insertSlice([], beat, 0), slice("t2", 0, 2000), 1);
  const back = insertSlice(apart, { ...beat }, 2);
  assert.deepEqual(back.map((s) => s.take_id), ["t1", "t2", "t1"]);
  assert.equal(totalMs(back), 6000);
});

test("moveSegment reorders, and a drop where it already is changes nothing", () => {
  const three = [slice("t1", 0, 4000), slice("t2", 4000, 7000), slice("t3", 7000, 9000)];
  assert.deepEqual(moveSegment(three, 2, 0).map((s) => s.take_id), ["t3", "t1", "t2"]);
  assert.deepEqual(moveSegment(three, 0, 3).map((s) => s.take_id), ["t2", "t3", "t1"]);
  // `to` is an insertion index in the ORIGINAL list, so both spellings of
  // "leave it alone" are no-ops rather than an off-by-one shuffle
  assert.equal(moveSegment(three, 1, 1), three);
  assert.equal(moveSegment(three, 1, 2), three);
  assert.equal(moveSegment(three, 9, 0), three);
  // the cut is the same length however it is ordered
  assert.equal(totalMs(moveSegment(three, 2, 0)), totalMs(three));
});

test("removing a piece closes up behind it — there are no gaps to leave", () => {
  const three = [slice("t1", 0, 4000), slice("t2", 4000, 7000), slice("t3", 7000, 9000)];
  const gone = removeSegment(three, 1);
  assert.deepEqual(gone.map((s) => s.take_id), ["t1", "t3"]);
  assert.deepEqual(layout(gone).map((p) => p.t0_ms), [0, 4000]);
  assert.equal(totalMs(gone), 6000);
  assert.equal(removeSegment(three, 7), three);
});

test("trimming a piece ripples, and cannot run off either end of its take", () => {
  const two = [slice("t1", 0, 6000), slice("t2", 2000, 5000)];
  const later = trimSegment(two, 0, { in_ms: 1000 });
  assert.equal(later[0].in_ms, 1000);
  assert.equal(totalMs(later), 8000, "the cut got shorter by what was trimmed");
  assert.equal(layout(later)[1].t0_ms, 5000, "and the piece after it moved with it");
  // a take is only so long: `maxMs` is the media's own length
  assert.equal(trimSegment(two, 1, { out_ms: 99000 }, 8000)[1].out_ms, 8000);
  // and neither edge may cross the other
  assert.equal(trimSegment(two, 0, { in_ms: 5900 })[0].in_ms, 6000 - MIN_SEGMENT_MS);
  assert.equal(trimSegment(two, 0, { out_ms: 10 })[0].out_ms, MIN_SEGMENT_MS);
  assert.equal(trimSegment(two, 0, { in_ms: -500 })[0].in_ms, 0);
});

test("moveBoundary is a ROLL: one piece gives up what the other takes", () => {
  const s = [slice("t1", 0, 5000), slice("t2", 5000, 9000), slice("t1", 9000, 14000)];
  const moved = moveBoundary(s, 0, 3000);
  assert.equal(moved[0].out_ms, 3000);
  assert.equal(moved[1].in_ms, 3000);
  assert.equal(totalMs(moved), totalMs(s), "a roll never changes the length");
  assert.equal(cuts(moved)[0], 3000);
  // dragging past the neighbouring cut clamps to a legal minimum piece
  assert.equal(moveBoundary(s, 0, 13000)[0].out_ms, 9000 - MIN_SEGMENT_MS);
  assert.equal(moveBoundary(s, 0, -500)[0].out_ms, MIN_SEGMENT_MS);
  // …and it may not roll a piece past the end of its own media
  const capped = moveBoundary([slice("t1", 0, 5000), slice("t2", 5000, 9000)], 0, 6000,
                              (id) => (id === "t1" ? 5400 : 14000));
  assert.equal(capped[0].out_ms, 5400);
});

test("splitAt cuts the piece under the playhead in two, and they stay apart", () => {
  const s = splitAt(one, 6000);
  assert.deepEqual(s, [
    { take_id: "t1", in_ms: 0, out_ms: 6000 },
    { take_id: "t1", in_ms: 6000, out_ms: 14000, note: undefined },
  ]);
  // the halves are contiguous in source, so coalesce WOULD merge them back —
  // splitting is a deliberate act and must survive its own bookkeeping
  assert.equal(splitAt(one, 6000).length, 2);
  assert.equal(totalMs(s), D);
  // …but each half can then go its own way
  assert.deepEqual(moveSegment(s, 1, 0).map((x) => x.in_ms), [6000, 0]);
  // too close to an edge to leave two shots behind: no split
  assert.equal(splitAt(one, 100), one);
  assert.equal(splitAt(one, D - 100), one);
});

test("setSegmentTake swaps the source without moving anything", () => {
  const s = [slice("t1", 0, 5000), slice("t2", 5000, 9000), slice("t1", 9000, 14000)];
  const swapped = setSegmentTake(s, 1, "t3");
  assert.equal(swapped[1].take_id, "t3");
  assert.deepEqual(cuts(swapped), [5000, 9000]);
  assert.equal(totalMs(swapped), totalMs(s));
  // swapping to the neighbour's take collapses the split, because it is then
  // one continuous piece of one take
  assert.deepEqual(setSegmentTake(s, 1, "t1"), one);
});

test("coalesce merges continuous neighbours, drops empties AND NEVER SORTS", () => {
  const messy: Segment[] = [
    slice("t1", 0, 4000),
    slice("t1", 4000, 7000),
    slice("t2", 7000, 7000),
    slice("t2", 7000, 14000),
  ];
  assert.deepEqual(coalesce(messy), [
    { take_id: "t1", in_ms: 0, out_ms: 7000 },
    { take_id: "t2", in_ms: 7000, out_ms: 14000 },
  ]);
  // The regression that would be invisible: the tiling version sorted by
  // `in_ms` (correct when that was cut time), which now un-reorders the cut on
  // the next edit that touches it.
  const reordered = [slice("t2", 8000, 12000), slice("t1", 0, 4000)];
  assert.deepEqual(coalesce(reordered).map((s) => s.take_id), ["t2", "t1"]);
  // …and two windows of one take that do not touch are two pieces, not one
  assert.equal(coalesce([slice("t1", 0, 2000), slice("t1", 6000, 8000)]).length, 2);
});

// ---------------------------------------------------------------- reading ---

test("cut time and source time are two clocks, and srcAt is the map", () => {
  // take 2's OPENING plays after take 1's middle: nothing here agrees with the
  // old model, which is the point.
  const s = [slice("t1", 6000, 9000), slice("t2", 0, 2000)];
  assert.deepEqual(layout(s).map((p) => [p.t0_ms, p.t1_ms]), [[0, 3000], [3000, 5000]]);
  assert.equal(totalMs(s), 5000);
  assert.equal(srcAt(s, 0), 6000);
  assert.equal(srcAt(s, 2999), 8999);
  assert.equal(srcAt(s, 3000), 0);
  assert.equal(srcAt(s, 4500), 1500);
  assert.equal(indexAt(s, 3500), 1);
  assert.equal(placedAt(s, 3500)?.take_id, "t2");
  assert.deepEqual(takesUsed(s), ["t1", "t2"]);
  assert.deepEqual(cuts(s), [3000]);
  // …and back the other way, which is what the bench needs: a strip is source
  // time, so clicking one has to be told where that moment plays.
  assert.equal(cutTimeOf(s, "t1", 7500), 1500);
  assert.equal(cutTimeOf(s, "t2", 500), 3500);
  assert.equal(cutTimeOf(s, "t1", 200), null, "that moment is not in this cut");
  assert.equal(cutTimeOf(s, "t3", 1000), null);
  // the same moment can be in the cut twice now; the earliest one is the one
  // the playhead reaches
  assert.equal(cutTimeOf([slice("t1", 0, 3000), slice("t1", 0, 3000)], "t1", 1000), 1000);
});

test("a drop lands at the nearest join, never inside a piece", () => {
  const s = [slice("t1", 0, 4000), slice("t2", 0, 6000)];
  assert.equal(insertIndexAt(s, 0), 0);
  assert.equal(insertIndexAt(s, 1500), 0);
  assert.equal(insertIndexAt(s, 3000), 1);
  assert.equal(insertIndexAt(s, 9000), 2);
  assert.equal(insertIndexAt([], 0), 0);
});

test("ONE TAKE WHOLE is the free commit and a TRIMMED one is not", () => {
  // The expensive direction: activating the take instead of rendering the cut
  // hands back the untrimmed render with nothing saying so.
  assert.equal(wholeTakeId(one, D), "t1");
  assert.equal(wholeTakeId([slice("t1", 0, 9000)], D), null);
  assert.equal(wholeTakeId([slice("t1", 2000, D)], D), null);
  assert.equal(wholeTakeId([slice("t1", 0, 5000), slice("t2", 5000, D)], D), null);
  // a render lands a frame or two off its plan, and that still counts
  assert.equal(wholeTakeId([slice("t1", 0, D - 40)], D), "t1");
  // a take's OWN measured length wins over the block's window
  assert.equal(wholeTakeId([slice("t1", 0, 12000)], D, () => 12000), "t1");
  assert.ok(isSingleTake(one, D));
  assert.ok(!isSingleTake([slice("t1", 0, 9000)], D));
});

test("isValid refuses what the renderer refuses, and checks the stored length", () => {
  assert.ok(!isValid([]));
  assert.ok(!isValid([{ take_id: "", in_ms: 0, out_ms: 4000 }]));
  assert.ok(!isValid([slice("t1", 0, 100)]), "below the flicker floor");
  assert.ok(!isValid([slice("t1", 5000, 4000)]));
  assert.ok(!isValid([slice("t1", -1000, 4000)]));
  // the cross-check between the length the browser computes and the one it
  // stores — the worker re-runs exactly this
  assert.ok(isValid([slice("t1", 0, 4000), slice("t2", 9000, 11000)], 6000));
  assert.ok(!isValid([slice("t1", 0, 4000), slice("t2", 9000, 11000)], 14000));
});

// ------------------------------------------------------------- evidence -----

test("evidenceFromReview splits ranged issues from global ones and converts ASR seconds", () => {
  const e = evidenceFromReview("t1", {
    scores: { overall: 0.62 },
    issues: [
      { code: "VISUAL_ARTIFACT", severity: "high", range_ms: [6000, 7500] },
      { code: "DIALOGUE_CUTOFF", severity: "high", detail: "ran past the end" },
    ],
    transcript: { matches: [{ speaker: "MIRA", line: "we should go", coverage: 0.7, t0: 2.5, t1: 4.25 }] },
  });
  assert.equal(e.overall, 0.62);
  assert.deepEqual(e.bad, [{ code: "VISUAL_ARTIFACT", severity: "high", detail: undefined, in_ms: 6000, out_ms: 7500 }]);
  assert.equal(e.global.length, 1);
  assert.deepEqual(e.lines, [{ speaker: "MIRA", line: "we should go", t0_ms: 2500, t1_ms: 4250, coverage: 0.7 }]);
  // a missing review is not an error — it is an unmeasured take
  assert.equal(evidenceFromReview("t9", undefined).overall, 0.8);
});

test("cutWarnings catches a cut through a spoken line, on either side of it", () => {
  const evidence = new Map([
    ["t1", ev("t1", { lines: [{ speaker: "MIRA", line: "we should go now", t0_ms: 4000, t1_ms: 6000, coverage: 1 }] })],
    ["t2", ev("t2")],
  ]);
  const w = cutWarnings([slice("t1", 0, 5000), slice("t2", 5000, D)], evidence);
  const mid = w.find((x) => x.code === "MID_LINE_CUT");
  assert.ok(mid, "expected MID_LINE_CUT");
  assert.equal(mid!.at_ms, 5000);
  assert.match(mid!.detail, /MIRA/);
  // the same cut moved clear of the line is clean
  assert.equal(cutWarnings([slice("t1", 0, 6500), slice("t2", 6500, D)], evidence)
    .filter((x) => x.code === "MID_LINE_CUT").length, 0);
  // and it is measured in SOURCE time but reported where you can seek to it:
  // t1's line is nowhere near this cut's position in the assembly
  const moved = cutWarnings([slice("t2", 0, 3000), slice("t1", 5000, 9000)], evidence);
  const late = moved.find((x) => x.code === "MID_LINE_CUT");
  assert.ok(late, "the incoming piece starts inside the line");
  assert.equal(late!.at_ms, 3000);
});

test("cutWarnings flags selecting a range the reviewer already condemned", () => {
  const evidence = new Map([
    ["t1", ev("t1")],
    ["t2", ev("t2", { bad: [{ code: "FROZEN_FRAMES", severity: "high", in_ms: 6000, out_ms: 6800 }] })],
  ]);
  const w = cutWarnings([slice("t1", 0, 5000), slice("t2", 5000, 9000)], evidence);
  const bad = w.find((x) => x.code === "SELECTED_BAD_RANGE");
  assert.ok(bad && bad.severity === "high");
  assert.equal(bad!.at_ms, 6000, "reported at the cut time the bad range lands on");
  // the same footage placed elsewhere in the cut is flagged where it now plays
  const shifted = cutWarnings([slice("t1", 0, 1000), slice("t2", 5000, 9000)], evidence);
  assert.equal(shifted.find((x) => x.code === "SELECTED_BAD_RANGE")!.at_ms, 2000);
  // picking t2 somewhere else does not inherit the complaint
  assert.ok(!cutWarnings([slice("t2", 9000, 12000)], evidence)
    .some((x) => x.code === "SELECTED_BAD_RANGE"));
});

test("cutWarnings flags a piece reaching past the end of its own take", () => {
  const evidence = new Map([["t2", ev("t2", { duration_ms: 12500 })], ["t1", ev("t1")]]);
  const w = cutWarnings([slice("t1", 0, 9000), slice("t2", 9000, D)], evidence);
  const short = w.find((x) => x.code === "SHORT_SOURCE");
  assert.ok(short, "expected SHORT_SOURCE");
  assert.equal(short!.severity, "high");
  // a few ms of jitter between renders is not a fault
  assert.ok(!cutWarnings([slice("t2", 9000, D)], new Map([["t2", ev("t2", { duration_ms: D - 20 })]]))
    .some((x) => x.code === "SHORT_SOURCE"));
});

test("cutWarnings names the two things free placement made possible", () => {
  // A jump cut: one take, end to end, discontinuous in itself.
  const jump = cutWarnings([slice("t1", 0, 3000), slice("t1", 8000, 11000)], new Map());
  assert.ok(jump.some((x) => x.code === "JUMP_CUT"));
  assert.ok(!cutWarnings(splitAt(one, 6000), new Map()).some((x) => x.code === "JUMP_CUT"),
            "a plain split is continuous, so it is not one");
  // The same instant twice: a stutter whose cause is nowhere in the picture.
  const twice = cutWarnings(
    [slice("t1", 2000, 5000), slice("t2", 0, 3000), slice("t1", 4000, 7000)], new Map());
  const rep = twice.find((x) => x.code === "REPEATED_MOMENT");
  assert.ok(rep, "expected REPEATED_MOMENT");
  assert.match(rep!.detail, /1\.0s/);
  assert.equal(rep!.at_ms, 6000, "reported where the SECOND copy plays");
});

test("the cut's LENGTH is not a warning — it is a fork at the commit", () => {
  // A cut that does not fit its block is answered by fitting it or by making
  // it a block of its own, so nothing about it belongs in a list of defects.
  const long = [slice("t1", 0, D), slice("t2", 0, 8000)];
  const codes = cutWarnings(long, new Map()).map((w) => w.code);
  assert.ok(!codes.includes("OFF_PLAN" as never));
  assert.ok(!cutWarnings([slice("t1", 0, 4000)], new Map()).length);
});

// -------------------------------------------------------------- the fit ----

test("fitToBlock takes the excess off the TAIL and says when it is exact", () => {
  const over = [slice("t1", 0, 6000), slice("t2", 0, 6000)];
  const fit = fitToBlock(over, 9000);
  assert.equal(totalMs(fit.segments), 9000);
  assert.equal(fit.remaining, 0);
  assert.deepEqual(fit.segments.map((s) => [s.take_id, s.in_ms, s.out_ms]),
                   [["t1", 0, 6000], ["t2", 0, 3000]], "only the last piece moved");
  // …and a cut already at the block's length is left completely alone
  const exact = fitToBlock(over, 12000);
  assert.deepEqual(exact.segments, coalesce(over));
  assert.equal(exact.remaining, 0);
  // a frame or two either way is near enough — a render lands off its plan
  assert.equal(fitToBlock(over, 12000 - FIT_EPS + 1).remaining, 0);
});

test("fitToBlock sheds whole pieces when the excess is bigger than the tail", () => {
  const many = [slice("t1", 0, 6000), slice("t2", 0, 2000), slice("t3", 0, 2000)];
  const fit = fitToBlock(many, 6000);
  assert.deepEqual(fit.segments.map((s) => s.take_id), ["t1"]);
  assert.equal(totalMs(fit.segments), 6000);
  assert.equal(fit.remaining, 0);
  // A piece is never left as a FLICKER on the way. Here the target falls
  // 100ms inside the tail, so trimming it would leave three frames: it is
  // dropped instead and the 100ms it overshot by is reported, because there is
  // no footage measured to take it back out of.
  const tight = fitToBlock([slice("t1", 0, 6000), slice("t2", 0, 2000)], 6100);
  assert.ok(tight.segments.every((x) => sliceMs(x) >= MIN_SEGMENT_MS));
  assert.equal(totalMs(tight.segments), 6000);
  assert.equal(tight.remaining, -100);
  // …and with the take's own length known it takes those 100ms straight back
  const healed = fitToBlock([slice("t1", 0, 6000), slice("t2", 0, 2000)], 6100, () => 9000);
  assert.equal(totalMs(healed.segments), 6100);
  assert.equal(healed.remaining, 0);
});

test("fitToBlock extends the tail into its own take, and REPORTS what it cannot reach", () => {
  const short = [slice("t1", 0, 4000), slice("t2", 2000, 5000)];
  // t2 runs to 10s, so the 5s shortfall comes out of the rest of it
  const fit = fitToBlock(short, 12000, () => 10000);
  assert.equal(totalMs(fit.segments), 12000);
  assert.equal(fit.remaining, 0);
  assert.equal(fit.segments[1].out_ms, 10000);
  // …and when the take ends first, the shortfall is stated rather than
  // invented: holding a frame is a freeze this model cannot express.
  const capped = fitToBlock(short, 12000, () => 6000);
  assert.equal(totalMs(capped.segments), 8000);
  assert.equal(capped.remaining, -4000);
  // with no measured media it cannot grow at all, and says so
  assert.equal(fitToBlock(short, 12000).remaining, -5000);
});

test("fitToBlock never empties the cut, and reports an impossible trim", () => {
  const only = [slice("t1", 0, 3000)];
  // a target above the floor is simply met
  assert.equal(totalMs(fitToBlock(only, 400).segments), 400);
  // …and one below it stops at the floor and says how far over that leaves it
  const floored = fitToBlock(only, 100);
  assert.equal(floored.segments.length, 1);
  assert.equal(totalMs(floored.segments), MIN_SEGMENT_MS);
  assert.equal(floored.remaining, MIN_SEGMENT_MS - 100);
  assert.deepEqual(fitToBlock([], 5000).segments, []);
});

test("cutWarnings flags flickers and dicing, worst first", () => {
  const diced: Segment[] = Array.from({ length: 7 }, (_, i) =>
    slice(i % 2 ? "t2" : "t1", i * 1000, i * 1000 + 900));
  const w = cutWarnings(diced, new Map());
  assert.ok(w.some((x) => x.code === "MANY_CUTS"));
  const flick = cutWarnings([slice("t1", 0, 7000), { take_id: "t2", in_ms: 7000, out_ms: 7100 }],
                            new Map());
  assert.ok(flick.some((x) => x.code === "FLICKER_CUT"));
  const ranks = { high: 3, medium: 2, low: 1 };
  const seq = w.map((x) => ranks[x.severity]);
  assert.deepEqual(seq, [...seq].sort((a, b) => b - a));
});

// ---------------------------------------------------------- auto assemble ---

test("shotSpans turns beats into semantic spans covering the take exactly", () => {
  const spans = shotSpans([{ duration_ms: 4000, camera: "wide" }, { duration_ms: 3000, camera: "two-shot" },
                           { duration_ms: 7000, camera: "reaction" }], D);
  assert.equal(spans.length, 3);
  assert.equal(spans[0].t0_ms, 0);
  assert.equal(spans[2].t1_ms, D);
  assert.deepEqual(spans.map((s) => s.label), ["wide", "two-shot", "reaction"]);
  // a block with no beats is one span, and a render a little off plan still tiles
  assert.deepEqual(shotSpans([], D), [{ t0_ms: 0, t1_ms: D }]);
  assert.equal(shotSpans([{ duration_ms: 5000 }, { duration_ms: 5000 }], 13800).at(-1)!.t1_ms, 13800);
});

test("shotLabel makes a chip out of H3's camera prose", () => {
  // Camera is a full sentence in the official motion grammar, and the action
  // text is markdown — neither fits a lane chip as written.
  assert.equal(
    shotLabel("close-up; the camera pulls back with large amplitude at fast speed", null, 0),
    "close-up");
  assert.equal(shotLabel(null, "She turns to face the **entwined limbs** of the crowd", 1),
               "She turns to face the entwined li…");
  assert.equal(shotLabel("", "", 2), "shot 3");
  assert.equal(shotLabel("two-shot", "ignored", 0), "two-shot");
});

test("spanScore punishes overlap with a ranged issue and unspoken dialogue", () => {
  const clean = ev("t1");
  const broken = ev("t2", { bad: [{ code: "FROZEN_FRAMES", severity: "high", in_ms: 0, out_ms: 4000 }] });
  const span = { t0_ms: 0, t1_ms: 4000 };
  assert.ok(spanScore(broken, span) < spanScore(clean, span));
  // the damage is local: elsewhere the same take scores clean
  assert.equal(spanScore(broken, { t0_ms: 9000, t1_ms: 12000 }), spanScore(clean, span));
});

test("autoAssemble picks the better take per shot and explains why", () => {
  const spans = shotSpans([{ duration_ms: 7000, camera: "two-shot" }, { duration_ms: 7000, camera: "reaction" }], D);
  // t1 is the stronger take overall but falls apart in the back half, and the
  // gap there (0.10) clears SWITCH_COST — so the cut is worth making.
  const evidence = new Map([
    ["t1", ev("t1", { overall: 0.95, bad: [{ code: "VISUAL_ARTIFACT", severity: "high", in_ms: 7000, out_ms: 14000 }] })],
    ["t2", ev("t2", { overall: 0.7 })],
  ]);
  const { segments, notes } = autoAssemble(["t1", "t2"], evidence, spans, D, "t1");
  assert.deepEqual(segments.map((s) => s.take_id), ["t1", "t2"]);
  assert.equal(segments[0].out_ms, 7000);
  // it proposes the plan's own shots in the plan's own order, so the cut it
  // hands back is exactly as long as the block and lands where it came from
  assert.ok(isValid(segments, D));
  assert.deepEqual(layout(segments).map((p) => p.t0_ms), [0, 7000]);
  assert.match(notes["1"], /scores/);
});

test("autoAssemble does not cut on noise, and keeps the take you already had", () => {
  const spans = shotSpans([{ duration_ms: 5000 }, { duration_ms: 5000 }, { duration_ms: 4000 }], D);
  // t2 is better by less than the switch cost in the middle span only
  const evidence = new Map([
    ["t1", ev("t1", { overall: 0.8 })],
    ["t2", ev("t2", { overall: 0.8 + SWITCH_COST / 4 })],
  ]);
  const { segments } = autoAssemble(["t1", "t2"], evidence, spans, D, "t1");
  assert.ok(isSingleTake(segments, D), "a marginal gain is not worth two cuts");
  assert.ok(isValid(segments, D));
});

test("autoAssemble degrades safely with one take and with no evidence at all", () => {
  assert.deepEqual(autoAssemble(["t1"], new Map(), shotSpans([], D), D).segments, one);
  const { segments } = autoAssemble(["t1", "t2", "t3"], new Map(),
                                    shotSpans([{ duration_ms: 7000 }, { duration_ms: 7000 }], D), D, "t2");
  assert.ok(isValid(segments, D));
  assert.deepEqual(segments, tile("t2", D));   // the tie-break holds it steady
  assert.deepEqual(autoAssemble([], new Map(), [], D).segments, []);
});

// ------------------------------------------------------------ the commit ----

test("the commit refuses an off-plan cut unless it is being made a block", () => {
  // `commitAssembly` reaches Supabase at import, so this reads its source —
  // the same reason `scoreTrack.test.ts` does. What is pinned is the pair: the
  // browser offers the fork and this decides that one of the two was taken, so
  // a caller that forgets cannot write a take that is quietly the wrong length
  // for its slot.
  const src = readFileSync(new URL("./db/assembly.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("export async function commitAssembly"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /FIT_EPS/, "the tolerance is the algebra's, not a second number");
  assert.match(body, /!opts\.asNewBlock/, "and the escape hatch is what lifts it");
  assert.match(body, /throw new Error\(/);
  // the job has to carry the route, or the worker publishes onto the old block
  assert.match(body, /as_new_block: true/);
  // …and the clip, which is what the new block takes the place of on the lane
  assert.match(body, /clip_id: opts\.clipId/);
});

test("cutTimeNear maps the bench's clock onto the viewer's, and never goes dead", () => {
  // take 2's OPENING plays second, so the two clocks disagree everywhere
  const s = [slice("t1", 6000, 9000), slice("t2", 0, 2000)];
  assert.equal(cutTimeNear(s, 6000), 0);
  assert.equal(cutTimeNear(s, 7500), 1500);
  assert.equal(cutTimeNear(s, 500), 3500, "that moment of t2 plays at 3.5s");
  // a moment the cut left out lands on the closest one it does hold, rather
  // than leaving the handle stuck halfway along with nothing said
  assert.equal(cutTimeNear(s, 12000), 2999);
  assert.equal(cutTimeNear([], 1000), null);
  // both takes hold 1.5s; the one on screen wins so scrubbing does not jump
  const both = [slice("t1", 0, 3000), slice("t2", 0, 3000)];
  assert.equal(cutTimeNear(both, 1500, "t1"), 1500);
  assert.equal(cutTimeNear(both, 1500, "t2"), 4500);
});

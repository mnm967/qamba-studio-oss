// node --test src/lib/clipFrames.test.ts
//
// The extract that feeds extend and chain. Every case here is one that
// produces a perfectly good picture of the wrong instant: nothing throws, the
// asset registers, and the generated bridge simply starts somewhere the viewer
// never was. The trimmed cases are the ones this was written for — a tail trim
// used to be honoured only by accident and a head trim not at all in the
// recorded metadata.
import test from "node:test";
import assert from "node:assert/strict";
import {
  clipRate, clipReversed, clipSourceAt, clipSourceMs, formatTc, frameAt, frameCount, frameMs,
  freezeSourceMs, maxClipMs, retimeGeometry, splitGeometry, trimReadout, trimPatch,
  DEFAULT_FPS, MIN_CLIP_MS, SPLIT_EDGE_MS, 
} from "./clipFrames.ts";

const clip = (over = {}) => ({ in_ms: 0, duration_ms: 10000, ops: [], ...over }) as never;
const asset = (fps: number | null) => ({ fps }) as never;
const media = (duration_ms: number | null) => ({ fps: 24, duration_ms }) as never;
const at = (rate: number) => [{ op: "speed", rate }];

test("an untrimmed clip ends one frame before its own length", () => {
  assert.equal(clipSourceMs(clip(), "first"), 0);
  assert.equal(clipSourceMs(clip(), "last"), 10000 - 1000 / DEFAULT_FPS);
});

test("a TAIL trim moves the end frame to the trim point", () => {
  // WsTimeline's right handle: duration_ms shrinks, in_ms is untouched.
  const trimmed = clip({ duration_ms: 6000 });
  assert.equal(clipSourceMs(trimmed, "last"), 6000 - 1000 / DEFAULT_FPS);
  assert.equal(clipSourceMs(trimmed, "first"), 0);
});

test("a HEAD trim moves the start frame and keeps the end where it was", () => {
  // The left handle advances in_ms and shortens duration_ms by the same
  // amount, so the out-point does not move.
  const trimmed = clip({ in_ms: 2500, duration_ms: 7500 });
  assert.equal(clipSourceMs(trimmed, "first"), 2500);
  assert.equal(clipSourceMs(trimmed, "last"), 10000 - 1000 / DEFAULT_FPS);
});

test("trimmed at both ends, both frames follow", () => {
  const trimmed = clip({ in_ms: 2000, duration_ms: 3000 });
  assert.equal(clipSourceMs(trimmed, "first"), 2000);
  assert.equal(clipSourceMs(trimmed, "last"), 5000 - 1000 / DEFAULT_FPS);
});

test("out_ms is ignored when it outlives the played window", () => {
  // _attach_to_clip writes the whole render into out_ms and only ever SHRINKS
  // duration_ms, so out_ms names a frame past the cut. Reading it would grab
  // a frame nobody sees.
  const attached = clip({ in_ms: 0, duration_ms: 4000, out_ms: 12000 });
  assert.equal(clipSourceMs(attached, "last"), 4000 - 1000 / DEFAULT_FPS);
});

test("the frame step comes from the asset's own fps", () => {
  assert.equal(frameMs(asset(48)), 1000 / 48);
  assert.equal(frameMs(asset(null)), 1000 / DEFAULT_FPS);
  assert.equal(frameMs(undefined), 1000 / DEFAULT_FPS);
  // A corrupt row must not put the step at Infinity and the end frame at -Inf.
  assert.equal(frameMs(asset(0)), 1000 / DEFAULT_FPS);
  assert.equal(clipSourceMs(clip(), "last", asset(0)), 10000 - 1000 / DEFAULT_FPS);
});

test("a speed op stretches source time under the playhead", () => {
  // 5s of lane at 2x plays 10s of source.
  const fast = clip({ duration_ms: 5000, ops: [{ op: "speed", rate: 2 }] });
  assert.equal(clipRate(fast), 2);
  assert.equal(clipSourceMs(fast, "last"), 10000 - 1000 / DEFAULT_FPS);
  const slow = clip({ duration_ms: 10000, ops: [{ op: "speed", rate: 0.5 }] });
  assert.equal(clipSourceMs(slow, "last"), 5000 - 1000 / DEFAULT_FPS);
});

test("two speed ops COMPOUND, the way the filter chain does", () => {
  // Every speed op appends its own setpts, so the render multiplies them
  // (worker/handlers/render.py::speed_rate). The UI writes at most one, so
  // this changes nothing for a clip anyone can make — it is here so the
  // preview's window cannot land somewhere the render will not go.
  assert.equal(clipRate(clip({ ops: [{ op: "speed", rate: 2 }, { op: "speed", rate: 3 }] })), 6);
  assert.equal(clipRate(clip({ ops: at(2) })), 2);
  assert.equal(clipRate(clip({ ops: [] })), 1);
});

test("a corrupt speed op falls back to 1x rather than dividing by zero", () => {
  for (const rate of [0, -1, NaN, undefined, "2" as unknown as number]) {
    assert.equal(clipRate(clip({ ops: [{ op: "speed", rate }] })), 1);
  }
  assert.equal(clipRate(clip({ ops: null })), 1);
});

test("a REVERSED clip ends on its in-point and opens on its out-point", () => {
  const rev = clip({ in_ms: 2000, duration_ms: 3000, ops: [{ op: "reverse" }] });
  assert.ok(clipReversed(rev));
  assert.equal(clipSourceMs(rev, "last"), 2000);
  assert.equal(clipSourceMs(rev, "first"), 5000 - 1000 / DEFAULT_FPS);
});

// ── the playback mapping ──────────────────────────────────────────────────
// clipSourceAt is what the player drives every element through and what the
// grab-frame button reads, so a wrong answer here is a stage showing one
// frame and every other surface naming another. Each case is one where the
// forward-only version it replaced was silently wrong.

test("clipSourceAt walks the source forwards at the clip's rate", () => {
  const c = clip({ in_ms: 2000, duration_ms: 3000, t_start_ms: 1000 });
  assert.equal(clipSourceAt(c, 1000), 2000);
  assert.equal(clipSourceAt(c, 2500), 3500);
  assert.equal(clipSourceAt(c, 4000), 5000);          // the cut
  const fast = clip({ in_ms: 0, duration_ms: 3000, t_start_ms: 0,
                      ops: [{ op: "speed", rate: 2 }] });
  assert.equal(clipSourceAt(fast, 1500), 3000);
});

test("a REVERSED clip runs its window backwards", () => {
  // Opens on the end of what it plays and lands on its in-point at the cut —
  // the same window `clipSourceMs` names and the same one the render's
  // `reverse` filter produces.
  const rev = clip({ in_ms: 2000, duration_ms: 3000, t_start_ms: 1000,
                     ops: [{ op: "reverse" }] });
  assert.equal(clipSourceAt(rev, 1000), 5000);
  assert.equal(clipSourceAt(rev, 2500), 3500);
  assert.equal(clipSourceAt(rev, 4000), 2000);
});

test("the two endpoints agree with clipSourceMs, one frame apart", () => {
  // clipSourceMs names the last frame HELD, which sits one frame before the
  // cut; clipSourceAt is the continuous mapping, so it lands ON the cut. Any
  // other relationship means the player and the extractor disagree about
  // which end of a reversed clip is which.
  const a = asset(24);
  const f = 1000 / 24;
  for (const ops of [[], [{ op: "reverse" }]]) {
    const c = clip({ in_ms: 2000, duration_ms: 3000, t_start_ms: 1000, ops });
    assert.equal(clipSourceAt(c, 1000), clipSourceMs(c, "first", a) + (ops.length ? f : 0));
    assert.equal(clipSourceAt(c, 4000), clipSourceMs(c, "last", a) + (ops.length ? 0 : f));
  }
});

test("clipSourceAt never asks for a negative source time", () => {
  // The playhead can sit before a clip mid-drag, and a reversed clip trimmed
  // to the head of its media mirrors past zero at the cut.
  assert.equal(clipSourceAt(clip({ in_ms: 0, t_start_ms: 5000 }), 0), 0);
  const rev = clip({ in_ms: 0, duration_ms: 3000, t_start_ms: 0, ops: [{ op: "reverse" }] });
  assert.equal(clipSourceAt(rev, 4000), 0);
});

test("a clip shorter than one frame cannot ask for a negative time", () => {
  const tiny = clip({ in_ms: 500, duration_ms: 10 });
  assert.equal(clipSourceMs(tiny, "last"), 500);
  assert.equal(clipSourceMs(clip({ in_ms: -5, duration_ms: 0 }), "first"), 0);
});

// ── the trim readout ──────────────────────────────────────────────────────
// What the card promises is "this exact frame", so the cases below are the
// ones where it could quietly name a different one: the binary boundary, a
// clamp binding, and a reversed clip whose handles swap meaning.

test("the last frame of an untrimmed clip is not off by one", () => {
  // 10000/41.666… is exactly 240 frames, so the last is 239 — and
  // 9958.333…/41.666… evaluates to 238.99999999999997 in binary. A bare
  // floor names 238 here, on EVERY untrimmed clip, which is the whole
  // reason frameAt carries an epsilon.
  const a = asset(24);
  assert.equal(frameAt(clipSourceMs(clip(), "last", a), a), 239);
  assert.equal(frameAt(0, a), 0);
  assert.equal(frameAt(1000 / 24 - 0.001, a), 0);
  assert.equal(frameAt(1000 / 24 + 0.001, a), 1);
});

test("a frame's own start is what the card quotes, not the raw cut point", () => {
  // Dragging inside one frame must not move the readout: the trim has not
  // landed anywhere new yet.
  const a = asset(24);
  const at = (inMs: number) => trimReadout(clip({ in_ms: inMs, duration_ms: 5000 }), "l", a);
  assert.equal(at(1234).frame, 29);
  assert.equal(at(1249).frame, 29);
  assert.equal(at(1234).srcMs, at(1249).srcMs);
  assert.equal(Math.round(at(1234).srcMs), 1208);      // frame 29 starts here
  assert.equal(at(1250).frame, 30);
});

test("the seek lands in the MIDDLE of the frame, inside the media", () => {
  const a = { fps: 24, duration_ms: 10000 } as never;
  const r = trimReadout(clip({ in_ms: 1250, duration_ms: 5000 }), "l", a);
  assert.equal(r.seekMs, 30 * (1000 / 24) + (1000 / 24) / 2);
  // The tail of an untrimmed clip would otherwise seek past the last frame's
  // midpoint on a source whose final frame is short.
  const tail = trimReadout(clip(), "r", a);
  assert.ok(tail.seekMs <= 10000 - (1000 / 24) / 2 + 1e-9);
  assert.equal(tail.frame, 239);
  assert.equal(tail.frames, 240);
});

test("each handle reads the end it is dragging", () => {
  const a = asset(24);
  const c = clip({ in_ms: 2000, duration_ms: 3000 });
  assert.equal(trimReadout(c, "l", a).edge, "in");
  assert.equal(trimReadout(c, "l", a).frame, frameAt(2000, a));
  assert.equal(trimReadout(c, "r", a).edge, "out");
  assert.equal(trimReadout(c, "r", a).frame, frameAt(5000 - 1000 / 24, a));
});

test("a REVERSED clip's left handle still names what the clip OPENS on", () => {
  // Which is its out-point — the card follows playback, not the source's
  // own direction, because "in" on screen is what the viewer sees first.
  const a = asset(24);
  const rev = clip({ in_ms: 2000, duration_ms: 3000, ops: [{ op: "reverse" }] });
  assert.equal(trimReadout(rev, "l", a).frame, frameAt(5000 - 1000 / 24, a));
  assert.equal(trimReadout(rev, "r", a).frame, frameAt(2000, a));
});

// ── the trim gesture ──────────────────────────────────────────────────────
// A handle is named for the SCREEN, so on a reversed clip it moves the
// OPPOSITE end of the source window. Getting that wrong is what "I trimmed the
// reversed clip and the start frame changed" was: the tail handle shortened
// the window from its far end, which is the one frame a tail trim must never
// move.

const REV = [{ op: "reverse" }];
// The clip from the report: 4.5s of a 4.5s take, reversed, untrimmed.
const shot = (over = {}) =>
  clip({ t_start_ms: 10000, in_ms: 0, duration_ms: 4500, ops: REV, ...over });
const media4500 = { fps: 24, duration_ms: 4500 } as never;

test("trimming a reversed clip's TAIL keeps the frame it opens on", () => {
  const c = shot();
  const before = clipSourceMs(c, "first", media4500);
  // Drag the right handle from 14500 back to 12100 — the 4.5s -> 2.1s of the
  // report.
  const p = trimPatch(c, "r", 12100, media4500);
  assert.equal(p.duration_ms, 2100);
  assert.equal(p.in_ms, 2400);                       // the window's START moved
  assert.equal(clipSourceMs({ ...c, ...p }, "first", media4500), before);
  assert.equal(clipSourceMs({ ...c, ...p }, "last", media4500), 2400);
});

test("trimming a reversed clip's HEAD moves the frame it opens on", () => {
  const c = shot();
  // Drag the left handle from 10000 to 12400.
  const p = trimPatch(c, "l", 12400, media4500);
  assert.equal(p.t_start_ms, 12400);
  assert.equal(p.duration_ms, 2100);
  assert.equal(p.in_ms, 0);                          // the window's START held
  assert.equal(clipSourceMs({ ...c, ...p }, "first", media4500), 2100 - 1000 / 24);
  assert.equal(clipSourceMs({ ...c, ...p }, "last", media4500), 0);
});

test("a FORWARD clip trims exactly as it always did", () => {
  const c = clip({ t_start_ms: 10000, in_ms: 500, duration_ms: 4000, ops: [] });
  const a = { fps: 24, duration_ms: 9000 } as never;
  // Tail: duration shrinks, in_ms untouched, the opening frame holds.
  const r = trimPatch(c, "r", 12500, a);
  assert.deepEqual([r.in_ms, r.duration_ms, r.out_ms], [500, 2500, 3000]);
  // Head: in_ms and t_start advance together, the window's END holds.
  const l = trimPatch(c, "l", 11500, a);
  assert.deepEqual([l.t_start_ms, l.in_ms, l.duration_ms, l.out_ms],
                   [11500, 2000, 2500, 4500]);
});

test("each handle reports the end it is really cutting", () => {
  // The readout has always said the left handle names what the clip opens on;
  // before trimPatch that was the one number a left drag could not move.
  const c = shot();
  const l = trimPatch(c, "l", 12400, media4500);
  const r = trimPatch(c, "r", 12100, media4500);
  assert.equal(trimReadout({ ...c, ...l }, "l", media4500).frame,
               frameAt(2100 - 1000 / 24, media4500));
  assert.equal(trimReadout({ ...c, ...r }, "r", media4500).frame, frameAt(2400, media4500));
});

test("a reversed clip cannot be grown past either end of its media", () => {
  // Left grows the window's END, and the file ends: untrimmed, it cannot move
  // left at all.
  assert.equal(trimPatch(shot(), "l", 9000, media4500).t_start_ms, 10000);
  // Trimmed off the head, it may grow back exactly as far as the media allows.
  const cut = shot({ duration_ms: 3000 });
  assert.equal(trimPatch(cut, "l", 8000, media4500).t_start_ms, 10000 - 1500);
  // Right grows the window's START, and `in_ms` may not go below zero.
  assert.equal(trimPatch(shot(), "r", 99000, media4500).duration_ms, 4500);
  assert.equal(trimPatch(shot({ in_ms: 1200, duration_ms: 3300 }), "r", 99000,
                         media4500).duration_ms, 4500);
});

test("a reversed trim carries the RATE across the two scales", () => {
  // 2x eats two seconds of source per second of timeline, so a 1s tail trim
  // walks the window's start on by two.
  const c = shot({ duration_ms: 2250, ops: [...REV, { op: "speed", rate: 2 }] });
  const p = trimPatch(c, "r", 10000 + 1250, media4500);
  assert.equal(p.duration_ms, 1250);
  assert.equal(p.in_ms, 2000);
  assert.equal(p.out_ms, 4500);                      // the window's end holds
});

test("neither handle can trim a clip below the floor", () => {
  assert.equal(trimPatch(shot(), "r", 10000, media4500).duration_ms, MIN_CLIP_MS);
  assert.equal(trimPatch(shot(), "l", 99000, media4500).duration_ms, MIN_CLIP_MS);
});

test("the limit names the end that is really binding on a reversed clip", () => {
  // Untrimmed: its left handle is against the MEDIA'S END (it opens on the
  // last frame), where a forward clip's left handle is against the start.
  const c = shot();
  assert.equal(trimReadout(c, "l", media4500).limit, "media-end");
  assert.equal(trimReadout(c, "r", media4500).limit, "media-start");
  const fwd = clip({ in_ms: 0, duration_ms: 4500, ops: [] });
  assert.equal(trimReadout(fwd, "l", media4500).limit, "media-start");
  assert.equal(trimReadout(fwd, "r", media4500).limit, "media-end");
});

test("the card says WHY the edge stopped following the pointer", () => {
  const a = { fps: 24, duration_ms: 10000 } as never;
  assert.equal(trimReadout(clip({ in_ms: 0, duration_ms: 5000 }), "l", a).limit, "media-start");
  assert.equal(trimReadout(clip({ in_ms: 100, duration_ms: 5000 }), "l", a).limit, null);
  assert.equal(trimReadout(clip({ in_ms: 0, duration_ms: 10000 }), "r", a).limit, "media-end");
  assert.equal(trimReadout(clip({ in_ms: 5000, duration_ms: 5000 }), "r", a).limit, "media-end");
  assert.equal(trimReadout(clip({ in_ms: 0, duration_ms: 9000 }), "r", a).limit, null);
  // The floor outranks the others: at 200ms against the head of the media
  // both are true and "you have run out of clip" is the actionable one.
  assert.equal(
    trimReadout(clip({ in_ms: 0, duration_ms: 200 }), "l", a, { minMs: 200 }).limit,
    "min-length");
  // A speed op is spent source time, so the end of the media arrives early.
  const fast = clip({ in_ms: 0, duration_ms: 5000, ops: [{ op: "speed", rate: 2 }] });
  assert.equal(trimReadout(fast, "r", a).limit, "media-end");
});

test("the length delta is against where the gesture STARTED", () => {
  const r = trimReadout(clip({ duration_ms: 4250 }), "r", asset(24), { origDurationMs: 5000 });
  assert.equal(r.durationMs, 4250);
  assert.equal(r.deltaMs, -750);
  assert.equal(trimReadout(clip({ duration_ms: 4250 }), "r", asset(24)).deltaMs, 0);
});

test("an asset with no fps or duration still reads a frame", () => {
  // Every placeholder clip on the lane is one of these until asset_ingest
  // lands — a card that renders "frame NaN" over a real picture is worse
  // than one that assumes the studio's own grid.
  const r = trimReadout(clip({ in_ms: 1000, duration_ms: 2000 }), "l", asset(null));
  assert.equal(r.frame, frameAt(1000, asset(DEFAULT_FPS)));
  assert.equal(r.frames, null);
  assert.equal(trimReadout(clip(), "l").frames, null);
  assert.equal(frameCount(asset(null)), null);
  assert.equal(frameCount({ fps: 24, duration_ms: 10000 } as never), 240);
});

test("timecode is padded so the readout does not jitter in width", () => {
  assert.equal(formatTc(0), "0:00.000");
  assert.equal(formatTc(9958.333), "0:09.958");
  assert.equal(formatTc(61_500), "1:01.500");
  assert.equal(formatTc(-5), "0:00.000");
});

test("the exact cut rides alongside the frame, for media with no frames", () => {
  // An audio lane reads `cutMs`: ffmpeg cuts sound at sample precision, so
  // rounding a music clip's trim onto the picture's 24fps grid invents up to
  // 41ms of precision that nothing downstream honours.
  const a = asset(24);
  const r = trimReadout(clip({ in_ms: 1234, duration_ms: 5000 }), "l", a);
  assert.equal(r.cutMs, 1234);
  assert.notEqual(r.cutMs, r.srcMs);
  assert.equal(Math.round(r.srcMs), 1208);
});


/* ── the retime ceiling ──────────────────────────────────────────────────────
   The bug these pin: `retime` used to write the op and nothing else, so the
   clip kept its width while consuming `duration_ms * rate` of source. At 2x a
   10s clip over a 10s file asked for 20s and played the back half off the end
   — a real picture of nothing, with no error anywhere. */

test("the ceiling is the source left over DIVIDED by the rate", () => {
  const ten = media(10_000);
  assert.equal(maxClipMs(clip(), ten, 1), 10_000);
  assert.equal(maxClipMs(clip(), ten, 2), 5_000);
  assert.equal(maxClipMs(clip(), ten, 0.5), 20_000);
  // A head trim spends source, so the ceiling drops with it.
  assert.equal(maxClipMs(clip({ in_ms: 2_000 }), ten, 2), 4_000);
});

test("the ceiling reads the clip's OWN rate when none is given", () => {
  assert.equal(maxClipMs(clip({ ops: at(4) }), media(10_000)), 2_500);
});

test("an unmeasured asset has NO ceiling", () => {
  // A placeholder clip sits on the lane from the moment a generate action is
  // pressed until the render lands. Clamping to a length nobody measured is
  // how a real shot gets cut to a default.
  assert.equal(maxClipMs(clip(), media(null)), Infinity);
  assert.equal(maxClipMs(clip(), undefined), Infinity);
  assert.equal(maxClipMs(clip(), media(0)), Infinity);
  assert.equal(retimeGeometry(clip(), 2, media(null)).duration_ms, 10_000);
});

test("speeding up CONTRACTS the clip to what the media can still fill", () => {
  const g = retimeGeometry(clip(), 2, media(10_000));
  assert.equal(g.duration_ms, 5_000);
  // The played window is unchanged, so the render's own trim is untouched:
  // (out - in) / 2 is exactly the new width.
  assert.equal(g.out_ms, 10_000);
});

test("slowing down does NOT grow the clip", () => {
  // Growing would shove or overlap everything after it on the lane — an edit
  // nobody asked for, from a control that is about one clip.
  const g = retimeGeometry(clip(), 0.5, media(10_000));
  assert.equal(g.duration_ms, 10_000);
  // ...but out_ms follows the played window, so the render stops where the
  // preview does instead of coming back twice as long.
  assert.equal(g.out_ms, 5_000);
});

test("a clip with source to spare keeps its width when sped up", () => {
  // Tail-trimmed to 4s of a 10s file: at 2x there is still 5s of ceiling, so
  // the width stands and the clip simply reaches further into the source.
  const g = retimeGeometry(clip({ duration_ms: 4_000 }), 2, media(10_000));
  assert.equal(g.duration_ms, 4_000);
  assert.equal(g.out_ms, 8_000);
});

test("the head trim is spent before the ceiling is measured", () => {
  const g = retimeGeometry(clip({ in_ms: 6_000, duration_ms: 4_000 }), 2, media(10_000));
  assert.equal(g.duration_ms, 2_000);          // (10000 - 6000) / 2
  assert.equal(g.out_ms, 10_000);
});

test("retiming again compounds off the CURRENT width, not the original", () => {
  const one = retimeGeometry(clip(), 2, media(10_000));
  const two = retimeGeometry(clip({ ...one, ops: at(2) }), 4, media(10_000));
  assert.equal(two.duration_ms, 2_500);
  assert.equal(two.out_ms, 10_000);
});

test("dropping back to 1x leaves the width alone — the media is what restores it", () => {
  // Never-grow means a retime is not self-reversing, and that is the stated
  // rule. What makes it RECOVERABLE is that the ceiling is read off the media
  // rather than off out_ms: the right handle can be dragged back out to the
  // whole shot.
  const fast = { ...clip({ ...retimeGeometry(clip(), 4, media(10_000)) }), ops: at(4) } as never;
  const back = retimeGeometry(fast, 1, media(10_000));
  assert.equal(back.duration_ms, 2_500);
  assert.equal(back.out_ms, 2_500);
  assert.equal(maxClipMs({ ...back, ops: [] } as never, media(10_000)), 10_000);
});

test("the floor never GROWS a clip", () => {
  // A ceiling under the floor means the media is shorter than a grabbable
  // clip: a few frames of overrun beats a row with no body to click.
  const g = retimeGeometry(clip({ duration_ms: 400 }), 8, media(1_000));
  assert.equal(g.duration_ms, MIN_CLIP_MS);
  // ...and a clip already under the floor is not stretched up to it.
  assert.equal(retimeGeometry(clip({ duration_ms: 120 }), 8, media(1_000)).duration_ms, 120);
});

test("a corrupt rate is not an instruction to divide by zero", () => {
  const ten = media(10_000);
  assert.equal(maxClipMs(clip(), ten, 0), 10_000);
  assert.equal(retimeGeometry(clip(), Number.NaN, ten).duration_ms, 10_000);
  assert.equal(retimeGeometry(clip(), -2, ten).out_ms, 10_000);
});

test("the contracted clip still ends on a frame the viewer saw", () => {
  // The whole point: after the contraction `clipSourceMs` lands one frame
  // inside the media instead of past the end of it, so an extend or a chain
  // anchors on a real picture.
  const g = retimeGeometry(clip(), 2, media(10_000));
  const after = clip({ ...g, ops: at(2) });
  assert.equal(clipSourceMs(after, "last", media(10_000)), 10_000 - 1000 / DEFAULT_FPS);
  // Before the fix the same clip asked for 20s of a 10s file.
  assert.equal(clipSourceMs(clip({ ops: at(2) }), "last", media(10_000)), 20_000 - 1000 / DEFAULT_FPS);
});

// ── where a split lands in the source ─────────────────────────────────────
// A split must not change what the render delivers, and every failure here
// is silent: both halves are valid rows on a lane whose geometry is
// untouched, and only the picture inside one of them is wrong.

const cut = (over = {}) =>
  ({ t_start_ms: 100000, in_ms: 0, duration_ms: 10000, ops: [], ...over }) as never;

test("an unspeeded split cuts the source where it cuts the lane", () => {
  const g = splitGeometry(cut({ t_start_ms: 100000 }), 4000)!;
  assert.deepEqual(g.left, { duration_ms: 4000, out_ms: 4000, ops: [] });
  assert.deepEqual(g.right,
                   { t_start_ms: 104000, in_ms: 4000, duration_ms: 6000, out_ms: 10000, ops: [] });
});

test("a RETIMED clip advances the source by the rate, not by the lane", () => {
  // The reported bug, with its own numbers: an 8.1s clip at 1.5x cut 3.3s in.
  // The picture has already run 4.95s of source by then, so a right half
  // opening at in+3300 re-plays 1.65s the left half has just shown.
  const g = splitGeometry(cut({ duration_ms: 8100, ops: at(1.5) }), 3300)!;
  assert.equal(g.left.out_ms, 4950);
  assert.equal(g.right.in_ms, 4950);
  assert.notEqual(g.right.in_ms, 3300);
  // The LANE is untouched: the two widths still sum to the original.
  assert.equal(g.left.duration_ms + g.right.duration_ms, 8100);
  assert.equal(g.right.t_start_ms, 103300);
});

test("the two halves tile the original's played window, at any rate", () => {
  for (const rate of [1, 1.5, 2, 0.5, 0.25, 3]) {
    for (const head of [0, 2500]) {
      const c = cut({ in_ms: head, duration_ms: 9000, ops: at(rate) });
      const g = splitGeometry(c, 3000)!;
      // One integer boundary — rounding each side alone drops or repeats a
      // frame at the join.
      assert.equal(g.left.out_ms, g.right.in_ms, `boundary at ${rate}x`);
      assert.equal(g.left.in_ms ?? head, head);
      assert.equal(g.right.out_ms, head + 9000 * rate, `tail at ${rate}x`);
      assert.equal(g.left.duration_ms + g.right.duration_ms, 9000);
      // Each half's source window matches the width it will play.
      assert.equal((g.left.out_ms - head) / rate, g.left.duration_ms);
      assert.equal((g.right.out_ms - g.right.in_ms) / rate, g.right.duration_ms);
    }
  }
});

test("a head-trimmed retimed clip cuts from its OWN in-point", () => {
  const g = splitGeometry(cut({ in_ms: 2000, duration_ms: 4000, ops: at(2) }), 1000)!;
  assert.equal(g.left.out_ms, 4000);     // 2000 + 1000*2
  assert.equal(g.right.in_ms, 4000);
  assert.equal(g.right.out_ms, 10000);   // 2000 + 4000*2
});

test("a REVERSED clip's first half is the TAIL of the media", () => {
  // Reversed playback shows `end - t*rate`, so the piece that plays first is
  // the end of the source. Carried forward instead, the two halves put the
  // shot back together inside out — each half backwards, the halves in
  // forward order — and the delivered cut changes.
  const g = splitGeometry(cut({ duration_ms: 10000, ops: [{ op: "reverse" }] }), 3000)!;
  const rv = [{ op: "reverse" }];
  assert.deepEqual(g.left, { in_ms: 7000, duration_ms: 3000, out_ms: 10000, ops: rv });
  assert.deepEqual(g.right,
                   { t_start_ms: 103000, in_ms: 0, duration_ms: 7000, out_ms: 7000, ops: rv });
  // Still a tiling of the same window, in the other order.
  assert.equal(g.right.in_ms, 0);
  assert.equal(g.left.out_ms, 10000);
  assert.equal(g.right.out_ms, g.left.in_ms);
});

test("reverse and speed compose", () => {
  const g = splitGeometry(
    cut({ in_ms: 1000, duration_ms: 4000, ops: [{ op: "speed", rate: 2 }, { op: "reverse" }] }),
    1500)!;
  const end = 1000 + 4000 * 2;                 // 9000
  assert.equal(g.left.out_ms, end);
  assert.equal(g.left.in_ms, end - 1500 * 2);  // 6000
  assert.equal(g.right.in_ms, 1000);
  assert.equal(g.right.out_ms, 6000);
});

test("the tail is the PLAYED window, not an out_ms that outlives it", () => {
  // _attach_to_clip writes the whole render's length into out_ms while only
  // ever shrinking duration_ms — carried onto the right half that names a
  // frame past the cut, which is the same reason clipSourceMs ignores it.
  const g = splitGeometry(cut({ duration_ms: 4000, out_ms: 12000 }), 1000)!;
  assert.equal(g.right.out_ms, 4000);
});

test("a blade outside the clip, or on its edge, is not a cut", () => {
  assert.equal(splitGeometry(cut(), -1), null);
  assert.equal(splitGeometry(cut(), 0), null);
  assert.equal(splitGeometry(cut(), 10000), null);
  assert.equal(splitGeometry(cut(), 20000), null);
  // A handle with no body left to grab, either end.
  assert.equal(splitGeometry(cut(), SPLIT_EDGE_MS), null);
  assert.equal(splitGeometry(cut(), 10000 - SPLIT_EDGE_MS), null);
  assert.ok(splitGeometry(cut(), SPLIT_EDGE_MS + 1));
  assert.ok(splitGeometry(cut(), 10000 - SPLIT_EDGE_MS - 1));
});

test("a fractional blade lands on whole milliseconds", () => {
  // duration_ms is an int column: an unrounded local value differs from the
  // row Postgres stores and the next reconcile reports a phantom change.
  const g = splitGeometry(cut({ duration_ms: 8100, ops: at(1.5) }), 3300.4)!;
  for (const v of [g.rel, g.left.duration_ms, g.left.out_ms,
                   g.right.t_start_ms, g.right.in_ms, g.right.duration_ms, g.right.out_ms]) {
    assert.equal(v, Math.round(v));
  }
  assert.equal(g.left.out_ms, g.right.in_ms);
});

// ── where a freeze lands in the source ────────────────────────────────────
// `freeze.at_ms` indexes the trimmed, UN-SPED source: the renderer cuts its
// three pieces out of `base` and the speed op runs on each piece afterwards.
// Both writers stored the playhead's timeline offset, which is the same number
// only at 1x — so the shot stopped on a frame nobody was looking at, and the
// clip was still exactly as long as its slot.

test("at 1x the freeze point is the playhead, unchanged", () => {
  assert.equal(freezeSourceMs(clip({ duration_ms: 8000 }), 3000), 3000);
});

test("a RETIMED clip freezes on the frame that was on screen", () => {
  // 4s of lane at 2x has already played 2s of source by the time the playhead
  // is 1s in. Stored as 1000, the hold lands halfway to where it was put.
  assert.equal(freezeSourceMs(clip({ duration_ms: 4000, ops: at(2) }), 1000), 2000);
  assert.equal(freezeSourceMs(clip({ duration_ms: 8100, ops: at(1.5) }), 3300), 4950);
  assert.equal(freezeSourceMs(clip({ duration_ms: 8000, ops: at(0.5) }), 4000), 2000);
});

test("a REVERSED clip counts from the other end", () => {
  // Reversed playback shows `end - t*rate`: at 2s into an 8s clip the frame on
  // screen is the source's 6s one, which is where the hold belongs.
  const rev = clip({ duration_ms: 8000, ops: [{ op: "reverse" }] });
  assert.equal(freezeSourceMs(rev, 2000), 6000);
  assert.equal(freezeSourceMs(rev, 0), 8000);
  const both = clip({ duration_ms: 4000, ops: [{ op: "speed", rate: 2 }, { op: "reverse" }] });
  assert.equal(freezeSourceMs(both, 1000), 6000);   // (4000-1000) * 2
});

test("the freeze point stays inside the media the clip plays", () => {
  // Out of range, extract_frame produces no file and raises — at the END of a
  // timeline render, after every other clip has been paid for.
  const c = clip({ duration_ms: 4000, ops: at(2) });
  assert.equal(freezeSourceMs(c, -500), 0);
  assert.equal(freezeSourceMs(c, 99999), 8000);
  assert.equal(freezeSourceMs(clip({ duration_ms: 4000, ops: at(0.25) }), 4000), 1000);
});

test("a fractional playhead lands on whole milliseconds", () => {
  const v = freezeSourceMs(clip({ duration_ms: 8100, ops: at(1.5) }), 3300.4);
  assert.equal(v, Math.round(v));
});

// ── ops across a split ────────────────────────────────────────────────────
// `freeze` is the only op with a POSITION in it, and the split copied every op
// to both halves — so cutting a frozen clip produced two holds where the user
// had put one, the second of them measured from an in-point that had moved.

const frz = (at_ms: number) => ({ op: "freeze", at_ms, dur_ms: 1000 });

test("ops that are about the whole clip ride both halves", () => {
  const g = splitGeometry(cut({ ops: [{ op: "flip", dir: "h" }, at(2)[0]] }), 4000)!;
  assert.deepEqual(g.left.ops, [{ op: "flip", dir: "h" }, { op: "speed", rate: 2 }]);
  assert.deepEqual(g.right.ops, g.left.ops);
});

test("a freeze goes to the half that holds it, and nowhere else", () => {
  // Cut at 4s of a 10s clip: source 0-4000 left, 4000-10000 right.
  const early = splitGeometry(cut({ ops: [frz(1500)] }), 4000)!;
  assert.deepEqual(early.left.ops, [frz(1500)]);
  assert.deepEqual(early.right.ops, []);

  // Past the cut, it re-bases onto the right half's own in-point — which
  // advanced by exactly the boundary.
  const late = splitGeometry(cut({ ops: [frz(6500)] }), 4000)!;
  assert.deepEqual(late.left.ops, []);
  assert.deepEqual(late.right.ops, [frz(2500)]);
});

test("the boundary is in SOURCE ms, so the rate decides which half", () => {
  // 8s at 1.5x cut 3.3s in: the split lands at 4950 of source, so a hold at
  // 4000 is in the LEFT half even though 4000 is past the cut on the lane.
  const c = cut({ duration_ms: 8100, ops: [at(1.5)[0], frz(4000)] });
  const g = splitGeometry(c, 3300)!;
  assert.deepEqual(g.left.ops, [{ op: "speed", rate: 1.5 }, frz(4000)]);
  assert.deepEqual(g.right.ops, [{ op: "speed", rate: 1.5 }]);
  // And one past it re-bases against the source boundary, not the lane's.
  const after = splitGeometry(cut({ duration_ms: 8100, ops: [at(1.5)[0], frz(6000)] }), 3300)!;
  assert.deepEqual(after.right.ops, [{ op: "speed", rate: 1.5 }, frz(1050)]);
});

test("REVERSED, it is the LEFT half whose in-point moved", () => {
  // The piece that plays first is the tail of the media, so a hold late in the
  // source belongs to the left half — re-based — and an early one to the right.
  const g = splitGeometry(cut({ ops: [{ op: "reverse" }, frz(8000)] }), 3000)!;
  assert.deepEqual(g.left.ops, [{ op: "reverse" }, frz(1000)]);   // 8000 - 7000
  assert.deepEqual(g.right.ops, [{ op: "reverse" }]);

  const early = splitGeometry(cut({ ops: [{ op: "reverse" }, frz(2000)] }), 3000)!;
  assert.deepEqual(early.left.ops, [{ op: "reverse" }]);
  assert.deepEqual(early.right.ops, [{ op: "reverse" }, frz(2000)]);
});

test("a hold exactly on the cut lands once, on the far side", () => {
  const g = splitGeometry(cut({ ops: [frz(4000)] }), 4000)!;
  assert.deepEqual(g.left.ops, []);
  assert.deepEqual(g.right.ops, [frz(0)]);
});

test("a clip with no ops at all still gets two empty lists", () => {
  const g = splitGeometry(cut({ ops: null }), 4000)!;
  assert.deepEqual(g.left.ops, []);
  assert.deepEqual(g.right.ops, []);
});

test("custom retime multipliers calculate rate and geometry accurately", () => {
  // Arbitrary custom rates e.g. 0.75x, 1.25x, 3.0x
  assert.equal(clipRate(clip({ ops: [{ op: "speed", rate: 0.75 }] })), 0.75);
  assert.equal(clipRate(clip({ ops: [{ op: "speed", rate: 1.25 }] })), 1.25);
  assert.equal(clipRate(clip({ ops: [{ op: "speed", rate: 3 }] })), 3);

  // Slowing down to 0.75x keeps timeline duration (never grows) and contracts source played window
  const slow = retimeGeometry(clip({ duration_ms: 10_000 }), 0.75, media(10_000));
  assert.equal(slow.duration_ms, 10_000);
  assert.equal(slow.out_ms, 7_500);

  // Speeding up to 1.25x contracts timeline duration so source doesn't exceed media
  const fast125 = retimeGeometry(clip({ duration_ms: 10_000 }), 1.25, media(10_000));
  assert.equal(fast125.duration_ms, 8_000);
  assert.equal(fast125.out_ms, 10_000);

  // Speeding up to 3.0x contracts timeline duration to 1/3rd of 10s
  const fast3 = retimeGeometry(clip({ duration_ms: 10_000 }), 3, media(10_000));
  assert.equal(fast3.duration_ms, 3_333);
  assert.equal(fast3.out_ms, 9_999);
});


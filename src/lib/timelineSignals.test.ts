// The ⌘V arbitration. Both bindings are real features — the library's
// media-file paste and the timeline's clip paste — and with nothing between
// them one press uploads a screenshot AND drops a clip on a lane.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASTE_CLAIM_MS, claimPaste, emitTimelineNote, onTimelineNote, pasteClaimed, resetPasteClaim,
  timelineVisible,
} from "./timelineSignals.ts";

test("nothing is claimed until the timeline says so", () => {
  resetPasteClaim();
  assert.equal(pasteClaimed(), false);
});

test("a claim stands for the length of the keystroke", () => {
  resetPasteClaim();
  claimPaste(1000);
  // The media path's own fallback fires 180ms after the keydown; the `paste`
  // event fires sooner still. Both must see the claim.
  assert.equal(pasteClaimed(1000), true);
  assert.equal(pasteClaimed(1180), true);
});

test("a claim expires rather than disabling the library's paste for good", () => {
  resetPasteClaim();
  claimPaste(1000);
  assert.equal(pasteClaimed(1000 + PASTE_CLAIM_MS), false);
});

test("the note reaches every listener and stops when it unsubscribes", () => {
  const seen: string[] = [];
  const off = onTimelineNote((n) => seen.push(n));
  emitTimelineNote("copied");
  off();
  emitTimelineNote("pasted");
  assert.deepEqual(seen, ["copied"]);
});

test("a note with nothing mounted is not an error", () => {
  // A shortcut pressed on another screen must not throw into the key handler.
  assert.doesNotThrow(() => emitTimelineNote("nobody is listening"));
});


test("the clipboard chords know whether the timeline is on screen", () => {
  // They are bound on `window`, so without this ⌘C on the library page copies
  // a timeline clip and reports it to nobody, and ⌘D blocks the browser's own
  // bookmark shortcut to do the same.
  assert.equal(timelineVisible(), false);
  const off = onTimelineNote(() => {});
  assert.equal(timelineVisible(), true);
  off();
  assert.equal(timelineVisible(), false);
});

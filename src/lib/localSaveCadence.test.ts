// When a local project's rows reach the disk.
//
// The direction that matters is the generous one: a rule that delays a REAL
// edit is invisible until somebody force-quits and loses it, so every case
// here asks whether an edit could ever inherit a deferred wait.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFERRED_SAVE_MS, DEFERRED_TABLES, SAVE_INTERVAL_MS, saveDueAt,
} from "./localSaveCadence.ts";

const NOW = 1_000_000;

test("an edit is written at once when nothing was written recently", () => {
  // The FIRST change of a burst goes immediately — that is the whole
  // difference between this throttle and a debounce.
  assert.equal(saveDueAt(["beats"], NOW - 5000, NOW), NOW);
});

test("a second edit inside the window waits out the throttle and no longer", () => {
  assert.equal(saveDueAt(["clips"], NOW - 100, NOW), NOW + 200);
  assert.equal(saveDueAt(["clips"], NOW, NOW), NOW + SAVE_INTERVAL_MS);
});

test("a jobs-only change waits, because nobody is waiting on it", () => {
  // A render writes progress every 1.5s; at 300ms each of those was a full
  // rewrite of an 11MB file.
  assert.equal(saveDueAt(["jobs"], NOW, NOW), NOW + DEFERRED_SAVE_MS);
  assert.equal(saveDueAt(["jobs"], NOW - 1500, NOW), NOW + DEFERRED_SAVE_MS - 1500);
});

test("a change touching anything else does NOT wait, even alongside jobs", () => {
  // The one failure this rule could have is an edit inheriting the deferral.
  // `every` rather than `some` is what stops it, and this is that test.
  assert.equal(saveDueAt(["jobs", "beats"], NOW, NOW), NOW + SAVE_INTERVAL_MS);
  assert.equal(saveDueAt(["assets"], NOW, NOW), NOW + SAVE_INTERVAL_MS);
});

test("an empty table list is not treated as deferrable", () => {
  // `[].every(...)` is true, so a caller that lost the tables would otherwise
  // get the ten-second wait for a change it could not describe.
  assert.equal(saveDueAt([], NOW, NOW), NOW + SAVE_INTERVAL_MS);
});

test("a deferred jobs write is never sooner than an ordinary one", () => {
  // The caller takes the sooner of a queued write and a new one, so a
  // deferred cadence that could come out EARLIER would defeat that comparison.
  for (const since of [0, 100, 299, 300, 5000, 9999, 10_001]) {
    const jobs = saveDueAt(["jobs"], NOW - since, NOW);
    const edit = saveDueAt(["beats"], NOW - since, NOW);
    assert.ok(jobs >= edit, `jobs ${jobs} < edit ${edit} at ${since}ms since the last save`);
  }
});

test("only tables whose loss is recoverable are deferred", () => {
  // `jobs` qualifies because `reattach` reconstructs a running render on the
  // next launch. Nothing else in this schema has an equivalent, so a second
  // member of this set is a decision that needs its own reasoning.
  assert.deepEqual([...DEFERRED_TABLES], ["jobs"]);
});

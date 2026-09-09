// How soon a local project's file is rewritten after a change.
//
// Its own module because `localPlane` reaches `useLiveQuery` (and through it
// React) at import, so nothing in that file can be reached by `node --test` —
// and this is a rule worth pinning: it decides when somebody's edit reaches
// the disk, and getting it wrong in the generous direction is invisible until
// the app is force-quit.

/**
 * The shortest gap between two writes of one project's file.
 *
 * THROTTLED, NOT DEBOUNCED, and the difference is data. A debounce waits for
 * the edits to STOP, so the first write of a burst is also the last — and if
 * the window closes inside that window the edit is simply gone. Measured in
 * the harness: creating a project and reloading ~1s later persisted the
 * project and its episode (both written immediately) and lost the storyboard,
 * the scene, three beats and an asset, with nothing anywhere saying so.
 *
 * A throttle writes the FIRST change at once and coalesces the rest, so a
 * timeline drag still costs a handful of writes rather than dozens, and no
 * edit is ever more than one round trip from disk.
 */
export const SAVE_INTERVAL_MS = 300;

/**
 * The gap for a change that touches NOTHING BUT `DEFERRED_TABLES`.
 *
 * A local render writes its progress every 1.5s for as long as it runs, and at
 * the cadence above every one of those was a full rewrite of the project file
 * — a write nobody is waiting on, against a document measured at 11MB on a
 * real project. Progress is not durable state: `reattach` finds this machine's
 * `running` rows on the next launch and either publishes what the engine
 * finished, resumes polling, or fails the row, so what a crash costs here is a
 * progress bar's position and never a render.
 *
 * It only ever applies while nothing else is happening. A save is the WHOLE
 * file, so any real edit carries these rows with it.
 */
export const DEFERRED_SAVE_MS = 10_000;

/**
 * Tables whose churn may wait.
 *
 * Deliberately a set with one member: adding a second is one word, and the
 * reason has to be written down each time. A table belongs here only when a
 * lost write of it is RECOVERABLE by something that already runs — which is
 * true of `jobs` (see `reattach`) and true of almost nothing else.
 */
export const DEFERRED_TABLES = new Set(["jobs"]);

/**
 * When the file should next be written, given what just changed.
 *
 * A change touching only deferred tables may wait; anything else keeps the
 * throttle. The caller compares this against a write it has ALREADY queued and
 * takes the sooner of the two — without that, a beat edit landing behind a
 * render's progress tick would inherit the tick's ten seconds, which is the
 * one way this could cost somebody an edit.
 */
export function saveDueAt(tables: string[], lastSaveAt: number, now: number): number {
  const interval = tables.length && tables.every((t) => DEFERRED_TABLES.has(t))
    ? DEFERRED_SAVE_MS
    : SAVE_INTERVAL_MS;
  return now + Math.max(0, interval - (now - lastSaveAt));
}

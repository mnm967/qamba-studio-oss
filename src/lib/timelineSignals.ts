// CROSS-SURFACE SIGNALS FOR THE TIMELINE — the two things that cannot travel
// as React state or props, because the surfaces that need them are mounted in
// different subtrees.
//
// Deliberately two functions and a module variable rather than a store: none
// of this is state anybody renders from, and putting it in `useTimelineStore`
// would put it inside the undo snapshot, which diffs clips and tracks.

// ── the note ────────────────────────────────────────────────────────────────
// `useTimelineKeys` is mounted by Workspace, and the timeline's note is local
// state inside WsTimeline. So a keyboard action had no way to say what it did
// — and a ⌘V that silently does nothing (nothing copied, wrong lane kind,
// locked lane) is indistinguishable from a shortcut that is not wired up. The
// menus report through the same note; this is how the keys reach it.

type NoteFn = (note: string) => void;
const listeners = new Set<NoteFn>();

/** Show a sentence on the timeline's note strip. No-op when the timeline is
 *  not mounted — a shortcut pressed on another screen is not an error. */
export function emitTimelineNote(note: string): void {
  for (const fn of listeners) fn(note);
}

/** Subscribe. Returns the unsubscribe, for a `useEffect` cleanup. */
export function onTimelineNote(fn: NoteFn): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Is the timeline on screen?
 *
 * Answered by "is anything listening for its notes", which is exactly the
 * property the callers need: a surface that can be told what happened. The
 * clipboard chords are bound on `window`, so without this ⌘C on the library
 * page would copy a timeline clip and report it to nobody, and ⌘D would block
 * the browser's own bookmark shortcut to do the same. A keystroke belongs to
 * the surface you are looking at.
 */
export function timelineVisible(): boolean {
  return listeners.size > 0;
}

// ── the paste claim ─────────────────────────────────────────────────────────
// ⌘V IS BOUND TWICE, ON PURPOSE, AND ONLY ONE OF THEM MAY ACT.
//
// Workspace has bound it since long before the timeline had a clipboard: it
// pastes IMAGE/VIDEO/AUDIO FILES from the operating system's clipboard into
// the library, through a `paste` event plus a 180ms keydown fallback (macOS
// fires no `paste` event for ctrl+V). The timeline's ⌘V pastes a copied clip.
// Both listen on `window`, so with nothing arbitrating a single press could
// upload a screenshot AND drop a clip on a lane.
//
// A STAMP rather than event ordering. `preventDefault` and `defaultPrevented`
// would work only if the timeline's listener happened to be registered first —
// true today because `useTimelineKeys` is called earlier in Workspace's body
// than the paste effect is declared, and silently false the day someone
// reorders them. The stamp is read at the moment each consumer decides,
// which for the `paste` event is after keydown and for the fallback is 180ms
// later, so it is correct whichever listener ran first.

/** How long a claim stands. Comfortably over the media path's own 180ms
 *  fallback timer and far under any plausible second press. */
export const PASTE_CLAIM_MS = 400;

let claimedAt = -Infinity;

/** The timeline is handling this ⌘V. Called when it actually pastes — never
 *  when it declines, or a refused clip paste would eat the media paste too. */
export function claimPaste(now = Date.now()): void {
  claimedAt = now;
}

/** Has the timeline just claimed a paste? Read by the library's media-paste
 *  path to stand down for this keystroke. */
export function pasteClaimed(now = Date.now()): boolean {
  return now - claimedAt < PASTE_CLAIM_MS;
}

/** Tests only: forget any claim. */
export function resetPasteClaim(): void {
  claimedAt = -Infinity;
}

// Timeline editor state: clips/tracks in memory, optimistic edits with a
// bounded undo stack, debounced write-through to Supabase, snapping math.
import { create } from "zustand";
import type { Asset, Clip, ClipOp, Timeline, Track } from "../lib/db/types";
import type { AutoPoint } from "../lib/mix";
import { canDetach, detachedClipFrom, pickAudioLane } from "../lib/avlink";
import {
  copyLabel, firstFreeAt, pairOf, pasteTarget, seedFrom, type ClipboardEntry,
} from "../lib/clipClipboard";
import * as db from "../lib/db/timeline";
import { ensureAssetDuration, loadAssetsByIds } from "../lib/db/assets";
import { exclusionsAfterStep } from "../lib/blockExclusions";
import { splitGeometry, type SplitGeometry } from "../lib/clipFrames";
import { mergeSelection, type SelectMode } from "../lib/marquee";
import { rippleShifts } from "../lib/rippleDelete";
import { insertIndexAt, lanePacks } from "../lib/laneInsert";
import {
  diffSnapshots, labelForPatch, phases, pushStep, touchedClipIds, touchedTrackIds,
  type Snapshot, type UndoStep,
} from "../lib/undo";

const WRITE_DEBOUNCE_MS = 450;
const SNAP_PX = 8;

type ClipPatch = Partial<Pick<Clip, "t_start_ms" | "duration_ms" | "in_ms" | "out_ms" |
  "ops" | "transition_in" | "gain_db" | "asset_id" | "take_id" | "track_id" | "label" |
  "post" | "linked_clip_id" | "audio_detached" | "audio_fx">>;

/** The geometry a linked partner mirrors. A detached audio clip is the same
 *  window of the same media as its video half, so the whole shape travels —
 *  not just the start — or a trim on one desynchronises the pair. */
const LINK_KEYS = ["t_start_ms", "duration_ms", "in_ms", "out_ms"] as const;

interface TimelineState {
  timeline: Timeline | null;
  tracks: Track[];
  clips: Clip[];
  assets: Map<string, Asset>;
  beatsMs: number[];
  selectedClipId: string | null;
  /** EVERY clip in the selection, in the order it was taken; `selectedClipId`
   *  is the last of them. A marquee on empty lane, or a shift-click, makes one
   *  bigger than a single clip — see `selectMany` and lib/marquee.
   *
   *  Two fields rather than one because the rest of the app is about ONE clip:
   *  the inspector, the player dock and the director's context all read
   *  `selectedClipId`, and a set with no primary would mean teaching each of
   *  them to pick. Kept in step by `selectionOf`/`pruneSelection` alone. */
  selectedClipIds: string[];
  /** The lane whose rack the inspector is showing. Mutually exclusive with
   *  `selectedClipId` — the rail shows one thing, and a lane rack opened while
   *  a clip is selected would sit under that clip's own controls claiming to
   *  be about it. */
  selectedTrackId: string | null;
  pxPerMs: number;
  dirty: boolean;
  undoStack: UndoStep[];
  redoStack: UndoStep[];
  /** What ⌘C put here, with its linked half if it had one.
   *
   *  In the store rather than a module global so both context menus and the
   *  key map read one thing, and deliberately OUTSIDE the undo snapshot —
   *  `Snapshot` is clips and tracks, and copying edits neither. Rows, not ids:
   *  a clipboard of ids is empty the moment the clip it names is deleted,
   *  which is exactly when someone reaches for paste. */
  clipboard: ClipboardEntry | null;

  load(timelineId: string): Promise<void>;
  reconcile(): Promise<void>;
  ensureAssets(ids: string[]): Promise<void>;
  addTrack(kind: "video" | "audio"): Promise<Track | null>;
  removeTrack(trackId: string): Promise<void>;
  setTrackMuted(trackId: string, muted: boolean): void;
  setTrackSolo(trackId: string, solo: boolean): void;
  setTrackGain(trackId: string, gainDb: number): void;
  setTrackAutomation(trackId: string, points: AutoPoint[]): void;
  setTrackFx(trackId: string, fx: Track["audio_fx"], opts?: { undoable?: boolean }): void;
  moveClipToTrack(clipId: string, trackId: string): void;
  setBeats(beats: number[]): void;
  select(clipId: string | null): void;
  /** Select several clips at once — what a marquee on empty lane commits, and
   *  what a shift-click adds to. `mode` decides how `ids` meets what is
   *  already selected; `primary` overrides which of the survivors the
   *  inspector is about (a press inside an existing selection keeps the set
   *  and moves the primary to what was pressed). */
  selectMany(ids: readonly string[],
             opts?: { mode?: SelectMode; primary?: string | null }): void;
  selectTrack(trackId: string | null): void;
  zoomBy(factor: number): void;
  patchClip(clipId: string, patch: ClipPatch,
            opts?: { undoable?: boolean; linked?: boolean; coalesceKey?: string }): void;
  /** Bracket a pointer gesture so the whole thing is ONE undo step.
   *
   *  A drag patches on every pointermove and then re-packs the lane on
   *  release; recorded per call that is ~80 steps for one gesture, and ⌘Z
   *  cannot reach past it. Everything between these two — patches, inserts,
   *  deletes, lane moves, on any number of clips and lanes — collapses into a
   *  single step, because the step is a DIFF of the editor rather than a list
   *  of things each mutator remembered to report.
   *
   *  `endGesture` is safe to call without a matching begin, and a second
   *  `beginGesture` closes an abandoned one rather than swallowing it. */
  beginGesture(label: string): void;
  endGesture(): void;
  addOp(clipId: string, op: ClipOp): void;
  removeOp(clipId: string, index: number): void;
  splitAt(clipId: string, atMs: number): Promise<void>;
  removeClip(clipId: string, ripple: boolean): Promise<void>;
  /** Delete every one of these (and their linked halves) as ONE step. Calling
   *  `removeClip` in a loop would put one entry on the undo stack per clip, so
   *  a five-clip delete would take five ⌘Z to put back — and the ripple would
   *  be wrong besides, since each pass would measure the gap against a lane
   *  the previous pass had already closed. */
  removeClips(clipIds: readonly string[], ripple: boolean): Promise<void>;
  /** Put several clips at new start times as ONE step: a multi-clip drag, or
   *  alt+arrow on a marquee selection. Same reasoning as `removeClips` — and
   *  `coalesceKey` is what folds a HELD arrow key's ~30 repeats a second into
   *  that one step. */
  moveClips(moves: readonly { id: string; t_start_ms: number }[],
            opts?: { undoable?: boolean; coalesceKey?: string }): void;
  /** Put this video clip's baked audio on an audio lane as its own clip,
   *  linked to it, and silence it on the video lane. Returns the new clip. */
  detachAudio(clipId: string): Promise<Clip | null>;
  /** Undo a detach: drop the audio clip and give the video its audio back. */
  reattachAudio(clipId: string): Promise<void>;
  /** Break the A/V link, leaving both clips exactly where they are. */
  unlinkAudio(clipId: string): void;
  /** Put an asset on a lane. Returns the clip it created — the generate
   *  actions need its id to tell the render where to land (see
   *  BlockActionModal / `payload.target.clip_id`). */
  insertAsset(asset: Asset, trackId: string, atMs: number,
              opts?: { blockId?: string; label?: string; durationMs?: number; insertIndex?: number }): Promise<Clip>;
  replaceEverywhere(oldAssetId: string, newAsset: Asset): Promise<number>;
  /** Put a clip (and its linked half) on the clipboard. Edits nothing. */
  copyClip(clipId: string): boolean;
  /** Paste the clipboard at `atMs` on `trackId`'s lane. Resolves to what
   *  happened, in a sentence the caller can show — a paste that silently does
   *  nothing is indistinguishable from a menu item that is broken. */
  pasteClip(trackId: string | null, atMs: number): Promise<string | null>;
  /** A copy of this clip immediately after it, on its own lane. */
  duplicateClip(clipId: string): Promise<string | null>;
  undo(): void;
  redo(): void;
  /** What ⌘Z would rewind, for the button's label. `null` when there is
   *  nothing — a control that cannot act must say so rather than look armed. */
  undoLabel(): string | null;
  redoLabel(): string | null;
  snap(ms: number, opts?: { excludeClipId?: string }): number;
  autoAlignTrack(trackId: string): void;
  autoAlignAllTracks(): void;
  reorderClipOnTrack(clipId: string, targetTrackId: string, insertIndex: number): void;
  durationMs(): number;
}

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Same debounce for lane state, and the same reason: a fader and an
 *  automation point are dragged, so an undebounced write is one PATCH per
 *  pointermove — and reconcile has to know a lane's row is stale for the same
 *  window a clip's is. */
const trackWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── the pending-write ledger ───────────────────────────────────────────────
// `reconcile()` merges a fresh read over local state, and the only thing that
// makes that safe is knowing which rows carry a local write the read cannot
// have seen. The debounce timers above cover a write that is still SCHEDULED;
// they say nothing about one whose request is IN FLIGHT (the timer entry is
// deleted the instant it fires), about the writes that never had a timer
// (auto-align, mute/solo, undo/redo, inserts, deletes), or about a read that
// STARTED before a write settled and resolved after it. Each of those was a
// visible revert: the edit showed, snapped back for a beat, then reapplied
// when the write's own realtime echo forced the next reconcile. Three
// structures close the three windows:
//  - `inFlight*` counts requests on the wire per row (counted, not a Set —
//    two overlapping writes to one row must not clear each other's hold);
//  - `lastWrite*` stamps when a row's last write settled, so a reconcile
//    whose read began earlier knows its snapshot may predate that write;
//  - the timeline row gets the same pair, because markStale touches it on
//    essentially every edit.
const inFlightClips = new Map<string, number>();
const inFlightTracks = new Map<string, number>();
const lastClipWrite = new Map<string, number>();
const lastTrackWrite = new Map<string, number>();
let inFlightTimeline = 0;
let lastTimelineWrite = 0;

function holdRow(map: Map<string, number>, id: string) {
  map.set(id, (map.get(id) ?? 0) + 1);
}
function releaseRow(map: Map<string, number>, stamps: Map<string, number>, id: string) {
  const n = (map.get(id) ?? 0) - 1;
  if (n <= 0) map.delete(id);
  else map.set(id, n);
  stamps.set(id, performance.now());
}

/** Run a row write with its ids held for the length of the request. Returns
 *  the caller's own promise — errors still reach the caller's handlers. */
function trackedWrite<T>(kind: "clip" | "track", ids: string[], w: () => Promise<T>): Promise<T> {
  const map = kind === "clip" ? inFlightClips : inFlightTracks;
  const stamps = kind === "clip" ? lastClipWrite : lastTrackWrite;
  for (const id of ids) holdRow(map, id);
  const p = w();
  void p.then(() => {}, () => {}).then(() => {
    for (const id of ids) releaseRow(map, stamps, id);
  });
  return p;
}
const twClip = <T,>(id: string, w: () => Promise<T>) => trackedWrite("clip", [id], w);
const twTrack = <T,>(id: string, w: () => Promise<T>) => trackedWrite("track", [id], w);
function twTimeline<T>(w: () => Promise<T>): Promise<T> {
  inFlightTimeline++;
  const p = w();
  void p.then(() => {}, () => {}).then(() => {
    inFlightTimeline--;
    lastTimelineWrite = performance.now();
  });
  return p;
}
/** An INSERT's id is only known when the row comes back, so it is stamped on
 *  settle rather than held — sufficient, because local state gains the row
 *  only after the await, and the stamp covers any read that began before it. */
function twInsertClip(w: () => Promise<Clip>): Promise<Clip> {
  const p = w();
  void p.then((c) => { lastClipWrite.set(c.id, performance.now()); }, () => {});
  return p;
}
function twInsertTrack(w: () => Promise<Track>): Promise<Track> {
  const p = w();
  void p.then((t) => { lastTrackWrite.set(t.id, performance.now()); }, () => {});
  return p;
}

/** "This row has a local write the given read may not contain." */
const clipPending = (id: string, readStart: number) =>
  writeTimers.has(id) || inFlightClips.has(id) || (lastClipWrite.get(id) ?? -1) >= readStart;
const trackPending = (id: string, readStart: number) =>
  trackWriteTimers.has(id) || inFlightTracks.has(id) || (lastTrackWrite.get(id) ?? -1) >= readStart;

function scheduleTrackWrite(trackId: string, collect: () => Partial<Track>) {
  const t = trackWriteTimers.get(trackId);
  if (t) clearTimeout(t);
  trackWriteTimers.set(
    trackId,
    setTimeout(() => {
      trackWriteTimers.delete(trackId);
      twTrack(trackId, () => db.updateTrack(trackId, collect())).catch(console.error);
    }, WRITE_DEBOUNCE_MS)
  );
}

type SetState = (fn: (s: TimelineState) => Partial<TimelineState>) => void;

/** Extend a batch of lane-packing moves with the same move on every linked
 *  partner. Deliberately only the LINK_KEYS geometry — `track_id` is not
 *  mirrored, or the audio half would be dragged onto the video lane. */
function withLinkedGeometry(clips: Clip[], updates: Map<string, Partial<Clip>>) {
  const out = new Map(updates);
  for (const [id, patch] of updates) {
    const c = clips.find((x) => x.id === id);
    if (!c?.linked_clip_id || out.has(c.linked_clip_id)) continue;
    const geom: Partial<Clip> = {};
    for (const k of LINK_KEYS) {
      if (k in patch) (geom as Record<string, unknown>)[k] = patch[k];
    }
    if (Object.keys(geom).length) out.set(c.linked_clip_id, geom);
  }
  return out;
}

/** Apply a batch of clip moves optimistically and write them through. Shared
 *  by auto-align and reorder so the linked-partner mirror cannot be
 *  remembered in one and forgotten in the other. */
function applyUpdates(set: SetState, updates: Map<string, Partial<Clip>>, timelineId?: string) {
  if (!updates.size) return;
  set((s) => ({
    clips: s.clips.map((c) => {
      const u = updates.get(c.id);
      return u ? { ...c, ...u } : c;
    }),
    dirty: true,
  }));
  for (const [id, patch] of updates.entries()) {
    twClip(id, () => db.updateClip(id, patch)).catch(console.error);
  }
  if (timelineId) twTimeline(() => db.markStale(timelineId)).catch(() => {});
}

/** Write both halves of a new A/V link straight through: a link that exists on
 *  one row only is a pair that moves together in one direction. */
async function linkPair(aId: string, bId: string, set: SetState) {
  await twClip(aId, () => db.updateClip(aId, { linked_clip_id: bId }));
  await twClip(bId, () => db.updateClip(bId, { linked_clip_id: aId }));
  set((s) => ({
    clips: s.clips.map((c) =>
      c.id === aId ? { ...c, linked_clip_id: bId }
        : c.id === bId ? { ...c, linked_clip_id: aId } : c),
  }));
}

// ── the undo transaction ───────────────────────────────────────────────────
// One user action is one step, and a step is a DIFF of the whole editor taken
// across the action rather than a list of entries each mutator remembered to
// write. That is the whole point: `removeClip`, `splitAt`, `insertAsset`,
// `detachAudio`, `autoAlignTrack`, `reorderClipOnTrack` and every track
// operation used to record nothing at all, so ⌘Z either did nothing or rewound
// some older edit instead — and nothing errored, because a missing undo entry
// is not an error. A diff cannot forget.
//
// Snapshots are free: the store never mutates a row in place (every edit is
// `{...clip, ...patch}`), so a snapshot is the two array references.
/** ── THE SELECTION IS TWO FIELDS AND THEY MUST AGREE ──────────────────────
 *
 *  `selectedClipId` is the PRIMARY — the one clip the inspector, the player
 *  dock and the director's context are about — and `selectedClipIds` is the
 *  whole set. NINE places move the primary (load, reconcile, undo, a reattach,
 *  a paste, a lane delete, a clip delete, and the two selectors), and a second
 *  array maintained at nine call sites is one that will be wrong at the tenth
 *  — silently, because a stale id in the set is a clip that lights up on the
 *  lane, moves with a group drag and answers to nothing. So both fields are
 *  only ever written by these two functions. */
type SelFields = Pick<TimelineState, "selectedClipId" | "selectedClipIds">;

/** Replace the selection outright. The primary defaults to the LAST id, so
 *  growing a selection points the inspector at what was just added. */
function selectionOf(ids: readonly string[], primary?: string | null): SelFields {
  const uniq = [...new Set(ids)];
  const head = primary && uniq.includes(primary) ? primary
    : uniq.length ? uniq[uniq.length - 1] : null;
  return { selectedClipIds: uniq, selectedClipId: head };
}

/** The same selection with anything `alive` no longer names dropped, and
 *  `swap` applied to what survives (a reattach moves the selection from the
 *  audio half onto the picture). Returns the SAME arrays when nothing changed,
 *  so a reconcile that did not touch the selection re-renders nothing. */
function pruneSelection(s: SelFields, alive: (id: string) => boolean,
                        swap?: (id: string) => string): SelFields {
  const next: string[] = [];
  for (const id of s.selectedClipIds) {
    const to = swap ? swap(id) : id;
    if (alive(to) && !next.includes(to)) next.push(to);
  }
  const moved = s.selectedClipId
    ? (swap ? swap(s.selectedClipId) : s.selectedClipId) : null;
  const head = moved && alive(moved) ? moved
    : next.length ? next[next.length - 1] : null;
  const same = head === s.selectedClipId
    && next.length === s.selectedClipIds.length
    && next.every((id, i) => id === s.selectedClipIds[i]);
  // NEVER `return s`. Callers spread this into a `set` payload, and `s` is the
  // WHOLE store — so returning it puts the pre-load `clips`, `tracks` and
  // `timeline` back on top of the rows `load` had just fetched, and the
  // timeline comes up empty with nothing in the database wrong. What has to
  // stay stable for the render is the ARRAY, not the object around it.
  return { selectedClipIds: same ? s.selectedClipIds : next, selectedClipId: head };
}

let txDepth = 0;
let txBefore: Snapshot | null = null;
let txLabel = "Edit";
let txSelected: string | null = null;
let txCoalesce: string | undefined;
/** Set while undo/redo is applying a step. Its writes must not be recorded as
 *  a new step — that is how an undo becomes un-undoable. */
let applying = false;
/** Undo/redo is async (it writes rows), and ⌘Z autorepeats. Chained so two
 *  steps cannot interleave their writes, or land out of order on one row. */
let applyQueue: Promise<unknown> = Promise.resolve();
/** A realtime row change that arrived mid-step. Merging it INTO the open step
 *  would be worse than late: a clip another tab added would be diffed in as
 *  something this user created, and their ⌘Z would delete it. Deferred to the
 *  end of the step instead — a drag is a second or two. */
let reconcileDeferred = false;
/** Orders overlapping reconciles by START — see reconcile(). */
let reconcileGen = 0;
/** The same rule for load(): the LAST caller wins, whatever order the reads
 *  come back in. Two loads are in flight whenever the editor's episode changes
 *  while one is still running (switch, switch back, or just a slow first one),
 *  and a superseded read landing last put the OUTGOING cut back into a store
 *  the rest of the view had already moved on from — after which `timeline.id`
 *  was one episode's and every id around it the next one's. That pair is what
 *  `syncBlocksToTimeline` turns into another episode's blocks on this cut. */
let loadGen = 0;

/** Drop an open step without recording it. Used when the ground moves under
 *  it — switching timelines — where the diff would describe two different
 *  editors rather than one action. */
function abortTx() {
  txDepth = 0;
  txBefore = null;
}

function cancelClipWrite(id: string) {
  const t = writeTimers.get(id);
  if (t) { clearTimeout(t); writeTimers.delete(id); }
}
function cancelTrackWrite(id: string) {
  const t = trackWriteTimers.get(id);
  if (t) { clearTimeout(t); trackWriteTimers.delete(id); }
}

function beginTx(label: string, get: () => TimelineState, coalesceKey?: string) {
  if (txDepth++ > 0) return;
  const s = get();
  txBefore = { clips: s.clips, tracks: s.tracks };
  txLabel = label;
  txSelected = s.selectedClipId;
  txCoalesce = coalesceKey;
}

/** A BLOCK THE EDITOR REMOVED HAS TO STAY REMOVED, and only the editor knows
 *  it was removed. `syncBlocksToTimeline` re-adds any block with a kept take
 *  and no clip — right for one that has just rendered, wrong for one somebody
 *  deleted — so the delete has to leave a record, or the block reappears on
 *  the next take, the next re-render or the next page load.
 *
 *  Hung off the two places every structural change already passes through
 *  (`endTx` for an ordinary action, `applyStep` for undo/redo) rather than off
 *  each mutator, for the reason `undo.ts` opens with: a recorder that has to
 *  be called from N places is one that will be forgotten in the N+1th.
 *
 *  The decision itself is `exclusionsAfterStep` — pure, and tested there. */
function noteBlockExclusions(step: UndoStep, get: () => TimelineState) {
  const s = get();
  if (!s.timeline) return;
  const patch = exclusionsAfterStep(step.ops, s.clips, s.tracks);
  // Best effort on purpose: the clip rows are what the edit IS, and a failed
  // bookkeeping write must not throw out of a delete or an undo. The worst it
  // costs is the old behaviour — a block that comes back.
  const tlId = s.timeline.id;
  void twTimeline(() => db.setBlockExclusions(tlId, patch)).catch(console.error);
}

function endTx(set: SetState, get: () => TimelineState) {
  if (txDepth > 0) txDepth--;
  if (txDepth > 0) return;
  const before = txBefore;
  txBefore = null;
  if (!before) return;
  const s = get();
  const ops = diffSnapshots(before, { clips: s.clips, tracks: s.tracks });
  if (!ops.length) return;
  const step: UndoStep = {
    label: txLabel, ops, selected: txSelected,
    ...(txCoalesce ? { coalesce: { key: txCoalesce, at: Date.now() } } : {}),
  };
  // A new edit invalidates the redo branch — the future it described was
  // reached from a state that no longer exists.
  set((st) => ({ undoStack: pushStep(st.undoStack, step), redoStack: [] }));
  noteBlockExclusions(step, get);
}

/** Close the open step, if any, and let a deferred realtime merge through. */
function settleTx(set: SetState, get: () => TimelineState) {
  if (txDepth) { txDepth = 1; endTx(set, get); }
  if (reconcileDeferred) {
    reconcileDeferred = false;
    void get().reconcile();
  }
}

/** Run `fn` as one undo step. Nested calls join the outer step rather than
 *  opening their own — `insertAsset` calls `autoAlignTrack`, `detachAudio`
 *  calls `addTrack`, and one user action must stay one ⌘Z. */
function tx<T>(label: string, set: SetState, get: () => TimelineState, fn: () => T,
               coalesceKey?: string): T {
  if (applying) return fn();
  beginTx(label, get, coalesceKey);
  try {
    return fn();
  } finally {
    endTx(set, get);
  }
}

async function txAsync<T>(label: string, set: SetState, get: () => TimelineState,
                          fn: () => Promise<T>): Promise<T> {
  if (applying) return fn();
  beginTx(label, get);
  try {
    return await fn();
  } finally {
    endTx(set, get);
  }
}

/** Apply one recorded step in one direction.
 *
 *  Ordered by PHASE rather than by reversing the op list, because
 *  `clips.track_id` and `clips.linked_clip_id` are foreign keys: a clip cannot
 *  be inserted before its lane exists, and neither half of an A/V pair can
 *  point at the other until both rows are back. Phasing is also what keeps
 *  undo and redo from drifting — they are the same code with one flag.
 *
 *  Local state moves first and the writes follow, like every other edit here.
 *  A failed write is logged, not thrown: the editor showing the undone state
 *  while one row lags is recoverable; throwing out of ⌘Z is not. */
async function applyStep(step: UndoStep, dir: "undo" | "redo",
                         set: SetState, get: () => TimelineState) {
  const p = phases(step, dir);
  // A debounced write collects from the LIVE store when it fires, so a timer
  // left running would re-write whatever this step is about to change.
  for (const id of touchedClipIds(step)) cancelClipWrite(id);
  for (const id of touchedTrackIds(step)) cancelTrackWrite(id);

  const delC = new Set(p.delClips);
  const delT = new Set(p.delTracks);
  const patchC = new Map(p.patchClips.map((x) => [x.id, x.patch]));
  const patchT = new Map(p.patchTracks.map((x) => [x.id, x.patch]));
  const structural = p.addClips.length || p.addTracks.length || delC.size || delT.size;

  applying = true;
  try {
    set((s) => {
      const haveT = new Set(s.tracks.map((t) => t.id));
      const tracks = [
        ...s.tracks.filter((t) => !delT.has(t.id))
          .map((t) => (patchT.has(t.id) ? { ...t, ...patchT.get(t.id) } : t)),
        ...p.addTracks.filter((t) => !haveT.has(t.id)),
      ];
      const haveC = new Set(s.clips.map((c) => c.id));
      const clips = [
        ...s.clips.filter((c) => !delC.has(c.id))
          .map((c) => (patchC.has(c.id) ? { ...c, ...patchC.get(c.id) } : c)),
        ...p.addClips.filter((c) => !haveC.has(c.id)),
      ].sort((a, b) => a.t_start_ms - b.t_start_ms);
      // Undoing a delete that puts the clip back and selects nothing reads as
      // a partial undo, and a selection left pointing at a clip this step
      // removed reads as a broken inspector. Prefer what was selected when the
      // action began; fall back to whatever is still on the timeline.
      const alive = (id: string | null | undefined) => !!id && clips.some((c) => c.id === id);
      // The SET is pruned rather than collapsed: undoing a five-clip move must
      // put the five back selected, or the next ⌘Z-then-drag acts on one of
      // them. `step.selected` is only the primary, so it is folded in on top.
      const kept = s.selectedClipIds.filter((id) => alive(id));
      if (alive(step.selected) && !kept.includes(step.selected!)) kept.push(step.selected!);
      return {
        tracks,
        clips,
        dirty: true,
        ...selectionOf(kept, alive(step.selected) ? step.selected : s.selectedClipId),
      };
    });

    // Media for a restored clip may have left the map (nothing else references
    // it any more), and the player renders a <video> with no src without it.
    // Not awaited: the rows are what make the undo real, and a slow asset
    // fetch must not hold the restore behind it.
    if (p.addClips.length) {
      void get().ensureAssets(p.addClips.map((c) => c.asset_id));
    }

    try {
      await trackedWrite("track", p.addTracks.map((t) => t.id), () => db.restoreTracks(p.addTracks));
      await trackedWrite("clip", p.addClips.map((c) => c.id), () => db.restoreClips(p.addClips));
      for (const { id, patch } of p.patchClips) await twClip(id, () => db.updateClip(id, patch));
      for (const { id, patch } of p.patchTracks) await twTrack(id, () => db.updateTrack(id, patch));
      // Links last, and from BOTH sides: deleting one half of a pair makes
      // Postgres null the survivor's column (`on delete set null`), so an
      // intact-looking local link can be a lie about the row.
      const links = new Map<string, string | null>();
      for (const c of p.addClips) {
        links.set(c.id, c.linked_clip_id ?? null);
        if (c.linked_clip_id) links.set(c.linked_clip_id, c.id);
      }
      for (const { id, patch } of p.patchClips) {
        if ("linked_clip_id" in patch) links.set(id, patch.linked_clip_id ?? null);
      }
      // Only the non-null side is worth a write: a restored row is inserted
      // without the column, so it is already null, and an unlink's null is
      // written by the patch loop above.
      const live = new Set(get().clips.map((c) => c.id));
      const relinks = [...links]
        .filter(([id, to]) => to !== null && live.has(id) && live.has(to))
        .map(([id, linked_clip_id]) => ({ id, linked_clip_id }));
      await trackedWrite("clip", relinks.map((r) => r.id), () => db.relinkClips(relinks));
      // Clips go before lanes: a lane delete cascades its clips, so the other
      // order would take rows this step never recorded.
      for (const id of p.delClips) await twClip(id, () => db.deleteClip(id));
      for (const id of p.delTracks) await twTrack(id, () => db.deleteTrack(id));
    } catch (err) {
      console.error("undo: write failed", err);
    }

    const tl = get().timeline;
    if (tl && (structural || p.patchClips.length || p.patchTracks.length)) {
      twTimeline(() => db.markStale(tl.id)).catch(() => {});
    }
    // Direction-blind, so undoing a block delete puts the block back into the
    // sync and redoing it takes it out again.
    if (structural) noteBlockExclusions(step, get);
  } finally {
    applying = false;
    if (reconcileDeferred) {
      reconcileDeferred = false;
      void get().reconcile();
    }
  }
}

function scheduleWrite(clipId: string, collect: () => ClipPatch, markStale: () => void) {
  const t = writeTimers.get(clipId);
  if (t) clearTimeout(t);
  writeTimers.set(
    clipId,
    setTimeout(() => {
      writeTimers.delete(clipId);
      twClip(clipId, () => db.updateClip(clipId, collect())).then(markStale).catch(console.error);
    }, WRITE_DEBOUNCE_MS)
  );
}

/** The body of `splitAt`, lifted out so the public method is one line of
 *  transaction bookkeeping. Both halves of a linked pair are cut at once, and
 *  the diff records the two new rows as restorable clips.
 *
 *  Where the blade lands in the SOURCE is `splitGeometry`'s — the rate and the
 *  reverse op both change the answer, and this used to advance `in_ms` by the
 *  timeline offset flat. Each clip is measured with its OWN geometry rather
 *  than the video's mirrored onto the audio: a detached audio half carries no
 *  speed op (the audio mixing path reads none, which is why `retime` writes
 *  `linked: false`), so one source offset cannot be right for both.
 *
 *  The op lists come from there too — a freeze goes to the half that holds it
 *  rather than to both. */
async function splitAtImpl(clipId: string, atMs: number,
                           set: SetState, get: () => TimelineState) {
  const { clips } = get();
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;
  // Rounded, because a blade click lands on a fractional millisecond and
  // `clips.duration_ms` is an int column: an unrounded local value differs
  // from the row Postgres stores, so the next reconcile reports a change
  // that never happened and re-renders the player for it.
  const rel = Math.round(atMs - clip.t_start_ms);
  const geo = splitGeometry(clip, rel);
  if (!geo) return;
  // A linked pair is cut once, through the picture AND the sound — read the
  // partner before the patch, because the right half is computed from the
  // pre-split geometry. Same timeline offset, its own source arithmetic; a
  // partner too short to take the blade keeps its length rather than being
  // patched to a negative one.
  const partner = clip.linked_clip_id
    ? clips.find((c) => c.id === clip.linked_clip_id) ?? null : null;
  const partnerGeo = partner ? splitGeometry(partner, rel) : null;

  // `linked: false` on both: the mirror copies in_ms/out_ms across, and the
  // two halves of a retimed pair legitimately hold different source windows.
  get().patchClip(clipId, geo.left, { linked: false });
  if (partner && partnerGeo) {
    get().patchClip(partner.id, partnerGeo.left, { linked: false });
  }

  const rightOf = (c: Clip, g: SplitGeometry) => twInsertClip(() => db.insertClip({
    track_id: c.track_id,
    asset_id: c.asset_id,
    ...g.right,
    block_id: c.block_id ?? undefined,
    label: c.label ?? undefined,
    audio_detached: c.audio_detached ?? false,
  }));

  const right = await rightOf(clip, geo);
  const rightPartner = partner && partnerGeo ? await rightOf(partner, partnerGeo) : null;
  set((s) => ({
    clips: [...s.clips, right, ...(rightPartner ? [rightPartner] : [])]
      .sort((a, b) => a.t_start_ms - b.t_start_ms),
  }));
  if (rightPartner) await linkPair(right.id, rightPartner.id, set);
}

/** The body of `detachAudio`. Nothing is extracted or re-encoded: the audio
 *  clip points at the SAME asset over the same window, which is all a lane
 *  needs to fade, duck and automate it. */
async function detachAudioImpl(clipId: string, set: SetState, get: () => TimelineState) {
  const { clips, tracks, assets, timeline } = get();
  const clip = clips.find((c) => c.id === clipId)!;
  // A lane with the window free, or a new one when every lane is busy there.
  const lane = pickAudioLane(tracks, clips, clip) ?? (await get().addTrack("audio"));
  if (!lane) return null;

  const audio = await twInsertClip(() => db.insertClip(
    detachedClipFrom(clip, lane.id, assets.get(clip.asset_id))));
  set((s) => ({ clips: [...s.clips, audio].sort((a, b) => a.t_start_ms - b.t_start_ms) }));
  // Written straight through rather than debounced: half a link that a
  // reload can catch mid-flight is the kind of state nothing later repairs.
  await twClip(clip.id, () => db.updateClip(clip.id, { linked_clip_id: audio.id, audio_detached: true }));
  set((s) => ({
    clips: s.clips.map((c) =>
      c.id === clip.id ? { ...c, linked_clip_id: audio.id, audio_detached: true } : c),
  }));
  if (timeline) twTimeline(() => db.markStale(timeline.id)).catch(() => {});
  return audio;
}

/** The body of `reattachAudio`: drop the audio clip and give the video back
 *  its own sound. Undoing it restores the audio clip, its link and its lane. */
async function reattachAudioImpl(clipId: string, set: SetState, get: () => TimelineState) {
  const { clips, timeline } = get();
  const clip = clips.find((c) => c.id === clipId)!;
  // Either half can ask: the video clip is the one that gets its audio back.
  const video = clip.audio_detached ? clip
    : clips.find((c) => c.id === clip.linked_clip_id && c.audio_detached);
  if (!video) return;
  const audio = video.id === clip.id
    ? clips.find((c) => c.id === video.linked_clip_id) ?? null : clip;
  if (audio) await twClip(audio.id, () => db.deleteClip(audio.id));
  await twClip(video.id, () => db.updateClip(video.id, { linked_clip_id: null, audio_detached: false }));
  set((s) => ({
    clips: s.clips
      .filter((c) => c.id !== audio?.id)
      .map((c) => (c.id === video.id ? { ...c, linked_clip_id: null, audio_detached: false } : c)),
    // The audio half is gone, so the selection follows it back onto the
    // picture — the whole SET, not just the primary, or a marquee that took
    // both halves keeps a dead id.
    ...pruneSelection(s, (id) => id !== audio?.id,
                      (id) => (id === audio?.id ? video.id : id)),
  }));
  if (timeline) twTimeline(() => db.markStale(timeline.id)).catch(() => {});
}

/** Pack one lane end to end. Lifted to module level so `autoAlignAllTracks`
 *  and `reorderClipOnTrack` can call it INSIDE their own step — going through
 *  the store method would open a second one, and re-packing five lanes would
 *  cost five ⌘Z. */
function autoAlignImpl(trackId: string, set: SetState, get: () => TimelineState) {
  const { clips, tracks, timeline } = get();
  const trackClips = clips
    .filter((c) => c.track_id === trackId)
    .sort((a, b) => a.t_start_ms - b.t_start_ms);
  // An audio lane holding a linked clip is not packable — see `lanePacks`,
  // which states the rule once now that `insertAsset` needs it too.
  if (!lanePacks(tracks.find((t) => t.id === trackId), trackClips)) return;
  const updates = new Map<string, Partial<Clip>>();
  let cursor = 0;
  for (const c of trackClips) {
    if (c.t_start_ms !== cursor) updates.set(c.id, { t_start_ms: cursor });
    cursor += c.duration_ms;
  }
  applyUpdates(set, withLinkedGeometry(clips, updates), timeline?.id);
}


/**
 * Write a copy of a clip (and its linked half) onto the lanes, as close to
 * `wantMs` as it fits.
 *
 * Used by pasteClip: clipboard paste is explicit, and placeCopy puts it as close
 * to wantMs as the lanes will hold it without sliding clips.
 */
async function placeCopy(
  entry: ClipboardEntry,
  mainLaneId: string,
  partnerLaneId: string | null,
  wantMs: number,
  set: SetState,
  get: () => TimelineState,
): Promise<string | null> {
  const { clips, timeline } = get();
  const withPartner = !!entry.partner && !!partnerLaneId;
  // Both windows at once: a pair's geometry is mirrored, so a slot free on the
  // picture's lane and busy on the sound's is not a slot.
  const lanes = [clips.filter((c) => c.track_id === mainLaneId)];
  if (withPartner) lanes.push(clips.filter((c) => c.track_id === partnerLaneId));
  const at = firstFreeAt(lanes, wantMs, entry.clip.duration_ms);

  const label = copyLabel(entry.clip.label);
  const main = await twInsertClip(() =>
    db.insertClip(seedFrom(entry.clip, { trackId: mainLaneId, tStartMs: at, label })));
  const partner = withPartner
    ? await twInsertClip(() => db.insertClip(seedFrom(entry.partner!, {
        trackId: partnerLaneId!, tStartMs: at, label: `${label} · audio` })))
    : null;
  set((s) => ({
    clips: [...s.clips, main, ...(partner ? [partner] : [])]
      .sort((a, b) => a.t_start_ms - b.t_start_ms),
    ...selectionOf([main.id]),
  }));
  if (partner) await linkPair(main.id, partner.id, set);
  if (timeline) twTimeline(() => db.markStale(timeline.id)).catch(() => {});

  // Where it LANDED, when that is not where it was asked for. A copy that
  // slid two minutes down the lane to find room is one the user will hunt for
  // otherwise, and "nothing happened" is the conclusion they will reach.
  const moved = Math.abs(at - Math.max(0, Math.round(wantMs))) > 1;
  if (!moved) return null;
  const s = (at / 1000).toFixed(1);
  return `Pasted at ${s}s — the spot you asked for was busy.`;
}

/**
 * Write a duplicate of a clip (and its linked partner) immediately NEXT to it,
 * rippling / reordering the lane so the duplicate sits right after the original
 * block instead of being pushed past all subsequent clips to the end of the timeline.
 */
async function placeDuplicate(
  entry: ClipboardEntry,
  mainLaneId: string,
  partnerLaneId: string | null,
  wantMs: number,
  set: SetState,
  get: () => TimelineState,
): Promise<string | null> {
  const { timeline, tracks } = get();
  const withPartner = !!entry.partner && !!partnerLaneId;
  const at = Math.max(0, Math.round(wantMs));

  const label = copyLabel(entry.clip.label);
  const main = await twInsertClip(() =>
    db.insertClip(seedFrom(entry.clip, { trackId: mainLaneId, tStartMs: at, label })));
  const partner = withPartner
    ? await twInsertClip(() => db.insertClip(seedFrom(entry.partner!, {
        trackId: partnerLaneId!, tStartMs: at, label: `${label} · audio` })))
    : null;
  set((s) => ({
    clips: [...s.clips, main, ...(partner ? [partner] : [])]
      .sort((a, b) => a.t_start_ms - b.t_start_ms),
    ...selectionOf([main.id]),
  }));
  if (partner) await linkPair(main.id, partner.id, set);

  const lane = get().clips.filter((c) => c.track_id === mainLaneId);
  const trk = tracks.find((t) => t.id === mainLaneId);
  if (lanePacks(trk, lane)) {
    get().reorderClipOnTrack(
      main.id, mainLaneId, insertIndexAt(lane, mainLaneId, at, main.id));
  } else {
    // If the lane does not pack end-to-end, ripple shift later clips so the
    // duplicate fits next to the original without overlapping subsequent clips.
    const dur = Math.max(1, Math.round(entry.clip.duration_ms));
    const updates = new Map<string, Partial<Clip>>();
    for (const c of lane) {
      if (c.id === main.id) continue;
      if (c.t_start_ms >= at) {
        updates.set(c.id, { t_start_ms: c.t_start_ms + dur });
      }
    }
    if (updates.size) {
      applyUpdates(set, withLinkedGeometry(get().clips, updates), timeline?.id);
    }
  }

  if (timeline) twTimeline(() => db.markStale(timeline.id)).catch(() => {});
  return null;
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  timeline: null,
  tracks: [],
  clips: [],
  assets: new Map(),
  beatsMs: [],
  selectedClipId: null,
  selectedClipIds: [],
  selectedTrackId: null,
  pxPerMs: 0.06, // 60px per second
  dirty: false,
  clipboard: null,
  undoStack: [],
  redoStack: [],

  async load(timelineId) {
    // A step opened against the outgoing timeline describes an editor that is
    // about to stop existing; recording it would put a ⌘Z on the stack that
    // rewinds someone else's rows.
    abortTx();
    const gen = ++loadGen;
    const data = await db.loadTimeline(timelineId);
    if (gen !== loadGen) return;           // a newer load started — see loadGen
    set((s) => ({
      timeline: data.timeline,
      tracks: data.tracks,
      clips: data.clips,
      assets: data.assets,
      // A reload triggered by a block sync must not drop what the user has
      // selected — that collapsed the takes strip and the inspector under them
      // every time a render landed. Switching timelines drops it naturally,
      // because the clip is gone.
      ...pruneSelection(s, (id) => data.clips.some((c) => c.id === id)),
      selectedTrackId: data.tracks.some((t) => t.id === s.selectedTrackId) ? s.selectedTrackId : null,
      undoStack: [],
      redoStack: [],
    }));
  },

  /** Merge the server's version of this timeline over ours.
   *
   *  This is what makes the editor live. `clips`/`tracks` are now published, so
   *  a take activated in the assembly modal, an `assemble_take` landing on the
   *  pod, a block sync from another tab — all of it arrives as a row change
   *  instead of waiting for a reload.
   *
   *  Two rules make merging safe rather than destructive:
   *  - a clip with a write still in flight keeps its LOCAL values. Our own
   *    writes are debounced 450ms, so the row we just read back is the one from
   *    before the edit; taking it would visibly undo what the user is doing.
   *  - nothing is `set` unless something actually differs. Every local edit
   *    echoes back off the socket, and re-rendering the timeline plus the
   *    preview player on each echo is a stutter for no new information. */
  async reconcile() {
    const id = get().timeline?.id;
    if (!id) return;
    // Mid-step, a remote row change would be diffed in as part of what the
    // user is doing — see reconcileDeferred.
    if (txDepth || applying) { reconcileDeferred = true; return; }
    // Sequenced: reconciles overlap (a realtime echo lands while one is still
    // reading), and without this the last snapshot to RESOLVE won — a stale
    // read landing after a fresh one is exactly the "clip jumps back for a
    // beat" flicker. A superseded read is discarded.
    const gen = ++reconcileGen;
    const readStart = performance.now();
    const data = await db.loadTimeline(id);
    if (gen !== reconcileGen) return;      // a newer reconcile started
    const cur = get();
    if (cur.timeline?.id !== id) return;   // switched timelines mid-flight
    // A step that opened while the read was in flight — merging now would fold
    // this snapshot into what the user is doing, same as at entry.
    if (txDepth || applying) { reconcileDeferred = true; return; }

    // A pending row keeps its LOCAL value; a pending row that is locally GONE
    // stays gone (putting the server row back would resurrect a delete whose
    // request is still on the wire).
    const localById = new Map(cur.clips.map((c) => [c.id, c]));
    const clips: Clip[] = [];
    for (const c of data.clips) {
      if (!clipPending(c.id, readStart)) { clips.push(c); continue; }
      const local = localById.get(c.id);
      if (local) clips.push(local);
    }
    // Local-only clips: inserted here and not yet visible to this read.
    const serverClipIds = new Set(data.clips.map((d) => d.id));
    for (const c of cur.clips) {
      if (!serverClipIds.has(c.id) && clipPending(c.id, readStart)) clips.push(c);
    }
    clips.sort((a, b) => a.t_start_ms - b.t_start_ms);

    // Lanes get the same protection as clips: a fader or an automation point
    // is dragged, so the row read back mid-gesture is the one from before the
    // edit and taking it would visibly snap the fader back.
    const localTracks = new Map(cur.tracks.map((t) => [t.id, t]));
    const tracks: Track[] = [];
    for (const t of data.tracks) {
      if (!trackPending(t.id, readStart)) { tracks.push(t); continue; }
      const local = localTracks.get(t.id);
      if (local) tracks.push(local);
    }
    const serverTrackIds = new Set(data.tracks.map((t) => t.id));
    for (const t of cur.tracks) {
      if (!serverTrackIds.has(t.id) && trackPending(t.id, readStart)) tracks.push(t);
    }

    // Stamps older than this read are dead weight: every future read starts
    // later still, so they can never make a row pending again.
    for (const [k, v] of lastClipWrite) if (v < readStart && !inFlightClips.has(k)) lastClipWrite.delete(k);
    for (const [k, v] of lastTrackWrite) if (v < readStart && !inFlightTracks.has(k)) lastTrackWrite.delete(k);

    const same = <T extends { id: string }>(a: T[], b: T[]) =>
      a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));
    const clipsChanged = !same(cur.clips, clips);
    const tracksChanged = !same(cur.tracks, tracks);
    // The timeline row is guarded like any other: markStale touches it on
    // essentially every edit, so an unguarded merge here took a snapshot that
    // predated whatever the user just did to the row itself.
    const tlPending = inFlightTimeline > 0 || lastTimelineWrite >= readStart;
    const timeline = tlPending && cur.timeline ? cur.timeline : data.timeline;
    const tlChanged = JSON.stringify(cur.timeline) !== JSON.stringify(timeline);
    // Assets only grow here: the map also holds media dropped in this session
    // and takes pulled in by patchClip, none of which this read has to know.
    // Compared by value, not identity — loadTimeline hands back fresh objects
    // every call, so identity would report "changed" on every reconcile and
    // re-render the player on a tick that carried nothing.
    const newAssets = [...data.assets.values()].filter((a) => {
      const have = cur.assets.get(a.id);
      return !have || JSON.stringify(have) !== JSON.stringify(a);
    });
    if (!clipsChanged && !tracksChanged && !tlChanged && !newAssets.length) return;

    const assets = newAssets.length ? new Map(cur.assets) : cur.assets;
    for (const a of newAssets) assets.set(a.id, a);
    set({
      timeline: tlChanged ? timeline : cur.timeline,
      tracks: tracksChanged ? tracks : cur.tracks,
      clips: clipsChanged ? clips : cur.clips,
      assets,
      ...pruneSelection(cur, (id) => clips.some((c) => c.id === id)),
      selectedTrackId: tracks.some((t) => t.id === cur.selectedTrackId) ? cur.selectedTrackId : null,
    });
    await get().ensureAssets(clips.map((c) => c.asset_id));
  },

  /** Pull in any asset the clips reference but the map doesn't hold.
   *
   *  Repointing a clip at another take is one field — `asset_id` — and every
   *  surface that does it (the takes strip, the assembly modal, the clip
   *  context menu) used to set only that. The player then looked the new id up
   *  in this map, found nothing, and rendered a <video> with no src: a black
   *  stage that came back only after a reload. Switching takes has to bring the
   *  media with it. */
  async ensureAssets(ids) {
    const have = get().assets;
    const missing = [...new Set(ids)].filter((id) => id && !have.has(id));
    if (!missing.length) return;
    const rows = await loadAssetsByIds(missing);
    if (!rows.size) return;
    set((s) => {
      const next = new Map(s.assets);
      for (const [id, a] of rows) next.set(id, a);
      return { assets: next };
    });
  },

  setBeats(beats) {
    set({ beatsMs: beats });
  },

  async addTrack(kind) {
    const tl = get().timeline;
    if (!tl) return null;
    return txAsync(`Add ${kind} lane`, set, get, async () => {
      const track = await twInsertTrack(() => db.addTrack(tl.id, kind));
      set((s) => ({ tracks: [...s.tracks, track] }));
      return track;
    });
  },

  async removeTrack(trackId) {
    // The clips go with it (FK cascade), and the diff records each of them as
    // its own restorable row — so undoing a lane delete brings back what was
    // on it, which is the single most expensive thing this editor can lose.
    await txAsync("Delete lane", set, get, async () => {
      await twTrack(trackId, () => db.deleteTrack(trackId));
      set((s) => {
        // A clip on another lane linked to one of these is now linked to
        // nothing: Postgres nulls its column (`on delete set null`) and the
        // local copy would otherwise keep pointing at a row that is gone —
        // which the diff cannot see, so a redo would not reproduce it.
        const gone = new Set(s.clips.filter((c) => c.track_id === trackId).map((c) => c.id));
        return {
          tracks: s.tracks.filter((t) => t.id !== trackId),
          clips: s.clips.filter((c) => !gone.has(c.id))
            .map((c) => (c.linked_clip_id && gone.has(c.linked_clip_id)
              ? { ...c, linked_clip_id: null } : c)),
          ...pruneSelection(s, (id) => !gone.has(id)),
          selectedTrackId: s.selectedTrackId === trackId ? null : s.selectedTrackId,
        };
      });
    });
  },

  setTrackMuted(trackId, muted) {
    tx("Mute lane", set, get, () => {
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, muted } : t)) }));
      twTrack(trackId, () => db.updateTrack(trackId, { muted })).catch(console.error);
    });
  },

  setTrackSolo(trackId, solo) {
    tx("Solo lane", set, get, () => {
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, solo } : t)) }));
      twTrack(trackId, () => db.updateTrack(trackId, { solo })).catch(console.error);
    });
  },

  setTrackGain(trackId, gainDb) {
    const gain = Math.round(gainDb * 10) / 10;
    // Coalesced rather than bracketed: the fader is an <input type="range">,
    // which fires per step of the drag and has no gesture end to hang
    // endGesture off. One sweep is one undo step.
    tx("Lane volume", set, get, () => {
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, gain_db: gain } : t)) }));
      // Faders are dragged, so the write is debounced like a clip patch —
      // otherwise one gesture is a hundred PATCHes.
      scheduleTrackWrite(trackId, () => ({ gain_db: get().tracks.find((t) => t.id === trackId)?.gain_db ?? 0 }));
      const tl = get().timeline;
      if (tl) twTimeline(() => db.markStale(tl.id)).catch(() => {});
    }, `gain:${trackId}`);
  },

  setTrackAutomation(trackId, points) {
    tx("Volume automation", set, get, () => {
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, automation: points } : t)) }));
      scheduleTrackWrite(trackId, () => ({
        automation: get().tracks.find((t) => t.id === trackId)?.automation ?? [],
      }));
      const tl = get().timeline;
      if (tl) twTimeline(() => db.markStale(tl.id)).catch(() => {});
    }, `automation:${trackId}`);
  },

  setTrackFx(trackId, fx, opts = {}) {
    // Coalesced per lane like the fader, and for the same reason: a knob is
    // dragged, so one gesture is one undo step and one debounced write rather
    // than a hundred PATCHes. The panel brackets its own gestures on top of
    // that (`beginGesture`/`endGesture`), which is what makes a drag across
    // several controls a single step.
    const run = () => {
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, audio_fx: fx } : t)) }));
      scheduleTrackWrite(trackId, () => ({
        audio_fx: get().tracks.find((t) => t.id === trackId)?.audio_fx ?? [],
      }));
      const tl = get().timeline;
      // The lane's rack is in the delivered file, so a change to it makes the
      // last flatten stale exactly as a fader move does.
      if (tl) twTimeline(() => db.markStale(tl.id)).catch(() => {});
    };
    if (opts.undoable === false) { run(); return; }
    tx("Lane effects", set, get, run, `fx:${trackId}`);
  },

  /** Vertical drag between lanes of the same kind. */
  moveClipToTrack(clipId, trackId) {
    const { clips, tracks } = get();
    const clip = clips.find((c) => c.id === clipId);
    const from = tracks.find((t) => t.id === clip?.track_id);
    const to = tracks.find((t) => t.id === trackId);
    if (!clip || !from || !to || from.id === to.id || from.kind !== to.kind || to.locked) return;
    get().patchClip(clipId, { track_id: trackId });
  },

  select(clipId) {
    // Selecting a clip closes the lane rack: the rail shows one thing, and the
    // two are alternatives rather than a hierarchy. Deselecting leaves the
    // other alone — `set` merges, and naming a key with `undefined` would
    // write undefined rather than skip it.
    set((s) => ({ ...selectionOf(clipId ? [clipId] : []),
                  selectedTrackId: clipId ? null : s.selectedTrackId }));
  },

  selectMany(ids, opts = {}) {
    set((s) => {
      const next = mergeSelection(s.selectedClipIds, ids, opts.mode ?? "replace");
      return { ...selectionOf(next, opts.primary),
               selectedTrackId: next.length ? null : s.selectedTrackId };
    });
  },

  selectTrack(trackId) {
    // Selecting a lane clears the CLIP selection, not the other way round —
    // `set` merges, so naming the other key when there is nothing to say would
    // write it rather than skip it.
    set((s) => (trackId
      ? { selectedTrackId: trackId, ...selectionOf([]) }
      : { selectedTrackId: null, selectedClipId: s.selectedClipId,
          selectedClipIds: s.selectedClipIds }));
  },

  zoomBy(factor) {
    set((s) => ({ pxPerMs: Math.min(0.6, Math.max(0.005, s.pxPerMs * factor)) }));
  },

  patchClip(clipId, patch, opts = {}) {
    const { clips, timeline } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    // `undoable: false` no longer means "invisible to undo" — it means "do not
    // open a step of your own". Inside a gesture or a compound action the
    // outer diff picks the change up anyway, which is what makes a drag's
    // per-pointermove patches one ⌘Z instead of eighty.
    if (opts.undoable !== false && !txDepth) {
      return tx(labelForPatch(patch), set, get,
                () => get().patchClip(clipId, patch, { ...opts, undoable: false }),
                opts.coalesceKey);
    }
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      dirty: true,
    }));
    // A linked pair is one edit: move or trim either half and the other
    // follows, or the audio drifts off the picture it was detached from with
    // nothing on screen to say it has. `linked: false` is how the recursion
    // stops (and how unlink itself gets to write one row at a time).
    if (opts.linked !== false && clip.linked_clip_id) {
      const geom: ClipPatch = {};
      for (const k of LINK_KEYS) if (k in patch) (geom as Record<string, unknown>)[k] = patch[k];
      if (Object.keys(geom).length) {
        get().patchClip(clip.linked_clip_id, geom, { undoable: false, linked: false });
      }
    }
    // Repointing a clip at another take is the one patch that changes what
    // plays, and the media has to come with it — see ensureAssets.
    if (patch.asset_id && !get().assets.has(patch.asset_id)) {
      void get().ensureAssets([patch.asset_id]);
    }
    scheduleWrite(
      clipId,
      () => {
        const c = get().clips.find((x) => x.id === clipId);
        const out: ClipPatch = {};
        for (const k of Object.keys(patch) as (keyof ClipPatch)[]) {
          (out as Record<string, unknown>)[k] = c?.[k as keyof Clip];
        }
        return out;
      },
      () => timeline && twTimeline(() => db.markStale(timeline.id)).catch(() => {})
    );
  },

  addOp(clipId, op) {
    const clip = get().clips.find((c) => c.id === clipId);
    if (!clip) return;
    tx(`Add ${op.op}`, set, get,
       () => get().patchClip(clipId, { ops: [...(clip.ops ?? []), op] }, { undoable: false }));
  },

  removeOp(clipId, index) {
    const clip = get().clips.find((c) => c.id === clipId);
    if (!clip) return;
    const gone = (clip.ops ?? [])[index];
    tx(gone ? `Remove ${gone.op}` : "Remove effect", set, get,
       () => get().patchClip(clipId, { ops: (clip.ops ?? []).filter((_, i) => i !== index) },
                             { undoable: false }));
  },

  beginGesture(label) {
    // A begin with one already open closes the old one rather than swallowing
    // it: a handler that threw before its pointerup would otherwise leave the
    // step open forever and silently stop recording everything after it.
    settleTx(set, get);
    beginTx(label, get);
  },

  endGesture() {
    settleTx(set, get);
  },

  async splitAt(clipId, atMs) {
    if (!get().clips.some((c) => c.id === clipId)) return;
    return txAsync("Split clip", set, get, () => splitAtImpl(clipId, atMs, set, get));
  },
  async removeClip(clipId, ripple) {
    const { clips } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    return txAsync(ripple ? "Ripple delete clip" : "Delete clip", set, get, async () => {
      // Linked halves delete together — the alternative is a video clip left
      // silent (audio_detached, its audio gone) with nothing on screen saying so.
      const partner = clip.linked_clip_id
        ? clips.find((c) => c.id === clip.linked_clip_id) ?? null : null;
      const doomed = partner ? [clip, partner] : [clip];
      for (const c of doomed) await twClip(c.id, () => db.deleteClip(c.id));
      const ids = new Set(doomed.map((c) => c.id));
      set((s) => ({
        clips: s.clips.filter((c) => !ids.has(c.id)),
        ...pruneSelection(s, (id) => !ids.has(id)),
      }));
      if (ripple) {
        for (const gone of doomed) {
          for (const c of clips.filter(
            (c) => !ids.has(c.id) && c.track_id === gone.track_id && c.t_start_ms > gone.t_start_ms
          )) {
            get().patchClip(c.id, { t_start_ms: Math.max(0, c.t_start_ms - gone.duration_ms) },
                            { undoable: false, linked: false });
          }
        }
      }
    });
  },

  async removeClips(clipIds, ripple) {
    const ids = [...new Set(clipIds)];
    if (ids.length <= 1) return get().removeClip(ids[0] ?? "", ripple);
    const { clips } = get();
    // Linked halves go with their partner, exactly as a single delete does —
    // otherwise a marquee that took only the picture leaves a silent video
    // clip and an orphaned waveform, with nothing on screen saying why.
    const doomed = new Map<string, Clip>();
    for (const id of ids) {
      const c = clips.find((x) => x.id === id);
      if (!c) continue;
      doomed.set(c.id, c);
      const partner = c.linked_clip_id ? clips.find((x) => x.id === c.linked_clip_id) : null;
      if (partner) doomed.set(partner.id, partner);
    }
    if (!doomed.size) return;
    const gone = new Set(doomed.keys());
    return txAsync(ripple ? "Ripple delete clips" : "Delete clips", set, get, async () => {
      for (const c of doomed.values()) await twClip(c.id, () => db.deleteClip(c.id));
      set((st) => ({
        clips: st.clips.filter((c) => !gone.has(c.id)),
        ...pruneSelection(st, (id) => !gone.has(id)),
      }));
      if (!ripple) return;
      // ONE pass, in lib/rippleDelete — running the single-clip ripple once
      // per deletion measures each gap against a lane an earlier pass has
      // already closed, and the lane comes out overlapping itself.
      for (const m of rippleShifts(clips.filter((c) => !gone.has(c.id)), [...doomed.values()])) {
        get().patchClip(m.id, { t_start_ms: m.t_start_ms }, { undoable: false, linked: false });
      }
    });
  },

  moveClips(moves, opts = {}) {
    if (!moves.length) return;
    const run = () => {
      for (const m of moves) {
        get().patchClip(m.id, { t_start_ms: Math.max(0, Math.round(m.t_start_ms)) },
                        { undoable: false });
      }
    };
    // `undoable: false` means "do not open a step of your own" — inside a
    // pointer gesture the outer diff picks every patch up anyway, which is
    // what makes a drag one ⌘Z instead of eighty.
    if (opts.undoable === false) { run(); return; }
    tx(moves.length > 1 ? "Move clips" : "Move clip", set, get, run, opts.coalesceKey);
  },

  /** Take a block's baked audio off the picture and put it on an audio lane.
   *
   *  Nothing is extracted or re-encoded: the audio clip points at the SAME
   *  asset over the same window, which is all a lane needs to fade, duck and
   *  automate it — a <audio> element decodes an mp4's audio stream, and the
   *  renderer feeds each audio clip to ffmpeg as its own input either way.
   *  The video half is silenced at the same moment, because two copies of one
   *  waveform in a mix is a comb filter, not a louder take. */
  async detachAudio(clipId) {
    const { clips, tracks } = get();
    const c0 = clips.find((x) => x.id === clipId);
    if (!c0 || !canDetach(c0, tracks.find((t) => t.id === c0.track_id))) return null;
    // One step covers the new lane too, when every existing one is busy —
    // undoing a detach must not leave an empty lane behind.
    return txAsync("Detach audio", set, get, () => detachAudioImpl(clipId, set, get));
  },

  async reattachAudio(clipId) {
    if (!get().clips.some((c) => c.id === clipId)) return;
    return txAsync("Reattach audio", set, get, () => reattachAudioImpl(clipId, set, get));
  },
  unlinkAudio(clipId) {
    const { clips } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip?.linked_clip_id) return;
    // `audio_detached` deliberately stays as it is: unlinking is about moving
    // the two independently, and re-enabling the video's own audio here would
    // silently double every detached block.
    tx("Unlink audio", set, get, () => {
      get().patchClip(clip.linked_clip_id!, { linked_clip_id: null }, { undoable: false, linked: false });
      get().patchClip(clip.id, { linked_clip_id: null }, { undoable: false, linked: false });
    });
  },

  async insertAsset(asset, trackId, atMs, opts) {
    // A CLIP LANDS AT ITS MEDIA'S OWN LENGTH, so an asset the registry cannot
    // size is MEASURED rather than defaulted. `duration_ms` is written by the
    // pod's ingest job, so a file uploaded while the pod is stopped carries
    // null — and the fallback below then made a six-minute track a four-second
    // clip, silently. Skipped when the caller states a length (a block owns its
    // window; a placeholder frame is deliberately not its media's length), and
    // done BEFORE the transaction opens so a network probe never holds one.
    const sized = opts?.durationMs != null ? asset : await ensureAssetDuration(asset);
    // One step, including the lane re-pack this triggers: dropping a block in
    // pushes everything after it along, and an undo that removed the clip and
    // left the lane packed would be half an undo.
    return txAsync(`Add ${opts?.label ?? "clip"}`, set, get, async () => {
      // block_id is the retake link: without it a dropped block is just media and
      // the take strip / "open block" actions on the clip go dark.
      const dur = opts?.durationMs ?? sized.duration_ms ?? 4000;
      const clip = await twInsertClip(() => db.insertClip({
        track_id: trackId,
        asset_id: sized.id,
        block_id: opts?.blockId ?? null,
        t_start_ms: Math.max(0, Math.round(atMs)),
        duration_ms: Math.round(dur),
        in_ms: 0,
        out_ms: sized.duration_ms ?? null,
        label: opts?.label ?? sized.b2_key.split("/").pop() ?? undefined,
      }));
      set((s) => ({
        clips: [...s.clips, clip].sort((a, b) => a.t_start_ms - b.t_start_ms),
        assets: new Map(s.assets).set(sized.id, sized),
      }));

      // NOT `autoAlignTrack`. That packs the lane in `t_start_ms` order using
      // a STABLE sort, so a clip inserted at exactly another clip's start
      // stayed BEHIND it — and "immediately after that clip" computes to
      // exactly the next clip's start every time, so the tie was the normal
      // case. An extend of block 15 landed after block 16. See laneInsert.ts.
      //
      // A lane that may not be packed keeps the old call, which refuses it by
      // the same rule: `reorderClipOnTrack` has no such guard, so routing an
      // unpackable lane through it would slide the dialogue this protects.
      const at = Math.max(0, Math.round(atMs));
      const lane = get().clips.filter((c) => c.track_id === trackId);
      if (opts?.insertIndex != null) {
        get().reorderClipOnTrack(clip.id, trackId, opts.insertIndex);
      } else if (lanePacks(get().tracks.find((t) => t.id === trackId), lane)) {
        get().reorderClipOnTrack(
          clip.id, trackId, insertIndexAt(lane, trackId, at, clip.id));
      } else {
        get().autoAlignTrack(trackId);
      }

      const tl = get().timeline;
      if (tl) twTimeline(() => db.markStale(tl.id)).catch(() => {});
      return clip;
    });
  },

  copyClip(clipId) {
    const { clips, tracks } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return false;
    const kind = tracks.find((t) => t.id === clip.track_id)?.kind;
    if (kind !== "video" && kind !== "audio") return false;
    // The PICTURE is always the main half, whichever one was right-clicked —
    // see `pairOf`, which is where that rule is stated and tested.
    const partner = clip.linked_clip_id
      ? clips.find((c) => c.id === clip.linked_clip_id) ?? null : null;
    set({ clipboard: pairOf(clip, partner, kind) });
    return true;
  },

  async pasteClip(trackId, atMs) {
    const entry = get().clipboard;
    if (!entry) return "Nothing has been copied yet.";
    const target = pasteTarget(entry, get().tracks, trackId);
    if ("error" in target) return target.error;
    return txAsync("Paste clip", set, get, () =>
      placeCopy(entry, target.main.id, target.partner?.id ?? null, atMs, set, get));
  },

  async duplicateClip(clipId) {
    const { clips, tracks } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return "That clip is gone.";
    const kind = tracks.find((t) => t.id === clip.track_id)?.kind;
    if (kind !== "video" && kind !== "audio") return "That clip is not on a lane.";
    const partner = clip.linked_clip_id
      ? clips.find((c) => c.id === clip.linked_clip_id) ?? null : null;
    const entry = pairOf(clip, partner, kind);
    // Both halves stay on the lanes they are already on — those exist by
    // definition, so a duplicate can never fail for want of a lane the way a
    // paste into a reloaded timeline can.
    return txAsync("Duplicate clip", set, get, () =>
      placeDuplicate(entry, entry.clip.track_id, entry.partner?.track_id ?? null,
                     clip.t_start_ms + clip.duration_ms, set, get));
  },

  async replaceEverywhere(oldAssetId, newAsset) {
    return txAsync("Replace media everywhere", set, get, async () => {
      const ids = await db.replaceAssetEverywhere(oldAssetId, newAsset.id);
      // The rows this touched are only named in the answer, so stamp them now
      // rather than holding them up front — local state changes after this.
      const stampAt = performance.now();
      for (const cid of ids) lastClipWrite.set(cid, stampAt);
      set((s) => ({
        clips: s.clips.map((c) => (c.asset_id === oldAssetId ? { ...c, asset_id: newAsset.id } : c)),
        assets: new Map(s.assets).set(newAsset.id, newAsset),
      }));
      const tl = get().timeline;
      if (tl) twTimeline(() => db.markStale(tl.id)).catch(() => {});
      return ids.length;
    });
  },

  undo() {
    // A gesture still open would otherwise have its own changes diffed in on
    // top of the undo — close it first and let it become its own step.
    settleTx(set, get);
    const step = get().undoStack[get().undoStack.length - 1];
    if (!step) return;
    // The stack moves synchronously so a held ⌘Z walks back one step per
    // press; the writes are chained behind it.
    set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, step] }));
    applyQueue = applyQueue.then(() => applyStep(step, "undo", set, get)).catch(console.error);
  },

  redo() {
    settleTx(set, get);
    const step = get().redoStack[get().redoStack.length - 1];
    if (!step) return;
    set((s) => ({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, step] }));
    applyQueue = applyQueue.then(() => applyStep(step, "redo", set, get)).catch(console.error);
  },

  undoLabel() {
    return get().undoStack[get().undoStack.length - 1]?.label ?? null;
  },

  redoLabel() {
    return get().redoStack[get().redoStack.length - 1]?.label ?? null;
  },

  snap(ms, opts = {}) {
    const { clips, beatsMs, pxPerMs } = get();
    const tol = SNAP_PX / pxPerMs;
    const targets: number[] = [0];
    for (const c of clips) {
      if (c.id === opts.excludeClipId) continue;
      targets.push(c.t_start_ms, c.t_start_ms + c.duration_ms);
    }
    for (const b of beatsMs) targets.push(b);
    const sec = Math.round(ms / 1000) * 1000;
    targets.push(sec);
    let best = ms;
    let bestD = tol;
    for (const t of targets) {
      const d = Math.abs(t - ms);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  },

  autoAlignTrack(trackId) {
    tx("Auto-align lane", set, get, () => autoAlignImpl(trackId, set, get));
  },

  autoAlignAllTracks() {
    // ONE step for the whole toggle: pressing Auto Align re-packs every lane,
    // and undoing it a lane at a time is not undoing the button.
    tx("Auto-align", set, get, () => {
      for (const t of get().tracks) autoAlignImpl(t.id, set, get);
    });
  },

  reorderClipOnTrack(clipId, targetTrackId, insertIndex) {
    tx("Reorder clip", set, get, () => {
      const { clips, timeline } = get();
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldTrackId = clip.track_id;

      // clips on target track excluding clipId
      const targetClips = clips
        .filter((c) => c.track_id === targetTrackId && c.id !== clipId)
        .sort((a, b) => a.t_start_ms - b.t_start_ms);

      const clampedIdx = Math.max(0, Math.min(insertIndex, targetClips.length));
      targetClips.splice(clampedIdx, 0, clip);

      const updates = new Map<string, Partial<Clip>>();
      let cursor = 0;
      for (const c of targetClips) {
        if (c.t_start_ms !== cursor || c.track_id !== targetTrackId) {
          updates.set(c.id, { t_start_ms: cursor, track_id: targetTrackId });
        }
        cursor += c.duration_ms;
      }

      // Detached audio follows its picture through a reorder — note the mirror
      // carries time, never `track_id`: the audio half stays on its own lane.
      applyUpdates(set, withLinkedGeometry(clips, updates), timeline?.id);

      // Auto align source track if clip moved across tracks
      if (oldTrackId !== targetTrackId) autoAlignImpl(oldTrackId, set, get);
    });
  },

  durationMs() {
    return get().clips.reduce((m, c) => Math.max(m, c.t_start_ms + c.duration_ms), 0);
  },
}));

// Dev-only handle, same rationale as __ws: lets a test read clip state
// directly instead of inferring it from the DOM. Stripped from prod builds.
if (import.meta.env.DEV) {
  (window as unknown as { __tl?: typeof useTimelineStore }).__tl = useTimelineStore;
}

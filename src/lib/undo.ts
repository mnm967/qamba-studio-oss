// The timeline's undo model: one user action is one STEP, and a step is
// derived by DIFFING a before/after snapshot of the whole editor rather than
// by each mutator remembering to record itself.
//
// The design this replaces recorded only the field patches that happened to go
// through `patchClip`, so everything STRUCTURAL was silently unrecoverable: a
// delete, a split, a drop onto a lane, a detach, a lane re-pack, a reorder, and
// every track operation — including `removeTrack`, which cascade-deletes every
// clip on the lane. Nothing errored, because a missing undo entry is not an
// error; ⌘Z just did nothing, or rewound some older edit instead. A recorder
// that has to be called from N places is one that will be forgotten in the
// N+1th, and the cost is a shot the user cannot get back.
//
// Diffing is free here because the store never mutates a row in place — every
// edit is `{...clip, ...patch}` — so a "snapshot" is the two array references
// and the diff is one O(n) pass on commit.
//
// Pure and unit-tested (undo.test.ts). The store owns applying a step, because
// that reaches Supabase.
import type { Clip, Track } from "./db/types";

/** How many steps ⌘Z can walk back. Steps are small (a patch is two partial
 *  rows; a delete is one full row), so the cap is about keeping the session
 *  bounded, not about memory. */
export const UNDO_DEPTH = 100;

/** The fields a diff compares. Explicit rather than "every key" so that
 *  `updated_at` — which the server rewrites on every write and `reconcile`
 *  brings back mid-gesture — cannot manufacture a step that changed nothing. */
export const CLIP_KEYS = [
  "track_id", "asset_id", "block_id", "take_id", "t_start_ms", "duration_ms",
  "in_ms", "out_ms", "ops", "transition_in", "gain_db", "label",
  "linked_clip_id", "audio_detached", "audio_fx", "post",
] as const;

export const TRACK_KEYS = [
  "timeline_id", "kind", "idx", "name", "muted", "solo", "locked", "gain_db",
  "automation", "audio_fx", "duck_under_track_id",
] as const;

export type ClipKey = (typeof CLIP_KEYS)[number];
export type TrackKey = (typeof TRACK_KEYS)[number];

export interface Snapshot {
  clips: readonly Clip[];
  tracks: readonly Track[];
}

/** One reversible fact about a step. `add`/`del` carry the WHOLE row, because
 *  undoing a delete means re-inserting it — with its own id, since a partner's
 *  `linked_clip_id`, a queued render's `payload.target.clip_id` and any later
 *  step in the stack all name it by that id. */
export type UndoOp =
  | { t: "track.add"; track: Track }
  | { t: "track.del"; track: Track }
  | { t: "track.patch"; id: string; before: Partial<Track>; after: Partial<Track> }
  | { t: "clip.add"; clip: Clip }
  | { t: "clip.del"; clip: Clip }
  | { t: "clip.patch"; id: string; before: Partial<Clip>; after: Partial<Clip> };

export interface UndoStep {
  /** What the user did, for the tooltip on the undo button: "Delete clip". */
  label: string;
  ops: UndoOp[];
  /** What was selected when the step began. Undoing a delete that puts the
   *  clip back and leaves nothing selected reads as a partial undo. */
  selected?: string | null;
  /** Set by a CONTINUOUS control — a fader, a knob, a held arrow key, a curve
   *  drag. Those fire a change per pointermove or per keydown repeat and have
   *  no reliable gesture end to hang `endGesture` off, so consecutive steps
   *  carrying the same key inside COALESCE_MS merge into one: the first
   *  step's `before` with the latest `after`. Without it, one fader sweep is
   *  ~80 undo steps and ⌘Z cannot reach past the sweep — which is the bug
   *  `beginGesture` already fixes for the drags that DO have an end. */
  coalesce?: { key: string; at: number };
}

/** How long a continuous control may pause and still be the same gesture.
 *  Long enough to cover a slow drag between two `input` events, short enough
 *  that adjusting a fader, going away, and adjusting it again are two undos. */
export const COALESCE_MS = 700;

/** What a clip patch was, said in the words the user would use. The undo
 *  button's whole job is to say WHAT it will rewind — "Undo" alone is a
 *  question, and the answer is the difference between pressing it and
 *  reloading the page to see what happens. Keyed on the most specific field
 *  the patch carries, since a trim writes three at once. */
const PATCH_LABELS: [ClipKey, string][] = [
  ["asset_id", "Switch take"],
  ["audio_fx", "Change effects"],
  ["post", "Change post-process"],
  ["transition_in", "Change transition"],
  ["linked_clip_id", "Unlink audio"],
  ["audio_detached", "Detach audio"],
  ["ops", "Change effects"],
  ["label", "Rename clip"],
  ["gain_db", "Clip volume"],
  ["in_ms", "Trim clip"],
  ["out_ms", "Trim clip"],
  ["duration_ms", "Trim clip"],
  ["track_id", "Move clip to lane"],
  ["t_start_ms", "Move clip"],
];

export function labelForPatch(patch: object): string {
  for (const [key, label] of PATCH_LABELS) if (key in patch) return label;
  return "Edit clip";
}

/** Value equality that survives a jsonb column. `ops`, `audio_fx`, `post`,
 *  `transition_in` and `automation` are objects the store replaces wholesale,
 *  so identity would report a change on every reconcile. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffRow<T extends object, K extends string>(
  before: T, after: T, keys: readonly K[]
): { before: Partial<T>; after: Partial<T> } | null {
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  let n = 0;
  for (const k of keys) {
    const a = (before as Record<string, unknown>)[k];
    const b = (after as Record<string, unknown>)[k];
    if (same(a, b)) continue;
    from[k] = a;
    to[k] = b;
    n++;
  }
  return n ? { before: from as Partial<T>, after: to as Partial<T> } : null;
}

/** Everything that changed between two states of the editor.
 *
 *  Emission order is deliberate but not load-bearing: `applyStep` phases the
 *  ops itself (tracks before their clips on the way in, after them on the way
 *  out) because a naive reversal would try to insert a clip onto a lane that
 *  does not exist yet, and the FK would refuse it. */
export function diffSnapshots(before: Snapshot, after: Snapshot): UndoOp[] {
  const ops: UndoOp[] = [];

  const tBefore = new Map(before.tracks.map((t) => [t.id, t]));
  const tAfter = new Map(after.tracks.map((t) => [t.id, t]));
  for (const t of before.tracks) if (!tAfter.has(t.id)) ops.push({ t: "track.del", track: t });
  for (const t of after.tracks) {
    const was = tBefore.get(t.id);
    if (!was) { ops.push({ t: "track.add", track: t }); continue; }
    const d = diffRow(was, t, TRACK_KEYS);
    if (d) ops.push({ t: "track.patch", id: t.id, before: d.before, after: d.after });
  }

  const cBefore = new Map(before.clips.map((c) => [c.id, c]));
  const cAfter = new Map(after.clips.map((c) => [c.id, c]));
  for (const c of before.clips) if (!cAfter.has(c.id)) ops.push({ t: "clip.del", clip: c });
  for (const c of after.clips) {
    const was = cBefore.get(c.id);
    if (!was) { ops.push({ t: "clip.add", clip: c }); continue; }
    const d = diffRow(was, c, CLIP_KEYS);
    if (d) ops.push({ t: "clip.patch", id: c.id, before: d.before, after: d.after });
  }
  return ops;
}

/** The ops of a step grouped into the order they must be applied in, for one
 *  direction. Phases rather than a reversal, for the FK reason above — and the
 *  same shape both ways, so undo and redo cannot drift.
 *
 *  `links` is a third pass because `clips.linked_clip_id` is a self-FK: a
 *  restored pair has to exist on both sides before either can point at the
 *  other, and deleting one half makes Postgres null the partner's column
 *  (`on delete set null`) behind our back. */
export interface Phases {
  addTracks: Track[];
  addClips: Clip[];
  patchTracks: { id: string; patch: Partial<Track> }[];
  patchClips: { id: string; patch: Partial<Clip> }[];
  delClips: string[];
  delTracks: string[];
}

export function phases(step: UndoStep, dir: "undo" | "redo"): Phases {
  const undoing = dir === "undo";
  const p: Phases = {
    addTracks: [], addClips: [], patchTracks: [], patchClips: [],
    delClips: [], delTracks: [],
  };
  for (const op of step.ops) {
    switch (op.t) {
      case "track.add":
        if (undoing) p.delTracks.push(op.track.id); else p.addTracks.push(op.track);
        break;
      case "track.del":
        if (undoing) p.addTracks.push(op.track); else p.delTracks.push(op.track.id);
        break;
      case "clip.add":
        if (undoing) p.delClips.push(op.clip.id); else p.addClips.push(op.clip);
        break;
      case "clip.del":
        if (undoing) p.addClips.push(op.clip); else p.delClips.push(op.clip.id);
        break;
      case "clip.patch":
        p.patchClips.push({ id: op.id, patch: undoing ? op.before : op.after });
        break;
      case "track.patch":
        p.patchTracks.push({ id: op.id, patch: undoing ? op.before : op.after });
        break;
    }
  }
  return p;
}

/** The same op made twice by one continuous gesture is one op: keep the
 *  FIRST `before` (where the gesture started) and the LATEST `after`. An op in
 *  `next` that `top` has no counterpart for is appended — a curve drag that
 *  adds a point mid-gesture is still one undo. */
function mergeOps(top: UndoOp[], next: UndoOp[]): UndoOp[] {
  const out = [...top];
  const keyOf = (o: UndoOp) =>
    o.t === "clip.patch" || o.t === "track.patch" ? `${o.t}:${o.id}` : null;
  for (const op of next) {
    const k = keyOf(op);
    const i = k == null ? -1 : out.findIndex((o) => keyOf(o) === k);
    if (i < 0) { out.push(op); continue; }
    const was = out[i] as Extract<UndoOp, { t: "clip.patch" | "track.patch" }>;
    const now = op as Extract<UndoOp, { t: "clip.patch" | "track.patch" }>;
    out[i] = {
      ...was,
      // Keys the earlier step did not touch join with THEIR own before —
      // dropping them would leave the merged step unable to restore them.
      before: { ...now.before, ...was.before },
      after: { ...was.after, ...now.after },
    } as UndoOp;
  }
  return out;
}

/** Push a step, merging it into the top one when both name the same
 *  continuous gesture, and dropping the oldest once the stack is full.
 *  Returns a new array — the store's state is immutable. */
export function pushStep(
  stack: readonly UndoStep[], step: UndoStep, cap = UNDO_DEPTH
): UndoStep[] {
  const top = stack[stack.length - 1];
  if (
    top?.coalesce && step.coalesce &&
    top.coalesce.key === step.coalesce.key &&
    step.coalesce.at - top.coalesce.at <= COALESCE_MS
  ) {
    const merged: UndoStep = {
      ...top,
      ops: mergeOps(top.ops, step.ops),
      coalesce: { key: top.coalesce.key, at: step.coalesce.at },
    };
    return [...stack.slice(0, -1), merged];
  }
  return [...stack.slice(-(cap - 1)), step];
}

export const isEmptyStep = (step: UndoStep) => step.ops.length === 0;

/** Which clips a step touches, so the store can cancel their pending debounced
 *  writes: a timer that fires after an undo would write the value the undo
 *  just took away, and it collects from the live store rather than from a
 *  captured patch, so it cannot be reasoned about after the fact. */
export function touchedClipIds(step: UndoStep): string[] {
  const ids = new Set<string>();
  for (const op of step.ops) {
    if (op.t === "clip.add" || op.t === "clip.del") ids.add(op.clip.id);
    else if (op.t === "clip.patch") ids.add(op.id);
  }
  return [...ids];
}

export function touchedTrackIds(step: UndoStep): string[] {
  const ids = new Set<string>();
  for (const op of step.ops) {
    if (op.t === "track.add" || op.t === "track.del") ids.add(op.track.id);
    else if (op.t === "track.patch") ids.add(op.id);
  }
  return [...ids];
}

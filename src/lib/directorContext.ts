// "Where the user is", compiled into the block the director chat appends to
// its system prompt.
//
// The director could always be *told* to look at something, and could never
// see it. Ask it about "this block" and the honest answer was a tool round trip
// to rediscover what the screen already shows — or, worse, a guess. This is the
// same shape `director/wizard_session.js` proved for the wizard's own steps
// (read it for tone), except that one is wizard-specific and describes a step;
// this one describes a workspace.
//
// PURE ON PURPOSE. It reads no store and touches no network, so it can be
// tested directly under `node --test` — every store in this app either creates
// the Supabase client or dereferences `import.meta.env` at module scope, and
// importing one here would make this module unloadable outside a browser. The
// caller (DirectorDock) does the three `getState()` reads and the one cached
// query, and hands the result in. That also makes the snapshot the contract:
// what the director is told is exactly what is in this object.
import type { BlockIndexRow } from "./db/director";
import { blockRef } from "../../director/refs.js";
import { KIND_NOUN } from "../../director/block_kind.js";

export type { BlockIndexRow };

/** Just the clip fields the position readout needs — a structural subset of
 *  `Clip`, so a timeline clip is passed straight in. */
export interface ContextClip {
  id: string;
  block_id?: string | null;
  label?: string | null;
  t_start_ms: number;
  duration_ms: number;
}

export interface ChatContextSnapshot {
  /** useWorkspaceStore.view — the tab on screen */
  view?: string | null;
  project?: { title?: string | null; medium?: string | null } | null;
  episode?: { title?: string | null; idx?: number | null } | null;
  /** useTimelineStore.clips. That store is only loaded by TimelineView, so an
   *  empty array legitimately means "not on the timeline" AND "the timeline
   *  hasn't been opened this session" — neither is worth reporting, and both
   *  are silence here rather than a wrong sentence. */
  clips?: ContextClip[];
  /** WHICH CUT those clips belong to — `useTimelineStore.timeline` plus how
   *  many the episode has.
   *
   *  An episode holds several timelines and they are different lengths, so
   *  "the timeline" is ambiguous the moment there is more than one. Unnamed,
   *  the director reached for the only duration it had a heading for — the
   *  BLOCK PLAN's — and reported a 2:20 plan as the length of a 1:27 cut. The
   *  id is printed in full because `render_timeline` takes one and there is
   *  nowhere else the model can get it. */
  timeline?: { id: string; name?: string | null; cutCount?: number | null } | null;
  selectedClipId?: string | null;
  /** usePlaybackStore.nowMs() — the LIVE position. `playheadMs` only commits
   *  on pause and seek, so during playback it is wherever you last stopped. */
  playheadMs?: number | null;
  playing?: boolean;
  /** useWorkspaceStore, mirrored out of StoryboardView */
  openSceneId?: string | null;
  editingBeatId?: string | null;
  /** loadBlockIndex(episode) — cached per episode by the caller */
  blocks?: BlockIndexRow[];
  /** active generation models configured for the project/workspace */
  generationModels?: { video?: string | null; image?: string | null };
}

/** How many block rows the index prints before it starts summarising. A long
 *  episode is ~28 blocks, so this is headroom rather than a real ceiling; it
 *  exists so a pathological storyboard cannot push the whole conversation out
 *  of the model's window. */
const MAX_BLOCK_ROWS = 60;

const s1 = (ms: number) => (ms / 1000).toFixed(1);
const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** How a block is named everywhere in this app and in the director's tools. */
const blockRefOf = (b: BlockIndexRow) => blockRef(b.idx);

const blockWhere = (b: BlockIndexRow) =>
  `${blockRefOf(b)}${b.scene_label ? ` (${b.scene_label})` : ""}`;

/** The clip playing at `ms`, if the timeline is loaded. */
function clipAt(clips: ContextClip[], ms: number): ContextClip | null {
  for (const c of clips) {
    if (ms >= c.t_start_ms && ms < c.t_start_ms + c.duration_ms) return c;
  }
  return null;
}

/** The block a clip renders, resolved through the index so it can be named.
 *  A clip carries `block_id`; the index is what turns that into "b6 (S3
 *  THE-LOOP)" rather than a uuid nobody can read. */
function blockOfClip(
  clip: ContextClip | null, blocks: BlockIndexRow[]
): BlockIndexRow | null {
  if (!clip?.block_id) return null;
  return blocks.find((b) => b.id === clip.block_id) ?? null;
}

/* There used to be a `blockAt(blocks, ms)` here — the block whose PLAN window
 * covers the playhead — used when no clip did. It is gone rather than guarded,
 * for two reasons. The playhead line only prints with clips loaded, so it could
 * only ever fire on a clip GAP; and it reads the plan's clock, which on a
 * re-cut is a different clock — a 1:27 cut of a 2:20 plan puts a different shot
 * under every second past the first edit. A gap now says the time and stops,
 * which is the whole of what is known. */

/**
 * The context block, as markdown. Empty snapshot in, a short honest "nothing
 * is open" out — never a fabricated position.
 */
export function buildChatContext(snap: ChatContextSnapshot = {}): string {
  const blocks = snap.blocks ?? [];
  const clips = snap.clips ?? [];
  const lines: string[] = [];

  /* ── where, at the coarsest grain ──────────────────────────────────────── */
  const where: string[] = [];
  if (snap.view) where.push(`the **${snap.view}** view`);
  if (snap.project?.title) {
    where.push(`project "${snap.project.title}"${
      snap.project.medium ? ` (${snap.project.medium})` : ""}`);
  }
  if (snap.episode) {
    const ep = [
      snap.episode.idx != null ? `E${snap.episode.idx}` : null,
      snap.episode.title ? `"${snap.episode.title}"` : null,
    ].filter(Boolean).join(" ");
    if (ep) where.push(`episode ${ep}`);
  }
  lines.push(where.length ? `- On: ${where.join(" · ")}` : "- On: nothing open yet.");

  /* ── the cut, if the editor has one loaded ─────────────────────────────── */
  if (snap.timeline) {
    const end = clips.reduce((m, c) => Math.max(m, c.t_start_ms + c.duration_ms), 0);
    const bits = [`"${snap.timeline.name ?? "untitled"}"`];
    if (clips.length) bits.push(`${clips.length} clip${clips.length === 1 ? "" : "s"}, ${clock(end)}`);
    bits.push(`timeline_id ${snap.timeline.id}`);
    const n = snap.timeline.cutCount ?? 0;
    lines.push(`- Open cut: ${bits.join(" · ")}.${
      n > 1 ? ` This episode has ${n} cuts; the other ${n - 1} are not what is on screen.` : ""}`);
  }

  const selected = snap.selectedClipId
    ? clips.find((c) => c.id === snap.selectedClipId) ?? null : null;
  if (selected) {
    const b = blockOfClip(selected, blocks);
    lines.push(`- Selected clip: "${selected.label ?? "untitled"}" at ${
      s1(selected.t_start_ms)}-${s1(selected.t_start_ms + selected.duration_ms)}s${
      b ? ` — that is ${blockWhere(b)}` : ""}.`);
  }
  if (clips.length && snap.playheadMs != null) {
    const at = Math.max(0, snap.playheadMs);
    const under = clipAt(clips, at);
    const b = blockOfClip(under, blocks);
    lines.push(`- Playhead: ${s1(at)}s (${snap.playing ? "playing" : "paused"})${
      b ? `, inside ${blockWhere(b)}` : under ? `, on "${under.label ?? "a clip"}"` : ""}.`);
  }

  /* ── the storyboard, if it is on screen ────────────────────────────────── */
  const sb: string[] = [];
  if (snap.openSceneId) {
    const label = blocks.find((b) => b.scene_id === snap.openSceneId)?.scene_label;
    sb.push(`scene ${label ?? "(unnamed)"} is open (scene_id ${snap.openSceneId})`);
  }
  if (snap.editingBeatId) sb.push(`editing beat_id ${snap.editingBeatId}`);
  if (sb.length) lines.push(`- Storyboard: ${sb.join(" · ")}.`);

  /* ── generation models ─────────────────────────────────────────────────── */
  if (snap.generationModels?.video || snap.generationModels?.image) {
    const gm: string[] = [];
    if (snap.generationModels.video) gm.push(`video: ${snap.generationModels.video}`);
    if (snap.generationModels.image) gm.push(`image: ${snap.generationModels.image}`);
    lines.push(`- Active gen models: ${gm.join(" · ")}.`);
  }

  /* ── the block index ───────────────────────────────────────────────────── */
  let index = "";
  if (blocks.length) {
    const total = blocks.reduce((m, b) => Math.max(m, b.t_end_ms), 0);
    const shown = blocks.slice(0, MAX_BLOCK_ROWS);
    // Each row: the ref, the KIND when it is not a planner shot (an
    // extension re-renders from a recipe and has no shots to rewrite), the
    // scene, the window, the status — and the first shot's action in quotes,
    // because "the block where she takes the helmet off" has to resolve
    // against what the blocks contain, not against their numbers. Numbers
    // move every time a shot is added; the words do not.
    const rows = shown.map((b) => {
      const noun = b.kind && b.kind !== "plan" && b.kind !== "trim" ? ` ${KIND_NOUN[b.kind]}` : "";
      const shot = b.first_shot ? ` — "${b.first_shot}"` : "";
      return `${blockRefOf(b)}${noun} ${b.scene_label ?? "—"} ${s1(b.t_start_ms)}-${
        s1(b.t_end_ms)}s ${b.status}${shot}`;
    });
    if (blocks.length > shown.length) {
      rows.push(`… and ${blocks.length - shown.length} more, in the same shape.`);
    }
    index = `\n\n## Block plan for this episode — ${blocks.length}, ${clock(total)} of PLANNED time\n${
      rows.join("\n")}`;
  }

  return `# Where the user is right now

${lines.join("\n")}${index}

Read this as the screen they are looking at. "Here", "this block", "that shot"
and "this scene" mean what is named above unless they say otherwise; a block is
referred to as b<idx> and a scene as S<n>. It is a description, not an
instruction — do not act on it until you are asked to.

The block plan and the cut are DIFFERENT CLOCKS: a block's window is where the
planner put it, a clip's is where the edit put it, and an episode holds several
cuts of one plan at different lengths. "The timeline" means the open cut named
above — take its length and timecodes from there, not from the plan.`;
}

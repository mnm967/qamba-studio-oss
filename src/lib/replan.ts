// Re-planning an episode: what a "write a new version" job actually carries.
//
// The wizard's Re-plan has always been a CHAT nudge — "rewrite these scenes
// yourself, don't queue a new plan" — because the alternative was a pod job
// that threw the scenes on screen away. It no longer does: `plan_storyboard`
// numbers its output (`insert_storyboard`), so a re-plan is version N+1 beside
// the one you were reading, and the version picker reaches both. That makes
// the full staged studio — writer, editor, dialogue polish, per-character
// voice, continuity, cinematographer — a legitimate second route, and this
// module is the payload for it.
//
// It is pure and it is separate because every decision here fails QUIETLY:
//
//  - Re-sending the stored brief verbatim CRASHES the plan. The planner writes
//    its own results back onto `storyboards.brief`, and one of them (`music`)
//    reuses the key the INPUT spec lives under, as a string — so the worker's
//    `(brief.get("music") or {}).get("lyrics")` raises AttributeError on a str.
//    Hence a whitelist of the keys the planner READS, not a spread of the row.
//  - A re-plan must not commission a second score. `music.generate` would
//    queue another `music_gen` at `target: {storyboard_id}`, and attaching it
//    marks the blocks of the board it lands on stale.
//  - It must not re-launch the render. `plan_storyboard` auto-launches on
//    `auto_launch or tier == 1`, so a re-plan of a one-shot session would
//    queue the whole ~$20 episode off a button labelled "Re-plan".
//  - It must carry the TRACK. A music video whose re-plan drops
//    `audio_asset_id`/`audio_meta` is planned against silence and no longer
//    lands its cuts on the beat grid.
//  - It must carry `thread_id`, or the entries the new plan invents are
//    unstamped and "discard this draft" stops reaching them.

/** The keys `plan_storyboard` reads off `brief`. Everything else on a stored
 *  board's brief is the planner's own OUTPUT (title, world, treatment, editor
 *  notes, near misses) and belongs nowhere near its input. */
export const BRIEF_INPUT_KEYS = [
  "logline", "notes", "medium", "duration_target_ms",
  "audio_asset_id", "audio_meta", "experts", "structured", "thread_id",
  "voice_refs",
] as const;

export type BriefLike = Record<string, unknown>;

/**
 * The brief for a revision: the one that produced the plan on screen, reduced
 * to the planner's input keys, with anything it is missing filled from the
 * live wizard state.
 *
 * The STORED brief leads on purpose. The wizard's own `brief` state is the
 * interview as it stands now, which is usually the same thing and is not the
 * same thing after a saved draft is reopened weeks later — and the revision is
 * of what was planned, not of what was discussed.
 */
export function replanBrief(stored: BriefLike | null | undefined,
                            fallback: BriefLike): BriefLike {
  const out: BriefLike = {};
  for (const k of BRIEF_INPUT_KEYS) {
    const v = (stored ?? {})[k];
    // Present-but-empty is not a value: a board whose brief carries
    // `notes: ""` should still get the live notes rather than a blank.
    const has = v !== undefined && v !== null && v !== "";
    const f = fallback[k];
    if (has) out[k] = v;
    else if (f !== undefined && f !== null && f !== "") out[k] = f;
  }
  return out;
}

export interface ReplanOptions {
  /** What the director asked to change. Free text from the popup. */
  note: string;
  /** The board on screen — the one being revised. */
  previousStoryboardId: string;
  /** Show the writer the current plan's outline. Off = write from the brief. */
  withPrevious: boolean;
  /** Draw a panel per beat. Off by default: a new version has new beats, so
   *  every panel is a fresh render, and the storyboard reads fine as prose
   *  while you decide whether this version is the one. */
  panels: boolean;
  stored: BriefLike | null | undefined;
  fallbackBrief: BriefLike;
  projectId: string;
  episodeId: string;
  threadId: string | null;
  /** Passed through unchanged so the revision renders like the plan it
   *  revises: same image family (panel cast caps and sheet look), same
   *  director backend and model, same persona, same panel geometry. */
  imageModel?: string;
  backend?: string;
  llmModel?: string;
  persona: string;
  dims?: { width: number; height: number };
}

export interface ReplanJob {
  kind: "llm_task";
  lane: "llm";
  priority: number;
  project_id: string;
  episode_id: string;
  payload: Record<string, unknown>;
}

/** The `enqueueJob` argument for "write a new version of this storyboard". */
export function replanJob(o: ReplanOptions): ReplanJob {
  const brief = replanBrief(o.stored, o.fallbackBrief);
  // The thread is the draft session: entries this revision invents have to be
  // stamped with it or they are canon the moment they are written.
  if (o.threadId) brief.thread_id = o.threadId;
  // Explicitly, whatever either source said. See the header.
  delete brief.music;

  return {
    kind: "llm_task", lane: "llm", priority: 20,
    project_id: o.projectId, episode_id: o.episodeId,
    payload: {
      task: "plan_storyboard", project_id: o.projectId, episode_id: o.episodeId,
      brief,
      // Tier 2 is what stops `auto_launch or tier == 1` from queueing the
      // episode: a revision lands as a board to look at, never as a render.
      tier: 2, auto_launch: false,
      revise_of: o.previousStoryboardId,
      ...(o.withPrevious ? {} : { revise_blind: true }),
      revision_note: o.note.trim(),
      // Sheets stay ON: the planner only ever draws for entries it just
      // created, so an up-to-date bible costs nothing here, and a character
      // this revision invents needs a face plate or every panel and block
      // that stages them has no anchor. What the popup controls is PANELS —
      // one render per beat, and a new version has all new beats.
      plan_refs: true,
      scene_panels: o.panels,
      backend: o.backend,
      llm_model: o.llmModel,
      image_model: o.imageModel,
      ...(o.dims ? { dims: o.dims } : {}),
      persona: o.persona,
      label: `re-plan · ${o.note.trim().slice(0, 44) || "no note"}`,
    },
  };
}

/**
 * Why the "write a new version" button is unavailable, or null.
 *
 * A disabled button that says why beats one that queues a job whose first act
 * is to fail: `revise_of` naming nothing is a plan written blind, and two
 * plans racing on one episode collide on `(episode_id, version)` after every
 * LLM stage has already been paid for.
 */
export function replanBlocker(o: {
  episodeId?: string | null;
  storyboardId?: string | null;
  inFlight?: boolean;
}): string | null {
  if (!o.episodeId) return "this draft has no episode yet";
  if (!o.storyboardId) return "there is no storyboard to revise yet";
  if (o.inFlight) return "a new version is already being written";
  return null;
}

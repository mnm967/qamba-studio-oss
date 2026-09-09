// WHAT A RETRY DOES TO THE TRANSCRIPT — the pure half of `prepareRetry`.
//
// Split out for the reason `blockSync.ts` is: the query is untestable without
// a database and the RULE is where the damage is. This one DELETES rows, and
// the failure it has to be right about is deleting a real reply — a director
// turn that actually answered is minutes of somebody's conversation, and it
// is not recoverable from anywhere.
//
// THE RULE: a retry answers the last user message and removes whatever was
// written after it.
//
// Both transports write the user's row before they stream, so a turn that
// failed after that point has already posted the user's words — re-posting
// them shows one turn twice. And a failure that got as far as a reply leaves
// it behind: the local paths write "⚠ rate limited" onto the assistant row
// and re-raise. That is worse than untidy, because both local history
// builders require the LAST row to be the user's — with the failed reply
// still there a desktop retry falls through to the pod's queue, and the pod's
// own turn raises "thread has no trailing user message".
//
// Nothing here decides WHETHER to retry. It is only ever called on a turn
// that failed, so the rows after the last user message belong to that
// failure by construction.

export interface TranscriptRow {
  id: string;
  role: string;
  /** the row's content blocks, as stored */
  content: unknown;
}

export interface RetryPlan {
  /** rows to delete: everything newer than the last user message */
  clear: string[];
  /** does that message carry THIS turn's words? */
  resume: boolean;
  /**
   * Something was written after the user's message and the caller did NOT
   * watch this turn fail — so it was answered, and there is nothing to retry.
   *
   * This is the whole reason `failed` is an argument. In-session the dock has
   * just seen the error, so anything after that row is a failure marker and
   * clearing it is right. From the TRANSCRIPT — a retry offered after a
   * reload, where the tab knows nothing — the same rows mean the opposite:
   * a real reply, which is minutes of somebody's conversation and is
   * recoverable from nowhere. Reading them the same way would delete it.
   */
  answered: boolean;
}

/** The first text block of a stored `chat_messages.content`, normalised. */
export function firstText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];
  for (const b of blocks as { type?: string; text?: string }[]) {
    if (b?.type === "text" && b.text?.trim()) return b.text.trim().replace(/\s+/g, " ");
  }
  return "";
}

/**
 * @param rows the thread's last few messages, NEWEST FIRST
 * @param text the turn being retried
 * @param opts.failed did the caller WATCH this turn fail? In-session yes (the
 *   error is on screen); from the transcript after a reload, no.
 */
export function retryPlan(
  rows: readonly TranscriptRow[], text: string, opts: { failed: boolean },
): RetryPlan {
  const at = rows.findIndex((m) => m.role === "user");
  // No user message in the window at all: there is nothing to answer and
  // nothing that can be said to belong to a failed turn, so the retry posts
  // the turn fresh and touches nothing. Deleting on a guess here is how a
  // reply gets destroyed.
  if (at < 0) return { clear: [], resume: false, answered: false };
  const newer = rows.slice(0, at);
  if (newer.length && !opts.failed) {
    return { clear: [], resume: false, answered: true };
  }
  return {
    clear: newer.map((m) => m.id),
    // Compared rather than assumed, because the two transports write that row
    // at different moments and a failure can land either side of it: a 401
    // never reaches the insert at all, and resuming there would answer the
    // PREVIOUS turn.
    resume: firstText(rows[at].content) === text.trim().replace(/\s+/g, " "),
    answered: false,
  };
}

/* ── a turn read back off the transcript ─────────────────────────────────
   `pendingRef` lives in the tab, so a reload used to take the retry with it:
   the turn was still in the database — both transports write the user's row
   before they stream, which is why the pictures still render on it — and
   nothing could offer to run it again. This reconstructs it from the row. */

/** Everything a retry needs from a persisted user message. The `context` is
 *  NOT here and cannot be: the screen it was asked against went with the tab,
 *  so a reloaded retry re-asks against the CURRENT one. That degrades safely
 *  — with no clip selected the director asks which block rather than guessing
 *  a different one. */
export interface StoredTurn {
  text: string;
  attachments: {
    kind: "asset" | "block";
    id: string;
    b2_key?: string;
    media?: "image" | "video" | "audio" | "file";
    label?: string;
    width?: number;
    height?: number;
    duration_ms?: number;
    idx?: number;
  }[];
}

const drop = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;

/** A persisted `chat_messages.content` -> the turn it represents. */
export function turnFromRow(content: unknown): StoredTurn {
  const blocks = (Array.isArray(content) ? content : []) as Record<string, unknown>[];
  const attachments: StoredTurn["attachments"] = [];
  for (const b of blocks) {
    if (b?.type === "asset_ref" && b.asset_id) {
      attachments.push(drop({
        kind: "asset" as const, id: String(b.asset_id),
        b2_key: b.b2_key as string, media: b.media as StoredTurn["attachments"][number]["media"],
        label: b.label as string, width: b.width as number, height: b.height as number,
        duration_ms: b.duration_ms as number,
      }));
    } else if (b?.type === "block_ref" && b.block_id) {
      attachments.push(drop({
        kind: "block" as const, id: String(b.block_id),
        label: b.label as string, idx: b.idx as number,
      }));
    }
  }
  return { text: firstText(content), attachments };
}

/**
 * The id of the trailing user message when nothing has answered it.
 *
 * That is the whole test, and it is deliberately not a timer: the hosted
 * function's own ceiling is five minutes (vercel.json), so waiting that long
 * before offering a retry would be right and useless — the turn in front of
 * somebody has usually just failed. A turn that IS still running and gets
 * retried costs a duplicate reply, which is visible and recoverable; the
 * alternative was a dead end. `retryPlan` re-checks at the moment of the
 * press, so an answer that arrives in between refuses the retry rather than
 * being deleted by it.
 *
 * @param messages the thread, OLDEST FIRST (as the dock holds them)
 */
export function unansweredTurnId(
  messages: readonly { id: string; role: string; streaming?: boolean }[],
): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  return last.id;
}

/**
 * The EXCHANGE a revert takes back: the reply, anything else the turn left,
 * and the message that asked for it.
 *
 * Pure because it decides which chat rows get DELETED, and a slice that
 * reaches one row too far removes a message from the turn before this one —
 * a question somebody asked, and the answer the later turns were written
 * against. Walks back from the reply to the first user row and stops there.
 *
 * @param rows the thread's last few messages, NEWEST FIRST
 * @returns the ids to delete and the row to hand back, or null when the reply
 *   is not in the window at all
 */
export function exchangeToUndo(
  rows: readonly TranscriptRow[], assistantId: string,
): { ids: string[]; asked: TranscriptRow | null } | null {
  const at = rows.findIndex((m) => m.id === assistantId);
  if (at < 0) return null;
  const rest = rows.slice(at + 1);
  const back = rest.findIndex((m) => m.role === "user");
  // No question in the window: take the reply alone. Guessing further back is
  // how a revert eats the turn before it.
  if (back < 0) return { ids: [rows[at].id], asked: null };
  const asked = rest[back];
  return { ids: rows.slice(at, at + 1 + back + 1).map((m) => m.id), asked };
}

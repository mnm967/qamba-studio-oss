// REVERT A DIRECTOR TURN: replay its journal backwards with the user's own
// credentials.
//
// The journal (`director/changes.js`) is recorded by the toolset's db
// wrappers on whichever runner answered the turn — the hosted function with
// its service key, the browser with the anon key, the pod's Python — and
// persisted onto the assistant message as a `changes` content block. The
// revert always runs HERE, in the browser: the rows belong to the signed-in
// user (or an editor on a shared project) and RLS lets them delete what a
// turn inserted, patch back what it changed and re-insert what it removed.
// Jobs are the exception — there is no UPDATE policy on `jobs` and a running
// one cannot be un-run — so they are CANCELLED through the same RPC the queue
// uses.
//
// Everything is best effort and REPORTED: a step that fails is listed by
// table with the reason, and the ones after it still run. A revert that
// stops at the first error leaves a storyboard half put back with nothing
// saying which half.
import { supabase } from "./supabase";
import { cancelJob } from "./db/jobs";
import { invalidateTables } from "../hooks/useLiveQuery";
import { exchangeToUndo, turnFromRow, type StoredTurn } from "./directorRetry";
import { revertPlan, describeChanges, hasChanges } from "../../director/changes.js";

export interface RevertOutcome {
  done: number;
  skipped: string[];
  failed: string[];
}

/** The `changes` block of a persisted assistant message, if it has one. */
export function changesOf(content: unknown): Record<string, unknown>[] | null {
  const blocks = Array.isArray(content) ? content : [];
  const hit = blocks.find((b) => b && typeof b === "object" && (b as { type?: string }).type === "changes");
  const ops = (hit as { ops?: unknown } | undefined)?.ops;
  return Array.isArray(ops) && hasChanges(ops) ? (ops as Record<string, unknown>[]) : null;
}

export { describeChanges };

export async function revertTurn(ops: Record<string, unknown>[]): Promise<RevertOutcome> {
  const out: RevertOutcome = { done: 0, skipped: [], failed: [] };
  const touched = new Set<string>();
  for (const step of revertPlan(ops) as Record<string, any>[]) {
    try {
      if (step.kind === "skip") {
        out.skipped.push(`${step.table}: ${step.why}`);
        continue;
      }
      if (step.kind === "cancel_job") {
        await cancelJob(step.id);
        touched.add("jobs");
      } else if (step.kind === "delete") {
        let q = supabase.from(step.table).delete();
        for (const [k, v] of Object.entries(step.key)) q = q.eq(k, v as string);
        const { error } = await q;
        if (error) throw error;
        touched.add(step.table);
      } else if (step.kind === "patch") {
        let q = supabase.from(step.table).update(step.body);
        for (const [k, v] of Object.entries(step.key)) q = q.eq(k, v as string);
        const { error } = await q;
        if (error) throw error;
        touched.add(step.table);
      } else if (step.kind === "insert") {
        const { error } = await supabase.from(step.table).insert(step.body);
        if (error) throw error;
        touched.add(step.table);
      }
      out.done++;
    } catch (e) {
      out.failed.push(`${step.table ?? step.kind}: ${(e as Error).message ?? String(e)}`);
    }
  }
  // The rows changed under every live query watching them; realtime carries
  // the echo too, but this puts the storyboard right on this tick.
  if (touched.size) invalidateTables([...touched]);
  return out;
}

/**
 * Take the EXCHANGE back too: remove the reply and the message that asked
 * for it, and hand that message back so it can be edited and sent again.
 *
 * Undoing the writes and leaving the conversation is half an undo — the
 * transcript then shows a director confidently reporting edits that are no
 * longer there, and the way to try again is to retype the brief and find the
 * reference pictures a second time. What the user asked for is the whole
 * gesture: put it back, give me my message.
 *
 * ONLY THE LAST EXCHANGE. Reverting an older turn still undoes its writes —
 * those are rows, and putting them back is well defined wherever the turn sits
 * — but deleting a pair from the middle rewrites history the turns after it
 * were answering, and pulling a message from three turns ago into the composer
 * is not what anybody meant. The caller decides which case it is; this
 * refuses rather than guessing.
 *
 * Runs AFTER the writes are put back, never before: a revert that destroyed
 * the transcript and then failed to undo anything would leave no record of
 * what had been done.
 */
export async function undoTurnMessages(
  threadId: string, assistantId: string,
): Promise<StoredTurn | null> {
  const { data } = await supabase
    .from("chat_messages").select("id,role,content")
    .eq("thread_id", threadId).order("created_at", { ascending: false }).limit(10);
  const plan = exchangeToUndo((data ?? []) as { id: string; role: string; content: unknown }[],
                              assistantId);
  if (!plan) return null;
  const { ids, asked } = plan;
  const { error } = await supabase.from("chat_messages").delete().in("id", ids);
  if (error) throw error;
  invalidateTables(["chat_messages"]);
  return asked ? turnFromRow(asked.content) : null;
}

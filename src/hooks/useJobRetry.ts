import { useCallback, useState } from "react";
import type { Job } from "../lib/db/types";
import { retryJob } from "../lib/db/jobs";
import { invalidateTables } from "./useLiveQuery";

/** Retrying is a NEW row, and the failed one stays on screen.
 *
 * That is the whole reason this is a hook rather than a `useState` in each
 * queue surface: `jobs` has no anon UPDATE, so a retry inserts a fresh job and
 * the row you clicked goes on reading `error` forever. Put the button back and
 * it invites a second click, which queues the whole cascade again — on a
 * $3.36/hr box. `retried` is what turns the button into a receipt instead.
 *
 * The state is deliberately per-hook (per surface) and not global: it is about
 * what THIS list has shown you, and a remount that forgets it is harmless
 * because the requeued rows are visible in the same list by then.
 */
export function useJobRetry(onResult?: (msg: string, bad?: boolean) => void) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [retried, setRetried] = useState<ReadonlyMap<string, number>>(() => new Map());

  const retry = useCallback(
    async (job: Job) => {
      setPending((s) => new Set(s).add(job.id));
      try {
        const queued = await retryJob(job);
        setRetried((m) => new Map(m).set(job.id, queued.length));
        // The realtime event still arrives; this is what puts the new rows in
        // the list on this tick instead of after a socket round trip, so the
        // click doesn't read as a dead button.
        invalidateTables(["jobs"]);
        onResult?.(
          queued.length > 1
            ? `Requeued ${queued.length} jobs — the whole failed chain.`
            : "Requeued — it runs after anything ahead of it.",
          false,
        );
      } catch (e) {
        onResult?.(`Retry failed: ${String((e as Error).message).slice(0, 100)}`, true);
      } finally {
        setPending((s) => {
          const n = new Set(s);
          n.delete(job.id);
          return n;
        });
      }
    },
    [onResult],
  );

  return {
    retry,
    /** Mid-flight: the insert is in the air. */
    retrying: useCallback((id: string) => pending.has(id), [pending]),
    /** Already requeued from this list — how many rows it queued, or 0. */
    retriedCount: useCallback((id: string) => retried.get(id) ?? 0, [retried]),
  };
}

/** A job worth offering a retry on. `canceled` is deliberately excluded:
 *  somebody asked for that one to stop. */
export function isRetryable(j: { status: string }): boolean {
  return j.status === "error";
}

import { useCallback, useState } from "react";
import { cancelJob } from "../lib/db/jobs";

/** A job being cancelled — asked for, not yet stopped. */
export interface CancellableJob {
  id: string;
  status: string;
  cancel_requested?: boolean | null;
}

/** Cancelling is not one moment, and every queue surface used to pretend it was.
 *
 * A QUEUED job flips to `canceled` inside `request_job_cancel` itself and drops
 * out of the live list on the next refetch — that one always looked like it
 * worked. A RUNNING job only gets `cancel_requested = true`: the worker notices
 * at its next cancel check (~6s apart while ComfyUI samples, and not at all
 * until the current phase ends inside a cold model load, a VAE decode or a B2
 * upload), so the row goes on saying `running` at whatever percent it had
 * reached. Pressing ✕ therefore changed nothing on screen for seconds at a
 * time, which reads exactly like a click that missed — so it got pressed again.
 *
 * `cancel_requested` is the durable half of the answer and rides realtime with
 * the row, so the state survives a remount and shows up on every surface even
 * when the cancel was issued from another one. `pending` covers only the round
 * trip before that lands.
 */
export function useJobCancel() {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const cancel = useCallback((id: string) => {
    setPending((s) => new Set(s).add(id));
    cancelJob(id).catch((e) => {
      console.error("cancel failed", e);
      // Nothing else will clear this one: the request never reached the row, so
      // `cancel_requested` stays false and the spinner would spin forever. Put
      // the button back and let them try again.
      setPending((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    });
  }, []);

  const cancelling = useCallback(
    (j: CancellableJob) =>
      (j.status === "queued" || j.status === "running") &&
      (!!j.cancel_requested || pending.has(j.id)),
    [pending],
  );

  return { cancel, cancelling };
}

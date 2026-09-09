// The two-step for reverting a director turn.
//
// A pop-up rather than an inline chip, for the reason DeleteSceneDialog is
// one: this puts back every row the turn wrote — shots, scenes, a block and
// its shifted followers — and cancels what it queued, and it has room to SAY
// that before it does. It OWNS the revert (the in-flight state, the partial
// report) so the dock only supplies what happens afterwards.
//
// What it cannot do is said up front: a render the turn queued that has
// already FINISHED is a take now, and a take is not undone by putting the
// plan back — it is deactivated from the takes strip.
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import ModalShell from "./ModalShell";
import {
  describeChanges, revertTurn, undoTurnMessages, type RevertOutcome,
} from "../../lib/directorRevert";
import type { StoredTurn } from "../../lib/directorRetry";

export default function RevertTurnDialog({
  ops, threadId, messageId, isLast, onCancel, onDone, onRestore,
}: {
  ops: Record<string, unknown>[];
  threadId: string | null;
  /** the reply Revert was pressed on */
  messageId: string;
  /** is this the LAST exchange in the thread? Only then is the conversation
   *  taken back with the writes — see `undoTurnMessages`. */
  isLast: boolean;
  onCancel: () => void;
  /** the revert has run and the user has seen anything there was to see */
  onDone: () => void;
  /** the message that asked for it, handed back for the composer */
  onRestore: (turn: StoredTurn) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RevertOutcome | null>(null);
  const lines = describeChanges(ops);
  const queued = ops.some((o) => o.op === "insert" && o.table === "jobs");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !outcome) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy, outcome]);

  const run = async () => {
    setBusy(true);
    try {
      const res = await revertTurn(ops);
      // The transcript only AFTER the writes are back: a revert that cleared
      // the conversation and then failed to undo anything would leave no
      // record of what had been done.
      let restored: StoredTurn | null = null;
      if (isLast && threadId) {
        try {
          restored = await undoTurnMessages(threadId, messageId);
        } catch (e) {
          res.failed.push(`the conversation: ${(e as Error).message}`);
        }
      }
      if (restored) onRestore(restored);
      // A clean revert needs no receipt — the composer holding the message
      // again IS the receipt, and it is where the user is going next.
      if (!res.failed.length && !res.skipped.length) { onDone(); return; }
      setOutcome(res);
    } finally {
      setBusy(false);
    }
  };

  const partial = outcome && (outcome.failed.length || outcome.skipped.length);
  return createPortal(
    <ModalShell
      z={150} width={480} tone="danger"
      onClose={busy ? () => {} : outcome ? onDone : onCancel}
      icon={partial ? <AlertTriangle size={15} /> : <RotateCcw size={15} />}
      title={outcome ? (partial ? "Reverted, with gaps" : "Reverted") : "Revert this turn"}
      context="Director">
      <div className="ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {outcome ? (
          <>
            <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              {outcome.done} step{outcome.done === 1 ? "" : "s"} put back.
            </div>
            {!!outcome.failed.length && (
              <ul className="sb-delnote">
                {outcome.failed.map((f, i) => <li key={i}>Could not undo — {f}</li>)}
              </ul>
            )}
            {!!outcome.skipped.length && (
              <ul className="sb-delnote">
                {outcome.skipped.map((f, i) => <li key={i}>Not recorded, left as is — {f}</li>)}
              </ul>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              Put back everything this turn changed?
            </div>
            <ul className="sb-delnote">
              {lines.map((l) => <li key={l}>{l}</li>)}
              {queued && (
                <li>
                  Queued renders are cancelled. A render that has already finished
                  stays as a take — deactivate it from the takes strip if you do
                  not want it.
                </li>
              )}
              {isLast ? (
                <li>
                  The reply and your message go too, and your message comes back
                  in the composer — with its pictures — to edit and send again.
                </li>
              ) : (
                <li>
                  The conversation is left alone: there are later turns, and
                  removing a message from the middle of one rewrites what they
                  were answering.
                </li>
              )}
            </ul>
            <div className="mono" style={{ fontSize: 11, color: "#5e6678" }}>
              Rows are restored to what they held before this turn; edits made since
              to the same fields are lost with it.
            </div>
          </>
        )}
      </div>
      <div className="ws-modal-foot">
        <span className="sum" />
        {outcome ? (
          <button className="ws-primary" autoFocus onClick={onDone}>Close</button>
        ) : (
          <>
            <button className="ws-ghost" autoFocus disabled={busy} onClick={onCancel}>Keep changes</button>
            <button className="ws-primary danger" disabled={busy} onClick={() => void run()}>
              {busy ? <Loader2 size={13} className="ns-spin" /> : <RotateCcw size={13} />}
              {busy ? "Reverting…" : "Revert"}
            </button>
          </>
        )}
      </div>
    </ModalShell>,
    document.body);
}

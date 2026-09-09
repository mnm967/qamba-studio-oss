// What a queued row is about to render, and — where the row actually holds it —
// the text itself, editable.
//
// PORTALLED, and not optionally: `.ws-queuepop` is `.ns-l2`, which carries a
// `backdrop-filter`, so the popover is a containing block for fixed
// descendants — an in-place `.ws-scrim` resolves against the popover's box and
// is then clipped by its `overflow: hidden`, i.e. the panel opens INSIDE the
// list that opened it. Same rule AssetPickerModal follows.
//
// Saving is a CANCEL AND REQUEUE (db/jobs.ts::requeueJobWithPayload), because
// `jobs` has no UPDATE policy. That costs the row its id and its place in its
// priority band, and it takes anything waiting on it along — so the footer
// says both before the button is pressed rather than after.
import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Loader2, SlidersHorizontal, SquarePen } from "lucide-react";
import ModalShell, { Card } from "../modals/ModalShell";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { invalidateTables } from "../../hooks/useLiveQuery";
import { loadQueuedDependents, requeueJobWithPayload } from "../../lib/db/jobs";
import { supabase } from "../../lib/supabase";
import { changedFields, describeJob, editBlocker } from "../../lib/jobPrompt";
import { jobLabel, jobWhere, KIND } from "../../lib/jobMeta";
import type { GenerationBlock, Job } from "../../lib/db/types";
import { blockRef } from "../../../director/refs.js";

export default function JobPromptModal({
  job, onClose, onDone,
}: {
  job: Job;
  onClose: () => void;
  /** Reported in the surface that opened this, beside its own errors. */
  onDone?: (msg: string, bad?: boolean) => void;
}) {
  const ws = useWorkspaceStore();
  const view = useMemo(() => describeJob(job), [job]);
  const blocker = useMemo(() => editBlocker(job), [job]);
  const editable = blocker === null;

  const [draft, setDraft] = useState<Record<string, string>>(
    () => Object.fromEntries(view.fields.map((f) => [f.key, f.value])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const patch = useMemo(() => changedFields(view, draft), [view, draft]);
  const dirty = Object.keys(patch).length > 0;

  // What a save would take with it. Live, because the answer changes as the
  // queue drains under the panel.
  const { data: dependents } = useLiveQuery(
    () => (editable ? loadQueuedDependents(job.id) : Promise.resolve([] as Job[])),
    ["jobs"], [job.id, editable]);
  const waiting = dependents?.length ?? 0;

  // Only to NAME the block on the button — `blockRef` is 1-indexed and the
  // stored `idx` is not, and guessing one is how a link points at b6 while
  // saying b7.
  const { data: block } = useLiveQuery(
    async () => {
      if (!view.blockId) return null;
      const { data } = await supabase.from("generation_blocks")
        .select("id,idx").eq("id", view.blockId).maybeSingle();
      return (data as Pick<GenerationBlock, "id" | "idx"> | null) ?? null;
    },
    ["generation_blocks"], [view.blockId]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await requeueJobWithPayload(job, patch);
      // The realtime event still arrives; this puts the fresh rows in the list
      // on this tick rather than after a socket round trip, so the click does
      // not read as a dead button.
      invalidateTables(["jobs"]);
      const extra = r.queued.length > 1
        ? ` — and the ${r.queued.length - 1} job${r.queued.length > 2 ? "s" : ""} waiting on it`
        : "";
      onDone?.(
        r.startedAlready
          ? `It had already started, so it was stopped and requeued with your changes${extra}.`
          : `Requeued with your changes${extra}. It runs after anything ahead of it.`,
        false);
      onClose();
    } catch (e) {
      // Stay open: the draft is the only copy of what they typed.
      setErr(String((e as Error).message).slice(0, 200));
      setBusy(false);
    }
  }

  const summary = !editable
    ? "Read-only"
    : dirty
      ? `Cancels ${waiting ? `${waiting + 1} jobs` : "this job"} and queues `
        + `${waiting ? `${waiting} fresh rows` : "a fresh one"} — new id, back of its priority band`
      : "Nothing changed yet";

  return createPortal(
    <ModalShell
      icon={<FileText size={16} />}
      title={jobLabel(job)}
      context={`${KIND[job.kind] ?? job.kind} · ${job.status}${jobWhere(job) ? ` · ${jobWhere(job)}` : ""}`}
      width={640}
      // No `maxH`: ModalShell writes it as an INLINE `max-height`, which beats
      // the stylesheet's own `.ws-modal { max-height: 100% }` — so a value
      // larger than the viewport uncaps the modal rather than capping it, and
      // the footer lands off the bottom of the screen. Letting the sheet's
      // rule stand is what makes `.ws-modal-body` the thing that scrolls.
      z={210}
      onClose={busy ? () => {} : onClose}
      footer={editable ? (
        <>
          <span className="sum">{summary}</span>
          <button className="ws-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="ws-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? <Loader2 size={13} className="ns-spin" /> : null}
            {busy ? "Requeueing…" : "Save and requeue"}
          </button>
        </>
      ) : (
        <>
          <span className="sum">{summary}</span>
          <button className="ws-ghost" onClick={onClose}>Close</button>
        </>
      )}
    >
      <div className="ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {err && (
          <div className="ws-card" style={{ borderColor: "rgba(255,90,90,.32)", color: "#ff8080",
                                            fontSize: 12.5, lineHeight: 1.5 }}>
            {err}
          </div>
        )}

        {!editable && blocker && (
          <div className="ws-card" style={{ fontSize: 12.5, lineHeight: 1.55, color: "#9aa4b6" }}>
            {blocker}
          </div>
        )}

        {/* A block re-render's real editor is the retake modal, which already
            shows the block's last compiled prompt and labels it as the previous
            render's. Sending people there beats reproducing it here badly. */}
        {view.blockId && view.shape !== "payload" && (
          <button className="ws-actbtn" style={{ alignSelf: "flex-start" }}
                  onClick={() => { onClose(); ws.openModal({ kind: "prompt", blockId: view.blockId! }); }}>
            <SlidersHorizontal size={12} />
            Open {block ? blockRef(block.idx) : "the block"} · prompt &amp; references
          </button>
        )}

        {view.fields.map((f) => (
          <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="ws-mlabel">{f.label}</span>
            {editable ? (
              <textarea
                className="ws-input"
                rows={f.kind === "line" ? 1 : 7}
                value={draft[f.key] ?? ""}
                disabled={busy}
                spellCheck={false}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            ) : (
              <pre className="ws-card mono" style={{ margin: 0, whiteSpace: "pre-wrap",
                                                     wordBreak: "break-word", fontSize: 12,
                                                     lineHeight: 1.55, color: "#c8cfdb" }}>
                {f.value || "—"}
              </pre>
            )}
            {f.hint && (
              <span style={{ fontSize: 11, lineHeight: 1.45, color: "#5e6678" }}>{f.hint}</span>
            )}
          </div>
        ))}

        {!!view.facts.length && (
          <Card label="Sent with it">
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 14px",
                          fontSize: 12 }}>
              {view.facts.map((f) => (
                <React.Fragment key={f.label}>
                  <span style={{ color: "#5e6678" }}>{f.label}</span>
                  <span className="mono" style={{ color: "#c8cfdb", wordBreak: "break-word" }}>
                    {f.value}
                  </span>
                </React.Fragment>
              ))}
            </div>
            <span style={{ fontSize: 11, lineHeight: 1.45, color: "#5e6678" }}>
              Read-only. These are the shape of the render — a grid-legal frame count, a
              model key the worker can resolve — and every way of getting one wrong fails
              deep in the sampler rather than here.
            </span>
          </Card>
        )}

        {editable && waiting > 0 && (
          <div className="ws-card" style={{ fontSize: 12, lineHeight: 1.55, color: "#9aa4b6" }}>
            <strong style={{ color: "#e8c268" }}>{waiting} queued job
            {waiting === 1 ? "" : "s"} wait{waiting === 1 ? "s" : ""} on this one.</strong>{" "}
            They are requeued with it, keeping their own priority — their{" "}
            <span className="mono">depends_on</span> names this row, and a dependency that
            can never reach <span className="mono">done</span> would leave them in the queue
            for good.
          </div>
        )}
      </div>
    </ModalShell>,
    document.body);
}

/**
 * The row's own button. Two icons on purpose: a pencil where the text can be
 * changed and a page where it can only be read, so which rows are editable is
 * answerable without opening any of them — and the split is not obvious from
 * outside (a `clip_gen` holds its prompt, the `master_pass` right beside it
 * compiles one later).
 *
 * Absent entirely on a row with nothing to say, rather than opening an empty
 * panel.
 */
export function JobPromptButton(
  { job, onOpen, size = 26 }: { job: Job; onOpen: () => void; size?: number },
) {
  const view = describeJob(job);
  if (view.shape === "none" && !view.facts.length) return null;
  const editable = editBlocker(job) === null;
  return (
    <button className="ws-icobtn" style={{ width: size, height: size }}
            data-testid="job-prompt-btn"
            title={editable
              ? "Prompt — read it, change it, requeue"
              : view.shape === "compiled"
                ? "What this will render — its prompt is compiled when the worker picks it up"
                : "What this job was sent"}
            onClick={onOpen}>
      {editable ? <SquarePen size={size > 24 ? 13 : 11} />
        : <FileText size={size > 24 ? 13 : 11} />}
    </button>
  );
}

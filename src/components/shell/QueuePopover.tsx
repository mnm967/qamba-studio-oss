import React, { useState } from "react";
import {
  Check, HardDrive, Laptop, Loader2, PlayCircle, RotateCcw, X,
} from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { useJobCancel } from "../../hooks/useJobCancel";
import { useJobRetry, isRetryable } from "../../hooks/useJobRetry";
import {
  useActiveDownloads, usePausedDownloads, type DownloadRow, type PausedDownload,
} from "../../hooks/useActiveDownloads";

/** A stable empty array for the server snapshot — a new one each call makes
 *  `useSyncExternalStore` loop. */
import { loadRecentJobs } from "../../lib/db/jobs";
import { supabase } from "../../lib/supabase";
import type { GenerationBlock } from "../../lib/db/types";
import { jobLabel, jobWhere, ST } from "../../lib/jobMeta";
import JobPreview from "./JobPreview";
import JobPromptModal, { JobPromptButton } from "./JobPromptModal";
import { blockRef } from "../../../director/refs.js";

const gb = (bytes: number) => bytes >= 1 << 30
  ? `${(bytes / (1 << 30)).toFixed(1)} GB`
  : `${Math.round(bytes / (1 << 20))} MB`;

/**
 * A weight download, in the same list as renders but kept visibly APART.
 *
 * They are not jobs: no `jobs` row, no pod, nothing to cancel through the
 * queue, and they run on this machine rather than the shared GPU. Folding them
 * into the job list would make "3 active" mean two unrelated things. But they
 * belong in the same popover, because this is the app's one answer to "what is
 * happening right now" — and before this, a download was only visible inside
 * the engine modal, which is exactly the screen people close and forget.
 */
function DownloadRowView({ d }: { d: DownloadRow }) {
  const pct = Math.round(Math.max(0, d.pct) * 100);
  return (
    <div className="ws-jobrow run">
      <div className="ws-jobhead">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="k" style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Loader2 size={12} className="ns-spin" style={{ color: "#5aa2ff" }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {d.name}
            </span>
          </div>
          <div className="m" style={{ marginTop: 2 }}>
            {d.pct < 0 ? `${gb(d.received)} — size unknown` : `${gb(d.received)} of ${gb(d.total)}`}
          </div>
        </div>
        <span className="m mono">{d.pct < 0 ? "" : `${pct}%`}</span>
      </div>
      <div className="ws-jobbar"><i style={{ width: `${d.pct < 0 ? 35 : pct}%` }} /></div>
    </div>
  );
}

/**
 * A download that STOPPED with bytes on disk.
 *
 * It needs a button, not a bar — which is why it is not folded in with the
 * in-flight ones. This is also the right home for a SHARED file: the engine
 * screen can only offer "Resume" against a variant row, and the 6.5GB text
 * encoder belongs to all five variants of its family at once, so there is no
 * one row to put it on. Here it is just the file, named.
 */
function PausedRowView({ p, onResume }: { p: PausedDownload; onResume: () => void }) {
  const [going, setGoing] = useState(false);
  const pct = p.totalMb > 0 ? Math.round((p.mb / p.totalMb) * 100) : 0;
  return (
    <div className="ws-jobrow">
      <div className="ws-jobhead">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="k" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {p.filename}
          </div>
          <div className="m" style={{ marginTop: 2 }}>
            {p.label} · {gb(p.mb * 1024 * 1024)} of {gb(p.totalMb * 1024 * 1024)} fetched
          </div>
        </div>
        <button className="ws-actbtn" style={{ fontSize: 11, padding: "4px 9px" }}
                disabled={going}
                onClick={() => { setGoing(true); onResume(); }}>
          {going ? <Loader2 size={11} className="ns-spin" /> : <PlayCircle size={11} />} Resume
        </button>
      </div>
      <div className="ws-jobbar"><i style={{ width: `${pct}%`, opacity: 0.5 }} /></div>
    </div>
  );
}

export default function QueuePopover() {
  const ws = useWorkspaceStore();
  const { data } = useLiveQuery(() => loadRecentJobs(50), ["jobs"], []);
  const { cancel, cancelling } = useJobCancel();
  const downloads = useActiveDownloads();
  const { paused, resume } = usePausedDownloads(downloads);
  const [note, setNote] = React.useState<{ msg: string; bad?: boolean } | null>(null);
  // The ID, not the row: the panel has to reflect the job as it is NOW, so
  // that a job claimed while it is open stops offering an edit the worker has
  // already read past. It also keeps the draft alive across progress ticks,
  // since the textarea state lives in the panel rather than out here.
  const [inspectId, setInspectId] = React.useState<string | null>(null);
  const { retry, retrying, retriedCount } = useJobRetry(
    React.useCallback((msg: string, bad?: boolean) => setNote({ msg, bad }), []),
  );
  const jobs = data ?? [];
  const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const running = active.filter((j) => j.status === "running").length;
  const blockIds = [...new Set(active.map((j) => (j.payload as { block_id?: string })?.block_id).filter(Boolean))] as string[];

  const { data: strip } = useLiveQuery(
    async () => {
      if (!blockIds.length) return [] as GenerationBlock[];
      const { data: touched } = await supabase
        .from("generation_blocks").select("storyboard_id").in("id", blockIds).limit(1);
      if (!touched?.length) return [];
      const { data: blocks } = await supabase
        .from("generation_blocks").select("*").eq("storyboard_id", touched[0].storyboard_id).order("idx");
      return (blocks ?? []) as GenerationBlock[];
    },
    ["generation_blocks"], [blockIds.join(",")]
  );

  const inspect = inspectId ? jobs.find((j) => j.id === inspectId) ?? null : null;

  const ordered = [
    ...active.filter((j) => j.status === "running"),
    ...active.filter((j) => j.status === "queued"),
    ...jobs.filter((j) => j.status !== "queued" && j.status !== "running").slice(0, 12),
  ];

  return (
    <div className="ws-queuepop ns-l2 ns-pop">
      <div className="ws-queuehead">
        <span className="ws-mlabel">
          Queue · {active.length + downloads.length} active
        </span>
        <span className="mono" style={{ fontSize: 11.5, color: "#5e6678" }}>
          {running} running{downloads.length ? ` · ${downloads.length} downloading` : ""}
        </span>
        <span style={{ flex: 1 }} />
        <button className="ws-icobtn" style={{ width: 26, height: 26 }} onClick={() => ws.toggle("queueOpen")}>
          <X size={14} />
        </button>
      </div>

      {!!strip?.length && (
        <div style={{ display: "flex", gap: 3, padding: "10px 15px 4px", flexWrap: "wrap" }}>
          {strip.map((b) => (
            <span key={b.id} title={`${blockRef(b.idx)} · ${b.status}`}
                  style={{ width: 16, height: 6, borderRadius: 2, background: ST[b.status] ?? "#5b6478" }} />
          ))}
        </div>
      )}

      <div className="ns-scroll" style={{ overflowY: "auto", padding: "10px 15px 15px", display: "flex", flexDirection: "column", gap: 7 }}>
        {downloads.length > 0 && (
          <>
            <div className="ws-mlabel" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <HardDrive size={11} /> Downloading to this machine
            </div>
            {downloads.map((d) => <DownloadRowView key={d.id} d={d} />)}
            {/* The one thing worth saying out loud: these do not need the
                screen that started them, and they DO die with the app. */}
            <div className="m" style={{ fontSize: 10.5, color: "#5e6678", margin: "-2px 0 4px" }}>
              Keeps going if you close the engine window · resumes where it
              stopped if you quit
            </div>
            {ordered.length > 0 && (
              <div className="ws-mlabel" style={{ marginTop: 4 }}>Renders</div>
            )}
          </>
        )}
        {paused.length > 0 && (
          <>
            <div className="ws-mlabel" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <PlayCircle size={11} /> Stopped — pick up where it left off
            </div>
            {paused.map((p) => <PausedRowView key={p.filename} p={p} onResume={() => void resume(p)} />)}
          </>
        )}
        {ordered.map((j) => {
          const live = j.status === "queued" || j.status === "running";
          const stopping = cancelling(j);
          const pctv = Math.round((j.status === "done" ? 1 : j.progress || 0) * 100);
          return (
            // A running job is a column: the status line, then the render
            // itself underneath at full width. The preview used to be a 56px
            // thumbnail beside the text, which is smaller than the thing it is
            // a picture OF — and the space it now fills was the progress bar
            // silently inflated to ~34px by legacy.css's global `.bar` padding.
            <div key={j.id} className={"ws-jobrow" + (j.status === "running" ? " run" : "")}>
              <div className="ws-jobhead">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="k" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    {j.status === "running" && <Loader2 size={12} className="ns-spin"
                      style={{ color: j.lane === "local" ? "#54c08a" : "#e8c268" }} />}
                    {jobLabel(j)}
                    {/* A local render and a pod render are the same row shape
                        and cost wildly different things — the laptop mark is
                        the only thing on screen that says which. */}
                    {j.lane === "local" && <Laptop size={11} style={{ color: "#54c08a", flex: "none" }} />}
                    <span className="m">{jobWhere(j)}</span>
                  </div>
                  <div className="m" style={{ marginTop: 2, color: j.status === "error" ? "#ff8080" : undefined }}>
                    {stopping ? "cancelling…"
                      : j.status === "error" ? (j.error_msg ?? "failed").slice(0, 70)
                      : j.status === "running" ? (j.progress_note ?? `${pctv}%`)
                      : j.status}
                    {j.depends_on?.length && j.status === "queued" && !stopping
                      ? ` · waits on ${j.depends_on.length}` : ""}
                  </div>
                </div>
                {j.eta_seconds != null && live && !stopping && (
                  <span className="m">~{Math.round(j.eta_seconds / 60)}m</span>
                )}

                {isRetryable(j) && (
                  // The failed row stays in the list — the retry is a new job —
                  // so once it has been requeued the button becomes a receipt
                  // rather than an invitation to queue the cascade twice.
                  <button className="ws-icobtn" style={{ width: 26, height: 26 }}
                          disabled={retrying(j.id) || retriedCount(j.id) > 0}
                          title={retriedCount(j.id)
                            ? `Requeued as ${retriedCount(j.id)} new job${retriedCount(j.id) > 1 ? "s" : ""}`
                            : "Retry — requeues this job and anything that failed with it"}
                          onClick={() => void retry(j)}>
                    {retrying(j.id) ? <Loader2 size={13} className="ns-spin" />
                      : retriedCount(j.id) ? <Check size={13} style={{ color: "#6fd08c" }} />
                      : <RotateCcw size={13} />}
                  </button>
                )}
                <JobPromptButton job={j} onOpen={() => setInspectId(j.id)} />
                {live && (
                  <button className="ws-icobtn" style={{ width: 26, height: 26 }} disabled={stopping}
                          title={stopping ? "Cancelling — the worker stops at its next checkpoint" : "Cancel"}
                          onClick={() => cancel(j.id)}>
                    {stopping ? <Loader2 size={13} className="ns-spin" /> : <X size={13} />}
                  </button>
                )}
              </div>
              {j.status === "running" && <JobPreview job={j} />}
            </div>
          );
        })}
        {!jobs.length && !downloads.length && !paused.length
          && <div className="ws-empty">No jobs yet.</div>}
      </div>

      {inspect && (
        <JobPromptModal job={inspect} onClose={() => setInspectId(null)}
                        onDone={(msg, bad) => setNote({ msg, bad })} />
      )}

      {note && (
        <div style={{
          padding: "8px 15px 12px", fontSize: 11.5, lineHeight: 1.4,
          color: note.bad ? "#ff8080" : "#8f97aa",
        }}>
          {note.msg}
        </div>
      )}
    </div>
  );
}

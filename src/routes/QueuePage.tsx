import React, { useMemo } from "react";
import { Loader2, X } from "lucide-react";
import V2Shell from "../design/V2Shell";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { useJobCancel } from "../hooks/useJobCancel";
import { loadRecentJobs } from "../lib/db/jobs";
import { supabase } from "../lib/supabase";
import type { GenerationBlock, Job } from "../lib/db/types";

const BLOCK_COLORS: Record<string, string> = {
  planned: "#5b6478", queued: "#8b93a7", generating: "#e8c268",
  generated: "#6fd08c", failed: "#e46e6e", stale: "#c98fe8",
};

/** Chip strip of every block in the storyboards the active jobs touch — the
 * "where is my render" view. */
function BlockDag({ jobs }: { jobs: Job[] }) {
  const blockIds = useMemo(
    () => [...new Set(jobs.map((j) => (j.payload as { block_id?: string })?.block_id).filter(Boolean))] as string[],
    [jobs]
  );
  const { data: strips } = useLiveQuery(
    async () => {
      if (!blockIds.length) return [];
      const { data: touched } = await supabase
        .from("generation_blocks").select("storyboard_id").in("id", blockIds);
      const sbIds = [...new Set((touched ?? []).map((t) => t.storyboard_id))];
      if (!sbIds.length) return [];
      const { data: blocks } = await supabase
        .from("generation_blocks").select("*").in("storyboard_id", sbIds).order("idx");
      const bySb = new Map<string, GenerationBlock[]>();
      for (const b of (blocks ?? []) as GenerationBlock[]) {
        const list = bySb.get(b.storyboard_id) ?? [];
        list.push(b);
        bySb.set(b.storyboard_id, list);
      }
      return [...bySb.values()];
    },
    ["generation_blocks"],
    [blockIds.join(",")]
  );
  const progressFor = (b: GenerationBlock) =>
    jobs.find((j) => (j.payload as { block_id?: string })?.block_id === b.id && j.status === "running")?.progress ?? null;
  if (!strips?.length) return null;
  return (
    <>
      {strips.map((blocks, i) => (
        <div key={i} className="blockdag">
          {blocks.map((b) => {
            const p = progressFor(b);
            return (
              <span key={b.id} className="blockdag-cell" title={`Block ${b.idx} · ${b.status}`}>
                <i style={{ background: BLOCK_COLORS[b.status] ?? "#666" }}>
                  {b.idx}
                  {p != null && <em style={{ width: `${Math.round(p * 100)}%` }} />}
                </i>
              </span>
            );
          })}
        </div>
      ))}
    </>
  );
}

const KIND_LABEL: Record<string, string> = {
  video: "Video take",
  image: "Still",
  audio: "Dialogue audio",
  compose: "Episode render",
  asset_ingest: "Media ingest",
  master_pass: "Master pass",
  patch_flf: "Patch (FLF)",
  patch_splice: "Patch splice",
  video_edit: "AI video edit",
  transition_gen: "Transition",
  clip_render: "Clip render",
  tl_render: "Timeline render",
  audio_slice: "Audio slice",
  llm_task: "Director task",
  api_generate: "API generation",
  embed: "Embedding",
  gc_sweep: "Storage sweep",
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function JobRow({ job, onCancel, cancelling }: {
  job: Job; onCancel: (id: string) => void; cancelling: boolean;
}) {
  const live = job.status === "running" || job.status === "queued";
  const payloadLabel = (job.payload as { label?: string } | null)?.label;
  const label = payloadLabel || (KIND_LABEL[job.kind] ?? job.kind);
  const pct = Math.round((job.status === "done" ? 1 : job.progress) * 100);
  const sub = [
    job.model_id ?? job.status === "error" ? null : null,
    job.status === "error" ? (job.error_msg ?? "failed") : job.progress_note,
    job.status === "queued" && job.depends_on.length ? `waits on ${job.depends_on.length} job(s)` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={"jobrow" + (job.status === "error" ? " err" : job.status === "done" ? " done" : "")}>
      <div className="jobrow-main">
        <div className="jobrow-kind">
          {label}
          {job.model_id ? <span style={{ color: "var(--low)", fontWeight: 400 }}> · {job.model_id}</span> : null}
        </div>
        <div className={"jobrow-sub" + (job.status === "error" ? " jobrow-err" : job.progress_note ? " jobrow-note" : "")}>
          {sub || ago(job.created_at)}
        </div>
        {(live || job.status === "error") && (
          <div className="prog">
            <i style={{ width: `${job.status === "queued" ? 2 : pct}%` }} />
          </div>
        )}
      </div>
      <div className="jobrow-side">
        <span className={`statuschip ${cancelling ? "cancelling" : job.status}`}>
          {cancelling ? "cancelling" : job.status === "running" && job.progress > 0 ? `${pct}%` : job.status}
        </span>
        {job.eta_seconds != null && live && !cancelling &&
          <span className="jobrow-eta mono">~{Math.round(job.eta_seconds / 60)}m</span>}
        {live && (
          <button
            className="jobrow-cancel"
            disabled={cancelling}
            // Only a running job has a wait worth explaining — a queued one is
            // already gone by the time this tooltip could be read.
            title={cancelling ? "Cancelling — the worker stops at its next checkpoint"
                 : job.status === "queued" ? "Remove from queue" : "Cancel render"}
            onClick={() => onCancel(job.id)}
          >
            {cancelling ? <Loader2 size={14} className="ns-spin" /> : <X size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}

export default function QueuePage() {
  const { data } = useLiveQuery(() => loadRecentJobs(80), ["jobs"], []);
  const { cancel, cancelling } = useJobCancel();
  const jobs = data ?? [];
  const { active, history } = useMemo(() => {
    const active = jobs
      .filter((j) => j.status === "queued" || j.status === "running")
      .sort((a, b) => (a.status === b.status ? a.priority - b.priority : a.status === "running" ? -1 : 1));
    const history = jobs.filter((j) => j.status !== "queued" && j.status !== "running").slice(0, 30);
    return { active, history };
  }, [jobs]);

  return (
    <V2Shell title="Queue" eyebrow="Jobs">
      <div className="v2-section">
        <span className="label">Active · {active.length}</span>
      </div>
      <BlockDag jobs={active} />
      {active.length === 0 && <div className="v2-empty">Nothing queued — the studio cloud stops itself when idle.</div>}
      {active.map((j) => (
        <JobRow key={j.id} job={j} onCancel={cancel} cancelling={cancelling(j)} />
      ))}
      <div className="v2-section">
        <span className="label">History</span>
      </div>
      {history.length === 0 && <div className="v2-empty">No finished jobs yet.</div>}
      {history.map((j) => (
        <JobRow key={j.id} job={j} onCancel={cancel} cancelling={cancelling(j)} />
      ))}
    </V2Shell>
  );
}

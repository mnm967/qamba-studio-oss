// JobPromptModal and its row button, on fixture jobs, for /ui/jobprompt.
//
// Reaching the real thing means signing in, opening a project and having work
// actually queued — a credential a test should not hold, and a state that is
// gone again in minutes. What is worth looking at is a picture either way,
// because the claim this screen makes is a VISUAL one: a row whose prompt can
// be changed and a row whose prompt does not exist yet must be told apart at a
// glance, before either is opened.
//
// What is live and what is not, stated rather than implied:
//   * The row buttons, both icons, every field, the facts table, the blockers
//     and the footer summary are real — they come from `jobPrompt.ts`, which
//     touches no network.
//   * The DEPENDENTS count and the block's number are Supabase reads that come
//     back empty without a session, so the cascade warning does not appear
//     here. Same deal as the queue popover's jobs half.
//   * Pressing "Save and requeue" genuinely calls `requeueJobWithPayload`,
//     which re-reads the row first and — with no session — fails on exactly
//     that, in the panel's own error card. That is the error path, rendered.
import React, { useState } from "react";
import JobPromptModal, { JobPromptButton } from "./JobPromptModal";
import { jobLabel } from "../../lib/jobMeta";
import type { Job } from "../../lib/db/types";

// Real uuids, because the panel's two side queries reach PostgREST and a
// non-uuid id comes back 400 rather than empty — a console full of red that
// looks like a bug in the thing being reviewed. With these it is an ordinary
// no-session empty result, which is the state the harness is meant to show.
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const BLOCK = "00000000-0000-4000-8000-0000000000ff";

const job = (o: Partial<Job> & { kind: string; payload: Record<string, unknown> }): Job => ({
  id: uuid(),
  status: "queued", project_id: "demo", episode_id: null, depends_on: [], priority: 5,
  lane: "gpu", cancel_requested: false, progress: 0, progress_note: null, preview_key: null,
  eta_seconds: null, model_id: null, worker_id: null, attempt: 0, error_msg: null,
  output_asset_id: null, output_key: null, comfy_prompt_id: null, cost_usd: null,
  timing: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  ...o,
} as Job);

const JOBS: Job[] = [
  // The straightforward case: `handle_clip_gen` sends this string to ComfyUI
  // verbatim, so the box IS the render.
  job({
    kind: "clip_gen", model_id: "h3-local",
    payload: {
      label: "Rooftop · push in", prompt:
        "detailed_description: A slow push in on Rei at the rooftop railing, the city "
        + "haze behind her going amber as the sun drops. She does not turn.\n"
        + "overall_soundscape: distant traffic, a rooftop AC unit ticking\n"
        + "non_diegetic_music: N/A",
      negative: "blurry, warped hands, text",
      mode: "i2v", model_key: "minimax-h3-turbo", seed: 42, width: 1280, height: 704,
      duration_ms: 5083, loras: [{ key: "combat", strength: 1 }],
      ref_asset_ids: ["a", "b", "c"], start_asset_id: "s1",
    },
  }),
  // The case the whole module exists for. Same list, same shape — and there is
  // no prompt to edit, because it has not been compiled yet.
  job({
    kind: "master_pass", model_id: "h3-local", depends_on: [uuid()],
    payload: {
      label: "b4 re-render (plain H3 · combat)", block_id: BLOCK,
      model_key: "minimax-h3", fight: true, steps: 20,
      loras: [{ key: "combat", strength: 1 }],
      dims: { w: 1280, h: 704 }, recompute_refs: true,
    },
  }),
  // …and the row one step upstream that DOES decide it. The master_pass above
  // depends on a revise_block exactly like this one, which is what makes the
  // brief the editable text behind a block re-render.
  job({
    kind: "llm_task", lane: "llm", model_id: "gpt-5.6-terra",
    payload: {
      label: "b4 brief", task: "revise_block", block_id: BLOCK,
      brief: "Hold on her hands at the railing longer before the line, and cut the "
           + "second half of the exchange — she should not answer him at all.",
    },
  }),
  job({
    kind: "music_gen", model_id: "acestep-15-turbo",
    payload: {
      label: "Main title", prompt: "slow post-rock, brushed drums, tape saturation",
      lyrics: "we were the last ones out\nthe lights stayed on behind us",
      bpm: 82, key_scale: "D minor", time_signature: "4/4", instrumental: false,
      duration_ms: 60000, seed: 7,
    },
  }),
  job({
    kind: "tts", lane: "api",
    payload: { label: "Mara · line 3", text: "You said you'd already sent it.",
               emotion: "flat, disbelieving", provider: "elevenlabs", voice: "el_abc123" },
  }),
  // Claimed. The prompt is readable and the edit is refused, because
  // `claim_next_job` read the payload when it took the row.
  job({
    kind: "clip_gen", status: "running", progress: 0.4, model_id: "h3-local",
    payload: { label: "Stairwell · reverse", prompt: "A reverse angle down the stairwell.",
               mode: "t2v", seed: 9, width: 1280, height: 704 },
  }),
  // Nothing to say: no prompt, no shape, no overrides. The button is ABSENT
  // rather than opening an empty panel — that is the third state.
  job({ kind: "asset_ingest", lane: "cpu", payload: { label: "ingest · take 2", asset_id: "x" } }),
];

export default function JobPromptDemo() {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = JOBS.find((j) => j.id === openId) ?? null;
  return (
    <div style={{ maxWidth: 520, margin: "40px auto", display: "flex",
                  flexDirection: "column", gap: 9 }}>
      {/* A `.ws-card`, because scripts/ui-test.mjs's `open()` waits for one of
          `.ws-modal, .ws-queuepop, .ws-card` to decide the screen mounted —
          and this one is a plain list, so without it the harness times out
          before a single assertion runs. */}
      <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <span className="ws-mlabel">Queue rows · /ui/jobprompt</span>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "#5e6678" }}>
          A pencil means the row holds its own prompt and can be changed. A page means it can
          only be read — either it has already started, or its prompt is compiled from the
          block's beats when the worker picks it up. The last row has neither, so it has no
          button at all.
        </div>
      </div>
      {JOBS.map((j) => (
        <div key={j.id} className={"ws-jobrow" + (j.status === "running" ? " run" : "")}>
          <div className="ws-jobhead">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="k">{jobLabel(j)}</div>
              <div className="m" style={{ marginTop: 2 }}>
                {j.status}{j.depends_on.length ? ` · waits on ${j.depends_on.length}` : ""}
              </div>
            </div>
            <JobPromptButton job={j} onOpen={() => setOpenId(j.id)} />
          </div>
        </div>
      ))}
      {open && <JobPromptModal job={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// The desktop app's own worker loop.
//
// It is the pod worker's shape, one plane over: poll for a claimable row, take
// it, run it, write the result back. The symmetry is the point — every queue
// surface, the library placeholder card, `jobLabel`, cancel and the roll
// history are written against `jobs`, and a local render that lived in React
// state instead would need a second implementation of all of them and would
// still lose a five-minute sample to a page reload.
//
// IT IS THE ONLY WORKER THERE IS. The cloud build shared the `jobs` table
// with a render pod and kept the two apart by LANE — this one claims
// `lane = 'local'` and the pod claimed the rest. Nothing else claims anything
// here, and `enqueueJob` corrects every lane to `local` on the way in, so the
// filter survives as the shape rather than as a boundary.
//
// ONE AT A TIME, DELIBERATELY. A laptop GPU is serial; two renders at once is
// two renders that both swap. The pod makes the same choice for its gpu lane.
import { isDesktop } from "./desktop.ts";
import { pingComfy, DEFAULT_COMFY } from "./comfyLocal.ts";
import { attachLocalJob, runLocalJob, LocalRenderError } from "./localRender.ts";
import { runByokJob } from "./byokRender.ts";
import { isLocalId } from "./localModels.ts";
import { PY_KINDS, RENDER_KINDS, runJobHere, speechEngineOf, speechNeedOf }
  from "./desktopPlanner.ts";
import { breezeEnsureUp, breezePark, breezeStatus } from "./breezeLocal.ts";
import { qwenEnsureUp, qwenPark, qwenStatus } from "./qwenLocal.ts";
import { startLocalDbBridge } from "./localDbBridge.ts";
import { invalidateTables } from "../hooks/useLiveQuery";
import type { JobIO } from "./jobIO.ts";
import { isLocalProject, localJobIO, localStores } from "./localPlane.ts";
import type { Job } from "./db/types.ts";

const POLL_MS = 2500;
/** Progress writes are a database round trip; the sampler ticks faster. */
const PROGRESS_MS = 1500;

/** Which machine claimed a row. Stable per install, so a reattach after a
 *  restart can tell "my own interrupted render" from "another desktop". */
function machineId(): string {
  const KEY = "qamba.local.worker";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `desktop-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

let started = false;
let busy = false;

export interface LocalWorkerState {
  running: boolean;
  jobId: string | null;
}

const listeners = new Set<(s: LocalWorkerState) => void>();
let state: LocalWorkerState = { running: false, jobId: null };

export function onLocalWorker(fn: (s: LocalWorkerState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function setState(s: LocalWorkerState) {
  state = s;
  for (const fn of listeners) fn(s);
}

/* ── the planes it serves ───────────────────────────────────────────────── */

/**
 * Every queue this machine may claim from: one per project on this computer.
 *
 * WHY NOT JUST `supabase.from`. That follows the OPEN project (localPlane.ts),
 * which is right for a screen and wrong for a worker: a render queued in one
 * project and finishing while another is on screen would publish itself into
 * the wrong one — and a project's queue would stop being polled the moment you
 * navigated away from it. So the worker holds every plane at once and each job
 * carries its own.
 */
function queues(): JobIO[] {
  return localStores().map(localJobIO);
}

/* ── row writes ─────────────────────────────────────────────────────────── */

async function patch(io: JobIO, id: string, row: Record<string, unknown>) {
  const { error } = await io.from("jobs").update(row).eq("id", id);
  if (error) console.warn("[local] job write failed", error.message);
}

/**
 * Take the row, or find that someone else already did.
 *
 * `.eq("status", "queued")` inside the update is the whole claim: two desktops
 * signed into one account race, and exactly one gets a row back.
 */
async function claim(io: JobIO, job: Job): Promise<Job | null> {
  const { data } = await io.from("jobs")
    .update({
      status: "running", worker_id: machineId(),
      progress: 0, progress_note: "starting on this machine", error_msg: null,
    })
    .eq("id", job.id).eq("status", "queued")
    .select().maybeSingle();
  return (data as Job) ?? null;
}

async function canceled(io: JobIO, id: string): Promise<boolean> {
  const { data } = await io.from("jobs")
    .select("cancel_requested,status").eq("id", id).maybeSingle();
  const r = data as { cancel_requested?: boolean; status?: string } | null;
  return !!r && (r.cancel_requested === true || r.status === "canceled");
}

/* ── running one ────────────────────────────────────────────────────────── */

async function execute(io: JobIO, job: Job, attachTo?: string) {
  setState({ running: true, jobId: job.id });
  let lastWrite = 0;
  let lastTick = -99;
  const hooks = {
    // Throttled by TIME, but never at the cost of a heartbeat: a changed poll
    // count always writes. Time alone would collapse "the loop is alive and
    // the sampler is slow" into "nothing has happened", which is the one
    // distinction anyone watching a ten-minute local render needs.
    onProgress: (pct: number, note: string, tick = 0) => {
      const now = Date.now();
      if (tick === lastTick && now - lastWrite < PROGRESS_MS) return;
      lastWrite = now;
      lastTick = tick;
      void patch(io, job.id, { progress: pct < 0 ? 0 : pct, progress_note: note });
    },
    isCanceled: () => canceled(io, job.id),
  };
  try {
    // THE STUDIO'S OWN PIPELINE, on this machine's Python — see
    // desktopPlanner.ts. It shares the lane and nothing else: it drives no
    // ComfyUI through this runner, writes its own progress and its own
    // terminal status from inside the Python (exactly as it does on the pod,
    // so every queue surface works unchanged), and for a LOCAL project it
    // reaches these very rows back through the loopback proxy.
    // A COMPOSER-QUEUED LOCAL MODEL RUNS THE RECIPE ITS PICKER PROMISED.
    //
    // `music_gen` and `sfx_gen` are in PY_KINDS because the WIZARD's score is
    // Python — it resolves against `model_map.desktop.json`'s own music rows.
    // The composer queues the same KIND for a `local:` id, which names an
    // engineCatalog variant that only `localGraphs` knows how to build; handed
    // to the bundled Python it resolves a different checkpoint entirely, which
    // renders fine and is not the model that was picked. Same silent
    // substitution the model pickers exist to prevent, one layer down.
    const pickedLocal = isLocalId(
      job.model_id ?? ((job.payload ?? {}) as { model_key?: string }).model_key);
    if (PY_KINDS.has(job.kind) && !pickedLocal) {
      const providers = ((job.payload ?? {}) as { byok_providers?: string[] })
        .byok_providers ?? [];
      // The project travels with the job, never read off the URL: a voice
      // reference finishing while a DIFFERENT project is on screen must still
      // write into the one that queued it. Same rule as JobIO.
      const local = job.project_id && isLocalProject(job.project_id)
        ? job.project_id : null;
      if (!local) {
        throw new LocalRenderError(
          "this job names no project on this machine, so there is nothing for "
          + "the pipeline to read or write");
      }
      // A LOCAL SPEECH ENGINE SHARES THE GPU, so it is parked before a render
      // and brought back for a line — the desktop's copy of `worker.py`'s own
      // rule. A failure to bring it back becomes the job's error, because a
      // plan that silently keeps the words-per-second floor instead of
      // measuring the real lines is a worse storyboard with nothing to say so.
      //
      // PARKING IS ALL OF THEM and ensuring is ONE, which is `park_all`'s own
      // reasoning on the pod: a box serving two engines that parks only one
      // meets the OOM through the engine nobody was watching — measured there
      // 2026-09-07, where a 9GB service crash-looped 36 times against a
      // resident ComfyUI.
      const need = speechNeedOf(job);
      if (need === "park") await parkSpeech();
      else if (need === "ensure") await ensureSpeech(speechEngineOf(job));
      const out = await runJobHere(job, providers, local);
      if (!out.ok) throw new LocalRenderError(out.error ?? "it failed on this machine");
      // The Python has already written `status: done` and its own rows;
      // patching again would overwrite its own progress_note with a worse one.
      return;
    }
    // A BYOK job is on this lane because the KEY is on this machine, not
    // because the GPU is — so it never touches ComfyUI, has no
    // `comfy_prompt_id` and cannot be reattached to. It shares the lane, the
    // hooks and the tail, and nothing else.
    const byok = job.kind === "byok_gen";
    const res = byok
      ? await runByokJob(job, hooks, io)
      : attachTo
      ? await attachLocalJob(job, attachTo, hooks, undefined, io)
      : await runLocalJob(job, hooks, io);
    await patch(io, job.id, {
      status: "done", progress: 1,
      progress_note: byok
        ? `${res.seconds}s on ${job.model_id ?? "a hosted provider"}`
        : `${res.seconds}s on this machine`,
      output_asset_id: res.assets[0]?.id ?? null,
      // A local render costs electricity, not money, and 0 is what makes the
      // Costs page's totals stay true once these rows exist. A BYOK render
      // costs REAL money on the user's own card, so the provider's own figure
      // is booked — an unpriced hosted generation is spend with no ledger row.
      cost_usd: byok ? ("costUsd" in res ? res.costUsd : 0) : 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await patch(io, job.id, {
      status: msg === "canceled" ? "canceled" : "error",
      error_msg: msg.slice(0, 400),
      progress_note: null,
    });
    if (!(e instanceof LocalRenderError)) console.error("[local] render failed", e);
  } finally {
    setState({ running: false, jobId: null });
    invalidateTables(["jobs", "assets"]);
  }
}

/* ── the loop ───────────────────────────────────────────────────────────── */

/**
 * Rows this machine left `running` when it quit.
 *
 * Three outcomes and they are genuinely different: the engine finished while
 * we were gone (publish it — the bytes exist and throwing them away is the
 * worst option), the engine is still on it (reattach), or the engine no longer
 * knows the prompt (fail it, because a row that says `running` forever is the
 * pod's stranded-job bug and there is no reason to reproduce it here).
 */
async function reattach() {
  for (const io of queues()) {
    const { data } = await io.from("jobs").select("*")
      .eq("lane", "local").eq("status", "running").eq("worker_id", machineId())
      .order("created_at").limit(4);
    for (const row of (data ?? []) as Job[]) {
      if (row.comfy_prompt_id) {
        await execute(io, row, row.comfy_prompt_id);
      } else {
        // A BYOK job has no `comfy_prompt_id` BY CONSTRUCTION — that column is
        // a ComfyUI prompt and there is no ComfyUI in this path — so it lands
        // here whether or not the provider ever saw it. It is failed rather
        // than retried, and that is the cautious direction: a fal render in
        // flight when the app quit is still running on the provider's side and
        // re-running it would bill the user twice for one picture. Re-queue it
        // from the composer, or check the provider's own dashboard.
        //
        // Recoverable in principle — fal hands back a `request_id` and the
        // adapter already records it on the finished asset — but recovering it
        // needs somewhere to keep that id while the job is RUNNING, which is a
        // column this table does not have.
        await patch(io, row.id, {
          status: "error",
          error_msg: row.kind === "byok_gen"
            ? "the app quit while this was rendering — check your provider's dashboard "
              + "before re-queueing, in case it finished and was billed"
            // A Python job's child dies with the app, so nothing is still
            // running to reattach to — and re-running it here would be a
            // second plan (or a second synthesis) on top of whatever the first
            // one had already written. Retry it from the queue.
            : PY_KINDS.has(row.kind)
            ? "the app quit part-way through this — retry it from the queue"
            : "the app quit before the engine was given this render",
        });
      }
    }
  }
}

/** The oldest job this build can run, across every plane. Planes are asked in
 *  order and the first with work wins — a strict priority across planes would
 *  need one merged sort and a reason to prefer one project's queue over
 *  another's, and there is none: this machine runs one render at a time either
 *  way. */
async function nextJob(): Promise<{ io: JobIO; job: Job } | null> {
  for (const io of queues()) {
    const { data } = await io.from("jobs").select("*")
      .eq("lane", "local").eq("status", "queued")
      .order("priority").order("created_at")
      .limit(1);
    const job = ((data ?? []) as Job[])[0];
    if (job) return { io, job };
  }
  return null;
}

/** Every local speech engine off the card. Failures are swallowed per engine:
 *  a service that was not running cannot be in the way, and a render must not
 *  fail because the thing it was clearing room from was already clear. */
async function parkSpeech(): Promise<void> {
  await Promise.all([
    breezePark().catch(() => false),
    qwenPark().catch(() => false),
  ]);
}

/**
 * Bring up the engine a job needs.
 *
 * `null` is "whichever is here" — a plan that named no provider lets the child
 * decide, and `plan_run` tells it only about engines already answering. Only
 * an INSTALLED engine is started: `*_ensure_up` on one that was never
 * installed is a refusal, and a plan may legitimately run with none (it keeps
 * the words-per-second floor and says so).
 */
async function ensureSpeech(engine: string | null): Promise<void> {
  const want = engine
    ? [engine]
    // BREEZE FIRST, matching `planner.rs`'s own default: it is the wizard's
    // default and the engine that can direct a line, so on a machine with both
    // an unspecified plan casts there.
    : ["breeze", "qwen"];
  for (const e of want) {
    const installed = e === "breeze"
      ? (await breezeStatus().catch(() => null))?.installed
      : (await qwenStatus().catch(() => null))?.installed;
    if (!installed) continue;
    if (e === "breeze") await breezeEnsureUp();
    else await qwenEnsureUp();
    return;
  }
}

/**
 * Start polling. Idempotent, and DESKTOP ONLY — a browser tab has no ComfyUI
 * to drive, no keychain to spend and no Python to run, and every project in
 * this build is a file on a disk it cannot reach. It returns without starting
 * rather than polling a queue it could never serve.
 */
export function startLocalWorker(base = DEFAULT_COMFY): void {
  if (started || !isDesktop()) return;
  started = true;
  void (async () => {
    // BEFORE `reattach`, and before any claim: a job reads its own project's
    // rows back through this bridge, so a Python child started while nothing
    // was listening would sit out the proxy's timeout on its first query.
    await startLocalDbBridge().catch((e) => console.warn("[local] db bridge failed", e));
    await reattach().catch((e) => console.warn("[local] reattach failed", e));
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (busy) continue;
      let next: { io: JobIO; job: Job } | null = null;
      try {
        next = await nextJob();
      } catch { continue; }
      if (!next) continue;
      // Only ask the engine when there is something to run: a ping every 2.5s
      // forever is a pointless request, and an unreachable engine must leave
      // the row QUEUED rather than failing it — ComfyUI takes minutes to come
      // up and "connection refused" during that window means "not yet", the
      // lesson `_NODE_TTL_UNREACHABLE` already cost the worker once.
      //
      // ONLY FOR THE KINDS THAT NEED IT. A plan, a voice reference and a
      // plain cut render touch no ComfyUI at all, and
      // gating them on it would mean a laptop with no engine installed could
      // not plan a storyboard — which is the whole thing this work exists to
      // make possible. A BLOCK render does need it, though: `master_pass`
      // submits a graph exactly as the pod's does, so it waits for the engine
      // the same way.
      //
      // AND SO DOES A CUT RENDER WITH A POST CHAIN ON IT — which the kind
      // alone cannot say. `tl_render` runs SeedVR2, LTX and the face passes
      // through ComfyUI per clip, so "a cut render touches no ComfyUI" was
      // true when this loop was written and stopped being true when the post
      // chain reached the timeline. The QUEUER stamps `needs_engine`
      // (`queueTimelineRender`) because it has the chain in hand; reading the
      // project back here would be a database round trip on every poll. An
      // unreachable engine leaves the row QUEUED rather than failing it, which
      // is the difference between "waiting for your engine" and a dead render.
      const needsComfy = next.job.kind !== "byok_gen"
        && (RENDER_KINDS.has(next.job.kind) || !PY_KINDS.has(next.job.kind)
            || (next.job.payload as { needs_engine?: boolean } | null)?.needs_engine === true);
      if (needsComfy && !(await pingComfy(base)).reachable) continue;
      busy = true;
      try {
        const mine = await claim(next.io, next.job);
        if (mine) await execute(next.io, mine);
      } finally {
        busy = false;
      }
    }
  })();
}

/** Test seam: the loop is a singleton and a second `startLocalWorker` is a
 *  no-op, which a suite that mounts the shell twice would otherwise trip. */
export function __resetLocalWorker() {
  started = false;
  busy = false;
  setState({ running: false, jobId: null });
}

// v2 job helpers: enqueue with DAG metadata, cancel via RPC, live queue reads.
import { supabase } from "../supabase";
import { planeIsLocal } from "../planeRouter.ts";
import { LOCAL_PROJECT_KINDS } from "../desktopPlanner.ts";
import { liveDeps, planRetry, remapDeps } from "../retryPlan";
import { chainNeedsEngine, type PostChain } from "../postChain";
import { normalizeOutput, type RenderOutput } from "../renderOutput";
import { catalogIdOf, resolveDefaults, type ProjectSettings } from "../projectSettings";
import { loadCatalog } from "../catalog";
import { blockFromClipPayload } from "../blockFromClip.ts";
import type { Asset, Clip, Job, JobLane, JobStatus } from "./types";
import { jobLabel } from "../jobMeta";
import { blockRef } from "../../../director/refs.js";

export interface EnqueueJob {
  kind: string;
  lane: JobLane;
  payload?: Record<string, unknown>;
  priority?: number;
  depends_on?: string[];
  project_id?: string;
  episode_id?: string;
  model_id?: string;
}

/**
 * EVERY JOB RUNS ON THIS MACHINE, and this is where that is said.
 *
 * A job is a row, and a project's rows are a file on this disk; the only thing
 * that reads that file is `localWorker`, which claims `lane: "local"`. So a
 * `gpu` or `cpu` lane — the queues the cloud build's render pod served — names
 * nothing here: such a row would sit `queued` forever, on a queue screen that
 * says nothing is wrong, which is the exact failure mode this codebase keeps
 * naming. The lane is CORRECTED rather than the job refused, because routing
 * it elsewhere was never a choice anybody made: it is a default written for a
 * studio that is not part of this build.
 *
 * What CANNOT be corrected is a kind this build has no runner for
 * (`LOCAL_PROJECT_KINDS`), and that is refused by name.
 *
 * Doing it here rather than at each call site is deliberate — the composer,
 * the wizard, the director, the storyboard and the timeline all enqueue, and a
 * rule repeated five times is one that gets forgotten once.
 */
export async function enqueueJob(j: EnqueueJob): Promise<Job> {
  if (j.lane !== "local" && planeIsLocal()) {
    if (LOCAL_PROJECT_KINDS.has(j.kind)) {
      j = { ...j, lane: "local" };
    } else {
      throw new Error(
        `“${j.kind}” has no runner on this machine yet — pick a model that runs `
        + "here, or one you hold the provider key for.");
    }
  }
  const { data, error } = await supabase
    .from("jobs")
    .insert({ status: "queued", payload: {}, ...j })
    .select()
    .single();
  if (error) throw error;
  return data as Job;
}

/** Anything the USER initiates outruns the machine's queue: wizard masters
 *  run at 50 and the reviewer's auto-retakes at 8, so 5 puts a human "redo
 *  this one" ahead of both without starving either. */
export const USER_PRIORITY = 5;

/** The kinds that actually RENDER a block, i.e. the ones whose existence means
 *  "a render is already on the way for this block". A `take_review` also
 *  carries a `block_id` and must not count: it judges a finished take and
 *  would make every reviewed block look busy. */
const RENDER_KINDS = ["master_pass", "video_edit", "api_generate", "patch_flf"];

/** Which of these blocks have a render in flight.
 *
 *  `generation_blocks.status` cannot answer this on its own, and that is the
 *  bug it exists for: a cancelled job leaves the row at `queued` with nothing
 *  coming, and every surface that skips a "busy" block then skips it forever.
 *  Measured live — half a scene sat un-retaken for an hour behind a status no
 *  job backed, and the retake reported success.
 *
 *  Matched in JS rather than with a `payload->>block_id=eq.` filter: the local
 *  plane's query shim splits a json path on ONE `->>`, so that filter reads a
 *  column literally named `payload->>block_id`, finds nothing and returns NO
 *  rows — which here would report every block as free and queue a second
 *  render beside a live one. Same reason `loadClipJobs` filters in JS.
 *
 *  Fails CLOSED: an unreadable jobs table returns every id as busy, because
 *  double-queueing a render costs GPU time and money while skipping one costs
 *  a second click. */
export async function blocksWithLiveRender(blockIds: string[]): Promise<Set<string>> {
  if (!blockIds.length) return new Set();
  const { data, error } = await supabase
    .from("jobs").select("payload")
    .in("status", ["queued", "running"])
    .in("kind", RENDER_KINDS)
    // The block id is inside `payload`, so there is nothing to filter the
    // query by and this reads the whole in-flight set. 500 is ~5x the largest
    // real launch (a 43-block episode queues 43 of these); past it a busy
    // block could read as free and be double-queued, so raise it rather than
    // paging if episodes ever get an order of magnitude longer.
    .limit(500);
  if (error) {
    console.warn("live render lookup failed", error.message);
    return new Set(blockIds);
  }
  const want = new Set(blockIds);
  const busy = new Set<string>();
  for (const j of (data ?? []) as { payload?: { block_id?: unknown } }[]) {
    const id = j.payload?.block_id;
    if (typeof id === "string" && want.has(id)) busy.add(id);
  }
  return busy;
}

/** Enqueue a block render and move the block to `queued` in the same breath.
 *
 * The worker only writes `generating` when it claims the job, so between
 * pressing generate and the GPU picking it up the block still read `planned` —
 * indistinguishable from "nothing happened", which is exactly how it looked
 * when the pod was asleep and the job sat in the queue for good. */
export async function queueBlockRender(
  blockId: string,
  j: Omit<EnqueueJob, "kind" | "lane"> & { kind?: string; lane?: JobLane; blockIdx?: number },
): Promise<Job> {
  const { blockIdx, ...rest } = j;
  const job = await enqueueJob({
    kind: "master_pass", lane: "gpu", priority: USER_PRIORITY, ...rest,
    payload: {
      block_id: blockId, user_retake: true,
      label: `${blockIdx == null ? "b?" : blockRef(blockIdx)} retake (yours)`,
      ...(rest.payload ?? {}),
    },
  });
  const { error } = await supabase.from("generation_blocks")
    .update({ status: "queued" }).eq("id", blockId);
  // The render is already queued; a failed status write is cosmetic and the
  // worker overwrites it on claim. Don't fail the caller over it.
  if (error) console.warn("block status -> queued failed", error.message);
  return job;
}

/**
 * "SAVE AS NEW BLOCK": promote a timeline clip's trimmed window to a
 * `generation_blocks` row of its own.
 *
 * A block clip points at a block and at that block's active take, which is the
 * WHOLE render — so a trim lives in the cut and nowhere else, and three things
 * then ignore it or overwrite it: `assemble_cut` concatenates take assets
 * whole, `syncBlocksToTimeline` repoints the media under the clip whenever a
 * take lands, and `launch_render` deletes every block of the storyboard on a
 * re-plan. This cuts the window to its own asset, makes that asset a new
 * block's active take, and repoints the clip. Afterwards the trim IS the
 * block.
 *
 * `cpu` lane: it is one ffmpeg trim, so it costs wall time and not the GPU's.
 * Inside a LOCAL project `enqueueJob` rewrites that lane to `local` — the kind
 * is in `LOCAL_PROJECT_KINDS`, and the desktop's own Python runs the same
 * ffmpeg — so this reaches the studio's cloud only for a cloud project.
 *
 * It THROWS the blocker's own sentence rather than returning null, so a state
 * that changed between the menu opening and the click is reported in the same
 * words the disabled tooltip would have used.
 */
export async function queueBlockFromClip(
  clip: Pick<Clip, "id" | "block_id" | "asset_id" | "in_ms" | "duration_ms" | "ops" | "label">,
  asset: Asset | null | undefined,
  o: { projectId?: string | null; episodeId?: string | null;
       /** Placement for a BLOCKLESS clip: the nearest lane block. The worker
        *  falls back to the episode's newest storyboard, which is why
        *  `episodeId` matters more on this path than on the source-block
        *  one. */
       afterBlockId?: string | null;
       /** Place it at the END of the storyboard rather than after its anchor
        *  — the choice the save dialog offers. See `BlockFromClipRequest`. */
       append?: boolean } = {},
): Promise<Job> {
  const payload = blockFromClipPayload(clip, asset,
    { afterBlockId: o.afterBlockId, append: o.append });
  return enqueueJob({
    kind: "block_from_clip", lane: "cpu", priority: USER_PRIORITY,
    project_id: o.projectId ?? undefined,
    episode_id: o.episodeId ?? undefined,
    payload: { ...payload },
  });
}

/** Re-render every stale block — the browser twin of the director's
 *  `rerender_stale` tool (api/director/chat.js), and the notice bar's action.
 *
 *  It is a twin rather than a call INTO the director for one reason: the tool
 *  is a dry run that "refuses to queue without confirm: true", and the thing
 *  that confirm was always standing in for is a human agreeing to spend GPU
 *  time. Here the human clicked the button, so routing it through a chat turn
 *  would spend a round trip and a model call to re-ask a question that has
 *  already been answered — which is the pattern the notice bar exists to
 *  replace. Invariant #1 is untouched: this writes `jobs` rows with the anon
 *  key exactly as every other browser-side enqueue does.
 *
 *  Three things it has to keep from the tool, each silent when wrong:
 *    * CHAINED blocks queue in idx order behind their predecessor, because a
 *      successor opens on that block's final frame — render them in parallel
 *      and the later one asks for a frame that does not exist yet.
 *    * `recompute_refs` — a block whose plan moved on is exactly the block
 *      whose staged sheets moved on too, and rendering the stored plan is the
 *      silent downgrade.
 *    * a fresh SEED per block. `handle_master_pass` reads `payload.seed or 0`,
 *      so re-rendering at the stored seed can hand back the take being
 *      replaced.
 *
 *  Partial failure is reported, not swallowed: whatever queued stays queued
 *  and the caller is told how far it got, because "3 blocks queued" having
 *  queued two is the same lie in a new place.
 */
export interface StaleBlock {
  id: string;
  idx: number;
  chain_from_block_id?: string | null;
  /** The block's own stored render settings. OPTIONAL because
   *  `BlockIndexRow` — the dock's whole data source here — deliberately does
   *  not carry `params`: it rides along with every director chat message and a
   *  jsonb blob per block is exactly what it is slim to avoid. Absent, they
   *  are fetched below for the blocks being queued and nothing else. */
  params?: Record<string, unknown> | null;
}

export async function queueStaleRerenders(
  blocks: StaleBlock[],
  o: { projectId?: string; episodeId?: string } = {},
): Promise<{ queued: string[]; failed: number; error?: string }> {
  const ordered = [...blocks].sort((a, b) => a.idx - b.idx);
  const catalog = await loadCatalog().catch(() => []);
  // The stored render settings, for `model_id`. One query for the batch, and
  // only for the blocks that did not arrive with theirs. Best effort: an
  // unreadable row degrades to the old constant rather than refusing a
  // re-render over bookkeeping.
  const need = ordered.filter((b) => b.params === undefined).map((b) => b.id);
  const paramsById = new Map<string, Record<string, unknown> | null>();
  if (need.length) {
    const { data, error } = await supabase.from("generation_blocks")
      .select("id,params").in("id", need);
    if (error) console.warn("stale re-render: block params unreadable", error.message);
    for (const r of (data ?? []) as { id: string; params: Record<string, unknown> | null }[]) {
      paramsById.set(r.id, r.params);
    }
  }
  const queued: string[] = [];
  const done: string[] = [];
  let prev: string | null = null;
  let failed = 0;
  // The FIRST refusal, kept verbatim. `enqueueJob`'s local-project guard is a
  // sentence written for a person to act on ("pick a model that runs on this
  // machine, or move the project to the cloud"), and collapsing every failure
  // into a count throws exactly that away.
  let firstError: string | undefined;
  for (const b of ordered) {
    try {
      const job = await enqueueJob({
        kind: "master_pass", lane: "gpu", priority: USER_PRIORITY,
        // NOT "h3-local". This column does not pick the checkpoint —
        // `_block_model` does, off the block's own `params.model_key` — but it
        // is what `job_timings` and `cost_ledger` file the render under, and a
        // constant booked every turbo and PDD block's wall time against plain
        // h3. Same fix as the storyboard retake's; the catalog is read once
        // for the whole batch and never allowed to fail the queue, since a
        // wrong attribution is cheap and a refused re-render is not.
        model_id: catalogIdOf(b.params ?? paramsById.get(b.id) ?? null, catalog),
        ...(o.projectId ? { project_id: o.projectId } : {}),
        ...(o.episodeId ? { episode_id: o.episodeId } : {}),
        ...(prev && b.chain_from_block_id ? { depends_on: [prev] } : {}),
        payload: {
          block_id: b.id,
          activate: "replace",
          recompute_refs: true,
          seed: Math.floor(Math.random() * 1e9) + 1,
          label: `${blockRef(b.idx)} re-render (stale)`,
        },
      });
      queued.push(job.id);
      done.push(b.id);
      prev = job.id;
    } catch (e) {
      // Keep going: one block refusing to queue is not a reason to leave the
      // rest stale, and the count is what the caller reports.
      console.warn("stale re-render failed for block", b.id, e);
      firstError ??= String((e as Error)?.message ?? e);
      failed += 1;
    }
  }
  // Only the blocks that actually got a job. Marking a failed one `queued`
  // takes it out of the stale count and off the notice bar, so the one block
  // that still needs re-rendering becomes the one nothing will offer to.
  if (done.length) {
    const { error } = await supabase.from("generation_blocks")
      .update({ status: "queued" }).in("id", done);
    if (error) console.warn("stale block status -> queued failed", error.message);
  }
  return { queued, failed, ...(firstError ? { error: firstError } : {}) };
}

/** Rewrite a block's BEATS from a plain-language brief, then render it.
 *
 *  This is what makes "Regenerate" with a note actually regenerate. The brief
 *  used to ride as `params.prompt_extra`, which `handle_master_pass` appends to
 *  the already-composed description as "Director's adjustment for this take:" —
 *  everything else compiled from the same unchanged beats, so the take came
 *  back the same shot with a sentence stapled on. Dialogue could not change at
 *  all: the lines are recorded at plan time and staged as reference audio bound
 *  "precisely lip-synced to <Audio N>", so the recording still said the old
 *  words however the prose was rewritten.
 *
 *  Two jobs, not one, and the render DEPENDS on the revision: a revision that
 *  fails must not fall through to rendering the unchanged shot, because that is
 *  indistinguishable from the bug it fixes. `fail_dependents` takes the render
 *  down with it and the queue row says why.
 *
 *  Invariant #6 is intact — the model rewrites structured beats and the
 *  deterministic compiler builds the envelope from them.
 */
export async function queueRevisedRender(
  blockId: string,
  o: {
    brief: string;
    projectId?: string | null;
    /** "auto" is fine: the worker's pick_backend falls through to whatever is
     *  configured. What is NOT fine is naming a model without a backend — see
     *  `revise_block`, which passes neither and lets each backend default. */
    backend?: string | null;
    render: Omit<EnqueueJob, "kind" | "lane"> & {
      kind?: string; lane?: JobLane; blockIdx?: number;
    };
  },
): Promise<{ revise: Job; render: Job }> {
  const revise = await enqueueJob({
    kind: "llm_task", lane: "llm", priority: USER_PRIORITY,
    project_id: o.projectId ?? undefined,
    // The BACKEND rides here as well as in the payload because pick_backend
    // reads model_id first; "auto" resolves to the first configured one.
    ...(o.backend && o.backend !== "auto" ? { model_id: o.backend } : {}),
    payload: {
      task: "revise_block", block_id: blockId, brief: o.brief.trim(),
      ...(o.backend && o.backend !== "auto" ? { backend: o.backend } : {}),
      ...(o.projectId ? { project_id: o.projectId } : {}),
      label: `${o.render.blockIdx == null ? "b?" : blockRef(o.render.blockIdx)} · rewriting the shot`,
    },
  });
  const render = await queueBlockRender(blockId, {
    ...o.render,
    depends_on: [...(o.render.depends_on ?? []), revise.id],
  });
  return { revise, render };
}

/** The clips whose post chain the render will actually apply. Audio clips are
 *  not offered one (the inspector hides the section) and tl_render only ever
 *  touches the video track, so counting them could only push the render onto
 *  the gpu lane for a pass that will never run. */
export const videoClips = <C extends { track_id: string; post?: unknown }>(
  tracks: { id: string; kind: "video" | "audio" }[], clips: C[],
): C[] => clips.filter((c) => tracks.find((t) => t.id === c.track_id)?.kind !== "audio");

/** Queue the final render of a timeline.
 *
 *  A helper rather than a bare `enqueueJob` because the LANE is a decision, not
 *  a constant, and getting it wrong is silent: worker.py fills the cpu/api/llm
 *  pool CONCURRENTLY with the serial gpu slot, so a cpu-lane render that drives
 *  ComfyUI (SeedVR2, RIFE, FaceDetailer) loads a second model beside whatever
 *  the pod is generating. When any clip's resolved post chain needs ComfyUI the
 *  render IS a GPU job and queues as one; a chain of ffmpeg-only passes (or
 *  none) stays on cpu, where a render belongs. The worker re-checks this and
 *  refuses rather than trusting the caller.
 *
 *  Reads the project's default chain itself: the lane depends on clips that
 *  inherit it, and every call site having to remember that is how the third one
 *  gets it wrong. */
export async function queueTimelineRender(opts: {
  timelineId: string;
  clips: { post?: unknown }[];
  projectId?: string;
  episodeId?: string;
  priority?: number;
  /** The delivery spec. Omitted, the worker falls back to its own default,
   *  which is the H.264/CRF 18 mp4 every render produced before the settings
   *  modal existed — so an old caller is bit-for-bit unchanged. */
  output?: RenderOutput;
  /** The project default the lane should be computed against. Passed in by the
   *  settings modal because it may have just been EDITED and not yet read back
   *  — computing the lane from the stored row would use the previous chain and
   *  could put a ComfyUI render on the cpu lane. */
  projectChain?: PostChain;
  /** WHERE IT RUNS — the studio's pod, or the machine that queued it.
   *
   *  Omitted means the pod, which is what every render did before the picker
   *  existed, so an old caller is unchanged. `"local"` is the desktop's own
   *  lane: `plan_cli.KINDS` carries `tl_render`, so this build's bundled
   *  Python produces the same cut with the pod asleep — and for a MEMBER it is
   *  the only plane that works, because `worker.py::_check_owner_allowed`
   *  refuses a member's own project on the studio's box.
   *
   *  A LOCAL PROJECT overrides it either way: `enqueueJob` reroutes, because
   *  the pod cannot see rows that are a file on this machine. */
  place?: "cloud" | "local";
}): Promise<Job> {
  // The episode is enough to find the project — TimelinePage has one and no
  // projectId, and asking every caller to carry both is the same footgun as
  // asking them to pick the lane.
  let projectId = opts.projectId;
  if (!projectId && opts.episodeId) {
    const { data } = await supabase.from("episodes").select("project_id").eq("id", opts.episodeId).single();
    projectId = (data?.project_id as string | undefined) ?? undefined;
  }
  let projectChain: PostChain | undefined = opts.projectChain;
  if (!projectChain && projectId) {
    const { data } = await supabase.from("projects").select("settings").eq("id", projectId).single();
    projectChain = resolveDefaults((data?.settings ?? null) as ProjectSettings | null).post;
  }
  const output = opts.output ? normalizeOutput(opts.output) : undefined;

  // The chain decides one thing: whether the claim waits for the engine. A
  // plain ffmpeg export must not be held back by a ComfyUI it never asks for,
  // and a cut whose chain runs SeedVR2 or a face pass must not be claimed
  // while that engine is down — an unreachable engine leaves the row QUEUED
  // rather than failing it, which is the difference between "waiting for your
  // engine" and a dead render.
  const needsEngine = chainNeedsEngine(opts.clips, projectChain ?? {});

  return enqueueJob({
    kind: "tl_render",
    lane: "local",
    priority: opts.priority ?? 30,
    project_id: projectId,
    episode_id: opts.episodeId,
    payload: {
      timeline_id: opts.timelineId,
      label: "Timeline render",
      // WHETHER THE CLAIM SHOULD WAIT FOR AN ENGINE, said by the side that
      // knows. The pod reads its own lane for this; the desktop's worker sees
      // one lane for every kind and cannot tell a chainless ffmpeg export from
      // one running SeedVR2 without reading the project back. Stamped only
      // when it is true, so no existing row's shape changes.
      ...(needsEngine ? { needs_engine: true } : {}),
      // Normalized on the way out as well as on the way in: the worker
      // normalizes too, but sending an illegal pair and having the pod correct
      // it would mean the queue row and the file disagree about what was asked
      // for — and the row is what anyone reads afterwards.
      ...(output ? { output } : {}),
    },
  });
}

/** Enqueue a dependency chain in order; each job depends on the previous. */
export async function enqueueChain(jobs: EnqueueJob[]): Promise<Job[]> {
  const out: Job[] = [];
  for (const j of jobs) {
    const deps = [...(j.depends_on ?? []), ...(out.length ? [out[out.length - 1].id] : [])];
    out.push(await enqueueJob({ ...j, depends_on: deps }));
  }
  return out;
}

/** Cancel queued (immediate) or running (flags the worker) jobs. */
export async function cancelJob(id: string): Promise<Job | null> {
  const { data, error } = await supabase.rpc("request_job_cancel", { p_job: id });
  if (error) throw error;
  return (data as Job) ?? null;
}

/** Ceiling on one retry. A wizard one-shot fans out to ~25 dependent jobs, so
 *  this is "the biggest real cascade, doubled" — a bound against a malformed
 *  `depends_on` graph, not a limit anyone should hit. */
const RETRY_MAX = 60;

/** Every failed job connected to this one through `depends_on`, both ways.
 *
 * When a job dies the worker calls `fail_dependents`, which errors out the
 * whole downstream tree with `dependency <id> failed` — so one real failure
 * (a pod still booting, say) leaves a dozen collateral ones behind it. Walking
 * UP matters just as much: the row a user clicks is usually a victim, not the
 * cause, and requeueing a body sheet whose face plate is still dead just fails
 * differently.
 */
async function collectFailedChain(rootId: string): Promise<Job[]> {
  const { data: root, error } = await supabase
    .from("jobs").select("*").eq("id", rootId).maybeSingle();
  if (error) throw error;
  if (!root) throw new Error("job no longer exists");
  const byId = new Map<string, Job>([[root.id, root as Job]]);
  const queue: Job[] = [root as Job];
  while (queue.length && byId.size < RETRY_MAX) {
    const j = queue.shift()!;
    const add = (rows: Job[] | null) => {
      for (const r of rows ?? []) {
        if (!byId.has(r.id) && byId.size < RETRY_MAX) { byId.set(r.id, r); queue.push(r); }
      }
    };
    const up = (j.depends_on ?? []).filter((id) => !byId.has(id));
    if (up.length) {
      const { data } = await supabase.from("jobs").select("*")
        .in("id", up).eq("status", "error");
      add(data as Job[] | null);
    }
    const { data: down } = await supabase.from("jobs").select("*")
      .contains("depends_on", [j.id]).eq("status", "error");
    add(down as Job[] | null);
  }
  return [...byId.values()];
}

/** Retry a failed job — and everything that failed with it.
 *
 * Fresh rows rather than an in-place reset: `jobs` has no anon UPDATE policy
 * (cancellation goes through an RPC for the same reason), and a new row keeps
 * the failure in the history where the error message is still readable.
 *
 * `depends_on` is rebuilt against the new ids so the chain survives the retry.
 * A dependency that actually completed keeps its original id — claim_next_job
 * is satisfied by a `done` dependency — while one that can never complete
 * (canceled) is dropped rather than left to block the new row forever.
 *
 * Queued at USER_PRIORITY: a person clicked this, so it outruns the wizard's
 * batch work at 50 and the reviewer's auto-retakes at 8. Returns the new rows,
 * dependency-first.
 */
export async function retryJob(job: Job | string): Promise<Job[]> {
  const chain = await collectFailedChain(typeof job === "string" ? job : job.id);
  const inChain = new Set(chain.map((j) => j.id));

  // Deps outside the chain: keep only the ones that can still turn `done`.
  const outside = [...new Set(chain.flatMap((j) => j.depends_on ?? []))]
    .filter((id) => !inChain.has(id));
  let live: ReadonlySet<string> = new Set();
  if (outside.length) {
    const { data } = await supabase.from("jobs").select("id,status").in("id", outside);
    live = liveDeps((data ?? []) as { id: string; status: string }[]);
  }

  // Dependency-first, so every chain id a row points at already has its
  // replacement by the time that row is inserted.
  const remap = new Map<string, string>();
  const queued: Job[] = [];
  for (const step of planRetry(chain, live)) {
    const fresh = await enqueueJob({
      kind: step.job.kind,
      lane: step.job.lane,
      payload: step.job.payload ?? {},
      priority: USER_PRIORITY,
      depends_on: remapDeps(step.deps, remap),
      project_id: step.job.project_id ?? undefined,
      episode_id: step.job.episode_id ?? undefined,
      model_id: step.job.model_id ?? undefined,
    });
    remap.set(step.job.id, fresh.id);
    queued.push(fresh);
  }
  return queued;
}

/** Every QUEUED job that would be STRANDED by requeueing this one.
 *
 * This is the whole reason an edit is a cascade rather than one row. `jobs`
 * has no UPDATE policy — deliberately, since 20260813090000_project_shares.sql
 * ("Still no UPDATE — cancellation goes through request_job_cancel") — so a
 * dependent's `depends_on` cannot be repointed at the new id. Leave it alone
 * and it names a row that is now `canceled`, and `claim_next_job` requires
 * every dependency to reach `done`: `canceled` never will, so the dependent
 * sits in the queue forever with nothing on screen to say why. That is the
 * same silent deadlock retryPlan.ts opens by describing, reached from the
 * other direction.
 *
 * DOWN only. A job that depends on a queued one cannot itself have started, so
 * every live dependent is queued too; walking up would drag in the work this
 * row is waiting FOR, which nobody asked to re-queue.
 */
export async function loadQueuedDependents(rootId: string): Promise<Job[]> {
  const byId = new Map<string, Job>();
  let frontier = [rootId];
  while (frontier.length && byId.size < RETRY_MAX) {
    const { data } = await supabase.from("jobs").select("*")
      .overlaps("depends_on", frontier).eq("status", "queued");
    const fresh = ((data ?? []) as Job[]).filter((r) => !byId.has(r.id) && r.id !== rootId);
    if (!fresh.length) break;
    for (const r of fresh) { if (byId.size < RETRY_MAX) byId.set(r.id, r); }
    frontier = fresh.map((r) => r.id);
  }
  return [...byId.values()];
}

export interface RequeueResult {
  /** The fresh rows, dependency-first. */
  queued: Job[];
  /** How many rows were canceled to make them — the edited one plus whatever
   *  was waiting on it. */
  canceled: number;
  /** The worker claimed the row between the status check and the cancel, so a
   *  render that had already started was asked to stop. Rare (the window is
   *  one round trip) and never silent: the caller says so. */
  startedAlready: boolean;
}

/**
 * Change a queued job's prompt — by cancelling it and queueing a fresh one.
 *
 * There is no UPDATE on `jobs` (above), so an in-place edit would need a new
 * SECURITY DEFINER RPC. Cancel-and-reinsert needs nothing: INSERT is already
 * allowed, `request_job_cancel` already exists, and both are already routed on
 * the local plane (localRpc.ts), so this works on a local project for free.
 * What it costs is the row's identity — a new id, and the back of its priority
 * band — which is why the panel says so before the button is pressed.
 *
 * The edited row is re-queued at USER_PRIORITY: a person just changed it, so
 * it outruns the wizard's batch work at 50, exactly as `retryJob` argues.
 * Its DEPENDENTS keep their own priority — they are collateral, and promoting
 * an episode's worth of blocks because one prompt was reworded is not what was
 * asked for. Order is enforced by `depends_on`, never by priority, so the two
 * cannot cross.
 *
 * Partial failure is reported rather than swallowed, the same convention
 * `queueStaleRerenders` follows: whatever queued stays queued.
 */
export async function requeueJobWithPayload(
  job: Job, patch: Record<string, unknown>,
): Promise<RequeueResult> {
  // Read the row back before touching anything. The claim window is the whole
  // risk here, and a row that has already started must not be quietly killed
  // by a button labelled "save".
  const { data: fresh, error } = await supabase
    .from("jobs").select("*").eq("id", job.id).maybeSingle();
  if (error) throw error;
  if (!fresh) throw new Error("that job is no longer in the queue");
  const root = fresh as Job;
  if (root.status !== "queued") {
    throw new Error(
      `“${jobLabel(root)}” is ${root.status} now — only a queued job can be changed. `
      + "Cancel it if you want to render it differently.");
  }

  const chain = [root, ...(await loadQueuedDependents(root.id))];
  const inChain = new Set(chain.map((j) => j.id));

  // Dependencies outside the cascade: keep only the ones that can still turn
  // `done`, or the replacement inherits a permanent block.
  const outside = [...new Set(chain.flatMap((j) => j.depends_on ?? []))]
    .filter((id) => !inChain.has(id));
  let live: ReadonlySet<string> = new Set();
  if (outside.length) {
    const { data } = await supabase.from("jobs").select("id,status").in("id", outside);
    live = liveDeps((data ?? []) as { id: string; status: string }[]);
  }

  // The edited row first: it is the only one in the set that is claimable, so
  // taking it out of the queue closes the window before anything else moves.
  const stopped = await cancelJob(root.id);
  const startedAlready = !!stopped && stopped.status !== "canceled";
  let canceled = stopped ? 1 : 0;
  for (const j of chain) {
    if (j.id === root.id) continue;
    if (await cancelJob(j.id)) canceled++;
  }

  const remap = new Map<string, string>();
  const queued: Job[] = [];
  for (const step of planRetry(chain, live)) {
    const isRoot = step.job.id === root.id;
    const queuedJob = await enqueueJob({
      kind: step.job.kind,
      lane: step.job.lane,
      payload: isRoot
        ? { ...(step.job.payload ?? {}), ...patch }
        : (step.job.payload ?? {}),
      priority: isRoot ? USER_PRIORITY : step.job.priority,
      depends_on: remapDeps(step.deps, remap),
      project_id: step.job.project_id ?? undefined,
      episode_id: step.job.episode_id ?? undefined,
      model_id: step.job.model_id ?? undefined,
    });
    remap.set(step.job.id, queuedJob.id);
    queued.push(queuedJob);
  }
  return { queued, canceled, startedAlready };
}

export async function bumpPriority(id: string, priority = 10): Promise<void> {
  // Priority changes only make sense while queued; the worker reads priority
  // at claim time. RLS: jobs has no anon UPDATE — go through the queue view's
  // service-backed path once it exists; until then this is a no-op guard.
  void id;
  void priority;
  throw new Error("priority bump requires the queue API (M2)");
}

export async function loadQueue(opts: { projectId?: string; limit?: number } = {}): Promise<Job[]> {
  let q = supabase
    .from("jobs")
    .select("*")
    .in("status", ["queued", "running"])
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 100);
  if (opts.projectId) q = q.eq("project_id", opts.projectId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Job[];
}

/* ── THE QUEUE IS CLAIMED OLDEST-FIRST AND WAS BEING READ NEWEST-FIRST ─────
 *
 * `claim_next_job` is `order by priority, created_at`, so the job actually on
 * the GPU is the OLDEST row of the batch it belongs to — while every window
 * below used to be `order created_at desc limit N`. On a long queue those two
 * orderings are exact opposites, and the row they disagree about hardest is
 * the one row anybody opens the queue to see.
 *
 * Measured on a 43-block episode (2026-08-29): 85 active jobs, the running one
 * ranked 85th by `created_at desc` — the single furthest row from a 50-row
 * window. It was missing from the queue popover, the queue page, the context
 * panel and the library's pending cards AT ONCE, taking its progress and its
 * live sampler preview with it, both of which the worker had been writing to
 * that row the whole time. The popover read "50 active · 0 running" over a pod
 * that was sampling, and listed the queue backwards on top of it: b44 at the
 * head of a list whose next render is b1.
 *
 * So ACTIVE WORK IS NEVER INSIDE A RECENCY WINDOW. It is fetched in CLAIM
 * order — which is also the order it will run in, so the list finally reads as
 * a queue — and a recency limit applies only to the finished tail. Any new job
 * window here follows the same rule: the failure is silent, because a short
 * list of real rows looks exactly like a complete one.
 */

/** A runaway guard, not a view — PostgREST caps any response at 1000 rows
 *  whatever `.limit()` says, so this stays well under it. */
const ACTIVE_CAP = 400;

/** How many in-flight generations the library draws placeholder cards for. */
const PENDING_CARDS = 24;

/** Active rows first, then whatever of the recent tail they do not already
 *  contain. The two windows overlap by design: it lets the tail stay
 *  status-BLIND, so it keeps carrying `cancelled` — the v1 spelling, 51 rows
 *  of it in the live data — that a finished-status whitelist would have
 *  quietly dropped out of history. */
function mergeJobRows<T extends { id: string }>(active: T[], tail: T[]): T[] {
  const seen = new Set(active.map((j) => j.id));
  return [...active, ...tail.filter((j) => !seen.has(j.id))];
}

/** Everything unfinished, in the order the worker will run it, plus the newest
 *  `limit` rows for history. See the note above on why the two are separate
 *  queries rather than one `order by created_at desc`. */
export async function loadRecentJobs(limit = 50): Promise<Job[]> {
  const [active, tail] = await Promise.all([
    supabase
      .from("jobs")
      .select("*")
      .in("status", ["queued", "running"])
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(ACTIVE_CAP),
    supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);
  if (active.error) throw active.error;
  if (tail.error) throw tail.error;
  return mergeJobRows((active.data ?? []) as Job[], (tail.data ?? []) as Job[]);
}

/** Generations that will land in the library, in flight right now.
 *
 * The library used to show only what had already arrived, so the minutes
 * between pressing generate and a file appearing looked identical to nothing
 * happening — and if the realtime socket had dropped, the result never showed
 * up at all until a reload. These rows are what the grid renders as placeholder
 * cards, and their presence is also what tells the view to poll.
 */
export interface PendingGen {
  id: string;
  kind: string;
  status: string;
  progress: number | null;
  progress_note: string | null;
  /** newest live sampler frame while this one runs — see Job.preview_key */
  preview_key: string | null;
  error_msg: string | null;
  created_at: string;
  model_id: string | null;
  payload: { prompt?: string; width?: number; height?: number;
             target?: Record<string, unknown> } | null;
}

/** Live state of named jobs, terminal states included.
 *
 * `loadPendingGenerations` answers "what is in flight" for the library grid, so
 * it filters out everything that has left the queue. Whoever PRESSED generate
 * needs the other half: a render that finished and a render that failed both
 * drop out of that list, and only one of those is good news. See the composer's
 * live strip — it reports its own work, where the queue popover reports the
 * studio's. */
export interface JobProgress {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number | null;
  progress_note: string | null;
  error_msg: string | null;
  cancel_requested: boolean | null;
  payload: { label?: string; prompt?: string } | null;
}

export async function loadJobsByIds(ids: string[]): Promise<JobProgress[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase.from("jobs")
    .select("id,kind,status,progress,progress_note,error_msg,cancel_requested,payload")
    .in("id", ids);
  if (error) throw error;
  return (data ?? []) as JobProgress[];
}

/** A render aimed at one timeline CLIP, for the takes strip. `Job`-shaped
 *  where it overlaps so `JobPreview` can render it unchanged. */
export interface ClipJob {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  progress_note: string | null;
  preview_key: string | null;
  error_msg: string | null;
  cancel_requested: boolean | null;
  created_at: string;
  payload: { label?: string; prompt?: string; target?: { clip_id?: string } } | null;
}

/**
 * The renders aimed at these CLIPS — `payload.target.clip_id`, the late-bound
 * shape the timeline's own generate actions use (extend, chain, add-after).
 * Those clips carry no `block_id`, so the takes strip had nothing to show for
 * them and reported "imported media, no generation takes" over a placeholder
 * still while a GPU render was in flight against it.
 *
 * DONE is deliberately excluded: `_attach_to_clip` repoints the clip before it
 * marks the job done, so by the time a render is `done` the strip is looking at
 * the take itself and a "finished" row would be a second thing claiming to be
 * the same render. What IS included is `error`/`canceled` — a chain that died
 * otherwise leaves a still on the lane forever with nothing to say why.
 *
 * The target match is done in JS, not in the query, and that is not laziness.
 * PostgREST would take `payload->target->>clip_id=eq.…`, but `localQuery`'s
 * path reader splits on a single `->>` — so on a LOCAL project that filter
 * reads a column literally named `payload->target`, finds nothing, and returns
 * NO ROWS rather than raising. "No render in flight" is a plausible answer, so
 * nothing would ever look wrong.
 */
export async function loadClipJobs(
  clipIds: string[],
  projectId?: string | null
): Promise<ClipJob[]> {
  const want = new Set(clipIds.filter(Boolean));
  if (!want.size) return [];
  const win = (statuses: string[], asc: boolean, limit: number) => {
    let q = supabase.from("jobs")
      .select("id,kind,status,progress,progress_note,preview_key,error_msg,cancel_requested,created_at,payload")
      .in("status", statuses)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: asc })
      .limit(limit);
    // Same rule as loadPendingGenerations: a null project_id must not hide work
    // the user is waiting on.
    if (projectId) q = q.or(`project_id.eq.${projectId},project_id.is.null`);
    return q;
  };
  // Two windows, because the match happens in JS (see above): a clip's render
  // has to be IN the rows fetched or the strip reports "no generation takes"
  // over a live render. Active work therefore comes in claim order and
  // unwindowed by recency, and only the failed tail is capped — see the note
  // on loadRecentJobs.
  const [active, failed] = await Promise.all([
    win(["queued", "running"], true, ACTIVE_CAP),
    win(["error", "canceled"], false, 80),
  ]);
  if (active.error) throw active.error;
  if (failed.error) throw failed.error;
  return mergeJobRows((active.data ?? []) as ClipJob[], (failed.data ?? []) as ClipJob[])
    .filter((j) => want.has(j.payload?.target?.clip_id ?? ""));
}

export async function loadPendingGenerations(projectId?: string | null): Promise<PendingGen[]> {
  const win = (statuses: string[], limit: number) => {
    let q = supabase.from("jobs")
      .select("id,kind,status,progress,progress_note,preview_key,error_msg,created_at,model_id,payload")
      .in("kind", ["image_gen", "clip_gen", "master_pass"])
      .in("status", statuses)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(limit);
    // A job row carries project_id, but legacy//free-form ones may not — a null
    // project must not hide work the user is actually waiting on.
    if (projectId) q = q.or(`project_id.eq.${projectId},project_id.is.null`);
    return q;
  };
  // RUNNING IS ITS OWN WINDOW, so the card cap can never evict it. This one is
  // the only surface here whose limit is a DISPLAY choice rather than a guard —
  // 24 placeholder cards is a grid, 85 is a wall — and a display choice must
  // not decide whether the render being watched is on screen. There is at most
  // one running job per lane, so this window stays small however long the
  // queue gets. Ordering is claim order in both, per the note above.
  const [running, queued] = await Promise.all([
    win(["running"], 8),
    win(["queued"], PENDING_CARDS),
  ]);
  if (running.error) throw running.error;
  if (queued.error) throw queued.error;
  return mergeJobRows(
    (running.data ?? []) as PendingGen[],
    (queued.data ?? []) as PendingGen[],
  );
}

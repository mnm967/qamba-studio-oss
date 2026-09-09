// Persistence for take assemblies. The algebra lives in lib/assembly.ts; this
// is the round trip: load everything the assembly UI reasons over in one go,
// keep the working draft alive across reloads, and commit.
import { supabase } from "../supabase";
import { enqueueJob } from "./jobs";
import { useTimelineStore } from "../../stores/useTimelineStore";
import {
  FIT_EPS, coalesce, evidenceFromReview, fmtTime, isValid, tile, totalMs, wholeTakeId,
  type ReviewRowLike, type Segment, type TakeEvidence,
} from "../assembly";
import type { Asset, Beat, BlockTake, GenerationBlock, Job } from "./types";

export type AssemblySource = "manual" | "auto" | "review";
export type AssemblyStatus = "draft" | "rendering" | "rendered" | "failed";

export interface TakeAssembly {
  id: string;
  block_id: string;
  segments: Segment[];
  duration_ms: number;
  source: AssemblySource;
  status: AssemblyStatus;
  output_take_id: string | null;
  render_job_id: string | null;
  notes: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** A `take_reviews` row as the assembly screen reads it: the algebra only
 *  needs scores/issues/transcript, the UI also shows the verdict. */
export interface ReviewRow extends ReviewRowLike {
  verdict?: "keep" | "patch" | "retake" | "flag" | null;
  metrics?: Record<string, unknown> | null;
}

export interface AssemblyContext {
  block: GenerationBlock;
  /** for the jobs rows the commit enqueues */
  projectId: string | null;
  episodeId: string | null;
  takes: BlockTake[];
  assets: Map<string, Asset>;
  beats: Beat[];
  /** newest review per take */
  reviews: Map<string, ReviewRow>;
  evidence: Map<string, TakeEvidence>;
  assemblies: TakeAssembly[];
  /** in-flight assemble_take job for this block, if any */
  job: Job | null;
  /** the block's planned length — what the takes were rendered against, and
   *  what the bench measures every strip in. The CUT's own length is the sum
   *  of its slices and may differ from it. */
  durationMs: number;
  /** where the editor opens: the live draft, the last rendered assembly that
   *  is still the active take, or simply the active take whole */
  initial: Segment[];
}

/** Everything the assembly modal reads, in one round trip's worth of queries.
 *  Realtime tables to watch: block_takes, generation_blocks, take_assemblies,
 *  jobs. */
export async function loadAssemblyContext(blockId: string): Promise<AssemblyContext | null> {
  const [{ data: block }, { data: takeRows }, { data: asmRows }] = await Promise.all([
    supabase.from("generation_blocks").select("*").eq("id", blockId).single(),
    supabase.from("block_takes").select("*").eq("block_id", blockId).order("created_at"),
    supabase.from("take_assemblies").select("*").eq("block_id", blockId)
      .order("created_at", { ascending: false }),
  ]);
  if (!block) return null;
  const b = block as GenerationBlock;
  // The job rows a commit enqueues are scoped to the episode, and the block
  // only knows its storyboard.
  const { data: owner } = await supabase.from("storyboards")
    .select("episodes(id,project_id)").eq("id", b.storyboard_id).maybeSingle();
  const ep = (owner as { episodes?: { id: string; project_id: string } | null } | null)?.episodes ?? null;
  const takes = (takeRows ?? []) as BlockTake[];
  const assetIds = takes.map((t) => t.asset_id);

  // NOTHING IN THIS BUILD WRITES `take_reviews`, so it is not read here. The
  // automatic take reviewer — word-level ASR against the script, loudness, a
  // VLM judge on sampled frames — is not part of the local edition, and a
  // query for a table nothing fills is a round trip that can only ever return
  // nothing. The `reviews`/`evidence` maps below stay in the shape they had:
  // `cutWarnings` keeps every check that is pure geometry (jump cuts, a
  // repeated moment, a slice past the end of its own take, flickers), the
  // evidence-derived ones simply go quiet, and a fork that adds a judge has
  // one query to put back.
  const reviewRows: ReviewRow[] = [];
  const [{ data: assetRows }, { data: beatRows }, { data: jobRows }] =
    await Promise.all([
      assetIds.length
        ? supabase.from("assets").select("*").in("id", assetIds)
        : Promise.resolve({ data: [] as Asset[] }),
      b.beat_ids.length
        ? supabase.from("beats").select("*").in("id", b.beat_ids)
        : Promise.resolve({ data: [] as Beat[] }),
      // Claim order — see loadRecentJobs in lib/db/jobs.ts.
      supabase.from("jobs").select("*").eq("kind", "assemble_take")
        .in("status", ["queued", "running"])
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true }).limit(20),
    ]);

  const assets = new Map(((assetRows ?? []) as Asset[]).map((a) => [a.id, a]));
  // Rows arrive oldest-first, so the newest review for a take wins.
  const reviews = new Map<string, ReviewRow>();
  for (const r of reviewRows) if (r.take_id) reviews.set(r.take_id, r);

  // Beats come back unordered; `beat_ids` is the shot order the block was
  // compiled in, and the spans have to follow it or every semantic segment
  // lands on the wrong part of the clip.
  const beatById = new Map(((beatRows ?? []) as Beat[]).map((x) => [x.id, x]));
  const beats = b.beat_ids.map((id) => beatById.get(id)).filter(Boolean) as Beat[];

  const assemblies = (asmRows ?? []) as TakeAssembly[];
  const active = takes.find((t) => t.id === b.active_take_id) ?? takes[0] ?? null;
  const durationMs =
    (active ? assets.get(active.asset_id)?.duration_ms : null)
    ?? Math.max(0, b.t_end_ms - b.t_start_ms);

  const evidence = new Map<string, TakeEvidence>();
  for (const t of takes) {
    evidence.set(t.id, evidenceFromReview(t.id, reviews.get(t.id),
                                          assets.get(t.asset_id)?.duration_ms ?? undefined));
  }

  const job = ((jobRows ?? []) as Job[]).find(
    (j) => (j.payload as { block_id?: string } | null)?.block_id === blockId) ?? null;

  return {
    block: b, projectId: ep?.project_id ?? null, episodeId: ep?.id ?? null,
    takes, assets, beats, reviews, evidence, assemblies, job, durationMs,
    initial: initialSegments(assemblies, takes, active?.id ?? null, durationMs),
  };
}

/** Where the editor opens.
 *
 *  A live draft wins. Otherwise, if the block's active take was itself
 *  produced by an assembly, reopen THAT assembly's segments rather than a
 *  flat tile of its output — the alternative is that adjusting a cut means
 *  rebuilding the whole assembly from scratch, and worse, that the assembled
 *  take shows up as one of its own sources.
 *
 *  A stored row is checked for STRUCTURE and for takes that still exist, not
 *  for length: a cut is now free to be shorter or longer than the block it
 *  belongs to, so a length test here would throw away exactly the assemblies
 *  that used the freedom. */
export function initialSegments(
  assemblies: TakeAssembly[],
  takes: BlockTake[],
  activeTakeId: string | null,
  durationMs: number,
): Segment[] {
  const live = takes.map((t) => t.id);
  const usable = (segs: Segment[]) =>
    segs.length > 0 && segs.every((s) => live.includes(s.take_id)) && isValid(segs);

  const draft = assemblies.find((a) => a.status === "draft" && a.source === "manual");
  if (draft && usable(draft.segments)) return coalesce(draft.segments);

  const rendered = assemblies.find(
    (a) => a.status === "rendered" && a.output_take_id && a.output_take_id === activeTakeId);
  if (rendered && usable(rendered.segments)) return coalesce(rendered.segments);

  const seed = activeTakeId ?? takes[0]?.id;
  return seed ? tile(seed, durationMs) : [];
}

/** Write the working draft. One per block per source (a partial unique index
 *  enforces it), so this is an update when the row already exists — PostgREST
 *  cannot infer a conflict target on a partial index, so the read comes
 *  first.
 *
 *  `duration_ms` is COMPUTED from the slices rather than taken from the
 *  caller. It is the cut's own length now, and the worker re-adds the slices
 *  and refuses the render if the two disagree — a check that is only worth
 *  anything while nothing else can write that column. */
export async function saveDraft(opts: {
  blockId: string;
  segments: Segment[];
  source?: AssemblySource;
  notes?: Record<string, string>;
}): Promise<TakeAssembly> {
  const { blockId, segments, source = "manual", notes = {} } = opts;
  const segs = coalesce(segments);
  const body = { segments: segs, duration_ms: totalMs(segs), notes };
  const { data: existing } = await supabase.from("take_assemblies").select("id")
    .eq("block_id", blockId).eq("source", source).eq("status", "draft").maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from("take_assemblies")
      .update(body).eq("id", (existing as { id: string }).id).select().single();
    if (error) throw error;
    return data as TakeAssembly;
  }
  const { data, error } = await supabase.from("take_assemblies")
    .insert({ block_id: blockId, source, status: "draft", ...body }).select().single();
  if (error) throw error;
  return data as TakeAssembly;
}

export async function discardDraft(id: string): Promise<void> {
  const { error } = await supabase.from("take_assemblies").delete().eq("id", id);
  if (error) throw error;
}

/** Make a take the block's canonical performance — the no-render path, taken
 *  whenever the assembly turns out to be one take whole. */
export async function activateTake(opts: {
  blockId: string;
  takeId: string;
  assetId: string;
  clipId?: string;
}): Promise<void> {
  await supabase.from("block_takes").update({ state: "kept" }).eq("id", opts.takeId);
  const { error } = await supabase.from("generation_blocks")
    .update({ active_take_id: opts.takeId, status: "generated" }).eq("id", opts.blockId);
  if (error) throw error;
  if (opts.clipId) useTimelineStore.getState().patchClip(opts.clipId, { asset_id: opts.assetId });
}

export interface CommitResult {
  kind: "activated" | "queued";
  job?: Job;
  assembly?: TakeAssembly;
}

/** Commit the assembly.
 *
 *  One take whole is not a render — it is the keep/reject the compare screen
 *  always did, so it happens instantly and costs nothing. Anything with a cut
 *  in it becomes an `assemble_take` job: ffmpeg only, so it runs on the CPU
 *  lane and never queues behind a master pass.
 *
 *  The draft is promoted rather than copied (its status leaves 'draft', which
 *  frees the one-draft index), so the rendered row is the provenance of the
 *  take it produces and reopening the block picks the cut back up. */
export async function commitAssembly(opts: {
  blockId: string;
  segments: Segment[];
  /** the block's planned length — the yardstick for "is this take whole", not
   *  a requirement the cut has to meet */
  durationMs: number;
  takes: BlockTake[];
  notes?: Record<string, string>;
  projectId?: string | null;
  episodeId?: string | null;
  clipId?: string;
  assetOf: (takeId: string) => string | undefined;
  /** a take's own measured length, where the asset row carries one */
  mediaMsOf?: (takeId: string) => number | null | undefined;
  /** the cut does not fit the block's window and is to become a block of its
   *  own, placed after it (or at the end of the storyboard) */
  asNewBlock?: boolean;
  appendBlock?: boolean;
}): Promise<CommitResult> {
  const segments = coalesce(opts.segments);
  if (!isValid(segments)) {
    throw new Error("this cut has a slice with no take or no length — refusing to render it");
  }

  // A BLOCK IS A SLOT, and a take that is quietly the wrong length for it is
  // played short or leaves a gap on the lane with nothing saying so. So there
  // are two outcomes and no third: the cut fits, or it becomes a block of its
  // own. Checked here as well as in the modal because this is the function that
  // writes the job — the UI decides which route to offer, this decides that one
  // of them was taken.
  const cutMs = totalMs(segments);
  const off = cutMs - Math.round(opts.durationMs);
  if (!opts.asNewBlock && Math.abs(off) > FIT_EPS) {
    throw new Error(
      `this cut is ${fmtTime(cutMs)} against the block's ${fmtTime(opts.durationMs)} — `
      + "fit it to the block, or save it as a block of its own");
  }

  // ONE TAKE WHOLE is the free path, and a TRIMMED single slice is not it:
  // activating the take would hand back the untrimmed render with nothing
  // saying so, which is the one silent wrong answer this screen can give.
  const whole = wholeTakeId(segments, opts.durationMs, opts.mediaMsOf);
  if (whole) {
    const assetId = opts.assetOf(whole);
    if (!assetId) throw new Error("that take has no media");
    await activateTake({ blockId: opts.blockId, takeId: whole, assetId, clipId: opts.clipId });
    return { kind: "activated" };
  }

  const assembly = await saveDraft({
    blockId: opts.blockId, segments, notes: opts.notes,
  });
  const job = await enqueueJob({
    kind: "assemble_take", lane: "cpu", priority: 15,
    project_id: opts.projectId ?? undefined,
    episode_id: opts.episodeId ?? undefined,
    payload: {
      assembly_id: assembly.id, block_id: opts.blockId,
      // The clip is what a new block takes the place of on the lane, so it
      // travels on both routes (the ordinary one ignores it).
      ...(opts.clipId ? { clip_id: opts.clipId } : {}),
      ...(opts.asNewBlock ? { as_new_block: true, append: !!opts.appendBlock } : {}),
    },
  });
  const { error } = await supabase.from("take_assemblies")
    .update({ status: "rendering", render_job_id: job.id }).eq("id", assembly.id);
  // The job is already queued and the worker sets this itself on claim; a
  // failed status write must not look like a failed commit.
  if (error) console.warn("assembly -> rendering failed", error.message);
  return { kind: "queued", job, assembly: { ...assembly, status: "rendering", render_job_id: job.id } };
}

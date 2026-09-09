// Director-side data access: chat threads/messages, bible entries with
// revisions + ref slots, storyboards with scenes/beats/blocks.
import { supabase } from "../supabase";
import { maxContentMs, planBlock } from "../h3timing";
import { blockKind, type BlockKind } from "../blockKind";
import { retryPlan, type TranscriptRow } from "../directorRetry";
import { registerAsset } from "./assets";
import { enqueueJob } from "./jobs";
import { uploadMedia } from "../upload";
import { useTimelineStore } from "../../stores/useTimelineStore";
import type {
  AssetKind, Beat, BibleAsset, BibleEntry, BlockTake, ChatMessage, ChatThread, GenerationBlock,
  Scene, Storyboard,
} from "./types";

// ------------------------------------------------------------------- chat ---
export async function loadThreads(projectId: string): Promise<ChatThread[]> {
  const { data, error } = await supabase
    .from("chat_threads").select("*").eq("project_id", projectId)
    .order("updated_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as ChatThread[];
}

export async function loadMessages(threadId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages").select("*").eq("thread_id", threadId)
    .order("created_at").limit(200);
  if (error) throw error;
  return (data ?? []) as ChatMessage[];
}

/** A thread plus the two facts the history list needs to be readable: how many
 *  turns it holds and what the last one said. Both come from a single extra
 *  query over the project's messages rather than one per thread. */
export interface ThreadSummary extends ChatThread {
  turns: number;
  preview: string;
}

const firstText = (content: unknown): string => {
  const blocks = Array.isArray(content) ? content : [];
  for (const b of blocks as { type?: string; text?: string }[]) {
    if (b?.type === "text" && b.text?.trim()) return b.text.trim().replace(/\s+/g, " ");
  }
  return "";
};

export async function loadThreadSummaries(projectId: string): Promise<ThreadSummary[]> {
  const threads = await loadThreads(projectId);
  if (!threads.length) return [];
  // Newest first so the first row seen per thread IS its last message.
  const { data } = await supabase
    .from("chat_messages").select("thread_id,content,created_at")
    .in("thread_id", threads.map((t) => t.id))
    .order("created_at", { ascending: false }).limit(600);
  const turns = new Map<string, number>();
  const preview = new Map<string, string>();
  for (const m of (data ?? []) as { thread_id: string; content: unknown }[]) {
    turns.set(m.thread_id, (turns.get(m.thread_id) ?? 0) + 1);
    if (!preview.has(m.thread_id)) {
      const t = firstText(m.content);
      if (t) preview.set(m.thread_id, t);
    }
  }
  return threads.map((t) => ({
    ...t,
    turns: turns.get(t.id) ?? 0,
    preview: preview.get(t.id) ?? "",
  }));
}

/**
 * What a retry has to do to the transcript before the turn runs again.
 *
 * A failed turn has usually ALREADY written the user's message row — both
 * transports write it before they stream — so re-posting the same words puts
 * one turn in the transcript twice. And a failure that got as far as a reply
 * leaves that reply behind: the local paths write "⚠ rate limited" onto the
 * assistant row and re-raise, which is worse than untidy, because both local
 * history builders require the LAST row to be the user's. With the failed
 * reply still there a desktop retry falls through to the pod's queue, and the
 * pod's own turn raises "thread has no trailing user message".
 *
 * The rule — which rows go and whether this turn's row is already there — is
 * `retryPlan` in lib/directorRetry, where its cases are tested. This is the
 * query around it.
 */
export async function prepareRetry(
  threadId: string | null, text: string, opts: { failed: boolean } = { failed: true },
): Promise<{ resume: boolean; cleared: number; answered: boolean }> {
  if (!threadId) return { resume: false, cleared: 0, answered: false };
  const { data, error } = await supabase
    .from("chat_messages").select("id,role,content")
    .eq("thread_id", threadId).order("created_at", { ascending: false }).limit(6);
  if (error) throw error;
  const { clear, resume, answered } = retryPlan((data ?? []) as TranscriptRow[], text, opts);
  if (clear.length) {
    const { error: delErr } = await supabase.from("chat_messages").delete().in("id", clear);
    if (delErr) throw delErr;
  }
  return { resume, cleared: clear.length, answered };
}

/** Saved one-shot sessions, newest first — the wizard's history list. */
export async function loadWizardSessions(projectId: string): Promise<ThreadSummary[]> {
  // Narrow and short on purpose: this query gates how fast the wizard can
  // restore your last draft, and a modal that shows an empty brief for three
  // seconds gets typed into before the real one arrives.
  const { data, error } = await supabase
    .from("chat_threads")
    .select("id,project_id,episode_id,kind,title,backend,brief,wizard,updated_at")
    .eq("project_id", projectId).eq("kind", "wizard")
    .order("updated_at", { ascending: false }).limit(20);
  if (error) throw error;
  const threads = (data ?? []) as ChatThread[];
  if (!threads.length) return [];
  const { data: msgs } = await supabase
    .from("chat_messages").select("thread_id,content")
    .in("thread_id", threads.map((t) => t.id))
    .order("created_at", { ascending: false }).limit(200);
  const turns = new Map<string, number>();
  const preview = new Map<string, string>();
  for (const m of (msgs ?? []) as { thread_id: string; content: unknown }[]) {
    turns.set(m.thread_id, (turns.get(m.thread_id) ?? 0) + 1);
    if (!preview.has(m.thread_id)) {
      const t = firstText(m.content);
      if (t) preview.set(m.thread_id, t);
    }
  }
  return threads.map((t) => ({
    ...t, turns: turns.get(t.id) ?? 0, preview: preview.get(t.id) ?? "",
  }));
}

/** Persist where the wizard got to. The modal owns the session while it is
 *  open, so it writes the whole object rather than merging. */
export async function saveWizardState(
  threadId: string, state: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("chat_threads").update({ wizard: state }).eq("id", threadId);
  if (error) throw error;
}

export async function createThread(opts: {
  projectId: string; episodeId?: string | null; backend?: string | null; title?: string;
}): Promise<ChatThread> {
  const { data, error } = await supabase.from("chat_threads").insert({
    project_id: opts.projectId, episode_id: opts.episodeId ?? null, kind: "director",
    title: opts.title ?? null, backend: opts.backend ?? null,
  }).select("*").single();
  if (error) throw error;
  return data as ChatThread;
}

export async function renameThread(id: string, title: string): Promise<void> {
  const { error } = await supabase.from("chat_threads").update({ title }).eq("id", id);
  if (error) throw error;
}

/** chat_messages cascades on the thread, so this takes the transcript with it. */
export async function deleteThread(id: string): Promise<void> {
  const { error } = await supabase.from("chat_threads").delete().eq("id", id);
  if (error) throw error;
}

// ------------------------------------------------------------------ bible ---
export interface BibleRevision {
  id: string;
  entry_id: string;
  version: number;
  doc: Record<string, unknown>;
  identity_line: string | null;
  change_note: string | null;
  proposed_by: string;
  confirmed_at: string | null;
  created_at: string;
}

/**
 * The project's bible.
 *
 * `committedOnly` drops the rows a wizard session invented and has not queued
 * yet (`doc.draft_session`). It is opt-IN, and which callers take it is the
 * whole design:
 *
 *  * The surfaces that mean "this project's canon" — the Bible page and the
 *    reference pickers — pass it. A series shares its bible across episodes, so
 *    an abandoned run's phantom cast used to follow you into the next one, and
 *    that is the pollution being fixed.
 *  * The surfaces that mean "this EPISODE" — the storyboard page, the scene
 *    editor, the prompt/refs modal — do NOT. A tier-2 episode awaiting approval
 *    is made entirely of draft entries; filtering them there would render its
 *    own cast list as a row of question marks.
 *
 * Defaulting to "show everything" keeps that second group correct without each
 * of them having to know the rule. A returning character the plan merely
 * referenced is never stamped, so it is canon to both groups.
 */
export async function loadBible(
  projectId: string, opts: { committedOnly?: boolean } = {},
): Promise<BibleEntry[]> {
  const { data, error } = await supabase
    .from("bible_entries").select("*").eq("project_id", projectId)
    .order("kind").order("name");
  if (error) throw error;
  const rows = (data ?? []) as BibleEntry[];
  if (!opts.committedOnly) return rows;
  return rows.filter((e) => !(e.doc as { draft_session?: string } | null)?.draft_session);
}

export async function loadBibleAssets(entryIds: string[]): Promise<BibleAsset[]> {
  if (!entryIds.length) return [];
  const { data, error } = await supabase
    .from("bible_assets").select("*").in("entry_id", entryIds).order("slot");
  if (error) throw error;
  return (data ?? []) as BibleAsset[];
}

/** Create a bible entry by hand, from the wizard's cast & world step.
 *  Draft, like everything the director proposes — the Bible page is still where
 *  canon gets confirmed. */
export async function addEntry(
  projectId: string, kind: BibleEntry["kind"],
  fields: { name: string; identity_line?: string; summary?: string }
): Promise<BibleEntry> {
  const { data, error } = await supabase.from("bible_entries").insert({
    project_id: projectId, kind, name: fields.name.slice(0, 80),
    identity_line: fields.identity_line?.trim() || null,
    summary: fields.summary?.trim() || null,
    doc: {}, status: "draft",
  }).select("*").single();
  if (error) throw error;
  return data as BibleEntry;
}

/** Drop an entry the user does not want. Guarded to drafts: confirmed canon is
 *  referenced by scenes and revisions, and losing it silently would be worse
 *  than the clutter. */
export async function deleteDraftEntry(id: string): Promise<void> {
  const { error } = await supabase.from("bible_entries")
    .delete().eq("id", id).eq("status", "draft");
  if (error) throw error;
}

/** Delete a story bible entry (and any associated lore document embeddings).
 *  Cascades down to bible_assets and bible_revisions via database foreign key. */
export async function deleteBibleEntry(id: string): Promise<void> {
  await supabase.from("rag_documents").delete().eq("source", `bible:${id}`);
  const { error } = await supabase.from("bible_entries").delete().eq("id", id);
  if (error) throw error;
}

export async function saveEntry(id: string, patch: Partial<BibleEntry>): Promise<void> {
  const { error } = await supabase.from("bible_entries").update(patch).eq("id", id);
  if (error) throw error;
}

/** Write a world-level `doc` value onto the entries that disagree with it.
 *
 *  `era` is not the entry's — every character, environment and prop in a
 *  project carries the same string, so the bible entry modal says as much and
 *  offers this. It is deliberately an EXPLICIT action carrying its own count
 *  rather than something a blur does: editing a field on one sheet must not
 *  silently rewrite thirty rows.
 *
 *  Merging into jsonb is a per-row read-modify-write (PostgREST cannot express
 *  `doc || '{…}'`), so this patches each id in turn. The list is the entries of
 *  one project, i.e. tens of rows, and this runs on a button press. */
export async function matchWorldField(
  ids: string[], key: string, value: string,
): Promise<number> {
  if (!ids.length) return 0;
  const { data, error } = await supabase.from("bible_entries")
    .select("id,doc").in("id", ids);
  if (error) throw error;
  const rows = (data ?? []) as { id: string; doc: Record<string, unknown> | null }[];
  await Promise.all(rows.map((r) => supabase.from("bible_entries")
    .update({ doc: { ...(r.doc ?? {}), [key]: value } }).eq("id", r.id)));
  return rows.length;
}

// -------------------------------------------------------- wizard drafts ---
// A `bible_entries` row is shared by every episode of the series, so a wizard
// run that came back wrong used to leave its phantom cast in the bible
// permanently, with nothing to tell its rows apart from canon. The planner now
// stamps everything it invents with `doc.draft_session` (the wizard thread) and
// leaves it `status: 'draft'`; these two functions are the only ways that ends.
//
// Deliberately NOT covering the storyboard: scenes and beats hang off the
// EPISODE and cascade with it, so they were always disposable. And deliberately
// not covering the generated IMAGES: those are `assets` rows on a public bucket
// (invariant #2) and belong to the library once made. A sheet in your library
// is not pollution; a character who does not exist is.

/** Everything this wizard session invented and has not committed. */
export async function loadDraftSessionEntries(
  projectId: string, sessionId: string,
): Promise<BibleEntry[]> {
  if (!sessionId) return [];
  const { data, error } = await supabase
    .from("bible_entries").select("*")
    .eq("project_id", projectId)
    .eq("doc->>draft_session", sessionId);
  if (error) throw error;
  return (data ?? []) as BibleEntry[];
}

/**
 * Promote this session's drafts to canon — what "Queue episode" means.
 *
 * Clearing the stamp is half the job: a row that still carries `draft_session`
 * is one a later discard would delete, so leaving it behind would make
 * committed canon destructible by an abandoned session. Twin of
 * `confirm_draft_entries` in worker/llm.py, which tier 1 runs for itself.
 */
export async function confirmDraftSession(
  projectId: string, sessionId: string,
): Promise<number> {
  const rows = await loadDraftSessionEntries(projectId, sessionId);
  for (const row of rows) {
    const doc = { ...(row.doc as Record<string, unknown> | null ?? {}) };
    delete doc.draft_session;
    const { error } = await supabase.from("bible_entries")
      .update({ status: "confirmed", doc }).eq("id", row.id);
    if (error) throw error;
  }
  return rows.length;
}

/**
 * Throw this session's drafts away.
 *
 * Scoped to the stamp, so a returning character the plan merely REFERENCED is
 * untouched — those are never stamped. `bible_assets` and `bible_revisions`
 * cascade; the sheets themselves stay in the library.
 */
export async function discardDraftSession(
  projectId: string, sessionId: string,
): Promise<number> {
  const rows = await loadDraftSessionEntries(projectId, sessionId);
  for (const row of rows) await deleteBibleEntry(row.id);
  return rows.length;
}

export async function createEntry(e: {
  project_id: string; kind: BibleEntry["kind"]; name: string;
  summary?: string; identity_line?: string;
}): Promise<BibleEntry> {
  const { data, error } = await supabase
    .from("bible_entries").insert({ status: "draft", doc: {}, ...e }).select().single();
  if (error) throw error;
  return data as BibleEntry;
}

export async function attachRef(entryId: string, assetId: string, role: string, slot: number): Promise<void> {
  const { error } = await supabase
    .from("bible_assets")
    .upsert({ entry_id: entryId, asset_id: assetId, role, slot }, { onConflict: "entry_id,asset_id" });
  if (error) throw error;
}

export async function detachRef(entryId: string, assetId: string): Promise<void> {
  const { error } = await supabase
    .from("bible_assets").delete().eq("entry_id", entryId).eq("asset_id", assetId);
  if (error) throw error;
}

export async function loadRevisions(entryId: string): Promise<BibleRevision[]> {
  const { data, error } = await supabase
    .from("bible_revisions").select("*").eq("entry_id", entryId)
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as BibleRevision[];
}

/** A bible entry changed, so every block that stages it renders something else
 *  now — a new identity line, new wardrobe, a new palette. NewEntryModal has
 *  always told the user that confirming "marks affected blocks stale"; nothing
 *  did it, so the ripple the storyboard strip exists to show was simply absent
 *  and a re-render reproduced the version just replaced.
 *
 *  "Affected" resolves through the scenes that CAST the entry (or are set
 *  there), then through the same rule `markSceneBlocksStale` applies: only
 *  `generated` blocks flip, because queued and planned ones compile their
 *  prompts at execution time and pick the change up on their own.
 *
 *  One `overlaps` rather than a `markSceneBlocksStale` per scene: a returning
 *  character is in a dozen scenes, and that would be a dozen round trips for
 *  one flag. Returns how many blocks actually went stale. */
export async function markEntryBlocksStale(entryId: string): Promise<number> {
  const [cast, env] = await Promise.all([
    supabase.from("scenes").select("id").contains("cast_ids", [entryId]),
    supabase.from("scenes").select("id").eq("environment_id", entryId),
  ]);
  const sceneIds = [...new Set([
    ...((cast.data ?? []) as { id: string }[]).map((s) => s.id),
    ...((env.data ?? []) as { id: string }[]).map((s) => s.id),
  ])];
  if (!sceneIds.length) return 0;
  const { data, error } = await supabase
    .from("generation_blocks")
    .update({ status: "stale" })
    .overlaps("scene_ids", sceneIds)
    .eq("status", "generated")
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/** Apply a proposed revision to its entry, stamp it confirmed, and flag the
 *  blocks it invalidates — see markEntryBlocksStale for why that last step is
 *  part of confirming rather than a separate thing to remember. */
export async function confirmRevision(rev: BibleRevision): Promise<number> {
  await saveEntry(rev.entry_id, {
    doc: rev.doc,
    identity_line: rev.identity_line,
    version: rev.version,
    status: "confirmed",
  } as Partial<BibleEntry>);
  const { error } = await supabase
    .from("bible_revisions").update({ confirmed_at: new Date().toISOString() }).eq("id", rev.id);
  if (error) throw error;
  return markEntryBlocksStale(rev.entry_id);
}

export async function dismissRevision(id: string): Promise<void> {
  const { error } = await supabase.from("bible_revisions").delete().eq("id", id);
  if (error) throw error;
}

// -------------------------------------------------------------- storyboard ---
/** Every plan ever made for this episode, newest version first.
 *
 *  Ordered on `version` rather than `created_at` because that is now the number
 *  on screen, and the two can disagree: a board written before the column
 *  existed carries the backfilled number, and `created_at` has second-level ties
 *  within one planning run. created_at stays as the tiebreak so a pre-migration
 *  row still sorts sensibly beside its siblings.
 *
 *  Callers that want "the current plan" take `[0]`. That was the whole of the
 *  behaviour before versions existed, and it is still right — what changed is
 *  that the rest of the list is now reachable instead of orphaned. */
export async function storyboardsForEpisode(episodeId: string): Promise<Storyboard[]> {
  const { data, error } = await supabase
    .from("storyboards").select("*").eq("episode_id", episodeId)
    .order("version", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Storyboard[];
}

export interface StoryboardFull {
  storyboard: Storyboard;
  scenes: Scene[];
  beats: Map<string, Beat[]>;
  blocks: GenerationBlock[];
}

export async function loadStoryboardFull(id: string): Promise<StoryboardFull> {
  const [{ data: sbRow, error: e1 }, { data: scenes, error: e2 }, { data: blocks, error: e3 }] =
    await Promise.all([
      supabase.from("storyboards").select("*").eq("id", id).single(),
      supabase.from("scenes").select("*").eq("storyboard_id", id).order("idx"),
      supabase.from("generation_blocks").select("*").eq("storyboard_id", id).order("idx"),
    ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  const sceneRows = (scenes ?? []) as Scene[];
  const beats = new Map<string, Beat[]>();
  if (sceneRows.length) {
    const { data: beatRows, error: e4 } = await supabase
      .from("beats").select("*").in("scene_id", sceneRows.map((s) => s.id)).order("idx");
    if (e4) throw e4;
    for (const b of (beatRows ?? []) as Beat[]) {
      const list = beats.get(b.scene_id) ?? [];
      list.push(b);
      beats.set(b.scene_id, list);
    }
  }
  return { storyboard: sbRow as Storyboard, scenes: sceneRows, beats, blocks: (blocks ?? []) as GenerationBlock[] };
}

/** What a stale block actually covers: the scenes it spans and its own shots.
 *
 *  The director dock's review popup is the one surface that has to answer "and
 *  what did I change?" — a list of block refs is not reviewable, because the
 *  thing that went stale is a SCENE or a BEAT and the block is only where it
 *  lands. `BlockIndexRow` deliberately carries neither (it rides along with
 *  every chat message), so this is a separate query made once, for the handful
 *  of blocks that are stale, when the popup opens.
 *
 *  A block may span two scenes — only an environment cut splits one — so
 *  `scenes` is a list and not the opening scene alone. Beats come back in the
 *  compiler's own order, `(scene idx, beat idx)`: `beat_ids` array order is NOT
 *  that (see worker/storyplan.revise_beats), and a shot numbered off the wrong
 *  order names a different shot than the render does. */
export interface BlockPlanDetail {
  scenes: { id: string; idx: number; slug: string | null }[];
  beats: {
    id: string; scene_id: string; idx: number;
    /** the shot's own action, trimmed for one line */
    action: string;
    /** how many lines are spoken in it — the thing a re-render most changes */
    lines: number;
    camera: string | null;
  }[];
}

export async function loadBlockPlanDetail(
  blockIds: readonly string[],
): Promise<Map<string, BlockPlanDetail>> {
  const out = new Map<string, BlockPlanDetail>();
  if (!blockIds.length) return out;
  const { data: blocks, error } = await supabase
    .from("generation_blocks").select("id,scene_ids,beat_ids").in("id", [...blockIds]);
  if (error) throw error;
  const rows = (blocks ?? []) as { id: string; scene_ids: string[] | null; beat_ids: string[] | null }[];
  const sceneIds = [...new Set(rows.flatMap((b) => b.scene_ids ?? []))];
  const beatIds = [...new Set(rows.flatMap((b) => b.beat_ids ?? []))];
  const [sceneRes, beatRes] = await Promise.all([
    sceneIds.length
      ? supabase.from("scenes").select("id,idx,slug").in("id", sceneIds)
      : Promise.resolve({ data: [], error: null }),
    beatIds.length
      ? supabase.from("beats").select("id,scene_id,idx,action,camera,dialogue").in("id", beatIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sceneRes.error) throw sceneRes.error;
  if (beatRes.error) throw beatRes.error;
  const sceneById = new Map(((sceneRes.data ?? []) as { id: string; idx: number; slug: string | null }[])
    .map((s) => [s.id, s]));
  const beatById = new Map(((beatRes.data ?? []) as (Pick<Beat, "id" | "scene_id" | "idx" | "action" | "camera" | "dialogue">)[])
    .map((b) => [b.id, b]));
  for (const b of rows) {
    const scenes = (b.scene_ids ?? []).map((id) => sceneById.get(id)).filter(Boolean)
      .map((s) => ({ id: s!.id, idx: s!.idx, slug: s!.slug }))
      .sort((x, y) => x.idx - y.idx);
    const beats = (b.beat_ids ?? []).map((id) => beatById.get(id)).filter(Boolean)
      .map((t) => ({
        id: t!.id, scene_id: t!.scene_id, idx: t!.idx,
        action: (t!.action ?? "").trim(),
        lines: (t!.dialogue ?? []).length,
        camera: t!.camera ?? null,
      }))
      // The compiler's order, not `beat_ids`' — see the doc comment.
      .sort((x, y) => (sceneById.get(x.scene_id)?.idx ?? 0) - (sceneById.get(y.scene_id)?.idx ?? 0)
        || x.idx - y.idx);
    out.set(b.id, { scenes, beats });
  }
  return out;
}

/** One line per block of the current episode: its ref, the scene it opens in,
 *  its window and its state.
 *
 *  This exists for the director's situational context (lib/directorContext).
 *  "Render b6 again" / "what is wrong with that block" needs the index in the
 *  system prompt, or every such turn spends a tool round trip re-discovering
 *  what the screen already shows. Deliberately lean — no beats, no ref plans,
 *  no takes — because it is rebuilt whenever the episode changes and rides
 *  along with every message. */
export interface BlockIndexRow {
  id: string;
  idx: number;
  t_start_ms: number;
  t_end_ms: number;
  status: string;
  scene_id: string | null;
  /** how the storyboard labels that scene ("S3 THE-LOOP") */
  scene_label: string | null;
  /** Set when this block opens on another's final frame. Carried because a
   *  re-render of several blocks has to queue chained ones IN ORDER — the
   *  successor's opening frame is the predecessor's last one — and the dock's
   *  stale-notice bar is the one surface that queues a fan-out from the
   *  browser. `rerender_stale` reads the same column for the same reason. */
  chain_from_block_id: string | null;
  /** What KIND of block — a planner shot, or a chain/extension the timeline
   *  made (lib/blockKind). The director has to call an extension "Extension
   *  19", because it renders from a recipe and has no shots to rewrite. */
  kind?: BlockKind;
  /** The first shot's action, trimmed to one line — or a clip-born block's
   *  recipe prompt. "The block where she takes the helmet off" has to resolve
   *  against what the blocks CONTAIN; an index of refs and scene slugs alone
   *  is how a re-render landed on the wrong block. */
  first_shot?: string | null;
}

/** How much of a shot's action rides in the index. One line: enough to tell
 *  two blocks of one scene apart, not enough to push the conversation out of
 *  the model's window over a long episode. */
const FIRST_SHOT_CHARS = 110;

export async function loadBlockIndex(episodeId: string): Promise<BlockIndexRow[]> {
  const boards = await storyboardsForEpisode(episodeId);
  const sbId = boards[0]?.id;
  if (!sbId) return [];
  const [{ data: blocks }, { data: scenes }] = await Promise.all([
    supabase.from("generation_blocks")
      .select("id,idx,t_start_ms,t_end_ms,status,scene_ids,beat_ids,chain_from_block_id,params")
      .eq("storyboard_id", sbId).order("idx"),
    supabase.from("scenes").select("id,idx,slug").eq("storyboard_id", sbId).order("idx"),
  ]);
  const byId = new Map(((scenes ?? []) as { id: string; idx: number; slug: string | null }[])
    .map((s) => [s.id, `S${s.idx + 1}${s.slug ? ` ${s.slug}` : ""}`]));
  type Row = Pick<GenerationBlock, "id" | "idx" | "t_start_ms" | "t_end_ms" | "status" | "params">
    & { scene_ids: string[]; beat_ids: string[] | null; chain_from_block_id: string | null };
  const rows = (blocks ?? []) as Row[];
  // One query for every block's FIRST beat. A clip-born block has none and
  // its recipe prompt stands in below.
  const firstBeatIds = [...new Set(rows.map((b) => (b.beat_ids ?? [])[0]).filter(Boolean))] as string[];
  const { data: beats } = firstBeatIds.length
    ? await supabase.from("beats").select("id,action").in("id", firstBeatIds)
    : { data: [] as { id: string; action: string | null }[] };
  const actionOf = new Map(((beats ?? []) as { id: string; action: string | null }[])
    .map((b) => [b.id, b.action]));
  const oneLine = (t: unknown): string | null => {
    const s = String(t ?? "").replace(/\s+/g, " ").trim();
    return s ? (s.length > FIRST_SHOT_CHARS ? `${s.slice(0, FIRST_SHOT_CHARS - 1)}…` : s) : null;
  };
  return rows.map((b) => {
    // A block may span scenes; it is named by the one it OPENS in, which is
    // how the storyboard reads it and how a user refers to it.
    const first = (b.scene_ids ?? [])[0] ?? null;
    const recipe = (b.params as { clip_gen?: { prompt?: unknown } } | null)?.clip_gen;
    const firstBeat = (b.beat_ids ?? [])[0];
    return {
      id: b.id, idx: b.idx, t_start_ms: b.t_start_ms, t_end_ms: b.t_end_ms,
      status: b.status, scene_id: first,
      scene_label: first ? byId.get(first) ?? null : null,
      chain_from_block_id: b.chain_from_block_id ?? null,
      kind: blockKind(b),
      first_shot: firstBeat ? oneLine(actionOf.get(firstBeat)) : oneLine(recipe?.prompt),
    };
  });
}

export async function saveScene(id: string, patch: Partial<Scene>): Promise<void> {
  const { error } = await supabase.from("scenes").update(patch).eq("id", id);
  if (error) throw error;
}

export async function saveBeat(id: string, patch: Partial<Beat>): Promise<void> {
  const { error } = await supabase.from("beats").update(patch).eq("id", id);
  if (error) throw error;
}

export async function saveStoryboard(id: string, patch: Partial<Storyboard>): Promise<void> {
  const { error } = await supabase.from("storyboards").update(patch).eq("id", id);
  if (error) throw error;
}

/** Cancel a whole render run: every queued/running job tied to the
 * storyboard's blocks (or its launch/plan), then reset block + storyboard
 * state so a fresh launch starts clean. Returns how many jobs were told
 * to stop (running GPU work interrupts within ~5s worker-side). */
export async function cancelStoryboardRun(storyboardId: string, projectId: string): Promise<number> {
  const { data: blocks } = await supabase
    .from("generation_blocks").select("id").eq("storyboard_id", storyboardId);
  const blockIds = new Set((blocks ?? []).map((b) => b.id));
  const { data: jobs } = await supabase
    .from("jobs").select("id,kind,status,payload")
    .eq("project_id", projectId).in("status", ["queued", "running"]);
  const targets = (jobs ?? []).filter((j) => {
    const p = (j.payload ?? {}) as { block_id?: string; storyboard_id?: string; task?: string };
    if (p.block_id) return blockIds.has(p.block_id);
    if (j.kind === "launch_render") return p.storyboard_id === storyboardId;
    if (j.kind === "llm_task") return p.task === "plan_storyboard";
    return j.kind === "image_gen"; // ref sheets belong to the run being canceled
  });
  // queued first so dependents don't error while parents die; running last
  targets.sort((a, b) => Number(a.status === "running") - Number(b.status === "running"));
  for (const j of targets) {
    await supabase.rpc("request_job_cancel", { p_job: j.id });
  }
  await supabase.from("generation_blocks")
    .update({ status: "planned" })
    .eq("storyboard_id", storyboardId).in("status", ["queued", "generating"]);
  await supabase.from("storyboards").update({ status: "approved" }).eq("id", storyboardId);
  return targets.length;
}

/** Write a new scene order (the full id list, in the order they should read).
 *
 * One RPC rather than a PATCH per row: `(storyboard_id, idx)` is unique and not
 * deferrable, so a permutation applied row by row collides with a row it hasn't
 * moved yet — and a sequence of PATCHes that dies halfway leaves the storyboard
 * scrambled. Returns how many scenes actually moved; marks the block plan stale
 * when any did. */
export async function reorderScenes(storyboardId: string, ids: string[]): Promise<number> {
  const { data, error } = await supabase
    .rpc("reorder_scenes", { p_storyboard: storyboardId, p_ids: ids });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Remove one scene from its storyboard. Its beats cascade with it.
 *
 * Two things have to follow the delete or the storyboard is quietly wrong,
 * and they are the same two `delete_scene` makes in director/tools.js:
 *
 *  * the scenes after it CLOSE THE GAP. `idx` is dense everywhere it is read
 *    — the ruler, the `S3` label, the refs the director resolves — so a hole
 *    silently renames every scene after it.
 *  * the WHOLE block plan goes stale, not this scene's slice of it. Blocks
 *    span scenes and carry absolute t_start_ms/t_end_ms, so removing seconds
 *    from the middle moves every window after it — the same reasoning
 *    `reorder_scenes` states for a re-order. Unconditional, because deleting
 *    the LAST scene moves nothing and still shortens the episode.
 *
 * The renumber goes through that RPC rather than a PATCH per row for the
 * reason the RPC exists: `(storyboard_id, idx)` is unique and not deferrable,
 * and a loop that dies halfway leaves the storyboard scrambled. Blocks naming
 * only this scene are left in place, marked stale — `launch_render` deletes
 * every block of the storyboard and re-plans from the scenes that remain.
 */
export async function deleteScene(
  sceneId: string,
): Promise<{ resequenced: number; warning: string | null }> {
  const { data: scene, error: readErr } = await supabase
    .from("scenes").select("id,storyboard_id").eq("id", sceneId).maybeSingle();
  if (readErr) throw readErr;
  // Already gone — another tab, or a double-press. Nothing to renumber.
  if (!scene) return { resequenced: 0, warning: null };
  const storyboardId = (scene as { storyboard_id: string }).storyboard_id;

  // ONLY this one throws. Past here the scene is gone, and reporting a
  // follow-up failure as "couldn't delete the scene" would be a lie about
  // the one thing that did happen — so the rest is best effort, and says
  // which half of it did not land rather than swallowing it. Both are
  // recoverable: a re-order re-densifies `idx`, and a launch re-plans.
  const { error: delErr } = await supabase.from("scenes").delete().eq("id", sceneId);
  if (delErr) throw delErr;

  let resequenced = 0;
  let warning: string | null = null;
  try {
    const { data: rest, error: restErr } = await supabase
      .from("scenes").select("id").eq("storyboard_id", storyboardId).order("idx");
    if (restErr) throw restErr;
    const ids = ((rest ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length) resequenced = await reorderScenes(storyboardId, ids);
  } catch (e) {
    // The likely cause is a scene added elsewhere since the read, which is
    // exactly what `reorder_scenes` refuses on. The numbering has a hole in
    // it until the next re-order; the order itself is still right.
    warning = `the scene numbers weren't closed up (${(e as Error).message})`;
  }

  const { error: staleErr } = await supabase.from("generation_blocks")
    .update({ status: "stale" })
    .eq("storyboard_id", storyboardId)
    .in("status", ["planned", "generated"]);
  if (staleErr) {
    warning = (warning ? `${warning}; ` : "")
      + `the blocks weren't marked stale (${staleErr.message})`;
  }

  return { resequenced, warning };
}

/** A scene changed after its blocks were generated — flag them stale so the
 * strip shows the ripple (queued/planned blocks pick edits up automatically:
 * prompts compile at execution time). */
export async function markSceneBlocksStale(sceneId: string): Promise<void> {
  const { error } = await supabase
    .from("generation_blocks")
    .update({ status: "stale" })
    .contains("scene_ids", [sceneId])
    .eq("status", "generated");
  if (error) throw error;
}

/** Write pre-computed `params` onto a set of blocks — the scene editor's
 *  combat toggle and its video-model card.
 *
 *  A per-block read-modify-write rather than one blanket patch, because
 *  `params` is a single jsonb blob carrying the model key, the resolution, the
 *  review flag and the LoRA stack: replacing it to set one key is how a
 *  per-block model override disappears. `fightPatch` / `modelPatch` compute
 *  each block's full next value; this only writes them.
 *
 *  It marks the touched blocks STALE for the reason every other edit in that
 *  modal does — the change alters what renders and the take on screen is from
 *  before it. Same narrowing as `markSceneBlocksStale`: only a `generated`
 *  block moves, so a queued or failed one is left alone.
 *
 *  Returns how many rows it wrote, because "turned on for 3 blocks" having
 *  written two is the same lie this codebase keeps naming. */
export async function setBlocksParams(
  patches: { id: string; params: Record<string, unknown> }[],
): Promise<number> {
  for (const p of patches) {
    const { error } = await supabase.from("generation_blocks")
      .update({ params: p.params }).eq("id", p.id);
    if (error) throw error;
  }
  if (patches.length) {
    const { error } = await supabase.from("generation_blocks")
      .update({ status: "stale" })
      .in("id", patches.map((p) => p.id))
      .eq("status", "generated");
    // The flag is written; a failed status write is cosmetic and the block is
    // still re-renderable by hand. Don't fail the caller over it.
    if (error) console.warn("fight blocks -> stale failed", error.message);
  }
  return patches.length;
}

/** Add one block by hand, without going through the planner.
 *
 * The one-shot path builds blocks from a brief, which is the wrong shape when
 * you just want to render a single idea: there was no way to get a first block
 * at all except by launching a whole storyboard. This creates the scaffolding
 * a block cannot exist without — a storyboard, a scene, one beat — and chains
 * it onto whatever came before so a hand-made block still continues the video.
 */
export async function createManualBlock(opts: {
  episodeId: string;
  durationMs?: number;
  action?: string;
  camera?: string;
}): Promise<{ blockId: string; sceneId: string; storyboardId: string }> {
  const durationMs = Math.min(maxContentMs(), Math.max(2000, opts.durationMs ?? 8000));
  // frames is NOT NULL and has to be a legal 17n+5 count from the start; the
  // worker re-plans from the same window at render time.
  const plan = planBlock(durationMs);

  const existing = await storyboardsForEpisode(opts.episodeId);
  let storyboard = existing[0];
  if (!storyboard) {
    const { data, error } = await supabase.from("storyboards")
      .insert({ episode_id: opts.episodeId, status: "draft" }).select("*").single();
    if (error) throw error;
    storyboard = data as Storyboard;
  }

  const { data: blocks } = await supabase.from("generation_blocks")
    .select("id,idx,t_end_ms,active_take_id").eq("storyboard_id", storyboard.id).order("idx");
  const prev = (blocks ?? []).at(-1) as
    { id: string; idx: number; t_end_ms: number; active_take_id: string | null } | undefined;
  const startMs = prev?.t_end_ms ?? 0;
  const nextIdx = prev ? prev.idx + 1 : 0;
  // Chaining means "open on the previous block's final frame", which only
  // exists once that block has actually rendered. Pointing at an unrendered
  // block makes a job that cannot run: the storyboard path is safe because
  // those jobs depend on the parent pass, but a hand-made block has no such
  // guarantee, so it would fail at execution with nothing to fix it.
  const chainFrom = prev?.active_take_id ? prev.id : null;

  const { data: scenes } = await supabase.from("scenes")
    .select("id,idx").eq("storyboard_id", storyboard.id).order("idx");
  // scenes carries unique(storyboard_id, idx) — reusing the last index throws.
  const lastScene = (scenes ?? []).at(-1) as { idx: number } | undefined;
  const { data: scene, error: sErr } = await supabase.from("scenes").insert({
    storyboard_id: storyboard.id,
    idx: lastScene ? lastScene.idx + 1 : 0,
    slug: `Shot ${nextIdx + 1}`,
    duration_ms: durationMs,
    cast_ids: [],
    status: "draft",
    meta: { manual: true },
  }).select("id").single();
  if (sErr) throw sErr;
  const sceneId = (scene as { id: string }).id;

  const { error: bErr } = await supabase.from("beats").insert({
    scene_id: sceneId, idx: 0, duration_ms: durationMs,
    camera: opts.camera ?? "static", action: opts.action ?? "", meta: {},
  });
  if (bErr) throw bErr;

  const { data: beat } = await supabase.from("beats")
    .select("id").eq("scene_id", sceneId).order("idx").limit(1).single();

  const { data: block, error } = await supabase.from("generation_blocks").insert({
    storyboard_id: storyboard.id,
    idx: nextIdx,
    scene_ids: [sceneId],
    beat_ids: [(beat as { id: string }).id],
    t_start_ms: startMs,
    t_end_ms: startMs + durationMs,
    frames: plan.renderF,
    trim: { warmup_f: plan.warmupF, cooldown_f: plan.cooldownF, out_ms: plan.outMs },
    mode: "r2v",
    ref_plan: [],
    audio_mode: "native",
    // Set only when the previous block can actually supply a final frame; the
    // worker resolves the concrete asset at render time.
    chain_from_block_id: chainFrom,
    status: "planned",
    seed: Math.floor(Math.random() * 9000) + 1000,
    params: {},
  }).select("id").single();
  if (error) throw error;

  return { blockId: (block as { id: string }).id, sceneId, storyboardId: storyboard.id };
}

/** Attach an existing asset as a take to a block (e.g. from Asset Library). */
export async function addTakeToBlock(opts: {
  blockId: string;
  assetId: string;
  kind?: "master" | "patch" | "spliced" | "edit";
  activate?: boolean;
  clipId?: string;
}): Promise<BlockTake> {
  const { blockId, assetId, kind = "master", activate = false, clipId } = opts;
  const { data: take, error } = await supabase
    .from("block_takes")
    .insert({
      block_id: blockId,
      asset_id: assetId,
      kind,
      state: activate ? "kept" : "pending",
    })
    .select()
    .single();
  if (error) throw error;

  if (activate) {
    await supabase
      .from("generation_blocks")
      .update({ active_take_id: (take as BlockTake).id, status: "generated" })
      .eq("id", blockId);
    if (clipId) {
      // `take_id: null` because this IS the block's take now — a pin naming a
      // different one would make the clip that was just handed this take go on
      // playing the old one at the next sync, which is exactly the silence the
      // pin exists to remove, pointed the wrong way.
      useTimelineStore.getState().patchClip(clipId, { asset_id: assetId, take_id: null });
    }
  }

  return take as BlockTake;
}

/** Upload a local video or image file and attach it as a take to a block. */
export async function uploadAndAddTake(opts: {
  blockId: string;
  file: File;
  projectId?: string | null;
  activate?: boolean;
  clipId?: string;
  onProgress?: (pct: number) => void;
}): Promise<BlockTake> {
  const { blockId, file, projectId, activate = true, clipId, onProgress } = opts;
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || [".mp4"])[0].toLowerCase();
  const key = `takes/${crypto.randomUUID()}${ext}`;

  await uploadMedia(file, key, onProgress);

  const kind: AssetKind = file.type.startsWith("video/") ? "video" : "image";
  const asset = await registerAsset({
    b2_key: key,
    kind,
    project_id: projectId,
    content_type: file.type,
    bytes: file.size,
    origin: "uploaded",
    tags: ["library", "block-take"],
    meta: { original_name: file.name, block_id: blockId },
  });

  await enqueueJob({
    kind: "asset_ingest",
    lane: "cpu",
    priority: 60,
    payload: { asset_id: asset.id },
  });

  return addTakeToBlock({
    blockId,
    assetId: asset.id,
    activate,
    clipId,
  });
}


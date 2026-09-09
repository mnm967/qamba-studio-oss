/** Lore documents — the retrieval half of the story bible.
 *
 *  A bible ENTRY is a card: a name, a line, and (for people and places) the
 *  pictures that hold it. A lore DOCUMENT is prose at a length nobody wants as
 *  a card — a world bible, a treatment, a script, a wiki export. The two feed
 *  the director differently and deliberately:
 *
 *    entry  -> always in context. `worker/llm.py` flattens every bible row into
 *              the planner's `existing_bible`, and a lore entry's body rides
 *              along with it. Costs nothing, needs no credits, always present.
 *    doc    -> retrieved. Chunked here, embedded on the pod by the `embed` job,
 *              and pulled top-k by `llm.rag_search` when it is relevant to the
 *              brief. Scales to a 200-page bible that could never fit in a
 *              prompt.
 *
 *  Everything below this line already existed and had no way in: `rag_documents`
 *  has carried a 'lore' kind since the v2 director migration, `rag_chunks` +
 *  `match_rag_chunks` have been queryable the whole time, `worker/llm.py`'s
 *  `handle_embed` backfills embeddings for exactly this shape of row, and
 *  `rag_search` reads the result into every plan. Nothing in the browser had
 *  ever written one — the only writer was the RAG seeder, for the repo's
 *  own craft guides. This module is the missing middle, not new machinery.
 */
import { supabase } from "../supabase";
import { chunkText } from "../loreChunk";
import { USER_PRIORITY, enqueueJob } from "./jobs";
import type { Job } from "./types";

/** `rag_documents.kind`, minus `prompt_guide` — that one is the repo's own
 *  craft guides, seeded project-less by the RAG seeder, and offering it
 *  here would invite a project-scoped row that looks global and is not. */
export const LORE_DOC_KINDS = [
  { id: "lore", label: "Lore", hint: "World bible, history, factions, rules — the canon the director reasons from." },
  { id: "script", label: "Script", hint: "A screenplay or treatment. Retrieved for structure and voice, not copied." },
  { id: "style_guide", label: "Style guide", hint: "How the piece looks and sounds. Read alongside the project style." },
  { id: "reference", label: "Reference", hint: "Research, interviews, notes — background the story draws on." },
] as const;

export type LoreDocKind = (typeof LORE_DOC_KINDS)[number]["id"];

export interface LoreDoc {
  id: string;
  project_id: string | null;
  /** Which episode this document is about; null = series-wide. Entries
   *  extracted from it inherit this as their default timing, which is what
   *  makes per-fact tagging cheap enough to actually happen. */
  episode_id: string | null;
  kind: LoreDocKind;
  title: string;
  /** Provenance: `file:<name>`, `paste`, or `bible:<entry_id>` for the body of
   *  a lore entry mirrored into retrieval. */
  source: string | null;
  created_at: string;
  /** How many chunks the document was split into. */
  chunks: number;
  /** How many of them carry an embedding — i.e. are actually retrievable.
   *  Below `chunks` means the `embed` job hasn't finished (or hasn't started,
   *  because the pod is asleep). Surfacing the gap is the point: an
   *  unembedded document is invisible to the director and there is nothing
   *  else on screen that would say so. */
  embedded: number;
}

const SOURCE_FOR_ENTRY = (entryId: string) => `bible:${entryId}`;

/** Documents for one project, newest first, with their indexing progress.
 *
 *  The counts are aggregated in Postgres (`rag_chunk_counts`). They used to be
 *  two queries selecting `document_id` per chunk, tallied here — which pulled a
 *  row across the wire per chunk to render two numbers, and, worse, was cut off
 *  at PostgREST's 1000-row cap however large the `.limit()` (see ./paging), so
 *  a long enough import would have under-reported its own indexing progress
 *  with nothing to say so. Selecting `document_id` alone was at least right
 *  about one thing: `rag_chunks` carries a 1536-float vector per row, and
 *  `select("*")` here would be tens of megabytes. */
export async function loadLoreDocs(projectId: string): Promise<LoreDoc[]> {
  const { data, error } = await supabase
    .from("rag_documents")
    .select("id,project_id,episode_id,kind,title,source,created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const docs = (data ?? []) as Omit<LoreDoc, "chunks" | "embedded">[];
  if (!docs.length) return [];

  const ids = docs.map((d) => d.id);
  const { data: counts, error: cErr } = await supabase.rpc("rag_chunk_counts", { p_doc_ids: ids });
  if (cErr) throw cErr;
  const rows = (counts ?? []) as { document_id: string; chunks: number; embedded: number }[];
  const by = new Map(rows.map((r) => [
    r.document_id,
    { chunks: Number(r.chunks) || 0, embedded: Number(r.embedded) || 0 },
  ] as const));
  return docs.map((d) => ({
    ...d,
    chunks: by.get(d.id)?.chunks ?? 0,
    embedded: by.get(d.id)?.embedded ?? 0,
  }));
}

/** A document's chunks, for the reader panel. `embedding` is never selected —
 *  see loadLoreDocs. */
export async function loadDocChunks(
  docId: string, limit = 200,
): Promise<{ id: string; idx: number; content: string }[]> {
  const { data, error } = await supabase
    .from("rag_chunks").select("id,idx,content")
    .eq("document_id", docId).order("idx").limit(limit);
  if (error) throw error;
  return (data ?? []) as { id: string; idx: number; content: string }[];
}

export interface ImportResult {
  doc: { id: string; title: string };
  chunks: number;
  job: Job | null;
}

/** Chunk text, store it, and queue the embedding pass.
 *
 *  `owner_id` and `project_id` on the chunks are left to the `set_row_owner`
 *  trigger, which walks chunk -> document -> project. Passing them would be the
 *  one thing the accounts design explicitly forbids ("owner_id is DERIVED,
 *  never passed"), and getting it wrong writes a row into someone else's tree.
 *
 *  A failure part-way through deletes the document rather than leaving a
 *  half-chunked one: `rag_chunks` cascades from `rag_documents`, and a document
 *  showing "12 of 40 chunks" that will never reach 40 is worse than an import
 *  that visibly did not happen. */
export async function importLoreDoc(opts: {
  projectId: string;
  title: string;
  text: string;
  kind?: LoreDocKind;
  source?: string;
  /** Which episode this document is about. Null/omitted = series-wide, and
   *  entries extracted from it come out evergreen — right for a series bible,
   *  wrong for an episode script, which is why the import asks. */
  episodeId?: string | null;
}): Promise<ImportResult> {
  const pieces = chunkText(opts.text);
  if (!pieces.length) throw new Error("nothing to import — the document is empty");

  const { data: doc, error } = await supabase.from("rag_documents").insert({
    project_id: opts.projectId,
    kind: opts.kind ?? "lore",
    title: opts.title.trim().slice(0, 200) || "Untitled document",
    source: opts.source ?? null,
    episode_id: opts.episodeId ?? null,
  }).select("id,title").single();
  if (error) throw error;
  const row = doc as { id: string; title: string };

  try {
    // Batched: a long bible is thousands of chunks and one insert of all of
    // them is a request body no proxy is happy with.
    for (let i = 0; i < pieces.length; i += 200) {
      const batch = pieces.slice(i, i + 200).map((content, j) => ({
        document_id: row.id, idx: i + j, content,
        meta: { source: opts.source ?? null },
      }));
      const { error: cErr } = await supabase.from("rag_chunks").insert(batch);
      if (cErr) throw cErr;
    }
  } catch (e) {
    await supabase.from("rag_documents").delete().eq("id", row.id);
    throw e;
  }

  // Embedding is a jobs row like every other piece of work: it is one call to
  // an embeddings endpoint on the user's own OpenAI key, made by the bundled
  // Python (`llm.handle_embed`) when the worker claims it.
  let job: Job | null = null;
  try {
    job = await enqueueJob({
      kind: "embed", lane: "local", priority: USER_PRIORITY, project_id: opts.projectId,
      payload: {
        document_id: row.id,
        label: `${row.title} · index ${pieces.length} chunk${pieces.length === 1 ? "" : "s"}`,
      },
    });
  } catch (e) {
    // The text is stored and re-indexable; only the queueing failed. Say so
    // rather than rolling back work the user can see.
    console.warn("lore import: embed job not queued", (e as Error).message);
  }
  // Nothing is woken: this machine's own worker polls the queue every couple
  // of seconds and will claim it. The import is finished and the document is
  // on screen either way.
  return { doc: row, chunks: pieces.length, job };
}

/** Re-queue embedding for a document whose chunks never got vectors — the pod
 *  was asleep when it was imported, or the key was out of quota. `handle_embed`
 *  only touches chunks where `embedding is null`, so this is safe to press
 *  twice and cheap when it is already done. */
export async function reindexLoreDoc(doc: LoreDoc): Promise<Job> {
  const job = await enqueueJob({
    kind: "embed", lane: "local", priority: USER_PRIORITY,
    project_id: doc.project_id ?? undefined,
    payload: {
      document_id: doc.id,
      label: `${doc.title} · re-index ${doc.chunks - doc.embedded} chunk${
        doc.chunks - doc.embedded === 1 ? "" : "s"}`,
    },
  });
  return job;
}

/** Re-scope a document to an episode (or to the series, with null).
 *
 *  Only affects what is extracted from it NEXT — entries already proposed keep
 *  the timing they were given, because they may have been corrected by hand
 *  since, and silently rewriting a human's retcon decision from a document-level
 *  default is exactly the kind of edit nobody would think to look for. */
export async function setLoreDocEpisode(id: string, episodeId: string | null): Promise<void> {
  const { error } = await supabase.from("rag_documents")
    .update({ episode_id: episodeId }).eq("id", id);
  if (error) throw error;
}

export async function deleteLoreDoc(id: string): Promise<void> {
  const { error } = await supabase.from("rag_documents").delete().eq("id", id);
  if (error) throw error;
}

/** Below this, an entry's body is NOT mirrored into retrieval: it already
 *  reaches the planner in full (worker/llm.py's `lore_context` inlines lore
 *  bodies to a budget), so indexing it would spend embedding credits to add a
 *  second copy of something already in the prompt.
 *
 *  Exported because the UI has to say the same thing the code does — a form
 *  promising "queues this for indexing" under a body that will be skipped is a
 *  lie the user has no way to check. */
export const LORE_INDEX_MIN_CHARS = 400;

/** Mirror a lore ENTRY's body into retrieval.
 *
 *  The entry stays the source of truth — this is a derived copy, replaced
 *  wholesale on every save (matched by `source`), never merged. Merging would
 *  leave chunks of deleted paragraphs retrievable forever, which reads as the
 *  director quoting canon that was edited out.
 *
 *  Returns null for a body under LORE_INDEX_MIN_CHARS — see above. */
export async function indexEntryBody(opts: {
  entryId: string;
  projectId: string;
  title: string;
  body: string;
}): Promise<ImportResult | null> {
  const source = SOURCE_FOR_ENTRY(opts.entryId);
  await supabase.from("rag_documents").delete()
    .eq("project_id", opts.projectId).eq("source", source);
  if (opts.body.trim().length < LORE_INDEX_MIN_CHARS) return null;
  return importLoreDoc({
    projectId: opts.projectId, title: opts.title, text: opts.body,
    kind: "lore", source,
  });
}

/** Whether an entry's body is currently mirrored into retrieval, and how far
 *  the indexing got. */
export async function entryIndexState(
  entryId: string, projectId: string,
): Promise<{ chunks: number; embedded: number } | null> {
  const { data } = await supabase.from("rag_documents")
    .select("id").eq("project_id", projectId).eq("source", SOURCE_FOR_ENTRY(entryId)).maybeSingle();
  const doc = data as { id: string } | null;
  if (!doc) return null;
  // Aggregated, not counted here — same cap, same silence as loadLoreDocs.
  const { data: counts, error } = await supabase.rpc("rag_chunk_counts", { p_doc_ids: [doc.id] });
  if (error) throw error;
  const row = ((counts ?? []) as { chunks: number; embedded: number }[])[0];
  return { chunks: Number(row?.chunks) || 0, embedded: Number(row?.embedded) || 0 };
}

/** Ask the director to read a document and propose bible entries for it.
 *
 *  Queued rather than run here because it is an LLM pass over the whole
 *  document, and the browser holds no provider credentials (invariant #4). The
 *  result is DRAFTS — same contract as every other thing the director proposes
 *  about the bible — so a 60-page import cannot silently fill the Bible with
 *  entries nobody read.
 *
 *  `backend` and `llm_model` are set TOGETHER and explicitly: `pick_backend`
 *  falls through to claude-oauth whenever the token is set, while `llm_model`
 *  independently defaults to an OpenAI name, so sending one without the other
 *  asks Anthropic for `gpt-5.6-terra` and dies on a 404 that no fallback chain
 *  covers. */
export async function queueLoreExtract(opts: {
  doc: LoreDoc;
  projectId: string;
  backend?: string;
  model?: string;
}): Promise<Job> {
  return enqueueJob({
    kind: "llm_task", lane: "llm", priority: USER_PRIORITY, project_id: opts.projectId,
    payload: {
      task: "extract_lore",
      document_id: opts.doc.id,
      project_id: opts.projectId,
      backend: opts.backend ?? "openai-compat",
      llm_model: opts.model ?? "gpt-5.6-terra",
      label: `${opts.doc.title} · extract entries`,
    },
  });
}

/** The entries one document proposed and nobody has ruled on yet.
 *
 *  `extract_lore` stamps `doc.from_document` on everything it writes, which is
 *  what makes a proposal traceable back to the document that made it — without
 *  that these would land in the Lore tab as anonymous drafts mixed in with
 *  hand-written ones, and "which of these did the director just invent?" would
 *  have no answer.
 *
 *  Drafts only: once confirmed, an entry is canon and belongs with the rest of
 *  the bible, not in a review list that keeps asking about it. */
export async function loadProposedEntries(
  projectId: string, docId: string,
): Promise<{ id: string; name: string; summary: string | null; body: string }[]> {
  const { data, error } = await supabase
    .from("bible_entries")
    .select("id,name,summary,doc")
    .eq("project_id", projectId).eq("kind", "lore").eq("status", "draft")
    .eq("doc->>from_document", docId)
    .order("created_at");
  if (error) throw error;
  return ((data ?? []) as { id: string; name: string; summary: string | null;
                           doc: { body?: unknown } }[])
    .map((e) => ({
      id: e.id, name: e.name, summary: e.summary,
      body: typeof e.doc?.body === "string" ? e.doc.body : "",
    }));
}

/** How many proposals are outstanding per document, for the shelf badge. One
 *  query for the whole project — a per-row count would be a request per
 *  document on every render of the Lore tab. */
export async function loadProposalCounts(projectId: string): Promise<Map<string, number>> {
  const { data } = await supabase
    .from("bible_entries").select("doc")
    .eq("project_id", projectId).eq("kind", "lore").eq("status", "draft")
    .limit(500);
  const out = new Map<string, number>();
  for (const e of (data ?? []) as { doc: { from_document?: unknown } }[]) {
    const src = e.doc?.from_document;
    if (typeof src === "string") out.set(src, (out.get(src) ?? 0) + 1);
  }
  return out;
}

/** The extract jobs in flight for a project, so the shelf can show a document
 *  as busy instead of looking inert for the minute the pass takes. */
export async function loadExtractJobs(projectId: string): Promise<
  { id: string; status: string; progress: number | null; progress_note: string | null;
    error_msg: string | null; document_id: string; kind: string; task: string | null }[]
> {
  const { data } = await supabase.from("jobs")
    .select("id,kind,status,progress,progress_note,error_msg,payload")
    .eq("project_id", projectId).in("kind", ["llm_task", "embed"])
    // `done` is included so a finished extract can be told apart from one that
    // never ran — "proposed nothing" and "you haven't pressed it yet" are
    // different states and the panel says different things about them.
    .in("status", ["queued", "running", "error", "failed", "done"])
    .order("created_at", { ascending: false }).limit(40);
  return ((data ?? []) as {
    id: string; kind: string; status: string; progress: number | null;
    progress_note: string | null; error_msg: string | null;
    payload: { document_id?: string; task?: string };
  }[])
    .filter((j) => !!j.payload?.document_id)
    .map((j) => ({ ...j, document_id: j.payload.document_id as string,
                   task: j.payload.task ?? null }));
}

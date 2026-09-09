/** Splitting a lore document into retrievable chunks.
 *
 *  This is the browser twin of the RAG seeder's `chunk()`, and it has to
 *  stay one: both write into the same `rag_chunks` table, both are retrieved by
 *  the same `match_rag_chunks`, and a corpus chunked two different ways
 *  retrieves unevenly — the repo's craft guides would answer at a paragraph's
 *  resolution while a user's world bible answered at a chapter's, with no way
 *  to tell from the results which had happened.
 *
 *  Dependency-free on purpose so `node --test` can run it without a Supabase
 *  client or React (same reasoning as hooks/realtimeTables.ts).
 *
 *  ONE deliberate difference from the Python, and it is about who writes the
 *  input. seed_rag.py reads `director/knowledge/*.md` — curated markdown with
 *  blank lines between paragraphs, so "pack paragraphs to ~1100 chars" always
 *  terminates somewhere sensible. An imported document is whatever the user
 *  had: a script exported without blank lines, or prose pasted out of a word
 *  processor as one 40KB run. The Python emits such a paragraph as a single
 *  chunk, and that fails in two ways at once — it retrieves uselessly (one
 *  embedding for the whole document) and, past ~8191 tokens, the embeddings
 *  endpoint rejects it outright, so the `embed` job fails and the import is
 *  silently unsearchable. Hence CHUNK_MAX below.
 */

/** Target chunk size in characters. Matches seed_rag.py's CHUNK_TARGET. */
export const CHUNK_TARGET = 1100;

/** Hard ceiling. A paragraph longer than this is split rather than emitted
 *  whole — see the header. ~4000 chars is ~1000 tokens, comfortably inside
 *  text-embedding-3-small's window with room for the packing above it. */
export const CHUNK_MAX = 4000;

/** Sentence-ish boundaries, preferred over cutting mid-word. */
const SENTENCE_END = /(?<=[.!?…]["')\]]?)\s+/;

/** Split one oversized paragraph into <= CHUNK_MAX pieces, preferring sentence
 *  boundaries and falling back to a hard character cut for text that has none
 *  (a table, a long list, a language this regex doesn't punctuate). */
function splitLong(para: string): string[] {
  if (para.length <= CHUNK_MAX) return [para];
  const out: string[] = [];
  let cur = "";
  for (const piece of para.split(SENTENCE_END)) {
    // A single sentence over the ceiling: cut it by characters. Rare, but the
    // alternative is emitting the thing this function exists to prevent.
    if (piece.length > CHUNK_MAX) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < piece.length; i += CHUNK_MAX) out.push(piece.slice(i, i + CHUNK_MAX));
      continue;
    }
    if (cur && cur.length + 1 + piece.length > CHUNK_MAX) { out.push(cur); cur = ""; }
    cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

/** Greedy paragraph packing to ~CHUNK_TARGET chars.
 *
 *  A trailing header never ends a chunk — it stays with the paragraph that
 *  follows it, so a retrieval hit carries the section it belongs to rather
 *  than arriving as an orphaned heading. (Same rule as the Python.) */
export function chunkText(text: string): string[] {
  const paras = String(text ?? "")
    .split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .flatMap(splitLong);
  const chunks: string[] = [];
  let cur: string[] = [];

  const flush = () => {
    if (cur.length) { chunks.push(cur.join("\n\n")); cur = []; }
  };

  for (const p of paras) {
    const size = cur.reduce((n, x) => n + x.length, 0);
    if (cur.length && size + p.length > CHUNK_TARGET && !cur[cur.length - 1].startsWith("#")) flush();
    cur.push(p);
  }
  flush();
  return chunks;
}

/** The document's own title, by the same rule seed_rag.py uses: the first
 *  markdown H1, else the filename with its extension dropped. Users name files
 *  `world-bible-v3-FINAL.md` and title them properly on line 1; taking the
 *  heading when there is one is what makes an import land with a readable name
 *  instead of a slug nobody edits afterwards. */
export function titleFromText(text: string, filename?: string): string {
  const h1 = /^#\s+(.+)$/m.exec(String(text ?? ""));
  if (h1) return h1[1].trim().slice(0, 200);
  const base = (filename ?? "").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return (base || "Untitled document").slice(0, 200);
}

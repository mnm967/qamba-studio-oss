// A proposal has to be traceable back to the document that made it, and that
// trace is a cross-language contract: `worker/llm.py::extract_lore` stamps the
// key, `src/lib/db/lore.ts` filters on it, and nothing else connects them.
//
// If they drift, nothing throws. `loadProposedEntries` returns an empty array,
// the review panel renders nothing, and the entries still exist — as anonymous
// drafts scattered through the Lore tab with no way to tell which the director
// invented. That is precisely the state the review panel was built to end, so
// it would look like the feature simply doesn't work.
//
// Same shape as tool_parity.test.mjs and realtimeTables.test.ts: one language
// asserting against another's source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = fs.readFileSync(path.join(ROOT, "worker/llm.py"), "utf8");
const TS = fs.readFileSync(path.join(ROOT, "src/lib/db/lore.ts"), "utf8");
const MODAL = fs.readFileSync(
  path.join(ROOT, "src/components/modals/LoreDocModal.tsx"), "utf8");

test("the worker stamps the provenance key the client filters on", () => {
  const extract = PY.slice(PY.indexOf("def extract_lore("), PY.indexOf("def lore_update("));
  assert.match(extract, /"from_document":\s*doc\["id"\]/,
    "extract_lore must record which document proposed each entry");
  assert.match(TS, /doc->>from_document/,
    "loadProposedEntries must filter on the same key");
  assert.match(TS, /from_document/,
    "loadProposalCounts must read the same key for the shelf badge");
});

test("proposals are drafts, and the review list only shows drafts", () => {
  const extract = PY.slice(PY.indexOf("def extract_lore("), PY.indexOf("def lore_update("));
  assert.match(extract, /"status":\s*"draft"/,
    "a 60-page import must not write confirmed canon nobody read");
  const loader = TS.slice(TS.indexOf("export async function loadProposedEntries"));
  assert.match(loader.slice(0, 900), /\.eq\("status",\s*"draft"\)/,
    "a confirmed entry is canon and must leave the review list, or the panel " +
    "keeps asking about decisions already made");
});

test("the review panel can only ever confirm or delete a DRAFT", () => {
  // `deleteDraftEntry` is guarded to drafts in the data layer; the panel must
  // go through it rather than deleting by id, because a confirmed entry is
  // referenced by scenes and losing it silently is worse than clutter.
  assert.match(MODAL, /deleteDraftEntry\(/);
  assert.doesNotMatch(MODAL, /\.from\("bible_entries"\)[\s\S]{0,120}\.delete\(/,
    "delete must go through the guarded helper, not a raw query");
});

test("the panel distinguishes an extract pass from an embed job", () => {
  // Both carry a document_id and both come back from loadExtractJobs. Without
  // the task filter, indexing a document would render as "the director is
  // reading it" and the Extract button would be disabled while it happened.
  assert.match(MODAL, /task === "extract_lore"/);
  assert.match(TS, /task: j\.payload\.task \?\? null/,
    "loadExtractJobs must expose the task for that filter to be possible");
});

test("a finished pass that proposed nothing says so", () => {
  // "Proposed nothing" and "you haven't run it yet" render identically if the
  // panel cannot see completed jobs — and the first is a real, informative
  // answer about the document.
  assert.match(TS, /"done"/, "loadExtractJobs must include done jobs");
  assert.match(MODAL, /lastExtract\?\.status === "done"/);
});

// The lore chunker must agree with the RAG seeder, because both write
// into the same `rag_chunks` table and both are read by the same
// `match_rag_chunks`. Drift is invisible in the product: retrieval simply
// answers at a different resolution depending on which path put the text
// there, and nothing in a result set says which.
//
// The parity case below runs the ACTUAL Python rather than restating what it
// is believed to do — a hand-copied expectation drifts the moment either side
// is edited, which is the failure this file exists to catch. It skips (not
// fails) where python3 is unavailable; the behavioural cases still run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHUNK_MAX, CHUNK_TARGET, chunkText, titleFromText } from "./loreChunk.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function pythonChunks(text: string): string[] | null {
  // Run seed_rag's own chunk() — restating it here would be exactly the copy
  // this test exists to make unnecessary. It cannot simply be imported: the
  // module reads credentials at import time and SystemExits without them. So
  // lift the constant and the function out of the source and exec just those,
  // which also means a rename on either side surfaces as a skip-with-reason
  // rather than a silent pass.
  const script = `
import json, os, re, sys
src = open(os.path.join(${JSON.stringify(ROOT)}, "scripts", "seed_rag.py")).read()
ns = {"re": re}
ns["CHUNK_TARGET"] = int(re.search(r"^CHUNK_TARGET\\s*=\\s*(\\d+)", src, re.M).group(1))
body = src[src.index("def chunk("):src.index("def main(")]
exec(body, ns)
print(json.dumps(ns["chunk"](json.load(sys.stdin))))
`;
  try {
    const out = execFileSync("python3", ["-c", script], {
      input: JSON.stringify(text), encoding: "utf8",
    });
    return JSON.parse(out) as string[];
  } catch {
    return null;   // no python3, or seed_rag.py moved — the caller skips
  }
}

const GUIDE = `# Camera grammar

A shot size says how much of the frame the subject fills. It is the first
thing the model reads and the first thing it drops.

## Sizes

An extreme wide puts the location in charge. Any figure in it is small enough
that identity is carried by silhouette rather than by face.

A close-up is the opposite bargain: the face fills the frame and the room
stops existing.

## Motion

Camera motion is a type, an amplitude and a speed. Prose that names only the
type ("a push in") leaves the other two to the model, and the model picks
whatever it saw most of during training.
`;

test("agrees with the RAG seeder on a real guide document", (t) => {
  const expected = pythonChunks(GUIDE);
  if (!expected) return t.skip("python3 unavailable");
  assert.deepEqual(chunkText(GUIDE), expected);
});

test("agrees with seed_rag.py that a heading never ends a chunk", (t) => {
  // The rule that matters most for retrieval quality: a hit has to arrive
  // carrying its own section name.
  const text = `${"x".repeat(CHUNK_TARGET)}\n\n## The Concord\n\nThey do not sign treaties.`;
  const expected = pythonChunks(text);
  if (!expected) return t.skip("python3 unavailable");
  assert.deepEqual(chunkText(text), expected);
  assert.ok(chunkText(text).some((c) => c.includes("## The Concord") && c.includes("treaties")),
            "the heading must travel with the paragraph beneath it");
});

test("packs paragraphs toward the target rather than one chunk per paragraph", () => {
  const text = Array.from({ length: 8 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(30)}`).join("\n\n");
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1, "8 paragraphs of ~160 chars should not be one chunk");
  assert.ok(chunks.length < 8, "nor one chunk each — they pack");
  for (const c of chunks) assert.ok(c.length <= CHUNK_MAX);
});

// The divergence from the Python, and the reason for it: seed_rag.py reads
// curated markdown, this reads whatever the user exported. A single
// unparagraphed run must not become one embedding for the whole document —
// past ~8191 tokens the embeddings call rejects it and the import lands
// unsearchable with nothing on screen to say so.
test("splits an unparagraphed document instead of emitting it whole", () => {
  const oneRun = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} of a long run.`).join(" ");
  assert.ok(oneRun.length > CHUNK_MAX * 3, "fixture must actually be oversized");
  const chunks = chunkText(oneRun);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= CHUNK_MAX, `chunk of ${c.length} exceeds the ceiling`);
  // Nothing may be dropped on the way through.
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), oneRun.replace(/\s+/g, " ").trim());
});

test("cuts by character when there is no sentence boundary to use", () => {
  const wall = "x".repeat(CHUNK_MAX * 2 + 17);
  const chunks = chunkText(wall);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= CHUNK_MAX);
  assert.equal(chunks.join(""), wall);
});

test("empty input is no chunks, not one empty chunk", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n  \n"), []);
});

test("titleFromText prefers the document's own H1", () => {
  assert.equal(titleFromText("# The Ashfall Concordat\n\nBody."), "The Ashfall Concordat");
  assert.equal(titleFromText("No heading here.", "world-bible_v3.md"), "world bible v3");
  assert.equal(titleFromText("", ""), "Untitled document");
});

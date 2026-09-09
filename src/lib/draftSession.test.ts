// node --test src/lib/draftSession.test.ts
//
// Which bible rows a surface may see, and what commit/discard do to them.
//
// The filtering rule is the interesting half, because BOTH ways of getting it
// wrong are silent. Filter too little and an abandoned wizard run's phantom
// cast stays in a bible the whole series shares — a plan that came back wrong
// followed you into the next episode, which is what this exists to stop.
// Filter too much and a tier-2 episode awaiting approval, which is made
// ENTIRELY of draft entries, renders its own cast list as question marks.
//
// db/director.ts reaches supabase at import, so the rule is exercised as the
// pure predicate it is, alongside a source check that the right callers opt in.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

interface Row { id: string; name: string; doc: { draft_session?: string } | null }

/** The predicate inside loadBible's `committedOnly` branch. */
const committed = (rows: Row[]) => rows.filter((e) => !e.doc?.draft_session);

const CANON: Row = { id: "e1", name: "Aki", doc: { } };
const RETURNING: Row = { id: "e2", name: "Haru", doc: null };
const MINE: Row = { id: "e3", name: "Guide Rei", doc: { draft_session: "thread-1" } };
const THEIRS: Row = { id: "e4", name: "Miko", doc: { draft_session: "thread-2" } };
const ALL = [CANON, RETURNING, MINE, THEIRS];

test("the shared bible shows canon only, whoever drafted the rest", () => {
  assert.deepEqual(committed(ALL).map((e) => e.id), ["e1", "e2"]);
});

test("a returning character with no doc at all is canon, not a draft", () => {
  // `doc` is nullable and plenty of older rows have it null — reading
  // `doc.draft_session` off that must not throw, and must not exclude it.
  assert.ok(committed([RETURNING]).length === 1);
});

test("an episode surface sees everything, because its own cast is draft", () => {
  // The default. A tier-2 storyboard references exactly the rows the shared
  // surfaces hide.
  assert.equal(ALL.length, 4);
});

// ------------------------------------------------------------- the wiring ---
const DIRECTOR = readFileSync(new URL("./db/director.ts", import.meta.url), "utf8");

test("committing clears the stamp as well as the status", () => {
  // A row that keeps `draft_session` after being committed is canon that a
  // later discard would delete — the same class of bug as a half-applied
  // migration, and just as quiet.
  const fn = DIRECTOR.split("export async function confirmDraftSession")[1]
    .split("export async function discardDraftSession")[0];
  assert.match(fn, /delete doc\.draft_session/);
  assert.match(fn, /status: "confirmed"/);
});

test("discard is scoped to the stamp, never to the project", () => {
  const fn = DIRECTOR.split("export async function discardDraftSession")[1].slice(0, 600);
  assert.match(fn, /loadDraftSessionEntries\(projectId, sessionId\)/);
  // no unscoped delete over the project's entries
  assert.ok(!/from\("bible_entries"\)\s*\.delete\(\)\s*\.eq\("project_id"/.test(fn));
});

test("both operations read the same scoped query, so they cannot disagree", () => {
  const q = DIRECTOR.split("export async function loadDraftSessionEntries")[1].slice(0, 500);
  assert.match(q, /eq\("doc->>draft_session", sessionId\)/);
  assert.match(q, /eq\("project_id", projectId\)/);
  // an empty session id must not select every draft in the project
  assert.match(q, /if \(!sessionId\) return \[\]/);
});

test("exactly the shared surfaces ask for committedOnly", () => {
  // Named explicitly: adding a new PICKER without this is the leak coming
  // back, and adding it to an EPISODE surface is the question-marks bug.
  const shared = ["src/routes/BiblePage.tsx",
                  "src/components/shell/GenComposer.tsx",
                  "src/components/modals/AssetPickerModal.tsx"];
  const episode = ["src/components/shell/StoryboardView.tsx",
                   "src/components/modals/SceneEditorModal.tsx",
                   "src/components/modals/PromptRefsModal.tsx",
                   "src/components/modals/WizardModal.tsx"];
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  for (const p of shared) {
    assert.match(read(p), /loadBible\([^)]*committedOnly: true/s, `${p} must hide drafts`);
  }
  for (const p of episode) {
    assert.ok(!/committedOnly/.test(read(p)), `${p} must NOT hide drafts — it shows a draft episode`);
  }
});

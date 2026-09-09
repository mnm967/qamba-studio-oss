// The ownership graph has to terminate, and every table has to be in it.
//
// `owner_id` is derived by walking a row's foreign keys up to a root, so the
// whole isolation model rests on one jsonb map inside the accounts migration.
// Both ways of getting that map wrong are invisible at runtime:
//
//  - a parent named that is not itself an owned table (a typo, or a table
//    someone forgot to add) makes `select owner_id from <parent>` fail — the
//    trigger raises, and it raises on INSERT, so a whole feature stops writing;
//  - a table left out of `neon_owned_tables()` gets no owner_id column, no
//    policies and no trigger. It keeps whatever policy it had, which for
//    everything created before accounts is `using (true)` — i.e. it stays
//    readable and writable by every account in the studio, and nothing about
//    the UI says so.
//
// A new table is therefore a migration PLUS a line in the owned list (or the
// shared list below), and this test is what says so out loud.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const ACCOUNTS = path.join(MIGRATIONS, "20260812190000_accounts.sql");

/** Tables that deliberately have no owner because they are shared
 *  infrastructure, plus the account tables themselves (scoped by `id`/`email`,
 *  not by `owner_id`). Kept here rather than derived: leaving a table out of
 *  the owned list must be a decision someone wrote down. */
const SHARED = new Set([
  "model_catalog", "pod_status", "job_timings", "profiles", "allowed_emails",
  // The grant table itself. Not owner-scoped by design: its policies are
  // written the other way round — the project's OWNER manages the row, and the
  // grantee may read and delete their own. An `owner_id` here would be a
  // second, competing answer to the same question.
  "project_shares",
  // Studio-wide curation, like `model_catalog` next to it: which adapters and
  // which models a member may pick. Admin-only both ways, so nobody owns a row.
  "lora_visibility",
  "model_visibility",
  // BYOK keys shared with the render pod. Scoped by `owner_id` like an owned
  // table, and deliberately NOT in `neon_owned_tables()`: that list drives the
  // `set_row_owner` trigger, which DERIVES an owner by walking a row's FKs up
  // to a project — and this row has no project. Its owner is `auth.uid()` at
  // the moment of sharing, set inside `byok_share_key`, and there is no INSERT
  // policy at all so a client can never choose it. It is also never shared
  // with a collaborator, which is the whole point of it.
  "byok_pod_keys",
  // One row, studio-wide: the settings a release should not have to redeploy
  // for (today, when the open beta's Pro grant ends). Nobody owns it — it is
  // readable by anyone signed in because the app states the date, and writable
  // by admins only. Owner-scoping a singleton is a contradiction.
  "app_config",
]);

/** v1 tables, created by hand years before this migrations directory existed
 *  (the realtime backfill migration is the only place they are named). */
const V1 = new Set(["jobs", "episodes", "shots", "takes", "references_", "series", "voices", "pod_status"]);

const sql = fs.readFileSync(ACCOUNTS, "utf8");

/** The `neon_owned_tables()` body. */
function ownedTables(): string[] {
  const fn = /create or replace function public\.neon_owned_tables\(\)[\s\S]*?select array\[([\s\S]*?)\]/i
    .exec(sql);
  assert.ok(fn, "neon_owned_tables() not found in the accounts migration");
  return [...fn[1].matchAll(/'([a-z_][a-z0-9_]*)'/gi)].map((m) => m[1]);
}

/** The parent map: child -> [parent, fk, parent, fk, …]. */
function parentMap(): Record<string, string[]> {
  const block = /spec jsonb :=\s*\$j\$([\s\S]*?)\$j\$/i.exec(sql);
  assert.ok(block, "the parent map ($j$…$j$) not found in the accounts migration");
  return JSON.parse(block[1]) as Record<string, string[]>;
}

test("every owned table is either a root or has a parent chain", () => {
  const owned = new Set(ownedTables());
  const spec = parentMap();
  // The only tables allowed to have no parent: a project and a v1 series are
  // what a person creates directly, and their owner is whoever inserted them.
  const ROOTS = new Set(["projects", "series"]);
  const stranded = [...owned]
    .filter((t) => !ROOTS.has(t) && !spec[t])
    .sort();
  assert.deepEqual(stranded, [],
    "owned but with no parent chain — these rows can only ever be owned by "
    + "auth.uid(), so anything the WORKER inserts into them is unowned and invisible");
});

test("every parent named in the map is itself an owned table", () => {
  const owned = new Set(ownedTables());
  const spec = parentMap();
  const bad: string[] = [];
  for (const [child, chain] of Object.entries(spec)) {
    assert.equal(chain.length % 2, 0, `${child}: chain must be (table, column) pairs`);
    for (let i = 0; i < chain.length; i += 2) {
      if (!owned.has(chain[i])) bad.push(`${child} -> ${chain[i]}`);
    }
  }
  assert.deepEqual(bad.sort(), [],
    "a parent with no owner_id column — the trigger's lookup raises on INSERT");
});

test("every table the map mentions as a child is in the owned list", () => {
  const owned = new Set(ownedTables());
  const orphanChildren = Object.keys(parentMap()).filter((t) => !owned.has(t)).sort();
  assert.deepEqual(orphanChildren, [],
    "has a parent chain but no owner_id column — the trigger is never installed");
});

test("every table the migrations create is owned or explicitly shared", () => {
  const owned = new Set(ownedTables());
  const created = new Set<string>();
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const body = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    // `public.` is optional in these migrations and both spellings appear.
    // Without the qualifier group the scanner extracts the SCHEMA and reports
    // a table called "public" — which is what it did the first time a
    // schema-qualified `create table` landed here.
    for (const m of body.matchAll(
      /create table (?:if not exists )?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      created.add(m[1]);
    }
  }
  const uncovered = [...created].filter((t) => !owned.has(t) && !SHARED.has(t)).sort();
  assert.deepEqual(uncovered, [],
    "a table with neither an owner nor a documented reason not to have one — "
    + "it keeps its `using (true)` policy and is visible to every account");
});

test("the v1 tables are covered too — the legacy studio still holds the catch-all route", () => {
  const owned = new Set(ownedTables());
  const missed = [...V1].filter((t) => !owned.has(t) && !SHARED.has(t)).sort();
  assert.deepEqual(missed, [], "v1 table left unscoped");
});

// --- sharing --------------------------------------------------------------
//
// The share policies read ONE column, `project_id`, on every owned table. A
// table that never gets it scoped is not an error anywhere — it just silently
// stays owner-only, so a collaborator opens a shared project and finds that
// one thing (its takes, its reviews, its clips) mysteriously empty.
const SHARES = fs.readFileSync(path.join(MIGRATIONS, "20260813090000_project_shares.sql"), "utf8");

/** Tables the backfill has to touch: owned, not `projects` (its id IS the
 *  scope), and not one that already carried a project_id before sharing. */
const ALREADY_SCOPED = new Set([
  "episodes", "assets", "jobs", "cost_ledger", "collections", "chat_threads",
  "bible_entries", "rag_documents",
  // Created AFTER sharing shipped, with `project_id` in its own CREATE TABLE
  // and its own policies in its own migration — so there is nothing for the
  // share migration's backfill to find, and demanding a line there would mean
  // editing a migration that has already run to no effect. Any table added
  // from here on lands in this set for the same reason; what still has to be
  // true of it is the four policies, which the accounts-migration test below
  // and the table's own migration cover.
  "custom_workflows", "voice_clones",
  // Created after sharing shipped, so they carry `project_id` from their own
  // CREATE TABLE and have no pre-existing rows to bring into scope.
  "film_shares", "product_events",
]);
/** Series-rooted v1 tables: no project exists above them, so they are
 *  deliberately never shareable. */
const NEVER_SCOPED = new Set(["series", "references_", "voices"]);

test("every owned table that can be scoped is backfilled by the share migration", () => {
  const owned = ownedTables();
  const backfilled = new Set(
    [...SHARES.matchAll(/update\s+([a-z_][a-z0-9_]*)\s+\w*\s*set project_id/gi)].map((m) => m[1]),
  );
  const missing = owned
    .filter((t) => t !== "projects" && !ALREADY_SCOPED.has(t) && !NEVER_SCOPED.has(t))
    .filter((t) => !backfilled.has(t))
    .sort();
  assert.deepEqual(missing, [],
    "gains a project_id column but nothing fills it for existing rows — every "
    + "pre-existing row of these is out of scope, so a share shows them empty");
});

test("take_reviews is backfilled by BOTH of its parents", () => {
  // A sequence_review has no block_id — it judges the assembled cut and hangs
  // off the storyboard. Following only the block left 32 of 296 unscoped.
  const viaBlock = /update take_reviews\s+\w*\s*set project_id[\s\S]{0,160}?generation_blocks/i.test(SHARES);
  const viaStoryboard = /update take_reviews\s+\w*\s*set project_id[\s\S]{0,160}?storyboards/i.test(SHARES);
  assert.ok(viaBlock, "take_reviews not backfilled from generation_blocks");
  assert.ok(viaStoryboard,
    "take_reviews not backfilled from storyboards — sequence_review rows (block_id null) stay unscoped");
});

test("the share migration scopes reads to viewers and writes to editors", () => {
  assert.match(SHARES, /shared_projects\('viewer'\)/, "no viewer read clause");
  assert.match(SHARES, /shared_projects\('editor'\)/, "no editor write clause");
  // The dangerous inversion: a viewer clause on an INSERT/UPDATE/DELETE would
  // make every reader an editor.
  for (const m of SHARES.matchAll(/for (insert|update|delete)[\s\S]{0,220}?shared_projects\('(\w+)'\)/gi)) {
    assert.equal(m[2], "editor",
      `a ${m[1]} policy admits '${m[2]}' shares — writes must require 'editor'`);
  }
});

test("the accounts migration leaves no open policy on an owned table", () => {
  // `using (true)` is how every pre-accounts policy was written. It is still
  // correct for the shared tables and nowhere else.
  const openPolicies = [...sql.matchAll(
    /create policy ([a-z_][a-z0-9_]*) on ([a-z_][a-z0-9_]*)[\s\S]{0,200}?using \(true\)/gi)];
  const bad = openPolicies.map((m) => m[2]).filter((t) => !SHARED.has(t)).sort();
  assert.deepEqual(bad, [], "an owned table with a `using (true)` policy");
});

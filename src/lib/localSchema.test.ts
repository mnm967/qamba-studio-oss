// `src/lib/localSchema.ts` is generated from the migrations, and this is what
// makes that true rather than aspirational.
//
// The local plane reproduces four things Postgres does for the cloud plane —
// column defaults, `moddatetime`, ON DELETE, and the ownership chain — and
// every one of them fails SILENTLY when it drifts: a migration that adds
// `not null default '{}'` to a column gives cloud rows a `{}` and local rows an
// `undefined`, which is a crash on the first property read, three screens away
// from the change that caused it.
//
// So the test re-renders the file from the SQL and compares the text. A
// migration that changes any of this fails here, and the fix is one command:
//
//   node scripts/gen_local_schema.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildLocalSchema, renderLocalSchema, V1_SERIES_ROOTED, CLOUD_ONLY } from "../../scripts/localSchemaSource.mjs";
import { readOwnership } from "../../scripts/sqlSchema.mjs";
import { DEFAULTS, FOREIGN_KEYS, LOCAL_TABLES, PRIMARY_KEYS } from "./localSchema.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const GENERATED = path.join(ROOT, "src", "lib", "localSchema.ts");

// Git's default on Windows checks the tree out CRLF, and a text comparison
// against a freshly rendered LF string would fail for that alone. Same rule as
// embedWorker.test.ts and prompt_guides.test.mjs: normalise at the READ site.
const lf = (s: string) => s.replace(/\r\n/g, "\n");

test("localSchema.ts is what the migrations say it should be", () => {
  const rendered = renderLocalSchema(buildLocalSchema(MIGRATIONS));
  const onDisk = lf(fs.readFileSync(GENERATED, "utf8"));
  assert.equal(onDisk, lf(rendered),
    "run `node scripts/gen_local_schema.mjs` — a migration has changed a default, "
    + "a trigger, a foreign key or a primary key, and the local plane still "
    + "reproduces the previous schema");
});

test("every owned table is either local or deliberately series-rooted", () => {
  const owned = readOwnership(MIGRATIONS).tables;
  const covered = new Set([...LOCAL_TABLES, ...V1_SERIES_ROOTED, ...CLOUD_ONLY]);
  const missing = owned.filter((t) => !covered.has(t)).sort();
  assert.deepEqual(missing, [],
    "an owned table the local plane neither carries nor names a reason to skip — "
    + "a local project would silently be missing that part of itself");
});

test("the two link tables keep their composite key and gain no id", () => {
  // Inventing an `id` for these works locally and fails the day the project is
  // pushed, on a column the database does not have.
  assert.deepEqual(PRIMARY_KEYS.collection_assets, ["collection_id", "asset_id"]);
  assert.deepEqual(PRIMARY_KEYS.bible_assets, ["entry_id", "asset_id"]);
  assert.equal(DEFAULTS.collection_assets?.id, undefined);
  assert.equal(DEFAULTS.bible_assets?.id, undefined);
});

test("the defaults every screen depends on are present", () => {
  // Spot checks, in the shape a reader can verify against the migration. The
  // text comparison above already guarantees the whole table; these say what
  // is load-bearing about it.
  assert.deepEqual(DEFAULTS.generation_blocks.status, { kind: "value", value: "planned" });
  assert.deepEqual(DEFAULTS.assets.hidden, { kind: "value", value: false });
  assert.deepEqual(DEFAULTS.assets.meta, { kind: "value", value: {} });
  assert.deepEqual(DEFAULTS.jobs.lane, { kind: "value", value: "gpu" });
  assert.deepEqual(DEFAULTS.jobs.status, { kind: "value", value: "queued" },
    "jobs predates this migrations directory — its base defaults are stated in the generator");
  assert.deepEqual(DEFAULTS.projects.id, { kind: "uuid" });
  assert.deepEqual(DEFAULTS.projects.created_at, { kind: "now" });
});

test("the delete actions the local store implements are the ones declared", () => {
  const of = (t: string, c: string) => FOREIGN_KEYS[t]?.find((f) => f.column === c);
  assert.equal(of("beats", "scene_id")?.onDelete, "cascade");
  assert.equal(of("generation_blocks", "active_take_id")?.onDelete, "set null",
    "a deleted take must not leave every block pointing at a row that is gone");
  assert.equal(of("clips", "asset_id")?.onDelete, "restrict",
    "deleting an asset a clip still plays is refused, not cascaded");
});

test("no foreign key points out of the local plane", () => {
  // A parent the store does not hold cannot be enforced, cascaded, or resolved
  // as an embed — and a local project whose rows point at absent tables is a
  // project with silently broken references.
  const local = new Set(LOCAL_TABLES);
  const stray: string[] = [];
  for (const [table, fks] of Object.entries(FOREIGN_KEYS)) {
    for (const fk of fks) if (!local.has(fk.parent)) stray.push(`${table}.${fk.column} -> ${fk.parent}`);
  }
  assert.deepEqual(stray.sort(), []);
});

/* ── the wholesale replace has to announce itself ───────────────────────── */

test("adopting a snapshot invalidates EVERY local table, not just projects", () => {
  // THE LOCAL PLANE HAS NO REALTIME. A write announces itself through
  // `LocalStore.onChange` -> `invalidateTables(c.tables)`, and that is the only
  // thing that ever tells a `useLiveQuery` to refetch. `adoptLocalSnapshot`
  // does not go through `onChange` at all — it swaps the whole store — so when
  // it announced `["projects"]` alone, a pull replaced every row on disk and
  // left the timeline, the storyboard, the bible and the library rendering
  // what they had before, until the app was restarted. The data was right the
  // whole time, which is exactly why it read as the replace having failed.
  //
  // Parsed rather than imported: `localPlane.ts` reaches React and the Tauri
  // bridge, so `node --test` cannot load it — the same wall `scoreTrack.test`
  // and `audioGraph.test` are behind.
  const src = fs.readFileSync(new URL("./localPlane.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("export async function adoptLocalSnapshot"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert.ok(body.includes("adoptLocalSnapshot"), "the scanner found nothing to read");
  // COMMENTS STRIPPED FIRST. The note above that call explains the bug by
  // naming `invalidateTables(c.tables)`, so a bare text search matches the
  // PROSE and reports a correct fix as broken — which is what it did on the
  // first run. Same rule `test_clip_gen_length.py` reaches for an AST for.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const call = code.match(/invalidateTables\(([^)]*)\)/);
  assert.ok(call, "adoptLocalSnapshot no longer announces anything at all");
  assert.ok(/LOCAL_TABLES/.test(call[1]),
    `adoptLocalSnapshot announces ${call[1]} — a wholesale replace has to name every table`);
  // ...and the list it names has to be the real one, or it announces nothing.
  assert.ok(LOCAL_TABLES.length > 15, `only ${LOCAL_TABLES.length} local tables`);
  for (const t of ["timelines", "tracks", "clips", "assets", "generation_blocks"]) {
    assert.ok(LOCAL_TABLES.includes(t), `${t} is not in LOCAL_TABLES`);
  }
});

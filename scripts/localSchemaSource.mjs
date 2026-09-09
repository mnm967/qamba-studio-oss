// The shape of `src/lib/localSchema.ts`, in one place so the GENERATOR and the
// DRIFT TEST cannot disagree about what the file should contain — the test
// re-renders from the migrations and compares text, so a hand-edit to the
// generated file is a failure rather than a surprise months later.
import { readDefaults, readForeignKeys, readOwnership, readPrimaryKeys, readTouchTables } from "./sqlSchema.mjs";

/** v1 tables are series-rooted: `series` is what a person creates, and no
 *  project sits above it. A local project is a PROJECT, so these can never be
 *  part of one — the legacy studio stays cloud-only, which is also the honest
 *  answer for a studio that is being retired. */
export const V1_SERIES_ROOTED = ["series", "shots", "takes", "references_", "voices"];

/** Owned, project-scoped, and deliberately NOT part of a local project.
 *
 *  Both of these are about the CLOUD by definition, and carrying them into the
 *  local plane would break each in its own quiet way:
 *
 *  * `product_events` is the funnel. On the local plane every event would be
 *    written into a file nobody reads — and in a LOCAL-ONLY beta that is every
 *    user, so the one measurement the beta exists to produce would come back
 *    empty while appearing to work.
 *  * `film_shares` names an asset on the public CDN and is served by a page
 *    that reads Supabase. A local project's media is a file on one machine, so
 *    a local share row could never be served by anything.
 *
 *  They still carry `project_id` and are still owner-scoped; what this list
 *  says is that a local project is not where they live. */
export const CLOUD_ONLY = ["film_shares", "product_events"];

/** The two v1 tables that ARE project-rooted, and whose base columns predate
 *  this migrations directory — so their `create table` is nowhere to be read
 *  and their defaults have to be stated. Everything ADDED to them since is
 *  extracted like any other column; this is only what the original CREATE
 *  gave them. */
/** The same two v1 tables' primary keys, for the same reason. */
export const V1_PRIMARY_KEYS = { jobs: ["id"], episodes: ["id"] };

export const V1_BASE_DEFAULTS = {
  jobs: {
    id: { kind: "uuid" },
    status: { kind: "value", value: "queued" },
    created_at: { kind: "now" },
    updated_at: { kind: "now" },
  },
  episodes: {
    id: { kind: "uuid" },
    status: { kind: "value", value: "draft" },
    created_at: { kind: "now" },
  },
};

export function buildLocalSchema(migrationsDir) {
  const { defaults, unsupported } = readDefaults(migrationsDir);
  // A default the local plane cannot represent is only a problem for a table
  // the local plane CARRIES. `film_shares.slug` is nine random bytes of
  // base64url from pgcrypto — genuinely not reproducible here, and genuinely
  // not needed, because a local project never has a share. Filtering after the
  // check would refuse to generate at all over a column nothing local reads.
  const relevant = unsupported.filter(
    (u) => !CLOUD_ONLY.some((t) => u.startsWith(`${t}.`)));
  if (relevant.length) {
    throw new Error(
      "a column default the local plane cannot represent — teach jsDefault() about it "
      + "rather than dropping it:\n  " + relevant.join("\n  "));
  }
  const { tables: owned, parents } = readOwnership(migrationsDir);
  const localTables = owned
    .filter((t) => !V1_SERIES_ROOTED.includes(t) && !CLOUD_ONLY.includes(t))
    .sort();
  const localSet = new Set(localTables);

  const mergedDefaults = {};
  for (const t of localTables) {
    const merged = { ...(V1_BASE_DEFAULTS[t] ?? {}), ...(defaults[t] ?? {}) };
    if (Object.keys(merged).length) mergedDefaults[t] = sortKeys(merged);
  }

  const fks = {};
  for (const [t, list] of Object.entries(readForeignKeys(migrationsDir))) {
    if (!localSet.has(t)) continue;
    // A foreign key OUT of the local plane cannot be enforced inside it.
    const kept = list.filter((fk) => localSet.has(fk.parent));
    if (kept.length) fks[t] = kept;
  }

  const ownership = {};
  for (const [child, chain] of Object.entries(parents)) {
    if (!localSet.has(child)) continue;
    const kept = [];
    for (let i = 0; i < chain.length; i += 2) {
      if (localSet.has(chain[i])) kept.push(chain[i], chain[i + 1]);
    }
    if (kept.length) ownership[child] = kept;
  }

  const pks = { ...V1_PRIMARY_KEYS, ...readPrimaryKeys(migrationsDir) };
  const primaryKeys = {};
  for (const t of localTables) primaryKeys[t] = pks[t] ?? V1_PRIMARY_KEYS[t] ?? ["id"];

  return {
    tables: localTables,
    primaryKeys: sortKeys(primaryKeys),
    defaults: mergedDefaults,
    touch: readTouchTables(migrationsDir).filter((t) => localSet.has(t)),
    foreignKeys: sortKeys(fks),
    ownership: sortKeys(ownership),
  };
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const j = (v) => JSON.stringify(v, null, 2).replace(/\n/g, "\n");

export function renderLocalSchema(s) {
  return `// GENERATED by scripts/gen_local_schema.mjs — do not edit by hand.
// Re-run it after any migration that adds a column default, a moddatetime
// trigger or a foreign key; \`localSchema.test.ts\` fails if you forget.
//
// This is the part of the database a LOCAL project has to reproduce without a
// database. Postgres fills defaults, moves \`updated_at\`, cascades deletes and
// derives \`project_id\` on the cloud plane; on the local plane this file plus
// \`localStore.ts\` are the whole of that behaviour.

/** How to fill a column the caller left out. \`now\`/\`uuid\` are computed per
 *  row; \`value\` is a constant (deep-copied before it is written, or two rows
 *  would share one \`meta\` object). */
export type ColumnDefault =
  | { kind: "now" }
  | { kind: "uuid" }
  | { kind: "value"; value: unknown };

/** Every table a local project is made of: the owned tables, minus the
 *  series-rooted v1 ones — no project sits above those, so they can never be
 *  part of a project that lives on this machine. */
export const LOCAL_TABLES: readonly string[] = ${j(s.tables)};

export const LOCAL_TABLE_SET: ReadonlySet<string> = new Set(LOCAL_TABLES);

/** table -> column -> what Postgres would have filled in. */
export const DEFAULTS: Readonly<Record<string, Record<string, ColumnDefault>>> = ${j(s.defaults)};

/** Tables carrying a \`moddatetime(updated_at)\` BEFORE UPDATE trigger. */
export const TOUCH_UPDATED_AT: readonly string[] = ${j(s.touch)};

/** table -> its primary key columns. Two link tables here have a COMPOSITE
 *  key and no \`id\` column at all, so nothing may assume one: a store that
 *  invents an id for them works until the row is pushed to a database that has
 *  no such column, and an upsert has no conflict target without this. */
export const PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = ${j(s.primaryKeys)};

/** table -> foreign keys, with the ON DELETE action the database would take. */
export const FOREIGN_KEYS: Readonly<Record<string, readonly {
  column: string; parent: string; onDelete: string;
}[]>> = ${j(s.foreignKeys)};

/** The ownership chain: child -> [parent table, local fk column, …], first hit
 *  wins. \`set_row_owner\` walks it to derive \`owner_id\`; the local store walks
 *  the same chain to derive \`project_id\`, which is what every share-scoped
 *  query filters on and what a local row would otherwise never carry. */
export const OWNERSHIP_PARENTS: Readonly<Record<string, readonly string[]>> = ${j(s.ownership)};
`;
}

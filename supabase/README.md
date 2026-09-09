# These migrations are a schema, not a deployment

There is no database in this build. A project's rows are a JSON file on your
disk (`src/lib/localStore.ts`) and the app answers PostgREST for them over
loopback, so nothing here is ever applied to a Postgres anywhere.

What the directory is for is **`src/lib/localSchema.ts`**, which is generated
from it:

```bash
node scripts/gen_local_schema.mjs
```

The local store needs five things Postgres used to do for free, and every one
of them is silent when it is missing:

- **column defaults** — an insert that omits `status` got `'planned'`; without
  it, a block that never renders and nothing saying why;
- **`updated_at`** moving on update, on exactly the tables that carried the
  trigger — the projects list sorts on it;
- **`on delete`** behaviour — cascade (a scene's beats), set null
  (`generation_blocks.active_take_id`), restrict (deleting an asset a clip
  still plays). Reproducing only the first leaves dangling references every
  consumer resolves to nothing;
- **`project_id`**, denormalised onto every owned table;
- **the primary key** — `collection_assets` and `bible_assets` are link rows
  with a composite key and no `id` column at all.

`src/lib/localSchema.test.ts` re-renders this and fails if the checked-in file
has drifted, so a schema change is one command rather than a bug three screens
away.

## Why the account and policy migrations are still here

Because the file names are a history and renumbering it would be worse than
leaving it. Several migrations set up things this build has no use for —
row-level security, an invite list, roles, sharing — and none of that runs:
there is nobody to authenticate and no server to authenticate against. Only
the structural half of these files is read.

The one thing that was edited rather than left alone is the owner seed in
`20260812190000_accounts.sql`, which was a real email address.

#!/usr/bin/env node
// Writes src/lib/localSchema.ts from supabase/migrations.
//
// The local plane has to behave like the database it stands in for, and every
// way of getting that wrong is silent (see scripts/sqlSchema.mjs). Deriving
// the table rather than typing it means a migration that adds a column with a
// default, a trigger or a foreign key is picked up by re-running this — and
// `localSchema.test.ts` fails the build if someone forgets to.
//
//   node scripts/gen_local_schema.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalSchema, renderLocalSchema } from "./localSchemaSource.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(ROOT, "src", "lib", "localSchema.ts");
fs.writeFileSync(out, renderLocalSchema(buildLocalSchema(path.join(ROOT, "supabase", "migrations"))));
console.log(`wrote ${path.relative(ROOT, out)}`);

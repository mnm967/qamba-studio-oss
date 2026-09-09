-- A PARTIAL unique index cannot be an ON CONFLICT arbiter, so every Civitai
-- import failed.
--
-- `custom_workflows_civitai_uniq` was written partial — `where
-- civitai_version_id is not null` — with the stated reason that everything
-- hand-made or pasted carries a null version id and several of those must be
-- allowed to coexist. The reasoning was sound and the mechanism was
-- unnecessary: a PLAIN unique index already permits them, because a unique
-- index never treats two NULLs as equal (`nulls not distinct` is opt-in, and
-- is not used here). So the partial predicate bought nothing and cost the
-- arbiter.
--
-- Postgres will only infer a partial index as an ON CONFLICT arbiter when the
-- statement REPEATS the index predicate (`on conflict (cols) where <pred>`).
-- PostgREST's `on_conflict=` parameter emits a bare column list and has no way
-- to carry a predicate, so `importWorkflow`'s upsert could never match this
-- index and died at PLAN time — before touching a row — with
--
--   42P10: there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- Measured on the live database 2026-08-23: `custom_workflows` held ZERO rows,
-- i.e. no Civitai import has ever succeeded since the feature shipped. The
-- error arrives from Postgres by way of PostgREST, so it reads like a database
-- fault rather than a schema mismatch, which is why it was never traced to the
-- index that caused it.
--
-- Dropping the predicate changes NOTHING about which rows are legal — the set
-- of enforced constraints is identical — so no existing row can violate the
-- replacement. Verified all three properties against the live database before
-- shipping: two null-version rows for one owner coexist, a duplicate
-- (owner_id, civitai_version_id) is still refused with 23505, and
-- `on conflict (owner_id, civitai_version_id)` now infers this index by name.

drop index if exists custom_workflows_civitai_uniq;

create unique index if not exists custom_workflows_civitai_uniq
  on custom_workflows (owner_id, civitai_version_id);

-- Counting rows in the BROWSER is the bug, and it is the same bug three more
-- times. PostgREST caps every response at `db.max_rows` (1000 here) and that
-- cap OVERRIDES the `.limit()` in the query — no error, nothing in the body to
-- say the list was cut — so `select(...).limit(5000)` followed by a client-side
-- tally reports the first 1000 rows as if they were the table.
--
-- Measured on this database the day these landed: 3,178 assets, 3,037 of them
-- unhidden, 3,031 for a single owner and 1,257 in a single project. The library
-- sidebar was reporting 1,000. The Costs page had the identical failure and was
-- reporting $110.54 of a real $334.49 (20260818060000).
--
-- All three are SECURITY INVOKER: RLS still applies inside the function, so an
-- aggregate cannot see a row its caller could not select. That is what makes
-- them safe to expose — a definer-rights count would leak the shape of other
-- accounts' libraries. Each returns one row per group (kinds, collections,
-- documents), so none of them can hit the cap it exists to escape.

-- Sidebar kind histogram + bin tally. Hidden assets are excluded here rather
-- than by the caller: a tally that counts what the grid will not show is itself
-- a disclosure ("40 images" over a grid of 34).
create or replace function public.asset_counts(
  p_project uuid default null,
  p_owner uuid default null
)
returns table (kind text, live bigint, trashed bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select kind,
         count(*) filter (where deleted_at is null)::bigint,
         count(*) filter (where deleted_at is not null)::bigint
  from assets
  where hidden is false
    and (p_project is null or project_id = p_project)
    and (p_owner is null or owner_id = p_owner)
  group by kind
$$;

-- Collection tallies stay UNRESOLVED on purpose: what counts depends on the
-- collection (a hidden one shows, and so counts, exactly what a visible one
-- must not), and that rule belongs with the UI that states it. So this returns
-- the cross-tab — at most four rows per collection — and the caller applies the
-- same rule it always did rather than having it reimplemented in SQL.
create or replace function public.collection_counts()
returns table (collection_id uuid, hidden boolean, trashed boolean, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select ca.collection_id,
         a.hidden,
         (a.deleted_at is not null),
         count(*)::bigint
  from collection_assets ca
  join assets a on a.id = ca.asset_id
  group by 1, 2, 3
$$;

-- Indexing progress per document. The old form selected `document_id` from
-- rag_chunks twice with `.limit(20000)` purely to call `.length` on the result
-- — so as well as truncating, it pulled a row per chunk across the wire to
-- render two numbers. (`embedding` was at least never selected: it is a
-- 1536-float vector and `select("*")` here would be tens of megabytes.)
create or replace function public.rag_chunk_counts(p_doc_ids uuid[])
returns table (document_id uuid, chunks bigint, embedded bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select document_id,
         count(*)::bigint,
         count(*) filter (where embedding is not null)::bigint
  from rag_chunks
  where document_id = any(p_doc_ids)
  group by 1
$$;

grant execute on function public.asset_counts(uuid, uuid) to authenticated;
grant execute on function public.collection_counts() to authenticated;
grant execute on function public.rag_chunk_counts(uuid[]) to authenticated;

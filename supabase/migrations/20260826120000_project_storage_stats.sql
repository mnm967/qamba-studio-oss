-- What a project actually occupies, per media kind.
--
-- The storage sheet could only say "this lives in the studio cloud" — no size,
-- no file count, nothing to judge a copy by. The numbers it needs are a SUM
-- over `assets.bytes`, and summing that in the browser is the bug this
-- database has already been bitten by four times: PostgREST caps a response at
-- `db.max_rows` (1000) and the cap overrides `.limit()`, so a client-side
-- tally over a 3,000-asset project reports a third of it, silently. See
-- 20260818070000, which is this same fix for the sidebar's counts.
--
-- SECURITY INVOKER, like every other aggregate here: RLS applies inside the
-- function, so it can never sum a row its caller could not select. One row per
-- kind, so it cannot hit the cap it exists to escape.
--
-- TWO DELIBERATE DEPARTURES from `asset_counts` next door:
--
--   1. HIDDEN ASSETS ARE COUNTED. That function excludes them, correctly: a
--      sidebar tally that counts what the grid will not show is itself a
--      disclosure. This sheet is not a browse — it is "what is here, and what
--      would be copied" — and a pull copies every row including hidden ones.
--      Excluding them would understate the transfer, so someone approves a
--      2 GB copy and watches 12 GB arrive. No hidden item is named or made
--      reachable by an aggregate byte figure.
--
--   2. BINNED ASSETS ARE REPORTED SEPARATELY rather than dropped. They still
--      occupy the bucket until `gc_sweep` takes them, so "you could get this
--      back by emptying the bin" is exactly the useful thing to say here.
--
-- `bytes` is nullable — it is written by the pod's ingest job, so anything
-- uploaded while the pod was stopped carries null. Those are summed as zero
-- AND counted in `unsized_n`, so the UI can mark the total approximate instead
-- of quietly under-reporting it.
create or replace function public.project_storage_stats(p_project uuid)
returns table (
  kind text,
  live_n bigint,
  live_bytes bigint,
  trashed_n bigint,
  trashed_bytes bigint,
  unsized_n bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select kind,
         count(*) filter (where deleted_at is null)::bigint,
         coalesce(sum(bytes) filter (where deleted_at is null), 0)::bigint,
         count(*) filter (where deleted_at is not null)::bigint,
         coalesce(sum(bytes) filter (where deleted_at is not null), 0)::bigint,
         count(*) filter (where bytes is null)::bigint
  from assets
  where project_id = p_project
  group by kind
$$;

grant execute on function public.project_storage_stats(uuid) to authenticated;

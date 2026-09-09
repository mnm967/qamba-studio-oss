-- The Costs page summed cost_ledger IN THE BROWSER, and PostgREST caps a
-- response at db.max_rows (1000). August had 2,378 rows, so the page fetched
-- an arbitrary 1000 of them and reported $110.54 of gpu_time against a real
-- $334.49 — and because the idle bucket is computed as "pod bill minus what
-- jobs booked", every dollar the cap hid was re-labelled as idle. The split
-- read 17% jobs / 83% idle where the truth is closer to 51/40.
--
-- A LIMIT cannot fix that: the cap is server-side, and asking for 5000 rows
-- silently returns 1000. Aggregate where the rows are.
--
-- SECURITY INVOKER on purpose: RLS still applies inside the function, so an
-- admin gets the studio and a member gets their own spend. A definer-rights
-- version would leak the whole account's ledger to any authenticated caller.
-- One row per (day, category) — ~50 a month, so it can never hit the cap
-- itself, and the day column is what draws the not-yet-billed tail.
create or replace function public.cost_ledger_totals(p_since timestamptz)
returns table (day date, category text, amount_usd numeric, n_rows bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select (occurred_at at time zone 'utc')::date,
         category,
         sum(amount_usd)::numeric,
         count(*)::bigint
  from cost_ledger
  where occurred_at >= p_since
  group by 1, 2
$$;

grant execute on function public.cost_ledger_totals(timestamptz) to authenticated;

-- Same cap, same page, second card: "What a generation actually costs" read
-- job_timings with `.limit(4000)` against 2,348 rows, so both the run counts
-- and the mean wall clock were computed from an arbitrary 1000 of them — on
-- the one card the copy calls "the number to trust when estimating a render".
-- 31 distinct (kind, model_id) pairs, so the aggregate is tiny.
create or replace function public.job_timing_stats()
returns table (kind text, model_id text, n bigint, total_seconds numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select kind, model_id, count(*)::bigint, sum(wall_seconds)::numeric
  from job_timings
  group by 1, 2
$$;

grant execute on function public.job_timing_stats() to authenticated;

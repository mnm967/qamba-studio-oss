-- claim_next_job_of_kind — the same claim, narrowed to job kinds a caller can
-- actually execute.
--
-- `claim_next_job(p_lanes, p_worker)` filters by LANE, which is right for the
-- pod: one process implements every handler, so anything on a lane it serves is
-- something it can run. It is wrong for a partial worker. The `api` lane
-- carries both `embed` (an HTTP call to an embeddings endpoint) and
-- `api_generate` (a hosted image/video generation, which goes through
-- worker/providers and writes to B2). An edge function claiming by lane would
-- eventually take an `api_generate` row, mark it `running`, and never execute
-- it — the job would sit "running" forever with no worker behind it, which is
-- exactly the stranded state `requeue_stale` exists to clean up after a crash.
--
-- Everything else is copied verbatim from claim_next_job: FOR UPDATE SKIP
-- LOCKED (so several workers can drain one queue without coordinating),
-- dependency-aware, priority then created_at. Deliberately a SEPARATE function
-- rather than an extra argument on the existing one — that RPC is called by the
-- pod on every poll and is not worth reshaping for a second caller.
create or replace function public.claim_next_job_of_kind(p_kinds text[], p_worker text)
returns setof jobs
language sql
security definer
set search_path = public
as $$
  update jobs j set
    status = 'running',
    worker_id = p_worker,
    attempt = attempt + 1,
    timing = jsonb_set(coalesce(timing, '{}'::jsonb), '{started_at}', to_jsonb(now())),
    updated_at = now()
  where j.id = (
    select id from jobs
    where status = 'queued'
      and kind = any(p_kinds)
      and not exists (
        select 1 from unnest(depends_on) as d
        join jobs dj on dj.id = d
        where dj.status <> 'done'
      )
    order by priority, created_at
    for update skip locked
    limit 1
  )
  returning *;
$$;

-- Claiming moves a row to `running` and stamps a worker onto it. That is an
-- execution-plane privilege, not a user one: a signed-in browser has no way to
-- then run the job, so letting it claim one would only ever strand work. The
-- edge function calls this with the service role.
revoke execute on function public.claim_next_job_of_kind(text[], text) from public, anon, authenticated;
grant execute on function public.claim_next_job_of_kind(text[], text) to service_role;

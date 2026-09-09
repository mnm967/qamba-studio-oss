-- v2 jobs: the ONE queue. The v1 `jobs` table is extended in place — v1
-- handlers keep their columns; v2 jobs use payload/lane/DAG fields. The
-- worker claims through claim_next_job() (FOR UPDATE SKIP LOCKED), which is
-- multi-worker-safe. Cancellation goes through request_job_cancel() so the
-- anon role never gets a general UPDATE policy on jobs.

alter table jobs
  add column if not exists project_id uuid references projects(id) on delete cascade,
  add column if not exists payload jsonb not null default '{}',
  add column if not exists depends_on uuid[] not null default '{}',
  add column if not exists priority int not null default 50,      -- 10 interactive · 50 batch · 70 post · 90 gc
  add column if not exists lane text not null default 'gpu'
    check (lane in ('gpu','cpu','api','llm')),
  add column if not exists cancel_requested boolean not null default false,
  add column if not exists progress numeric not null default 0,
  add column if not exists progress_note text,
  add column if not exists eta_seconds int,
  add column if not exists model_id text,
  add column if not exists worker_id text,
  add column if not exists attempt int not null default 0,
  add column if not exists output_asset_id uuid references assets(id) on delete set null,
  add column if not exists cost_usd numeric(10,4),
  add column if not exists timing jsonb not null default '{}';

create index if not exists jobs_claim_idx on jobs (status, lane, priority, created_at);
create index if not exists jobs_payload_block_idx on jobs ((payload->>'block_id'));

-- 'canceled' joins the v1 status set (queued|running|done|error).
-- v1 rows carry no status check constraint, so nothing to alter.

create or replace function claim_next_job(p_lanes text[], p_worker text)
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
      and lane = any(p_lanes)
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
-- The worker calls this with the service key; keep anon out.
revoke execute on function claim_next_job(text[], text) from public, anon;

create or replace function request_job_cancel(p_job uuid)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare j jobs;
begin
  update jobs set
    cancel_requested = true,
    status = case when status = 'queued' then 'canceled' else status end,
    updated_at = now()
  where id = p_job and status in ('queued','running')
  returning * into j;
  return j;
end;
$$;
grant execute on function request_job_cancel(uuid) to anon;

-- ---------------------------------------------------------------------------
-- model catalog: single source of truth (replaces the hand-mirrored models.js
-- for v2 surfaces; worker resolve reads local_files with model_map fallback)
-- ---------------------------------------------------------------------------
create table if not exists model_catalog (
  id text primary key,                 -- 'h3-local', 'h3-api-2k', 'seedream-5-pro', …
  family text not null,
  display_name text not null,
  kind text not null check (kind in ('video','image','audio','llm','embed','post')),
  provider text not null,              -- local | minimax | fal | openai | anthropic | ollama | higgsfield
  modes text[] not null default '{}',
  sizes jsonb,
  max_seconds int,
  fps int,
  frame_base int,
  frame_rem int,
  dim_step int,
  pricing jsonb not null default '{}', -- {unit:'second'|'image'|'mtok', usd:…, note?, estimate?}
  capabilities jsonb not null default '{}',
  local_files jsonb,                   -- model_map fragment (worker consumes)
  enabled boolean not null default true,
  sort int not null default 100,
  updated_at timestamptz not null default now()
);
create trigger model_catalog_updated before update on model_catalog
  for each row execute procedure extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- ETA samples + cost ledger
-- ---------------------------------------------------------------------------
create table if not exists job_timings (
  id uuid primary key default gen_random_uuid(),
  job_id uuid,
  model_id text,
  kind text,
  width int,
  height int,
  frames int,
  steps int,
  cold_load boolean not null default false,
  wall_seconds numeric not null,
  load_seconds numeric,
  gpu text,
  created_at timestamptz not null default now()
);
create index if not exists job_timings_model_idx on job_timings (model_id, gpu, created_at desc);

create table if not exists cost_ledger (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,
  job_id uuid,
  category text not null check (category in ('gpu_time','api_generation','llm','storage','higgsfield')),
  provider text,
  amount_usd numeric(12,6) not null,
  quantity numeric,
  unit text,
  note text,
  estimate boolean not null default false,
  occurred_at timestamptz not null default now()
);
create index if not exists cost_ledger_project_idx on cost_ledger (project_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- RLS. jobs keeps its v1 policies (select/insert open, delete kind='image',
-- no anon UPDATE — cancel goes through the RPC). New tables: read-open;
-- writes come from the worker (service key) only, except cost_ledger inserts
-- (frontend may record Higgsfield/manual entries).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['model_catalog','job_timings','cost_ledger'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_select on %I for select to public using (true)', t, t);
  end loop;
end $$;
create policy cost_ledger_insert on cost_ledger for insert to public with check (true);

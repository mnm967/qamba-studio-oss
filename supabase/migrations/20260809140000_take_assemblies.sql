-- Take assembly: the canonical performance, built from several takes.
--
-- Generation produces possibilities; assembly decides which one is true at
-- each moment. Because every take of a block is an alternate render of the
-- SAME plan, source time and assembly time are the same clock — so an
-- assembly is not an edit decision list with independent in/out points, it is
-- a gapless TILING of [0, duration_ms): each span names the take that owns it.
-- That is what keeps this from being a timeline editor.
create table if not exists take_assemblies (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references generation_blocks(id) on delete cascade,
  -- [{take_id, in_ms, out_ms, note?}] — ordered, contiguous, covering
  -- [0, duration_ms) exactly. Enforced in code (src/lib/assembly.ts and
  -- worker/assembly.py share one validator), not in SQL.
  segments jsonb not null default '[]',
  duration_ms int not null,
  -- who proposed it: the user, the evidence-based planner, or a reviewer
  source text not null default 'manual' check (source in ('manual','auto','review')),
  status text not null default 'draft'
    check (status in ('draft','rendering','rendered','failed')),
  output_take_id uuid references block_takes(id) on delete set null,
  render_job_id uuid,
  -- per-segment rationale from auto-assemble ({segment_idx: "why"}), and any
  -- accept/reject the user made on those proposals
  notes jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger take_assemblies_updated before update on take_assemblies
  for each row execute procedure extensions.moddatetime(updated_at);
create index if not exists take_assemblies_block_idx
  on take_assemblies (block_id, created_at desc);

-- One live draft per block per source: the manual draft is a working
-- document the modal reopens, and auto-assemble replaces its own proposal
-- rather than stacking a new one every press. Rendered assemblies are
-- history and are not constrained.
create unique index if not exists take_assemblies_one_draft
  on take_assemblies (block_id, source) where status = 'draft';

alter table take_assemblies enable row level security;
create policy take_assemblies_select on take_assemblies for select to public using (true);
create policy take_assemblies_insert on take_assemblies for insert to public with check (true);
create policy take_assemblies_update on take_assemblies for update to public using (true) with check (true);
create policy take_assemblies_delete on take_assemblies for delete to public using (true);

-- Realtime: auto-assemble runs on the worker and the modal must show its
-- proposal the moment it lands, same reasoning as take_reviews.
alter publication supabase_realtime add table take_assemblies;

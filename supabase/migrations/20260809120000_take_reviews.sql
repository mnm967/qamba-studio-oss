-- Production QA: structured reviews of generated takes and of the assembled
-- sequence. One table, two kinds — a take review binds to its take/block, a
-- sequence review binds only to the storyboard.
create table if not exists take_reviews (
  id uuid primary key default gen_random_uuid(),
  take_id uuid references block_takes(id) on delete cascade,
  block_id uuid references generation_blocks(id) on delete cascade,
  storyboard_id uuid references storyboards(id) on delete cascade,
  kind text not null default 'take' check (kind in ('take','sequence')),
  scores jsonb not null default '{}',      -- {dialogue, audio, continuity, action, camera, quality, overall}
  issues jsonb not null default '[]',      -- [{code, severity, detail, range_ms?}]
  transcript jsonb,                        -- {text, matches:[{speaker,line,coverage,t0,t1}]}
  metrics jsonb,                           -- DSP: lufs, peak, silence_gaps
  usable_ranges jsonb,                     -- [[in_ms,out_ms], …] for the editor
  verdict text check (verdict in ('keep','patch','retake','flag')),
  recommended_action text,
  auto_action text,                        -- what the worker actually did
  created_at timestamptz not null default now()
);
create index if not exists take_reviews_block_idx on take_reviews (block_id, created_at desc);
create index if not exists take_reviews_story_idx on take_reviews (storyboard_id, kind, created_at desc);

alter table take_reviews enable row level security;
create policy take_reviews_select on take_reviews for select to public using (true);
create policy take_reviews_insert on take_reviews for insert to public with check (true);
create policy take_reviews_update on take_reviews for update to public using (true) with check (true);
create policy take_reviews_delete on take_reviews for delete to public using (true);

-- Realtime: the storyboard page renders verdict chips live while blocks
-- render — same reasoning as the bible tables.
alter publication supabase_realtime add table take_reviews;

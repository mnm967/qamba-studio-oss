-- v2 pipeline: storyboards → scenes → beats, generation blocks (the 15s H3
-- master-pass atom) + block_takes, and the timeline editor tables.
-- All durations are MILLISECONDS.

-- ---------------------------------------------------------------------------
-- storyboard
-- ---------------------------------------------------------------------------
create table if not exists storyboards (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references episodes(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft','review','approved','rendering','complete')),
  audio_asset_id uuid references assets(id) on delete set null,  -- MV master track
  audio_meta jsonb not null default '{}',   -- {bpm, beats_ms[], lyrics:[{t0,t1,text,singer}], sections}
  brief jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger storyboards_updated before update on storyboards
  for each row execute procedure extensions.moddatetime(updated_at);
create index if not exists storyboards_episode_idx on storyboards (episode_id, created_at desc);

create table if not exists scenes (
  id uuid primary key default gen_random_uuid(),
  storyboard_id uuid not null references storyboards(id) on delete cascade,
  idx int not null,
  slug text,
  duration_ms int not null,
  environment_id uuid references bible_entries(id) on delete set null,
  cast_ids uuid[] not null default '{}',
  scene_prompt text,
  still_asset_id uuid references assets(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft','approved','locked','generating','generated')),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storyboard_id, idx)
);
create trigger scenes_updated before update on scenes
  for each row execute procedure extensions.moddatetime(updated_at);

create table if not exists beats (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references scenes(id) on delete cascade,
  idx int not null,
  duration_ms int not null,
  camera text,
  action text not null,
  dialogue jsonb,                               -- [{speaker_id, line, delivery}]
  sfx text,
  meta jsonb not null default '{}',
  unique (scene_id, idx)
);

-- ---------------------------------------------------------------------------
-- generation blocks: 15s master passes with chaining metadata
-- ---------------------------------------------------------------------------
create table if not exists generation_blocks (
  id uuid primary key default gen_random_uuid(),
  storyboard_id uuid not null references storyboards(id) on delete cascade,
  idx int not null,
  scene_ids uuid[] not null default '{}',
  beat_ids uuid[] not null default '{}',
  t_start_ms int not null,
  t_end_ms int not null,
  frames int not null,                          -- padded 17n+5 render count
  trim jsonb not null default '{}',             -- {warmup_f, cooldown_f, out_ms}
  mode text not null default 'r2v' check (mode in ('r2v','flf','i2v','t2v')),
  compiled_prompt jsonb,                        -- {description, soundscape, music, fmt_version}
  ref_plan jsonb not null default '[]',         -- [{slot,label,purpose, asset_id|'prev_last_frame'}]
  audio_mode text not null default 'native' check (audio_mode in ('native','locked')),
  audio_slice jsonb,                            -- {asset_id, offset_ms, duration_ms}
  chain_from_block_id uuid references generation_blocks(id) on delete set null,
  status text not null default 'planned'
    check (status in ('planned','queued','generating','generated','failed','stale')),
  active_take_id uuid,                          -- FK added below
  seed bigint,
  params jsonb not null default '{}',           -- steps, w, h, easycache, sage…
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storyboard_id, idx)
);
create trigger generation_blocks_updated before update on generation_blocks
  for each row execute procedure extensions.moddatetime(updated_at);

-- v2 takes are block-scoped (v1 `takes` stays shot-scoped until retirement)
create table if not exists block_takes (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references generation_blocks(id) on delete cascade,
  job_id uuid,
  asset_id uuid not null references assets(id) on delete cascade,
  kind text not null default 'master' check (kind in ('master','patch','spliced','edit')),
  patch_range jsonb,                            -- {in_ms, out_ms} for patches
  state text not null default 'pending' check (state in ('pending','kept','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists block_takes_block_idx on block_takes (block_id, created_at desc);

alter table generation_blocks
  add constraint generation_blocks_active_take_fk
  foreign key (active_take_id) references block_takes(id) on delete set null;

-- ---------------------------------------------------------------------------
-- timeline editor
-- ---------------------------------------------------------------------------
create table if not exists timelines (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references episodes(id) on delete cascade,
  name text not null default 'Main',
  fps int not null default 24,
  width int not null default 1280,
  height int not null default 720,
  render_asset_id uuid references assets(id) on delete set null,
  render_stale boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger timelines_updated before update on timelines
  for each row execute procedure extensions.moddatetime(updated_at);

create table if not exists tracks (
  id uuid primary key default gen_random_uuid(),
  timeline_id uuid not null references timelines(id) on delete cascade,
  kind text not null check (kind in ('video','audio')),
  idx int not null,
  name text,
  muted boolean not null default false,
  locked boolean not null default false,
  gain_db numeric not null default 0,
  duck_under_track_id uuid references tracks(id) on delete set null,
  unique (timeline_id, kind, idx)
);

create table if not exists clips (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references tracks(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete restrict,
  block_id uuid references generation_blocks(id) on delete set null,  -- retake provenance
  t_start_ms int not null,
  duration_ms int not null,
  in_ms int not null default 0,
  out_ms int,
  ops jsonb not null default '[]',              -- ordered op objects (flip/crop/speed/…)
  transition_in jsonb,                          -- {type:'xfade'|'generated', dur_ms, style, asset_id?}
  gain_db numeric not null default 0,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger clips_updated before update on clips
  for each row execute procedure extensions.moddatetime(updated_at);
create index if not exists clips_track_t_idx on clips (track_id, t_start_ms);
create index if not exists clips_asset_idx on clips (asset_id);

-- ---------------------------------------------------------------------------
-- RLS (open, single-user posture)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['storyboards','scenes','beats','generation_blocks',
                           'block_takes','timelines','tracks','clips'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_select on %I for select to public using (true)', t, t);
    execute format('create policy %I_insert on %I for insert to public with check (true)', t, t);
    execute format('create policy %I_update on %I for update to public using (true) with check (true)', t, t);
    execute format('create policy %I_delete on %I for delete to public using (true)', t, t);
  end loop;
end $$;
